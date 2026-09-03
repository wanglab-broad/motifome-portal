#!/usr/bin/env python
"""08_network.py — bake portal/data/network.json  (CONTRACT.md § network.json)

R3 payload: the gated protein-cluster x UTR-cluster association graph.

  nodes  every cluster touched by >=1 gated edge            -> 519
  edges  paths.PAIR_PASSING, all passes_phylo_filter==True  -> 2,620
  x/y    FROZEN spring layout, networkx seed=7, box 0-1000
  x2/y2  FROZEN per-module bipartite layout (protein column left, UTR right,
         barycenter crossing-minimisation), box 0-1000
  logo   TRIMMED STREME matrix (top 4 letters/position at 2 dp + exact bits) on
         the 456 of 519 nodes that have one, so the drill-down can draw a real
         sequence logo in the node glyph; the other 63 carry no logo key
  meta   asymmetric 6x6 protein-module x UTR-module count matrix, module cards,
         component/degree census, the non-dismissible caveat, empty-state denominators

Everything numeric is asserted against the independently measured values in the
brief; a mismatch raises. Run:  /opt/anaconda3/envs/bio/bin/python 08_network.py
"""
from __future__ import annotations

import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paths as P  # noqa: E402

CACHE = Path(__file__).resolve().parent / "_cache"
OUT = P.OUT
OUT.mkdir(parents=True, exist_ok=True)

SEED = 7
BOX = 1000.0

# Okabe-Ito, straight out of CONTRACT.md § Module colours
MODULE_COLOR = {
    1: "#E69F00", 2: "#56B4E9", 3: "#009E73",
    4: "#F0E442", 5: "#0072B2", 6: "#D55E00", 0: "#9AA5B1",
}
REGION_COLOR = {"utr5": "#0072B2", "utr3": "#0072B2", "protein": "#D55E00"}

# Short human labels. Each is a compression of that module's own leading terms
# in paths.MODULE_TERMS -- no label asserts anything the enrichment does not.
MODULE_LABEL = {
    1: "Transcriptional / developmental regulation",
    2: "Transcription factors & nucleotide-exchange signalling",
    3: "Secretory, membrane & extracellular matrix",
    4: "Immune & host defence",
    5: "RNA processing & splicing",
    6: "Translation & histone / chromatin structure",
}
MODULE_SHORT = {
    1: "Transcription I", 2: "Transcription II", 3: "Secretory / membrane",
    4: "Immune", 5: "RNA processing", 6: "Translation / histone",
}

CAVEAT = (
    "Module membership and every edge here are STATISTICAL CO-OCCURRENCE of motif "
    "clusters across transcripts. They are not evidence of a physical interaction "
    "between the protein motif and the UTR motif. Layout distance carries no meaning."
)


def log(msg: str) -> None:
    print(msg, flush=True)


def check(label: str, got, want) -> None:
    ok = got == want
    log(f"  [{'OK  ' if ok else 'FAIL'}] {label}: {got}" + ("" if ok else f"  (expected {want})"))
    if not ok:
        raise AssertionError(f"{label}: got {got}, expected {want}")


# ─────────────────────────────────────────────────────────────────────────────
# 1. load
# ─────────────────────────────────────────────────────────────────────────────
log("[1] loading")

clusters = pd.read_parquet(CACHE / "clusters.parquet")
core_meta = json.loads((CACHE / "core_meta.json").read_text())

# the same STREME cache 07_cluster_shards.py reads; the shards keep the full
# matrix, the network payload gets the trimmed one (section 3b)
streme = json.loads((CACHE / "streme.json").read_text())
streme.pop("_meta", None)

pairs = pd.read_csv(P.PAIR_PASSING)
check("PAIR_PASSING rows", len(pairs), P.N_GATED_EDGES)
if not bool(pairs["passes_phylo_filter"].all()):
    raise AssertionError("PAIR_PASSING contains a row with passes_phylo_filter False")
check("duplicate (protein,utr) pairs", int(pairs.duplicated(["protein", "utr"]).sum()), 0)

