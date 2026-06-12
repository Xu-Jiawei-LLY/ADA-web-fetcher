// AI client for ADA Web Fetcher.
// Supports:
//   - openai_compatible (direct API, requires OPENAI_API_KEY)
//   - copilot_business (keyless mode via local VS Code extension bridge)
//
// Configuration:
//   ADA_AI_PROVIDER       -> optional; openai_compatible or copilot_business
//   OPENAI_BASE_URL       -> API base URL (default https://api.openai.com/v1)
//   OPENAI_API_KEY        -> required for openai_compatible
//   OPENAI_MODEL          -> default model alias
//   OPENAI_MODEL_OPUS     -> alias used by vision-heavy calls
//   OPENAI_MODEL_SONNET   -> alias used by mid-tier calls
//   OPENAI_MODEL_HAIKU    -> alias used by light parse/health calls
//   COPILOT_BRIDGE_URL    -> local extension bridge URL (default http://127.0.0.1:42175)

const fs = require('fs');
const path = require('path');

const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL ||
  process.env.OPENAI_API_BASE ||
  'https://api.openai.com/v1';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const COPILOT_BRIDGE_URL = (process.env.COPILOT_BRIDGE_URL || 'http://127.0.0.1:42175').replace(/\/$/, '');
const PROVIDER = (
  process.env.ADA_AI_PROVIDER ||
  (OPENAI_API_KEY ? 'openai_compatible' : 'copilot_business')
).trim().toLowerCase();

const COPILOT_PROMPT_HINT = '/ADA Web Fetcher GPT Run';
const OPENAI_MODEL_DEFAULT = process.env.OPENAI_MODEL || 'gpt-5.3';
const MODEL_OPUS = process.env.OPENAI_MODEL_OPUS || OPENAI_MODEL_DEFAULT;
const MODEL_SONNET = process.env.OPENAI_MODEL_SONNET || OPENAI_MODEL_DEFAULT;
const MODEL_HAIKU = process.env.OPENAI_MODEL_HAIKU || OPENAI_MODEL_DEFAULT;

function ensureProvider() {
  if (PROVIDER !== 'openai_compatible' && PROVIDER !== 'copilot_business') {
    throw new Error(`Unsupported ADA_AI_PROVIDER: ${PROVIDER}. Use openai_compatible or copilot_business.`);
  }
}

function ensureApiKey() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing. Set OPENAI_API_KEY to enable AI features.');
  }
}

function isCopilotBusinessMode() {
  return PROVIDER === 'copilot_business';
}

function parsePossiblyFencedJSON(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Empty JSON response content');
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return JSON.parse(fenced[1]);
  throw new Error(`Failed to parse JSON response: ${raw.substring(0, 300)}`);
}

function normalizeOpenAIMessages(messages = []) {
  return messages.map(msg => {
    const out = { role: msg.role || 'user' };
    if (typeof msg.content === 'string') {
      out.content = msg.content;
      return out;
    }
    if (!Array.isArray(msg.content)) {
      out.content = String(msg.content || '');
      return out;
    }
    out.content = msg.content.map(block => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text || '' };
      }
      if (block.type === 'image' && block.source?.type === 'base64') {
        const media = block.source.media_type || 'image/jpeg';
        return {
          type: 'image_url',
          image_url: { url: `data:${media};base64,${block.source.data}` }
        };
      }
      if (block.type === 'image_url') return block;
      return { type: 'text', text: '' };
    });
    return out;
  });
}

function extractTextFromChoiceContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map(p => {
    if (typeof p === 'string') return p;
    if (p?.type === 'text') return p.text || '';
    if (p?.type === 'output_text') return p.text || '';
    return '';
  }).join('');
}

function resolveImageInput(opts) {
  return (async () => {
    let buffer = opts.imageBuffer;
    let mediaType = opts.mediaType;
    if (opts.imagePath) {
      buffer = await fs.promises.readFile(opts.imagePath);
      if (!mediaType) {
        const ext = path.extname(opts.imagePath).toLowerCase();
        mediaType = ext === '.png' ? 'image/png'
          : ext === '.gif' ? 'image/gif'
          : ext === '.webp' ? 'image/webp'
          : 'image/jpeg';
      }
    }
    if (!buffer) throw new Error('Image input missing: provide imagePath or imageBuffer');
    return { imageBase64: buffer.toString('base64'), mediaType: mediaType || 'image/jpeg' };
  })();
}

