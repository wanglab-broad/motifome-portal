#!/usr/bin/env python
"""03_ntscore.py — quantize the per-nucleotide NTScore track for all 18,093 transcripts.

Reads the two HDF5 caches (paths.NT_UTR5_H5, paths.NT_UTR3_H5), restricts to the
transcript universe in _cache/genes.parquet, asserts array length == region sequence
length for every transcript in both regions, quantizes to uint8 over the contract
domain, and writes ONE file the gene-shard builder can read cheaply:

    _cache/nt/nt.parquet      columns (refseq, region, n, b64)
    _cache/nt/nt_meta.json    domain census, size measurements, assertion results

`b64` is standard base64 (RFC 4648, '+/' alphabet, '=' padding) of the raw uint8
buffer.  It drops straight into the contract's gene shard:

    shard["nt"] = {"utr5": <b64>, "utr3": <b64>}      # absent key = no track

There is NO cds/protein track anywhere in the source data and none is fabricated here.

Quantization (CONTRACT.md, `gene/<REFSEQ>.json` -> nt):
    q = clip(round(255 * (v - LO) / (HI - LO)), 0, 255).astype(uint8)   LO,HI = paths.NT_DOMAIN
Dequantization in the browser:
    v = LO + q * (HI - LO) / 255

DOMAIN NOTE — read the banner this script prints.  The true global minimum is measured
here over every one of the 32,745,544 positions BEFORE quantizing.  If it falls below
paths.NT_DOMAIN[0] the script says so loudly, records the full out-of-domain census in
nt_meta.json, and (unless --strict) proceeds with the contract's published formula so
the rest of the build can run.  It never clamps silently.

Run:  /opt/anaconda3/envs/bio/bin/python code/build/03_ntscore.py [--strict]
"""
from __future__ import annotations

import argparse
import base64
import gzip
import json
import sys
import time

import h5py
import numpy as np
import pandas as pd

import paths

T0 = time.time()
CACHE = paths.HERE / "_cache"
NTDIR = CACHE / "nt"
LO, HI = paths.NT_DOMAIN
SPAN = HI - LO

REGIONS = (("utr5", paths.NT_UTR5_H5, "len_utr5"),
           ("utr3", paths.NT_UTR3_H5, "len_utr3"))


def log(msg: str) -> None:
    print(f"[{time.time() - T0:6.1f}s] {msg}", flush=True)


def banner(title: str) -> None:
    print("\n" + "=" * 78, flush=True)
    print(title, flush=True)
    print("=" * 78, flush=True)


ap = argparse.ArgumentParser()
ap.add_argument("--strict", action="store_true",
                help="exit non-zero if any position falls outside paths.NT_DOMAIN")
args = ap.parse_args()

# ══════════════════════════════════════════════════════════════════════════
# universe
# ══════════════════════════════════════════════════════════════════════════
banner("03_ntscore.py — per-nucleotide NTScore quantization")

genes = pd.read_parquet(CACHE / "genes.parquet",
                        columns=["refseq", "len_utr5", "len_utr3"])
assert genes["refseq"].is_unique, "genes.parquet refseq is not unique"
n_tx = len(genes)
log(f"universe: {n_tx:,} transcripts from _cache/genes.parquet")
if n_tx != paths.N_TRANSCRIPTS:
    print(f"  WARNING: expected {paths.N_TRANSCRIPTS:,} transcripts, cache has {n_tx:,}")

expect = {r: dict(zip(genes["refseq"], genes[c].astype(int)))
          for r, _, c in REGIONS}
order = list(genes["refseq"])
total_positions_expected = sum(sum(expect[r].values()) for r, _, _ in REGIONS)
log(f"expected positions: utr5 {sum(expect['utr5'].values()):,} + "
    f"utr3 {sum(expect['utr3'].values()):,} = {total_positions_expected:,}")

# ══════════════════════════════════════════════════════════════════════════
# PASS 1 — read every array, measure the TRUE global min/max, check lengths
#          (no quantization yet: the domain must be judged on raw values)
# ══════════════════════════════════════════════════════════════════════════
banner("PASS 1 — raw scan: true global min/max, length agreement, NaN census")

raw: dict[str, dict[str, np.ndarray]] = {}
h5_report: dict[str, dict] = {}
mismatches: list[tuple] = []          # (region, refseq, h5_len, seq_len)
missing: list[tuple] = []             # (region, refseq)
nan_tx: list[tuple] = []              # (region, refseq, n_nan)
below: list[tuple] = []               # (region, refseq, min, n_below, first_idx, len)
above: list[tuple] = []

