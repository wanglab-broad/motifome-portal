/* =============================================================================
   view-about.js — the page that keeps the portal honest.

   Everything a reader needs in order to distrust this atlas correctly: how the
   numbers were made, how much of each annotation database actually reaches a
   motif, where the evidence stops, what the manuscript says against itself,
   what the words mean, and how to cite and archive the thing.

   Live wherever a payload carries the number. Where a number was measured at
   bake and never published into portal/data/, it is in BAKE_COVERAGE below,
   labelled as such, and its percentage is still computed at render time from
   the live denominator so the two can never drift apart silently.

   API:  render(container, params)   teardown()
   ============================================================================= */

import * as router from './router.js';
import * as data from './data.js';
import {
  el, mount, fmt, card, csvButton, copyLinkButton, setTitle,
  regionBadge, CAVEAT_TEXT, DENOMINATORS
} from './ui.js';

/* -----------------------------------------------------------------------------
   Bake-time measurements that manifest.json does not (yet) publish.

   Numerators: 06_gene_shards.py, _cache/gene_shard_meta.json ->
   annotation_keys_by_kind, re-verified here by re-reading all 18,093 shipped
   gene shards and counting the non-empty keys in every motif's `a` object.
   Every figure below reproduced exactly, and the region masking held: `mir`
   appears on 3'UTR rows only, `rbp` on UTR rows only, the six protein layers on
   protein rows only, zero exceptions in 889,215 motifs.

   Denominators are read live from manifest.regions; the fallbacks here are the
   measured region census and are only used if the manifest is missing.

   If a future bake publishes manifest.annotations = {kind: n}, that wins.
   -------------------------------------------------------------------------- */
const BAKE_COVERAGE = {
  any:  568101,
  rbp:  325996,
  upr:  229532,
  mob:  221909,
  ipr:  172421,
  mir:   24228,
  idpo:   1908,
  elm:     797,
  sig:     298
};
const REGION_FALLBACK = { utr5: 118997, utr3: 515752, protein: 254466 };

const DBS = [
  { k: 'rbp',  name: 'RBP binding sites',      src: 'eCLIP · PAR-CLIP · iCLIP-Piranha · iCLIP-CIMS',
    scope: 'utr',     scopeLabel: 'UTR motifs',
    note: 'Four assays, kept separate in the payload. A motif counts as covered if any assay hits it.' },
  { k: 'mir',  name: 'miRNA target sites',     src: 'miRNA target predictions',
    scope: 'utr3',    scopeLabel: "3′UTR motifs",
    note: 'Masked to 3′UTR rows. A 5′UTR motif is never annotated with a miRNA site.' },
  { k: 'ipr',  name: 'InterPro domains',       src: 'InterPro',
    scope: 'protein', scopeLabel: 'protein motifs',
    note: 'Re-joined through accessions, never split on commas: 8,228 of 17,814 InterPro entry ' +
          'names contain a comma of their own ("Zinc finger, C2H2 type").' },
  { k: 'upr',  name: 'UniProt features',       src: 'UniProt',
    scope: 'protein', scopeLabel: 'protein motifs',
    note: 'Free text, shipped as one opaque display string. Splitting it damages 6.9% of rows.' },
  { k: 'mob',  name: 'Disorder (MobiDB)',      src: 'MobiDB',
    scope: 'protein', scopeLabel: 'protein motifs',
    note: 'The densest protein layer, and the reason so many protein clusters are named after ' +
          'disorder rather than a domain.' },
  { k: 'idpo', name: 'Disorder ontology',      src: 'IDPO',
    scope: 'protein', scopeLabel: 'protein motifs',
    note: 'Curated, and therefore rare. Present on fewer than one protein motif in a hundred.' },
  { k: 'elm',  name: 'Linear motifs',          src: 'ELM',
    scope: 'protein', scopeLabel: 'protein motifs',
    note: 'The rarest layer in the atlas. An ELM hit is informative precisely because it is unusual.' },
  { k: 'sig',  name: 'Signal peptides',        src: 'SignalP',
    scope: 'protein', scopeLabel: 'protein motifs',
    note: 'A signal peptide occupies the N-terminus only, so almost no motif overlaps one.' }
];

/* -------------------------------------------------------------------------- */

const STYLE_ID = 'mirto-about-css';

export function teardown() { /* no listeners, no timers, nothing to release */ }

export async function render(host, params) {
  setTitle('About, methods & caveats');
  injectStyle();

  const wrap = el('div.wrap-narrow.view-pad.ab');
  mount(host, wrap);

  const manifest = await data.getManifest();
  const c = (manifest && manifest.counts) || {};
  const es = (manifest && manifest.empty_states) || {};
  const cov = (manifest && manifest.coverage) || {};
  const regions = (manifest && manifest.regions) || REGION_FALLBACK;

  wrap.appendChild(header(manifest, c));
  wrap.appendChild(toc());
  wrap.appendChild(pipeline(manifest, c, es, cov));
  wrap.appendChild(coverageSection(manifest, regions));
  wrap.appendChild(gapsSection(manifest, es, cov, c));
  wrap.appendChild(caveatSection(manifest));
  wrap.appendChild(glossary());
  wrap.appendChild(citeSection(manifest, c));
  wrap.appendChild(provenance(manifest));

  return wrap;
}

/* =============================================================================
   header
   ============================================================================= */

