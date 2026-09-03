#!/usr/bin/env python
"""01_core.py — the master cache every other bake script reads.

Writes four parquet files under code/build/_cache/:

  master.parquet    889,215 motif rows joined to their transcript, with gene_symbol,
                    region-masked opaque annotation columns, and the mRNA-axis
                    projection (ms, me) for all three regions.
  genes.parquet      18,093 transcripts: ids, the four sequences, five lengths
                    (incl. the TRUE mRNA length), per-region motif counts, modules.
  coupling.parquet  per transcript, the co-present GATED cluster pairs.
  clusters.parquet     900 clusters: region, module, counts, length histogram,
                    score/entropy/plddt quantiles, 20-bin positional histogram.

Nothing here is sampled and nothing is fabricated. Run 00_validate.py first.

Run:  /opt/anaconda3/envs/bio/bin/python code/build/01_core.py
"""
from __future__ import annotations

import json
import time
from collections import defaultdict

import numpy as np
import pandas as pd

import paths

T0 = time.time()
CACHE = paths.HERE / "_cache"
CACHE.mkdir(exist_ok=True)

# quantile levels stored in the *_q list columns of clusters.parquet
QLEVELS = [0.0, 0.05, 0.25, 0.5, 0.75, 0.95, 1.0]
NBINS = 20

# annotation columns -> (short name, kind, which regions keep it)
ANN_SPEC = [
    ("RBPs_eCLIP",              "rbp_eclip",         "list", ("utr5", "utr3")),
    ("RBPs_PAR-CLIP,PARalyzer", "rbp_parclip",       "list", ("utr5", "utr3")),
    ("RBPs_iCLIP,Piranha_0.01", "rbp_iclip_piranha", "list", ("utr5", "utr3")),
    ("RBPs_iCLIP,CIMS",         "rbp_iclip_cims",    "list", ("utr5", "utr3")),
    ("mirna_annotations_targetscan", "mir",          "list", ("utr3",)),
    ("MobIDB annotation",       "mob",               "list", ("protein",)),
    ("interpro_annotations",    "ipr",               "str",  ("protein",)),
    ("uniprot_annotations",     "upr",               "str",  ("protein",)),
    ("elm_annotations",         "elm",               "str",  ("protein",)),
    ("idpo_annotations",        "idpo",              "str",  ("protein",)),
    ("signalp_annotation",      "sig",               "str",  ("protein",)),
]


def log(msg: str) -> None:
    print(f"[{time.time() - T0:6.1f}s] {msg}", flush=True)


# ══════════════════════════════════════════════════════════════════════════
# load
# ══════════════════════════════════════════════════════════════════════════
log("loading motif core + annotations + sequences")
core = pd.read_parquet(paths.MOTIF_CORE)
ann = pd.read_parquet(paths.MOTIF_ANNOT)
assert len(core) == len(ann) == paths.N_MOTIFS, (len(core), len(ann))
# the two motif tables are row-aligned (verified: raw_motif_index, sequence_id and
# motif_cluster agree positionally on all 889,215 rows) — assert rather than assume.
for c in ("raw_motif_index", "sequence_id", "motif_cluster", "region", "motif_start"):
    assert (core[c].to_numpy() == ann[c].to_numpy()).all(), f"row misalignment on {c}"

seqs = pd.read_parquet(paths.SEQUENCES)
sd = seqs.drop_duplicates("refseq_id_without_ver")
log(f"    motifs {len(core):,}   sequences {len(seqs):,} -> deduped {len(sd):,}")

# ══════════════════════════════════════════════════════════════════════════
# modules
# ══════════════════════════════════════════════════════════════════════════
modules_json = json.loads(paths.MODULES_JSON.read_text())
cluster_module: dict[str, int] = {}
for m in modules_json:
    mid = int(m["module_id"])
    for c in list(m["protein_motifs"]) + list(m["utr_motifs"]):
        cluster_module[c] = mid
log(f"    modules: {len(modules_json)}, clusters assigned to a module: {len(cluster_module)}")

