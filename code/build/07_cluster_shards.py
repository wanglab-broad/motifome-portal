#!/usr/bin/env python
"""07_cluster_shards.py — one JSON per motif cluster, CONTRACT.md `cluster/<ID>.json`.

Reads only the cache written by 01_core.py / 02_streme.py plus the precomputed figure
intermediates named in paths.py.  Nothing is re-derived from the raw sources.

Honesty rules enforced here
---------------------------
* `npmi_raw` is present in PAIR_SCORES and is NEVER carried into a shard (invariant 5:
  25 of the top-30 raw associations are ZNF clade artifacts by the authors' own verdict).
  Only `npmi_mip_APC` ships, under the contract key `npmi`.
* `partners[]` is the COMPLETE scored partner set (600 UTR clusters for every protein
  cluster, 300 protein clusters for every UTR cluster), each with all four gate values
  and `pass`.  The UI filters; the shard never pre-filters, so the denominator is always
  recoverable ("8 of 600 pass").
* Every empty state carries its denominator.  `n_terms_total`, `n_partners_total`,
  `n_gated_partners` and the global census in _cache/cluster_shard_meta.json exist so no
  panel is ever blank without a number beside it.
* Logo is null for the 444 clusters with no STREME motif at test_pvalue < 0.05.  No
  fallback PWM is computed (VERIFIED FACT 7).
* Alphabet: everything in the payload is DNA (A/C/G/T) so the front end can apply the
  single T->U display rule for utr5/utr3 only (VERIFIED FACT 11).  `name.text` is the
  one exception — it is prose meant for direct display, so it is written in the RNA
  alphabet for UTR clusters, matching the manuscript.
* Annotation strings are never split on ',' (invariant 4).  InterPro terms are re-joined
  to their accessions through paths.INTERPRO_MAP instead.
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paths  # noqa: E402

CACHE = paths.HERE / "_cache"
OUTDIR = paths.OUT / "cluster"

FDR_GATE = 0.05
MAX_TERMS = 40          # median cluster has 28; max is 410
MAX_GENES = 500         # contract cap
MAX_CONS_PAIRS = 6

REGION_LABEL = {"utr5": "5'UTR", "utr3": "3'UTR", "protein": "Protein"}
REGION_UNIT = {"utr5": "nt", "utr3": "nt", "protein": "aa"}


# ── small helpers ──────────────────────────────────────────────────────────────
def jnum(x, nd=None):
    """numpy/NaN-safe scalar for json.dumps."""
    if x is None:
        return None
    if isinstance(x, (np.floating, float)):
        if not np.isfinite(x):
            return None
        return round(float(x), nd) if nd is not None else float(x)
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.bool_, bool)):
        return bool(x)
    return x


def to_dna(s):
    return s.replace("U", "T") if isinstance(s, str) else s


def to_rna(s):
    return s.replace("T", "U") if isinstance(s, str) else s


def display_seq(s, region):
    """DNA -> display alphabet.  T->U for UTRs only; protein U is selenocysteine."""
    return to_rna(s) if region in ("utr5", "utr3") else s


def composition_word(seq, region):
    """One honest compositional adjective, or '' when nothing dominates."""
    if not seq:
        return ""
    n = len(seq)
    f = Counter(seq)
    frac = lambda letters: sum(f[c] for c in letters) / n  # noqa: E731
    if region in ("utr5", "utr3"):
        if frac("CT") >= 0.8:
            return "pyrimidine-rich"
        if frac("AG") >= 0.8:
            return "purine-rich"
        for b, disp in (("T", "U"), ("A", "A"), ("C", "C"), ("G", "G")):
            if frac(b) >= 0.6:
                return f"{disp}-rich"
        if frac("GC") >= 0.8:
            return "GC-rich"
        return ""
    # protein
    if frac("AVLIMFWC") >= 0.65:
        return "hydrophobic"
    if frac("DE") >= 0.40:
        return "acidic"
    if frac("KR") >= 0.40:
        return "basic"
    for aa, word in (("P", "proline-rich"), ("G", "glycine-rich"),
                     ("Q", "glutamine-rich"), ("S", "serine-rich"),
                     ("E", "glutamate-rich"), ("A", "alanine-rich"),
                     ("L", "leucine-rich")):
        if frac(aa) >= 0.35:
            return word
    if frac("ST") >= 0.45:
        return "Ser/Thr-rich"
    return ""


# ── load ───────────────────────────────────────────────────────────────────────
def load():
    d = {}
    d["clusters"] = pd.read_parquet(CACHE / "clusters.parquet")
    d["core_meta"] = json.loads((CACHE / "core_meta.json").read_text())
    d["streme"] = json.loads((CACHE / "streme.json").read_text())
    d["streme_meta"] = d["streme"].pop("_meta")

    d["cons"] = pd.read_csv(paths.CONSENSUS_META)
    d["enrich"] = pd.read_csv(paths.CLUSTER_ENRICH)
    d["labels"] = pd.read_csv(paths.CLUSTER_LABELS)
    d["ipr"] = pd.read_csv(paths.INTERPRO_MAP)
    d["pairs"] = pd.read_csv(paths.PAIR_SCORES)
    d["cpairs"] = pd.read_csv(paths.CONSENSUS_PAIRS)

    master = pd.read_parquet(CACHE / "master.parquet",
                             columns=["motif_cluster", "gene_symbol"])
    d["carriers"] = master
    return d


def main():
    D = load()
    cl = D["clusters"]
    ids = cl["cluster_id"].tolist()
    assert len(ids) == 900 == len(set(ids)), f"expected 900 clusters, got {len(ids)}"
    region_of = dict(zip(cl.cluster_id, cl.region))
    module_of = dict(zip(cl.cluster_id, cl.module.astype(int)))
    qlev = D["core_meta"]["quantile_levels"]

    # ── carrier gene symbols per cluster (order: most instances first) ─────────
    car = (D["carriers"].groupby(["motif_cluster", "gene_symbol"])
           .size().rename("n").reset_index()
           .sort_values(["motif_cluster", "n", "gene_symbol"],
                        ascending=[True, False, True]))
    genes_by_cluster = defaultdict(list)
    for c, g in zip(car.motif_cluster.values, car.gene_symbol.values):
        genes_by_cluster[c].append(g)

    # ── consensus ─────────────────────────────────────────────────────────────
    cons_by_cluster = defaultdict(list)
    cons_sorted = D["cons"].sort_values(["cluster", "coverage"],
                                        ascending=[True, False])
    for r in cons_sorted.itertuples(index=False):
        cons_by_cluster[r.cluster].append({
            "cid": r.cid,
            "text": to_dna(r.consensus),
            "coverage": jnum(r.coverage, 4),
            "carriers": int(r.carriers),
        })

    # ── enrichment terms ──────────────────────────────────────────────────────
    name2acc = dict(zip(D["ipr"]["name"], D["ipr"]["ipr"]))
    en = D["enrich"]
    sig = en[(en.fdr_cluster < FDR_GATE) & (en.informative)].copy()
    sig = sig.sort_values(["cluster", "fdr_cluster", "fold"],
                          ascending=[True, True, False])
    n_terms_total = sig.groupby("cluster").size().to_dict()
    terms_by_cluster = defaultdict(list)
    for c, grp in sig.groupby("cluster", sort=False):
        out = []
        for r in grp.head(MAX_TERMS).itertuples(index=False):
            term = r.term
            if r.source == "InterPro":
                term = name2acc.get(r.term, r.term)   # re-join, never str.split(',')
            out.append({
                "src": r.source,
                "term": term,
                "display": r.display if isinstance(r.display, str) else str(r.term),
                "fold": jnum(r.fold, 3),
                "k": int(r.k),
                "n": int(r.n),
                "fdr": jnum(r.fdr_cluster),
            })
        terms_by_cluster[c] = out

    # curated leading labels (37 clusters, rank 1 only)
    lab = D["labels"].sort_values(["cluster", "rank"])
    curated = {}
    for c, grp in lab.groupby("cluster", sort=False):
        top = grp.iloc[0]
        curated[c] = {"display": top["display"], "source_db": top["source"]}

    # ── partners ──────────────────────────────────────────────────────────────
    P = D["pairs"]
    n_partner_rows = len(P)
    # consensus-level pairs, keyed by (p_cluster, u_cluster)
    CP = D["cpairs"].sort_values(
        ["p_cluster", "u_cluster", "phylo_corrected_score", "npmi_mip_APC"],
        ascending=[True, True, False, False])
    cpair_by_edge = defaultdict(list)
    for r in CP.itertuples(index=False):
        k = (r.p_cluster, r.u_cluster)
        if len(cpair_by_edge[k]) < MAX_CONS_PAIRS:
            cpair_by_edge[k].append(
                (to_dna(r.p_consensus), to_dna(r.u_consensus),
                 jnum(r.phylo_corrected_score, 4)))

    partners = defaultdict(list)
    for r in P.itertuples(index=False):
        rec_core = {
            "id": None,
            "score": jnum(r.phylo_corrected_score, 4),
            "npmi": jnum(r.npmi_mip_APC, 4),
            "co": int(r.co_count),
            "clades": int(r.n_indep_clades),
            "conc": jnum(r.clade_concentration, 3),
            "znf": jnum(r.frac_co_ZNF, 3),
            "pass": bool(r.passes_phylo_filter),
        }
        cps = cpair_by_edge.get((r.protein, r.utr))
        # protein cluster's row: partner is the UTR cluster
        a = dict(rec_core, id=r.utr, module=module_of.get(r.utr, 0))
        b = dict(rec_core, id=r.protein, module=module_of.get(r.protein, 0))
        if cps:
            # contract order is [self_consensus, partner_consensus, score]
            a["consensus_pairs"] = [[p, u, s] for p, u, s in cps]
            b["consensus_pairs"] = [[u, p, s] for p, u, s in cps]
        partners[r.protein].append(a)
        partners[r.utr].append(b)
    for c in partners:
        partners[c].sort(key=lambda d: (-(d["score"] or 0.0), -(d["npmi"] or -9),
                                        -d["co"], d["id"]))

    # ── name resolution ───────────────────────────────────────────────────────
    def resolve_name(cid, region):
        if cid in curated:
            return {"text": curated[cid]["display"], "tier": 1,
                    "source": f"cluster_term_labels:{curated[cid]['source_db']}"}
        t = terms_by_cluster.get(cid)
        if t:
            return {"text": t[0]["display"], "tier": 1,
                    "source": f"term_enrichment:{t[0]['src']}"}
        cs = cons_by_cluster.get(cid)
        if cs:
            top = cs[0]
            disp = display_seq(top["text"], region)
            word = composition_word(top["text"], region)
            unit = "mer"
            bits = [disp]
            if word:
                bits.append(word)
            bits.append(f"{len(top['text'])}-{unit}")
            return {"text": ", ".join(bits), "tier": 2,
                    "source": f"consensus:{top['cid']}"}
        row = cl.loc[cl.cluster_id == cid].iloc[0]
        num = cid.split("_")[-1]
        med = int(round(float(row.len_median)))
        return {"text": f"{REGION_LABEL[region]} cluster {num}, "
                        f"{med}-{REGION_UNIT[region]} median",
                "tier": 3, "source": "derived"}

    # ── write ─────────────────────────────────────────────────────────────────
    OUTDIR.mkdir(parents=True, exist_ok=True)
    for old in OUTDIR.glob("*.json"):
        old.unlink()

    sizes = []
    n_logo = n_term = n_module = n_pass = n_consensus = 0
    tier_count = Counter()
    src_count = Counter()

    for row in cl.itertuples(index=False):
        cid = row.cluster_id
        region = row.region
        logo = D["streme"].get(cid)
        if logo is not None:
            logo = {"pwm": logo["pwm"], "alphabet": logo["alphabet"],
                    "evalue": logo["evalue"], "nsites": logo["nsites"],
                    "source": logo["source"], "motif_id": logo["motif_id"],
                    "test_pvalue": logo["test_pvalue"], "width": logo["width"]}
            n_logo += 1

        lengths = {str(int(L)): int(c)
                   for L, c in zip(list(row.hist_length), list(row.hist_count))}

        plddt = None
        if row.plddt_median is not None and np.isfinite(np.float64(
                row.plddt_median if row.plddt_median is not None else np.nan)):
            plddt = {"median": jnum(row.plddt_median, 4),
                     "q": [jnum(v, 4) for v in list(row.plddt_q)]}

        pl = partners.get(cid, [])
        npass = sum(1 for p in pl if p["pass"])
        terms = terms_by_cluster.get(cid, [])
        cons = cons_by_cluster.get(cid, [])
        gl = genes_by_cluster.get(cid, [])
        name = resolve_name(cid, region)
        tier_count[name["tier"]] += 1
        src_count[name["source"].split(":")[0]] += 1

        if terms:
            n_term += 1
        if int(row.module) != 0:
            n_module += 1
        if npass:
            n_pass += 1
        if cons:
            n_consensus += 1

        shard = {
            "id": cid,
            "region": region,
            "module": int(row.module),
            "name": name,
            "size": {
                "instances": int(row.n_instances),
                "transcripts": int(row.n_transcripts),
                "genes": int(row.n_genes),
                "lengths": lengths,
                "len_median": jnum(row.len_median, 1),
            },
            "logo": logo,
            "consensus": cons,
            "position": [jnum(v, 5) for v in list(row.position)],
            "stats": {
                "score": {"median": jnum(row.score_median, 4),
                          "q": [jnum(v, 4) for v in list(row.score_q)]},
                "entropy": {"median": jnum(row.entropy_median, 4),
                            "q": [jnum(v, 4) for v in list(row.entropy_q)]},
                "plddt": plddt,
                "quantile_levels": qlev,
            },
            "terms": terms,
            "n_terms_total": int(n_terms_total.get(cid, 0)),
            "partners": pl,
            "n_partners_total": len(pl),
            "n_partners_passing": npass,
            "genes": gl[:MAX_GENES],
            "n_genes_total": len(gl),
        }
        # sanity: n_gated_partners from the cache must equal what we just counted
        assert npass == int(row.n_gated_partners), (
            f"{cid}: passing partners {npass} != cached {row.n_gated_partners}")

        txt = json.dumps(shard, separators=(",", ":"), allow_nan=False)
        (OUTDIR / f"{cid}.json").write_text(txt)
        sizes.append(len(txt))

    sizes = np.array(sizes)
    meta = {
        "n_shards": len(sizes),
        "coverage": {
            "logo": n_logo, "logo_null": 900 - n_logo,
            "terms": n_term, "terms_null": 900 - n_term,
            "module": n_module, "module_null": 900 - n_module,
            "passing_partner": n_pass, "passing_partner_null": 900 - n_pass,
            "consensus": n_consensus, "consensus_null": 900 - n_consensus,
        },
        "utr_no_gated_partner": int(sum(
            1 for r in cl.itertuples(index=False)
            if r.region in ("utr3", "utr5") and int(r.n_gated_partners) == 0)),
        "prot_no_gated_partner": int(sum(
            1 for r in cl.itertuples(index=False)
            if r.region == "protein" and int(r.n_gated_partners) == 0)),
        "name_tiers": dict(tier_count),
        "name_sources": dict(src_count),
        "fdr_gate": FDR_GATE,
        "fdr_column": "fdr_cluster",
        "max_terms_per_shard": MAX_TERMS,
        "max_genes_per_shard": MAX_GENES,
        "partner_rows_consumed": n_partner_rows,
        "gated_edges_with_consensus_pair": int(sum(
            1 for k in cpair_by_edge
            if k in set(zip(P.loc[P.passes_phylo_filter, "protein"],
                            P.loc[P.passes_phylo_filter, "utr"])))),
        "bytes": {
            "total": int(sizes.sum()), "min": int(sizes.min()),
            "median": int(np.median(sizes)), "mean": int(sizes.mean()),
            "p95": int(np.percentile(sizes, 95)), "max": int(sizes.max()),
        },
        "npmi_raw_carried": False,
    }
    (CACHE / "cluster_shard_meta.json").write_text(json.dumps(meta, indent=1))

    print("=" * 72)
    print("07_cluster_shards.py")
    print("=" * 72)
    print(f"  shards written ......... {len(sizes)} -> {OUTDIR}")
    b = meta["bytes"]
    print(f"  size  min {b['min']/1024:8.1f} KB   median {b['median']/1024:8.1f} KB"
          f"   mean {b['mean']/1024:8.1f} KB")
    print(f"        p95 {b['p95']/1024:8.1f} KB   max    {b['max']/1024:8.1f} KB"
          f"   total {b['total']/1e6:6.1f} MB")
    c = meta["coverage"]
    print(f"  logo             {c['logo']:4d}/900  ({100*c['logo']/900:.1f}%)"
          f"   null {c['logo_null']}")
    print(f"  >=1 term FDR<.05 {c['terms']:4d}/900  ({100*c['terms']/900:.1f}%)"
          f"   null {c['terms_null']}")
    print(f"  module assigned  {c['module']:4d}/900  ({100*c['module']/900:.1f}%)"
          f"   null {c['module_null']}")
    print(f"  >=1 gated partner{c['passing_partner']:4d}/900 "
          f"({100*c['passing_partner']/900:.1f}%)   null {c['passing_partner_null']}")
    print(f"  >=1 consensus    {c['consensus']:4d}/900   null {c['consensus_null']}")
    print(f"  UTR clusters with 0 gated partners:  {meta['utr_no_gated_partner']}/600")
    print(f"  protein clusters with 0 gated ptnrs: {meta['prot_no_gated_partner']}/300")
    print(f"  name tiers {dict(tier_count)}  sources {dict(src_count)}")
    print(f"  gated edges carrying a consensus pair: "
          f"{meta['gated_edges_with_consensus_pair']}/2620")


if __name__ == "__main__":
    main()
