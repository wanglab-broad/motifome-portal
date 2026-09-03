#!/usr/bin/env python
"""00_validate.py — eleven hard assertions over the FULL MIRTO portal source data.

Every check runs on every row (no sampling). Each prints PASS/FAIL with the measured
number. The script exits non-zero if any assertion fails.

Run:  /opt/anaconda3/envs/bio/bin/python code/build/00_validate.py
"""
from __future__ import annotations

import json
import sys
import time
from collections import Counter

import h5py
import numpy as np
import pandas as pd

import paths

# ── result bookkeeping ─────────────────────────────────────────────────────
RESULTS: list[dict] = []
T0 = time.time()

REGION_SEQ = {"utr5": "utr5_sequence", "utr3": "utr3_sequence", "protein": "protein_sequence"}
SEQ_COLS = ["utr5_sequence", "cds_sequence", "utr3_sequence", "protein_sequence"]


def check(n: int, name: str, ok: bool, measured: str, detail: str = "") -> bool:
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {n:2d}. {name}")
    print(f"          measured: {measured}")
    if detail:
        for line in detail.splitlines():
            print(f"          {line}")
    RESULTS.append({"n": n, "name": name, "ok": bool(ok), "measured": measured})
    return ok


def banner(msg: str) -> None:
    print(f"\n--- {msg}  (t+{time.time() - T0:5.1f}s)")


# ── load ───────────────────────────────────────────────────────────────────
banner("loading source tables")
motifs = pd.read_parquet(
    paths.MOTIF_CORE,
    columns=["sequence_id", "region", "motif_start", "motif_end", "motifs",
             "motif_length", "motif_cluster", "plddt", "motif_score", "motif_entropy"],
)
seqs = pd.read_parquet(paths.SEQUENCES)
print(f"    motifs  {motifs.shape}   sequences {seqs.shape}")

# ── 3. dedup on refseq_id_without_ver is lossless ──────────────────────────
banner("assertion 3 — dedup losslessness")
vc = seqs["refseq_id_without_ver"].value_counts()
dup_ids = vc[vc > 1].index
n_dup_groups = int(len(dup_ids))
sub = seqs[seqs["refseq_id_without_ver"].isin(dup_ids)]
nuniq = sub.groupby("refseq_id_without_ver", sort=False)[SEQ_COLS].nunique()
n_conflict = int((nuniq > 1).any(axis=1).sum())
n_extra_rows = int(len(seqs) - seqs["refseq_id_without_ver"].nunique())
ok3 = (n_dup_groups == 1296) and (n_conflict == 0)
check(3, "drop_duplicates('refseq_id_without_ver') is lossless",
      ok3,
      f"{n_dup_groups} duplicate groups (expected 1296), "
      f"{n_dup_groups - n_conflict}/{n_dup_groups} byte-identical across all 4 sequence columns",
      f"extra rows removed: {n_extra_rows}  ({len(seqs)} -> {seqs['refseq_id_without_ver'].nunique()})")

sd = seqs.drop_duplicates("refseq_id_without_ver").set_index("refseq_id_without_ver")

# ── 4. every motif sequence_id joins ───────────────────────────────────────
banner("assertion 4 — join coverage")
motif_ids = pd.Index(motifs["sequence_id"].unique())
n_universe = int(len(motif_ids))
n_joined = int(motif_ids.isin(sd.index).sum())
# counter-evidence: the wrong key
alt = seqs.dropna(subset=["RefSeq mRNA ID"]).drop_duplicates("RefSeq mRNA ID")
n_alt = int(motif_ids.isin(pd.Index(alt["RefSeq mRNA ID"])).sum())
n_ensg = int(motif_ids.isin(pd.Index(seqs["Gene stable ID"])).sum())
ok4 = (n_joined == n_universe == paths.N_TRANSCRIPTS)
check(4, "all motif sequence_ids join under refseq_id_without_ver",
      ok4,
      f"{n_joined}/{n_universe} joined (expected {paths.N_TRANSCRIPTS}/{paths.N_TRANSCRIPTS})",
      f"counter-evidence: 'RefSeq mRNA ID' would join {n_alt}/{n_universe} "
      f"({100 * n_alt / n_universe:.2f}%, drops {n_universe - n_alt}); "
      f"'Gene stable ID' joins {n_ensg}/{n_universe}")