cmeta = pd.read_csv(P.CONSENSUS_META)
cpairs = pd.read_csv(P.CONSENSUS_PAIRS, usecols=["p_cluster", "u_cluster"])
enrich = pd.read_csv(
    P.CLUSTER_ENRICH,
    usecols=["cluster", "source", "term", "display", "fold", "k", "n", "fdr_cluster", "informative"],
)

cl_region = dict(zip(clusters.cluster_id, clusters.region))
cl_module = {k: int(v) for k, v in zip(clusters.cluster_id, clusters.module)}
cl_inst = {k: int(v) for k, v in zip(clusters.cluster_id, clusters.n_instances)}
cl_tx = {k: int(v) for k, v in zip(clusters.cluster_id, clusters.n_transcripts)}
cl_genes = {k: int(v) for k, v in zip(clusters.cluster_id, clusters.n_genes)}
cl_gpart = {k: int(v) for k, v in zip(clusters.cluster_id, clusters.n_gated_partners)}
cl_pos = {k: list(v) for k, v in zip(clusters.cluster_id, clusters.position)}

# ─────────────────────────────────────────────────────────────────────────────
# 2. node set
# ─────────────────────────────────────────────────────────────────────────────
log("[2] node set")

prot_ids = sorted(set(pairs["protein"]))
utr_ids = sorted(set(pairs["utr"]))
node_ids = sorted(set(prot_ids) | set(utr_ids))
check("nodes touched by a gated edge", len(node_ids), 519)
log(f"       protein nodes {len(prot_ids)} | UTR nodes {len(utr_ids)}")

missing = [n for n in node_ids if n not in cl_region]
if missing:
    raise AssertionError(f"{len(missing)} network nodes absent from clusters.parquet: {missing[:5]}")
if any(cl_region[n] != "protein" for n in prot_ids):
    raise AssertionError("a 'protein' endpoint is not a protein cluster")
if any(cl_region[n] == "protein" for n in utr_ids):
    raise AssertionError("a 'utr' endpoint is a protein cluster")

deg = Counter()
for p, u in zip(pairs["protein"], pairs["utr"]):
    deg[p] += 1
    deg[u] += 1
check("max degree", max(deg.values()), 62)
# degree must reproduce the n_gated_partners column baked by 01_core.py
bad_deg = [n for n in node_ids if deg[n] != cl_gpart[n]]
check("nodes whose degree != clusters.n_gated_partners", len(bad_deg), 0)

# ─────────────────────────────────────────────────────────────────────────────
# 3. names  (tier 1 strong term / 2 weak term / 3 consensus-derived / 4 none)
# ─────────────────────────────────────────────────────────────────────────────
log("[3] names")

# top consensus per cluster: highest coverage, ties broken by cid for determinism
cmeta = cmeta.sort_values(["cluster", "coverage", "cid"], ascending=[True, False, True])
top_cons = cmeta.drop_duplicates("cluster").set_index("cluster")
n_with_cons = len(set(node_ids) & set(top_cons.index))
log(f"       clusters with a consensus repertoire: {len(top_cons)} "
    f"({n_with_cons} of {len(node_ids)} network nodes)")
# consensus_meta already stores UTR consensus in the RNA alphabet -- never re-map
utr_cons = top_cons[top_cons.region != "protein"]["consensus"]
check("UTR consensus strings containing 'T' (must be 0, already RNA)",
      int(utr_cons.str.contains("T").sum()), 0)

sig = enrich[(enrich.fdr_cluster < 0.05) & (enrich.informative == True)].copy()  # noqa: E712
check("clusters with no significant term (denominator)", 900 - sig.cluster.nunique(), 437)
sig = sig.sort_values(["cluster", "fdr_cluster", "term"], ascending=[True, True, True])
top_term = sig.drop_duplicates("cluster").set_index("cluster")


