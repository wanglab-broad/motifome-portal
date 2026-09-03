/* =============================================================================
   data.js — the ONLY module in the portal that touches the network.

   Contract: every getter resolves. A missing or malformed payload resolves to
   `null` (or an empty array for search) and the caller renders its designed
   empty state. Nothing here ever rejects, so no view can produce an uncaught
   rejection. Failures are recorded in `dataErrors()` for the About page.

   Paths are RELATIVE ('data/...') so the site works from any subdirectory.
   ============================================================================= */

const BASE = 'data/';

/* ---------- shapes the contract guarantees (used for graceful degradation) - */
export const NT_DOMAIN = [-8.0, 0.0];

export const MODULE_COLORS = {
  0: '#9AA5B1', 1: '#E69F00', 2: '#56B4E9', 3: '#009E73',
  4: '#F0E442', 5: '#0072B2', 6: '#D55E00'
};

/** Fallback labels. `network.json.meta.modules[].label` is authoritative and
 *  overrides these once the network payload has been loaded. */
export const MODULE_LABELS = {
  0: 'Unassigned',
  1: 'Transcriptional / developmental regulation',
  2: 'Transcription factors',
  3: 'Secretory / membrane',
  4: 'Immune',
  5: 'RNA processing',
  6: 'Translation / histone'
};

/* ---------- LRU ----------------------------------------------------------- */

class LRU {
  constructor(limit) { this.limit = limit; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v);      // touch
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return v;
  }
  has(k) { return this.map.has(k); }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

const geneCache    = new LRU(80);     // ~3.3 KB mean, 16 KB max -> well under 2 MB
const clusterCache = new LRU(120);
const moduleCache  = new LRU(8);
const inflight     = new Map();       // url -> Promise (dedupes concurrent requests)
const errors       = [];              // {url, status, message, at}

let manifestPromise = null;
let networkPromise  = null;
let searchPromise   = null;

/* ---------- the single fetch primitive ------------------------------------ */

function note(url, status, message) {
  errors.push({ url, status, message, at: new Date().toISOString() });
  if (errors.length > 40) errors.shift();
}

