/* =============================================================================
   views/cluster.js — one motif cluster: what it looks like, what it is enriched
   for, and who it co-occurs with.

   Layout: an identity rail that never scrolls away (logo, consensus repertoire,
   position, size, distributions, module) beside a tabbed evidence column
   (Annotations · Partners · Members · Genes).

   The honesty rules this view exists to keep:
     · the sequence logo is drawn only when STREME found a motif at p < 0.05.
       444 of 900 clusters get the designed absent state, never a guessed PWM.
     · a partner row shows the FOUR gate values as pass/fail meters BEFORE any
       interpretation, and a labelled 'suggestive' superset is opt-in.
     · 282 of 600 UTR clusters (and 99 of 300 protein clusters) have zero strict
       partners: that is a designed state that points at where the evidence is.
     · npmi_raw is never displayed and never offered as a sort key.
     · the co-occurrence caveat is mounted by the shell on /cluster/* — this view
       must not render caveatBar() again, so it prints the gate legend instead.
   ============================================================================= */

import * as router from '../router.js';
import { getCluster, prefetchCluster, resolveToRefseq } from '../data.js';
import {
  el, mount, clear, fmt, emptyState, skeleton, copyLinkButton, csvButton, moduleChip,
  regionBadge, displaySeq, setTitle, scrollTop, DENOMINATORS, downloadBlob, toast,
  REGION_LABEL
} from '../ui.js';
import { renderLogo, absentLogo, refreshLogo, logoSVGText } from '../logo.js';
import * as R2 from '../r2-ui.js';

const TABS = [
  { key: 'annotations', label: 'Annotations' },
  { key: 'partners', label: 'Partners' },
  { key: 'members', label: 'Members' },
  { key: 'genes', label: 'Genes' }
];

let live = null;                 // {c, ix, panel, tabbar, token}
let token = 0;

export function teardown() { live = null; token++; }

/* =============================================================================
   render
   ============================================================================= */

export async function render(container, params) {
  R2.ensureR2Style();
  const mine = ++token;
  const id = String(params.id || '').toLowerCase();
  setTitle([id, 'cluster']);
  scrollTop();

  const wrap = el('div.wrap.view-pad');
  mount(container, wrap);
  wrap.appendChild(skeleton({ rows: 6, label: 'Loading cluster ' + id }));

  const [c, ix] = await Promise.all([getCluster(id), R2.getClusterIndex()]);
  if (mine !== token) return;
  clear(wrap);

  if (!c) {
    wrap.appendChild(el('nav.row', { style: { marginBottom: 'var(--s3)' } }, [
      el('a', { href: router.link('/browse') }, '← Browse all 900 clusters')
    ]));
    wrap.appendChild(emptyState({
      mark: '⌀',
      title: 'No cluster “' + id + '”',
      message: 'Cluster ids are ' + 'prot_0000–prot_0299, utr3_0000–utr3_0499 and ' +
        'utr5_0000–utr5_0099. Either this id does not exist or its payload has not been baked.',
      denominator: '900 clusters · 300 protein · 500 3′UTR · 100 5′UTR',
      action: el('a.btn.btn-primary', { href: router.link('/browse') }, 'Open the browser')
    }));
    return;
  }

  const row = ix && ix.byId ? ix.byId.get(c.id) : null;
  live = { c, ix, row, id: c.id };

  /* ---- provenance breadcrumb (dismissible) ------------------------------ */
  const from = params.query && params.query.from;
  if (from) wrap.appendChild(fromChip(String(from)));

  /* ---- header ----------------------------------------------------------- */
  wrap.appendChild(header(c, row, ix));

  /* ---- body ------------------------------------------------------------- */
  const rail = el('aside.r2-rail', { 'aria-label': 'Cluster identity' });
  const col = el('div');
  wrap.appendChild(el('div.r2-layout', [rail, col]));

  buildRail(rail, c, row, ix);

  const tabbar = el('div.r2-tabs', { role: 'tablist' });
  const panel = el('div', { role: 'tabpanel', id: 'cl-panel' });
  col.appendChild(tabbar);
  col.appendChild(panel);
  live.panel = panel; live.tabbar = tabbar;

  buildTabs(tabbar, c);
  renderPanel();

  router.onQuery(q => {
    if (mine !== token) return;
    markTabs(q.tab || 'annotations');
    renderPanel();
  });
}

/* =============================================================================
   header
   ============================================================================= */

function fromChip(from) {
  let label = from, href = null;
  if (/^N[MR]_/i.test(from)) { label = 'from ' + from.toUpperCase(); href = router.link('/gene/' + from); }
  else if (/^(prot|utr3|utr5)_\d+$/i.test(from)) { label = 'from ' + from; href = R2.clusterHref(from); }
  else if (/^m[1-6]$/i.test(from)) { label = 'from module ' + from.toUpperCase(); href = router.link('/module/' + from.slice(1)); }
  else if (from === 'network') { label = 'from the module network'; href = router.link('/network'); }
  else if (from === 'browse') { label = 'from the cluster browser'; href = router.link('/browse'); }
  else label = 'from ' + from;
  const node = el('div.r2-from', [
    el('span', { 'aria-hidden': 'true' }, '↩'),
    href ? el('a', { href }, label) : el('span', label),
    el('button', { type: 'button', title: 'Dismiss this trail', 'aria-label': 'Dismiss',
      on: { click: () => { node.remove(); router.setQuery({ from: null }); } } }, '×')
  ]);
  return node;
}

