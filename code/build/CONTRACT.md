# Data contract — portal/data/**

Every payload the browser reads. Bake scripts WRITE these; frontend modules READ these.
Nobody changes a shape without changing this file first.

Ship raw `.json` (host gzips on the wire). All ids are strings. All coordinates are
**0-based, inclusive both ends** — `seq.slice(s, e + 1)` in JS.

---

## `manifest.json`   (written by 10_manifest.py)
```json
{ "built": "2026-09-02", "counts": {"transcripts":18093,"genes":17847,"motifs":889215,
  "clusters":900,"edges":2620,"cross_module_edges":757,"modules":6},
  "nt_domain": [-8.0, 0.0],
  "assertions_passed": 10, "assertions_total": 11 }
```

## `search.json`   (10_manifest.py)  — one array, loaded once (0.52 MB raw / 0.16 MB gz)
```json
[ ["ACTB","NM_001101",6,20], ... ]      // [symbol, refseq, primary_module|0, n_motifs]
```
Aliases (ENSG/ENST) live in `search_alias.json`: `{"ENSG00000075624":"NM_001101", ...}`

## `gene/<REFSEQ>.json`   (06_gene_shards.py)  — mean 18.1 KB raw / 6.1 KB gz, max 82.7 KB raw / 19.4 KB gz (NM_003128)
```json
{
  "refseq":"NM_001101", "symbol":"ACTB", "ensg":["ENSG00000075624"], "enst":["ENST00000646664"],
  "len": {"utr5":84,"cds":1128,"utr3":600,"protein":375,"mrna":1812},
  "seq": {"utr5":"...","cds":"...","utr3":"...","protein":"..."},   // DNA alphabet; display maps T->U for UTRs only
  "motifs":[
    {"i":0,"r":"utr5","s":5,"e":15,"c":"utr5_0004","m":6,"sc":-1.2619,"en":0.9233,"pl":null,
     "ms":5,"me":15,                                  // mRNA-axis span (protein projected)
     "a":{"rbp":{"eCLIP":["GEMIN5","PUM1","SERBP1"],"PAR-CLIP":["ATXN2","TARDBP"]}}}
     // ^ REAL values from gene/NM_001101.json. Empty keys are OMITTED, never sent as [] or null.
  ],
  "coupling":[ {"p":3,"u":0,"sc":1.7694,"npmi":0.6284,"co":175,"cl":23,"conc":0.114,"znf":0.0} ],
  "nt": {"utr5":"<base64 uint8, len == len(utr5)>", "utr3":"<base64 uint8>"},
  "modules":[6,1]
}
```
- `r` ∈ `utr5|utr3|protein`; `m` = module id or 0 for unassigned; `pl` = pLDDT **0–1**, protein only.
- `ms`/`me`: for UTR motifs, the region span offset into mRNA coords; for protein,
  `ms = len(utr5) + 3*s`, `me = len(utr5) + 3*e + 2`.
- `nt`: NTScore quantized `round(255 * (v - (-8)) / 8)` clamped 0–255. Absent key = no track.
  **There is no CDS or protein track.** The viewer draws a hatched "not computed" band.
- `coupling`: `p`/`u` index into `motifs[]` and name the FIRST motif of each cluster in this
  transcript, so a view must highlight by cluster id (`m.c`), not only the indexed span.
  All four gate values ship — `sc` (phylo_corrected_score), `npmi` (npmi_mip_APC), `co`, `cl` —
  plus `conc` (clade_concentration) and `znf` (frac_co_ZNF). `conc`/`znf` are `null`, never 0,
  when the source is NaN: render "not computable". Sorted by `sc` desc. 65.2% of transcripts
  have >=1 entry; the other 6,301 need the designed empty state.
- `a` keys are omitted when empty. MobiDB/IDPO/SignalP/InterPro/UniProt/ELM appear on
  **protein rows only**; rbp/mir on **UTR rows only** (masked at bake — 212,449 spurious rows).

