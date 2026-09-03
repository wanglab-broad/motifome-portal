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
  "assertions_passed": 11 }
```

## `search.json`   (10_manifest.py)  — one array, loaded once (~0.4 MB)
```json
[ ["ACTB","NM_001101",6,20], ... ]      // [symbol, refseq, primary_module|0, n_motifs]
```
Aliases (ENSG/ENST) live in `search_alias.json`: `{"ENSG00000075624":"NM_001101", ...}`

## `gene/<REFSEQ>.json`   (06_gene_shards.py)  — mean 3.3 KB, max ~16 KB
```json
{
  "refseq":"NM_001101", "symbol":"ACTB", "ensg":["ENSG00000075624"], "enst":["ENST00000331789"],
  "len": {"utr5":84,"cds":1128,"utr3":600,"protein":375,"mrna":1812},
  "seq": {"utr5":"...","cds":"...","utr3":"...","protein":"..."},   // DNA alphabet; display maps T->U for UTRs only
  "motifs":[
    {"i":0,"r":"utr5","s":5,"e":15,"c":"utr5_0004","m":6,"sc":-1.26,"en":1.02,"pl":null,
     "ms":5,"me":15,                                  // mRNA-axis span (protein projected)
     "a":{"rbp":{"eCLIP":["PUM1"]},"mir":[],"ipr":[],"upr":[],"elm":[],"mob":[],"idpo":[],"sig":null}}
  ],
  "coupling":[ {"p":3,"u":0,"sc":1.7694,"co":175,"cl":23,"znf":0.0} ],  // indices into motifs[]
  "nt": {"utr5":"<base64 uint8, len == len(utr5)>", "utr3":"<base64 uint8>"},
  "modules":[6,1]
}
```
- `r` ∈ `utr5|utr3|protein`; `m` = module id or 0 for unassigned; `pl` = pLDDT **0–1**, protein only.
- `ms`/`me`: for UTR motifs, the region span offset into mRNA coords; for protein,
  `ms = len(utr5) + 3*s`, `me = len(utr5) + 3*e + 2`.
- `nt`: NTScore quantized `round(255 * (v - (-8)) / 8)` clamped 0–255. Absent key = no track.
  **There is no CDS or protein track.** The viewer draws a hatched "not computed" band.
- `a` keys are omitted when empty. MobiDB/IDPO/SignalP/InterPro/UniProt/ELM appear on
  **protein rows only**; rbp/mir on **UTR rows only** (masked at bake — 212,449 spurious rows).

## `cluster/<CLUSTER_ID>.json`   (07_cluster_shards.py) — 900 files
```json
{
  "id":"utr3_0215","region":"utr3","module":4,
  "name":{"text":"UCUCC, pyrimidine-rich 5-mer","tier":3,"source":"derived"},
  "size":{"instances":566,"transcripts":540,"genes":206,"lengths":{"5":188,"6":90}},
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
  "genes":["ACTB", ...]                 // carrier symbols, capped at 500 + count
}
```
`logo` is `null` for the ~444 clusters with no STREME motif at `test_pvalue < 0.05`.
`partners` includes non-passing ones; the UI filters. `pass` = phylo-independence gate.

## `network.json`   (08_network.py) — ~1.6 MB total, one file
```json
{
  "nodes":[ {"id":"prot_0072","r":"protein","m":5,"deg":17,"n":189,
             "x":412.3,"y":88.1,                     // frozen build-time layout, seed=7
             "cons":"RGRGGG","cov":0.39,"pos":[...20 bins...],
             "name":"RNA-binding sf","tier":1} ],
  "edges":[ {"p":"prot_0072","u":"utr5_0079","sc":0.517,"npmi":0.41,"co":34,
             "cl":12,"conc":0.19,"znf":0.0,"x":false,"cons":true} ],  // x = cross-module
  "meta":{"matrix":[[0,178,...],[66,...]],           // 6x6 protein-module x utr-module counts
          "modules":[{"id":1,"n_protein":39,"n_utr":67,"n_edges":774,"mean_score":0.3633,
                      "genes":3388,"terms":["DNA-binding transcription activator activity",...],
                      "color":"#E69F00","label":"Transcriptional / developmental regulation"}]}
}
```
Layout is frozen at bake with a fixed seed. `07_` writes a provenance note: distance carries no meaning.

## `modules/<N>.json`   (09_modules.py) — 6 files
Module detail: full GO term list, member clusters, top carrier genes, the caveat text.

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
6. NTScore domain is `[-8, 0]`. Compute the true global min at bake; fail if outside.