for region, path, _ in REGIONS:
    store: dict[str, np.ndarray] = {}
    rmin, rmax = np.inf, -np.inf
    n_pos = 0
    n_below = n_above = 0
    with h5py.File(path, "r") as f:
        n_keys = len(f.keys())
        for rid in order:
            g = f.get(rid)
            if g is None or "score" not in g:
                missing.append((region, rid))
                continue
            arr = np.asarray(g["score"][:], dtype=np.float64)
            if arr.shape[0] != expect[region][rid]:
                mismatches.append((region, rid, int(arr.shape[0]), expect[region][rid]))
                continue
            nn = int(np.isnan(arr).sum())
            if nn:
                nan_tx.append((region, rid, nn))
                continue
            store[rid] = arr
            n_pos += arr.size
            amin, amax = float(arr.min()), float(arr.max())
            rmin = min(rmin, amin)
            rmax = max(rmax, amax)
            lo_mask = arr < LO
            hi_mask = arr > HI
            nb, na = int(lo_mask.sum()), int(hi_mask.sum())
            if nb:
                n_below += nb
                below.append((region, rid, amin, nb, int(np.argmax(lo_mask)), int(arr.size)))
            if na:
                n_above += na
                above.append((region, rid, amax, na, int(np.argmax(hi_mask)), int(arr.size)))
    raw[region] = store
    h5_report[region] = dict(
        file=str(path), n_keys=int(n_keys), extra_keys=int(n_keys - n_tx),
        covered=len(store), positions=int(n_pos),
        min=round(rmin, 6), max=round(rmax, 6),
        n_below_domain=n_below, n_above_domain=n_above,
    )
    log(f"{region}: {len(store):,}/{n_tx:,} covered, {n_pos:,} positions, "
        f"{n_keys:,} keys in file ({n_keys - n_tx:+,} vs universe), "
        f"min {rmin:.4f} max {rmax:.4f}")

# ── hard failures: report, never silently trim ────────────────────────────
if missing or mismatches or nan_tx:
    banner("FAILURE — the NTScore arrays do not line up with the sequences")
    for region, rid in missing[:20]:
        print(f"  MISSING   {region} {rid}: no 'score' dataset in the h5")
    for region, rid, hl, sl in mismatches[:20]:
        print(f"  LEN       {region} {rid}: h5 len {hl:,} != region sequence len {sl:,}")
    for region, rid, nn in nan_tx[:20]:
        print(f"  NaN       {region} {rid}: {nn:,} NaN positions")
    print(f"  totals: {len(missing)} missing, {len(mismatches)} length mismatches, "
          f"{len(nan_tx)} arrays with NaN")
    print("  NOT trimming and NOT proceeding: the contract's nt track must be the exact\n"
          "  length of the region sequence or the browser mis-aligns every nucleotide.")
    sys.exit(1)

n_scanned = sum(h5_report[r]["positions"] for r, _, _ in REGIONS)
assert n_scanned == total_positions_expected, (n_scanned, total_positions_expected)
gmin = min(h5_report[r]["min"] for r, _, _ in REGIONS)
gmax = max(h5_report[r]["max"] for r, _, _ in REGIONS)
n_below_total = sum(h5_report[r]["n_below_domain"] for r, _, _ in REGIONS)
n_above_total = sum(h5_report[r]["n_above_domain"] for r, _, _ in REGIONS)

print(f"\n  ASSERTION len(NTScore) == len(region sequence):  "
      f"{n_tx * 2:,}/{n_tx * 2:,} PASS  (utr5 {n_tx:,}/{n_tx:,}, utr3 {n_tx:,}/{n_tx:,})")
print(f"  positions scanned: {n_scanned:,}  (matches the expected sum exactly)")
print(f"  TRUE global min {gmin:.4f}   TRUE global max {gmax:.4f}")
print(f"  utr5 [{h5_report['utr5']['min']:.4f}, {h5_report['utr5']['max']:.4f}]   "
      f"utr3 [{h5_report['utr3']['min']:.4f}, {h5_report['utr3']['max']:.4f}]")

