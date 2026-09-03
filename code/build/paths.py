"""The ONLY module in the build that contains absolute paths.

Everything else imports from here. To relocate the project, edit SD.
"""
from pathlib import Path

SD   = Path("/Users/wangyanz/Desktop/Project/sequence_design")
HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent                 # .../manuscript/online_contents
OUT  = REPO / "portal" / "data"           # everything the browser reads

# ── source data ────────────────────────────────────────────────────────────
MOTIF_ANNOT   = SD / "sequence_annotation/sequence_annotation_human/data/processed/motif_full_annotations.parquet"
MOTIF_CORE    = SD / "data/identified_motifs_with_clusters.0513.parquet"
SEQUENCES     = SD / "data/GRCh37_latest_rna_sequence_pairs_long_transcript.parquet"
NT_UTR3_H5    = SD / "data/outputs_utr3_score_0318.h5"
NT_UTR5_H5    = SD / "explore_biology/01.protein_localization/analysis/data/h5cache/outputs_utr5_score_0326.h5"

# ── module / network analysis ──────────────────────────────────────────────
V4            = SD / "sequence_analysis_v4_0621"
PAIR_SCORES   = V4 / "results/protein_utr_FINAL_scores.csv"
PAIR_PASSING  = V4 / "results/phylo_corrected_candidates.csv"
PAIR_RAW_TOP  = V4 / "results/RAW_top30_annotated.csv"
MODULES_JSON  = V4 / "03.interacting_modules/modules.json"
MODULES_SUMM  = V4 / "03.interacting_modules/modules_summary.csv"
MODULE_TERMS  = V4 / "03.interacting_modules/module_leading_terms.csv"
MODULE_GO     = V4 / "03.interacting_modules/module_GO_enrichment.csv"
MODULE_GENEIX = V4 / "03.interacting_modules/module_gene_members/module_gene_index.csv"

# ── precomputed figure caches (reused, never rebuilt) ──────────────────────
FIGI          = SD / "manuscript/main_figures_code/figure3_4/motif_pair_network/intermediate"
CONSENSUS_META  = FIGI / "consensus_meta.csv"
CONSENSUS_PAIRS = FIGI / "consensus_pair_scores.csv.gz"
CLUSTER_LABELS  = FIGI / "cluster_term_labels.csv"
CLUSTER_ENRICH  = FIGI / "cluster_term_enrichment.csv.gz"
INTERPRO_MAP    = FIGI / "interpro_entry_map.csv"
STREME_FULL     = FIGI / "streme_out_full"      # 513 cluster dirs with streme.xml
STREME_OUT      = FIGI / "streme_out"           # 143
STREME_TOPN     = FIGI / "streme_out_topN"      # 56

ANNOT_COVERAGE  = SD / "sequence_annotation/annotation_coverage_stats.json"

PY = "/opt/anaconda3/envs/bio/bin/python"

# ── verified invariants (see instructions/01.proposal_and_plan.md §2) ──────
N_MOTIFS        = 889_215
N_TRANSCRIPTS   = 18_093       # transcripts carrying >=1 motif
N_CLUSTERS      = 900
N_GATED_EDGES   = 2_620
# NTScore quantization domain. DO NOT CHANGE without re-running 03_ntscore.py AND
# 06_gene_shards.py AND updating the browser-side decode in portal/js/data.js — the
# encode/decode pair (q = clip(round(255*(v+8)/8),0,255) / v = -8 + q*8/255) is baked
# into all 18,093 gene shards.
# MEASURED over all 32,745,544 positions (QA re-verified 2026-09-03, no sampling):
#   true global min -8.2500 (utr5 NM_001273 idx 101) · utr3 min -8.0625 · global max -0.0013
# An earlier comment here read "measured min -7.688"; that value does not reproduce and
# was the source of the same error in the project's VERIFIED FACTS list. Corrected.
# CONSEQUENCE: exactly 4 of 32,745,544 positions (0.0000122%) fall below -8.0 and clamp
# to the darkest bin — utr5/NM_001273@101, utr5/NM_004703@68, utr5/NM_015080@466,
# utr3/NM_001292043@179. Nothing is clamped silently: the clamp is counted at bake,
# recorded in manifest.json.nt (positions_clamped, true_global_min) and reported as a
# FAILED build assertion (assertions_passed 10 of 11) rather than being papered over.
# Widening to (-8.5, 0) was considered and rejected: it changes every browser-side
# dequantization for a 0.0000122% gain.
NT_DOMAIN       = (-8.0, 0.0)
