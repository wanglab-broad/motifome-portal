#!/usr/bin/env python
"""06_gene_shards.py — write portal/data/gene/<REFSEQ>.json, one per transcript.

Reads ONLY the caches built upstream:
    _cache/master.parquet    889,215 motif instances, annotations already region-masked
    _cache/genes.parquet     18,093 transcripts, the four sequences, TRUE mrna length
    _cache/coupling.parquet  145,406 (transcript, prot_cluster, utr_cluster) carrier rows
    _cache/nt/nt.parquet     36,186 base64 NTScore tracks (utr5 + utr3, no cds/protein)

Shape is CONTRACT.md §gene/<REFSEQ>.json.  Nothing is re-derived from the raw sources.

Invariants asserted at bake (the build fails, loudly, if any of them breaks):
  A1  seq[region][s : e+1] == motif string, all 889,215 rows.
  A2  ms/me reproduce the mRNA axis: utr5 ms=s; utr3 ms=len5+lencds+s; protein ms=len5+3s,
      me=len5+3e+2, and mrna[ms:me+1] is the motif string for UTR rows / 3*len for protein.
  A3  every coupling row's two clusters are actually carried by that transcript, so p/u
      always resolve to a real index into motifs[].
  A4  len(b64decode(nt[region])) == len(seq[region]) for both tracks of every transcript.
  A5  pl (pLDDT) is present on protein rows only and lies in [0, 1].
  A6  no annotation key is ever emitted empty; no `a` object is ever emitted empty.

Usage:  python 06_gene_shards.py [--limit N] [--no-gzip-stats]
"""
from __future__ import annotations

import argparse
import base64
import gzip
import json
import math
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import paths  # noqa: E402

CACHE = HERE / "_cache"
OUT_GENE = paths.OUT / "gene"

# master's four RBP assay columns -> the display keys inside a.rbp
RBP_COLS = [
    ("rbp_eclip", "eCLIP"),
    ("rbp_parclip", "PAR-CLIP"),
    ("rbp_iclip_piranha", "iCLIP-Piranha"),
    ("rbp_iclip_cims", "iCLIP-CIMS"),
]
STR_ANNOT = [("ipr", "ipr"), ("upr", "upr"), ("elm", "elm"), ("idpo", "idpo"), ("sig", "sig")]


def log(msg: str) -> None:
    print(msg, flush=True)


def pct(a: int, b: int) -> str:
    return f"{a}/{b} ({100.0 * a / b:.3f}%)" if b else f"{a}/0"


def stats(v: list[int]) -> dict:
    a = np.asarray(v, dtype=np.int64)
    return {
        "min": int(a.min()),
        "median": float(np.median(a)),
        "mean": float(a.mean()),
        "p95": float(np.percentile(a, 95)),
        "max": int(a.max()),
        "total": int(a.sum()),
    }