# per-region sequence lookups, restricted to the motif universe
uni = sd.loc[sd.index.intersection(motif_ids)]
LOOK = {r: uni[c].to_dict() for r, c in REGION_SEQ.items()}

# ── 1. coordinate convention ───────────────────────────────────────────────
banner("assertion 1 — seq[start:end+1] == motif, all 889,215 rows")
sid = motifs["sequence_id"].to_numpy()
reg = motifs["region"].to_numpy()
ms = motifs["motif_start"].to_numpy()
me = motifs["motif_end"].to_numpy()
mstr = motifs["motifs"].to_numpy()

per_region_ok: Counter = Counter()
per_region_n: Counter = Counter()
bad_rows: list[int] = []
overrun_rows: list[int] = []
for r in ("utr5", "utr3", "protein"):
    m = reg == r
    idx = np.flatnonzero(m)
    look = LOOK[r]
    for i in idx:
        s = look.get(sid[i])
        if s is None:
            bad_rows.append(int(i))
            continue
        if me[i] >= len(s):
            overrun_rows.append(int(i))
        if s[ms[i]: me[i] + 1] == mstr[i]:
            per_region_ok[r] += 1
        else:
            bad_rows.append(int(i))
    per_region_n[r] = int(m.sum())

tot_ok = int(sum(per_region_ok.values()))
tot_n = int(len(motifs))
ok1 = (tot_ok == tot_n == paths.N_MOTIFS)
check(1, "seq[motif_start : motif_end + 1] reproduces the stored motif",
      ok1,
      f"{tot_ok}/{tot_n} rows (expected {paths.N_MOTIFS}/{paths.N_MOTIFS}) — 0-based, inclusive both ends",
      "\n".join(f"{r:>8}: {per_region_ok[r]}/{per_region_n[r]}"
                for r in ("utr5", "utr3", "protein")))

# ── 2. motif_length consistency ────────────────────────────────────────────
banner("assertion 2 — motif_length == end - start + 1")
ml = motifs["motif_length"].to_numpy()
good2 = int(np.sum(ml == (me - ms + 1)))
# and the stored string really has that length
strlen = np.fromiter((len(x) for x in mstr), dtype=np.int64, count=len(mstr))
good2b = int(np.sum(strlen == ml))
ok2 = (good2 == tot_n) and (good2b == tot_n)
check(2, "motif_length == motif_end - motif_start + 1",
      ok2,
      f"{good2}/{tot_n} rows; len(motif string) == motif_length for {good2b}/{tot_n}")

# ── 6. no interval overruns its sequence ───────────────────────────────────
banner("assertion 6 — no motif interval overruns its region sequence")
n_overrun = int(len(overrun_rows))
n_neg = int(np.sum(ms < 0))
ok6 = (n_overrun == 0) and (n_neg == 0)
check(6, "motif_end < len(region sequence) for every row",
      ok6,
      f"{tot_n - n_overrun}/{tot_n} in-bounds; {n_overrun} overruns, {n_neg} negative starts")

# ── 5. CDS / protein length relation ───────────────────────────────────────
banner("assertion 5 — len(cds) == 3*len(protein) + 3")
cds_len = sd["cds_sequence"].str.len().to_numpy()
prot_len = sd["protein_sequence"].str.len().to_numpy()
good5_all = int(np.sum(cds_len == 3 * prot_len + 3))
n_all = int(len(sd))
uni_cds = uni["cds_sequence"].str.len().to_numpy()
uni_prot = uni["protein_sequence"].str.len().to_numpy()
good5_uni = int(np.sum(uni_cds == 3 * uni_prot + 3))
n_uni = int(len(uni))
ok5 = (good5_all == n_all) and (good5_uni == n_uni)
check(5, "len(cds) == 3*len(protein) + 3 (protein->mRNA projection is exact)",
      ok5,
      f"{good5_all}/{n_all} deduped rows; {good5_uni}/{n_uni} rows in the motif universe")

# spot-check the published ACTB example (fact 4)
try:
    actb = uni.loc["NM_001101"]
    a_utr5, a_cds = actb["utr5_sequence"], actb["cds_sequence"]
    proj_s = len(a_utr5) + 3 * 23
    proj_e = len(a_utr5) + 3 * 27 + 2
    mrna = a_utr5 + a_cds + actb["utr3_sequence"]
    print(f"          ACTB aa 23-27 {actb['protein_sequence'][23:28]} -> nt {proj_s}-{proj_e} -> {mrna[proj_s:proj_e + 1]}")