function header(manifest, c) {
  return el('header.ab-head', [
    el('p.eyebrow.mono', 'colophon · methods · caveats'),
    el('h1.ab-h1', 'How to distrust this atlas correctly'),
    el('p.lede',
      'This is a static companion to the MIRTO manuscript. Every payload is a JSON file baked once ' +
      'from the analysis tables and read straight off disk; nothing is recomputed in the browser ' +
      'that was not first checked against the source. The page you are reading exists because a ' +
      'figure that shows only what worked is a figure that misleads — so here is the pipeline, the ' +
      'coverage of every annotation database with its denominator, and a register of everywhere ' +
      'the evidence runs out.'),
    manifest ? null : el('div.banner.warn', [
      el('strong', 'manifest.json did not load. '),
      'The figures below fall back to the published values measured at bake. Serve portal/ over ' +
      'HTTP and re-run the bake to see the live numbers.'
    ])
  ]);
}

function toc() {
  const items = [
    ['#ab-pipeline', 'How the data was made'],
    ['#ab-coverage', 'Annotation coverage'],
    ['#ab-gaps', 'Known gaps'],
    ['#ab-caveats', 'Caveats'],
    ['#ab-glossary', 'Glossary'],
    ['#ab-cite', 'Citing & archiving']
  ];
  /* Buttons, not anchors: the router owns location.hash, so a bare in-page
     "#ab-gaps" href would be parsed as a route and 404 if it were ever opened
     in a new tab or followed without JS. */
  return el('nav.ab-toc', { 'aria-label': 'On this page' },
    items.map(i => el('button', {
      type: 'button',
      on: { click: () => {
        const t = document.getElementById(i[0].slice(1));
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } }
    }, i[1])));
}

/* =============================================================================
   1. how the data was made
   ============================================================================= */

function pipeline(manifest, c, es, cov) {
  const nProt = es.prot_clusters_total || 300;
  const nUtr = es.utr_clusters_total || 600;
  const nt = (manifest && manifest.nt) || {};

  const steps = [
    { n: 'Model',
      t: 'A protein-conditioned masked-diffusion model of full-length mRNA',
      b: 'MIRTO reads 5′UTR, CDS and 3′UTR together while conditioned on the protein the transcript ' +
         'encodes. The atlas ships the model’s downstream products — motif instances, their scores ' +
         'and their likelihood tracks — not the model, its weights or its raw attention maps.' },
    { n: 'Readout 1',
      t: 'Δ-attention',
      b: 'The manuscript localises motifs partly from how attention shifts when the conditioning ' +
         'changes: a position matters when the other modality is what makes the model look at it. ' +
         'The attention tensors are not part of this snapshot; what reaches you is the motif spans ' +
         'they produced, each with its motif score and entropy.' },
    { n: 'Readout 2',
      t: 'NTScore — per-nucleotide likelihood',
      b: 'A log-likelihood per nucleotide, always negative, over the domain ' +
         '[' + ((nt.domain || [-8, 0]).join(', ')) + ']. It exists for the 5′UTR and 3′UTR only. ' +
         (nt.positions_scanned
           ? fmt.int(nt.positions_scanned) + ' positions were scored and quantised to one byte each. '
           : '') +
         'There is no CDS or protein track anywhere in the source data, so the gene view draws a ' +
         'hatched “not computed” band across the coding region rather than interpolating one.' },
    { n: 'Instances',
      t: fmt.int(c.motifs || 889215) + ' motif instances',
      b: 'Each instance is a span in one region of one transcript, stored 0-based and inclusive at ' +
         'both ends. seq.slice(start, end + 1) reproduces the stored motif string for every one of ' +
         'the ' + fmt.int(c.motifs || 889215) + ' rows — the build asserts it and fails if it does ' +
         'not. Spans never overlap within a transcript region, but 53,729 pairs abut exactly, ' +
         'which is why every span in the gene view carries its own border.' },
    { n: 'Clusters',
      t: fmt.int(c.clusters || 900) + ' clusters, by embedding — not by sequence',
      b: 'Instances were embedded and k-means’d into ' + fmt.int(nProt) + ' protein clusters and ' +
         fmt.int(nUtr) + ' UTR clusters (500 in the 3′UTR, 100 in the 5′UTR). This one decision ' +
         'explains most of the empty states in the atlas: members of a protein cluster share an ' +
         'embedding neighbourhood, not a string — 99.5% of the member strings in a protein cluster ' +
         'are distinct — so a sequence logo is not guaranteed to exist.' },
    { n: 'Association',
      t: 'NPMI, then an APC background correction',
      b: 'Every protein cluster was scored against every UTR cluster for co-occurrence across ' +
         'genes: ' + fmt.int(nProt * nUtr) + ' candidate pairs. Normalised pointwise mutual ' +
         'information measures the association; the average product correction subtracts what is ' +
         'explained by each cluster’s general promiscuity, so a cluster that co-occurs with ' +
         'everything stops looking specific.' },
    { n: 'The gate',
      t: 'Phylogenetic independence — four conditions',
      b: fmt.int(c.edges || 2620) + ' pairs survive. The gate asks whether an association still ' +
         'stands once no single paralogous clade can carry it: enough independent gene families ' +
         'must support the pair, and the support must not concentrate in one clade. Paralog ' +
         'expansions — zinc fingers, olfactory receptors, protocadherins — are exactly what it ' +
         'removes, and removing them is the point of the analysis.' },
    { n: 'Modules',
      t: (c.modules || 6) + ' bipartite modules over the gated graph',
      b: 'Community detection over the surviving edges yields six modules covering ' +
         fmt.of(cov.clusters_with_module || 513, es.clusters_total || 900) + ' clusters. The gated ' +
         'graph is one connected component of 513 nodes, not six islands: ' +
         fmt.int(c.cross_module_edges || 757) + ' edges (28.9%) cross a module boundary. Module ' +
         'names come from GO terms enriched in the carrier genes, so a module name describes ' +
         'the genes that carry the motifs, not the motifs themselves.' }
  ];

  const list = el('ol.pipe');
  for (const s of steps) {
    list.appendChild(el('li.pipe-step', [
      el('span.pipe-n.mono', s.n),
      el('div.pipe-body', [el('h3', s.t), el('p', s.b)])
    ]));
  }

  return el('section.ab-sec#ab-pipeline', [
    el('h2', 'How the data was made'),
    el('p.ab-lede', 'Eight steps, each of which discards something. The counts below are read from ' +
      'the manifest baked alongside the payloads.'),
    list
  ]);
}

