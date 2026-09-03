#!/usr/bin/env python
"""11_cluster_index.py — the 900-row cluster index the browse view needs.

WHY THIS EXISTS (flagged in the R2 report, not a silent deviation)
------------------------------------------------------------------
CONTRACT.md ships one shard per cluster (48 MB over 900 files, median 41 KB).  The
faceted browser has to show EVERY cluster at once — 900 points in a scatter, six facet
groups whose counts are recomputed live against the other active filters, and a sortable
table.  There is no payload in the contract that carries all 900 clusters:
`network.json` carries only the 519 clusters touched by a gated edge, so it is blind to
exactly the 381 clusters whose designed empty states the atlas is supposed to be honest
about.  Fetching 900 shards to draw one page is not an option.

So this script derives a small index (~200 KB raw) FROM the already-written shards.  It
invents nothing: every field is copied or counted out of `portal/data/cluster/*.json`.

TWO OUTPUTS, same content
-------------------------
  portal/data/cluster_index.json   the canonical payload (a contract addition)
  portal/js/cluster-index.js       the same object as an ES module

The second exists because `portal/js/data.js` is the only module allowed to fetch and it
has no getter for this payload, and it is not R2's file to edit.  A view importing a
generated ES module issues no fetch(), so the rule holds.  When data.js grows a
`getClusterIndex()`, the .js copy can be deleted and the views switched to it.

THE GATE
--------
`passes_phylo_filter` in paths.PAIR_SCORES is reproduced EXACTLY (180,000/180,000 rows,
2,620 pass, 0 false positives, 0 false negatives) by four conditions:

    co_count >= 10  AND  n_indep_clades >= 8  AND
    clade_concentration < 0.35  AND  npmi_mip_APC > 0.10

A fifth condition frac_co_ZNF <= 0.40 is satisfied by every pair that clears those four
(max on a passing pair is exactly 0.400), so it is reported as a diagnostic, not a gate.
That measurement is re-run here with --verify-gate so the number in the UI can never
drift away from the source table.

`npmi_raw` is not read, not counted and not written.  It is not in the shards either.
"""
import argparse
import json
import sys
from collections import Counter
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paths  # noqa: E402

SRC = paths.OUT / "cluster"
OUT_JSON = paths.OUT / "cluster_index.json"
# The ES-module mirror was removed: data.js now fetches data/cluster_index.json
# directly via getClusterIndex(), so shipping the same 379 KB twice was pure weight.
OUT_JS = None

# The gate, verified against paths.PAIR_SCORES (see --verify-gate).
GATE = {
    "co":     {"label": "co-occurrence",        "op": ">=", "t": 10,   "hi": True},
    "clades": {"label": "independent clades",   "op": ">=", "t": 8,    "hi": True},
    "conc":   {"label": "clade concentration",  "op": "<",  "t": 0.35, "hi": False},
    "npmi":   {"label": "NPMI (MI-adj + APC)",  "op": ">",  "t": 0.10, "hi": True},
}
ZNF = {"label": "ZNF-clade share", "op": "<=", "t": 0.40, "hi": False}

QL = [0.0, 0.05, 0.25, 0.5, 0.75, 0.95, 1.0]


def passes(p):
    return (p["co"] >= 10 and p["clades"] >= 8
            and p["conc"] is not None and p["conc"] < 0.35
            and p["npmi"] > 0.10)


def suggestive(p):
    """The labelled superset: clears the co-occurrence evidence floor (count and NPMI)
    but not necessarily the two phylogenetic-independence gates."""
    return p["co"] >= 10 and p["npmi"] > 0.10


def pct_rank(sorted_vals, v):
    """Percentile of v among sorted_vals, 0-100, by fraction strictly below."""
    lo, hi = 0, len(sorted_vals)
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_vals[mid] < v:
            lo = mid + 1
        else:
            hi = mid
    return round(100.0 * lo / max(1, len(sorted_vals) - 1), 1)