except KeyError:
    print("          (ACTB / NM_001101 not in universe — spot check skipped)")

# ── 7. stacking depth ──────────────────────────────────────────────────────
banner("assertion 7 — max stacking depth == 1 within every (sequence_id, region)")
o = motifs[["sequence_id", "region", "motif_start", "motif_end", "motif_cluster"]].sort_values(
    ["sequence_id", "region", "motif_start"], kind="mergesort").reset_index(drop=True)
same = (o["sequence_id"].to_numpy()[1:] == o["sequence_id"].to_numpy()[:-1]) & \
       (o["region"].to_numpy()[1:] == o["region"].to_numpy()[:-1])
prev_end = o["motif_end"].to_numpy()[:-1]
next_start = o["motif_start"].to_numpy()[1:]
overlaps = int(np.sum(same & (next_start <= prev_end)))
gap = next_start - prev_end - 1
abut = same & (gap == 0)
n_abut = int(np.sum(abut))
same_cl = abut & (o["motif_cluster"].to_numpy()[1:] == o["motif_cluster"].to_numpy()[:-1])
n_abut_same = int(np.sum(same_cl))
n_groups = int(o.groupby(["sequence_id", "region"], sort=False).ngroups)
max_depth = 1 if overlaps == 0 else 2  # any overlap means depth >= 2
ok7 = (overlaps == 0)
check(7, "motifs never overlap — max stacking depth is exactly 1",
      ok7,
      f"max depth {max_depth} across {n_groups} (sequence_id, region) groups; {overlaps} overlapping pairs",
      f"adjacency: {n_abut} pairs abut exactly (gap 0), {n_abut_same} of those share a cluster "
      f"-> every span needs its own border")

# ── 8. plddt scale and masking ─────────────────────────────────────────────
banner("assertion 8 — plddt in [0,1], protein rows only")
pl = motifs["plddt"].to_numpy()
is_prot = (reg == "protein")
n_prot = int(is_prot.sum())
n_prot_present = int(np.sum(is_prot & ~np.isnan(pl)))
n_nonprot_present = int(np.sum(~is_prot & ~np.isnan(pl)))
present = pl[~np.isnan(pl)]
pmin, pmax = float(present.min()), float(present.max())
ok8 = (0.0 <= pmin) and (pmax <= 1.0) and (n_nonprot_present == 0) and (n_prot_present == n_prot)
check(8, "plddt is 0-1 scale and exists only on protein rows",
      ok8,
      f"range [{pmin:.4f}, {pmax:.4f}]; present on {n_prot_present}/{n_prot} protein rows "
      f"and {n_nonprot_present} non-protein rows",
      f"(a 0-100 scale would max near 100; measured max {pmax:.4f})")

# ── 9./10. NTScore HDF5 coverage, lengths, domain ──────────────────────────
banner("assertions 9 & 10 — NTScore HDF5 coverage, array lengths, true global min")
universe = list(uni.index)
h5_report = {}
gmin, gmax = np.inf, -np.inf
n_positions = 0
n_below = 0
n_above = 0
outliers: list[tuple] = []
cov_ok = True
len_ok = True
LO, HI = paths.NT_DOMAIN
for tag, path, seqcol in (("utr3", paths.NT_UTR3_H5, "utr3_sequence"),
                          ("utr5", paths.NT_UTR5_H5, "utr5_sequence")):
    lens = uni[seqcol].str.len().to_dict()
    n_keys = 0
    missing = 0
    mismatch = 0
    nan = 0
    tmin, tmax = np.inf, -np.inf
    with h5py.File(path, "r") as f:
        n_keys = len(f.keys())
        for k in universe:
            g = f.get(k)
            if g is None or "score" not in g:
                missing += 1
                continue
            arr = g["score"][:]
            if arr.shape[0] != lens[k]:
                mismatch += 1
                continue
            if not arr.size:
                continue
            n_positions += int(arr.size)
            nan += int(np.isnan(arr).sum())
            a_min = float(arr.min())
            a_max = float(arr.max())
            tmin = min(tmin, a_min)
            tmax = max(tmax, a_max)
            nb = int(np.sum(arr < LO))
            na = int(np.sum(arr > HI))
            n_below += nb
            n_above += na
            if nb or na:
                outliers.append((tag, k, round(a_min, 4), nb, na, int(arr.size)))
    gmin = min(gmin, tmin)
    gmax = max(gmax, tmax)
    h5_report[tag] = dict(n_keys=int(n_keys), covered=int(len(universe) - missing),
                          missing=int(missing), len_mismatch=int(mismatch), n_nan=int(nan),
                          min=round(tmin, 4), max=round(tmax, 4),
                          extra_keys=int(n_keys - len(universe)))
    cov_ok &= (missing == 0)
    len_ok &= (mismatch == 0)

