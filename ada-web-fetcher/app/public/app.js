// ADA Web Fetcher — chat UI front-end
// Drives the slot-filling conversation against /api/* endpoints, streams progress via SSE.

// All API paths are relative to the page's mount point so the app works behind
// proxies that mount it at non-root paths (e.g. Posit Workbench session-proxy).
// document.baseURI is "<origin>/<mount>/" — a trailing-slash redirect from the
// proxy guarantees this; we use it to build absolute URLs for fetch/EventSource.
function apiUrl(path) {
  // Strip leading slash so URL() resolves against the mount, not the host root.
  return new URL(path.replace(/^\//, ''), document.baseURI).toString();
}

const $ = sel => document.querySelector(sel);
const chat = $('#chat');
const inputArea = $('#input-area');
const inputBox = $('#input');
const sendBtn = $('#send-btn');
const actionArea = $('#action-area');
const cookieModal = $('#cookie-modal');
const cookieInput = $('#cookie-input');
const cookieSubmit = $('#cookie-submit');
const cookieCancel = $('#cookie-cancel');
const cfUrlLink = $('#cf-url');
const fileInput = $('#file-input');
const status = $('#status');
const aiToggle = $('#ai-mode-checkbox');
const aiStatus = $('#ai-status');
const aiToggleLabel = aiToggle ? aiToggle.parentElement : null;

let session = { id: null, slots: {}, userSynonyms: {}, sourceUrl: '', mode: 'prompt', generateTable: true, awaiting: null };
let synonymMeta = null;  // populated after first /api/parse call
let evtSrc = null;
let aiMode = false;
let aiAvailable = null;  // null=unknown, true=verified online, false=health check failed

// Probe the configured AI backend once at load. The toggle remains user-controlled;
// offline health only informs status/warnings and server-side fallback behavior.
async function probeAI() {
  aiStatus.className = 'checking';
  aiStatus.textContent = '⋯';
  try {
    const r = await fetch(apiUrl('/api/ai/health'));
    const j = await r.json();
    aiAvailable = j.ok;
    aiStatus.className = j.ok ? 'online' : 'offline';
    aiStatus.textContent = j.ok ? '●' : '✕';
    aiStatus.title = j.ok
      ? `${j.provider || 'ai'}: ${j.model || 'unknown model'} (${j.ms}ms)`
      : `Offline: ${j.error || 'unknown'}`;
  } catch (e) {
    aiAvailable = false;
    aiStatus.className = 'offline';
    aiStatus.textContent = '✕';
    aiStatus.title = `Offline: ${e.message}`;
  }
}

if (aiToggle) {
  aiToggle.addEventListener('change', () => {
    aiMode = aiToggle.checked;
    aiToggleLabel.classList.toggle('active', aiMode);
    if (aiMode && aiAvailable === false) {
      alert('AI backend appears offline. AI steps may fall back to rule-based behavior until /api/ai/health is online.');
    }
  });
  probeAI();
}

// ─────── messaging ───────
function bubble(role, html) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'You' : (role === 'system' ? '!' : (role === 'log' ? '·' : 'A'));
  const b = document.createElement('div');
  b.className = 'bubble';
  b.innerHTML = html;
  div.appendChild(avatar);
  div.appendChild(b);
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return b;
}
const bot = (h) => bubble('bot', h);
const me  = (h) => bubble('user', h);
const sys = (h) => bubble('system', h);
const logLine = (h) => bubble('log', h);

function clearActions() { actionArea.innerHTML = ''; }
function action(label, fn, opts = {}) {
  const btn = document.createElement('button');
  btn.textContent = label;
  if (opts.primary) btn.style.background = 'var(--primary-soft)';
  btn.onclick = () => { clearActions(); fn(); };
  actionArea.appendChild(btn);
}

function showInput(placeholder = 'Type your answer...') {
  inputArea.classList.remove('hidden');
  inputBox.placeholder = placeholder;
  inputBox.value = '';
  inputBox.focus();
}
function hideInput() { inputArea.classList.add('hidden'); }

// Pending answer resolver. The flow is: ask question → set pendingResolve → user clicks/types → resolves.
let pendingResolve = null;
function ask(prompt, opts = {}) {
  return new Promise(resolve => {
    bot(prompt);
    if (opts.actions) {
      hideInput();
      for (const a of opts.actions) action(a.label, () => { me(a.label); resolve(a.value); });
    } else {
      showInput(opts.placeholder);
      pendingResolve = (text) => { me(escapeHtml(text)); resolve(text); };
    }
  });
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

sendBtn.onclick = () => {
  const v = inputBox.value.trim();
  if (!v || !pendingResolve) return;
  const r = pendingResolve;
  pendingResolve = null;
  hideInput();
  r(v);
};
inputBox.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
};

// ─────── flow ───────
async function start() {
  const r = await fetch(apiUrl('/api/start-session'), { method: 'POST' });
  const j = await r.json();
  session.id = j.sessionId;
  status.textContent = '●';
  status.className = 'status';

  bot(`Hi — I'm the ADA Web Fetcher. I can scrape an ADA Scientific Sessions abstract supplement and produce a categorized report.<br><br>How would you like to start?`);
  hideInput();
  action('💬 Describe a topic in natural language', () => { me('Describe a topic'); flowPromptMode(); }, { primary: true });
  action('📂 Upload a list of abstract IDs', () => { me('Upload a list'); flowReferenceMode(); });
}

async function flowPromptMode() {
  session.mode = 'prompt';

  // Step 1: source URL
  const defaultUrl = 'https://diabetesjournals.org/diabetes/issue/75/Supplement_1';
  const sourceUrl = await ask(
    `Which supplement issue should I scrape? Press Enter to use the default (Vol 75 Supp 1, ADA 2026), or paste any other ADA issue URL.<br><code>${defaultUrl}</code>`,
    { placeholder: defaultUrl }
  );
  session.sourceUrl = sourceUrl || defaultUrl;

  // Step 2: free-text topic. Try to parse it for slots.
  const topicText = await ask(
    `What topic would you like to research? Describe it however you like — for example:<br>` +
    `• <em>HbA1c reduction in Chinese T2D patients</em><br>` +
    `• <em>weight loss Phase 2/3 RCTs</em><br>` +
    `• <em>cardiovascular outcomes in obesity trials</em><br><br>` +
    `<strong>Optional:</strong> add your own synonyms in parentheses, like<br>` +
    `<code>Type 2 Diabetes (T2D; T2DM); HbA1c (A1C; glycemic); Phase 2/3</code><br>` +
    `Your synonyms will be added to (not replace) my built-in dictionary — I'll still expand related terms automatically.`,
    { placeholder: 'e.g., Type 2 Diabetes (T2D; T2DM); HbA1c; Phase 2/3' }
  );
  const parseEndpoint = aiMode ? '/api/ai/parse' : '/api/parse';
  const parseR = await fetch(apiUrl(parseEndpoint), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: topicText }) });
  const parsed = await parseR.json();
  synonymMeta = { available: parsed.available, order: parsed.order };
  session.slots = parsed.slots;
  session.userSynonyms = parsed.userSynonyms || {};
  // Show which parser was used (AI vs rule-based)
  const parserBadge = aiMode
    ? `<span class="parser-tag ai">${parsed.aiError ? '⚠ rule-based fallback' : escapeHtml(parsed.parser || 'ai')}</span>`
    : `<span class="parser-tag">rule-based</span>`;
  if (parsed.aiError) {
    bot(`AI parser failed (<code>${escapeHtml(parsed.aiError)}</code>); fell back to rule-based.`);
  }
  if (parsed.aiNotice) {
    bot(escapeHtml(parsed.aiNotice));
  }
  if (parsed.humanReadable) {
    bot(`Got it. I parsed: ${parserBadge}<br><strong>${parsed.humanReadable}</strong>`);
  } else {
    bot(`I couldn't auto-detect any filters from that ${parserBadge} — let me ask one slot at a time.`);
  }
  // Echo any user-supplied synonyms back so they can confirm they were captured.
  const usnKeys = Object.keys(session.userSynonyms).filter(k => (session.userSynonyms[k] || []).length > 0);
  if (usnKeys.length) {
    const lines = usnKeys.map(k => {
      const lbl = synonymMeta.available[k]?.label || k;
      return `<li><strong>${escapeHtml(lbl)}:</strong> ${session.userSynonyms[k].map(escapeHtml).join(', ')}</li>`;
    }).join('');
    bot(`Plus your custom synonyms (added to the built-in dictionary):<ul>${lines}</ul>`);
  }

  // Step 3: walk through any remaining slots that ask-if-missing
  for (const slotName of synonymMeta.order) {
    const slotMeta = synonymMeta.available[slotName];
    if (session.slots[slotName]) continue;     // already set
    if (!slotMeta.askIfMissing) continue;      // optional, default ok
    await fillSlot(slotName, slotMeta);
  }

  // Optional slots — offer the user a chance to add more filters
  const optionalUnfilled = synonymMeta.order.filter(s => !session.slots[s] && !synonymMeta.available[s].askIfMissing);
  if (optionalUnfilled.length > 0) {
    const choice = await ask(
      `Want to narrow further? You can set: <strong>${optionalUnfilled.map(s => synonymMeta.available[s].label).join(', ')}</strong>. Default is no filter for each.`,
      { actions: [
        { label: 'Add more filters', value: 'more' },
        { label: 'Use defaults (no filter)', value: 'skip' }
      ]}
    );
    if (choice === 'more') {
      for (const slotName of optionalUnfilled) {
        await fillSlot(slotName, synonymMeta.available[slotName], { allowSkip: true });
      }
    }
  }

  // Step 4: generate data table?
  const tableChoice = await ask(
    `Should I include a data analysis table in the report? (efficacy data extracted from figures and abstracts)`,
    { actions: [
      { label: 'Yes — include table', value: 'yes' },
      { label: 'No — articles only', value: 'no' }
    ]}
  );
  session.generateTable = tableChoice === 'yes';

  // Confirm and run
  const summary = `<strong>Ready to run:</strong><br>• Source: <code>${session.sourceUrl}</code><br>• Filters: ${session.slots && Object.keys(session.slots).length ? Object.entries(session.slots).map(([k, v]) => `${synonymMeta.available[k].label}: ${synonymMeta.available[k].options[v]?.canonical}`).join(' · ') : 'none (all articles)'}<br>• Data table: ${session.generateTable ? 'yes' : 'no'}`;
  const confirm = await ask(summary + '<br><br>Proceed?', { actions: [
    { label: 'Run scrape', value: 'go' },
    { label: 'Cancel', value: 'cancel' }
  ]});
  if (confirm !== 'go') { bot('Cancelled. Refresh to start over.'); return; }

  await runScrape();
}