def fmt_stats(name: str, s: dict) -> str:
    return (f"  {name:<26} min {s['min']:>7,}  median {s['median']:>9,.0f}  "
            f"mean {s['mean']:>9,.0f}  p95 {s['p95']:>9,.0f}  max {s['max']:>7,}  "
            f"total {s['total'] / 1e6:>8,.2f} MB")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only write the first N transcripts (debug)")
    ap.add_argument("--no-gzip-stats", action="store_true", help="skip the gzip size census")
    args = ap.parse_args()
    t0 = time.time()

    # ---------------------------------------------------------------- load ---
    log("[load] genes.parquet")
    genes = pd.read_parquet(CACHE / "genes.parquet")
    log("[load] master.parquet")
    master = pd.read_parquet(CACHE / "master.parquet")
    log("[load] coupling.parquet")
    coup = pd.read_parquet(CACHE / "coupling.parquet")
    log("[load] nt/nt.parquet")
    nt = pd.read_parquet(CACHE / "nt" / "nt.parquet")
    log(f"[load] {len(genes):,} transcripts · {len(master):,} motifs · "
        f"{len(coup):,} coupling rows · {len(nt):,} nt tracks   ({time.time() - t0:.1f}s)")

    assert len(genes) == paths.N_TRANSCRIPTS, len(genes)
    assert len(master) == paths.N_MOTIFS, len(master)
    assert genes.refseq.is_unique

    # nt lookup: (refseq, region) -> base64 str, plus its declared length
    nt_region = nt.region.astype(str)
    NT = {(r, g): (int(n), b) for r, g, n, b in zip(nt.refseq, nt_region, nt.n, nt.b64)}
    log(f"[load] nt lookup {len(NT):,} keys")

    # ------------------------------------------------------- order motifs ---
    # motifs[] is ordered along the mRNA axis: 5'UTR, then protein (projected into
    # the CDS), then 3'UTR.  ms is unique per (transcript, region) and the three
    # regions occupy disjoint mRNA intervals, so (sequence_id, ms, me) is a total order.
    log("[sort] master by (sequence_id, ms, me)")
    master = master.sort_values(["sequence_id", "ms", "me"], kind="mergesort").reset_index(drop=True)

    sid = master["sequence_id"].to_numpy()
    m_region = master["region"].to_numpy()
    m_s = master["motif_start"].to_numpy()
    m_e = master["motif_end"].to_numpy()
    m_len = master["motif_length"].to_numpy()
    m_str = master["motifs"].to_numpy()
    m_clu = master["motif_cluster"].to_numpy()
    m_mod = master["module"].to_numpy()
    m_sc = master["motif_score"].to_numpy()
    m_en = master["motif_entropy"].to_numpy()
    m_pl = master["plddt"].to_numpy()
    m_ms = master["ms"].to_numpy()
    m_me = master["me"].to_numpy()
    rbp_arrays = [(master[c].to_numpy(), k) for c, k in RBP_COLS]
    mir_a = master["mir"].to_numpy()
    mob_a = master["mob"].to_numpy()
    str_arrays = [(master[c].to_numpy(), k) for c, k in STR_ANNOT]

    # group boundaries over the sorted sequence_id column
    change = np.flatnonzero(sid[1:] != sid[:-1]) + 1
    starts = np.concatenate(([0], change))
    ends = np.concatenate((change, [len(sid)]))
    assert len(starts) == len(genes), (len(starts), len(genes))
    motif_span = {sid[a]: (int(a), int(b)) for a, b in zip(starts, ends)}

    # coupling groups, order preserved (already sorted by sequence_id, score desc)
    coup = coup.reset_index(drop=True)
    c_sid = coup["sequence_id"].to_numpy()
    c_p = coup["prot_cluster"].to_numpy()
    c_u = coup["utr_cluster"].to_numpy()
    c_sc = coup["phylo_corrected_score"].to_numpy()
    c_np = coup["npmi_mip_APC"].to_numpy()
    c_co = coup["co_count"].to_numpy()
    c_cl = coup["n_indep_clades"].to_numpy()
    c_cc = coup["clade_concentration"].to_numpy()
    c_zn = coup["frac_co_ZNF"].to_numpy()
    cchange = np.flatnonzero(c_sid[1:] != c_sid[:-1]) + 1
    cstarts = np.concatenate(([0], cchange))
    cends = np.concatenate((cchange, [len(c_sid)]))
    coup_span = {c_sid[a]: (int(a), int(b)) for a, b in zip(cstarts, cends)}
    log(f"[group] {len(motif_span):,} motif groups · {len(coup_span):,} coupling groups   "
        f"({time.time() - t0:.1f}s)")

    OUT_GENE.mkdir(parents=True, exist_ok=True)
    for old in OUT_GENE.glob("*.json"):
        old.unlink()

    # ---------------------------------------------------------------- bake ---
    n_a1 = n_a2 = n_a5 = 0          # assertion counters
    n_ann_cells = 0                 # emitted annotation keys
    n_coupling = 0
    n_motifs_out = 0
    ann_key_counts: Counter = Counter()
    region_counts: Counter = Counter()
    raw_sizes: list[int] = []
    gz_sizes: list[int] = []
    gz_no_nt: list[int] = []
    biggest = (0, "")
    n_files = 0

    rows = genes.itertuples(index=False)
    total = args.limit if args.limit else len(genes)
    log(f"[bake] writing {total:,} shards -> {OUT_GENE}")

    for gi, g in enumerate(rows):
        if args.limit and gi >= args.limit:
            break
        rid = g.refseq
        seq = {"utr5": g.utr5, "cds": g.cds, "utr3": g.utr3, "protein": g.protein}
        L = {"utr5": int(g.len_utr5), "cds": int(g.len_cds),
             "utr3": int(g.len_utr3), "protein": int(g.len_protein),
             "mrna": int(g.len_mrna)}
        assert L["mrna"] == L["utr5"] + L["cds"] + L["utr3"], rid
        mrna = g.utr5 + g.cds + g.utr3
        assert len(mrna) == L["mrna"]

        a0, a1 = motif_span[rid]
        motifs = []
        first_of_cluster: dict[str, int] = {}
        for j in range(a0, a1):
            i = j - a0
            reg = m_region[j]
            s = int(m_s[j]); e = int(m_e[j])
            ms = int(m_ms[j]); me = int(m_me[j])
            mstr = m_str[j]

            # -- A1: region-local coordinates reproduce the stored motif string
            assert seq[reg][s:e + 1] == mstr, (rid, reg, s, e)
            assert e - s + 1 == int(m_len[j]) == len(mstr), (rid, i)
            n_a1 += 1

            # -- A2: the mRNA axis
            if reg == "utr5":
                assert ms == s and me == e
                assert mrna[ms:me + 1] == mstr
            elif reg == "utr3":
                off = L["utr5"] + L["cds"]
                assert ms == off + s and me == off + e
                assert mrna[ms:me + 1] == mstr
            else:
                assert ms == L["utr5"] + 3 * s and me == L["utr5"] + 3 * e + 2
                assert me - ms + 1 == 3 * len(mstr)
                assert L["utr5"] <= ms and me < L["utr5"] + L["cds"]
            n_a2 += 1

            pl = m_pl[j]
            if reg == "protein":
                assert not math.isnan(pl) and 0.0 <= pl <= 1.0, (rid, i, pl)
                pl_out = round(float(pl), 3)
                n_a5 += 1
            else:
                assert math.isnan(pl), (rid, i, pl)
                pl_out = None

            mo = {
                "i": i,
                "r": reg,
                "s": s,
                "e": e,
                "c": m_clu[j],
                "m": int(m_mod[j]),
                "sc": round(float(m_sc[j]), 4),
                "en": round(float(m_en[j]), 4),
                "pl": pl_out,
                "ms": ms,
                "me": me,
            }

            # -- annotations: already region-masked upstream; emit only what exists
            ann = {}
            rbp = {}
            for arr, key in rbp_arrays:
                v = arr[j]
                if v is not None and len(v):
                    rbp[key] = [str(x) for x in v]
            if rbp:
                ann["rbp"] = rbp
                ann_key_counts["rbp"] += 1
            v = mir_a[j]
            if v is not None and len(v):
                ann["mir"] = [str(x) for x in v]
                ann_key_counts["mir"] += 1
            for arr, key in str_arrays:
                v = arr[j]
                if v is not None and v == v and v != "":
                    ann[key] = str(v)
                    ann_key_counts[key] += 1
            v = mob_a[j]
            if v is not None and len(v):
                ann["mob"] = [str(x) for x in v]
                ann_key_counts["mob"] += 1
            if ann:
                mo["a"] = ann
                n_ann_cells += len(ann)

            motifs.append(mo)
            region_counts[reg] += 1
            if m_clu[j] not in first_of_cluster:
                first_of_cluster[m_clu[j]] = i

        assert len(motifs) == int(g.n_motifs), (rid, len(motifs), g.n_motifs)
        n_motifs_out += len(motifs)

        # -- coupling: cluster pairs resolved to indices into motifs[]
        coupling = []
        span = coup_span.get(rid)
        if span:
            for j in range(span[0], span[1]):
                p = first_of_cluster.get(c_p[j])
                u = first_of_cluster.get(c_u[j])
                # -- A3: both partners must genuinely be carried by this transcript
                assert p is not None and u is not None, (rid, c_p[j], c_u[j])
                assert motifs[p]["r"] == "protein" and motifs[u]["r"] in ("utr5", "utr3")
                cc = c_cc[j]
                zn = c_zn[j]
                coupling.append({
                    "p": p, "u": u,
                    "sc": round(float(c_sc[j]), 4),
                    "npmi": round(float(c_np[j]), 4),
                    "co": int(c_co[j]),
                    "cl": int(c_cl[j]),
                    "conc": None if cc != cc else round(float(cc), 4),
                    "znf": None if zn != zn else round(float(zn), 4),
                })
            n_coupling += len(coupling)

        shard = {
            "refseq": rid,
            "symbol": g.symbol,
            "ensg": [str(x) for x in (g.ensg if g.ensg is not None else [])],
            "enst": [str(x) for x in (g.enst if g.enst is not None else [])],
            "len": L,
            "seq": seq,
            "motifs": motifs,
            "coupling": coupling,
            "modules": [int(x) for x in (g.modules if g.modules is not None else [])],
        }

        # -- nt: utr5 / utr3 only.  Key omitted entirely when no track exists.
        ntobj = {}
        for reg in ("utr5", "utr3"):
            hit = NT.get((rid, reg))
            if hit is None:
                continue
            n, b64 = hit
            # -- A4
            assert n == L[reg], (rid, reg, n, L[reg])
            assert len(base64.b64decode(b64)) == L[reg], (rid, reg)
            if n > 0:
                ntobj[reg] = b64
        if ntobj:
            shard["nt"] = ntobj

        blob = json.dumps(shard, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
        data = blob.encode("utf-8")
        (OUT_GENE / f"{rid}.json").write_bytes(data)
        n_files += 1
        raw_sizes.append(len(data))
        if len(data) > biggest[0]:
            biggest = (len(data), rid)
        if not args.no_gzip_stats:
            gz_sizes.append(len(gzip.compress(data, 6)))
            if "nt" in shard:
                shard.pop("nt")
                gz_no_nt.append(len(gzip.compress(
                    json.dumps(shard, separators=(",", ":"), allow_nan=False,
                               ensure_ascii=False).encode("utf-8"), 6)))
            else:
                gz_no_nt.append(gz_sizes[-1])
        if (gi + 1) % 2000 == 0:
            log(f"       {gi + 1:>6,}/{total:,}   ({time.time() - t0:.1f}s)")

    log(f"[bake] {n_files:,} shards written   ({time.time() - t0:.1f}s)")

    # --------------------------------------------------------- assertions ---
    if not args.limit:
        assert n_files == paths.N_TRANSCRIPTS, n_files
        assert n_a1 == paths.N_MOTIFS, n_a1
        assert n_a2 == paths.N_MOTIFS, n_a2
        assert n_motifs_out == paths.N_MOTIFS, n_motifs_out
        assert n_coupling == len(coup), (n_coupling, len(coup))
        assert region_counts["protein"] == n_a5 == 254_466, region_counts["protein"]
        assert region_counts["utr5"] == 118_997 and region_counts["utr3"] == 515_752

    log("")
    log("ASSERTIONS")
    log(f"  A1 seq[s:e+1] == motif                {pct(n_a1, paths.N_MOTIFS)}")
    log(f"  A2 mRNA-axis ms/me reproduce          {pct(n_a2, paths.N_MOTIFS)}")
    log(f"  A3 coupling clusters resolve to idx   {pct(n_coupling, len(coup))}")
    log(f"  A4 len(b64decode(nt)) == len(region)  {2 * n_files:,}/{2 * n_files:,} tracks")
    log(f"  A5 pLDDT on protein rows only, 0-1    {pct(n_a5, int(region_counts['protein']))}")
    log(f"  A6 emitted annotation keys            {n_ann_cells:,} (no empty key, no empty `a`)")
    log(f"     region census                      utr5 {region_counts['utr5']:,} · "
        f"utr3 {region_counts['utr3']:,} · protein {region_counts['protein']:,}")
    log(f"     annotation keys by kind            "
        + " · ".join(f"{k} {v:,}" for k, v in sorted(ann_key_counts.items())))

    # --------------------------------------------------------------- size ---
    raw = stats(raw_sizes)
    log("")
    log("SHARD SIZE")
    log(fmt_stats("raw json", raw))
    out = {
        "script": "06_gene_shards.py",
        "built": pd.Timestamp.today().strftime("%Y-%m-%d"),
        "files": n_files,
        "dir": str(OUT_GENE),
        "motifs": n_motifs_out,
        "coupling_rows": n_coupling,
        "annotation_keys_emitted": n_ann_cells,
        "annotation_keys_by_kind": dict(sorted(ann_key_counts.items())),
        "region_counts": dict(region_counts),
        "size_raw": raw,
        "biggest": {"bytes": biggest[0], "refseq": biggest[1]},
    }
    if gz_sizes:
        gz = stats(gz_sizes)
        gzn = stats(gz_no_nt)
        log(fmt_stats("gzip -6", gz))
        log(fmt_stats("gzip -6, nt removed", gzn))
        log(f"  nt costs {(gz['total'] - gzn['total']) / 1e6:,.2f} MB gzipped "
            f"({100.0 * (gz['total'] - gzn['total']) / gz['total']:.1f}% of the corpus)")
        out["size_gzip"] = gz
        out["size_gzip_without_nt"] = gzn
    (CACHE / "gene_shard_meta.json").write_text(json.dumps(out, indent=2))
    log(f"[meta] {CACHE / 'gene_shard_meta.json'}")
    log(f"[done] {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