async function _postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (status ${res.status}) from ${url}: ${text.substring(0, 400)}`);
  }
  if (!res.ok) {
    const msg = parsed?.error || parsed?.message || text.substring(0, 400);
    throw new Error(`HTTP ${res.status} from ${url}: ${msg}`);
  }
  return parsed;
}

async function _postOpenAI(pathname, body) {
  ensureProvider();
  ensureApiKey();
  const url = OPENAI_BASE_URL.replace(/\/$/, '') + pathname;
  return _postJson(url, body, { Authorization: `Bearer ${OPENAI_API_KEY}` });
}

async function _postCopilotBridge(pathname, body) {
  ensureProvider();
  const url = `${COPILOT_BRIDGE_URL}${pathname}`;
  return _postJson(url, body);
}

async function _getCopilotBridgeHealth() {
  const url = `${COPILOT_BRIDGE_URL}/health`;
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Bridge health returned non-JSON (status ${res.status}): ${text.substring(0, 400)}`);
  }
  if (!res.ok) {
    const msg = parsed?.error || parsed?.message || text.substring(0, 400);
    throw new Error(`Bridge health failed (${res.status}): ${msg}`);
  }
  return parsed;
}

// Compatibility helper retained for callers that previously expected token retrieval.
async function getToken() {
  ensureProvider();
  if (isCopilotBusinessMode()) return null;
  ensureApiKey();
  return OPENAI_API_KEY;
}

async function chat(opts = {}) {
  if (isCopilotBusinessMode()) {
    const out = await _postCopilotBridge('/chat', {
      system: opts.system || '',
      messages: opts.messages || [],
      max_tokens: opts.max_tokens || 4096,
      model: opts.model || MODEL_OPUS
    });
    return {
      provider: out.provider || 'copilot_business_bridge',
      model: out.model || (opts.model || MODEL_OPUS),
      content: [{ type: 'text', text: out.text || '' }],
      stop_reason: out.stop_reason || null,
      raw: out
    };
  }

  const messages = normalizeOpenAIMessages(opts.messages || []);
  const oaiMessages = opts.system
    ? [{ role: 'system', content: opts.system }, ...messages]
    : messages;
  const body = {
    model: opts.model || MODEL_OPUS,
    max_tokens: opts.max_tokens || 4096,
    messages: oaiMessages
  };
  if (opts.stop_sequences?.length) body.stop = opts.stop_sequences;
  const parsed = await _postOpenAI('/chat/completions', body);
  const choice = parsed?.choices?.[0] || {};
  const text = extractTextFromChoiceContent(choice?.message?.content || '');
  return {
    provider: 'openai_compatible',
    model: parsed?.model || body.model,
    content: [{ type: 'text', text }],
    stop_reason: choice?.finish_reason || null,
    raw: parsed
  };
}

async function chatJSON(opts) {
  if (isCopilotBusinessMode()) {
    const out = await _postCopilotBridge('/json', {
      system: opts.system || '',
      prompt: opts.prompt || '',
      schema: opts.schema || {},
      max_tokens: opts.max_tokens || 4096,
      model: opts.model || MODEL_OPUS
    });
    return out.json;
  }

  const schemaName = (opts.toolName || 'emit_result').replace(/[^a-zA-Z0-9_-]/g, '_');
  const messages = opts.system
    ? [{ role: 'system', content: opts.system }, { role: 'user', content: opts.prompt }]
    : [{ role: 'user', content: opts.prompt }];
  const parsed = await _postOpenAI('/chat/completions', {
    model: opts.model || MODEL_OPUS,
    max_tokens: opts.max_tokens || 4096,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: schemaName,
        strict: true,
        schema: opts.schema
      }
    }
  });
  const text = extractTextFromChoiceContent(parsed?.choices?.[0]?.message?.content || '');
  return parsePossiblyFencedJSON(text);
}