/* =============================================================================
   2. annotation coverage, with denominators
   ============================================================================= */

function coverageRows(manifest, regions) {
  const live = (manifest && manifest.annotations) || null;   // future bake wins
  const nProt = regions.protein || REGION_FALLBACK.protein;
  const nUtr3 = regions.utr3 || REGION_FALLBACK.utr3;
  const nUtr5 = regions.utr5 || REGION_FALLBACK.utr5;
  const denomFor = scope => scope === 'utr' ? nUtr3 + nUtr5
                          : scope === 'utr3' ? nUtr3 : nProt;

  const rows = DBS.map(db => {
    const k = (live && live[db.k] != null) ? live[db.k] : BAKE_COVERAGE[db.k];
    const n = denomFor(db.scope);
    return { key: db.k, name: db.name, source: db.src, scope: db.scope,
             scopeLabel: db.scopeLabel, covered: k, of: n, pct: n ? 100 * k / n : 0,
             note: db.note };
  });

  const total = nProt + nUtr3 + nUtr5;
  const anyK = (live && live.any != null) ? live.any : BAKE_COVERAGE.any;
  rows.push({ key: 'any', name: 'Any annotation at all', source: 'union of all eight layers',
              scope: 'all', scopeLabel: 'all motifs', covered: anyK, of: total,
              pct: total ? 100 * anyK / total : 0,
              note: 'The remaining ' + fmt.int(total - anyK) + ' motifs carry no annotation from ' +
                    'any database. They are not errors — they are the part of the model’s output ' +
                    'that existing catalogues have nothing to say about.' });
  return rows;
}

function coverageSection(manifest, regions) {
  const rows = coverageRows(manifest, regions);

  const body = el('div.table-scroll', el('table.data.cov-table', [
    el('thead', el('tr', [
      el('th', 'Database'),
      el('th', 'Applies to'),
      el('th.num', 'Motifs covered'),
      el('th.num', 'Of'),
      el('th', 'Coverage'),
      el('th.num', '%')
    ])),
    el('tbody', rows.map(r => el('tr' + (r.key === 'any' ? '.cov-any' : ''), [
      el('td', [el('span.cov-name', r.name), el('span.cov-src.dim', r.source)]),
      el('td', [
        r.scope === 'protein' ? regionBadge('protein')
          : r.scope === 'utr3' ? regionBadge('utr3')
          : r.scope === 'utr' ? el('span.cov-badges', [regionBadge('utr5'), regionBadge('utr3')])
          : null,
        el('span.cov-scope.dim', r.scopeLabel)
      ]),
      el('td.num.mono', fmt.int(r.covered)),
      el('td.num.mono.dim', fmt.int(r.of)),
      el('td.cov-barcell', el('div.cov-track', el('div.cov-bar', {
        title: fmt.of(r.covered, r.of) + ' ' + r.scopeLabel,
        style: {
          width: Math.max(r.pct, 0.4) + '%',
          background: r.scope === 'protein' ? 'var(--protein)'
                    : r.scope === 'all' ? 'var(--ink-3)' : 'var(--rna)'
        }
      }))),
      el('td.num.mono', r.pct < 1 ? r.pct.toFixed(2) + '%' : r.pct.toFixed(1) + '%')
    ])))
  ]));

  const notes = el('dl.cov-notes', []);
  for (const r of rows) {
    notes.appendChild(el('dt', r.name));
    notes.appendChild(el('dd', r.note));
  }

  const tools = [
    csvButton('mirto-annotation-coverage.csv', () => coverageRows(manifest, regions),
      [{ key: 'name', label: 'database' }, { key: 'source', label: 'source' },
       { key: 'scopeLabel', label: 'applies_to' }, { key: 'covered', label: 'motifs_covered' },
       { key: 'of', label: 'denominator' }, { key: 'pct', label: 'percent' }], 'CSV')
  ];

  return el('section.ab-sec#ab-coverage', [
    el('h2', 'Annotation coverage, with denominators'),
    el('p.ab-lede', [
      'A motif with no InterPro domain is not a motif in a protein with no domains — it is a motif ' +
      'that InterPro has nothing to say about. Coverage differs by more than two orders of ' +
      'magnitude between layers, so every annotation panel in this atlas prints the denominator ' +
      'next to the hit. Each layer is masked to its own modality at bake: ',
      el('strong', 'a re-audit of all ' + fmt.int(rows[rows.length - 1].of) +
        ' shipped motifs finds zero cross-layer leakage'),
      ' — no miRNA site on a 5′UTR motif, no RBP site on a protein motif, no MobiDB entry on a UTR ' +
      'motif.'
    ]),
    card(el('h3', 'Coverage by database'), tools, body),
    el('div.ab-sub', [el('h3', 'What each layer is, and why it is as sparse as it is'), notes])
  ]);
}