async function fillSlot(slotName, slotMeta, opts = {}) {
  const optsList = Object.entries(slotMeta.options);
  const buttons = optsList.map(([k, o]) => ({ label: o.canonical, value: k }));
  if (opts.allowSkip) buttons.push({ label: 'Skip (use default)', value: '__skip__' });
  const v = await ask(
    `What about <strong>${slotMeta.label}</strong>? (${slotMeta.hint})`,
    { actions: buttons }
  );
  if (v && v !== '__skip__') session.slots[slotName] = v;
}

async function flowReferenceMode() {
  session.mode = 'reference';
  bot(`Reference mode: pick an HTML or CSV file containing the abstract IDs you want to scrape. I'll extract the IDs (e.g. <code>1234-OR</code>, <code>2989-LB</code>) and look them up in the supplement.`);
  hideInput();
  action('Choose file...', () => { me('Choose file'); fileInput.click(); }, { primary: true });
}

fileInput.onchange = async () => {
  const f = fileInput.files[0];
  if (!f) return;
  const text = await f.text();
  const r = await fetch(apiUrl('/api/upload-ref'), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Session-Id': session.id, 'X-Filename': f.name },
    body: text
  });
  const j = await r.json();
  bot(`Parsed <strong>${j.count}</strong> abstract IDs from <code>${escapeHtml(f.name)}</code>.<br>${j.ids.slice(0, 10).map(escapeHtml).join(', ')}${j.ids.length > 10 ? ` and ${j.ids.length - 10} more...` : ''}`);

  // Source URL
  const defaultUrl = 'https://diabetesjournals.org/diabetes/issue/75/Supplement_1';
  const sourceUrl = await ask(
    `Which supplement should I look these up in? Press Enter for default, or paste another ADA issue URL.<br><code>${defaultUrl}</code>`,
    { placeholder: defaultUrl }
  );
  session.sourceUrl = sourceUrl || defaultUrl;

  // Data table?
  const tableChoice = await ask(
    `Include a data analysis table?`,
    { actions: [
      { label: 'Yes — include table', value: 'yes' },
      { label: 'No — articles only', value: 'no' }
    ]}
  );
  session.generateTable = tableChoice === 'yes';

  // Run
  await runScrape();
};