async function chatVision(opts) {
  if (isCopilotBusinessMode()) {
    const img = await resolveImageInput(opts);
    const out = await _postCopilotBridge('/vision', {
      system: opts.system || '',
      prompt: opts.prompt || '',
      imageBase64: img.imageBase64,
      mediaType: img.mediaType,
      max_tokens: opts.max_tokens || 4096,
      model: opts.model || MODEL_OPUS
    });
    return {
      provider: out.provider || 'copilot_business_bridge',
      model: out.model || (opts.model || MODEL_OPUS),
      content: [{ type: 'text', text: out.text || '' }],
      stop_reason: out.stop_reason || null,
      raw: out
    };
  }

  const img = await resolveImageInput(opts);
  const userContent = [
    { type: 'text', text: opts.prompt || '' },
    { type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.imageBase64}` } }
  ];
  const messages = opts.system
    ? [{ role: 'system', content: opts.system }, { role: 'user', content: userContent }]
    : [{ role: 'user', content: userContent }];
  const parsed = await _postOpenAI('/chat/completions', {
    model: opts.model || MODEL_OPUS,
    max_tokens: opts.max_tokens || 4096,
    messages
  });
  const choice = parsed?.choices?.[0] || {};
  const text = extractTextFromChoiceContent(choice?.message?.content || '');
  return {
    provider: 'openai_compatible',
    model: parsed?.model || (opts.model || MODEL_OPUS),
    content: [{ type: 'text', text }],
    stop_reason: choice?.finish_reason || null,
    raw: parsed
  };
}

async function chatVisionJSON(opts) {
  if (isCopilotBusinessMode()) {
    const img = await resolveImageInput(opts);
    const out = await _postCopilotBridge('/vision-json', {
      system: opts.system || '',
      prompt: opts.prompt || '',
      schema: opts.schema || {},
      imageBase64: img.imageBase64,
      mediaType: img.mediaType,
      max_tokens: opts.max_tokens || 4096,
      model: opts.model || MODEL_OPUS
    });
    return out.json;
  }

  const img = await resolveImageInput(opts);
  const schemaName = (opts.toolName || 'emit_result').replace(/[^a-zA-Z0-9_-]/g, '_');
  const userContent = [
    { type: 'text', text: opts.prompt || '' },
    { type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.imageBase64}` } }
  ];
  const messages = opts.system
    ? [{ role: 'system', content: opts.system }, { role: 'user', content: userContent }]
    : [{ role: 'user', content: userContent }];
  const parsed = await _postOpenAI('/chat/completions', {
    model: opts.model || MODEL_OPUS,
    max_tokens: opts.max_tokens || 4096,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: schemaName,
        strict: true,
        schema: opts.schema
      }
    }
  });
  const text = extractTextFromChoiceContent(parsed?.choices?.[0]?.message?.content || '');
  return parsePossiblyFencedJSON(text);
}

async function healthCheck() {
  const t0 = Date.now();
  if (isCopilotBusinessMode()) {
    try {
      const h = await _getCopilotBridgeHealth();
      const allowed = h.canSendRequest === true;
      const authorizeHint = h.authorizeCommand
        ? `Run '${h.authorizeCommand}'.`
        : "Authorize your Copilot bridge in this environment.";
      return {
        ok: allowed,
        provider: 'copilot_business',
        model: h.model?.family || h.model?.id || 'copilot-model',
        text: allowed ? 'copilot_business_bridge_ready' : 'copilot_business_bridge_not_authorized',
        ms: Date.now() - t0,
        serverSideAI: allowed,
        bridge: h,
        ...(allowed ? {} : {
          error: `Copilot bridge is running but model access is not authorized yet (state: ${h.accessState || 'unknown'}). ${authorizeHint}`
        })
      };
    } catch (e) {
      return {
        ok: false,
        provider: 'copilot_business',
        error: `${e.message}. Start a local Copilot bridge and ensure Copilot login is active.`
      };
    }
  }

  try {
    const resp = await chat({
      model: MODEL_HAIKU,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }]
    });
    const text = (resp.content || []).find(b => b.type === 'text')?.text || '';
    return {
      ok: true,
      provider: PROVIDER,
      model: resp.model,
      text: text.trim(),
      ms: Date.now() - t0
    };
  } catch (e) {
    return { ok: false, provider: PROVIDER, error: e.message };
  }
}

module.exports = {
  PROVIDER,
  COPILOT_PROMPT_HINT,
  COPILOT_BRIDGE_URL,
  OPENAI_BASE_URL,
  MODEL_OPUS,
  MODEL_SONNET,
  MODEL_HAIKU,
  getToken,
  chat,
  chatJSON,
  chatVision,
  chatVisionJSON,
  healthCheck
};
