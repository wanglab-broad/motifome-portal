#!/usr/bin/env node
/* probe.mjs — ONE Chrome, many measurements.
 *
 * The slow way (and the reason a previous run took 30 minutes for zero edits) is
 * launching `chrome --headless --dump-dom` once per route/width: a cold start plus
 * a full virtual-time budget every time, 7-17 minutes each on the network route.
 * This launches Chrome ONCE, drives every route/width over CDP in one session, and
 * returns the whole matrix as JSON in a few seconds.
 *
 *   node probe.mjs --port 8899 --routes "/,#/network" --widths 1600,1280,390 [--theme dark]
 *
 * WIDTHS MATTER MORE THAN YOU THINK. The network cockpit only becomes a 3-column
 * layout with a 344px inspector at >=1480px (graph.js @media min-width:1480px).
 * A matrix of 1440/390 reports clean on a panel bug that is plainly visible at
 * 1600px. Always include a width above every breakpoint you are testing across.
 *                  [--json out.json] [--shot name:/route] [--timeout 15000]
 *
 * Per (route, width) it reports:
 *   overlaps  sibling element boxes intersecting by >1px   -> must be 0
 *   escapes   elements whose box exceeds its offsetParent's content box,
 *             excluding anything inside an overflow-x:auto/scroll container
 *   pageWide  documentElement.scrollWidth > innerWidth  (body{overflow-x:hidden}
 *             HIDES this, so it is measured geometrically, never from a scrollbar)
 *   errors    uncaught page errors + console.error
 *
 * KNOWN BENIGN: #/gene/* reports one escape, `div.sv-handle r by 5px`. The
 * sequence viewer's resize handles are 13px wide and deliberately centred on the
 * viewport edge (seqview.js: .sv-handle.r{right:-7px}) so the edge stays
 * grabbable. That is design, not overflow. Everything else should read 0.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? dflt : process.argv[i + 1];
}
const PORT    = arg('port', '8899');
const ROUTES  = String(arg('routes', '/')).split(',').map(s => s.trim()).filter(Boolean);
const WIDTHS  = String(arg('widths', '1440')).split(',').map(n => parseInt(n, 10));
const THEME   = arg('theme', 'light');
const OUT     = arg('json', null);
const TIMEOUT = parseInt(arg('timeout', '15000'), 10);
const SHOTS   = process.argv.reduce((a, v, i) =>
  (v === '--shot' ? a.concat([process.argv[i + 1]]) : a), []);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- the audit that runs INSIDE the page ------------------------------- */
const AUDIT = `(() => {
  const vis = el => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const scrollHost = el => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  const all = [...document.querySelectorAll('body *')].filter(vis);
  const overlaps = [], escapes = [];
  const byParent = new Map();
  for (const el of all) {
    const p = el.parentElement;
    if (!p) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(el);
  }
  const NOOVERLAP = new Set(['SVG','G','PATH','RECT','CIRCLE','LINE','TEXT','POLYLINE',
    'POLYGON','DEFS','USE','TSPAN','MARKER','PATTERN','ELLIPSE','IMAGE','CANVAS']);
  for (const [p, kids] of byParent) {
    if (NOOVERLAP.has(p.tagName.toUpperCase())) continue;         // SVG children legitimately overlap
    const flow = kids.filter(k => {
      const s = getComputedStyle(k);
      return s.position !== 'absolute' && s.position !== 'fixed' && !NOOVERLAP.has(k.tagName.toUpperCase());
    });
    /* Compare PER LINE BOX, not per bounding box. An inline element that wraps
       across N lines has a getBoundingClientRect() covering all of them, so a
       following inline sibling on the last line sits geometrically inside it
       while looking perfectly fine. That false positive reported 36 overlaps on
       a cluster page whose rows render correctly, and it was nearly filed as a
       real defect. getClientRects() gives the individual line boxes. */
    const rectsOf = e => {
      const rs = [...e.getClientRects()].filter(r => r.width > 0 && r.height > 0);
      return rs.length ? rs : [e.getBoundingClientRect()];
    };
    for (let i = 0; i < flow.length; i++) {
      for (let j = i + 1; j < flow.length; j++) {
        let ox = 0, oy = 0;
        for (const a of rectsOf(flow[i])) {
          for (const b of rectsOf(flow[j])) {
            const px = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const py = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (px > 1 && py > 1 && px * py > ox * oy) { ox = px; oy = py; }
          }
        }
        if (ox > 1 && oy > 1) {
          overlaps.push({
            a: flow[i].tagName.toLowerCase() + '.' + (flow[i].className || '').toString().slice(0, 40),
            b: flow[j].tagName.toLowerCase() + '.' + (flow[j].className || '').toString().slice(0, 40),
            byX: Math.round(ox), byY: Math.round(oy),
            text: (flow[i].textContent || '').trim().slice(0, 50)
          });
        }
      }
    }
  }
  for (const el of all) {
    const p = el.offsetParent;
    if (!p || scrollHost(el)) continue;
    const r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    const padR = parseFloat(cs.paddingRight) || 0;
    const over = r.right - (pr.right - padR);
    if (over > 1) {
      escapes.push({
        el: el.tagName.toLowerCase() + '.' + (el.className || '').toString().slice(0, 40),
        byPx: Math.round(over), text: (el.textContent || '').trim().slice(0, 50)
      });
    }
  }
  return {
    overlaps: overlaps.slice(0, 40), nOverlaps: overlaps.length,
    escapes: escapes.slice(0, 40), nEscapes: escapes.length,
    pageWide: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth
  };
})()`;

