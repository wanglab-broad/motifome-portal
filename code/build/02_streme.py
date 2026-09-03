#!/usr/bin/env python
"""02_streme.py — parse STREME output into a gated PWM bundle.

Writes  _cache/streme.json :

    { "<cluster_id>": {"pwm": [[...], ...], "alphabet": "ACGT"|"ACDEFGHIKLMNPQRSTVWY",
                       "evalue": 5.4e-4, "nsites": 148, "source": "streme_out_full",
                       "motif_id": "1-UUUUUA", "test_pvalue": 4.5e-5, "width": 6},
      ... }
      plus a "_meta" key with the full census.

VERIFIED FACT 7 — only clusters whose best STREME motif has test_pvalue < 0.05 get a
logo.  There is NO on-the-fly fallback PWM: clusters were k-means'd on EMBEDDINGS, not
on sequence, so a naive per-cluster PWM disagrees with STREME on 77% of clusters and
manufactures SSSSS / PPPPP / VVVVV artifacts.  Everything else stays null and the UI
shows a designed empty state with the denominator printed.

Alphabet note: STREME was run on RNA fasta for the UTR clusters, so its XML alphabet is
ACGU.  Every other payload in this portal stores UTR sequence in the DNA alphabet and
lets the front end map T->U at display time (VERIFIED FACT 11), so we relabel the U
column to T here.  The column ORDER is untouched (A,C,G,U == A,C,G,T); no probability
moves.
"""
import json
import sys
import xml.etree.ElementTree as ET
from collections import Counter

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
import paths  # noqa: E402

CACHE = paths.HERE / "_cache"
OUT_JSON = CACHE / "streme.json"

PVAL_GATE = 0.05

# search order: the full run first (513 dirs, the superset), then the two smaller runs,
# which are allowed to rescue a cluster whose full run produced nothing significant.
SOURCES = [
    ("streme_out_full", paths.STREME_FULL),
    ("streme_out", paths.STREME_OUT),
    ("streme_out_topN", paths.STREME_TOPN),
]


def core_alphabet(root):
    """Core (unambiguous) letters, in file order.

    A letter is ambiguous iff it carries `equals` (N=ACGU, X=ACDEF...).  We
    cross-check against the attribute order of the first <pos> row, which is
    authoritative for the PWM column order.
    """
    alph_el = root.find("model/alphabet")
    core = [le.attrib["id"] for le in alph_el if "equals" not in le.attrib]
    name = alph_el.attrib.get("name", "")
    return core, name


def parse_txt(txt_path):
    """Fallback reader for streme.txt.

    IMPORTANT: streme.txt carries only the E-value (`E= 5.4e-004`) on the
    letter-probability header line — it does NOT carry test_pvalue.  The gate this
    build must enforce (VERIFIED FACT 7) is test_pvalue < 0.05, so a txt-only cluster
    cannot be gated correctly and we refuse to emit a logo for it.  We still parse the
    file so the census can say exactly what was there.
    """
    text = txt_path.read_text() if txt_path.exists() else ""
    if not text.strip():
        return None, "streme.txt is empty (0 bytes) — the run produced no output"
    alph = None
    motifs = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("ALPHABET="):
            alph = list(ln.split("=", 1)[1].strip())
        elif ln.startswith("MOTIF "):
            mid = ln.split()[1]
            hdr = lines[i + 1] if i + 1 < len(lines) else ""
            if "letter-probability matrix" in hdr:
                toks = hdr.replace("=", "= ").split()
                get = lambda k: toks[toks.index(k) + 1] if k in toks else "nan"  # noqa: E731
                w = int(float(get("w=")))
                rows = []
                for j in range(i + 2, i + 2 + w):
                    rows.append([float(x) for x in lines[j].split()])
                motifs.append(
                    {
                        "motif_id": mid,
                        "width": w,
                        "nsites": int(float(get("nsites="))),
                        "test_evalue": float(get("E=")),
                        "test_pvalue": float("nan"),  # NOT AVAILABLE in txt
                        "pwm": rows,
                    }
                )
                i += 1 + w
        i += 1
    return (alph, motifs), None


def parse_xml(xml_path):
    """-> (alphabet_list, alphabet_name, [motif dicts])  or None if unusable."""
    try:
        root = ET.parse(xml_path).getroot()
    except Exception as exc:  # truncated / malformed file
        return None, str(exc)

    core, alph_name = core_alphabet(root)
    motifs = []
    for m in root.findall("motifs/motif"):
        a = m.attrib
        rows = []
        cols = None
        for pos in m.findall("pos"):
            keys = list(pos.attrib.keys())
            if cols is None:
                cols = keys
            elif keys != cols:
                return None, "inconsistent <pos> columns"
            rows.append([float(pos.attrib[k]) for k in cols])
        if not rows:
            continue
        if cols != core:
            # trust the PWM's own column order; note the disagreement
            core = cols
        try:
            tp = float(a.get("test_pvalue", "nan"))
        except ValueError:
            tp = float("nan")
        motifs.append(
            {
                "motif_id": a.get("id"),
                "alt": a.get("alt"),
                "width": int(a.get("width", len(rows))),
                "test_pvalue": tp,
                "test_evalue": float(a.get("test_evalue", "nan")),
                "train_pvalue": float(a.get("train_pvalue", "nan")),
                "nsites": int(float(a.get("total_sites", 0))),
                "pwm": rows,
            }
        )
    return (core, alph_name, motifs), None


