// Shared library for the ADA web fetcher chat-UI app.
// Wraps the Cloudflare-bypassed Chrome session, BFS section traversal, abstract fetching,
// and reference-file parsing — everything the app's HTTP routes need.
//
// Browser lifecycle:
//   start()         — launch Xvfb + Chrome on :9223 if not already up
//   isAlive()       — check CDP health
//   navigate(url)   — Page.navigate + 18s wait; returns {title, throughCloudflare}
//   injectCookies() — set CF cookies on the running Chrome
//   close()         — kill Chrome + Xvfb
//
// Scrape pipeline:
//   collectArticles(issueUrl, issueId, log) — full BFS traversal; returns array of articles
//   filterArticles(arts, regexes, log)      — apply slot regexes
//   fetchAbstract(url)                      — pull single abstract text + figure URLs
//   fetchDisclosure(url)                    — pull disclosure / funding text
//
// All long-running ops accept an optional `log(msg)` callback the chat UI uses to stream
// progress events back to the user.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const delay = ms => new Promise(r => setTimeout(r, ms));

const CDP_PORT = 9223;
const XVFB_DISPLAY = ':99';
const PROFILE_DIR = '/tmp/ada-scraper-profile';

function ensureLinuxRuntime() {
  if (process.platform !== 'linux') {
    throw new Error('Scraper runtime requires Linux tools (Xvfb, chromium-browser, pkill). On Windows, run in WSL or a Linux container.');
  }
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { ...options, stdio: 'ignore', detached: true });
    } catch (e) {
      reject(e);
      return;
    }
    const onError = (err) => reject(err);
    child.once('error', onError);
    child.once('spawn', () => {
      child.removeListener('error', onError);
      child.unref();
      resolve();
    });
  });
}

// ────────────────────────── CDP CLIENT ──────────────────────────
class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('CDP WebSocket error'));
      this.ws.onmessage = (event) => {
        const m = JSON.parse(event.data);
        if (m.id && this.pending.has(m.id)) {
          this.pending.get(m.id)(m);
          this.pending.delete(m.id);
        }
      };
    });
  }
  send(method, params = {}) {
    return new Promise(resolve => {
      const id = ++this.msgId;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, timeout = 60000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout });
    if (r.result?.result?.value !== undefined) return r.result.result.value;
    if (r.result?.exceptionDetails) throw new Error('Eval error: ' + JSON.stringify(r.result.exceptionDetails));
    return null;
  }
  close() { if (this.ws) try { this.ws.close(); } catch {} }
}

// ────────────────────────── BROWSER LIFECYCLE ──────────────────────────
let _cdp = null;

async function isAlive() {
  try {
    const v = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    return v.ok;
  } catch { return false; }
}