/* ---- minimal CDP client over Node's built-in WebSocket ------------------ */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.errors = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiters.has(m.id)) {
        const { resolve, reject } = this.waiters.get(m.id); this.waiters.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params?.exceptionDetails?.exception?.description ||
                         m.params?.exceptionDetails?.text || 'exception');
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('CDP timeout: ' + method)); } }, TIMEOUT);
    });
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'probe-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not report a debug port in 20s')), 20000);
    chrome.stderr.on('data', d => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(t); resolve(m[0]); }
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const browser = new CDP(ws);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  // a session-scoped sender
  const raw = browser.send.bind(browser);
  browser.send = (method, params = {}) => raw(method, params);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++browser.id;
    browser.waiters.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, sessionId, method, params }));
    setTimeout(() => { if (browser.waiters.has(id)) { browser.waiters.delete(id); reject(new Error('timeout ' + method)); } }, TIMEOUT);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  if (THEME !== 'system') {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: THEME }]
    });
  }

  const results = [];
  for (const width of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const route of ROUTES) {
      const url = 'http://localhost:' + PORT + '/' + (route.startsWith('#') ? route : route.replace(/^\//, ''));
      browser.errors.length = 0;
      await send('Page.navigate', { url });
      await sleep(220);
      // hash-only changes do not fire a load, so nudge the router and settle
      await send('Runtime.evaluate', { expression: "location.hash && dispatchEvent(new HashChangeEvent('hashchange'))" }).catch(() => {});
      await sleep(1100);
      let r;
      try {
        const out = await send('Runtime.evaluate',
          { expression: AUDIT, returnByValue: true, awaitPromise: false });
        r = out.result?.value || { error: 'no value' };
      } catch (e) { r = { error: String(e.message) }; }
      r.route = route; r.width = width; r.theme = THEME;
      r.consoleErrors = browser.errors.slice(0, 8);
      results.push(r);
      const tag = (r.nOverlaps || 0) + '/' + (r.nEscapes || 0) + (r.pageWide ? '/PAGEWIDE' : '') +
                  (r.consoleErrors.length ? '/ERR' : '');
      console.log(`  ${String(width).padEnd(5)} ${route.padEnd(42)} overlaps/escapes = ${tag}`);
    }
  }

  for (const spec of SHOTS) {
    const [name, ...rest] = spec.split(':');
    const route = rest.join(':');
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTHS[0], height: 1400, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://localhost:' + PORT + '/' + (route.startsWith('#') ? route : route.replace(/^\//, '')) });
    await sleep(1400);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(name.endsWith('.png') ? name : name + '.png', Buffer.from(data, 'base64'));
    console.log('  shot -> ' + name);
  }

  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));
  /* ESCAPES COUNT AS DEFECTS. An earlier version of this summary ignored them and
     printed "0 with a defect" on a run that had just reported 15 escapes — a
     verification tool that reports green on a known-red case is worse than none. */
  const bad = results.filter(r => (r.nOverlaps || 0) > 0 || (r.nEscapes || 0) > 0 ||
                                  r.pageWide || (r.consoleErrors || []).length || r.error);
  console.log(`\n${results.length} combinations · ${bad.length} with a defect`);
  ws.close(); chrome.kill();
  process.exit(bad.length ? 1 : 0);
}

main().catch(e => { console.error('probe failed:', e.message); process.exit(2); });