/* =============================================================================
   3. known gaps
   ============================================================================= */

function gapsSection(manifest, es, cov, c) {
  const nt = (manifest && manifest.nt) || {};
  const D = DENOMINATORS;
  const g = (k, fb) => (es[k] != null ? es[k] : fb);

  const gaps = [
    { k: g('clusters_no_logo', D.noLogo.k), n: g('clusters_total', 900), u: 'clusters',
      t: 'have no sequence logo',
      why: 'Clusters were built in embedding space, not sequence space. A logo is shown only where ' +
           'STREME found a motif at test p < 0.05; 43 clusters would otherwise inherit a logo from ' +
           'a motif STREME itself scored p = 1.0. There is no honest fallback: a naive ' +
           'position-weight matrix over the member strings disagrees with STREME on 77% of clusters ' +
           'and manufactures poly-S, poly-P and poly-V artifacts. Those pages show a designed empty ' +
           'state instead of a fabricated logo.' },
    { k: g('clusters_no_term', D.noTerm.k), n: g('clusters_total', 900), u: 'clusters',
      t: 'have no significantly enriched term',
      why: 'Enrichment is tested within the cluster at FDR < 0.05 against informative terms only. ' +
           'A cluster with no surviving term keeps its consensus-derived name, and the page marks ' +
           'that name as tier 2 or tier 3 rather than passing it off as an annotation.' },
    { k: g('clusters_no_module', D.noModule.k), n: g('clusters_total', 900), u: 'clusters',
      t: 'belong to no module',
      why: 'A cluster joins a module only through gated edges. ' +
           fmt.int((cov.clusters_in_network || 519)) + ' clusters carry at least one gated ' +
           'association and ' + fmt.int(cov.clusters_with_module || 513) + ' of those fall inside a ' +
           'module; the remainder are perfectly real clusters whose associations did not survive.' },
    { k: g('utr_clusters_no_gated_partner', D.utrNoPartner.k), n: g('utr_clusters_total', 600),
      u: 'UTR clusters', t: 'have no phylogeny-independent partner',
      why: 'Nearly half the UTR clusters end the pipeline with an empty partner panel. The panel ' +
           'prints how many of the ' + fmt.int(g('prot_clusters_total', 300)) + ' protein clusters ' +
           'were tested against it, so “none passed” is legible as a result rather than as a bug.' },
    { k: g('prot_clusters_no_gated_partner', D.protNoPartner.k), n: g('prot_clusters_total', 300),
      u: 'protein clusters', t: 'have no phylogeny-independent partner', why: null },
    { k: g('edges_cluster_level_only', D.edgeNoPair.k), n: g('edges_total', c.edges || 2620),
      u: 'gated edges', t: 'are cluster-level only',
      why: 'The association passed the gate, but no specific consensus string on one side pairs ' +
           'with a specific consensus string on the other at that level of evidence. The edge panel ' +
           'says so instead of showing the cluster consensus as if it were a matched pair.' },
    { k: g('transcripts_no_module', D.noModuleGene.k), n: g('transcripts_total', c.transcripts || 18093),
      u: 'transcripts', t: 'touch no module at all', why: null }
  ];

  const list = el('div.gap-list');
  for (const x of gaps) {
    list.appendChild(el('div.gap', [
      el('div.gap-fig', [
        el('span.gap-k.mono', fmt.int(x.k)),
        el('span.gap-n.mono.dim', 'of ' + fmt.int(x.n))
      ]),
      el('div.gap-body', [
        el('h4', [el('span.gap-u', x.u + ' '), x.t]),
        x.why ? el('p', x.why) : null
      ])
    ]));
  }

  /* the two gaps that are not a count of clusters */
  const ntGaps = el('div.gap-list', [
    el('div.gap', [
      el('div.gap-fig', [el('span.gap-k.mono', '0'), el('span.gap-n.mono.dim', 'positions')]),
      el('div.gap-body', [
        el('h4', 'There is no NTScore for the CDS or the protein'),
        el('p', 'The likelihood track exists for the 5′UTR and 3′UTR only. Nothing in the source ' +
          'data scores a coding nucleotide or a residue, so the gene view draws a hatched band ' +
          'across the coding region. No value there is interpolated, smoothed or borrowed from a ' +
          'neighbouring region.')
      ])
    ]),
    el('div.gap', [
      el('div.gap-fig', [
        el('span.gap-k.mono', fmt.int(nt.positions_clamped != null ? nt.positions_clamped : 4)),
        el('span.gap-n.mono.dim', 'of ' + fmt.int(nt.positions_scanned || 32745544))
      ]),
      el('div.gap-body', [
        el('h4', 'NTScore positions that fall outside the quantisation domain'),
        el('p', [
          'The published domain is ',
          el('span.mono', '[' + ((nt.domain || (manifest && manifest.nt_domain) || [-8, 0]).join(', ')) + ']'),
          ', but the true measured minimum across all ',
          fmt.int(nt.positions_scanned || 32745544), ' scored positions is ',
          el('span.mono', String(nt.true_global_min != null ? nt.true_global_min : -8.25)),
          '. Four nucleotides therefore clamp to the darkest bin instead of rendering very ' +
          'slightly darker. The build records this as a failed assertion — ',
          el('span.mono', (manifest && manifest.assertions_passed != null ? manifest.assertions_passed : 10) +
            ' of ' + (manifest && manifest.assertions_total != null ? manifest.assertions_total : 11)),
          ' passed — rather than weakening the assertion to make the number look clean.'
        ])
      ])
    ])
  ]);

  return el('section.ab-sec#ab-gaps', [
    el('h2', 'Known gaps'),
    el('p.ab-lede', 'Every figure here is also printed inside the empty state it explains, so a ' +
      'missing panel always tells you how common it is to be missing. None of these is a bug ' +
      'report; each is a result.'),
    list,
    el('h3.gap-sub', 'And two that are not about clusters'),
    ntGaps
  ]);
}