# ══════════════════════════════════════════════════════════════════════════
# genes.parquet
# ══════════════════════════════════════════════════════════════════════════
log("building genes.parquet")
universe = pd.Index(core["sequence_id"].unique())
assert len(universe) == paths.N_TRANSCRIPTS, len(universe)

g = sd[sd["refseq_id_without_ver"].isin(universe)].set_index("refseq_id_without_ver")
assert len(g) == len(universe), (len(g), len(universe))

# ENSG / ENST lists come from the FULL (pre-dedup) table — the 1,296 duplicate groups
# are byte-identical in sequence but carry distinct Ensembl ids, which are aliases.
alias = seqs[seqs["refseq_id_without_ver"].isin(universe)]
ensg = alias.groupby("refseq_id_without_ver")["Gene stable ID"].apply(lambda s: sorted(set(s)))
enst = alias.groupby("refseq_id_without_ver")["Transcript stable ID"].apply(lambda s: sorted(set(s)))

sym = ann.drop_duplicates("sequence_id").set_index("sequence_id")["gene_symbol"]

genes = pd.DataFrame(index=g.index)
genes.index.name = "refseq"
genes["symbol"] = sym.reindex(genes.index)
genes["ensg"] = ensg.reindex(genes.index)
genes["enst"] = enst.reindex(genes.index)
genes["utr5"] = g["utr5_sequence"]
genes["cds"] = g["cds_sequence"]
genes["utr3"] = g["utr3_sequence"]
genes["protein"] = g["protein_sequence"]
genes["len_utr5"] = genes["utr5"].str.len().astype("int32")
genes["len_cds"] = genes["cds"].str.len().astype("int32")
genes["len_utr3"] = genes["utr3"].str.len().astype("int32")
genes["len_protein"] = genes["protein"].str.len().astype("int32")
# fact 9: transcript_length is NOT the mRNA length. The real one is the sum.
genes["len_mrna"] = (genes["len_utr5"] + genes["len_cds"] + genes["len_utr3"]).astype("int32")
genes["len_declared"] = g["transcript_length"].astype("int32")
assert genes["symbol"].notna().all()
assert (genes["len_cds"] == 3 * genes["len_protein"] + 3).all()
n_short = int((genes["len_declared"] < genes["len_mrna"]).sum())
log(f"    transcript_length < true mRNA length in {n_short}/{len(genes)} rows (fact 9)")

cnt = core.groupby(["sequence_id", "region"]).size().unstack(fill_value=0)
for r in ("utr5", "utr3", "protein"):
    genes[f"n_{r}"] = cnt[r].reindex(genes.index).fillna(0).astype("int32")
genes["n_motifs"] = (genes["n_utr5"] + genes["n_utr3"] + genes["n_protein"]).astype("int32")
assert int(genes["n_motifs"].sum()) == paths.N_MOTIFS

# ══════════════════════════════════════════════════════════════════════════
# master.parquet
# ══════════════════════════════════════════════════════════════════════════
log("building master.parquet")
mst = core[["raw_motif_index", "unique_motif_id", "sequence_id", "region",
            "motif_start", "motif_end", "motif_length", "motifs",
            "motif_score", "motif_entropy", "plddt", "motif_cluster"]].copy()
mst["gene_symbol"] = ann["gene_symbol"].to_numpy()
mst["module"] = mst["motif_cluster"].map(cluster_module).fillna(0).astype("int8")

reg = mst["region"].to_numpy()
s = mst["motif_start"].to_numpy()
e = mst["motif_end"].to_numpy()
L5 = genes["len_utr5"].reindex(mst["sequence_id"]).to_numpy()
LC = genes["len_cds"].reindex(mst["sequence_id"]).to_numpy()
L3 = genes["len_utr3"].reindex(mst["sequence_id"]).to_numpy()
LP = genes["len_protein"].reindex(mst["sequence_id"]).to_numpy()
LM = genes["len_mrna"].reindex(mst["sequence_id"]).to_numpy()