def consensus_descriptor(text: str, region: str) -> str:
    """A derived, non-inflated name: the string plus its plain composition."""
    L = len(text)
    if region == "protein":
        return f"{text}, {L}-mer peptide"
    pyr = sum(c in "CU" for c in text) / L
    pur = sum(c in "AG" for c in text) / L
    au = sum(c in "AU" for c in text) / L
    if pyr >= 0.8:
        flavour = "pyrimidine-rich"
    elif pur >= 0.8:
        flavour = "purine-rich"
    elif au >= 0.8:
        flavour = "AU-rich"
    else:
        flavour = "mixed"
    return f"{text}, {flavour} {L}-mer"


names: dict[str, tuple[str, int, str]] = {}
tier_counts = Counter()
for nid in node_ids:
    region = cl_region[nid]
    if nid in top_term.index:
        row = top_term.loc[nid]
        text = str(row["display"])
        tier = 1 if float(row["fold"]) >= 2.0 else 2
        source = str(row["source"])
    elif nid in top_cons.index:
        text = consensus_descriptor(str(top_cons.loc[nid, "consensus"]), region)
        tier, source = 3, "derived"
    else:
        text, tier, source = nid, 4, "none"
    names[nid] = (text, tier, source)
    tier_counts[tier] += 1
log("       name tiers: " + ", ".join(f"t{t}={tier_counts[t]}" for t in sorted(tier_counts)))

# ─────────────────────────────────────────────────────────────────────────────
# 3b. node logos — the trimmed STREME matrix the drill-down draws inline
# ─────────────────────────────────────────────────────────────────────────────
log("[3b] node logos")

LOGO_TOP_K = 4       # letters kept per position
LOGO_DECIMALS = 2    # probability precision kept (shipped as an integer percent)


def trim_logo(logo: dict) -> dict:
    """The node-glyph payload: exact per-position information content plus the
    top LOGO_TOP_K letters at LOGO_DECIMALS decimals.

    WHY TRIMMED.  The drill-down draws these ~10 px tall, where a letter under
    p=0.02 is sub-pixel: nothing visible is lost and the full matrices cost 3x
    the bytes.  The cluster shard still serves the complete PWM, so no analysis
    ever reads the trimmed copy.

    WHY `bits` IS SHIPPED RATHER THAN RECOMPUTED.  Information content needs the
    WHOLE column, H = -sum p log2 p over all 20 amino acids.  Recomputing it in
    the browser from a truncated column would understate H and so OVERSTATE the
    information content of every protein logo.  It is computed here, from the
    full matrix, and travels with the trimmed one.

    ENCODING.  `top[i]` is a flat [letter_index, pct, letter_index, pct, ...] run
    in descending probability, where pct is the probability x100 -- exactly the
    two decimals kept, three characters cheaper per letter than "0.67".  Nesting
    the pairs and writing floats cost +12 KB gzipped across 456 nodes for no
    added information.
    """
    alphabet = str(logo["alphabet"])
    K = len(alphabet)
    maxbits = math.log2(K)
    bits, top = [], []
    for row in logo["pwm"]:
        h = -sum(p * math.log2(p) for p in row if p > 0)
        bits.append(round(max(0.0, maxbits - h), 2))
        order = sorted(range(K), key=lambda i: (-row[i], i))[:LOGO_TOP_K]
        kept = [(i, int(round(100 * float(row[i])))) for i in order]
        kept = [d for d in kept if d[1] >= 1] or [(order[0], max(1, int(round(100 * row[order[0]]))))]
        top.append([v for d in kept for v in d])
    return {"alphabet": alphabet, "width": int(logo["width"]), "bits": bits,
            "top": top, "nsites": int(logo["nsites"])}


node_logo = {nid: trim_logo(streme[nid]) for nid in node_ids if streme.get(nid)}
n_logo = len(node_logo)
check("network nodes with a STREME PWM", n_logo, 456)
check("network nodes with no PWM (they keep the text/absent treatment)",
      len(node_ids) - n_logo, 63)
check("logos whose trimmed width != the STREME width",
      sum(1 for g in node_logo.values() if len(g["top"]) != g["width"]), 0)
