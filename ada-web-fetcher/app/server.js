// ADA Web Fetcher — chat-UI HTTP server.
// Runs on http://127.0.0.1:8765 (override via $PORT). No external deps; uses Node's built-in
// http + fs. Designed to be reached through Posit Workbench's session-proxy URL.
//
// Endpoints:
//   GET  /                       — chat UI
//   GET  /static/<file>          — serve public/* assets
//   POST /api/parse              — parse free-text → slot dict (rule-based)
//   POST /api/ai/parse           — parse free-text → slot dict (configured AI provider)
//   GET  /api/ai/health          — verify AI backend reachable
//   POST /api/start-session      — create new session, returns sessionId
//   POST /api/run                — body: {sessionId, slots, sourceUrl, mode, ...} kicks off scrape
//   GET  /api/events/:sessionId  — Server-Sent Events stream of scrape progress
//   GET  /api/poll/:sessionId    — short-poll alternative for clients that can't keep SSE open
//   POST /api/cookies            — body: {sessionId, cookies} inject into running browser, resume scrape
//   POST /api/upload-ref         — multipart-ish: body is text content of reference HTML/CSV
//   GET  /api/report/:sessionId  — serve the generated report.html
//   POST /api/cancel             — kill the scrape + browser

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const synonyms = require('./lib/synonyms');
const scraper = require('./lib/scraper');
const report = require('./lib/report');
const ai = require('./lib/ai_client');

const PORT = parseInt(process.env.PORT || '9876', 10);
const HOST = process.env.HOST || '127.0.0.1';
const APP_ROOT = __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const RUNS_DIR = path.join(APP_ROOT, 'runs');
const PROJECT_ROOT = path.dirname(APP_ROOT);

// In-memory sessions. Each session: { id, state, slots, sourceUrl, mode, log[], sseClients[], result, ... }
const sessions = new Map();
function newSessionId() {
  return 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Known investigational/marketed compounds that show up in ADA abstract titles.
// Used in two places: (a) tagging matched articles for the report's compound tabs,
// and (b) seeding the reverse-search pass — articles whose titles mention any of
// these compounds become candidates for an extra abstract-level recovery check.
// Adding a new molecule? Append it here and it's picked up everywhere.
const KNOWN_COMPOUNDS_RE = /\b(Mazdutide|Tirzepatide|Semaglutide|Dorzagliatin|HRS\d+|HDM\d+|IBI\d+|GZR\d+|MDR-\d+|Ribupatide|Utreglutide|Ecnoglutide|Bofanglutide|Anagliptin|Clofutriben|Efsitora|Elecoglipron|Zenagamtide|GL\d+|PG-\d+|HR\d+)\b/gi;

// Extract all distinct compound names mentioned in a piece of text.
// Returns canonical names (first-letter-capitalized) so downstream grouping
// doesn't treat "Semaglutide" and "semaglutide" as different compounds.
function extractCompounds(text) {
  if (!text) return [];
  const out = new Set();
  let m;
  // Reset lastIndex because the regex uses /g — defensive when reused.
  KNOWN_COMPOUNDS_RE.lastIndex = 0;
  while ((m = KNOWN_COMPOUNDS_RE.exec(text)) !== null) {
    // Canonicalize: any name that is all-caps (with optional internal hyphens
    // and trailing digits, e.g. PG-102, HR17031, IBI3032) keeps its case.
    // Mixed-case scientific names (Semaglutide, Mazdutide) are titlecased to
    // fold semaglutide/Semaglutide variants.
    const name = m[1];
    const isCodeLike = /^[A-Z]+(?:[-–][A-Z0-9]+)*\d*$/.test(name) && /\d/.test(name);
    const canon = isCodeLike ? name.toUpperCase() : (name.charAt(0).toUpperCase() + name.slice(1).toLowerCase());
    out.add(canon);
  }
  return [...out];
}

// Helper for the reverse-search pass: given the full article cache, the set of
// already-matched URLs, and a regex matching the seed compounds, return all
// non-matched articles whose title mentions a seed compound. Used as the
// "candidates to abstract-check" pool for reverse search.
function articles_pool_for_reverse(allArticles, matchedSet, seedRe) {
  const pool = [];
  for (const a of allArticles) {
    if (matchedSet.has(a.url)) continue;
    if (seedRe.test(a.title || '')) pool.push(a);
  }
  return pool;
}

// ───────────────────────── HTTP HELPERS ─────────────────────────
function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer ? body : (typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': isBuffer || typeof body === 'string' ? (headers['Content-Type'] || 'text/plain; charset=utf-8') : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(buf.toString('utf8') || '{}')); }
        catch (e) { reject(e); }
      } else {
        resolve(buf.toString('utf8'));
      }
    });
    req.on('error', reject);
  });
}
function logToSession(session, msg) {
  const entry = { ts: Date.now(), type: 'log', msg };
  session.log.push(entry);
  for (const client of session.sseClients) {
    try { client.write(`data: ${JSON.stringify(entry)}\n\n`); }
    catch {}
  }
}
function sseEvent(session, type, payload) {
  const evt = { ts: Date.now(), type, ...payload };
  session.log.push(evt);
  for (const client of session.sseClients) {
    try { client.write(`data: ${JSON.stringify(evt)}\n\n`); }
    catch {}
  }
}

// ───────────────────────── ROUTES ─────────────────────────

async function routeStaticOrIndex(req, res, parsed) {
  let filePath;
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (parsed.pathname.startsWith('/static/')) {
    filePath = path.join(PUBLIC_DIR, parsed.pathname.slice('/static/'.length));
  } else {
    return send(res, 404, 'Not found');
  }
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const ct = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }[ext] || 'text/plain';
    send(res, 200, data, { 'Content-Type': ct });
  } catch (e) {
    send(res, 404, `Not found: ${parsed.pathname}`);
  }
}