/* =============================================================================
   4. caveats
   ============================================================================= */

function caveatSection(manifest) {
  const forbidden = (manifest && manifest.sort_keys_forbidden) || ['npmi_raw'];

  const items = [
    { t: 'Statistical co-occurrence is not physical interaction',
      lead: CAVEAT_TEXT.lead,
      b: CAVEAT_TEXT.detail + ' A protein motif cluster and a UTR motif cluster joined by an edge ' +
         'appear in the same genes more often than the corrected background allows. That is a ' +
         'hypothesis about regulation worth testing at the bench. It is not evidence that the ' +
         'peptide binds the transcript, that the two are ever present at the same time, or that ' +
         'either is functional. The caveat strip over every partner and edge panel in this atlas ' +
         'renders no dismiss control — it cannot be turned off, by design.' },
    { t: 'Paralog expansion is why the gate exists',
      lead: 'Raw NPMI is a leaderboard of gene-family size.',
      b: 'Human paralog families — zinc fingers, olfactory receptors, protocadherins — expand to ' +
         'hundreds of near-identical members. Any two motif clusters that both happen to sit in the ' +
         'ZNF clade will co-occur spectacularly, and uncorrected NPMI will rank them at the top. By ' +
         'the authors’ own verdict column, 25 of the top 30 raw associations are ZNF clade ' +
         'artifacts. The phylogenetic-independence gate exists to delete exactly that leaderboard, ' +
         'which is why sorting by it anywhere in this site would hand it straight back.' },
    { t: 'Raw NPMI is not offered as a sort key',
      lead: forbidden.map(k => k).join(', ') + ' appears in no payload this site loads.',
      b: 'It was stripped at bake rather than merely hidden in the UI: the cluster shards, the ' +
         'network payload and the module payloads each carry a machine-readable ' +
         'sort_keys_forbidden list and were asserted to contain zero occurrences of the column ' +
         'itself. A reader cannot reach the artifact leaderboard through this atlas by accident, ' +
         'and nor can a future view written against these payloads.' },
    { t: 'Network geometry carries no meaning',
      lead: 'Distance and direction in the network view are not measurements.',
      b: 'The layout is a spring embedding computed once at bake with a fixed seed and frozen into ' +
         'the payload, so that every reader sees the same picture and no one sees a different graph ' +
         'on a re-render. Two nodes drawn close together are not more strongly associated than two ' +
         'drawn apart; the edge is the evidence, and its four gate values are printed when you ' +
         'click it.' },
    { t: 'Module names describe the carrier genes, not the motifs',
      lead: 'A module called “RNA processing & splicing” is a statement about its genes.',
      b: 'GO enrichment was computed over the genes that carry a module’s motifs, not over the ' +
         'motifs. The name is a compression of the leading enriched terms in that gene set. It does ' +
         'not assert that the motifs themselves are splicing elements.' },
    { t: 'Displayed alphabets, and one column that lies',
      lead: 'UTR sequence is stored as DNA and displayed as RNA; protein is never mapped.',
      b: 'The T→U mapping is applied to 5′UTR and 3′UTR only. In a protein sequence U is ' +
         'selenocysteine and mapping it would be a factual error. Separately: the source table’s ' +
         'transcript_length column is shorter than 5′UTR + CDS + 3′UTR in every one of its 19,210 ' +
         'rows, so it was never carried into the payloads. Lengths shown here are the true sum — ' +
         'median 2,923 nt, 99th percentile 8,736 nt, longest 11,426 nt.' }
  ];

  return el('section.ab-sec#ab-caveats', [
    el('h2', 'Caveats the manuscript states about itself'),
    el('div.cav-list', items.map(x => el('div.cav', [
      el('h3', x.t),
      el('p.cav-lead', x.lead),
      el('p.cav-body', x.b)
    ])))
  ]);
}

/* =============================================================================
   5. glossary
   ============================================================================= */

