#!/usr/bin/env python
"""09_modules.py — bake portal/data/modules/<N>.json  (CONTRACT.md § modules/<N>.json)

Six drill-down payloads, one per module. Each carries

  head      id, label, colour, the non-dismissible caveat, headline counts
  terms     the FULL GO list at q < 0.05 from paths.MODULE_GO, each flagged
            `tr` for the stricter TRUSTED subset (q < 0.05 & fold >= 2 &
            n_fam_support >= 5). Both denominators are printed in `counts`.
  clusters  member clusters (region, degree, instances, name, top consensus),
            split protein / UTR, ordered by degree
  genes     top carrier genes from paths.MODULE_GENEIX with the full denominator
  edges     the module's strongest internal pairs, plus the cross-module traffic
            in and out broken down by partner module

Reads only paths.* sources and _cache/. Writes only portal/data/modules/.
Run:  /opt/anaconda3/envs/bio/bin/python 09_modules.py
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paths as P  # noqa: E402

CACHE = Path(__file__).resolve().parent / "_cache"
OUTDIR = P.OUT / "modules"
OUTDIR.mkdir(parents=True, exist_ok=True)

GENE_CAP = 400          # carrier genes shipped per module (denominator always printed)
EDGE_CAP = 60           # strongest internal pairs shipped per module

MODULE_COLOR = {1: "#E69F00", 2: "#56B4E9", 3: "#009E73",
                4: "#F0E442", 5: "#0072B2", 6: "#D55E00"}
MODULE_LABEL = {
    1: "Transcriptional / developmental regulation",
    2: "Transcription factors & nucleotide-exchange signalling",
    3: "Secretory, membrane & extracellular matrix",
    4: "Immune & host defence",
    5: "RNA processing & splicing",
    6: "Translation & histone / chromatin structure",
}
MODULE_SHORT = {1: "Transcription I", 2: "Transcription II", 3: "Secretory / membrane",
                4: "Immune", 5: "RNA processing", 6: "Translation / histone"}

CAVEAT = (
    "Module membership and every edge here are STATISTICAL CO-OCCURRENCE of motif "
    "clusters across transcripts. They are not evidence of a physical interaction "
    "between the protein motif and the UTR motif. Layout distance carries no meaning."
)
TERM_CAVEAT = (
    "GO enrichment is computed over the module's CARRIER GENES, not over the motifs "
    "themselves. 'Trusted' additionally requires fold >= 2 and support from at least "
    "5 independent paralog families, which is what removes clade-driven artifacts."
)


def log(msg: str) -> None:
    print(msg, flush=True)


def check(label: str, got, want) -> None:
    ok = got == want
    log(f"  [{'OK  ' if ok else 'FAIL'}] {label}: {got}" + ("" if ok else f"  (expected {want})"))
    if not ok:
        raise AssertionError(f"{label}: got {got}, expected {want}")


# ─────────────────────────────────────────────────────────────────────────────
log("[1] loading")

clusters = pd.read_parquet(CACHE / "clusters.parquet")
core_meta = json.loads((CACHE / "core_meta.json").read_text())
net = json.loads((P.OUT / "network.json").read_text())  # written by 08_network.py

pairs = pd.read_csv(P.PAIR_PASSING)
check("PAIR_PASSING rows", len(pairs), P.N_GATED_EDGES)

go = pd.read_csv(P.MODULE_GO)
summ = pd.read_csv(P.MODULES_SUMM).set_index("module_id")
terms_hdr = pd.read_csv(P.MODULE_TERMS).set_index("module_id")
geneix = pd.read_csv(P.MODULE_GENEIX)
check("MODULE_GO rows", len(go), 6389)
check("MODULE_GENEIX rows", len(geneix), 12345)

cl_region = dict(zip(clusters.cluster_id, clusters.region))
cl_module = {k: int(v) for k, v in zip(clusters.cluster_id, clusters.module)}
cl_inst = {k: int(v) for k, v in zip(clusters.cluster_id, clusters.n_instances)}
cl_tx = {k: int(v) for k, v in zip(clusters.cluster_id, clusters.n_transcripts)}
cl_genes = {k: int(v) for k, v in zip(clusters.cluster_id, clusters.n_genes)}

# node metadata (name/tier/consensus/degree/x2/y2) comes straight from network.json
# so the drill-down can never disagree with the network view
node = {n["id"]: n for n in net["nodes"]}
check("network.json nodes", len(node), 519)

deg = Counter()
for r in pairs.itertuples(index=False):
    deg[r.protein] += 1
    deg[r.utr] += 1

# ─────────────────────────────────────────────────────────────────────────────
log("[2] GO terms")

sig = go[go.q < 0.05].copy()
check("GO rows at q < 0.05", len(sig), 6389)
sig["tr"] = (sig.fold >= 2.0) & (sig.n_fam_support >= 5)
check("trusted GO rows (q<0.05 & fold>=2 & n_fam_support>=5)", int(sig.tr.sum()), 3530)
for m in range(1, 7):
    sub = sig[sig.module_id == m]
    check(f"M{m} n_sig vs module_leading_terms", len(sub), int(terms_hdr.loc[m, "n_sig"]))
    check(f"M{m} n_trusted vs module_leading_terms", int(sub.tr.sum()),
          int(terms_hdr.loc[m, "n_trusted"]))

# ─────────────────────────────────────────────────────────────────────────────
log("[3] per-module payloads")

# directional cross-module traffic, recomputed here and cross-checked against
# the matrix 08_network.py froze into network.json
matrix = net["meta"]["matrix"]
out_by: dict[int, Counter] = defaultdict(Counter)   # protein side in module m
in_by: dict[int, Counter] = defaultdict(Counter)    # UTR side in module m
edges_by_module: dict[int, list] = defaultdict(list)
for r in pairs.itertuples(index=False):
    pm, um = cl_module[r.protein], cl_module[r.utr]
    if pm and um:
        if pm == um:
            edges_by_module[pm].append(r)
        else:
            out_by[pm][um] += 1
            in_by[um][pm] += 1

written = []
for m in range(1, 7):
    s, th = summ.loc[m], terms_hdr.loc[m]

    members = sorted([n for n in node if cl_module[n] == m], key=lambda n: (-deg[n], n))
    prot = [n for n in members if cl_region[n] == "protein"]
    utr = [n for n in members if cl_region[n] != "protein"]
    check(f"M{m} protein members", len(prot), int(s.n_protein))
    check(f"M{m} UTR members", len(utr), int(s.n_utr))

    def cluster_card(nid: str) -> dict:
        nd = node[nid]
        return {
            "id": nid, "r": nd["r"], "deg": nd["deg"], "n": cl_inst[nid],
            "nt": cl_tx[nid], "ng": cl_genes[nid],
            "name": nd["name"], "tier": nd["tier"],
            "cons": nd["cons"], "cov": nd["cov"],
            "y2": nd["y2"],
        }

    sub = sig[sig.module_id == m].sort_values(["q", "p", "term"])
    term_rows = [{
        "t": str(r.term), "n": str(r["name"]),
        "k": int(r.k), "K": int(r.K),
        "f": round(float(r.fold), 2),
        "q": float(f"{float(r.q):.3g}"),
        "fs": int(r.n_fam_support),
        "df": round(float(r.dom_family_frac), 2),
        "tr": bool(r.tr),
    } for _, r in sub.iterrows()]

    gsub = geneix[geneix.module_id == m].sort_values(
        ["n_trusted_terms_hit", "n_sig_terms_hit", "gene_symbol"],
        ascending=[False, False, True])
    gene_rows = [{
        "s": str(r.gene_symbol),
        "rs": str(r.refseq_ids).split(";")[0],
        "nt": int(r.n_transcripts),
        "pf": int(r.paralog_families),
        "sig": int(r.n_sig_terms_hit),
        "trs": int(r.n_trusted_terms_hit),
    } for _, r in gsub.head(GENE_CAP).iterrows()]

    ee = sorted(edges_by_module[m], key=lambda r: (-r.phylo_corrected_score, r.protein, r.utr))
    check(f"M{m} internal edges vs frozen matrix", len(ee), matrix[m - 1][m - 1])
    edge_rows = [{
        "p": r.protein, "u": r.utr,
        "sc": round(float(r.phylo_corrected_score), 4),
        "npmi": round(float(r.npmi_mip_APC), 4),
        "co": int(r.co_count), "cl": int(r.n_indep_clades),
        "conc": None if pd.isna(r.clade_concentration) else round(float(r.clade_concentration), 3),
        "znf": None if pd.isna(r.frac_co_ZNF) else round(float(r.frac_co_ZNF), 4),
    } for r in ee[:EDGE_CAP]]

    check(f"M{m} cross-out vs frozen matrix", sum(out_by[m].values()),
          sum(matrix[m - 1][j] for j in range(6) if j != m - 1))
    check(f"M{m} cross-in vs frozen matrix", sum(in_by[m].values()),
          sum(matrix[i][m - 1] for i in range(6) if i != m - 1))

    payload = {
        "id": m,
        "label": MODULE_LABEL[m],
        "short": MODULE_SHORT[m],
        "color": MODULE_COLOR[m],
        "caveat": CAVEAT,
        "term_caveat": TERM_CAVEAT,
        "counts": {
            "n_protein": len(prot),
            "n_utr": len(utr),
            "n_clusters": len(members),
            "n_edges": len(ee),
            "n_cross_out": sum(out_by[m].values()),
            "n_cross_in": sum(in_by[m].values()),
            "mean_score": round(float(s.mean_score), 4),
            "mean_clades": round(float(s.mean_indep_clades), 1),
            "frac_znf": round(float(s.mean_frac_ZNF), 3),
            "genes": int(th.n_genes),
            "genes_hitting_a_term": len(gsub),
            "genes_shipped": len(gene_rows),
            "n_sig_terms": len(term_rows),
            "n_trusted_terms": sum(1 for t in term_rows if t["tr"]),
            "edges_shipped": len(edge_rows),
        },
        "leading_terms": [x.strip() for x in str(th.leading_terms).split(";") if x.strip()],
        "terms": term_rows,
        "clusters": {"protein": [cluster_card(n) for n in prot],
                     "utr": [cluster_card(n) for n in utr]},
        "genes": gene_rows,
        "edges": edge_rows,
        "cross": {
            "out": {str(k): int(v) for k, v in sorted(out_by[m].items())},
            "in": {str(k): int(v) for k, v in sorted(in_by[m].items())},
            "note": ("'out' counts edges whose PROTEIN cluster is in this module and whose UTR "
                     "cluster is elsewhere; 'in' is the reverse. The two are not mirror images -- "
                     "the module x module matrix is directional and asymmetric."),
        },
        "empty_states": {
            "clusters_with_no_significant_term":
                sum(1 for n in members if node[n]["tier"] >= 3),
            "clusters_with_no_consensus": sum(1 for n in members if node[n]["cons"] is None),
            "n_clusters": len(members),
        },
        "sort_keys_forbidden": ["npmi_raw"],
        "built": core_meta.get("built"),
    }

    path = OUTDIR / f"{m}.json"
    path.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False))
    sz = path.stat().st_size
    written.append((m, sz, len(term_rows), sum(1 for t in term_rows if t["tr"]),
                    len(members), len(gene_rows), len(ee)))
    log(f"       M{m}: {sz:>8,} B | {len(term_rows):>4} terms ({sum(1 for t in term_rows if t['tr'])} trusted)"
        f" | {len(members):>3} clusters | {len(gene_rows)}/{len(gsub)} genes"
        f" | {len(ee)} internal edges (top {len(edge_rows)} shipped)")

# ─────────────────────────────────────────────────────────────────────────────
log("[4] verify")

check("module files written", len(written), 6)
check("total member clusters across the 6 modules", sum(w[4] for w in written), 513)
check("total internal edges across the 6 modules", sum(w[6] for w in written), 1860)
check("total significant GO terms shipped", sum(w[2] for w in written), 6389)
check("total trusted GO terms shipped", sum(w[3] for w in written), 3530)
total = sum(w[1] for w in written)
log(f"       total modules/ payload {total:,} bytes ({total / 1e6:.3f} MB), "
    f"largest {max(w[1] for w in written):,} B")

for m, *_ in written:
    back = json.loads((OUTDIR / f"{m}.json").read_text())
    if back["id"] != m or not back["caveat"]:
        raise AssertionError(f"modules/{m}.json failed round-trip")
log(f"       round-trip OK for all 6 files in {OUTDIR}")

# The 6 clusters outside every module get NO module file by design; they are
# reachable via network.json meta.outside_module_nodes and their cluster shards.
outside = net["meta"]["outside_module_nodes"]
check("clusters outside every module (no module file, by design)", len(outside), 6)
log(f"       outside-module nodes: {', '.join(outside)}")
log("[done] 09_modules.py")