async function routeParse(req, res) {
  const body = await readBody(req);
  const text = body.text || '';
  const parsed = synonyms.parseFreeText(text);
  const userSynonyms = synonyms.parseUserSynonyms(text);
  send(res, 200, {
    slots: parsed,
    userSynonyms,
    humanReadable: synonyms.humanReadable(parsed),
    available: synonyms.SLOTS,
    order: synonyms.SLOT_ORDER
  });
}

// AI-powered free-text → slots parse, via the configured provider.
// Falls back to the rule-based path on any failure so the chat never hangs.
async function routeAIParse(req, res) {
  const body = await readBody(req);
  const text = body.text || '';

  // Build the JSON Schema dynamically from the synonyms registry — keeps
  // the AI parser locked to the same slot vocabulary as the rule-based one.
  const properties = {};
  for (const slotName of synonyms.SLOT_ORDER) {
    const slot = synonyms.SLOTS[slotName];
    properties[slotName] = {
      type: ['string', 'null'],
      enum: [...Object.keys(slot.options), null],
      description: `${slot.label}. ${slot.hint}. Use null if the user didn't specify.`
    };
  }
  const schema = { type: 'object', properties, required: synonyms.SLOT_ORDER };

  let aiSlots = {};
  let aiError = null;
  try {
    aiSlots = await ai.chatJSON({
      model: ai.MODEL_HAIKU,
      max_tokens: 1024,
      system: 'You parse user requests for medical literature scraping into structured filter slots. Map natural language to the canonical slot keys. Set a slot to null when the user did not specify a value for it; do not invent filters. Examples: "T2D Phase 2/3 RCTs in Chinese patients" → endpoint:null, disease:t2d, population:chinese, trial_type:phase23_rct, sponsor:null, topic_type:null. "weight loss in obese adolescents" → endpoint:weight, disease:obesity, population:adolescent, trial_type:null, sponsor:null, topic_type:null.',
      prompt: text,
      schema,
      description: 'Map the user request to filter slots; null for unspecified slots.'
    });
    // Strip nulls so the front-end's "ask if missing" logic still triggers
    aiSlots = Object.fromEntries(Object.entries(aiSlots).filter(([_, v]) => v != null));
  } catch (e) {
    aiError = e.message;
    // Fall back to rule-based
    aiSlots = synonyms.parseFreeText(text);
  }
  // User-supplied synonyms are parsed locally with a regex — AI slot
  // mapping handles the canonical keys; we still want to capture the
  // "(syn1; syn2)" lists verbatim because they're user-authored regex
  // augmentations, not interpretation tasks.
  const userSynonyms = synonyms.parseUserSynonyms(text);
  send(res, 200, {
    slots: aiSlots,
    userSynonyms,
    humanReadable: synonyms.humanReadable(aiSlots),
    available: synonyms.SLOTS,
    order: synonyms.SLOT_ORDER,
    aiError,                // null on success; populated on fallback
    parser: aiError ? 'rule-based (fallback)' : `ai (${ai.PROVIDER})`,
    aiNotice: aiError && ai.PROVIDER === 'copilot_business'
      ? `Copilot bridge AI parse unavailable (${aiError}). Falling back to rule-based parse. If needed, run prompt ${ai.COPILOT_PROMPT_HINT} in Copilot Chat.`
      : null
  });
}

async function routeAIHealth(req, res) {
  const h = await ai.healthCheck();
  send(res, h.ok ? 200 : 503, h);
}

function routeStart(req, res) {
  const id = newSessionId();
  const session = {
    id, state: 'init',
    slots: {}, sourceUrl: '', mode: 'prompt',
    log: [], sseClients: [],
    result: null,
    startedAt: Date.now()
  };
  sessions.set(id, session);
  send(res, 200, { sessionId: id });
}

async function routeUploadRef(req, res) {
  const sid = req.headers['x-session-id'];
  const session = sessions.get(sid);
  if (!session) return send(res, 404, { error: 'session not found' });
  const body = await readBody(req);
  const content = typeof body === 'string' ? body : (body.content || '');
  const filename = req.headers['x-filename'] || 'ref.html';
  const ids = scraper.parseReferenceFile(content, filename);
  session.referenceIds = ids;
  session.referenceFilename = filename;
  session.mode = 'reference';
  logToSession(session, `Reference file '${filename}' parsed: ${ids.length} abstract IDs found.`);
  send(res, 200, { ids, count: ids.length });
}

function routeEvents(req, res, parsed) {
  const sid = parsed.pathname.split('/').pop();
  const session = sessions.get(sid);
  if (!session) return send(res, 404, 'session not found');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // Posit Workbench's nginx session-proxy buffers chunked responses by default,
    // which holds every event until the scrape ends. This header tells nginx to
    // pass bytes through unbuffered. Pair with the 2 KiB padding below to defeat
    // any other intermediate buffer (some have a fixed-size watermark).
    'X-Accel-Buffering': 'no'
  });
  // 2 KiB of padding + an immediate flush kicks the stream open through any
  // stubborn intermediary buffer (some proxies hold the first N bytes regardless).
  res.write(`: ${' '.repeat(2048)}\n\n`);
  res.write(`data: ${JSON.stringify({ ts: Date.now(), type: 'log', msg: 'stream connected' })}\n\n`);
  // Replay existing log
  for (const entry of session.log) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  if (session.state === 'done') {
    res.write(`data: ${JSON.stringify({ type: 'done', reportUrl: `/api/report/${sid}` })}\n\n`);
  }
  if (session.state === 'awaiting_cookies') {
    res.write(`data: ${JSON.stringify({ type: 'awaiting_cookies', sourceUrl: session.sourceUrl })}\n\n`);
  }
  // Heartbeat every 15 s — keeps the proxy from closing the idle stream and
  // gives the browser something to confirm the connection is alive.
  const hb = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch {}
  }, 15000);
  session.sseClients.push(res);
  req.on('close', () => {
    clearInterval(hb);
    session.sseClients = session.sseClients.filter(c => c !== res);
  });
}