function glossary() {
  const terms = [
    ['NTScore',
     'The model’s per-nucleotide log-likelihood: how unsurprised MIRTO is by the base it finds at ' +
     'a position, given everything else. Always negative, over the domain [−8, 0]; near 0 means ' +
     '“confidently predicted”, near −8 means “the model did not expect this”. Computed for the ' +
     '5′UTR and 3′UTR only. Shipped quantised to one byte per nucleotide, worst-case display error ' +
     '0.0157.'],
    ['SeqScore',
     'The manuscript’s sequence-level score for a motif. No column of that name exists in the ' +
     'baked tables: what this atlas ships per motif is motif_score (shown as “score”) together with ' +
     'motif_entropy. If the manuscript’s SeqScore is that column under another name they are the ' +
     'same number — the atlas does not assume it, and labels what it actually has.'],
    ['Δ-attention (delta-attention)',
     'The change in the model’s attention attributable to its conditioning, used in the manuscript ' +
     'to localise positions that matter because of the other modality rather than in isolation. The ' +
     'attention tensors are not in this snapshot; the motif spans derived from them are.'],
    ['Motif instance',
     'One occurrence: a single span in one region of one transcript, with its own start, end, ' +
     'score, entropy and annotations. There are 889,215. Coordinates are 0-based and inclusive at ' +
     'both ends, so the substring is seq.slice(start, end + 1).'],
    ['Motif cluster',
     'A group of instances that sit close together in embedding space — a k-means cluster, not a ' +
     'sequence family. Ids are prot_NNNN, utr3_NNNN and utr5_NNNN. Two instances in the same ' +
     'cluster usually have different strings; that is the intended behaviour, and the reason 444 ' +
     'clusters have no logo.'],
    ['Consensus',
     'A representative string for a cluster, with the fraction of the cluster’s carriers it covers. ' +
     'A cluster may have several, or none. A consensus is a description of the cluster, not a ' +
     'regular expression that its members match.'],
    ['NPMI',
     'Normalised pointwise mutual information between two clusters over genes: how much more often ' +
     'they occur together than independent occurrence would predict, scaled to [−1, 1] so that ' +
     'clusters of very different sizes are comparable.'],
    ['APC',
     'Average product correction. Each cluster has a general tendency to co-occur with everything; ' +
     'APC estimates that tendency from the row and column means and subtracts it, so a promiscuous ' +
     'cluster stops looking specifically associated with each of its many partners.'],
    ['Phylogenetic-independence filter',
     'The four-condition gate applied after NPMI + APC. It requires the pair to be supported by ' +
     'enough independent gene families and forbids the support from concentrating in a single ' +
     'paralogous clade. 2,620 of 180,000 candidate pairs pass. Every edge in this atlas has passed ' +
     'it; nothing that failed is displayed as an association.'],
    ['Module',
     'A bipartite community in the gated graph: protein clusters and UTR clusters that associate ' +
     'with each other more than with the rest of the graph. There are six. They are not disjoint ' +
     'territories — 28.9% of gated edges cross a module boundary and the whole gated graph is one ' +
     'connected component.'],
    ['Carrier gene',
     'A gene carrying at least one instance of a given cluster’s motif. Cluster and module ' +
     'statistics — including all GO enrichment — are computed over carrier genes, so the ' +
     'denominator of every enrichment is a gene count, never a motif count.'],
    ['Coverage',
     'Two distinct meanings, always disambiguated on the page that uses it. For a consensus: the ' +
     'fraction of the cluster’s carriers that the string accounts for. For an annotation database: ' +
     'the fraction of the motifs it could in principle annotate that it does annotate — the table ' +
     'above.'],
    ['Trusted term',
     'An enriched GO term that clears more than significance alone: FDR q < 0.05, fold ≥ 2, and ' +
     'support from at least 5 independent gene families. Module pages default to the trusted subset ' +
     'and print both counts, because a term significant only through one expanded family is the ' +
     'same failure mode the edge gate exists to catch.']
  ];

  return el('section.ab-sec#ab-glossary', [
    el('h2', 'Glossary'),
    el('p.ab-lede', 'Thirteen words this atlas uses in a specific sense.'),
    el('dl.gloss', terms.map(t => [el('dt', t[0]), el('dd', t[1])]))
  ]);
}

/* =============================================================================
   6. citing & archiving
   ============================================================================= */