function znfLevel(c) {
  const strict = c.partners.filter(p => p.pass && p.znf != null);
  const pool = strict.length ? strict : c.partners.filter(p => R2.isSuggestive(p) && p.znf != null);
  if (!pool.length) return null;
  const v = pool.map(p => p.znf).sort((a, b) => a - b);
  return { med: v[Math.floor(v.length / 2)], max: v[v.length - 1], n: pool.length,
           over: strict.length ? 'strict partners' : 'suggestive partners' };
}

function header(c, row, ix) {
  const npass = c.n_partners_passing != null ? c.n_partners_passing
                                             : c.partners.filter(p => p.pass).length;
  const znf = znfLevel(c);
  const head = el('header', { style: { marginBottom: 'var(--s5)' } });

  head.appendChild(el('div.r2-head', [
    el('div', [
      el('div.r2-id', [c.id, '  ·  ', REGION_LABEL[c.region] || c.region, ' motif cluster']),
      el('h1', c.name && c.name.text ? c.name.text : c.id)
    ]),
    el('div.r2-chips', { style: { marginLeft: 'auto' } }, [
      copyLinkButton({ label: 'Copy link' }),
      neighbourLinks(c, ix)
    ])
  ]));

  head.appendChild(el('div.r2-chips', [
    regionBadge(c.region, { long: true }),
    moduleChip(c.module || 0, c.module ? { href: router.link('/module/' + c.module) } : { href: false }),
    R2.tierBadge(c.name ? c.name.tier : 3, c.name ? c.name.source : null),
    R2.qualityChip(!!c.logo, c.logo ? 'logo' : 'no logo', null,
      c.logo ? 'STREME motif at test p < 0.05' : '444 of 900 clusters have no defensible logo'),
    R2.qualityChip(c.n_terms_total > 0, c.n_terms_total ? 'enriched terms' : 'no enriched term',
      c.n_terms_total || null,
      c.n_terms_total ? c.n_terms_total + ' terms at FDR < 0.05'
                      : '437 of 900 clusters have no significant term'),
    R2.qualityChip(npass > 0, npass ? 'strict partners' : 'no strict partner', npass || null,
      npass + ' of ' + (c.n_partners_total || c.partners.length) +
      ' scored partners pass all four gates'),
    R2.qualityChip(!!c.module, c.module ? 'in a module' : 'no module', null,
      c.module ? 'Module M' + c.module : '387 of 900 clusters are unassigned'),
    znf ? R2.qualityChip(znf.med <= 0.2, 'ZNF share ' + znf.med.toFixed(2), null,
      'median frac_co_ZNF over this cluster’s ' + znf.n + ' ' + znf.over +
      ' (max ' + znf.max.toFixed(2) + '). A high share means the association is carried by ' +
      'the zinc-finger clade — the artifact the phylogenetic gate exists to remove.')
      : R2.qualityChip(false, 'ZNF share n/a', null,
        'No partner clears the co-occurrence floor, so no ZNF diagnostic is computable.')
  ]));

  if (c.name && c.name.tier === 3) {
    head.appendChild(el('p.r2-sub',
      'This cluster has no significant enriched term and no consensus string, so its id is the ' +
      'only honest name. 229 of 900 clusters are named this way.'));
  }
  return head;
}

function neighbourLinks(c, ix) {
  if (!ix) return null;
  const sibs = ix.rows.filter(r => r.r === c.region).map(r => r.id).sort();
  const i = sibs.indexOf(c.id);
  if (i < 0) return null;
  const prev = i > 0 ? sibs[i - 1] : null;
  const next = i < sibs.length - 1 ? sibs[i + 1] : null;
  return el('span.row', { style: { gap: '4px' } }, [
    el('a.btn.btn-sm' + (prev ? '' : '.is-off'), {
      href: prev ? R2.clusterHref(prev) : null, 'aria-disabled': prev ? null : 'true',
      title: prev ? 'Previous ' + c.region + ' cluster (' + prev + ')' : 'first in this region',
      on: { mouseenter: () => prev && prefetchCluster(prev) }
    }, '←'),
    el('span.dim', { style: { fontSize: 'var(--fs-xs)' } }, (i + 1) + ' / ' + sibs.length),
    el('a.btn.btn-sm', {
      href: next ? R2.clusterHref(next) : null, 'aria-disabled': next ? null : 'true',
      title: next ? 'Next ' + c.region + ' cluster (' + next + ')' : 'last in this region',
      on: { mouseenter: () => next && prefetchCluster(next) }
    }, '→')
  ]);
}

/* =============================================================================
   the identity rail
   ============================================================================= */

function railCard(title, tools, body) {
  return el('section.rail-card', [
    el('div.r2-panelhead', [el('h4', title), tools ? el('span', { style: { marginLeft: 'auto' } }, tools) : null]),
    body
  ]);
}