async function start(log = () => {}) {
  ensureLinuxRuntime();
  if (await isAlive()) {
    log('Browser already running on :' + CDP_PORT);
    return await connectExisting();
  }
  log('Starting Xvfb + Chrome...');
  try {
    await spawnDetached('Xvfb', [XVFB_DISPLAY, '-screen', '0', '1920x1080x24', '-ac']);
  } catch (e) {
    throw new Error(`Failed to launch Xvfb: ${e.message}`);
  }
  await delay(2000);
  try {
    await spawnDetached('chromium-browser', [
      '--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled',
      `--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${CDP_PORT}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'
    ], { env: { ...process.env, DISPLAY: XVFB_DISPLAY } });
  } catch (e) {
    throw new Error(`Failed to launch chromium-browser: ${e.message}`);
  }
  await delay(4000);
  for (let i = 0; i < 12; i++) {
    if (await isAlive()) break;
    await delay(800);
  }
  if (!(await isAlive())) throw new Error('Chrome failed to start on port ' + CDP_PORT);
  return await connectExisting();
}

async function connectExisting() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No CDP page target found');
  if (_cdp) try { _cdp.close(); } catch {}
  _cdp = new CDPClient(page.webSocketDebuggerUrl);
  await _cdp.connect();
  await _cdp.send('Page.enable');
  await _cdp.send('Network.enable');
  return _cdp;
}

async function close() {
  if (_cdp) try { _cdp.close(); } catch {}
  _cdp = null;
  if (process.platform !== 'linux') return;
  try { execSync('pkill -f "chromium.*9223"', { stdio: 'ignore' }); } catch {}
  try { execSync('pkill -f "Xvfb :99"', { stdio: 'ignore' }); } catch {}
}

// Get the current CDP client (must call start() first)
function cdp() {
  if (!_cdp) throw new Error('Browser not started — call start() first');
  return _cdp;
}

// ────────────────────────── COOKIE INJECTION ──────────────────────────
async function injectCookies(cookieString, log = () => {}) {
  const c = cdp();
  const pairs = cookieString.split(/;\s*/).map(p => {
    const eq = p.indexOf('=');
    return eq < 0 ? null : { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() };
  }).filter(Boolean);
  log(`Injecting ${pairs.length} cookies into scraper Chrome...`);
  for (const { name, value } of pairs) {
    await c.send('Network.setCookie', {
      name, value,
      domain: '.diabetesjournals.org',
      path: '/', secure: true, httpOnly: false, sameSite: 'None'
    });
    await c.send('Network.setCookie', {
      name, value,
      domain: 'diabetesjournals.org',
      path: '/', secure: true, httpOnly: false
    });
  }
  log(`Done. Cookies set: ${pairs.map(p => p.name).join(', ')}`);
}

// ────────────────────────── NAVIGATION + CLOUDFLARE PROBE ──────────────────────────
async function navigate(url, opts = {}) {
  const { waitMs = 18000, log = () => {} } = opts;
  const c = cdp();
  log(`Navigating to ${url}`);
  await c.send('Page.navigate', { url });
  await delay(waitMs);
  let title = await c.evaluate('document.title');
  if (title && title.includes('Just a moment')) {
    log('Cloudflare JS challenge — waiting longer...');
    await delay(15000);
    title = await c.evaluate('document.title');
  }
  const blocked = title === 'Validate User' || title.includes('Just a moment');
  log(`Page title: "${title}"${blocked ? ' (BLOCKED)' : ''}`);
  return { title, throughCloudflare: !blocked };
}

// ────────────────────────── ISSUE-ID DISCOVERY ──────────────────────────
// Click the first .js-cat-toggle and capture the issueId from the XHR URL.
async function discoverIssueId(log = () => {}) {
  const c = cdp();
  // Hook Network events to capture requestWillBeSent for the next ~5s
  await c.send('Network.enable');
  const captured = [];
  const origSend = c.ws.send.bind(c.ws);
  // Use the existing message handler — reuse pending pattern by registering a one-off
  // listener. Since we don't expose it nicely, do it via document.click + a brief wait.
  const result = await c.evaluate(`
    (async function() {
      const a = document.querySelector('.parent-category-container > a.js-cat-toggle[data-id]');
      if (!a) return JSON.stringify({err: 'no js-cat-toggle on page'});
      // Hook fetch to capture URL
      const orig = window.fetch;
      let captured = null;
      window.fetch = function(...args) {
        if (typeof args[0] === 'string' && args[0].includes('IssueChildHeadings')) captured = args[0];
        return orig.apply(this, args);
      };
      a.click();
      await new Promise(r => setTimeout(r, 3500));
      window.fetch = orig;
      if (!captured) return JSON.stringify({err: 'no XHR captured'});
      const m = captured.match(/issueId=(\\d+)/);
      return JSON.stringify({issueId: m ? parseInt(m[1]) : null, url: captured});
    })()
  `);
  const r = JSON.parse(result);
  log(`Issue probe: ${JSON.stringify(r)}`);
  if (r.err) throw new Error('Could not discover issueId: ' + r.err);
  return r.issueId;
}

// ────────────────────────── BFS ARTICLE COLLECTION ──────────────────────────
async function collectArticles(issueUrl, issueId, log = () => {}) {
  const c = cdp();
  log('Collecting top-level sections...');
  const topJson = await c.evaluate(`
    JSON.stringify(Array.from(document.querySelectorAll('.parent-category-container > a.js-cat-toggle[data-id]')).map(a => ({
      id: a.getAttribute('data-id'),
      title: (a.querySelector('h4') || a).textContent.trim()
    })).filter((v, i, arr) => arr.findIndex(x => x.id === v.id) === i))
  `);
  const topSections = JSON.parse(topJson);
  log(`  Found ${topSections.length} top-level sections.`);

  const all = [];
  const seen = new Set();

  for (let i = 0; i < topSections.length; i++) {
    const sec = topSections[i];
    log(`[${i + 1}/${topSections.length}] ${sec.title.substring(0, 60)}`);
    await processSection(c, sec.id, sec.title, issueId, all, seen, log);
  }
  log(`Collected ${all.length} articles total.`);
  return all;
}

async function processSection(c, sectionId, path, issueId, all, seen, log = () => {}) {
  const queue = [{ id: sectionId, path }];
  let nodesVisited = 0;
  let articlesAdded = 0;
  let subsQueued = 0;
  while (queue.length > 0) {
    const cur = queue.shift();
    const data = await fetchHeading(c, cur.id, issueId, log, cur.path);
    nodesVisited++;
    for (const art of data.articles) {
      if (!seen.has(art.url)) {
        seen.add(art.url);
        articlesAdded++;
        all.push({
          ...art,
          url: art.url.startsWith('/') ? 'https://diabetesjournals.org' + art.url : art.url,
          sectionPath: cur.path
        });
      }
    }
    for (const sub of data.subs) {
      subsQueued++;
      queue.push({ id: sub.id, path: cur.path + ' > ' + sub.title });
    }
    await delay(500);
  }
  log(`  → section closed: visited ${nodesVisited} nodes, added ${articlesAdded} articles, queued ${subsQueued} sub-sections.`);
}

// fetchHeading — fetch one heading's child listing.
// Hardened: distinguishes outright HTTP failures from silent zero-result responses
// (Cloudflare may return 200 with a challenge body that has no .al-article-items).
// Retries up to 5x with exponential backoff. The returned object now includes
// {ok, articles, subs, status, attempts} so callers can detect partial-success.
async function fetchHeading(c, headingId, issueId, log = () => {}, sectPath = '') {
  let lastStatus = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await c.evaluate(`
        (async function() {
          const r = await fetch('/diabetes/IssueVolume/MeetingAbstractIssueChildHeadings?headingId=${headingId}&issueId=${issueId}&headingTypeId=2');
          const status = r.status;
          if (!r.ok) return JSON.stringify({articles: [], subs: [], status, error: 'HTTP ' + status});
          const html = await r.text();
          // Cloudflare challenge body never contains .al-article-items but may also
          // not contain .js-cat-toggle. Surface raw length so the caller can
          // distinguish "empty leaf" (small, ~500 bytes) from "challenge page" (10KB+ with cf-* refs).
          const cfMarker = /cloudflare|challenge-platform|just a moment|validate user/i.test(html);
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          const articles = [];
          for (const item of doc.querySelectorAll('.al-article-items')) {
            const t = item.querySelector('h3.item-title a, h5.customLink a, h3 a');
            const a = item.querySelector('.al-authors-list');
            if (t) articles.push({title: t.textContent.trim(), url: t.getAttribute('href') || '', authors: a ? a.textContent.trim() : ''});
          }
          const subs = [];
          for (const tg of doc.querySelectorAll('a.js-cat-toggle[data-id]')) {
            const sid = tg.getAttribute('data-id');
            const h4 = tg.querySelector('h4');
            const stitle = h4 ? h4.textContent.trim() : tg.textContent.trim().substring(0, 80);
            if (sid) subs.push({id: sid, title: stitle});
          }
          return JSON.stringify({articles, subs, status, htmlLen: html.length, cfMarker});
        })()
      `);
      if (!result) {
        await delay(1500 * (attempt + 1));
        continue;
      }
      const parsed = JSON.parse(result);
      lastStatus = parsed.status;
      // Treat a Cloudflare-marked body or an HTTP error as a retry-able failure.
      // A genuinely empty leaf (200, no cfMarker, small html) is fine.
      if (parsed.error || parsed.cfMarker) {
        log(`  ⚠ heading ${headingId} attempt ${attempt + 1}/5 throttled (${parsed.error || 'cf challenge'}, status ${parsed.status}, len ${parsed.htmlLen})`);
        await delay(2500 * (attempt + 1));   // exponential-ish backoff
        continue;
      }
      // Sanity warning if a heading returned 0 articles AND 0 subs AND tiny body —
      // worth logging but not retrying (some leaves really are empty).
      if (parsed.articles.length === 0 && parsed.subs.length === 0 && parsed.htmlLen < 800) {
        log(`  · heading ${headingId} returned 0 articles, 0 subs (htmlLen ${parsed.htmlLen}) — assuming empty leaf at "${sectPath.substring(0, 60)}"`);
      }
      return { ok: true, articles: parsed.articles, subs: parsed.subs, status: parsed.status, attempts: attempt + 1 };
    } catch (e) {
      log(`  ⚠ heading ${headingId} attempt ${attempt + 1}/5 threw: ${e.message}`);
      await delay(2500 * (attempt + 1));
    }
  }
  log(`  ✗ heading ${headingId} FAILED after 5 attempts (last status ${lastStatus}). Section "${sectPath.substring(0, 80)}" may have lost articles.`);
  return { ok: false, articles: [], subs: [], status: lastStatus, attempts: 5 };
}

// ────────────────────────── ABSTRACT FETCH ──────────────────────────
async function fetchAbstract(url) {
  const c = cdp();
  const r = await c.evaluate(`
    (async function() {
      try {
        const resp = await fetch("${url}");
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const content = doc.querySelector('.widget-ArticleFulltext') || doc.querySelector('.article-body') || doc.querySelector('main');
        let text = '';
        if (content) {
          let t = content.innerHTML;
          t = t.replace(/<li[^>]*>/gi, '\\n• ').replace(/<\\/li>/gi, '');
          t = t.replace(/<[^>]+>/g, ' ');
          t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
          t = t.replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n/g, '\\n');
          text = t.trim().substring(0, 8000);
        }
        const figLinks = [];
        for (const a of doc.querySelectorAll('a.fig-view-orig, a.at-figureViewLarge')) {
          const h = a.getAttribute('href') || a.href;
          if (h) figLinks.push(h);
        }
        return JSON.stringify({text, figLinks: [...new Set(figLinks)]});
      } catch(e) { return JSON.stringify({err: e.message}); }
    })()
  `);
  try { return JSON.parse(r); } catch { return { text: '', figLinks: [] }; }
}

async function fetchDisclosure(url) {
  const c = cdp();
  const r = await c.evaluate(`
    (async function() {
      try {
        const resp = await fetch("${url}");
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const body = doc.body?.innerText || doc.body?.textContent || '';
        const dIdx = body.toLowerCase().indexOf('disclosure');
        const fIdx = body.toLowerCase().indexOf('funding');
        const disclosure = dIdx > -1 ? body.substring(dIdx, Math.min(dIdx + 800, body.length)) : '';
        const funding = fIdx > -1 ? body.substring(fIdx, Math.min(fIdx + 300, body.length)) : '';
        return JSON.stringify({disclosure, funding});
      } catch(e) { return JSON.stringify({disclosure: '', funding: ''}); }
    })()
  `);
  try { return JSON.parse(r); } catch { return { disclosure: '', funding: '' }; }
}

// ────────────────────────── FILTERING ──────────────────────────
// regexes: { endpoint, disease, population, trial_type, sponsor, topic_type } — any subset
function applyFilters(article, regexes, fullText = '') {
  const titleAuthors = `${article.title} ${article.authors || ''}`;
  const sectionPath = article.sectionPath || '';
  const allText = `${titleAuthors} ${fullText} ${sectionPath}`;
  for (const [slot, re] of Object.entries(regexes)) {
    if (!re || re === '.*') continue;
    const target = slot === 'topic_type' ? sectionPath : allText;
    if (!new RegExp(re, 'i').test(target)) return false;
  }
  return true;
}

// ────────────────────────── REFERENCE-FILE PARSING ──────────────────────────
// Accepts an HTML or CSV/TSV file containing abstract IDs. Returns deduped array of IDs.
function parseReferenceFile(content, filename = '') {
  const isHtml = /\.html?$/i.test(filename) || /<html|<table|<body/i.test(content);
  const text = isHtml ? content.replace(/<[^>]+>/g, ' ') : content;
  const ids = new Set();
  // Match patterns like 1234-OR, 5678-LB, 999-P, 2989-LB
  const re = /\b(\d{3,4}[-–](?:OR|P|LB|PUB))\b/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1].replace('–', '-'));
  return [...ids].sort();
}

// ────────────────────────── MAP IDs → URLs FROM CACHE ──────────────────────────
function resolveIdsFromCache(ids, cacheJsonPath) {
  if (!fs.existsSync(cacheJsonPath)) return { resolved: {}, missing: ids };
  const cache = JSON.parse(fs.readFileSync(cacheJsonPath, 'utf8'));
  const resolved = {};
  for (const a of cache) {
    const m = a.title.match(/^(\d+[-–][A-Z]+)/);
    if (m && ids.includes(m[1].replace('–', '-'))) {
      resolved[m[1].replace('–', '-')] = a;
    }
  }
  const missing = ids.filter(id => !resolved[id]);
  return { resolved, missing };
}

module.exports = {
  CDP_PORT, PROFILE_DIR,
  isAlive, start, close, cdp,
  injectCookies,
  navigate, discoverIssueId,
  collectArticles,
  fetchAbstract, fetchDisclosure,
  applyFilters,
  parseReferenceFile, resolveIdsFromCache
};