check("logos whose bits row count != the width",
      sum(1 for g in node_logo.values() if len(g["bits"]) != g["width"]), 0)
check("logo alphabets that are neither ACGT nor the 20 amino acids",
      sum(1 for g in node_logo.values() if len(g["alphabet"]) not in (4, 20)), 0)
alpha_counts = Counter(len(g["alphabet"]) for g in node_logo.values())
check("nucleotide logos (4-letter alphabet)", alpha_counts[4], 315)
check("amino-acid logos (20-letter alphabet)", alpha_counts[20], 141)
# every kept position must still hold at least one letter, and the retained mass
# must never exceed 1 -- a rounding bug here would inflate a letter's height
check("logo positions left with no letter", sum(
    1 for g in node_logo.values() for col in g["top"] if not col), 0)
check("logo positions holding a malformed index/percent run", sum(
    1 for g in node_logo.values() for col in g["top"]
    if len(col) % 2 or len(col) > 2 * LOGO_TOP_K), 0)
check("logo positions whose retained probability exceeds 102%", sum(
    1 for g in node_logo.values() for col in g["top"] if sum(col[1::2]) > 102), 0)
check("logo positions whose letters are not in descending probability", sum(
    1 for g in node_logo.values() for col in g["top"]
    if list(col[1::2]) != sorted(col[1::2], reverse=True)), 0)
logo_widths = sorted(g["width"] for g in node_logo.values())
log(f"       {n_logo} of {len(node_ids)} nodes carry a logo; "
    f"width {logo_widths[0]}-{logo_widths[-1]}, median {logo_widths[len(logo_widths) // 2]}; "
    f"{alpha_counts[4]} nucleotide / {alpha_counts[20]} amino-acid")

# ─────────────────────────────────────────────────────────────────────────────
# 4. edges
# ─────────────────────────────────────────────────────────────────────────────
log("[4] edges")

cons_pair_keys = set(zip(cpairs.p_cluster, cpairs.u_cluster))
gated_keys = set(zip(pairs["protein"], pairs["utr"]))
n_cons_edges = len(gated_keys & cons_pair_keys)
check("gated edges with a consensus-level pair", n_cons_edges, 1430)

edges = []
n_cross = 0
n_outside = 0
matrix = [[0] * 6 for _ in range(6)]  # matrix[protein_module-1][utr_module-1]
for r in pairs.itertuples(index=False):
    pm, um = cl_module[r.protein], cl_module[r.utr]
    cross = bool(pm and um and pm != um)
    n_cross += cross
    if pm == 0 and um == 0:
        n_outside += 1
    if pm and um:
        matrix[pm - 1][um - 1] += 1
    conc = r.clade_concentration
    znf = r.frac_co_ZNF
    edges.append({
        "p": r.protein,
        "u": r.utr,
        "sc": round(float(r.phylo_corrected_score), 4),
        "npmi": round(float(r.npmi_mip_APC), 4),
        "co": int(r.co_count),
        "cl": int(r.n_indep_clades),
        "conc": None if pd.isna(conc) else round(float(conc), 3),
        "znf": None if pd.isna(znf) else round(float(znf), 4),
        "x": cross,
        "cons": (r.protein, r.utr) in cons_pair_keys,
    })
check("cross-module edges", n_cross, 757)
check("edges with both endpoints outside every module", n_outside, 3)
check("within-module edges", sum(matrix[i][i] for i in range(6)), 1860)
check("meta.matrix total (module-assigned edges)", sum(map(sum, matrix)), P.N_GATED_EDGES - 3)
check("matrix M1protein -> M2utr", matrix[0][1], 178)
check("matrix M2protein -> M1utr", matrix[1][0], 66)
if matrix == [list(col) for col in zip(*matrix)]:
    raise AssertionError("matrix came out symmetric; the directional axes were lost")
log(f"       matrix is ASYMMETRIC as required: [M1p][M2u]={matrix[0][1]} vs [M2p][M1u]={matrix[1][0]}")
log(f"       cross-module share {100 * n_cross / len(edges):.1f}%")