function citeSection(manifest, c) {
  const built = (manifest && manifest.built) || 'unbuilt snapshot';
  const src = (manifest && manifest.source) || 'human GRCh37, RefSeq transcripts';
  const payloads = (manifest && manifest.payloads) || {};

  const cite =
    'MIRTO Atlas — motif clusters across mRNA and protein. Static data companion to the MIRTO\n' +
    'manuscript. Snapshot ' + built + '. ' + src + '.\n' +
    fmt.int(c.motifs || 889215) + ' motif instances · ' + fmt.int(c.clusters || 900) +
    ' clusters · ' + fmt.int(c.edges || 2620) + ' gated associations · ' + (c.modules || 6) +
    ' modules.\n' +
    'Cite the manuscript itself as printed in the paper; this snapshot is the data behind its\n' +
    'figures, not a separate publication.';

  const pre = el('pre.cite-block.mono', cite);

  return el('section.ab-sec#ab-cite', [
    el('h2', 'Citing & archiving'),
    el('div.grid.grid-2', [
      card(el('h3', 'How to cite'),
        [copyLinkButton({ label: 'Copy link to this page' })],
        [
          el('p.ab-p', 'Cite the manuscript as printed in the paper — this atlas deliberately does ' +
            'not carry its own author list, journal or DOI, because inventing one would be exactly ' +
            'the kind of thing the rest of this page exists to prevent. To identify the snapshot ' +
            'your figure or claim came from, quote the build date and the counts:'),
          pre
        ]),
      card(el('h3', 'Archiving'),
        null,
        [
          el('p.ab-p', [
            'The whole site is static files: an HTML page, one stylesheet, five JavaScript modules ' +
            'and a data directory. There is no server, no database, no API, no analytics and no ' +
            'external request of any kind at runtime — no font CDN, no script host. Copy the ',
            el('span.mono', 'portal/'), ' directory and it keeps working offline, forever, as long ' +
            'as something can serve it over HTTP.'
          ]),
          el('ul.arch-list', [
            el('li', [el('span.mono', fmt.int(payloads.gene || 18093)), ' gene shards']),
            el('li', [el('span.mono', fmt.int(payloads.cluster || 900)), ' cluster payloads']),
            el('li', [el('span.mono', fmt.int(payloads.modules || 6)), ' module payloads, one network graph']),
            el('li', [el('span.mono', fmt.int(payloads.search_rows || 18093)), ' search rows and ',
                      el('span.mono', fmt.int(payloads.search_aliases || 40962)), ' Ensembl aliases'])
          ]),
          el('p.ab-p.dim', 'Every id in the URL is a deep link. A hash such as ' +
            '#/cluster/utr3_0215?tab=partners survives copy, paste and archiving unchanged.')
        ])
    ])
  ]);
}

/* =============================================================================
   7. provenance & failed payloads
   ============================================================================= */

function provenance(manifest) {
  const errs = data.dataErrors();
  const nt = (manifest && manifest.nt) || {};
  const sizes = (manifest && manifest.sizes) || {};

  const rows = [
    ['Snapshot built', (manifest && manifest.built) || 'not built'],
    ['Source', (manifest && manifest.source) || '—'],
    ['Build assertions',
     (manifest && manifest.assertions_passed != null)
       ? manifest.assertions_passed + ' of ' + (manifest.assertions_total || 11) + ' passed'
       : '—'],
    ['NTScore quantisation',
     nt.encode || 'q = clip(round(255 * (v + 8.0) / 8.0), 0, 255)'],
    ['NTScore decode', nt.decode || 'v = -8.0 + q * 8.0 / 255'],
    ['Gene payloads on disk', sizes.gene_dir_raw_bytes ? mb(sizes.gene_dir_raw_bytes) +
      ' raw · ' + mb(sizes.gene_dir_gzip_bytes) + ' gzipped' : '—'],
    ['Sort keys removed at bake',
     ((manifest && manifest.sort_keys_forbidden) || ['npmi_raw']).join(', ')]
  ];

  return el('section.ab-sec', [
    el('h2', 'Build & provenance'),
    el('div.table-scroll', el('table.data', [
      el('tbody', rows.map(r => el('tr', [
        el('td.prov-k', r[0]),
        el('td.mono', String(r[1]))
      ])))
    ])),

    errs.length
      ? el('div.ab-sub', [
          el('h3', 'Payloads that failed to load this session'),
          el('div.banner.warn', fmt.int(errs.length) + ' request(s) failed. If portal/data/ has ' +
            'not been baked, or you opened index.html from the filesystem instead of serving it, ' +
            'this is expected.'),
          el('ul.err-list.mono', errs.slice(-12).map(e =>
            el('li', e.url + ' — ' + (e.status || 'no response') + ' ' + e.message)))
        ])
      : el('div.ab-sub', el('p.ab-p.dim',
          'No payload failed to load in this session.')),

    el('div.ab-foot', [
      el('a.btn', { href: router.link('/') }, 'Back to the atlas'),
      el('a.btn.btn-ghost', { href: router.link('/network') }, 'Module network'),
      el('a.btn.btn-ghost', { href: router.link('/browse') }, 'Browse clusters')
    ])
  ]);
}

function mb(n) { return Number.isFinite(+n) ? (+n / 1048576).toFixed(1) + ' MB' : '—'; }

/* =============================================================================
   styles — scoped, injected once, tokens only
   ============================================================================= */

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.ab h2 { font-size: var(--fs-xl); line-height: var(--lh-tight); margin: 0 0 var(--s3); }
.ab h3 { font-size: var(--fs-md); margin: 0 0 var(--s2); }
.ab-head { margin-bottom: var(--s6); }
.ab-h1 { font-size: var(--fs-2xl); line-height: var(--lh-tight); max-width: 20ch; margin: var(--s3) 0 var(--s4); }
.ab-sec { margin: 0 0 var(--s8); scroll-margin-top: calc(var(--topbar-h) + var(--s4)); }
.ab-lede { color: var(--ink-2); max-width: var(--measure); margin: 0 0 var(--s5); font-size: var(--fs-sm); }
.ab-p { font-size: var(--fs-sm); margin: 0 0 var(--s3); }
.ab-sub { margin-top: var(--s6); }
.ab-foot { display: flex; gap: var(--s3); flex-wrap: wrap; margin-top: var(--s6); }