/** Never throws. Returns the parsed JSON, or null. */
async function getJSON(url) {
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    try {
      const res = await fetch(url, { cache: 'default' });
      if (!res.ok) {
        note(url, res.status, res.statusText || 'HTTP ' + res.status);
        return null;
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        note(url, 200, 'malformed JSON: ' + e.message);
        return null;
      }
    } catch (e) {
      // file:// origin, offline, blocked, aborted — all land here
      note(url, 0, e && e.message ? e.message : 'network error');
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
  return p;
}

export function dataErrors() { return errors.slice(); }
export function dataBase() { return BASE; }

/* ---------- id hygiene ---------------------------------------------------- */
/* Ids come out of the URL bar. Restrict them to the shapes the bake writes so a
   crafted hash can never build a path that escapes portal/data/. */

const SAFE_ID = /^[A-Za-z0-9_.\-]{1,64}$/;

export function normalizeRefseq(id) {
  if (id == null) return null;
  let s = String(id).trim().toUpperCase();
  s = s.replace(/\.\d+$/, '');                  // NM_001101.5 -> NM_001101
  return SAFE_ID.test(s) ? s : null;
}

export function normalizeClusterId(id) {
  if (id == null) return null;
  const s = String(id).trim().toLowerCase();
  return /^(prot|utr3|utr5)_\d{1,6}$/.test(s) ? s : null;
}

export function normalizeModule(n) {
  const m = parseInt(String(n == null ? '' : n).replace(/^m/i, ''), 10);
  return Number.isInteger(m) && m >= 1 && m <= 6 ? m : null;
}

/* ---------- public getters ------------------------------------------------ */

export function getManifest() {
  if (!manifestPromise) {
    manifestPromise = getJSON(BASE + 'manifest.json').then(m => {
      if (!m || typeof m !== 'object') return null;
      // fill in only what is structurally required so views can read blindly
      m.counts = m.counts || {};
      m.nt_domain = Array.isArray(m.nt_domain) && m.nt_domain.length === 2 ? m.nt_domain : NT_DOMAIN;
      return m;
    });
  }
  return manifestPromise;
}

export async function getGene(refseq) {
  const id = normalizeRefseq(refseq);
  if (!id) return null;
  const hit = geneCache.get(id);
  if (hit !== undefined) return hit;
  const g = await getJSON(BASE + 'gene/' + encodeURIComponent(id) + '.json');
  return geneCache.set(id, g || null);
}

export async function getCluster(clusterId) {
  const id = normalizeClusterId(clusterId);
  if (!id) return null;
  const hit = clusterCache.get(id);
  if (hit !== undefined) return hit;
  const c = await getJSON(BASE + 'cluster/' + encodeURIComponent(id) + '.json');
  return clusterCache.set(id, c || null);
}

/** ~1.6 MB, loaded once and pinned (the network view needs all of it). */
export function getNetwork() {
  if (!networkPromise) {
    networkPromise = getJSON(BASE + 'network.json').then(n => {
      if (!n || !Array.isArray(n.nodes) || !Array.isArray(n.edges)) return null;
      n.meta = n.meta || {};
      n.meta.modules = Array.isArray(n.meta.modules) ? n.meta.modules : [];
      // index for O(1) lookups by every view that needs them
      n.byId = new Map(n.nodes.map(d => [d.id, d]));
      for (const m of n.meta.modules) {
        if (m && m.id != null) {
          if (m.color) MODULE_COLORS[m.id] = m.color;
          if (m.label) MODULE_LABELS[m.id] = m.label;
        }
      }
      return n;
    });
  }
  return networkPromise;
}

export async function getModule(n) {
  const m = normalizeModule(n);
  if (!m) return null;
  const hit = moduleCache.get(m);
  if (hit !== undefined) return hit;
  const d = await getJSON(BASE + 'modules/' + m + '.json');
  return moduleCache.set(m, d || null);
}

/* ---------- search -------------------------------------------------------- */
/* search.json  : [[symbol, refseq, primary_module|0, n_motifs], ...]
   search_alias.json : {"ENSG00000075624": "NM_001101", ...}                    */

async function loadSearch() {
  if (!searchPromise) {
    searchPromise = (async () => {
      const [rows, alias] = await Promise.all([
        getJSON(BASE + 'search.json'),
        getJSON(BASE + 'search_alias.json')
      ]);
      const list = Array.isArray(rows) ? rows.filter(r => Array.isArray(r) && r.length >= 2) : [];
      const bySymbol = new Map();
      const byRefseq = new Map();
      for (const r of list) {
        const sym = String(r[0] || ''), rs = String(r[1] || '');
        if (sym) {
          const k = sym.toUpperCase();
          if (!bySymbol.has(k)) bySymbol.set(k, []);
          bySymbol.get(k).push(r);
        }
        if (rs) byRefseq.set(rs.toUpperCase(), r);
      }
      const aliasMap = new Map();
      if (alias && typeof alias === 'object' && !Array.isArray(alias)) {
        for (const k of Object.keys(alias)) aliasMap.set(k.toUpperCase(), String(alias[k]));
      }
      return { list, bySymbol, byRefseq, alias: aliasMap, ok: list.length > 0 };
    })();
  }
  return searchPromise;
}

export async function searchIndexReady() {
  const ix = await loadSearch();
  return { ok: ix.ok, genes: ix.list.length, aliases: ix.alias.size };
}

/** Resolve a symbol or alias straight to a refseq (no ranking). */
export async function resolveToRefseq(term) {
  const ix = await loadSearch();
  const q = String(term || '').trim().toUpperCase();
  if (!q) return null;
  if (ix.byRefseq.has(q)) return ix.byRefseq.get(q)[1];
  const rsNoVer = q.replace(/\.\d+$/, '');
  if (ix.byRefseq.has(rsNoVer)) return ix.byRefseq.get(rsNoVer)[1];
  if (ix.alias.has(q)) return ix.alias.get(q);
  if (ix.alias.has(rsNoVer)) return ix.alias.get(rsNoVer);
  const hit = ix.bySymbol.get(q);
  return hit && hit.length ? hit[0][1] : null;
}

/**
 * search(query, opts) -> array of result objects, ranked. Never rejects.
 *   { kind:'gene'|'cluster'|'module'|'route', id, label, sub, href, module, n }
 * Recognises: gene symbols, RefSeq (with or without version), ENSG/ENST aliases,
 * cluster ids (prot_0038 / utr3_0215), 'M3' / 'module 3', and the static routes.
 * Motif strings typed in the RNA alphabet are U->T normalised before matching so
 * the manuscript's own names (UCAUC, GCCACC) behave.
 */
export async function search(query, opts) {
  opts = opts || {};
  const limit = opts.limit || 24;
  const raw = String(query == null ? '' : query).trim();
  if (!raw) return [];
  const q = raw.toUpperCase();
  const out = [];
  const seen = new Set();
  const push = r => { const k = r.kind + ':' + r.id; if (!seen.has(k)) { seen.add(k); out.push(r); } };

  /* --- exact non-gene shapes first ------------------------------------- */
  const cid = normalizeClusterId(raw);
  if (cid) {
    push({ kind: 'cluster', id: cid, label: cid, sub: 'motif cluster',
           href: '#/cluster/' + cid, module: null, n: null, score: 1000 });
  }
  const mnum = /^(?:M|MODULE\s*)(\d)$/.exec(q);
  if (mnum && +mnum[1] >= 1 && +mnum[1] <= 6) {
    const m = +mnum[1];
    push({ kind: 'module', id: String(m), label: 'Module M' + m,
           sub: MODULE_LABELS[m] || 'module', href: '#/module/' + m,
           module: m, n: null, score: 999 });
  }
  for (const r of [['network', 'Module network', '#/network'],
                   ['browse', 'Browse clusters & genes', '#/browse'],
                   ['about', 'About, data & caveats', '#/about']]) {
    if (r[0].startsWith(q.toLowerCase()) && q.length >= 3) {
      push({ kind: 'route', id: r[0], label: r[1], sub: 'page', href: r[2],
             module: null, n: null, score: 500 });
    }
  }

  /* --- the gene index --------------------------------------------------- */
  const ix = await loadSearch();
  if (ix.ok) {
    const qT = q.replace(/U/g, 'T');             // RNA -> DNA alphabet
    const asRefseq = q.replace(/\.\d+$/, '');

    if (ix.byRefseq.has(asRefseq)) push(geneResult(ix.byRefseq.get(asRefseq), 900, 'RefSeq'));
    if (ix.alias.has(asRefseq)) {
      const rs = ix.alias.get(asRefseq).toUpperCase();
      const row = ix.byRefseq.get(rs);
      if (row) push(geneResult(row, 880, asRefseq.startsWith('ENST') ? 'ENST' : 'ENSG'));
    }
    const exact = ix.bySymbol.get(q) || (qT !== q ? ix.bySymbol.get(qT) : null);
    if (exact) for (const row of exact) push(geneResult(row, 950, 'gene symbol'));

    if (out.length < limit) {
      const pre = [], sub = [];
      for (const row of ix.list) {
        const sym = String(row[0] || '').toUpperCase();
        const rs = String(row[1] || '').toUpperCase();
        if (sym.startsWith(q)) { pre.push([row, 700 - Math.min(sym.length, 40)]); }
        else if (rs.startsWith(asRefseq) && asRefseq.length >= 3) { pre.push([row, 640]); }
        else if (q.length >= 3 && sym.indexOf(q) !== -1) { sub.push([row, 400]); }
        if (pre.length > 400) break;
      }
      pre.sort((a, b) => b[1] - a[1] || String(a[0][0]).length - String(b[0][0]).length);
      sub.sort((a, b) => String(a[0][0]).length - String(b[0][0]).length);
      for (const [row, sc] of pre.concat(sub)) {
        if (out.length >= limit) break;
        push(geneResult(row, sc, 'gene'));
      }
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

function geneResult(row, score, why) {
  const sym = String(row[0] || ''), rs = String(row[1] || '');
  const mod = Number(row[2]) || 0, n = Number(row[3]) || 0;
  return {
    kind: 'gene', id: rs, label: sym || rs,
    sub: (sym ? rs : '') + (why && why !== 'gene' ? ' · ' + why : ''),
    href: '#/gene/' + rs, module: mod, n, score
  };
}

/* ---------- helpers the views share (kept here: they decode bake output) --- */

/** base64 -> Uint8Array. The `nt` tracks in a gene shard are base64 uint8. */
export function decodeTrack(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    note('(inline base64)', 0, 'bad nt track: ' + e.message);
    return null;
  }
}

/** Inverse of the contract's quantization: round(255 * (v + 8) / 8). */
export function ntValue(byte, domain) {
  const d = domain || NT_DOMAIN;
  return d[0] + (Number(byte) / 255) * (d[1] - d[0]);
}

/** Prefetch a payload without caring about the result (hover intent, etc). */
export function prefetchGene(refseq) { getGene(refseq).catch(() => {}); }
export function prefetchCluster(id) { getCluster(id).catch(() => {}); }

export function cacheStats() {
  return { genes: geneCache.size, clusters: clusterCache.size,
           modules: moduleCache.size, errors: errors.length };
}

export function clearCaches() {
  geneCache.clear(); clusterCache.clear(); moduleCache.clear();
  manifestPromise = null; networkPromise = null; searchPromise = null;
}
