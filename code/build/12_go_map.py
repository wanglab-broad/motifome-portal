#!/usr/bin/env python
"""12_go_map.py — bake the GO enrichment map (EnrichmentMap-style) for the browse page.

Reuses the PUBLISHED pipeline verbatim by importing the figure script rather than
reimplementing it, so the portal's interactive map and manuscript Fig 3d/ED 3b are
computed from exactly the same term selection, similarity, MCL clustering, labels
and layout. Only the rendering differs: this emits JSON instead of calling draw().

    node   one enriched GO term   -- radius from term size K, colour by module
                                     (a term enriched in several modules is a pie)
    edge   gene-set similarity    -- 0.5*Jaccard + 0.5*overlap, above EDGE_DRAW_MIN
    disc   an MCL cluster of terms with a 3-word auto label

Output: portal/data/go_map.json   { "branches": { ALL|BP|MF|CC: {nodes, edges, clusters} } }

COLOURS ARE DELIBERATELY *NOT* THE FIGURE'S. plot_GO_enrichment_map.MODCOL maps
M1->blue, M2->purple, M3->orange, M4->vermillion, M5->grey, M6->teal, while the
portal has used M1->orange, M2->sky, M3->green, M4->yellow, M5->blue, M6->vermillion
on the home cards, the network, every cluster chip and the module pages since it was
built. The portal's own consistency wins: a reader who has just seen M1 orange in the
network must not meet a blue M1 here. The module id travels with every node, so the
front end colours from its own token set and this file stays palette-free.
"""
import json
import sys
from pathlib import Path

import numpy as np

import paths

FIGDIR = paths.SD / "manuscript/main_figures_code/figure3_4/module_go_enrichment"
SHARED = paths.SD / "manuscript/main_figures_code/_shared"

sys.path.insert(0, str(SHARED))
sys.path.insert(0, str(FIGDIR))
import plot_GO_enrichment_map as G          # noqa: E402  (path set above)

OUT = paths.OUT / "go_map.json"

BRANCHES = [
    (None,   "ALL", "All GO branches"),
    ("GOBP", "BP",  "Biological process"),
    ("GOMF", "MF",  "Molecular function"),
    ("GOCC", "CC",  "Cellular component"),
]


def build_branch(branch):
    """Mirror G.build() up to (not including) draw(), returning plain JSON types."""
    rng = np.random.default_rng(G.SEED)
    nodes, genes = G.load_nodes(branch)
    W = G.similarity(nodes, genes)
    labels = G.mcl(W)

    from collections import Counter
    sizes = Counter(labels)
    keep = sorted([c for c, n in sizes.items() if n >= G.MIN_CLUSTER_SIZE],
                  key=lambda c: -sizes[c])
    cl_names = G.cluster_labels(nodes, labels, keep)

    rad = G.node_radius(nodes.K.values)
    xy, Q, R = G.solve_layout(W, labels, keep, rad, cl_names, rng, nodes.modules.values)

    # normalise into a 0..1000 box so the front end can scale to any viewport
    kept = np.isin(labels, keep)
    pts = np.vstack([xy[kept], Q]) if len(Q) else xy[kept]
    span = max(pts[:, 0].max() - pts[:, 0].min(), pts[:, 1].max() - pts[:, 1].min(), 1e-9)
    x0, y0 = pts[:, 0].min(), pts[:, 1].min()
    s = 1000.0 / span

    def nx(v):
        return round(float((v - x0) * s), 2)

    def ny(v):
        return round(float((v - y0) * s), 2)

    idx_of = {}
    out_nodes = []
    for i in range(len(nodes)):
        if not kept[i]:
            continue                      # terms in clusters below MIN_CLUSTER_SIZE
        idx_of[i] = len(out_nodes)
        r = nodes.iloc[i]
        out_nodes.append({
            "t": r.term,                                   # GO term id (MSigDB style)
            "n": r["name"],                                # display name
            "b": r.branch,
            "K": int(r.K),                                 # term size (drives radius)
            "k": int(r.k_max),                             # max member genes in a module
            "q": float(r.best_q),
            "m": [int(m) for m in r.modules],              # 1..6, several = pie slices
            "x": nx(xy[i, 0]), "y": ny(xy[i, 1]),
            "r": round(float(rad[i] * s), 2),
            "c": int(labels[i]),                           # its MCL cluster
        })

    out_edges = []
    n = len(nodes)
    for i in range(n):
        if not kept[i]:
            continue
        for j in range(i + 1, n):
            if not kept[j]:
                continue
            w = float(W[i, j])
            if w >= G.EDGE_DRAW_MIN:
                out_edges.append([idx_of[i], idx_of[j], round(w, 3)])

    out_clusters = []
    for ci, c in enumerate(keep):
        members = [idx_of[i] for i in range(n) if kept[i] and labels[i] == c]
        mods = sorted(set().union(*nodes.modules[labels == c])) if members else []
        out_clusters.append({
            "id": int(c),
            "label": cl_names[c].replace("\n", " "),
            "n": int(sizes[c]),
            "m": [int(m) for m in mods],
            "cx": nx(Q[ci][0]), "cy": ny(Q[ci][1]),
            "R": round(float(R[ci] * s), 2),
            "members": members,
        })

    return {"nodes": out_nodes, "edges": out_edges, "clusters": out_clusters}


def main():
    payload = {
        "built_from": str(FIGDIR / "plot_GO_enrichment_map.py"),
        "params": {
            "term_size_max": G.TERM_SIZE_MAX, "fold_min": G.FOLD_MIN,
            "fam_support_min": G.FAM_SUPPORT_MIN, "top_n_per_module": G.TOP_N_PER_MODULE,
            "sim_cutoff": G.SIM_CUTOFF, "edge_draw_min": G.EDGE_DRAW_MIN,
            "mcl_inflation": G.MCL_INFLATION, "min_cluster_size": G.MIN_CLUSTER_SIZE,
            "seed": G.SEED,
        },
        "branches": {},
    }
    for branch, key, title in BRANCHES:
        b = build_branch(branch)
        b["title"] = title
        payload["branches"][key] = b
        print(f"  {key:3s} {title:22s} {len(b['nodes']):4d} terms · "
              f"{len(b['edges']):5d} edges · {len(b['clusters']):2d} labelled clusters")

    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    import gzip
    raw = OUT.stat().st_size
    gz = len(gzip.compress(OUT.read_bytes()))
    print(f"[go_map] -> {OUT.name}  {raw/1024:.1f} KB raw / {gz/1024:.1f} KB gz")


if __name__ == "__main__":
    main()