// Short-polling alternative for clients that can't keep an SSE connection open
// (R/Shiny). GET /api/poll/:sessionId?cursor=N returns events with idx >= cursor
// plus the next cursor to use, plus current state.
function routePoll(req, res, parsed) {
  const sid = parsed.pathname.split('/').pop();
  const session = sessions.get(sid);
  if (!session) return send(res, 404, { error: 'session not found' });
  const cursor = parseInt(parsed.query.cursor || '0', 10);
  const events = session.log.slice(cursor);
  send(res, 200, {
    cursor: session.log.length,
    state: session.state,
    events,
    reportUrl: session.state === 'done' ? `/api/report/${sid}` : null,
    awaitingCookies: session.state === 'awaiting_cookies' ? session.sourceUrl : null
  });
}

async function routeRun(req, res) {
  const body = await readBody(req);
  const session = sessions.get(body.sessionId);
  if (!session) return send(res, 404, { error: 'session not found' });
  // userSynonyms is the parsed-out "(syn1; syn2)" map from the user's prompt.
  // It augments — doesn't replace — the built-in slot regex via slotsToRegexes().
  // Passed by the UI; can be empty/missing for non-prompt flows.
  Object.assign(session, {
    slots: body.slots || session.slots,
    userSynonyms: body.userSynonyms || {},
    sourceUrl: body.sourceUrl || session.sourceUrl,
    generateTable: body.generateTable !== false,  // default true
    aiMode: body.aiMode === true,                 // default false
    mode: body.mode || session.mode || 'prompt'
  });
  session.state = 'running';
  send(res, 200, { ok: true });
  // Run async — the SSE stream pushes progress
  runScrape(session).catch(err => {
    logToSession(session, `FATAL: ${err.message}`);
    sseEvent(session, 'error', { message: err.message });
    session.state = 'failed';
  });
}

async function routeCookies(req, res) {
  const body = await readBody(req);
  const session = sessions.get(body.sessionId);
  if (!session) return send(res, 404, { error: 'session not found' });
  if (session.state !== 'awaiting_cookies') return send(res, 400, { error: 'not awaiting cookies' });
  try {
    await scraper.injectCookies(body.cookies, msg => logToSession(session, msg));
    session.state = 'running';
    sseEvent(session, 'cookies_accepted', {});
    send(res, 200, { ok: true });
    // Resume the navigation
    if (session._resumeFn) session._resumeFn();
  } catch (e) {
    logToSession(session, `Cookie inject failed: ${e.message}`);
    send(res, 500, { error: e.message });
  }
}