ok9 = cov_ok and len_ok
check(9, "both NTScore HDF5 files cover all 18,093 and array length == region length",
      ok9,
      "; ".join(f"{t}: {r['covered']}/{len(universe)} covered, {r['len_mismatch']} length mismatches "
                f"({r['n_keys']} keys in file, {r['extra_keys']} extra, {r['n_nan']} NaN)"
                for t, r in h5_report.items()))

# independent confirmation that 'score' IS NTScore and the coordinates line up:
# motif_score must equal mean(NTScore[start : end+1]) for UTR motifs.
u3 = motifs[motifs["region"] == "utr3"].head(2000)
with h5py.File(paths.NT_UTR3_H5, "r") as f:
    recomputed = np.array([f[t.sequence_id]["score"][t.motif_start:t.motif_end + 1].mean()
                           for t in u3.itertuples()], dtype=np.float64)
delta = float(np.abs(recomputed - u3["motif_score"].to_numpy()).max())
print(f"          cross-check: motif_score == mean(NTScore[s:e+1]) on 2,000 utr3 motifs, "
      f"max |delta| = {delta:.2e}")

ok10 = (LO <= gmin) and (gmax <= HI)
detail10 = (f"positions scanned: {n_positions:,} over {len(universe)} transcripts x 2 regions\n"
            f"below {LO}: {n_below} ({100 * n_below / max(n_positions, 1):.7f}%)   "
            f"above {HI}: {n_above}\n"
            f"a [-5, 0] domain would clip {int(n_below)} + more — the most model-surprising nucleotides")
if outliers:
    detail10 += "\nout-of-domain transcripts: " + "; ".join(
        f"{t}/{k} min={mn} ({nb} pos of {sz})" for t, k, mn, nb, na, sz in outliers)
    detail10 += ("\nBLOCKING: paths.NT_DOMAIN lower bound is too high. Either widen it to -8.5 "
                 "(and update the CONTRACT quantization formula) or document the clamp.")
check(10, f"true global NTScore min lies inside the quantization domain {paths.NT_DOMAIN}",
      ok10,
      f"global min {gmin:.4f}, global max {gmax:.4f}  (utr3 min {h5_report['utr3']['min']}, "
      f"utr5 min {h5_report['utr5']['min']})",
      detail10)

# ── 11. published annotation coverage percentages ──────────────────────────
banner("assertion 11 — reproduce the 8 published annotation coverage percentages")
ann = pd.read_parquet(
    paths.MOTIF_ANNOT,
    columns=["region", "RBPs_eCLIP", "RBPs_PAR-CLIP,PARalyzer", "RBPs_iCLIP,Piranha_0.01",
             "RBPs_iCLIP,CIMS", "mirna_annotations_targetscan", "interpro_annotations",
             "elm_annotations", "uniprot_annotations", "idpo_annotations",
             "MobIDB annotation", "signalp_annotation"],
)
pub = json.loads(paths.ANNOT_COVERAGE.read_text())["human"]
a_reg = ann["region"].to_numpy()
m_utr = np.isin(a_reg, ["utr5", "utr3"])
m_u3 = a_reg == "utr3"
m_pr = a_reg == "protein"


def nonempty_list(col: str) -> np.ndarray:
    return ann[col].map(lambda v: v is not None and len(v) > 0
                        if isinstance(v, (list, np.ndarray)) else False).to_numpy()


def nonempty_str(col: str) -> np.ndarray:
    s = ann[col]
    return (s.notna() & (s.fillna("").str.len() > 0)).to_numpy()


rbp_any = np.zeros(len(ann), dtype=bool)
for c in ("RBPs_eCLIP", "RBPs_PAR-CLIP,PARalyzer", "RBPs_iCLIP,Piranha_0.01", "RBPs_iCLIP,CIMS"):
    rbp_any |= nonempty_list(c)

