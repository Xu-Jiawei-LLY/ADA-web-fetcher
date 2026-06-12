const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = process.env.COPILOT_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.COPILOT_BRIDGE_PORT || 42175);
const DEFAULT_MODEL = process.env.COPILOT_CLI_MODEL || '';
const CLI_TIMEOUT_MS = Number(process.env.COPILOT_CLI_TIMEOUT_MS || 120000);

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function stripAnsi(s) {
  return String(s || '').replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])|(?:[^\u001b\u009b]*[\u001b\u009b][[\]()#;?]*\d*[A-PR-TZcf-nq-uy=><~]))/g,
    ''
  );
}

function sanitizeJsonStringControls(raw) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const code = raw.charCodeAt(i);
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    if (code < 0x20) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\b') out += '\\b';
      else if (ch === '\f') out += '\\f';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonLenient(candidate) {
  const text = String(candidate || '');
  try {
    return JSON.parse(text);
  } catch (err) {
    const sanitized = sanitizeJsonStringControls(text);
    if (sanitized === text) throw err;
    return JSON.parse(sanitized);
  }
}

function parsePossiblyFencedJSON(text) {
  let raw = String(text || '').trim();
  if (!raw) throw new Error('Empty model response');
  raw = raw.replace(/^●\s*/, '').trim();
  try {
    return parseJsonLenient(raw);
  } catch {}
  const m = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) return parseJsonLenient(m[1]);
  const firstObject = raw.indexOf('{');
  const lastObject = raw.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    return parseJsonLenient(raw.slice(firstObject, lastObject + 1));
  }
  const firstArray = raw.indexOf('[');
  const lastArray = raw.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) {
    return parseJsonLenient(raw.slice(firstArray, lastArray + 1));
  }
  throw new Error(`Model did not return valid JSON: ${raw.substring(0, 300)}`);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 15 * 1024 * 1024) {
        reject(new Error('Request body too large (max 15MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function toPromptTranscript(system, messages) {
  const lines = [];
  if (system) lines.push(`System instructions:\n${String(system)}`);
  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = String(msg?.role || 'user').toUpperCase();
    const content = msg?.content;
    if (typeof content === 'string') {
      lines.push(`${role}: ${content}`);
      continue;
    }
    if (!Array.isArray(content)) {
      lines.push(`${role}: ${String(content || '')}`);
      continue;
    }
    const text = content
      .map(part => (part?.type === 'text' ? String(part.text || '') : ''))
      .join('\n')
      .trim();
    lines.push(`${role}: ${text}`);
  }
  if (!lines.length) {
    return 'Reply with "ok" only.';
  }
  return lines.join('\n\n');
}

function runCopilotPromptOnce({ prompt, model, attachments = [] }) {
  return new Promise((resolve, reject) => {
    const args = ['copilot', '--', '-p', String(prompt || ''), '-s', '--stream', 'off', '--output-format', 'text'];
    const resolvedModel = model || DEFAULT_MODEL;
    if (resolvedModel) args.push('--model', resolvedModel);
    for (const att of attachments) {
      args.push('--attachment', att);
    }

    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;

    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new Error(`Copilot CLI request timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      const out = stripAnsi(stdout).trim();
      const err = stripAnsi(stderr).trim();
      if (code !== 0) {
        reject(new Error(err || out || `gh copilot exited with code ${code}`));
        return;
      }
      if (!out) {
        reject(new Error('Copilot CLI returned empty output'));
        return;
      }
      resolve(out);
    });
  });
}

function isUnavailableModelError(message) {
  const msg = String(message || '').toLowerCase();
  return msg.includes('from --model flag is not available') || msg.includes('model') && msg.includes('not available');
}

async function runCopilotPrompt({ prompt, model, attachments = [] }) {
  const requestedModel = model || DEFAULT_MODEL || '';
  try {
    const text = await runCopilotPromptOnce({ prompt, model: requestedModel, attachments });
    return { text, usedModel: requestedModel || 'auto' };
  } catch (e) {
    if (!requestedModel || !isUnavailableModelError(e.message)) throw e;
    const text = await runCopilotPromptOnce({ prompt, model: '', attachments });
    return { text, usedModel: 'auto' };
  }
}

function truncateForPrompt(text, maxChars = 12000) {
  const raw = String(text || '');
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n...[truncated ${raw.length - maxChars} chars]`;
}

async function parseModelJsonWithRepair({ text, schema, model }) {
  try {
    return parsePossiblyFencedJSON(text);
  } catch (parseErr) {
    const repairPrompt = [
      'You repair malformed JSON.',
      'Return ONLY strict JSON with no markdown or commentary.',
      `JSON schema:\n${JSON.stringify(schema || {})}`,
      'Malformed model output to repair (preserve values; only fix JSON syntax):',
      truncateForPrompt(text, 12000)
    ].join('\n\n');
    const repaired = await runCopilotPrompt({ prompt: repairPrompt, model });
    try {
      return parsePossiblyFencedJSON(repaired.text);
    } catch (repairErr) {
      throw new Error(`JSON parse failed after repair attempt. First error: ${parseErr.message}. Repair error: ${repairErr.message}`);
    }
  }
}

async function runJsonPromptWithRetries({ task, schema, model, attachments = [] }) {
  let lastErr;
  let usedModel = 'auto';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retryHint = attempt === 0 || !lastErr
      ? ''
      : [
          '',
          'IMPORTANT RETRY INSTRUCTION:',
          `Previous output was invalid JSON: ${truncateForPrompt(lastErr.message, 220)}`,
          'Return ONLY MINIFIED strict JSON.',
          'Escape all quotes and line breaks inside string values.',
          'Do not include markdown, comments, or explanations.'
        ].join('\n');
    const out = await runCopilotPrompt({
      prompt: `${task}${retryHint}`,
      model,
      attachments
    });
    usedModel = out.usedModel;
    try {
      const json = await parseModelJsonWithRepair({ text: out.text, schema, model });
      return { json, usedModel };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`JSON generation failed after retries: ${lastErr?.message || 'unknown error'}`);
}

async function writeTempImage(imageBase64, mediaType) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ada-copilot-cli-'));
  const ext = mediaType === 'image/png' ? '.png'
    : mediaType === 'image/gif' ? '.gif'
    : mediaType === 'image/webp' ? '.webp'
    : '.jpg';
  const file = path.join(dir, `image${ext}`);
  await fs.promises.writeFile(file, Buffer.from(imageBase64, 'base64'));
  return { dir, file };
}

async function rmDirSafe(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {}
}

async function handleHealth(res) {
  try {
    const out = await runCopilotPrompt({ prompt: 'Reply with "ok" only.', model: DEFAULT_MODEL });
    return sendJson(res, 200, {
      ok: true,
      provider: 'copilot_cli_bridge',
      model: out.usedModel,
      canSendRequest: true,
      accessState: 'allowed',
      authorizeCommand: 'gh copilot -- login'
    });
  } catch (e) {
    return sendJson(res, 503, {
      ok: false,
      provider: 'copilot_cli_bridge',
      canSendRequest: false,
      accessState: 'blocked',
      authorizeCommand: 'gh copilot -- login',
      error: `${e.message}. Run 'gh copilot -- login' in this same environment.`
    });
  }
}

async function handleChat(req, res) {
  const body = await parseJsonBody(req);
  const prompt = toPromptTranscript(body.system || '', body.messages || []);
  const out = await runCopilotPrompt({ prompt, model: body.model });
  return sendJson(res, 200, {
    ok: true,
    provider: 'copilot_cli_bridge',
    model: out.usedModel,
    text: out.text,
    stop_reason: 'stop'
  });
}

async function handleJson(req, res) {
  const body = await parseJsonBody(req);
  const task = [
    body.system ? `System instructions:\n${String(body.system)}` : '',
    'Return ONLY strict JSON with no markdown or commentary.',
    `JSON schema:\n${JSON.stringify(body.schema || {})}`,
    `Task:\n${String(body.prompt || '')}`
  ].filter(Boolean).join('\n\n');
  const out = await runJsonPromptWithRetries({
    task,
    schema: body.schema || {},
    model: body.model
  });
  return sendJson(res, 200, {
    ok: true,
    provider: 'copilot_cli_bridge',
    model: out.usedModel,
    json: out.json
  });
}

async function handleVision(req, res, wantJson) {
  const body = await parseJsonBody(req);
  const imageBase64 = String(body.imageBase64 || '');
  if (!imageBase64) {
    return sendJson(res, 400, { ok: false, code: 'MISSING_IMAGE', error: 'Missing imageBase64 in request body.' });
  }
  const mediaType = String(body.mediaType || 'image/jpeg');
  const taskText = wantJson
    ? [
        body.system ? `System instructions:\n${String(body.system)}` : '',
        'Return ONLY strict JSON with no markdown or commentary.',
        `JSON schema:\n${JSON.stringify(body.schema || {})}`,
        `Task:\n${String(body.prompt || '')}`
      ].filter(Boolean).join('\n\n')
    : [
        body.system ? `System instructions:\n${String(body.system)}` : '',
        String(body.prompt || '')
      ].filter(Boolean).join('\n\n');

  let tmp;
  try {
    tmp = await writeTempImage(imageBase64, mediaType);
    if (wantJson) {
      const out = await runJsonPromptWithRetries({
        task: taskText,
        schema: body.schema || {},
        model: body.model,
        attachments: [tmp.file]
      });
      return sendJson(res, 200, {
        ok: true,
        provider: 'copilot_cli_bridge',
        model: out.usedModel,
        json: out.json
      });
    }
    const out = await runCopilotPrompt({
      prompt: taskText,
      model: body.model,
      attachments: [tmp.file]
    });
    return sendJson(res, 200, {
      ok: true,
      provider: 'copilot_cli_bridge',
      model: out.usedModel,
      text: out.text,
      stop_reason: 'stop'
    });
  } finally {
    if (tmp?.dir) await rmDirSafe(tmp.dir);
  }
}

function mapErrorStatus(err) {
  if (/timed out/i.test(err?.message || '')) return 504;
  if (/login/i.test(err?.message || '')) return 403;
  return 500;
}

async function requestHandler(req, res) {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && parsed.pathname === '/health') return handleHealth(res);
    if (req.method === 'POST' && parsed.pathname === '/chat') return handleChat(req, res);
    if (req.method === 'POST' && parsed.pathname === '/json') return handleJson(req, res);
    if (req.method === 'POST' && parsed.pathname === '/vision') return handleVision(req, res, false);
    if (req.method === 'POST' && parsed.pathname === '/vision-json') return handleVision(req, res, true);
    return sendJson(res, 404, { ok: false, error: `No route for ${req.method} ${parsed.pathname}` });
  } catch (err) {
    return sendJson(res, mapErrorStatus(err), {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || 'REQUEST_FAILED'
    });
  }
}

const server = http.createServer((req, res) => {
  requestHandler(req, res).catch(err => {
    sendJson(res, 500, { ok: false, error: err?.message || String(err) });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[ADA Copilot CLI Bridge] listening on http://${HOST}:${PORT}`);
});