function buildRail(rail, c, row, ix) {
  /* ---- logo ------------------------------------------------------------- */
  let box = null;
  if (c.logo) {
    box = renderLogo(c.logo, { region: c.region, height: 116, maxColW: 30 });
    rail.appendChild(railCard('Sequence logo',
      el('button.btn.btn-sm', {
        type: 'button', title: 'Download this logo as a standalone SVG',
        on: { click: () => {
          const txt = logoSVGText(box);
          if (!txt) return toast('Nothing to export');
          downloadBlob('mirto-' + c.id + '-logo.svg', txt, 'image/svg+xml');
        } }
      }, 'SVG'),
      el('div', [
        box,
        el('p.r2-note', { style: { marginTop: 'var(--s3)' } }, [
          'STREME motif ', el('b', c.logo.motif_id || '—'),
          ' from ', el('b', c.logo.source || 'streme'),
          '. Letter height is information content; the stack is at most ',
          el('b', (c.region === 'protein' ? '4.32' : '2.00')), ' bits.',
          c.region !== 'protein' ? ' Drawn in the RNA alphabet; the payload is DNA.' : ''
        ])
      ])));
  } else {
    rail.appendChild(railCard('Sequence logo', null, absentLogo({ region: c.region })));
  }

  /* ---- consensus repertoire --------------------------------------------- */
  const med = ix && ix.meta && ix.meta.cons_coverage_median
    ? ix.meta.cons_coverage_median[c.region] : null;
  const cons = c.consensus || [];
  rail.appendChild(railCard('Consensus repertoire',
    cons.length > 4 ? el('a.btn.btn-sm', { href: '#', on: { click: e => { e.preventDefault(); go('members'); } } },
      'all ' + cons.length) : null,
    cons.length
      ? el('div', [
          el('div', cons.slice(0, 4).map(x => R2.coverageRow(
            displaySeq(x.text, c.region), x.coverage, x.carriers, med))),
          el('p.r2-note', { style: { marginTop: 'var(--s3)' } }, [
            'Bar = share of this cluster’s carrier transcripts holding the string; the tick is ',
            'the corpus median (', med != null ? fmt.pct(med, 0) : '—', ').'
          ])
        ])
      : emptyState({
          compact: true, mark: '◌', title: 'No consensus string',
          message: 'No sub-string recurs often enough across this cluster’s members to be ' +
            'reported as a consensus.',
          denominator: '449 of 900 clusters have no consensus string'
        })));

  /* ---- position --------------------------------------------------------- */
  rail.appendChild(railCard('Position along the region', null, el('div', [
    R2.positionHistogram(c.position || [], c.region),
    el('p.r2-note', { style: { marginTop: 'var(--s2)' } },
      '20 bins of relative position over ' + fmt.int(c.size.instances) + ' instances. The dashed ' +
      'line is the median instance.')
  ])));

  /* ---- size ------------------------------------------------------------- */
  rail.appendChild(railCard('Size', null, el('div', [
    R2.percentileRow('Instances', c.size.instances, row ? row.qi : null,
      row ? 'percentile ' + fmt.num(row.qi, 0) + ' of 900 clusters' : null),
    R2.percentileRow('Transcripts', c.size.transcripts, row ? row.qt : null,
      row ? 'percentile ' + fmt.num(row.qt, 0) : null),
    R2.percentileRow('Genes', c.size.genes, row ? row.qg : null,
      row ? 'percentile ' + fmt.num(row.qg, 0) : null),
    el('p.r2-note', { style: { marginTop: 'var(--s3)' } },
      'Median instance length ' + fmt.int(c.size.len_median) +
      (c.region === 'protein' ? ' aa' : ' nt') + '.')
  ])));

  /* ---- distributions ---------------------------------------------------- */
  const ghost = ix && ix.meta && ix.meta.ghost ? ix.meta.ghost[c.region] : null;
  const dist = el('div');
  dist.appendChild(distBlock('NTScore-like motif score', c.stats.score, ghost && ghost.score, c));
  dist.appendChild(distBlock('Positional entropy', c.stats.entropy, ghost && ghost.entropy, c));
  if (c.stats.plddt) dist.appendChild(distBlock('pLDDT (0–1)', c.stats.plddt, ghost && ghost.plddt, c));
  else if (c.region !== 'protein') {
    dist.appendChild(el('p.r2-note', { style: { marginTop: 'var(--s3)' } },
      'pLDDT exists for protein motifs only — there is none for a UTR cluster.'));
  }
  dist.appendChild(el('p.r2-note', { style: { marginTop: 'var(--s3)' } }, [
    'Box = 25–75%, whisker = 5–95%, thin line = full range, heavy tick = median. ',
    'The dashed outline behind is the ', el('b', 'median ' + (REGION_LABEL[c.region] || c.region) +
    ' cluster'), ' of the corpus, so a wide box means this cluster is more heterogeneous than ',
    'its peers.'
  ]));
  rail.appendChild(railCard('Distributions', null, dist));

  /* ---- module ----------------------------------------------------------- */
  rail.appendChild(railCard('Module', null, c.module
    ? el('div', [
        el('div.row', [
          moduleChip(c.module, { href: router.link('/module/' + c.module) }),
          el('a.btn.btn-sm', { href: router.link('/network/' + c.module) }, 'See it in the network'),
        ]),
        el('p.r2-note', { style: { marginTop: 'var(--s3)' } },
          'Module membership is statistical co-occurrence across genes, not demonstrated ' +
          'physical interaction. 513 of 900 clusters sit in a module.')
      ])
    : emptyState({
        compact: true, mark: '◇', title: 'Not in any module',
        message: 'This cluster’s associations were not dense enough to place it in one of the ' +
          'six modules. It can still have partners, and it is still in the browser.',
        denominator: DENOMINATORS.noModule,
        action: el('a.btn.btn-sm', { href: router.link('/network') }, 'Open the network')
      })));
}