def main():
    universe = sorted(
        json.loads((CACHE / "core_meta.json").read_text())["cluster_ids"]
    ) if "cluster_ids" in json.loads((CACHE / "core_meta.json").read_text()) else None
    if universe is None:
        import pandas as pd

        universe = sorted(
            pd.read_parquet(CACHE / "clusters.parquet")["cluster_id"].tolist()
        )

    have_dir = set()
    have_motif = set()
    pass_gate = set()
    bundle = {}
    per_source = Counter()
    parse_fail = []
    txt_fallback = []
    n_motifs_seen = 0
    rescued = []

    for src_name, src_dir in SOURCES:
        if not src_dir.exists():
            print(f"  [warn] {src_name} missing at {src_dir}")
            continue
        for d in sorted(src_dir.iterdir()):
            if not d.is_dir():
                continue
            cid = d.name
            have_dir.add(cid)
            if cid in bundle:
                continue  # already satisfied by a higher-priority source
            xml_path = d / "streme.xml"
            parsed = None
            if xml_path.exists():
                parsed, err = parse_xml(xml_path)
            else:
                err = "no streme.xml"
            if parsed is None:
                # XML unusable -> try streme.txt, and say so loudly.
                tparsed, terr = parse_txt(d / "streme.txt")
                if tparsed is None:
                    parse_fail.append((src_name, cid, f"{err}; {terr}"))
                else:
                    txt_fallback.append(
                        (src_name, cid, len(tparsed[1]),
                         "REFUSED: streme.txt has no test_pvalue, gate unenforceable")
                    )
                    parse_fail.append((src_name, cid, f"{err}; txt has no test_pvalue"))
                continue
            alph, alph_name, motifs = parsed
            if not motifs:
                continue
            n_motifs_seen += len(motifs)
            have_motif.add(cid)

            good = [m for m in motifs if m["test_pvalue"] == m["test_pvalue"] and m["test_pvalue"] < PVAL_GATE]
            if not good:
                continue
            good.sort(key=lambda m: (m["test_pvalue"], m["test_evalue"], -m["nsites"]))
            best = good[0]

            # RNA -> DNA relabel so the whole portal speaks one alphabet.
            letters = ["T" if c == "U" else c for c in alph]
            bundle[cid] = {
                "pwm": [[round(v, 5) for v in row] for row in best["pwm"]],
                "alphabet": "".join(letters),
                "evalue": best["test_evalue"],
                "nsites": best["nsites"],
                "source": src_name,
                "motif_id": best["motif_id"],
                "test_pvalue": best["test_pvalue"],
                "width": best["width"],
                "n_motifs_in_run": len(motifs),
                "n_motifs_passing": len(good),
            }
            pass_gate.add(cid)
            per_source[src_name] += 1
            if src_name != "streme_out_full":
                rescued.append(cid)

    # census
    n_universe = len(universe)
    in_universe = {c for c in bundle if c in set(universe)}
    meta = {
        "gate": f"test_pvalue < {PVAL_GATE}",
        "n_clusters_total": n_universe,
        "n_with_streme_dir": len(have_dir),
        "n_with_ge1_motif": len(have_motif),
        "n_passing_gate": len(pass_gate),
        "n_logos_in_universe": len(in_universe),
        "n_null_logo": n_universe - len(in_universe),
        "pct_with_logo": round(100.0 * len(in_universe) / n_universe, 2),
        "per_source": dict(per_source),
        "rescued_from_secondary_runs": rescued,
        "n_motifs_parsed": n_motifs_seen,
        "parse_failures": parse_fail,
        "txt_fallback_used": txt_fallback,
        "alphabet_note": "UTR PWM columns relabelled U->T; order unchanged.",
    }

    payload = dict(bundle)
    payload["_meta"] = meta
    OUT_JSON.write_text(json.dumps(payload))

    by_region = Counter(c.split("_")[0] for c in in_universe)
    print("=" * 72)
    print("02_streme.py")
    print("=" * 72)
    print(f"  clusters in universe .............. {n_universe}")
    print(f"  clusters with a STREME dir ........ {len(have_dir)}")
    print(f"  ... with >=1 parsed motif ......... {len(have_motif)}")
    print(f"  ... with >=1 motif p_test<0.05 .... {len(pass_gate)}")
    print(f"  logo != null in the 900 universe .. {len(in_universe)}"
          f"  ({meta['pct_with_logo']}%)")
    print(f"  logo == null ...................... {meta['n_null_logo']}")
    print(f"  by region: {dict(by_region)}")
    print(f"  per source: {dict(per_source)}"
          f"   rescued by secondary runs: {len(rescued)}")
    print(f"  motifs parsed ..................... {n_motifs_seen}")
    print(f"  parse failures .................... {len(parse_fail)}"
          f"  (txt fallback needed: {len(txt_fallback)})")
    for f in parse_fail[:10]:
        print(f"      {f}")
    print(f"  wrote {OUT_JSON}  ({OUT_JSON.stat().st_size/1e6:.2f} MB)")

    # sanity: every stored pwm row sums to ~1 and has |alphabet| columns
    bad = 0
    for cid, lg in bundle.items():
        k = len(lg["alphabet"])
        for row in lg["pwm"]:
            if len(row) != k or abs(sum(row) - 1.0) > 0.02:
                bad += 1
    print(f"  PWM rows failing (ncol=={{|alphabet|}} and sum~1): {bad}")
    assert bad == 0, "malformed PWM rows"


if __name__ == "__main__":
    main()