async function runScrape() {
  bot(`Starting scrape... (you'll see progress messages stream in below)`);
  // Open SSE stream
  if (evtSrc) try { evtSrc.close(); } catch {}
  evtSrc = new EventSource(apiUrl(`/api/events/${session.id}`));
  let lastSseAt = Date.now();
  let pollFallbackActive = false;
  let pollCursor = 0;
  let pollTimer = null;

  function handleEvent(evt) {
    if (evt.type === 'log') {
      logLine(escapeHtml(evt.msg));
    } else if (evt.type === 'awaiting_cookies') {
      promptForCookies(evt.sourceUrl);
    } else if (evt.type === 'cookies_accepted') {
      bot(`Cookies accepted. Resuming...`);
    } else if (evt.type === 'progress') {
      // narrative progress already logged; ignore
    } else if (evt.type === 'done') {
      bot(`Done — scraped <strong>${evt.articleCount}</strong> articles.<br><a class="report-link" href="${apiUrl(evt.reportUrl)}" target="_blank">📄 View Report</a>`);
      stopFeed();
    } else if (evt.type === 'error') {
      sys(`ERROR: ${escapeHtml(evt.message)}`);
    }
  }

  function stopFeed() {
    try { evtSrc && evtSrc.close(); } catch {}
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function pollOnce() {
    try {
      const r = await fetch(apiUrl(`/api/poll/${session.id}?cursor=${pollCursor}`));
      const j = await r.json();
      pollCursor = j.cursor;
      for (const evt of (j.events || [])) handleEvent(evt);
      if (j.state === 'done' && j.reportUrl) {
        // poll's "done" doesn't carry articleCount; fetch it from the events we already have
        stopFeed();
      }
      if (j.awaitingCookies) handleEvent({ type: 'awaiting_cookies', sourceUrl: j.awaitingCookies });
    } catch (e) { /* network blip — try again next tick */ }
  }

  function activatePollFallback(reason) {
    if (pollFallbackActive) return;
    pollFallbackActive = true;
    sys(`(Live stream silent for too long — switching to polling. Reason: ${reason})`);
    try { evtSrc && evtSrc.close(); } catch {}
    // Replay everything from the start so we don't miss the early lines
    pollCursor = 0;
    pollOnce();
    pollTimer = setInterval(pollOnce, 1500);
  }

  evtSrc.onopen = () => { lastSseAt = Date.now(); };
  evtSrc.onmessage = (e) => {
    lastSseAt = Date.now();
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    handleEvent(evt);
  };
  evtSrc.onerror = () => {
    // Browser auto-reconnects on simple errors; only fall back if it stays broken.
    setTimeout(() => {
      if (evtSrc && evtSrc.readyState === EventSource.CLOSED) {
        activatePollFallback('SSE connection closed');
      }
    }, 2000);
  };

  // Watchdog: if we don't see ANY bytes for 5s while the run is active, the
  // proxy is buffering. Start polling alongside the (silent) SSE.
  const watchdog = setInterval(() => {
    if (pollFallbackActive) { clearInterval(watchdog); return; }
    if (Date.now() - lastSseAt > 5000) {
      clearInterval(watchdog);
      activatePollFallback('no SSE bytes for 5s — likely proxy buffering');
    }
  }, 1000);

  // Fire the run
  await fetch(apiUrl('/api/run'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.id,
      slots: session.slots,
      userSynonyms: session.userSynonyms || {},
      sourceUrl: session.sourceUrl,
      mode: session.mode,
      generateTable: session.generateTable,
      aiMode: aiMode
    })
  });
}