function distBlock(label, blk, ghost, c) {
  if (!blk || !blk.q) return el('div');
  return el('div', { style: { marginBottom: 'var(--s4)' } }, [
    el('div.row', { style: { justifyContent: 'space-between', gap: 'var(--s2)' } }, [
      el('span.pbar-k', label),
      el('span.pbar-v', fmt.num(blk.median, 3))
    ]),
    R2.quantileStrip(blk.q, ghost, {
      label: label,
      lo: ghost ? Math.min(blk.q[0], ghost.lo) : blk.q[0],
      hi: ghost ? Math.max(blk.q[6], ghost.hi) : blk.q[6]
    })
  ]);
}

/* =============================================================================
   tabs
   ============================================================================= */

function curTab() {
  const t = String((router.getQuery().tab || 'annotations')).toLowerCase();
  return TABS.some(x => x.key === t) ? t : 'annotations';
}

function go(tab) { router.setQuery({ tab: tab === 'annotations' ? null : tab }); }

function buildTabs(bar, c) {
  const npass = c.n_partners_passing || 0;
  const counts = {
    annotations: c.n_terms_total || 0,
    partners: npass,
    members: c.size.instances,
    genes: c.n_genes_total || (c.genes || []).length
  };
  clear(bar);
  for (const t of TABS) {
    bar.appendChild(el('a.r2-tab', {
      href: router.link('/cluster/' + c.id,
        Object.assign({}, router.getQuery(), { tab: t.key === 'annotations' ? null : t.key })),
      role: 'tab', dataset: { tab: t.key },
      'aria-selected': String(t.key === curTab()),
      on: { click: e => { e.preventDefault(); go(t.key); } }
    }, [
      el('span', t.label),
      el('span.cnt', fmt.int(counts[t.key]))
    ]));
  }
}

function markTabs(tab) {
  if (!live || !live.tabbar) return;
  for (const a of live.tabbar.querySelectorAll('.r2-tab')) {
    a.setAttribute('aria-selected', String(a.dataset.tab === tab));
  }
}

function renderPanel() {
  if (!live || !live.panel) return;
  const { c, ix, row } = live;
  const tab = curTab();
  markTabs(tab);
  const p = live.panel;
  clear(p);
  if (tab === 'partners') p.appendChild(partnersPanel(c, ix));
  else if (tab === 'members') p.appendChild(membersPanel(c, ix, row));
  else if (tab === 'genes') p.appendChild(genesPanel(c));
  else p.appendChild(annotationsPanel(c));
  // the logo is built detached; re-measure its glyphs now that it is on screen
  const box = document.querySelector('.r2-rail .logo-box');
  if (box) refreshLogo(box);
}

/* =============================================================================
   ANNOTATIONS
   ============================================================================= */

const SRC_NOTE = {
  protein: 'InterPro, UniProt, MobiDB, IDPO, ELM and SignalP terms are masked to protein ' +
           'rows at bake; RBP and miRNA evidence never appears on a protein cluster.',
  utr: 'eCLIP / PAR-CLIP / iCLIP RBP evidence and miRNA sites are masked to UTR rows at bake; ' +
       'InterPro / UniProt / MobiDB never appear on a UTR cluster.'
};