is5, is3, isp = (reg == "utr5"), (reg == "utr3"), (reg == "protein")
# fact 4: protein aa i occupies mRNA nt len(utr5)+3i .. len(utr5)+3i+2
ms = np.where(is5, s, np.where(is3, L5 + LC + s, L5 + 3 * s))
me = np.where(is5, e, np.where(is3, L5 + LC + e, L5 + 3 * e + 2))
mst["ms"] = ms.astype("int32")
mst["me"] = me.astype("int32")
assert (mst["ms"] >= 0).all()
assert (mst["me"] < LM).all(), "an mRNA-axis projection runs off the end of the transcript"
assert (mst.loc[isp, "me"] - mst.loc[isp, "ms"] + 1 == 3 * mst.loc[isp, "motif_length"]).all()
assert (mst.loc[~isp, "me"] - mst.loc[~isp, "ms"] + 1 == mst.loc[~isp, "motif_length"]).all()

# region length + relative position (midpoint / region length), for cluster histograms
rlen = np.where(is5, L5, np.where(is3, L3, LP)).astype(np.float64)
mst["region_len"] = rlen.astype("int32")
mid = (s + e) / 2.0
mst["rel_pos"] = np.clip(mid / np.maximum(rlen, 1.0), 0.0, 0.999999).astype("float32")

# ── annotations: mask by region, keep every string OPAQUE (fact 6) ─────────
log("    masking annotations to their own layer (never str.split on them)")
masked_cells = 0
for src, short, kind, keep in ANN_SPEC:
    col = ann[src]
    keep_mask = np.isin(reg, list(keep))
    if kind == "list":
        present = col.map(lambda v: v is not None and len(v) > 0
                          if isinstance(v, (list, np.ndarray)) else False).to_numpy()
    else:
        present = (col.notna() & (col.fillna("").str.len() > 0)).to_numpy()
    masked_cells += int((present & ~keep_mask).sum())
    out = col.where(pd.Series(keep_mask, index=col.index), other=None)
    if kind == "list":
        out = out.map(lambda v: list(v) if isinstance(v, (list, np.ndarray)) and len(v) else None)
    else:
        out = out.map(lambda v: v if isinstance(v, str) and v else None)
    mst[short] = out.to_numpy()
log(f"    dropped {masked_cells:,} cross-layer annotation cells (expected ~212,449)")

# ══════════════════════════════════════════════════════════════════════════
# modules per transcript  (ordered by how many of its motifs sit in each module)
# ══════════════════════════════════════════════════════════════════════════
mm = mst.loc[mst["module"] > 0, ["sequence_id", "module"]]
mcnt = mm.groupby(["sequence_id", "module"]).size().reset_index(name="n")
mcnt = mcnt.sort_values(["sequence_id", "n", "module"], ascending=[True, False, True])
mod_lists = mcnt.groupby("sequence_id")["module"].apply(lambda x: [int(v) for v in x])
genes["modules"] = mod_lists.reindex(genes.index).apply(lambda v: v if isinstance(v, list) else [])
genes["primary_module"] = genes["modules"].apply(lambda v: int(v[0]) if v else 0).astype("int8")
log(f"    transcripts touching >=1 module: {int((genes['primary_module'] > 0).sum()):,}/{len(genes):,}")

# ══════════════════════════════════════════════════════════════════════════
# coupling.parquet — co-present GATED cluster pairs, per transcript
# ══════════════════════════════════════════════════════════════════════════
log("building coupling.parquet")
gated = pd.read_csv(paths.PAIR_PASSING)
assert len(gated) == paths.N_GATED_EDGES, len(gated)
assert bool(gated["passes_phylo_filter"].all()), "PAIR_PASSING contains a non-passing row"

carriers: dict[str, set] = {k: set(v) for k, v in
                            core.groupby("motif_cluster")["sequence_id"].apply(set).items()}
rows_t, rows_p, rows_u = [], [], []
edge_idx = []
for i, (p, u) in enumerate(zip(gated["protein"].to_numpy(), gated["utr"].to_numpy())):
    inter = carriers.get(p, set()) & carriers.get(u, set())
    if not inter:
        continue
    for t in inter:
        rows_t.append(t)
        rows_p.append(p)
        rows_u.append(u)
        edge_idx.append(i)