function promptForCookies(sourceUrl) {
  cfUrlLink.href = sourceUrl;
  cfUrlLink.textContent = sourceUrl;
  cookieInput.value = '';
  cookieModal.classList.remove('hidden');
  cookieInput.focus();
}

cookieSubmit.onclick = async () => {
  const cookies = cookieInput.value.trim();
  if (!cookies) { alert('Please paste the cookie string.'); return; }
  cookieSubmit.disabled = true;
  try {
    const r = await fetch(apiUrl('/api/cookies'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, cookies })
    });
    const j = await r.json();
    if (r.ok) {
      cookieModal.classList.add('hidden');
    } else {
      alert(`Inject failed: ${j.error || 'unknown error'}`);
    }
  } finally {
    cookieSubmit.disabled = false;
  }
};
cookieCancel.onclick = () => {
  cookieModal.classList.add('hidden');
  bot('Cookie injection cancelled. The scrape will hang until you provide cookies or refresh.');
};

// Kick off
start().catch(e => sys(`Failed to start: ${e.message}`));

// "New Search" button — tear down whatever's running and start a fresh chat.
// We reset DOM, kill any open SSE stream, ask the server to cancel its scrape,
// then re-run start() so the user lands back at the "How would you like to
// start?" prompt with a brand-new session id.
const newSearchBtn = $('#new-search-btn');
if (newSearchBtn) {
  newSearchBtn.onclick = async () => {
    // Best-effort cancel on the server side. Doesn't block; if it fails we
    // still proceed with the local reset.
    if (session.id) {
      try {
        await fetch(apiUrl('/api/cancel'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: session.id })
        });
      } catch {}
    }
    // Close any live SSE stream
    try { evtSrc && evtSrc.close(); } catch {}
    evtSrc = null;
    // Hide cookie modal if it's open
    cookieModal.classList.add('hidden');
    // Reset state
    session = { id: null, slots: {}, userSynonyms: {}, sourceUrl: '', mode: 'prompt', generateTable: true, awaiting: null };
    // Wipe the chat history and any pending action/input UI
    chat.innerHTML = '';
    actionArea.innerHTML = '';
    inputArea.classList.add('hidden');
    inputBox.value = '';
    // Scroll to top so the user sees the new greeting
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Restart the conversation
    start().catch(e => sys(`Failed to start: ${e.message}`));
  };
}