function annotationsPanel(c) {
  const host = el('div');
  const terms = c.terms || [];
  const total = c.n_terms_total || terms.length;

  if (!terms.length) {
    const npass = c.n_partners_passing || 0;
    host.appendChild(emptyState({
      mark: '⌀',
      title: 'No significantly enriched annotation term',
      message: 'Nothing reaches FDR < 0.05 over this cluster’s ' + fmt.int(c.size.genes) +
        ' carrier genes. That is the common case, not a failure: the clusters were built ' +
        'from MIRTO embeddings, not from any annotation. ' +
        (npass ? 'The cross-modal evidence for this cluster is in the Partners tab.'
               : 'This cluster has no passing partner either — see Members for what its ' +
                 'instances actually look like.'),
      denominator: DENOMINATORS.noTerm,
      action: npass
        ? el('button.btn.btn-primary', { type: 'button', on: { click: () => go('partners') } },
            'Open Partners (' + npass + ')')
        : el('button.btn', { type: 'button', on: { click: () => go('members') } }, 'Open Members')
    }));
    return host;
  }

  /* source facet, in the URL */
  const bySrc = new Map();
  for (const t of terms) bySrc.set(t.src, (bySrc.get(t.src) || 0) + 1);
  const q = router.getQuery();
  const active = q.tsrc ? String(q.tsrc) : null;
  const chips = el('div.row', { style: { marginBottom: 'var(--s3)' } });
  chips.appendChild(el('button', {
    type: 'button', 'aria-pressed': String(!active),
    class: 'btn btn-sm' + (!active ? ' btn-primary' : ''),
    on: { click: () => router.setQuery({ tsrc: null }) }
  }, 'All ' + terms.length));
  for (const [src, n] of Array.from(bySrc.entries()).sort((a, b) => b[1] - a[1])) {
    chips.appendChild(el('button', {
      type: 'button', class: 'btn btn-sm' + (active === src ? ' btn-primary' : ''),
      on: { click: () => router.setQuery({ tsrc: active === src ? null : src }) }
    }, src + ' ' + n));
  }

  const shown = active ? terms.filter(t => t.src === active) : terms;
  const maxFold = Math.max.apply(null, shown.map(t => t.fold).concat([1]));

  const table = el('table.data', [
    el('thead', el('tr', [
      el('th', 'Source'), el('th', 'Term'), el('th.num', 'Fold'),
      el('th.num', 'Carriers'), el('th.num', 'FDR')
    ])),
    el('tbody', shown.map(t => el('tr', [
      el('td', el('span.mono', { style: { fontSize: 'var(--fs-xs)' } }, t.src)),
      el('td', [
        el('span', { style: { color: 'var(--ink)' } }, t.display),
        t.term && t.term !== t.display
          ? el('span.mono.dim', { style: { marginLeft: '6px', fontSize: 'var(--fs-xs)' } }, t.term)
          : null
      ]),
      el('td.num', [
        el('span.mono', fmt.num(t.fold, 1) + '×'),
        el('span.mini-track', { style: { marginLeft: '6px' } },
          el('span.mini', { style: { width: (46 * t.fold / maxFold).toFixed(1) + 'px' } }))
      ]),
      el('td.num.mono', fmt.int(t.k) + ' / ' + fmt.int(t.n)),
      el('td.num.mono', {
        title: t.fdr === 0
          ? 'FDR underflowed double precision at bake — it is smaller than 1e-308, not zero'
          : 'FDR within this cluster'
      }, t.fdr === 0 ? '< 1e-308' : R2.sig(t.fdr))
    ])))
  ]);

  host.appendChild(el('div.r2-panelhead', [
    el('h3', 'Enriched annotation terms'),
    el('span.r2-note', shown.length === total
      ? fmt.int(total) + ' terms at FDR < 0.05'
      : 'showing ' + fmt.int(shown.length) + ' of the ' + fmt.int(terms.length) +
        ' strongest terms shipped' +
        (terms.length < total ? ' · ' + fmt.int(total) + ' are significant in all' : '')),
    el('span', { style: { marginLeft: 'auto' } },
      csvButton('mirto-' + c.id + '-terms.csv', () => shown,
        [{ key: 'src', label: 'source' }, { key: 'term', label: 'term_id' },
         { key: 'display', label: 'term' }, { key: 'fold', label: 'fold_enrichment' },
         { key: 'k', label: 'carriers_with_term' }, { key: 'n', label: 'cluster_genes' },
         { key: 'fdr', label: 'fdr_cluster' }]))
  ]));
  host.appendChild(chips);
  host.appendChild(el('div.table-scroll', { style: { maxHeight: '62vh' } }, table));
  host.appendChild(el('p.r2-note', { style: { marginTop: 'var(--s3)' } }, [
    'Enrichment is over the cluster’s ', el('b', fmt.int(c.size.genes)), ' carrier genes ',
    'against the transcriptome background, FDR-corrected within the cluster. ',
    c.region === 'protein' ? SRC_NOTE.protein : SRC_NOTE.utr,
    ' Term names are single opaque strings — they are never split on a comma, because 41.3% of ',
    'InterPro names contain one.'
  ]));
  return host;
}

/* =============================================================================
   PARTNERS — the evidential heart
   ============================================================================= */

const PSORTS = [
  { key: 'score', label: 'phylo-corrected score', get: p => -p.score },
  { key: 'npmi', label: 'NPMI', get: p => -p.npmi },
  { key: 'co', label: 'co-occurrence', get: p => -p.co },
  { key: 'clades', label: 'independent clades', get: p => -p.clades },
  { key: 'conc', label: 'clade concentration (low first)', get: p => (p.conc == null ? 9 : p.conc) }
];

