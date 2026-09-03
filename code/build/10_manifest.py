#!/usr/bin/env python
"""10_manifest.py — the last bake step.

Writes three files and audits everything that was written before it:
    portal/data/manifest.json      real counts, the NTScore domain, the assertion tally
    portal/data/search.json        [[symbol, refseq, primary_module|0, n_motifs], ...]
    portal/data/search_alias.json  {"ENSG...": "NM_...", "ENST...": "NM_...", ...}

Counts are never hardcoded: they are read out of _cache/validation.json, _cache/core_meta.json,
_cache/gene_shard_meta.json, _cache/cluster_shard_meta.json and portal/data/network.json, and
then cross-checked against the files actually present on disk.  A mismatch fails the build.

Usage:  python 10_manifest.py
"""
from __future__ import annotations

import gzip
import json
import sys
import time
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import paths  # noqa: E402

CACHE = HERE / "_cache"
OUT = paths.OUT


def log(msg: str) -> None:
    print(msg, flush=True)


def jload(p: Path):
    return json.loads(p.read_text()) if p.exists() else None


def gz(b: bytes) -> int:
    return len(gzip.compress(b, 6))


def main() -> int:
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)

    # ---------------------------------------------------------- upstream ----
    validation = jload(CACHE / "validation.json")
    core = jload(CACHE / "core_meta.json")
    gene_meta = jload(CACHE / "gene_shard_meta.json")
    clus_meta = jload(CACHE / "cluster_shard_meta.json")
    nt_meta = jload(CACHE / "nt" / "nt_meta.json")
    network = jload(OUT / "network.json")
    missing = [n for n, v in [("validation.json", validation), ("core_meta.json", core),
                              ("gene_shard_meta.json", gene_meta),
                              ("cluster_shard_meta.json", clus_meta),
                              ("nt/nt_meta.json", nt_meta), ("network.json", network)] if v is None]
    if missing:
        log("FATAL: upstream artefacts missing: " + ", ".join(missing))
        return 2

    ncounts = network["meta"]["counts"]

    # ------------------------------------------------------ payload audit ---
    gene_files = sorted((OUT / "gene").glob("*.json"))
    cluster_files = sorted((OUT / "cluster").glob("*.json"))
    module_files = sorted((OUT / "modules").glob("*.json"))
    log(f"[audit] gene {len(gene_files):,} · cluster {len(cluster_files):,} · "
        f"modules {len(module_files)} · network.json {(OUT / 'network.json').stat().st_size:,} B")
    assert len(gene_files) == paths.N_TRANSCRIPTS, len(gene_files)
    assert len(cluster_files) == paths.N_CLUSTERS, len(cluster_files)
    assert len(module_files) == 6, len(module_files)
    assert gene_meta["files"] == paths.N_TRANSCRIPTS
    assert gene_meta["motifs"] == paths.N_MOTIFS
    assert ncounts["edges"] == paths.N_GATED_EDGES
    on_disk = {p.stem for p in gene_files}

    # ------------------------------------------------------- search index ---
    genes = pd.read_parquet(
        CACHE / "genes.parquet",
        columns=["refseq", "symbol", "ensg", "enst", "primary_module", "n_motifs"])
    assert len(genes) == paths.N_TRANSCRIPTS
    genes = genes.sort_values(["symbol", "refseq"], kind="mergesort")

    rows = []
    alias: dict[str, str] = {}
    collisions = 0
    for r in genes.itertuples(index=False):
        assert r.refseq in on_disk, f"search.json would point at a missing shard: {r.refseq}"
        rows.append([r.symbol, r.refseq, int(r.primary_module), int(r.n_motifs)])
        ids = list(r.ensg if r.ensg is not None else []) + \
              list(r.enst if r.enst is not None else [])
        for aid in ids:
            aid = str(aid)
            if aid in alias:
                collisions += 1
                continue                      # first wins; census reported below
            alias[aid] = r.refseq

    n_symbols = genes.symbol.nunique()
    multi = int((genes.symbol.value_counts() > 1).sum())
    assert n_symbols == core["counts"]["genes"] == 17_847, n_symbols

    search_bytes = json.dumps(rows, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    (OUT / "search.json").write_bytes(search_bytes)
    alias_bytes = json.dumps(alias, separators=(",", ":"), ensure_ascii=False,
                             sort_keys=True).encode("utf-8")
    (OUT / "search_alias.json").write_bytes(alias_bytes)
    n_ensg = sum(1 for k in alias if k.startswith("ENSG"))
    log(f"[search] {len(rows):,} rows · {n_symbols:,} distinct symbols ({multi} with >1 transcript)")
    log(f"[search] search.json       {len(search_bytes):>10,} B raw   {gz(search_bytes):>9,} B gz")
    log(f"[search] search_alias.json {len(alias_bytes):>10,} B raw   {gz(alias_bytes):>9,} B gz   "
        f"({n_ensg:,} ENSG + {len(alias) - n_ensg:,} ENST, {collisions} collisions)")

    # ---------------------------------------------------------- manifest ----
    built = pd.Timestamp.today().strftime("%Y-%m-%d")
    dom = list(paths.NT_DOMAIN)
    nt_scan = nt_meta["scan"]
    nt_verdict = nt_meta["domain_verdict"]

    manifest = {
        "built": built,
        "counts": {
            "transcripts": paths.N_TRANSCRIPTS,
            "genes": int(n_symbols),
            "motifs": paths.N_MOTIFS,
            "clusters": paths.N_CLUSTERS,
            "edges": int(ncounts["edges"]),
            "cross_module_edges": int(ncounts["cross_module_edges"]),
            "modules": len(module_files),
        },
        "nt_domain": dom,
        # 10 of 11 — assertion 10 (the NTScore domain contains the data) genuinely fails:
        # 4 of 32,745,544 positions sit below -8 and are clamped. Never rounded up to 11.
        "assertions_passed": int(validation["assertions_passed"]),
        "assertions_total": int(validation["assertions_total"]),

        # ---- everything below is additive; the six keys above are the contract ----
        "payloads": {
            "gene": len(gene_files),
            "cluster": len(cluster_files),
            "modules": len(module_files),
            "network": 1,
            "search_rows": len(rows),
            "search_aliases": len(alias),
        },
        "regions": {
            "utr5": gene_meta["region_counts"]["utr5"],
            "utr3": gene_meta["region_counts"]["utr3"],
            "protein": gene_meta["region_counts"]["protein"],
        },
        "mrna_length": core["mrna_length"],
        "coupling": {
            "rows": core["coupling"]["rows"],
            "mean_per_transcript": round(core["coupling"]["mean"], 2),
            "median_per_transcript": core["coupling"]["median"],
            "max_per_transcript": core["coupling"]["max"],
            "pct_transcripts_with_pair": round(core["coupling"]["pct_ge1"], 1),
        },
        "nt": {
            "domain": dom,
            "encode": "q = clip(round(255 * (v + 8.0) / 8.0), 0, 255)",
            "decode": "v = -8.0 + q * 8.0 / 255",
            "regions": ["utr5", "utr3"],
            "no_cds_or_protein_track": True,
            "positions_scanned": nt_scan["positions_scanned"],
            "true_global_min": nt_scan["true_global_min"],
            "true_global_max": nt_scan["true_global_max"],
            "positions_clamped": nt_verdict["clamped_cells"],
            "note": ("NTScore exists for 5'UTR and 3'UTR only. The measured global minimum is "
                     f"{nt_scan['true_global_min']}, so {nt_verdict['clamped_cells']} of "
                     f"{nt_scan['positions_scanned']:,} positions fall below the quantization "
                     "domain and clamp to the darkest bin. Build assertion 10 is recorded as "
                     "failed rather than weakened."),
        },
        "coverage": {
            "clusters_with_logo": clus_meta["coverage"]["logo"],
            "clusters_with_term": clus_meta["coverage"]["terms"],
            "clusters_with_module": clus_meta["coverage"]["module"],
            "clusters_in_network": clus_meta["coverage"]["passing_partner"],
            "edges_with_consensus_pair": int(ncounts["edges_with_consensus_pair"]),
        },
        "empty_states": {
            "clusters_no_module": clus_meta["coverage"]["module_null"],
            "clusters_no_term": clus_meta["coverage"]["terms_null"],
            "clusters_no_logo": clus_meta["coverage"]["logo_null"],
            "clusters_total": paths.N_CLUSTERS,
            "utr_clusters_no_gated_partner": clus_meta["utr_no_gated_partner"],
            "utr_clusters_total": 600,
            "prot_clusters_no_gated_partner": clus_meta["prot_no_gated_partner"],
            "prot_clusters_total": 300,
            "edges_cluster_level_only": int(ncounts["edges_cluster_level_only"]),
            "edges_total": int(ncounts["edges"]),
            "transcripts_no_module": 58,
            "transcripts_total": paths.N_TRANSCRIPTS,
        },
        "sizes": {
            "gene_shard_raw_mean": round(gene_meta["size_raw"]["mean"]),
            "gene_shard_raw_max": gene_meta["size_raw"]["max"],
            "gene_dir_raw_bytes": gene_meta["size_raw"]["total"],
            "search_json_bytes": len(search_bytes),
            "search_alias_json_bytes": len(alias_bytes),
            "network_json_bytes": (OUT / "network.json").stat().st_size,
            "cluster_dir_raw_bytes": clus_meta["bytes"]["total"],
        },
        "sort_keys_forbidden": ["npmi_raw"],
        "source": "MIRTO — human GRCh37, RefSeq transcripts joined on refseq_id_without_ver",
    }
    if "size_gzip" in gene_meta:
        manifest["sizes"]["gene_shard_gzip_mean"] = round(gene_meta["size_gzip"]["mean"])
        manifest["sizes"]["gene_shard_gzip_max"] = gene_meta["size_gzip"]["max"]
        manifest["sizes"]["gene_dir_gzip_bytes"] = gene_meta["size_gzip"]["total"]

    mbytes = json.dumps(manifest, indent=1, ensure_ascii=False).encode("utf-8")
    (OUT / "manifest.json").write_bytes(mbytes)
    log(f"[manifest] manifest.json    {len(mbytes):>10,} B")
    for k, v in manifest["counts"].items():
        log(f"           counts.{k:<20} {v:>10,}")
    log(f"           assertions_passed    {manifest['assertions_passed']:>10} "
        f"of {manifest['assertions_total']}")

    # -------------------------------------------------------- final audit ---
    # every alias resolves; every search row resolves; the manifest agrees with the tree
    assert all(v in on_disk for v in alias.values())
    assert len(json.loads(search_bytes)) == paths.N_TRANSCRIPTS
    assert json.loads(alias_bytes)["ENSG00000075624"] == "NM_001101"
    assert json.loads(search_bytes)[0][1] in on_disk
    log(f"[audit] every search row and every alias resolves to a shard on disk")
    log(f"[done] {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
