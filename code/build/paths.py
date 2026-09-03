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
NT_DOMAIN       = (-8.0, 0.0)  # NTScore quantization domain; measured min -7.688