function partnersPanel(c, ix) {
  const host = el('div');
  const q = router.getQuery();
  const tier = q.tier === 'suggestive' ? 'suggestive' : 'strict';
  const strict = c.partners.filter(p => p.pass);
  const sugg = c.partners.filter(p => R2.isSuggestive(p));
  const total = c.n_partners_total || c.partners.length;
  const otherRegion = c.region === 'protein' ? 'UTR' : 'protein';

  host.appendChild(el('div.r2-panelhead', [
    el('h3', 'Cross-modal partners'),
    el('span.r2-note', [
      el('b', fmt.int(strict.length)), ' of ', el('b', fmt.int(total)), ' scored ',
      otherRegion, ' clusters pass all four gates'
    ]),
    el('span', { style: { marginLeft: 'auto' } }, [
      csvButton('mirto-' + c.id + '-partners-' + tier + '.csv',
        () => sortPartners(tier === 'strict' ? strict : sugg),
        [{ key: 'id', label: 'partner' }, { key: 'module', label: 'module' },
         { key: 'score', label: 'phylo_corrected_score' }, { key: 'npmi', label: 'npmi_mip_APC' },
         { key: 'co', label: 'co_count' }, { key: 'clades', label: 'n_indep_clades' },
         { key: 'conc', label: 'clade_concentration' }, { key: 'znf', label: 'frac_co_ZNF' },
         { key: 'pass', label: 'passes_phylo_filter' }])
    ])
  ]));

  host.appendChild(R2.gateLegend());

  /* tier control */
  const tierBar = el('div.row', { style: { marginBottom: 'var(--s3)' } }, [
    el('div.seg', { role: 'group', 'aria-label': 'evidence tier' }, [
      el('button', { type: 'button', 'aria-pressed': String(tier === 'strict'),
        on: { click: () => router.setQuery({ tier: null }) },
        title: 'All four gates hold. This is the published set: 2,620 pairs of 166,615.' },
        'Strict, phylogeny-independent (' + fmt.int(strict.length) + ')'),
      el('button', { type: 'button', 'aria-pressed': String(tier === 'suggestive'),
        on: { click: () => router.setQuery({ tier: 'suggestive' }) },
        title: 'Superset: clears the co-occurrence floor (co ≥ 10 and NPMI > 0.10) but not ' +
               'necessarily the two phylogenetic-independence gates.' },
        'Suggestive superset (' + fmt.int(sugg.length) + ')')
    ]),
    el('label.r2-note', { style: { marginLeft: 'auto' } }, [
      'sort ',
      el('select', {
        class: 'btn btn-sm', style: { paddingRight: '4px' },
        on: { change: e => router.setQuery({ psort: e.target.value === 'score' ? null : e.target.value }) }
      }, PSORTS.map(s => el('option', { value: s.key, selected: (q.psort || 'score') === s.key },
        s.label)))
    ])
  ]);
  host.appendChild(tierBar);

  if (tier === 'suggestive') {
    host.appendChild(el('div.banner.warn', [
      el('b', 'Suggestive tier. '),
      'These pairs clear the co-occurrence floor but not the phylogenetic-independence gates: ',
      'the association may be carried by one clade of related genes rather than by independent ',
      'evidence. The failing gate is marked in red on every row. Nothing here is in the ',
      'published 2,620.'
    ]));
  }

  const list = sortPartners(tier === 'strict' ? strict : sugg);

  if (!list.length) {
    host.appendChild(zeroPartners(c, tier, strict, sugg, total));
    return host;
  }

  const body = el('div');
  host.appendChild(body);
  let drawn = 0;
  const PAGE = 40;
  const more = el('div.row', { style: { marginTop: 'var(--s4)', justifyContent: 'center' } });

  function draw() {
    const slice = list.slice(drawn, drawn + PAGE);
    for (const p of slice) body.appendChild(partnerRow(p, c, ix));
    drawn += slice.length;
    clear(more);
    if (drawn < list.length) {
      more.appendChild(el('button.btn', { type: 'button', on: { click: draw } },
        'Show ' + Math.min(PAGE, list.length - drawn) + ' more (' + drawn + ' of ' +
        list.length + ' shown)'));
    } else if (list.length > PAGE) {
      more.appendChild(el('span.r2-note', 'all ' + list.length + ' shown'));
    }
  }
  draw();
  host.appendChild(more);
  return host;
}

function sortPartners(list) {
  const key = router.getQuery().psort || 'score';
  const s = PSORTS.find(x => x.key === key) || PSORTS[0];
  return list.slice().sort((a, b) => s.get(a) - s.get(b) || b.npmi - a.npmi ||
                                     String(a.id).localeCompare(String(b.id)));
}

function partnerRow(p, c, ix) {
  const row = ix && ix.byId ? ix.byId.get(p.id) : null;
  const pairs = p.consensus_pairs || [];
  const node = el('div', { class: 'p-row' + (p.pass ? '' : ' is-fail') });

  node.appendChild(R2.gateStrip(p));

  node.appendChild(el('div.p-head', [
    R2.clusterLink(p.id, { from: c.id }),
    regionBadge(R2.regionOf(p.id)),
    moduleChip(p.module || 0, { quiet: true, href: false }),
    row ? el('span.p-name', row.name) : null,
    el('span.p-score', p.pass
      ? [fmt.num(p.score, 3), el('span', ' phylo-corrected score')]
      : [el('span', 'score 0 — not phylogeny-corrected')])
  ]));

  node.appendChild(el('div.p-cons', pairs.length
    ? [
        el('span.p-verdict.ok', ['◆ consensus-level pair']),
        ...pairs.slice(0, 4).map(pr => el('span.pair', [
          displaySeq(pr[0], c.region), el('i', '×'),
          displaySeq(pr[1], R2.regionOf(p.id))
        ])),
        pairs.length > 4 ? el('span.dim', '+' + (pairs.length - 4) + ' more') : null
      ]
    : [
        el('span.p-verdict.no', ['◇ cluster-level only']),
        el('span', 'No consensus string of one cluster pairs with a consensus string of the ' +
          'other above threshold — the association is between the clusters, not between two ' +
          'specific short motifs.'),
        p.pass ? el('span.dim.mono', '1,190 of 2,620 gated edges') : null
      ]));

  node.appendChild(el('div', { style: { marginTop: 'var(--s2)' } }, [
    el('a.btn.btn-sm', {
      href: R2.clusterHref(p.id, { from: c.id }),
      on: { mouseenter: () => prefetchCluster(p.id) }
    }, 'Open ' + p.id + ' →')
  ]));
  return node;
}