# ─────────────────────────────────────────────────────────────────────────────
# 5. components + degree census
# ─────────────────────────────────────────────────────────────────────────────
log("[5] graph census")

import networkx as nx  # noqa: E402

G = nx.Graph()
G.add_nodes_from(node_ids)
G.add_edges_from(gated_keys)
comps = sorted(nx.connected_components(G), key=len, reverse=True)
comp_sizes = [len(c) for c in comps]
check("connected components", len(comps), 4)
check("giant component size", comp_sizes[0], 513)
check("components of size 2 (isolated dyads)", sum(1 for s in comp_sizes if s == 2), 3)

outside_nodes = sorted(n for n in node_ids if cl_module[n] == 0)
check("nodes outside every module", len(outside_nodes), 6)
log(f"       outside-module nodes: {', '.join(outside_nodes)}")
giant = comps[0]
if any(n in giant for n in outside_nodes):
    raise AssertionError("an unassigned node landed in the giant component")
if set().union(*comps[1:]) != set(outside_nodes):
    raise AssertionError("the 3 dyads are not exactly the 6 unassigned nodes")
log("       the 3 dyads ARE exactly the 6 unassigned nodes (verified)")

dv = np.array([deg[n] for n in node_ids])
deg_hist = dict(sorted(Counter(dv.tolist()).items()))
log(f"       degree  min {dv.min()} / median {np.median(dv):.0f} / mean {dv.mean():.2f} / max {dv.max()}")
log("       degree deciles " + str([int(np.percentile(dv, q)) for q in range(0, 101, 10)]))
top_hubs = sorted(((deg[n], n) for n in node_ids), reverse=True)[:10]
log("       top hubs: " + ", ".join(f"{n}({d})" for d, n in top_hubs))

# ─────────────────────────────────────────────────────────────────────────────
# 6. FROZEN global layout — networkx spring, seed=7
# ─────────────────────────────────────────────────────────────────────────────
log("[6] frozen global layout (spring, seed=7)")

Gg = G.subgraph(giant).copy()
raw = nx.spring_layout(Gg, seed=SEED, k=2.6 / math.sqrt(Gg.number_of_nodes()), iterations=400)

pts = np.array([raw[n] for n in sorted(Gg.nodes())], dtype=float)
lo, hi = pts.min(axis=0), pts.max(axis=0)
span = np.maximum(hi - lo, 1e-9)
MARGIN, USABLE_H = 24.0, 916.0  # 0..940 reserved for the giant component


def rescale(pt):
    u = (np.asarray(pt, dtype=float) - lo) / span
    return (MARGIN + u[0] * (BOX - 2 * MARGIN), MARGIN + u[1] * USABLE_H)


xy: dict[str, tuple[float, float]] = {n: rescale(raw[n]) for n in Gg.nodes()}

# The 3 dyads are not connected to anything; a force layout would fling them to
# infinity, so they are PLACED, deterministically, in a reserved strip at the
# bottom. meta.layout says so.
for i, comp in enumerate(comps[1:]):
    p, u = sorted(comp, key=lambda n: (cl_region[n] != "protein", n))
    cx = 190.0 + i * 310.0
    xy[p] = (cx - 52.0, 978.0)
    xy[u] = (cx + 52.0, 978.0)

check("nodes with a frozen x/y", len(xy), 519)
xs = [v[0] for v in xy.values()]
ys = [v[1] for v in xy.values()]
log(f"       x range [{min(xs):.1f}, {max(xs):.1f}]  y range [{min(ys):.1f}, {max(ys):.1f}]")

# nearest-neighbour spacing, a crude readability check on the frozen layout
gp = np.array([xy[n] for n in sorted(Gg.nodes())])
d2 = ((gp[:, None, :] - gp[None, :, :]) ** 2).sum(-1)
np.fill_diagonal(d2, np.inf)
nn = np.sqrt(d2.min(axis=1))
log(f"       giant-component nearest-neighbour distance: min {nn.min():.2f}, median {np.median(nn):.2f}")