MEASURE = {
    "rbp": (rbp_any & m_utr, pub["n_utr"]),
    "mirna": (nonempty_list("mirna_annotations_targetscan") & m_u3, pub["n_utr3"]),
    "interpro": (nonempty_str("interpro_annotations") & m_pr, pub["n_protein"]),
    "elm": (nonempty_str("elm_annotations") & m_pr, pub["n_protein"]),
    "uniprot": (nonempty_str("uniprot_annotations") & m_pr, pub["n_protein"]),
    "mobidb": (nonempty_list("MobIDB annotation") & m_pr, pub["n_protein"]),
    "idpo": (nonempty_str("idpo_annotations") & m_pr, pub["n_protein"]),
    "signalp": (nonempty_str("signalp_annotation") & m_pr, pub["n_protein"]),
}
lines = []
ok11 = True
cov_out = {}
for key, (mask, denom) in MEASURE.items():
    n = int(mask.sum())
    pct = 100.0 * n / denom
    exp = pub["databases"][key]
    d = abs(pct - exp["pct"])
    good = d <= 0.1
    ok11 &= good
    cov_out[key] = dict(display=exp["display"], source=exp["source"], applies=exp["applies"],
                        denominator=int(denom), n_annotated=n, pct=round(pct, 3))
    lines.append(f"{'OK ' if good else 'BAD'} {key:<9} {n:>7}/{denom:<7} = {pct:7.3f}%  "
                 f"published {exp['pct']:7.3f}%  delta {d:.4f}")
check(11, "8 published annotation coverage percentages reproduce within 0.1%",
      ok11, f"{sum(1 for k in MEASURE if abs(100.0 * MEASURE[k][0].sum() / MEASURE[k][1] - pub['databases'][k]['pct']) <= 0.1)}/8 within tolerance",
      "\n".join(lines))

# spurious cross-layer annotation rows (fact 6) — reported, not asserted
spurious = 0
for c in ("interpro_annotations", "elm_annotations", "uniprot_annotations", "idpo_annotations",
          "signalp_annotation"):
    spurious += int((nonempty_str(c) & ~m_pr).sum())
spurious += int((nonempty_list("MobIDB annotation") & ~m_pr).sum())
for c in ("RBPs_eCLIP", "RBPs_PAR-CLIP,PARalyzer", "RBPs_iCLIP,Piranha_0.01", "RBPs_iCLIP,CIMS"):
    spurious += int((nonempty_list(c) & ~m_utr).sum())
spurious += int((nonempty_list("mirna_annotations_targetscan") & ~m_u3).sum())
print(f"          cross-layer annotation cells that MUST be masked at bake: {spurious}")

# comma damage (fact 6) — reported, not asserted
ipr = ann.loc[m_pr, "interpro_annotations"].dropna()
ipr_comma = int(ipr.str.contains(",", regex=False).sum())
upr = ann.loc[m_pr, "uniprot_annotations"].dropna()
print(f"          InterPro strings containing a comma: {ipr_comma}/{len(ipr)} "
      f"({100 * ipr_comma / max(len(ipr), 1):.1f}%) -> never str.split(',')")

# ── summary ────────────────────────────────────────────────────────────────
n_pass = sum(1 for r in RESULTS if r["ok"])
print("\n" + "=" * 74)
print(f"  {n_pass}/11 assertions passed        elapsed {time.time() - T0:.1f}s")
print("=" * 74)
for r in sorted(RESULTS, key=lambda x: x["n"]):
    if not r["ok"]:
        print(f"  BLOCKING FAILURE  #{r['n']} {r['name']}: {r['measured']}")

paths.HERE.joinpath("_cache").mkdir(exist_ok=True)
out = paths.HERE / "_cache" / "validation.json"
out.write_text(json.dumps({
    "assertions_passed": n_pass,
    "assertions_total": 11,
    "results": sorted(RESULTS, key=lambda x: x["n"]),
    "nt_domain": list(paths.NT_DOMAIN),
    "nt_global_min": round(float(gmin), 4),
    "nt_global_max": round(float(gmax), 4),
    "nt_positions_scanned": int(n_positions),
    "nt_positions_below_domain": int(n_below),
    "nt_positions_above_domain": int(n_above),
    "nt_out_of_domain_transcripts": outliers,
    "nt_h5": h5_report,
    "annot_coverage": cov_out,
    "n_dup_groups": n_dup_groups,
    "n_abutting_pairs": n_abut,
    "n_abutting_same_cluster": n_abut_same,
    "n_spurious_annotation_cells": spurious,
}, indent=2))
print(f"  wrote {out}")

sys.exit(0 if n_pass == 11 else 1)