# ══════════════════════════════════════════════════════════════════════════
# DOMAIN VERDICT — loud, itemised, never silent
# ══════════════════════════════════════════════════════════════════════════
domain_ok = (gmin >= LO) and (gmax <= HI)
if not domain_ok:
    banner(f"DOMAIN VIOLATION — paths.NT_DOMAIN = {(LO, HI)} does NOT contain the data")
    print(f"  The domain constant is WRONG, not the data.  Measured over ALL {n_scanned:,}")
    print(f"  positions in both HDF5 files (no sampling):")
    print(f"     true global min  {gmin:.4f}   (constant says {LO})")
    print(f"     true global max  {gmax:.4f}   (constant says {HI})")
    print(f"     {n_below_total} position(s) below {LO}, {n_above_total} above {HI} "
          f"= {100.0 * (n_below_total + n_above_total) / n_scanned:.7f}% of the corpus")
    print(f"  paths.py's inline comment 'measured min -7.688' also does not reproduce; the")
    print(f"  briefed minima (-7.688 utr3 / -7.281 utr5) were most likely taken on a sample.")
    print("  Full out-of-domain census (region, refseq, transcript min, n, first index, len):")
    for rec in sorted(below + above, key=lambda t: t[2])[:40]:
        print(f"     {rec[0]:5s} {rec[1]:<16s} min {rec[2]:+.4f}  n={rec[3]}  "
              f"idx={rec[4]}  len={rec[5]}")
    print("\n  RESOLUTION IS NOT MINE TO MAKE — paths.py and CONTRACT.md belong to another")
    print("  agent.  Two honest options, both stated in the report:")
    print(f"    (a) keep NT_DOMAIN = {(LO, HI)} and DOCUMENT the clamp.  CONTRACT.md already")
    print("        says 'clamped 0-255', so these positions land on 0 and nothing else moves.")
    print("        Contract invariant 6 must then be restated as 'no more than N positions")
    print("        fall outside' instead of 'fail if outside'.")
    print("    (b) widen NT_DOMAIN to (-8.5, 0.0) and change the contract formula to")
    print("        round(255 * (v + 8.5) / 8.5).  Every browser-side dequantization changes.")
    print(f"  THIS RUN takes (a): it keeps the published formula and loses "
          f"{n_below_total + n_above_total} of {n_scanned:,} positions.")
    print("  The clamp is recorded position-by-position in _cache/nt/nt_meta.json.")
    if args.strict:
        print("\n  --strict given: exiting non-zero without writing anything.")
        sys.exit(2)
else:
    log(f"domain OK: [{gmin:.4f}, {gmax:.4f}] fits inside {(LO, HI)}")

# ══════════════════════════════════════════════════════════════════════════
# PASS 2 — quantize + base64, and measure the round trip
# ══════════════════════════════════════════════════════════════════════════
banner("PASS 2 — quantize to uint8, base64, verify the round trip")

rng = np.random.default_rng(7)
rows = []
sizes = {r: [] for r, _, _ in REGIONS}          # raw base64 bytes per transcript
gz_per_tx = []                                   # gzip of the shard's "nt" object
raw_b64_bytes = {r: 0 for r, _, _ in REGIONS}
clamped_cells = 0
max_dequant_err = 0.0
qmin_seen, qmax_seen = 255, 0
hist = np.zeros(256, dtype=np.int64)

b64: dict[str, dict[str, str]] = {r: {} for r, _, _ in REGIONS}

for region, _, _ in REGIONS:
    for rid in order:
        arr = raw[region][rid]
        scaled = np.round(255.0 * (arr - LO) / SPAN)
        clamped_cells += int(((scaled < 0) | (scaled > 255)).sum())
        q = np.clip(scaled, 0, 255).astype(np.uint8)
        hist += np.bincount(q, minlength=256)
        if q.size:
            qmin_seen = min(qmin_seen, int(q.min()))
            qmax_seen = max(qmax_seen, int(q.max()))
        s = base64.b64encode(q.tobytes()).decode("ascii")
        b64[region][rid] = s
        nb = len(s)
        sizes[region].append(nb)
        raw_b64_bytes[region] += nb
        rows.append((rid, region, int(q.size), s))

# round-trip verification on a 2,000-transcript random sample, both regions
sample = rng.choice(np.array(order, dtype=object), size=2000, replace=False)
rt_len_ok = rt_val_ok = 0
half_step = 0.5 * SPAN / 255.0 + 1e-9
for rid in sample:
    for region, _, _ in REGIONS:
        d = np.frombuffer(base64.b64decode(b64[region][rid]), dtype=np.uint8)
        if d.size == expect[region][rid]:
            rt_len_ok += 1
        v = LO + d.astype(np.float64) * SPAN / 255.0
        src = np.clip(raw[region][rid], LO, HI)
        err = float(np.abs(v - src).max()) if src.size else 0.0
        max_dequant_err = max(max_dequant_err, err)
        if err <= half_step:
            rt_val_ok += 1