# ─────────────────────────────────────────────────────────────────────────────
# 7. FROZEN per-module bipartite layout (x2/y2), barycenter crossing-min
# ─────────────────────────────────────────────────────────────────────────────
log("[7] frozen per-module bipartite layout (x2/y2)")

COL_P, COL_U = 250.0, 750.0
TOP, BOT = 46.0, 954.0

by_module: dict[int, list[str]] = defaultdict(list)
for n in node_ids:
    by_module[cl_module[n]].append(n)

xy2: dict[str, tuple[float, float]] = {}
crossing_report = []
for m in sorted(by_module):
    members = sorted(by_module[m])
    left = [n for n in members if cl_region[n] == "protein"]
    right = [n for n in members if cl_region[n] != "protein"]
    # only edges INTERNAL to the module drive the ordering
    inner = [(p, u) for (p, u) in gated_keys if cl_module[p] == m and cl_module[u] == m]
    adj_l = defaultdict(list)
    adj_r = defaultdict(list)
    for p, u in inner:
        adj_l[p].append(u)
        adj_r[u].append(p)

    # deterministic seed order: hubs first, then id
    left.sort(key=lambda n: (-deg[n], n))
    right.sort(key=lambda n: (-deg[n], n))

    def crossings(lo_, ro_):
        li = {n: i for i, n in enumerate(lo_)}
        ri = {n: i for i, n in enumerate(ro_)}
        es = sorted(((li[p], ri[u]) for p, u in inner))
        c = 0
        for a in range(len(es)):
            for b in range(a + 1, len(es)):
                if es[a][0] != es[b][0] and es[a][1] > es[b][1]:
                    c += 1
        return c

    before = crossings(left, right) if len(inner) <= 900 else None
    for sweep in range(24):  # barycenter sweeps, fully deterministic
        ri = {n: i for i, n in enumerate(right)}
        left.sort(key=lambda n: (
            np.mean([ri[u] for u in adj_l[n]]) if adj_l[n] else len(right) / 2.0, n))
        li = {n: i for i, n in enumerate(left)}
        right.sort(key=lambda n: (
            np.mean([li[p] for p in adj_r[n]]) if adj_r[n] else len(left) / 2.0, n))
    after = crossings(left, right) if len(inner) <= 900 else None
    if before is not None:
        crossing_report.append((m, before, after))

    for col, order in ((COL_P, left), (COL_U, right)):
        k = len(order)
        for i, n in enumerate(order):
            y = (TOP + BOT) / 2 if k == 1 else TOP + (BOT - TOP) * i / (k - 1)
            xy2[n] = (col, round(y, 1))
    log(f"       M{m}: {len(left):>3} protein x {len(right):>3} UTR, {len(inner):>4} internal edges"
        + (f", crossings {before} -> {after}" if before is not None else ""))

check("nodes with a frozen x2/y2", len(xy2), 519)

# ─────────────────────────────────────────────────────────────────────────────
# 8. meta.modules
# ─────────────────────────────────────────────────────────────────────────────
log("[8] meta.modules")

msumm = pd.read_csv(P.MODULES_SUMM).set_index("module_id")
mterms = pd.read_csv(P.MODULE_TERMS).set_index("module_id")
check("modules in modules_summary", len(msumm), 6)