.ab-toc { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); padding: var(--s3) 0;
  margin-bottom: var(--s7); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
  font-size: var(--fs-sm); }
.ab-toc button { appearance: none; border: 0; background: none; padding: 0; cursor: pointer;
  font: inherit; color: var(--ink-2); }
.ab-toc button:hover { color: var(--accent-ink); text-decoration: underline; }
.ab-toc button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; border-radius: 2px; }

/* --- pipeline ------------------------------------------------------------ */
.pipe { list-style: none; margin: 0; padding: 0; border-left: 2px solid var(--line); }
.pipe-step { display: grid; grid-template-columns: 108px 1fr; gap: var(--s4);
  padding: 0 0 var(--s6) var(--s5); position: relative; }
.pipe-step::before { content: ''; position: absolute; left: -6px; top: 6px; width: 10px; height: 10px;
  border-radius: 50%; background: var(--surface); border: 2px solid var(--line-strong); }
.pipe-step:last-child { padding-bottom: 0; }
.pipe-n { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .09em;
  color: var(--ink-3); font-weight: 700; padding-top: 3px; }
.pipe-body h3 { color: var(--ink); }
.pipe-body p { margin: 0; font-size: var(--fs-sm); color: var(--ink-2); }

/* --- coverage ------------------------------------------------------------ */
.cov-table td { vertical-align: middle; }
.cov-name { display: block; color: var(--ink); font-weight: 560; }
.cov-src { display: block; font-size: var(--fs-xs); }
.cov-scope { font-size: var(--fs-xs); margin-left: 5px; }
.cov-badges { display: inline-flex; gap: 3px; }
.cov-barcell { width: 180px; min-width: 120px; }
.cov-track { height: 9px; background: var(--surface-2); border-radius: var(--r-full);
  overflow: hidden; }
.cov-bar { height: 100%; border-radius: var(--r-full); min-width: 2px; }
.cov-any td { border-top: 1px solid var(--line-strong); background: var(--surface-2); }
.cov-any .cov-name { font-weight: 700; }
.cov-notes { margin: 0; font-size: var(--fs-sm); }
.cov-notes dt { color: var(--ink); font-weight: 620; margin-top: var(--s3); }
.cov-notes dd { margin: 2px 0 0; color: var(--ink-2); }

/* --- gaps ---------------------------------------------------------------- */
.gap-list { display: flex; flex-direction: column; gap: var(--s4); }
.gap { display: grid; grid-template-columns: 116px 1fr; gap: var(--s4);
  border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface);
  padding: var(--s4) var(--s5); }
.gap-fig { display: flex; flex-direction: column; gap: 1px; }
.gap-k { font-size: var(--fs-xl); line-height: 1.05; color: var(--ink); letter-spacing: -.03em; }
.gap-n { font-size: var(--fs-xs); }
.gap-body h4 { margin: 0 0 5px; color: var(--ink); font-size: var(--fs-md); }
.gap-u { color: var(--ink-3); font-weight: 500; }
.gap-body p { margin: 0; font-size: var(--fs-sm); color: var(--ink-2); }
.gap-sub { margin: var(--s6) 0 var(--s4); font-size: var(--fs-xs); text-transform: uppercase;
  letter-spacing: .09em; color: var(--ink-3); }

/* --- caveats ------------------------------------------------------------- */
.cav-list { display: flex; flex-direction: column; gap: var(--s5); }
.cav { border-left: 3px solid var(--warn-line); padding-left: var(--s4); }
.cav h3 { color: var(--ink); }
.cav-lead { margin: 0 0 6px; font-size: var(--fs-sm); font-weight: 620; color: var(--ink); }
.cav-body { margin: 0; font-size: var(--fs-sm); color: var(--ink-2); }

/* --- glossary ------------------------------------------------------------ */
.gloss { margin: 0; display: grid; grid-template-columns: 210px 1fr; gap: var(--s3) var(--s5); }
.gloss dt { font-weight: 620; color: var(--ink); font-size: var(--fs-sm);
  border-top: 1px solid var(--line-soft); padding-top: var(--s3); }
.gloss dd { margin: 0; color: var(--ink-2); font-size: var(--fs-sm);
  border-top: 1px solid var(--line-soft); padding-top: var(--s3); }

/* --- cite ---------------------------------------------------------------- */
.cite-block { white-space: pre-wrap; font-size: var(--fs-xs); line-height: 1.7; margin: 0;
  padding: var(--s3) var(--s4); background: var(--surface-2); border: 1px solid var(--line);
  border-radius: var(--r-md); color: var(--ink-2); overflow-x: auto; }
.arch-list { margin: 0 0 var(--s3); padding-left: 1.15em; font-size: var(--fs-sm); color: var(--ink-2); }
.arch-list li { margin-bottom: 3px; }
.prov-k { color: var(--ink); width: 220px; }
.err-list { padding-left: 1.15em; font-size: var(--fs-xs); color: var(--ink-3); }

@media (max-width: 700px) {
  .pipe-step { grid-template-columns: 1fr; gap: var(--s2); }
  .gap { grid-template-columns: 1fr; gap: var(--s2); }
  .gloss { grid-template-columns: 1fr; gap: var(--s1); }
  .gloss dd { border-top: 0; padding-top: 0; }
}
`;
  document.head.appendChild(el('style', { id: STYLE_ID, text: css }));
}