n_rt = len(sample) * 2
print(f"  round trip: base64 -> uint8 length == region length for {rt_len_ok:,}/{n_rt:,}")
print(f"  round trip: max |dequantized - clamped source| = {max_dequant_err:.6f} "
      f"(half step = {half_step:.6f}) for {rt_val_ok:,}/{n_rt:,}")
assert rt_len_ok == n_rt and rt_val_ok == n_rt, "round trip failed"
print(f"  quantized value range actually used: [{qmin_seen}, {qmax_seen}] of [0, 255]")
print(f"  cells hitting the clamp: {clamped_cells} "
      f"({100.0 * clamped_cells / n_scanned:.7f}% of {n_scanned:,})")
assert clamped_cells == n_below_total + n_above_total

# ══════════════════════════════════════════════════════════════════════════
# SIZE — what this actually costs the gene shards
# ══════════════════════════════════════════════════════════════════════════
banner("SIZE — projected contribution to the gene shards")

size_stats = {}
for region, _, _ in REGIONS:
    a = np.asarray(sizes[region], dtype=np.int64)
    size_stats[region] = dict(mean=float(a.mean()), p50=float(np.percentile(a, 50)),
                              p95=float(np.percentile(a, 95)), max=int(a.max()),
                              total=int(a.sum()))
    print(f"  {region} base64 bytes/transcript:  mean {a.mean():8.1f}   "
          f"p50 {np.percentile(a, 50):8.1f}   p95 {np.percentile(a, 95):8.1f}   "
          f"max {a.max():,}    corpus {a.sum() / 1e6:.2f} MB")

# the "nt" object exactly as it lands in the shard JSON, per transcript
both_raw = []
for rid in order:
    payload = json.dumps({"nt": {"utr5": b64["utr5"][rid], "utr3": b64["utr3"][rid]}},
                         separators=(",", ":"))
    both_raw.append(len(payload.encode("utf-8")))
    gz_per_tx.append(len(gzip.compress(payload.encode("utf-8"), 6)))
both_raw = np.asarray(both_raw, dtype=np.int64)
gz = np.asarray(gz_per_tx, dtype=np.int64)

print(f"\n  shard \"nt\" object, RAW json bytes/transcript:  mean {both_raw.mean():8.1f}   "
      f"p95 {np.percentile(both_raw, 95):8.1f}   max {both_raw.max():,}")
print(f"  shard \"nt\" object, GZIP bytes/transcript:      mean {gz.mean():8.1f}   "
      f"p95 {np.percentile(gz, 95):8.1f}   max {gz.max():,}")
print(f"  corpus-wide: raw {both_raw.sum() / 1e6:.2f} MB   gzipped {gz.sum() / 1e6:.2f} MB")
TARGET_TX, TARGET_CORPUS = 1871.0, 33.9e6
print(f"  estimate to beat: ~1,871 B gz/transcript, 33.9 MB corpus-wide")
verdict = "UNDER" if gz.mean() <= TARGET_TX else "OVER"
print(f"  VERDICT: {gz.mean():.0f} B gz/transcript ({verdict} by "
      f"{abs(gz.mean() - TARGET_TX):.0f} B), {gz.sum() / 1e6:.2f} MB corpus "
      f"({'UNDER' if gz.sum() <= TARGET_CORPUS else 'OVER'} by "
      f"{abs(gz.sum() - TARGET_CORPUS) / 1e6:.2f} MB)")
print(f"  (gzip level 6 on the isolated \"nt\" object; the real shard gzips as a whole,\n"
      f"   so the per-transcript figure above is a slight over-estimate.)")

# ══════════════════════════════════════════════════════════════════════════
# WRITE
# ══════════════════════════════════════════════════════════════════════════
banner("WRITE")
NTDIR.mkdir(parents=True, exist_ok=True)

nt = pd.DataFrame(rows, columns=["refseq", "region", "n", "b64"])
nt["region"] = nt["region"].astype("category")
nt = nt.sort_values(["refseq", "region"], kind="stable").reset_index(drop=True)
out = NTDIR / "nt.parquet"
nt.to_parquet(out, index=False, compression="zstd")
log(f"wrote {out}  {len(nt):,} rows x {nt.shape[1]} cols  "
    f"{out.stat().st_size / 1e6:.2f} MB on disk")

assert len(nt) == n_tx * 2
assert nt.groupby("refseq", observed=True).size().eq(2).all()
assert (nt["n"] > 0).all()