modules_meta = []
for m in range(1, 7):
    s, t = msumm.loc[m], mterms.loc[m]
    n_p = sum(1 for n in prot_ids if cl_module[n] == m)
    n_u = sum(1 for n in utr_ids if cl_module[n] == m)
    check(f"M{m} n_protein nodes vs modules_summary", n_p, int(s.n_protein))
    check(f"M{m} n_utr nodes vs modules_summary", n_u, int(s.n_utr))
    check(f"M{m} internal edges vs modules_summary", matrix[m - 1][m - 1], int(s.n_edges))
    modules_meta.append({
        "id": m,
        "n_protein": n_p,
        "n_utr": n_u,
        "n_edges": int(s.n_edges),
        "n_cross_out": sum(matrix[m - 1][j] for j in range(6) if j != m - 1),
        "n_cross_in": sum(matrix[i][m - 1] for i in range(6) if i != m - 1),
        "mean_score": round(float(s.mean_score), 4),
        "mean_clades": round(float(s.mean_indep_clades), 1),
        "frac_znf": round(float(s.mean_frac_ZNF), 3),
        "genes": int(t.n_genes),
        "n_sig_terms": int(t.n_sig),
        "n_trusted_terms": int(t.n_trusted),
        "terms": [x.strip() for x in str(t.leading_terms).split(";") if x.strip()],
        "color": MODULE_COLOR[m],
        "label": MODULE_LABEL[m],
        "short": MODULE_SHORT[m],
    })

# ─────────────────────────────────────────────────────────────────────────────
# 9. assemble + write
# ─────────────────────────────────────────────────────────────────────────────
log("[9] writing")

nodes = []
for nid in node_ids:
    text, tier, source = names[nid]
    x, y = xy[nid]
    x2, y2 = xy2[nid]
    node = {
        "id": nid,
        "r": cl_region[nid],
        "m": cl_module[nid],
        "deg": deg[nid],
        "n": cl_inst[nid],
        "nt": cl_tx[nid],
        "ng": cl_genes[nid],
        "x": round(x, 1),
        "y": round(y, 1),
        "x2": x2,
        "y2": y2,
        "cons": None,
        "cov": None,
        "pos": [round(float(v), 4) for v in cl_pos[nid]],
        "name": text,
        "tier": tier,
        "src": source,
    }
    if nid in top_cons.index:
        row = top_cons.loc[nid]
        node["cons"] = str(row["consensus"])
        node["cov"] = round(float(row["coverage"]), 4)
        node["carriers"] = int(row["carriers"])
    if nid in node_logo:
        node["logo"] = node_logo[nid]
    nodes.append(node)

check("every node carries a 20-bin position histogram",
      sum(1 for n in nodes if len(n["pos"]) == 20), 519)
check("nodes carrying a trimmed logo", sum(1 for n in nodes if "logo" in n), 456)