coupling = pd.DataFrame({
    "sequence_id": rows_t,
    "prot_cluster": rows_p,
    "utr_cluster": rows_u,
})
meta = gated.iloc[edge_idx]
coupling["phylo_corrected_score"] = meta["phylo_corrected_score"].to_numpy().astype("float32")
coupling["npmi_mip_APC"] = meta["npmi_mip_APC"].to_numpy().astype("float32")
coupling["co_count"] = meta["co_count"].to_numpy().astype("int32")
coupling["n_indep_clades"] = meta["n_indep_clades"].to_numpy().astype("int32")
coupling["clade_concentration"] = meta["clade_concentration"].to_numpy().astype("float32")
coupling["frac_co_ZNF"] = meta["frac_co_ZNF"].to_numpy().astype("float32")
coupling = coupling.sort_values(["sequence_id", "phylo_corrected_score"],
                                ascending=[True, False]).reset_index(drop=True)

per_tx = coupling.groupby("sequence_id").size().reindex(genes.index).fillna(0).astype(int)
COUP = dict(
    rows=int(len(coupling)),
    mean=float(per_tx.mean()),
    median=float(per_tx.median()),
    p90=float(per_tx.quantile(0.90)),
    max=int(per_tx.max()),
    pct_ge1=float(100.0 * (per_tx >= 1).mean()),
    edges_with_carriers=int(len(set(edge_idx))),
)
EXPECT = dict(mean=8.04, median=2, p90=23, max=203, pct_ge1=65.2)
log(f"    co-present pairs: mean {COUP['mean']:.2f} (expect {EXPECT['mean']}), "
    f"median {COUP['median']:.0f} (expect {EXPECT['median']}), "
    f"p90 {COUP['p90']:.0f} (expect {EXPECT['p90']}), "
    f"max {COUP['max']} (expect {EXPECT['max']}), "
    f">=1 pair {COUP['pct_ge1']:.1f}% (expect {EXPECT['pct_ge1']}%)")
disagree = []
if abs(COUP["mean"] - EXPECT["mean"]) > 0.05:
    disagree.append(f"mean {COUP['mean']:.3f} != {EXPECT['mean']}")
if COUP["median"] != EXPECT["median"]:
    disagree.append(f"median {COUP['median']} != {EXPECT['median']}")
if COUP["p90"] != EXPECT["p90"]:
    disagree.append(f"p90 {COUP['p90']} != {EXPECT['p90']}")
if COUP["max"] != EXPECT["max"]:
    disagree.append(f"max {COUP['max']} != {EXPECT['max']}")
if abs(COUP["pct_ge1"] - EXPECT["pct_ge1"]) > 0.1:
    disagree.append(f"pct>=1 {COUP['pct_ge1']:.2f} != {EXPECT['pct_ge1']}")
if disagree:
    print("  !! COUPLING DISAGREES WITH THE BRIEFED NUMBERS: " + "; ".join(disagree))
    print("  !! reporting the measured values as-is; nothing was adjusted to fit.")
else:
    log("    coupling matches every briefed number exactly")
COUP["disagreements"] = disagree
log(f"    gated edges with >=1 co-carrying transcript: {COUP['edges_with_carriers']}/{len(gated)}")

# ══════════════════════════════════════════════════════════════════════════
# clusters.parquet
# ══════════════════════════════════════════════════════════════════════════
log("building clusters.parquet")
n_gated_partners = defaultdict(int)
for p, u in zip(gated["protein"], gated["utr"]):
    n_gated_partners[p] += 1
    n_gated_partners[u] += 1

bins = np.minimum((mst["rel_pos"].to_numpy() * NBINS).astype(int), NBINS - 1)
mst_bin = pd.Series(bins, index=mst.index)