function zeroPartners(c, tier, strict, sugg, total) {
  const isUTR = c.region !== 'protein';
  const denom = isUTR ? DENOMINATORS.utrNoPartner : DENOMINATORS.protNoPartner;
  const actions = el('div.row', { style: { justifyContent: 'center' } }, [
    tier === 'strict' && sugg.length
      ? el('button.btn.btn-primary', { type: 'button',
          on: { click: () => router.setQuery({ tier: 'suggestive' }) } },
          'See the ' + sugg.length + ' suggestive pairs')
      : null,
    c.module
      ? el('a.btn', { href: router.link('/network/' + c.module) },
          'Where the evidence is: module M' + c.module)
      : el('a.btn', { href: router.link('/network') }, 'Open the module network'),
    el('a.btn', { href: router.link('/browse', { partners: 'has', region: c.region }) },
      'Browse ' + (isUTR ? 'UTR' : 'protein') + ' clusters that do have partners')
  ]);

  return emptyState({
    mark: '⌀',
    title: tier === 'strict'
      ? 'No partner passes all four gates'
      : 'No partner even clears the co-occurrence floor',
    message: tier === 'strict'
      ? 'All ' + fmt.int(total) + ' ' + (isUTR ? 'protein' : 'UTR') + ' clusters were scored ' +
        'against this one and none passes co ≥ 10, clades ≥ 8, conc < 0.35 and NPMI > 0.10 ' +
        'together. ' + (sugg.length
          ? sugg.length + ' clear the co-occurrence floor but fail phylogenetic independence — ' +
            'that is exactly the artifact the gate removes, and they are one click away, labelled.'
          : 'Not one of them clears even the co-occurrence floor, so there is no suggestive ' +
            'tier to fall back on either.')
      : 'Not one of the ' + fmt.int(total) + ' scored partners reaches co ≥ 10 with NPMI > 0.10.',
    denominator: denom,
    action: actions
  });
}

/* =============================================================================
   MEMBERS
   ============================================================================= */

function membersPanel(c, ix, row) {
  const host = el('div');
  const unit = c.region === 'protein' ? 'aa' : 'nt';

  host.appendChild(el('div.r2-panelhead', [
    el('h3', 'Member instances'),
    el('span.r2-note', [
      el('b', fmt.int(c.size.instances)), ' instances in ', el('b', fmt.int(c.size.transcripts)),
      ' transcripts across ', el('b', fmt.int(c.size.genes)), ' genes'
    ])
  ]));
  host.appendChild(el('p.r2-note', { style: { marginBottom: 'var(--s4)' } },
    'No per-instance table is shipped — 889,215 motif instances would be a download, not a page. ' +
    'These are the distributions over this cluster’s members; the gene pages carry the individual ' +
    'spans, drawn on the transcript.'));

  /* length histogram */
  const lens = Object.keys(c.size.lengths || {}).map(Number).sort((a, b) => a - b);
  if (lens.length) {
    const counts = lens.map(L => c.size.lengths[String(L)]);
    const totalN = counts.reduce((a, b) => a + b, 0);
    const maxC = Math.max.apply(null, counts);
    const W = 640, H = 130;
    const bw = W / lens.length;
    const svg = el('svg.hist', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none',
      style: { height: '130px' }, role: 'img',
      'aria-label': 'distribution of motif instance length' });
    let cum = 0, medL = null;
    lens.forEach((L, i) => {
      const h = (counts[i] / maxC) * (H - 4);
      svg.appendChild(el('rect.b', { x: (i * bw + 0.5).toFixed(2), y: (H - h).toFixed(2),
        width: Math.max(1, bw - 1).toFixed(2), height: Math.max(0.8, h).toFixed(2), rx: 1 },
        el('title', L + ' ' + unit + ' · ' + fmt.int(counts[i]) + ' instances (' +
          fmt.pct(counts[i] / totalN, 1) + ')')));
      cum += counts[i];
      if (medL == null && cum >= totalN / 2) medL = i;
    });
    if (medL != null) {
      svg.appendChild(el('line.med', { x1: ((medL + 0.5) * bw).toFixed(1),
        x2: ((medL + 0.5) * bw).toFixed(1), y1: 0, y2: H }));
    }
    host.appendChild(el('section.rail-card', { style: { marginBottom: 'var(--s4)' } }, [
      el('h4', 'Instance length'),
      svg,
      el('div.hist-axis', [
        el('span', lens[0] + ' ' + unit),
        el('span.dim', 'median ' + fmt.int(c.size.len_median) + ' ' + unit),
        el('span', lens[lens.length - 1] + ' ' + unit)
      ]),
      el('p.r2-note', { style: { marginTop: 'var(--s2)' } },
        'One bar per observed length (' + lens.length + ' distinct values from ' + lens[0] +
        ' to ' + lens[lens.length - 1] + ' ' + unit + '), so the spacing is ordinal, not linear. ' +
        'The dashed line is the median instance.')
    ]));
  }

  /* position, full width */
  host.appendChild(el('section.rail-card', { style: { marginBottom: 'var(--s4)' } }, [
    el('h4', 'Position within the region'),
    R2.positionHistogram(c.position || [], c.region),
    el('p.r2-note', { style: { marginTop: 'var(--s2)' } },
      c.region === 'protein'
        ? 'Relative position from N- to C-terminus, 20 bins.'
        : 'Relative position along the ' + (c.region === 'utr5' ? "5′" : "3′") +
          ' UTR, 20 bins, 5′ on the left.')
  ]));

  /* quantile table with the corpus ghost */
  const ghost = ix && ix.meta && ix.meta.ghost ? ix.meta.ghost[c.region] : null;
  const QL = (c.stats.quantile_levels || [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1]).map(x =>
    x === 0 ? 'min' : x === 1 ? 'max' : 'p' + Math.round(x * 100));
  const blocks = [['score', 'Motif score', c.stats.score, ghost && ghost.score],
                  ['entropy', 'Positional entropy', c.stats.entropy, ghost && ghost.entropy],
                  ['plddt', 'pLDDT (0–1)', c.stats.plddt, ghost && ghost.plddt]]
    .filter(b => b[2] && b[2].q);
  host.appendChild(el('section.rail-card', { style: { marginBottom: 'var(--s4)' } }, [
    el('h4', 'Distributions vs the corpus'),
    el('div.table-scroll', el('table.data', [
      el('thead', el('tr', [el('th', 'Statistic')].concat(QL.map(l => el('th.num', l))))),
      el('tbody', blocks.map(b => [
        el('tr', [el('td', b[1])].concat(b[2].q.map(v => el('td.num.mono', fmt.num(v, 3))))),
        b[3] ? el('tr', { style: { opacity: '.65' } },
          [el('td.dim', ['median ', REGION_LABEL[c.region] || c.region, ' cluster'])]
            .concat(b[3].q.map(v => el('td.num.mono', fmt.num(v, 3))))) : null
      ]).flat().filter(Boolean))
    ])),
    el('p.r2-note', { style: { marginTop: 'var(--s3)' } },
      'The grey row is the median cluster of this region, computed across all ' +
      (ghost && ghost.score ? fmt.int(ghost.score.n) : '—') + ' of them — the same ghost drawn ' +
      'behind the strips in the rail.' +
      (c.region === 'protein' ? '' : ' pLDDT is protein-only and absent here by construction.'))
  ]));

  /* full consensus repertoire */
  const med = ix && ix.meta && ix.meta.cons_coverage_median
    ? ix.meta.cons_coverage_median[c.region] : null;
  const cons = c.consensus || [];
  host.appendChild(el('section.rail-card', [
    el('h4', 'Consensus repertoire (' + cons.length + ')'),
    cons.length
      ? el('div', cons.map(x => R2.coverageRow(displaySeq(x.text, c.region), x.coverage,
          x.carriers, med)))
      : emptyState({ compact: true, mark: '◌', title: 'No consensus string',
          message: 'No sub-string recurs often enough across the members to be reported.',
          denominator: '449 of 900 clusters have no consensus string' }),
    cons.length ? el('p.r2-note', { style: { marginTop: 'var(--s3)' } },
      'Consensus strings are shown in the display alphabet (' +
      (c.region === 'protein' ? 'amino acids' : 'RNA, U for T') + '). ' +
      'Coverage is the share of carrier transcripts holding the string.') : null
  ]));
  return host;
}