payload = {
    "nodes": nodes,
    "edges": edges,
    "meta": {
        "matrix": matrix,
        "matrix_axes": {
            "rows": "protein module 1..6",
            "cols": "UTR module 1..6",
            "note": ("DIRECTIONAL and asymmetric: matrix[0][1] (M1 protein -> M2 UTR) = "
                     f"{matrix[0][1]} while matrix[1][0] (M2 protein -> M1 UTR) = {matrix[1][0]}. "
                     "Excludes the 3 edges whose endpoints sit outside every module."),
            "excluded_unassigned_edges": n_outside,
        },
        "modules": modules_meta,
        "counts": {
            "nodes": len(nodes),
            "nodes_protein": len(prot_ids),
            "nodes_utr": len(utr_ids),
            "nodes_outside_module": len(outside_nodes),
            "edges": len(edges),
            "within_module_edges": sum(matrix[i][i] for i in range(6)),
            "cross_module_edges": n_cross,
            "cross_module_pct": round(100 * n_cross / len(edges), 1),
            "edges_outside_module": n_outside,
            "edges_with_consensus_pair": n_cons_edges,
            "edges_cluster_level_only": len(edges) - n_cons_edges,
            "components": len(comps),
            "component_sizes": comp_sizes,
            "clusters_total": P.N_CLUSTERS,
            "clusters_not_in_network": P.N_CLUSTERS - len(nodes),
            "nodes_with_logo": n_logo,
            "nodes_no_logo": len(nodes) - n_logo,
        },
        "logo": {
            "trimmed": True,
            "top_letters_per_position": LOGO_TOP_K,
            "decimals": LOGO_DECIMALS,
            "nodes_with_logo": n_logo,
            "nodes_no_logo": len(nodes) - n_logo,
            "note": ("Each node's `logo` is the TRIMMED STREME matrix: the top "
                     f"{LOGO_TOP_K} letters per position at {LOGO_DECIMALS} decimals. Each "
                     "position is a flat [letter_index_into_alphabet, probability_x100, ...] "
                     "run in descending probability. "
                     "`bits` is that position's information content computed at bake time "
                     "from the FULL matrix, because recomputing it from a truncated column "
                     "would overstate the information content of a 20-letter protein "
                     "alphabet. The drill-down draws these ~10 px tall, where a letter under "
                     "p=0.02 is sub-pixel. The complete PWM ships in the cluster shard. "
                     f"The {len(nodes) - n_logo} nodes with no STREME motif carry no `logo` "
                     "key at all and keep the consensus string / absent treatment: those "
                     "clusters were k-means'd on embeddings, not on sequence, so a "
                     "client-side PWM would manufacture SSSSS/PPPPP artifacts."),
        },
        "outside_module_nodes": outside_nodes,
        "degree": {
            "min": int(dv.min()), "median": float(np.median(dv)),
            "mean": round(float(dv.mean()), 2), "max": int(dv.max()),
            "hist": {str(k): int(v) for k, v in deg_hist.items()},
        },
        "layout": {
            "algo": "networkx.spring_layout",
            "seed": SEED,
            "iterations": 400,
            "box": [0, int(BOX)],
            "frozen": True,
            "note": ("x/y are computed ONCE at bake with a fixed seed and never recomputed in "
                     "the browser. Distance and direction carry NO meaning. The 513-node giant "
                     "component occupies y 24-940; the 3 isolated dyads (6 clusters with no "
                     "module) are placed, not simulated, in the reserved strip at y=978."),
            "bipartite_note": ("x2/y2 are the frozen per-module bipartite coordinates: protein "
                               f"clusters at x={COL_P:.0f}, UTR clusters at x={COL_U:.0f}, row order "
                               "from 24 deterministic barycenter sweeps over that module's internal "
                               "edges only. Cross-module edges have one endpoint outside the panel."),
        },
        "colors": {"module": {str(k): v for k, v in MODULE_COLOR.items()}, "region": REGION_COLOR},
        "caveat": CAVEAT,
        "name_tiers": {
            "1": "significant enriched term, fold >= 2 (FDR < 0.05, within-cluster)",
            "2": "significant enriched term, fold < 2",
            "3": "derived from the cluster's top consensus string -- descriptive only",
            "4": "no term and no consensus; the cluster id is the only honest name",
            "counts": {str(k): v for k, v in sorted(tier_counts.items())},
        },
        "empty_states": {
            "clusters_no_module": core_meta["clusters"].get("no_module", 387),
            "clusters_total": P.N_CLUSTERS,
            "utr_clusters_no_gated_partner": core_meta["clusters"].get("utr_no_gated_partner", 282),
            "utr_clusters_total": 600,
            "nodes_no_consensus": len(nodes) - n_with_cons,
            "nodes_no_logo": len(nodes) - n_logo,
            "nodes_no_significant_term": sum(1 for n in nodes if n["tier"] >= 3),
            "edges_cluster_level_only": len(edges) - n_cons_edges,
        },
        "sort_keys_forbidden": ["npmi_raw"],
        "built": core_meta.get("built"),
    },
}

path = OUT / "network.json"
path.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False))
size = path.stat().st_size
log(f"       {path}  {size:,} bytes ({size / 1e6:.3f} MB)")
if size > 2_000_000:
    raise AssertionError(f"network.json is {size} bytes, over the 2 MB budget")

# round-trip
back = json.loads(path.read_text())
check("round-trip nodes", len(back["nodes"]), 519)
check("round-trip edges", len(back["edges"]), P.N_GATED_EDGES)
check("round-trip cross-module flags", sum(e["x"] for e in back["edges"]), 757)
check("round-trip consensus flags", sum(e["cons"] for e in back["edges"]), 1430)
check("round-trip node logos", sum(1 for n in back["nodes"] if n.get("logo")), 456)
log("[done] 08_network.py")