recs = []
for cid, sub in mst.groupby("motif_cluster", sort=True):
    region = sub["region"].iloc[0]
    assert sub["region"].nunique() == 1, f"cluster {cid} spans regions"
    lh = sub["motif_length"].value_counts().sort_index()
    pos = np.bincount(mst_bin.loc[sub.index].to_numpy(), minlength=NBINS).astype(np.float64)
    pos = pos / pos.sum() if pos.sum() else pos
    pl = sub["plddt"].dropna()
    recs.append(dict(
        cluster_id=cid,
        region=region,
        module=int(cluster_module.get(cid, 0)),
        n_instances=int(len(sub)),
        n_transcripts=int(sub["sequence_id"].nunique()),
        n_genes=int(sub["gene_symbol"].nunique()),
        n_gated_partners=int(n_gated_partners.get(cid, 0)),
        hist_length=[int(x) for x in lh.index],
        hist_count=[int(x) for x in lh.values],
        len_median=float(sub["motif_length"].median()),
        score_median=float(sub["motif_score"].median()),
        score_q=[float(x) for x in sub["motif_score"].quantile(QLEVELS)],
        entropy_median=float(sub["motif_entropy"].median()),
        entropy_q=[float(x) for x in sub["motif_entropy"].quantile(QLEVELS)],
        plddt_median=(float(pl.median()) if len(pl) else None),
        plddt_q=([float(x) for x in pl.quantile(QLEVELS)] if len(pl) else None),
        position=[float(x) for x in pos],
    ))
clusters = pd.DataFrame(recs)
assert len(clusters) == paths.N_CLUSTERS, len(clusters)
assert int(clusters["n_instances"].sum()) == paths.N_MOTIFS
for r in ("utr5", "utr3", "protein"):
    assert (clusters.loc[clusters.region == r, "cluster_id"]
            .str.startswith({"protein": "prot_"}.get(r, r + "_")).all()), r

n_no_module = int((clusters["module"] == 0).sum())
n_no_partner = int(((clusters["n_gated_partners"] == 0) & (clusters["region"] != "protein")).sum())
n_utr = int((clusters["region"] != "protein").sum())
log(f"    clusters with no module: {n_no_module}/900 (expect 387)")
log(f"    UTR clusters with zero gated partners: {n_no_partner}/{n_utr} (expect 282/600)")

# ══════════════════════════════════════════════════════════════════════════
# write
# ══════════════════════════════════════════════════════════════════════════
log("writing parquet")
genes = genes.reset_index()
mst.to_parquet(CACHE / "master.parquet", index=False, compression="zstd")
genes.to_parquet(CACHE / "genes.parquet", index=False, compression="zstd")
coupling.to_parquet(CACHE / "coupling.parquet", index=False, compression="zstd")
clusters.to_parquet(CACHE / "clusters.parquet", index=False, compression="zstd")

mrna = genes["len_mrna"]
meta_out = dict(
    built=time.strftime("%Y-%m-%d"),
    quantile_levels=QLEVELS,
    position_bins=NBINS,
    counts=dict(motifs=int(len(mst)), transcripts=int(len(genes)),
                genes=int(genes["symbol"].nunique()), clusters=int(len(clusters)),
                gated_edges=int(len(gated)), coupling_rows=int(len(coupling))),
    mrna_length=dict(median=int(mrna.median()), p99=int(mrna.quantile(0.99)),
                     max=int(mrna.max()), min=int(mrna.min())),
    coupling=COUP,
    clusters=dict(no_module=n_no_module, utr_no_gated_partner=n_no_partner, n_utr=n_utr),
    annotation_cells_masked=int(masked_cells),
    columns=dict(master=list(mst.columns), genes=list(genes.columns),
                 coupling=list(coupling.columns), clusters=list(clusters.columns)),
)
(CACHE / "core_meta.json").write_text(json.dumps(meta_out, indent=2))

print("\n" + "=" * 74)
for f in ("master", "genes", "coupling", "clusters"):
    p = CACHE / f"{f}.parquet"
    print(f"  {p.name:<18} {p.stat().st_size / 1e6:8.2f} MB")
print(f"  mRNA length: median {meta_out['mrna_length']['median']:,}  "
      f"p99 {meta_out['mrna_length']['p99']:,}  max {meta_out['mrna_length']['max']:,}"
      f"   (expect 2,923 / 8,736 / 11,426)")
print(f"  done in {time.time() - T0:.1f}s -> {CACHE}")
print("=" * 74)