async function routeReport(req, res, parsed) {
  const sid = parsed.pathname.split('/').pop();
  const session = sessions.get(sid);
  if (!session) return send(res, 404, 'session not found');
  if (session.state !== 'done' || !session.result) return send(res, 425, 'report not ready');
  const fp = session.result.reportPath;
  if (!fs.existsSync(fp)) return send(res, 500, 'report file missing');
  const html = fs.readFileSync(fp);
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

function routeCancel(req, res) {
  readBody(req).then(async body => {
    const session = sessions.get(body.sessionId);
    if (session) session.state = 'cancelled';
    await scraper.close();
    send(res, 200, { ok: true });
  });
}

// ───────────────────────── SCRAPE ORCHESTRATION ─────────────────────────
async function runScrape(session) {
  const log = msg => logToSession(session, msg);
  const sourceUrl = session.sourceUrl || 'https://diabetesjournals.org/diabetes/issue/75/Supplement_1';
  const runDir = path.join(RUNS_DIR, session.id);
  fs.mkdirSync(runDir, { recursive: true });

  log(`Source: ${sourceUrl}`);
  log(`Mode: ${session.mode}`);
  log(`Filters: ${synonyms.humanReadable(session.slots) || '(no filters — all articles)'}`);

  // 1. Start browser
  await scraper.start(log);
  // 2. Navigate
  let nav = await scraper.navigate(sourceUrl, { log });
  if (!nav.throughCloudflare) {
    // Pause for cookie injection
    log('⚠ Cloudflare blocked. Waiting for you to provide cookies via the chat UI...');
    session.state = 'awaiting_cookies';
    sseEvent(session, 'awaiting_cookies', { sourceUrl });
    await new Promise(resolve => { session._resumeFn = resolve; });
    log('Cookies injected — re-navigating...');
    nav = await scraper.navigate(sourceUrl, { log });
    if (!nav.throughCloudflare) throw new Error('Still blocked after cookie injection. The cookies may have expired or be wrong.');
  }

  // 3. Discover issueId
  const issueId = await scraper.discoverIssueId(log);
  log(`Discovered issueId = ${issueId}`);

  // 4. Reference vs prompt mode
  let articles;
  if (session.mode === 'reference' && session.referenceIds?.length) {
    log(`Reference mode: looking up ${session.referenceIds.length} abstract IDs.`);
    // For reference mode, we still need to traverse to get URLs, OR we can try direct URL probing.
    // Simplest: traverse, then filter by ID. Cache speed-up if we have it from a recent scrape.
    const cachePath = path.join(PROJECT_ROOT, 'all_articles_cache.json');
    let allArts;
    if (fs.existsSync(cachePath)) {
      allArts = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      log(`Loaded ${allArts.length} articles from cache.`);
    } else {
      allArts = await scraper.collectArticles(sourceUrl, issueId, log);
      if (allArts.length >= 1500) {
        fs.writeFileSync(cachePath, JSON.stringify(allArts));
        log(`Saved cache (${allArts.length} articles).`);
      }
    }
    const refSet = new Set(session.referenceIds);
    articles = [];
    for (const a of allArts) {
      const m = a.title.match(/^(\d+[-–][A-Z]+)/);
      if (m && refSet.has(m[1].replace('–', '-'))) articles.push(a);
    }
    log(`Matched ${articles.length}/${session.referenceIds.length} reference IDs from cache.`);
    const missing = session.referenceIds.filter(id => !articles.some(a => a.title.match(/^(\d+[-–][A-Z]+)/)?.[1].replace('–', '-') === id));
    if (missing.length) log(`Missing IDs (not in published supplement): ${missing.join(', ')}`);
  } else {
    // Prompt mode — port skill.md's two-pass filter (lines 68–82 of skill.md):
    //   Pass 1: title/authors match. The "anchor slot" (the one most likely
    //           appearing in the title) MUST hit at the title level — it's the
    //           cheap gate that scopes the work-set. In skill.md the anchor was
    //           T2D; we generalize to "disease if set, else endpoint, else
    //           population". Remaining slots may match title OR abstract.
    //   Pass 2: for the title-anchor matches that don't yet satisfy ALL slots
    //           in title/authors, fetch the abstract (cap 100, 1.5 s delay)
    //           and re-check against full text. Mirrors skill.md verbatim.
    // The previous implementation required ALL slots in the title at once —
    // brittle: e.g. "HbA1c + Chinese + Phase 2/3" had 0 titles satisfying all
    // three even though the cache contained dozens of qualifying studies.
    const cachePath = path.join(PROJECT_ROOT, 'all_articles_cache.json');
    if (fs.existsSync(cachePath)) {
      articles = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      log(`Loaded ${articles.length} articles from cache (skipping re-traversal).`);
    } else {
      articles = await scraper.collectArticles(sourceUrl, issueId, log);
      if (articles.length >= 1500) {
        fs.writeFileSync(cachePath, JSON.stringify(articles));
        log(`Saved cache (${articles.length} articles).`);
      }
    }
    const regexes = synonyms.slotsToRegexes(session.slots, session.userSynonyms || {});
    const slotNames = Object.keys(regexes);
    const userSynKeys = Object.keys(session.userSynonyms || {}).filter(k => (session.userSynonyms[k] || []).length > 0);
    if (userSynKeys.length) {
      log(`Filters active: ${slotNames.join(', ') || '(none)'}  (+ user synonyms on: ${userSynKeys.join(', ')})`);
    } else {
      log(`Filters active: ${slotNames.join(', ') || '(none)'}`);
    }

    if (slotNames.length === 0) {
      log('No filters set — keeping all articles (capped at 200).');
      articles = articles.slice(0, 200);
    } else {
      // Snapshot the full cache before any reassignment — reverse search needs
      // it to scan the eliminated pool.
      const allCachedArticles = articles;
      // Pick the anchor slot — disease > endpoint > population > whatever's left.
      // Anchor's regex must hit the title/authors; the title is the cheap gate.
      const anchorPriority = ['disease', 'endpoint', 'population', 'trial_type', 'sponsor', 'topic_type'];
      const anchor = anchorPriority.find(s => slotNames.includes(s)) || slotNames[0];
      log(`Anchor slot for title gate: ${anchor}`);
      const anchorRe = new RegExp(regexes[anchor], 'i');
      const otherSlots = slotNames.filter(s => s !== anchor);

      // Pass 1: title/authors match. Split into:
      //   directMatches  — anchor + ALL other slots already satisfied at title level
      //   needAbstract   — anchor matches title, but at least one other slot did not
      const directMatches = [];
      const needAbstract = [];
      for (const a of articles) {
        const titleText = `${a.title} ${a.authors || ''} ${a.sectionPath || ''}`;
        if (!anchorRe.test(titleText)) continue;
        const allOthersHit = otherSlots.every(s => {
          const target = s === 'topic_type' ? (a.sectionPath || '') : titleText;
          return new RegExp(regexes[s], 'i').test(target);
        });
        if (allOthersHit) directMatches.push(a);
        else needAbstract.push(a);
      }
      log(`Title-anchor pass: ${directMatches.length} direct matches, ${needAbstract.length} need abstract check.`);

      // Pass 2: abstract check for the deferred set. No cap — every candidate
      // that passed the title-anchor gate gets its abstract fetched. 1.5 s
      // delay between requests per skill.md to stay under Cloudflare's rate
      // limit. With ~400 candidates this is ~10 min; with the typical anchor
      // narrowing it down, runs are usually well under that.
      // Abstracts fetched here are also cached and reused by the reverse-search
      // pass below (no double-fetching).
      const abstractCache = new Map();   // url → { text, figLinks }
      const abstractMatches = [];
      const ABSTRACT_DELAY_MS = 1500;
      const toCheck = needAbstract;
      log(`Abstract pass: checking all ${toCheck.length} deferred candidates (no cap, ~${Math.round(toCheck.length * ABSTRACT_DELAY_MS / 1000 / 60)} min).`);
      for (let i = 0; i < toCheck.length; i++) {
        if ((i + 1) % 5 === 0) {
          sseEvent(session, 'progress', { stage: 'abstracts', done: i + 1, total: toCheck.length });
          log(`  abstract check ${i + 1}/${toCheck.length}...`);
        }
        const art = toCheck[i];
        const ab = await scraper.fetchAbstract(art.url);
        abstractCache.set(art.url, ab);
        const fullText = `${art.title} ${art.authors || ''} ${ab.text || ''} ${art.sectionPath || ''}`;
        const allHit = otherSlots.every(s => {
          const target = s === 'topic_type' ? (art.sectionPath || '') : fullText;
          return new RegExp(regexes[s], 'i').test(target);
        });
        if (allHit) {
          art.abstractSnippet = (ab.text || '').substring(0, 400);
          art.figLinks = ab.figLinks;
          abstractMatches.push(art);
        }
        await new Promise(r => setTimeout(r, ABSTRACT_DELAY_MS));
      }
      log(`Abstract pass: ${abstractMatches.length} additional matches.`);
      articles = [...directMatches, ...abstractMatches];
      log(`Final filtered set: ${articles.length} articles.`);

      // Hydrate abstractSnippet/figLinks for direct matches too (vision curation needs figLinks)
      const directNeedingHydration = directMatches.filter(a => !a.figLinks || a.figLinks.length === 0);
      if (directNeedingHydration.length > 0 && directNeedingHydration.length <= 50) {
        log(`Hydrating ${directNeedingHydration.length} direct matches with abstract+figures...`);
        for (let i = 0; i < directNeedingHydration.length; i++) {
          const art = directNeedingHydration[i];
          const ab = await scraper.fetchAbstract(art.url);
          abstractCache.set(art.url, ab);
          art.abstractSnippet = (ab.text || '').substring(0, 400);
          art.figLinks = ab.figLinks;
          await new Promise(r => setTimeout(r, ABSTRACT_DELAY_MS));
        }
      }

      // ─── Pass 3: reverse search ───
      // The two passes above gate on the title anchor; an article whose title
      // misses the anchor regex is invisible to them. This pass recovers
      // compound-named studies missed that way:
      //   1. Extract every distinctive compound name from the matched articles
      //      (titles + abstract snippets) → seed set, e.g. {Mazdutide, IBI362}.
      //   2. Find articles NOT in the matched set whose titles mention any
      //      seed compound — these are eliminated-but-domain-relevant.
      //   3. For each, fetch the abstract and keep it if the abstract+title
      //      satisfies all NON-anchor slot regexes. Anchor is treated as
      //      satisfied by the compound match (compound-name presence is a
      //      strong domain-relevance signal — strong enough to substitute for
      //      a "T2D" or "HbA1c" keyword that the title may have phrased
      //      differently or implicitly).
      // Reuses abstractCache to avoid re-fetching abstracts already pulled
      // in pass 2 (rare but possible if a compound article passed the
      // title-anchor gate but failed pass 2 on a different slot).
      const matchedSet = new Set(articles.map(a => a.url));
      const seeds = new Set();
      for (const art of articles) {
        for (const c of extractCompounds(art.title)) seeds.add(c);
        if (art.abstractSnippet) {
          for (const c of extractCompounds(art.abstractSnippet)) seeds.add(c);
        }
      }
      if (seeds.size === 0) {
        log('Reverse-search skipped: no compound seeds extracted from matched articles.');
      } else {
        const seedRe = new RegExp('\\b(' + [...seeds].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
        log(`Reverse-search seeds (${seeds.size}): ${[...seeds].join(', ')}`);
        const candidates = articles_pool_for_reverse(allCachedArticles, matchedSet, seedRe);

        // Reverse search has no cap — every compound-bearing eliminated article gets
        // its abstract checked. With ~50–100 compound mentions across the cache and
        // 1.5 s per fetch, this typically adds 1–3 min to the run. The compound-name
        // pre-screen is what bounds it, not an arbitrary cap.
        log(`Reverse-search pass: ${candidates.length} compound-bearing candidates to check (~${Math.round(candidates.length * 1.5 / 60)} min).`);

        const recovered = [];
        for (let i = 0; i < candidates.length; i++) {
          if ((i + 1) % 5 === 0) {
            sseEvent(session, 'progress', { stage: 'reverse_search', done: i + 1, total: candidates.length });
            log(`  reverse check ${i + 1}/${candidates.length}...`);
          }
          const art = candidates[i];
          let ab = abstractCache.get(art.url);
          if (!ab) {
            ab = await scraper.fetchAbstract(art.url);
            abstractCache.set(art.url, ab);
            await new Promise(r => setTimeout(r, ABSTRACT_DELAY_MS));
          }
          const fullText = `${art.title} ${art.authors || ''} ${ab.text || ''} ${art.sectionPath || ''}`;
          // Check ALL non-anchor slots against the full text. The anchor itself
          // is intentionally relaxed — compound-name presence stands in for it.
          const passes = otherSlots.every(s => {
            const target = s === 'topic_type' ? (art.sectionPath || '') : fullText;
            return new RegExp(regexes[s], 'i').test(target);
          });
          if (passes) {
            art.abstractSnippet = (ab.text || '').substring(0, 400);
            art.figLinks = ab.figLinks;
            art.recoveredViaReverseSearch = true;
            recovered.push(art);
          }
        }
        log(`Reverse-search pass: ${recovered.length} recovered from ${candidates.length} candidates.`);
        articles = [...articles, ...recovered];
        log(`Final set after reverse search: ${articles.length} articles.`);
      }
    }
  }

  // 5. Tag every matched article with its compound (extracted from title +
  //    abstract snippet) BEFORE the optional vision step. This ensures the
  //    final report can sub-categorize by compound under each company tab
  //    even when AI mode is off (no vision curation).
  for (const art of articles) {
    if (!art.compound) {
      const text = `${art.title || ''} ${art.abstractSnippet || ''}`;
      const found = extractCompounds(text);
      if (found.length) art.compound = found[0];
    }
  }

  // 6. Fetch disclosures for the final set (caps at 50 to avoid runaway)
  if (articles.length > 0 && articles.length <= 50) {
    log(`Fetching disclosure/funding for ${articles.length} articles...`);
    for (let i = 0; i < articles.length; i++) {
      if ((i + 1) % 5 === 0) sseEvent(session, 'progress', { stage: 'disclosure', done: i + 1, total: articles.length });
      const d = await scraper.fetchDisclosure(articles[i].url);
      articles[i].disclosure = d.disclosure;
      articles[i].funding = d.funding;
      // Tag company from funding text if available
      if (d.funding) {
        const fmatch = /(Eli Lilly|Novo Nordisk|Sanofi|AstraZeneca|Innovent|Hengrui|Hua Medicine|Hansoh|Tonghua Dongbao|Sciwind|Eccogene|HighTide|Bayer|Merck|Pfizer|Boehringer|Huadong)/i.exec(d.funding);
        if (fmatch) articles[i].company = fmatch[1];
      }
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // 7. Curate efficacy data from figures + abstract text (only when AI mode is on)
  let dataRows = [];
  if (session.generateTable && session.aiMode && articles.length > 0) {
    const aiHealth = await ai.healthCheck();
    if (!aiHealth.ok) {
      log(`AI curation unavailable: ${aiHealth.error}`);
      if (ai.PROVIDER === 'copilot_business') {
        log(`Tip: start the local Copilot bridge extension in VS Code, then retry. You can also use prompt ${ai.COPILOT_PROMPT_HINT} in Copilot Chat as a manual fallback.`);
      }
    } else {
      log(`Curating efficacy data from figures + abstracts (${articles.length} articles)...`);
      const figDir = path.join(runDir, 'figs');
      fs.mkdirSync(figDir, { recursive: true });
      dataRows = await curateEfficacyData(articles, figDir, session, log);
      log(`Curated ${dataRows.length} treatment-arm rows from ${new Set(dataRows.map(r => r.study_ind)).size} studies.`);
    }
  } else if (session.generateTable && !session.aiMode) {
    log('Data table requested but AI mode is off — skipping curation (no rows extracted).');
  }

  // 7. Generate report
  log('Generating report...');
  const reportHtml = report.generateReport({
    articles,
    dataRows,
    meta: {
      title: `ADA Web Fetcher Report — ${session.mode === 'reference' ? 'Reference IDs' : 'Filtered Search'}`,
      subtitle: synonyms.humanReadable(session.slots) || 'No filters applied',
      sourceUrl,
      generatedAt: new Date().toISOString().split('T')[0]
    }
  });
  const reportPath = path.join(runDir, 'report.html');
  fs.writeFileSync(reportPath, reportHtml);
  fs.writeFileSync(path.join(runDir, 'articles.json'), JSON.stringify(articles, null, 2));
  if (dataRows.length > 0) {
    fs.writeFileSync(path.join(runDir, 'data.csv'), report.generateCSV(Object.keys(dataRows[0]), dataRows));
  }

  session.result = { reportPath, articleCount: articles.length, dataRowCount: dataRows.length };
  session.state = 'done';
  log(`Report ready: ${articles.length} articles, ${dataRows.length} curated rows. Click 'View Report' to open.`);
  sseEvent(session, 'done', { reportUrl: `/api/report/${session.id}`, articleCount: articles.length, dataRowCount: dataRows.length });
}

// ─────── AI curation schemas ───────
// Schema for one efficacy datapoint extracted from a figure.
const CURATION_SCHEMA = {
  type: 'object',
  properties: {
    arms: {
      type: 'array',
      description: 'One row per treatment arm in the figure. Include placebo and active comparators. Empty array if the figure has no extractable efficacy data.',
      items: {
        type: 'object',
        properties: {
          treat:    { type: 'string',                    description: 'Full arm label (dose + drug + frequency, or "Placebo")' },
          n:        { type: ['integer', 'null'],         description: 'Sample size, null if not reported' },
          y:        { type: ['number', 'null'],          description: 'Primary endpoint change from baseline (HbA1c %, weight %, etc.). Negative for reductions.' },
          se:       { type: ['number', 'null'],          description: 'Standard error of y; or SD if SE not given. null if neither reported.' },
          base:     { type: ['number', 'null'],          description: 'Baseline value of the endpoint per-arm; null if only overall reported' },
          weeks:    { type: ['integer', 'null'],         description: 'Endpoint timepoint in weeks; null if not in figure' },
          notes:    { type: 'string',                    description: 'Per-arm notes: data type (LSM±SE / Mean±SD), CIs, p-values, etc. Brief.' }
        },
        required: ['treat']
      }
    },
    studyName: { type: 'string', description: 'Trial alias (SURPASS-CN-INS, DREAMS-1, etc.) if visible in the figure or its caption; otherwise empty string.' },
    phase:     { type: 'string', description: 'Trial phase if visible (Phase 2, Phase 3, etc.); empty string if not.' },
    primaryEndpoint: { type: 'string', description: 'What y measures (HbA1c %, body weight %, FPG mmol/L, etc.).' },
    figureNotes:     { type: 'string', description: 'Anything notable about the figure: data quality, ambiguities, or "not an efficacy figure" (e.g. AE table, Kaplan-Meier curve, etc.).' }
  },
  required: ['arms', 'studyName', 'phase', 'primaryEndpoint', 'figureNotes']
};

// Schema for one efficacy datapoint extracted from abstract free text.
const ABSTRACT_CURATION_SCHEMA = {
  type: 'object',
  properties: {
    arms: {
      type: 'array',
      description: 'One row per treatment arm with explicit numeric efficacy values found in the abstract text. Empty array if the abstract has no extractable efficacy values.',
      items: {
        type: 'object',
        properties: {
          treat:    { type: 'string',                    description: 'Full treatment arm label (dose + drug + frequency, or placebo/comparator label) as written or directly implied by nearby text.' },
          n:        { type: ['integer', 'null'],         description: 'Sample size for this arm, null if not reported' },
          y:        { type: ['number', 'null'],          description: 'Primary endpoint change/result for this arm (HbA1c %, body weight %, etc.). Use null if no numeric value is stated for this arm.' },
          se:       { type: ['number', 'null'],          description: 'SE or SD for y when explicitly reported; null otherwise.' },
          base:     { type: ['number', 'null'],          description: 'Baseline endpoint value for this arm if explicitly reported; null otherwise.' },
          weeks:    { type: ['integer', 'null'],         description: 'Timepoint in weeks if explicitly reported; null otherwise.' },
          notes:    { type: 'string',                    description: 'Brief notes with exact phrasing cues (e.g., CI/p-value/statistical qualifiers).' }
        },
        required: ['treat']
      }
    },
    studyName: { type: 'string', description: 'Trial alias if stated in title/abstract; otherwise empty string.' },
    phase:     { type: 'string', description: 'Trial phase if explicitly present; empty string if absent.' },
    primaryEndpoint: { type: 'string', description: 'What y measures (HbA1c %, body weight %, FPG mmol/L, etc.).' },
    abstractNotes:   { type: 'string', description: 'Explain extraction confidence, missing values, or why no efficacy values were extractable.' }
  },
  required: ['arms', 'studyName', 'phase', 'primaryEndpoint', 'abstractNotes']
};

function normalizeRowKeyPart(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (Number.isFinite(n)) return n.toString();
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

function dedupeRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = [
      normalizeRowKeyPart(row.treat),
      normalizeRowKeyPart(row.n),
      normalizeRowKeyPart(row.y),
      normalizeRowKeyPart(row.se),
      normalizeRowKeyPart(row.base),
      normalizeRowKeyPart(row.weeks),
      normalizeRowKeyPart(row.Phase),
      normalizeRowKeyPart(row.study)
    ].join('|');
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, { ...row });
      continue;
    }
    if (row.source && prior.source && row.source !== prior.source) {
      const mergedSource = new Set(
        `${prior.source},${row.source}`.split(',').map(s => s.trim()).filter(Boolean)
      );
      prior.source = [...mergedSource].join(',');
    }
    if (row.comments && prior.comments && !prior.comments.includes(row.comments)) {
      prior.comments = `${prior.comments} | ${row.comments}`;
    }
  }
  return [...byKey.values()];
}

function mapResultArmsToRows(result, { compound, abstractId, fallbackPhase, sourceTag, articleUrl }) {
  const rows = [];
  for (const arm of (result.arms || [])) {
    rows.push({
      abstract_id: abstractId,
      compound,
      treat: arm.treat,
      n: arm.n != null ? arm.n : '',
      y: arm.y != null ? arm.y : '',
      se: arm.se != null ? arm.se : '',
      base: arm.base != null ? arm.base : '',
      weeks: arm.weeks != null ? arm.weeks : '',
      Phase: result.phase || fallbackPhase || '',
      study: result.studyName || abstractId,
      source: sourceTag,
      comments: [arm.notes, result.primaryEndpoint, articleUrl].filter(Boolean).join('; ')
    });
  }
  return rows;
}

async function hydrateAbstractContext(art) {
  const ab = await scraper.fetchAbstract(art.url);
  art.abstractText = ab.text || '';
  art.abstractSnippet = (ab.text || '').substring(0, 400);
  art.figLinks = ab.figLinks || [];
  return ab;
}

async function curateEfficacyData(articles, figDir, session, log) {
  const allRows = [];
  let studyInd = 0;
  let figIdx = 0;
  for (const art of articles) {
    const abstractId = (art.title.match(/^(\d+[-–][A-Z]+)/) || [])[1] || `fig${figIdx}`;
    figIdx++;

    if (!art.abstractText || !art.abstractSnippet || !Array.isArray(art.figLinks)) {
      try {
        sseEvent(session, 'progress', { stage: 'abstract_fetch', current: abstractId });
        log(`  [${abstractId}] fetching abstract context...`);
        await hydrateAbstractContext(art);
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        log(`  [${abstractId}] abstract fetch failed: ${e.message}`);
      }
    }

    const compound = art.compound || extractCompounds(`${art.title || ''} ${art.abstractSnippet || ''}`)[0] || '';
    const articleRows = [];

    // Figure extraction path
    if (Array.isArray(art.figLinks) && art.figLinks.length > 0) {
      const figUrl = art.figLinks[0];
      const ext = figUrl.includes('.png') ? 'png' : 'jpg';
      const figPath = path.join(figDir, `${abstractId}.${ext}`);
      try {
        sseEvent(session, 'progress', { stage: 'figure_download', current: abstractId });
        log(`  [${abstractId}] downloading figure...`);
        const r = await fetch(figUrl);
        if (!r.ok) {
          log(`  [${abstractId}] download failed: HTTP ${r.status}`);
        } else {
          const buf = Buffer.from(await r.arrayBuffer());
          fs.writeFileSync(figPath, buf);
          sseEvent(session, 'progress', { stage: 'vision', current: abstractId });
          log(`  [${abstractId}] reading figure with AI vision...`);
          const result = await ai.chatVisionJSON({
            model: ai.MODEL_OPUS,
            max_tokens: 3000,
            system: 'You extract clinical-trial efficacy data from published figures and tables. Be precise; only report numbers actually visible in the image. If the figure is not an efficacy results figure (e.g. it is a study schema, a Kaplan-Meier curve, an AE summary, or a structural diagram), return arms: [] and explain in figureNotes.',
            imagePath: figPath,
            prompt: `Extract every treatment arm from this figure. The article title is: "${art.title.substring(0, 200)}". The abstract context (first 800 chars): "${(art.abstractSnippet || '').substring(0, 800)}". Include placebo and active comparators. Use the abstract context to disambiguate arm labels and units, but only extract values that are actually visible in the figure.`,
            schema: CURATION_SCHEMA
          });
          if (!result.arms || result.arms.length === 0) {
            log(`  [${abstractId}] no efficacy data extracted from figure: ${result.figureNotes || '(no notes)'}`);
          } else {
            articleRows.push(...mapResultArmsToRows(result, {
              compound,
              abstractId,
              fallbackPhase: art.trialType,
              sourceTag: 'figure',
              articleUrl: art.url
            }));
            log(`  [${abstractId}] extracted ${result.arms.length} arm(s) from figure.`);
          }
        }
      } catch (e) {
        log(`  [${abstractId}] vision call failed: ${e.message}`);
      }
    } else {
      log(`  [${abstractId}] no figure links available.`);
    }

    // Abstract free-text extraction path
    try {
      const abstractText = (art.abstractText || art.abstractSnippet || '').trim();
      if (!abstractText) {
        log(`  [${abstractId}] no abstract text available for extraction.`);
      } else {
        sseEvent(session, 'progress', { stage: 'abstract_curation', current: abstractId });
        log(`  [${abstractId}] extracting efficacy values from abstract text...`);
        const abstractResult = await ai.chatJSON({
          model: ai.MODEL_SONNET,
          max_tokens: 2500,
          system: 'You extract clinical-trial efficacy data from abstract free text. Only extract values that are explicitly stated in the text. Do not infer missing numbers. If there is no arm-level efficacy value, return arms: [].',
          prompt: `Article title: "${(art.title || '').substring(0, 240)}"\n\nAbstract text:\n${abstractText.substring(0, 6000)}\n\nExtract efficacy values per treatment arm. Include placebo and active comparators when explicitly reported.`,
          schema: ABSTRACT_CURATION_SCHEMA
        });
        if (!abstractResult.arms || abstractResult.arms.length === 0) {
          log(`  [${abstractId}] no efficacy data extracted from abstract: ${abstractResult.abstractNotes || '(no notes)'}`);
        } else {
          articleRows.push(...mapResultArmsToRows(abstractResult, {
            compound,
            abstractId,
            fallbackPhase: art.trialType,
            sourceTag: 'abstract',
            articleUrl: art.url
          }));
          log(`  [${abstractId}] extracted ${abstractResult.arms.length} arm(s) from abstract text.`);
        }
      }
    } catch (e) {
      log(`  [${abstractId}] abstract extraction failed: ${e.message}`);
    }

    const mergedRows = dedupeRows(articleRows);
    if (mergedRows.length > 0) {
      studyInd++;
      mergedRows.forEach((row, idx) => {
        allRows.push({
          study_ind: studyInd,
          arm_ind: idx + 1,
          ...row
        });
      });
      log(`  [${abstractId}] kept ${mergedRows.length} unique arm row(s) after merge/dedupe.`);
    }
    // Small pause between AI calls to avoid hammering the gateway
    await new Promise(r => setTimeout(r, 500));
  }
  return allRows;
}

// ───────────────────────── REQUEST DISPATCH ─────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  try {
    if (req.method === 'GET' && (parsed.pathname === '/' || parsed.pathname === '/index.html' || parsed.pathname.startsWith('/static/'))) {
      return await routeStaticOrIndex(req, res, parsed);
    }
    if (req.method === 'POST' && parsed.pathname === '/api/parse') return await routeParse(req, res);
    if (req.method === 'POST' && parsed.pathname === '/api/ai/parse') return await routeAIParse(req, res);
    if (req.method === 'GET'  && parsed.pathname === '/api/ai/health') return await routeAIHealth(req, res);
    if (req.method === 'POST' && parsed.pathname === '/api/start-session') return routeStart(req, res);
    if (req.method === 'POST' && parsed.pathname === '/api/run') return await routeRun(req, res);
    if (req.method === 'POST' && parsed.pathname === '/api/cookies') return await routeCookies(req, res);
    if (req.method === 'POST' && parsed.pathname === '/api/upload-ref') return await routeUploadRef(req, res);
    if (req.method === 'POST' && parsed.pathname === '/api/cancel') return routeCancel(req, res);
    if (req.method === 'GET' && parsed.pathname.startsWith('/api/events/')) return routeEvents(req, res, parsed);
    if (req.method === 'GET' && parsed.pathname.startsWith('/api/poll/')) return routePoll(req, res, parsed);
    if (req.method === 'GET' && parsed.pathname.startsWith('/api/report/')) return await routeReport(req, res, parsed);
    send(res, 404, `No route: ${req.method} ${parsed.pathname}`);
  } catch (err) {
    console.error('Request error:', err);
    if (!res.writableEnded) send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`╔═══════════════════════════════════════════════════╗`);
  console.log(`║  ADA Web Fetcher — chat agent                      ║`);
  console.log(`║                                                    ║`);
  console.log(`║  Listening on http://${HOST}:${String(PORT).padEnd(5)}             ║`);
  console.log(`║  Open in browser via Workbench session-proxy URL  ║`);
  console.log(`║  (Workbench rewrites localhost:${PORT} for you)     ║`);
  console.log(`╚═══════════════════════════════════════════════════╝`);
});