## `cluster/<CLUSTER_ID>.json`   (07_cluster_shards.py) — 900 files
```json
{
  "id":"utr3_0215","region":"utr3","module":4,
  "name":{"text":"UCUCC, pyrimidine-rich, 5-mer","tier":2,"source":"consensus:utr3_0215#0"},
  // name tiers: 1 = significant enriched term (463) · 2 = derived from the top consensus
  // string (208) · 3 = placeholder, id + size only (229). `source` carries the provenance.
  "size":{"instances":566,"transcripts":213,"genes":206,"lengths":{"5":184,"6":79,...},
          "len_median":7.0},
  "logo": {"pwm":[[0.01,0.02,0.02,0.95], ...], "alphabet":"ACGT",
           "evalue":9.2e-14,"nsites":394,"source":"streme_out_full"} | null,
  "consensus":[ {"cid":"utr3_0215#0","text":"TCTCC","coverage":0.51,"carriers":155} ],
  "position":[0.02,0.03,...],          // 20 bins of relative position within region
  "stats":{"score":{"median":-1.09,"q":[...]},"entropy":{...},"plddt":null},
  "terms":[ {"src":"InterPro","term":"IPR003006","display":"Ig-like domain sf",
             "fold":25.4,"k":43,"n":271,"fdr":1.8e-64} ],
  "partners":[ {"id":"prot_0038","score":0.428,"npmi":0.292,"co":21,"clades":8,
                "conc":0.21,"znf":0.0,"pass":true,"module":4,
                "consensus_pairs":[["TCTCC","LLLSLLS",0.31]]} ],
  "genes":["ACTB", ...],                // carrier symbols, capped at 500
  "n_terms_total":0, "n_partners_total":300, "n_partners_passing":2, "n_genes_total":206
}
```
Field values above are the REAL `cluster/utr3_0215.json` (verified 2026-09-03) except the
`logo`/`consensus`/`terms` rows, which are shape sketches — utr3_0215 in fact has
`n_terms_total: 0`, one of the 437 clusters that must render the designed no-term state.
The four `n_*_total` keys are the DENOMINATORS every designed empty state must print
("8 of 300 partners pass"), so no panel needs a second fetch to say how much it is hiding.
`terms[]` is capped at 40 and `genes[]` at 500; the `n_*` keys are the true counts.
`stats.quantile_levels` = `[0,0.05,0.25,0.5,0.75,0.95,1.0]` describes the `q` arrays.
`logo` additionally carries `motif_id`, `test_pvalue`, `width`, and `size.len_median`.
`partners[].consensus_pairs` is `[[self, partner, score], ...]` capped at 6, DNA alphabet
on the UTR side; present on 8,156 cluster-pairs and on 1,430 of the 2,620 gated edges.
`logo` is `null` for the ~444 clusters with no STREME motif at `test_pvalue < 0.05`.
`partners` includes non-passing ones; the UI filters. `pass` = phylo-independence gate.