/* =============================================================================
   GENES
   ============================================================================= */

function genesPanel(c) {
  const host = el('div');
  const genes = c.genes || [];
  const total = c.n_genes_total || genes.length;
  const q = router.getQuery();
  const filter = String(q.gq || '').trim().toUpperCase();

  host.appendChild(el('div.r2-panelhead', [
    el('h3', 'Carrier genes'),
    el('span.r2-note', genes.length < total
      ? 'showing ' + fmt.int(genes.length) + ' of ' + fmt.int(total) +
        ' (the shard caps the list at 500, ordered by instance count)'
      : fmt.int(total) + ' genes carry at least one instance'),
    el('span', { style: { marginLeft: 'auto' } },
      csvButton('mirto-' + c.id + '-genes.csv', () => genes.map(s => ({ gene: s })),
        [{ key: 'gene', label: 'gene_symbol' }]))
  ]));

  if (!genes.length) {
    host.appendChild(emptyState({
      mark: '⌀', title: 'No carrier gene list',
      message: 'This cluster ships no gene list.',
      denominator: fmt.int(total) + ' genes reported in size.genes'
    }));
    return host;
  }

  const input = el('input', {
    type: 'search', placeholder: 'Filter ' + fmt.int(genes.length) + ' symbols…',
    value: q.gq || '', 'aria-label': 'Filter carrier genes',
    class: 'btn', style: { width: '260px', height: '30px' },
    on: { input: e => {
      const v = e.target.value;
      clearTimeout(input.__t);
      input.__t = setTimeout(() => router.setQuery({ gq: v || null }), 180);
    } }
  });
  host.appendChild(el('div.row', { style: { marginBottom: 'var(--s3)' } }, [input]));

  const shown = filter ? genes.filter(g => String(g).toUpperCase().indexOf(filter) !== -1) : genes;
  const grid = el('div', { style: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '6px'
  } });
  host.appendChild(grid);

  if (!shown.length) {
    grid.appendChild(emptyState({ compact: true, mark: '⌀', title: 'No symbol matches “' + filter + '”',
      message: 'The filter is a plain substring match over the carrier list.',
      denominator: '0 of ' + fmt.int(genes.length) + ' listed genes' }));
    return host;
  }

  for (const sym of shown.slice(0, 600)) {
    const a = el('a.chip', {
      style: { justifyContent: 'flex-start', textDecoration: 'none' },
      title: 'Resolving ' + sym + '…'
    }, sym);
    grid.appendChild(a);
    resolveToRefseq(sym).then(rs => {
      if (rs) {
        a.setAttribute('href', router.link('/gene/' + rs));
        a.title = sym + ' → ' + rs;
      } else {
        a.classList.add('tag-off');
        a.title = sym + ' — no RefSeq transcript in the 18,093-transcript universe ' +
          '(the carrier list uses the annotation table’s own symbols)';
      }
    });
  }

  host.appendChild(el('p.r2-note', { style: { marginTop: 'var(--s4)' } },
    'Symbols come from the annotation table; each links to its RefSeq transcript page where ' +
    'that mapping exists. gene_symbol → sequence_id is effectively 1:1 (17,847 symbols over ' +
    '18,093 transcripts), so a symbol that does not resolve is one the sequence table never ' +
    'carried.'));
  return host;
}