meta = {
    "script": "03_ntscore.py",
    "built": time.strftime("%Y-%m-%d"),
    "output": {
        "file": "code/build/_cache/nt/nt.parquet",
        "columns": ["refseq", "region", "n", "b64"],
        "rows": len(nt),
        "disk_bytes": out.stat().st_size,
        "b64_alphabet": "RFC 4648 standard ('+/' with '=' padding), python base64.b64encode",
        "dtype": "uint8, little-endian irrelevant (1 byte)",
        "note": "two rows per transcript, region in {utr5, utr3}; n == len(region sequence) == "
                "len(base64.b64decode(b64)). No cds/protein track exists.",
    },
    "quantization": {
        "domain": [LO, HI],
        "encode": "q = clip(round(255 * (v - (-8.0)) / 8.0), 0, 255).astype(uint8)",
        "decode": "v = -8.0 + q * 8.0 / 255",
        "half_step": half_step,
        "max_dequant_error_observed": max_dequant_err,
        "q_range_used": [qmin_seen, qmax_seen],
        "q_histogram": hist.tolist(),
    },
    "scan": {
        "transcripts": n_tx,
        "positions_scanned": int(n_scanned),
        "true_global_min": gmin,
        "true_global_max": gmax,
        "per_region": h5_report,
        "length_mismatches": mismatches,
        "missing_keys": missing,
        "nan_arrays": nan_tx,
    },
    "domain_verdict": {
        "domain_contains_data": bool(domain_ok),
        "positions_below_domain": n_below_total,
        "positions_above_domain": n_above_total,
        "fraction_out_of_domain": (n_below_total + n_above_total) / n_scanned,
        "clamped_cells": clamped_cells,
        "out_of_domain_census": [
            {"region": r, "refseq": rid, "transcript_min_or_max": v,
             "n_positions": n, "first_index": i, "region_len": L}
            for r, rid, v, n, i, L in sorted(below + above, key=lambda t: t[2])
        ],
        "resolution": ("paths.NT_DOMAIN lower bound does not contain the data. This run keeps "
                       "the published formula and clamps; the owner of paths.py/CONTRACT.md must "
                       "either document the clamp (invariant 6 restated as a budget) or widen the "
                       "domain to -8.5 and change the decode formula everywhere.")
        if not domain_ok else "domain contains the data; no action needed",
    },
    "size": {
        "per_region_b64_bytes": size_stats,
        "shard_nt_object_raw_bytes": {"mean": float(both_raw.mean()),
                                      "p95": float(np.percentile(both_raw, 95)),
                                      "max": int(both_raw.max()),
                                      "corpus": int(both_raw.sum())},
        "shard_nt_object_gzip_bytes": {"mean": float(gz.mean()),
                                       "p95": float(np.percentile(gz, 95)),
                                       "max": int(gz.max()),
                                       "corpus": int(gz.sum())},
        "target_gz_per_transcript": TARGET_TX,
        "target_corpus_bytes": TARGET_CORPUS,
    },
    "roundtrip": {"sampled_transcripts": len(sample), "checks": n_rt,
                  "length_ok": rt_len_ok, "value_ok": rt_val_ok},
}
mpath = NTDIR / "nt_meta.json"
mpath.write_text(json.dumps(meta, indent=1))
log(f"wrote {mpath}")

# ── read-back proof: exactly what the gene-shard builder will do ──────────
banner("READ-BACK — the gene-shard builder's access pattern")
back = pd.read_parquet(out)
lut = {(r, g): s for r, g, s in zip(back["refseq"], back["region"].astype(str), back["b64"])}
probe = ["NM_001101"] if "NM_001101" in expect["utr5"] else [order[0]]
probe += list(rng.choice(np.array(order, dtype=object), size=4, replace=False))
for rid in probe:
    d5 = np.frombuffer(base64.b64decode(lut[(rid, "utr5")]), dtype=np.uint8)
    d3 = np.frombuffer(base64.b64decode(lut[(rid, "utr3")]), dtype=np.uint8)
    ok = d5.size == expect["utr5"][rid] and d3.size == expect["utr3"][rid]
    print(f"  {rid:<16s} utr5 {d5.size:>5,}=={expect['utr5'][rid]:<5,} "
          f"utr3 {d3.size:>5,}=={expect['utr3'][rid]:<5,}  {'OK' if ok else 'MISMATCH'}  "
          f"first utr5 q = {d5[:6].tolist()} -> "
          f"{np.round(LO + d5[:6].astype(float) * SPAN / 255.0, 3).tolist()}")
    assert ok

print(f"\n[{time.time() - T0:6.1f}s] 03_ntscore.py done — "
      f"{len(nt):,} rows, {n_scanned:,} positions, "
      f"domain {'OK' if domain_ok else 'VIOLATED (clamped, see banner)'}")