## `network.json`   (08_network.py) — 0.509 MB, one file
```json
{
  "nodes":[ {"id":"prot_0072","r":"protein","m":5,"deg":26,"n":617,"nt":270,"ng":267,
             "x":265.8,"y":518.1,                    // frozen build-time layout, seed=7
             "x2":250.0,"y2":677.7,                  // frozen per-module bipartite coords
             "cons":"RGRGGG","cov":0.5905,"carriers":168,"pos":[...20 bins...],
             "name":"RNA-binding domain superfamily","tier":1,"src":"InterPro"} ],
            // ^ REAL node from network.json, verified 2026-09-03.
  "edges":[ {"p":"prot_0072","u":"utr5_0079","sc":0.517,"npmi":0.41,"co":34,
             "cl":12,"conc":0.19,"znf":0.0,"x":false,"cons":true} ],  // x = cross-module
  "meta":{"matrix":[[0,178,...],[66,...]],           // 6x6 protein-module x utr-module counts
          "matrix_axes":{...},"counts":{...},"degree":{...},"layout":{...},"colors":{...},
          "caveat":"...","name_tiers":{...},"empty_states":{...},
          "outside_module_nodes":[...6...],"sort_keys_forbidden":["npmi_raw"],"built":"...",
          "modules":[{"id":1,"n_protein":39,"n_utr":67,"n_edges":774,"mean_score":0.3633,
                      "genes":3388,"terms":["DNA-binding transcription activator activity",...],
                      "color":"#E69F00","label":"Transcriptional / developmental regulation"}]}
}
```
Layout is frozen at bake with a fixed seed (`08_network.py`) and **must not be recomputed in
the browser**: `x`/`y` are a seed=7 spring layout of the 513-node giant component in a 0-1000
box; the 3 isolated dyads (the 6 module-less clusters) are PLACED at y=978, not simulated.
`meta.layout.note` carries the provenance line verbatim — distance and direction carry no meaning.
`meta.matrix` is `matrix[protein_module-1][utr_module-1]`, DIRECTIONAL and ASYMMETRIC
(M[0][1]=178 vs M[1][0]=66), and EXCLUDES the 3 edges whose endpoints sit outside every
module, so it totals 2,617 not 2,620.
Node `cons` strings are ALREADY in the RNA alphabet — do NOT apply the T->U display map to
them (the cluster shard's `consensus[].text` and `consensus_pairs` ARE DNA and DO need it).
The gated graph is ONE giant component of 513 nodes plus 3 dyads; 28.9% of edges cross a
module boundary. Do not draw six isolated panels.

## `modules/<N>.json`   (09_modules.py) — 6 files
Module detail: full GO term list, member clusters, top carrier genes, the caveat text.
Shape: `{id,label,short,color,caveat,term_caveat,counts{},leading_terms[],terms[],
clusters{protein[],utr[]},genes[],edges[],cross{out,in},empty_states{},sort_keys_forbidden}`.
A term's `tr` flag marks the trusted subset (q<0.05 & fold>=2 & n_fam_support>=5) — ship the
trusted filter as a toggle, defaulting to trusted. `genes[]` is capped at 400 and `edges[]`
at 60, both with their denominator in `counts.*_shipped`.
**There is no `modules/0.json`.** The 6 module-less clusters (prot_0058/0108/0291,
utr3_0139/0355, utr5_0013) are reachable only via `meta.outside_module_nodes` and their
own cluster shards; a module route must not invent an "M0".

## `cluster_index.json`   (11_cluster_index.py) — 0.379 MB, one file
A 900-row derived index (every cluster, including the 381 absent from `network.json`) so the
browse view can rank and filter all 900 without fetching 900 shards. Derived FROM the written
cluster shards, so it can never disagree with them; re-run `11_` whenever a shard changes.
`{meta{ghost,size_buckets,gate,gate_check,counts}, rows[{id,r,m,ni,ntx,ng,qi,qt,qg,lmed,
logo,ev,lw,nterms,tsrc,tdisp,tfold,npass,nptot,nsug,best,bestsc,name,tier,nsrc,cons,cov,
ncons,smed,emed,pmed,sb}]}`. Mirrored byte-for-byte as `portal/js/cluster-index.js` only
because `data.js` is the sole fetcher and has no getter for it yet.

## The gate (four thresholds, so every panel prints the same numbers)
`co_count >= 10` · `n_indep_clades >= 8` · `clade_concentration < 0.35` · `npmi_mip_APC > 0.10`.
`frac_co_ZNF <= 0.40` is diagnostic, not binding. 2,620 of 166,615 co-occurring pairs pass.

---

## Module colours (Okabe–Ito, from the manuscript's own style library)
M1 `#E69F00` · M2 `#56B4E9` · M3 `#009E73` · M4 `#F0E442` · M5 `#0072B2` · M6 `#D55E00`
unassigned `#9AA5B1`. Region: RNA `#0072B2`, protein `#D55E00`.

## Non-negotiable invariants
1. `seq[s:e+1] == motif_string` for **889,215/889,215** rows — asserted in `00_validate.py`, fails the build.
2. Join on `refseq_id_without_ver` after `drop_duplicates` — never `RefSeq mRNA ID` (drops 1,617 genes).
3. Motifs never overlap within (transcript, region) — single lane, but every span gets its own border
   (9,838 same-cluster abutting pairs would otherwise fuse).
4. Never `str.split(',')` on annotation strings — 41.3% of InterPro rows damaged. Re-join accessions.
5. `npmi_raw` is never offered as a sort key outside the paralogy page.
6. NTScore domain is `[-8, 0]`, encode `q = clip(round(255*(v+8)/8), 0, 255)`, decode
   `v = -8 + q*8/255`. The true global min IS computed at bake over all 32,745,544 positions
   and it is **-8.2500**, which is OUTSIDE the domain. This is a KNOWN, MEASURED, ACCEPTED
   failure, not an oversight: exactly **4 positions (0.0000122%)** clamp to the darkest bin
   (utr5 NM_001273@101 -8.2500, NM_004703@68 -8.1875, NM_015080@466 -8.1875;
   utr3 NM_001292043@179 -8.0625). The build does not silently pass — it counts the clamped
   cells, records `true_global_min` and `positions_clamped` in `manifest.json.nt`, and ships
   `assertions_passed: 10` of 11 so the About page can state the failure in prose.
   Widening the domain was rejected: it would rewrite all 18,093 shards and the browser
   decoder for a 0.0000122% gain. Re-verified independently 2026-09-03.
7. Every payload above is a SUPERSET of what earlier revisions of this file sketched. Nothing
   has been removed or renamed, so a reader built against an older sketch still works.