def median(xs):
    s = sorted(xs)
    n = len(s)
    if not n:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def verify_gate():
    import pandas as pd
    f = pd.read_csv(paths.PAIR_SCORES)
    g = ((f.co_count >= 10) & (f.n_indep_clades >= 8)
         & (f.clade_concentration < 0.35) & (f.npmi_mip_APC > 0.10))
    fp = int((g & ~f.passes_phylo_filter).sum())
    fn = int((~g & f.passes_phylo_filter).sum())
    znf_max = float(f.loc[f.passes_phylo_filter, "frac_co_ZNF"].max())
    print(f"  gate check: {len(f):,} rows · reconstructed {int(g.sum()):,} · "
          f"source {int(f.passes_phylo_filter.sum()):,} · fp {fp} · fn {fn}")
    print(f"  frac_co_ZNF max on a passing pair: {znf_max:.3f} "
          f"(the <= 0.40 condition never binds)")
    assert fp == 0 and fn == 0, "gate reconstruction drifted from passes_phylo_filter"
    return {"rows": int(len(f)), "reconstructed": int(g.sum()),
            "source": int(f.passes_phylo_filter.sum()), "fp": fp, "fn": fn,
            "znf_max_on_pass": round(znf_max, 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-gate", action="store_true",
                    help="re-derive passes_phylo_filter from paths.PAIR_SCORES")
    args = ap.parse_args()

    files = sorted(SRC.glob("*.json"))
    assert len(files) == 900, f"expected 900 cluster shards, found {len(files)}"

    gate_check = verify_gate() if args.verify_gate else None

    rows = []
    ghost_src = {}          # region -> {'score': [ [q0..q6], ... ], 'entropy': [...], 'plddt': [...]}
    cons_cov = {"all": [], "utr5": [], "utr3": [], "protein": []}

    for fp_ in files:
        d = json.loads(fp_.read_text())
        r = d["region"]
        size = d["size"]
        logo = d.get("logo")
        terms = d.get("terms") or []
        cons = d.get("consensus") or []
        partners = d.get("partners") or []
        stats = d.get("stats") or {}

        npass = sum(1 for p in partners if passes(p))
        assert npass == int(d["n_partners_passing"]), (
            f"{d['id']}: recomputed gate {npass} != shard n_partners_passing "
            f"{d['n_partners_passing']}")
        nsug = sum(1 for p in partners if suggestive(p))

        strict = [p for p in partners if p["pass"]]
        strict.sort(key=lambda p: (-p["score"], -p["npmi"]))
        best = strict[0] if strict else None

        top_term = terms[0] if terms else None
        top_cons = cons[0] if cons else None
        for c in cons:
            cons_cov["all"].append(c["coverage"])
            cons_cov[r].append(c["coverage"])

        gs = ghost_src.setdefault(r, {"score": [], "entropy": [], "plddt": []})
        for k in ("score", "entropy", "plddt"):
            blk = stats.get(k)
            if blk and blk.get("q"):
                gs[k].append(blk["q"])

        rows.append({
            "id": d["id"], "r": r, "m": d.get("module") or 0,
            "ni": size["instances"], "ntx": size["transcripts"], "ng": size["genes"],
            "lmed": size.get("len_median"),
            "logo": 1 if logo else 0,
            "ev": (logo or {}).get("evalue"),
            "lw": (logo or {}).get("width"),
            "nterms": int(d.get("n_terms_total") or 0),
            "tsrc": top_term["src"] if top_term else None,
            "tdisp": top_term["display"] if top_term else None,
            "tfold": round(top_term["fold"], 2) if top_term else None,
            "npass": npass, "nptot": int(d.get("n_partners_total") or len(partners)),
            "nsug": nsug,
            "best": best["id"] if best else None,
            "bestsc": round(best["score"], 4) if best else None,
            "name": d["name"]["text"], "tier": d["name"]["tier"],
            "nsrc": d["name"]["source"],
            "cons": top_cons["text"] if top_cons else None,
            "cov": top_cons["coverage"] if top_cons else None,
            "ncons": len(cons),
            "smed": (stats.get("score") or {}).get("median"),
            "emed": (stats.get("entropy") or {}).get("median"),
            "pmed": (stats.get("plddt") or {}).get("median"),
        })

    # ── percentiles within the 900-cluster rail ────────────────────────────────
    for key, out in (("ni", "qi"), ("ntx", "qt"), ("ng", "qg")):
        vals = sorted(x[key] for x in rows)
        for x in rows:
            x[out] = pct_rank(vals, x[key])

    # ── size buckets: corpus quartiles of instance count, edges printed in the UI ─
    inst = sorted(x["ni"] for x in rows)
    q1, q2, q3 = (inst[len(inst) // 4], inst[len(inst) // 2], inst[3 * len(inst) // 4])
    edges = [(inst[0], q1 - 1), (q1, q2 - 1), (q2, q3 - 1), (q3, inst[-1])]
    names = ["smallest quartile", "second quartile", "third quartile", "largest quartile"]
    buckets = []
    for i, (lo, hi) in enumerate(edges):
        n = sum(1 for x in rows if lo <= x["ni"] <= hi)
        buckets.append({"key": "q" + str(i + 1), "label": names[i],
                        "min": int(lo), "max": int(hi), "n": n})
        for x in rows:
            if lo <= x["ni"] <= hi:
                x["sb"] = "q" + str(i + 1)

    # ── ghost corpus outline: the median cluster's quantile curve, per region ───
    ghost = {}
    for r, blocks in ghost_src.items():
        g = {}
        for k, curves in blocks.items():
            if not curves:
                g[k] = None
                continue
            g[k] = {
                "q": [round(median([c[i] for c in curves]), 4) for i in range(len(QL))],
                "lo": round(min(c[0] for c in curves), 4),
                "hi": round(max(c[-1] for c in curves), 4),
                "n": len(curves),
            }
        ghost[r] = g

    counts = Counter(x["r"] for x in rows)
    meta = {
        "built": str(date.today()),
        "source": "derived from portal/data/cluster/*.json by code/build/11_cluster_index.py",
        "counts": {
            "clusters": len(rows),
            "utr5": counts["utr5"], "utr3": counts["utr3"], "protein": counts["protein"],
            "no_logo": sum(1 for x in rows if not x["logo"]),
            "no_terms": sum(1 for x in rows if not x["nterms"]),
            "no_module": sum(1 for x in rows if not x["m"]),
            "no_strict_partner": sum(1 for x in rows if not x["npass"]),
            "no_consensus": sum(1 for x in rows if not x["ncons"]),
            "utr_no_strict_partner": sum(1 for x in rows
                                         if x["r"] != "protein" and not x["npass"]),
            "prot_no_strict_partner": sum(1 for x in rows
                                          if x["r"] == "protein" and not x["npass"]),
            "strict_edges": sum(x["npass"] for x in rows) // 2,
        },
        "gate": GATE, "znf": ZNF, "gate_check": gate_check,
        "quantile_levels": QL,
        "size_buckets": buckets,
        "cons_coverage_median": {k: (round(median(v), 4) if v else None)
                                 for k, v in cons_cov.items()},
        "ghost": ghost,
        "sort_keys_forbidden": ["npmi_raw"],
    }
    payload = {"meta": meta, "rows": rows}

    blob = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    OUT_JSON.write_text(blob)

    c = meta["counts"]
    print(f"[cluster_index] {len(rows)} rows -> {OUT_JSON.name} ({len(blob):,} B)")
    print(f"  regions utr5 {c['utr5']} · utr3 {c['utr3']} · protein {c['protein']}")
    print(f"  no logo {c['no_logo']}/900 · no terms {c['no_terms']}/900 · "
          f"no module {c['no_module']}/900 · no strict partner {c['no_strict_partner']}/900")
    print(f"  UTR clusters with no strict partner {c['utr_no_strict_partner']}/600 · "
          f"protein {c['prot_no_strict_partner']}/300 · "
          f"strict edges (pairs/2) {c['strict_edges']}")
    print(f"  size buckets: " + " · ".join(
        f"{b['label']} {b['min']}-{b['max']} n={b['n']}" for b in buckets))
    for r in ("utr5", "utr3", "protein"):
        g = ghost[r]["score"]
        print(f"  ghost {r:<7} score median-curve {g['q']}  (n={g['n']})")

    # assertions the atlas prints as denominators
    assert c["no_logo"] == 444, c["no_logo"]
    assert c["no_terms"] == 437, c["no_terms"]
    assert c["no_module"] == 387, c["no_module"]
    assert c["utr_no_strict_partner"] == 282, c["utr_no_strict_partner"]
    assert c["prot_no_strict_partner"] == 99, c["prot_no_strict_partner"]
    assert c["strict_edges"] == 2620, c["strict_edges"]
    print("  assertions: 444/437/387/282/99/2620 all reproduce")


if __name__ == "__main__":
    main()
