const http = require('http');
const vscode = require('vscode');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 42175;
const JUSTIFICATION = 'Enable ADA Web Fetcher to parse requests and curate figure data through your Copilot Business model access.';

let server;
let output;

function log(msg) {
  output.appendLine(`[ADA Copilot Bridge] ${msg}`);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
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

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
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
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Empty model response');
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

function guessFamilyFromModelName(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('gpt-5')) return 'gpt-5';
  if (n.includes('gpt-4.1')) return 'gpt-4.1';
  if (n.includes('gpt-4o')) return 'gpt-4o';
  return undefined;
}

async function selectModel(preferredModel) {
  const family = guessFamilyFromModelName(preferredModel);
  let models = [];
  if (family) {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
  }
  if (!models.length) {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  }
  if (!models.length) {
    throw new Error('No Copilot chat model is available. Check Copilot sign-in and entitlement.');
  }
  return models[0];
}

async function collectResponseText(response) {
  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
  }
  return text;
}

function accessInfo(context, model) {
  const can = context.languageModelAccessInformation.canSendRequest(model);
  const accessState = can === true ? 'allowed' : (can === false ? 'blocked' : 'not_asked');
  return { canSendRequest: can, accessState };
}

function toUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  const out = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') {
      out.push(new vscode.LanguageModelTextPart(part));
      continue;
    }
    if (part.type === 'text') {
      out.push(new vscode.LanguageModelTextPart(part.text || ''));
      continue;
    }
    if ((part.type === 'image' || part.type === 'image_base64') && part.data) {
      const data = new Uint8Array(Buffer.from(part.data, 'base64'));
      out.push(vscode.LanguageModelDataPart.image(data, part.mime || 'image/jpeg'));
      continue;
    }
  }
  return out.length ? out : '';
}

async function runModelRequest(context, preferredModel, messages) {
  const model = await selectModel(preferredModel);
  const access = accessInfo(context, model);
  if (access.canSendRequest !== true) {
    const err = new Error(`Model access is not authorized for this extension (state: ${access.accessState}). Run command 'ADA Copilot Bridge: Authorize Copilot Access'.`);
    err.code = 'NO_PERMISSION';
    err.accessState = access.accessState;
    throw err;
  }

  const response = await model.sendRequest(messages, { justification: JUSTIFICATION });
  const text = await collectResponseText(response);
  return { model, text, access };
}

async function handleHealth(context, res) {
  try {
    const model = await selectModel('gpt-5');
    const access = accessInfo(context, model);
    return sendJson(res, 200, {
      ok: true,
      provider: 'copilot_business_bridge',
      model: {
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        family: model.family,
        version: model.version,
        maxInputTokens: model.maxInputTokens,
        capabilities: model.capabilities || {}
      },
      canSendRequest: access.canSendRequest,
      accessState: access.accessState,
      authorizeCommand: 'ADA Copilot Bridge: Authorize Copilot Access'
    });
  } catch (e) {
    return sendJson(res, 503, { ok: false, error: e.message, provider: 'copilot_business_bridge' });
  }
}

async function handleChat(context, req, res) {
  const body = await parseJsonBody(req);
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];

  const messages = [];
  if (body.system) {
    messages.push(vscode.LanguageModelChatMessage.User(`System instructions:\n${body.system}`));
  }
  for (const msg of rawMessages) {
    const role = String(msg?.role || 'user').toLowerCase();
    const content = toUserContent(msg?.content);
    if (role === 'assistant') {
      messages.push(vscode.LanguageModelChatMessage.Assistant(typeof content === 'string' ? content : ''));
    } else {
      messages.push(vscode.LanguageModelChatMessage.User(content));
    }
  }
  if (!messages.length) {
    messages.push(vscode.LanguageModelChatMessage.User('Say "ok" and nothing else.'));
  }

  const out = await runModelRequest(context, body.model, messages);
  return sendJson(res, 200, {
    ok: true,
    provider: 'copilot_business_bridge',
    model: out.model.family || out.model.id,
    text: out.text,
    stop_reason: 'stop'
  });
}

async function handleJson(context, req, res) {
  const body = await parseJsonBody(req);
  const schema = body.schema || {};
  const prompt = String(body.prompt || '');
  const system = String(body.system || '');

  const task = [
    system ? `System instructions:\n${system}` : '',
    'Return ONLY strict JSON with no markdown or commentary.',
    `JSON schema:\n${JSON.stringify(schema)}`,
    `Task:\n${prompt}`
  ].filter(Boolean).join('\n\n');

  const messages = [vscode.LanguageModelChatMessage.User(task)];
  const out = await runModelRequest(context, body.model, messages);
  const json = parsePossiblyFencedJSON(out.text);
  return sendJson(res, 200, {
    ok: true,
    provider: 'copilot_business_bridge',
    model: out.model.family || out.model.id,
    json
  });
}

async function handleVision(context, req, res, wantJson) {
  const body = await parseJsonBody(req);
  const model = await selectModel(body.model);
  const access = accessInfo(context, model);
  if (access.canSendRequest !== true) {
    return sendJson(res, 403, {
      ok: false,
      code: 'NO_PERMISSION',
      accessState: access.accessState,
      error: `Model access is not authorized for this extension (state: ${access.accessState}). Run command 'ADA Copilot Bridge: Authorize Copilot Access'.`
    });
  }

  const imageSupported = model.capabilities?.imageInput === true;
  if (!imageSupported) {
    return sendJson(res, 400, {
      ok: false,
      code: 'IMAGE_NOT_SUPPORTED',
      error: `Selected model '${model.family || model.id}' does not support image input.`
    });
  }

  const imageBase64 = String(body.imageBase64 || '');
  if (!imageBase64) {
    return sendJson(res, 400, { ok: false, code: 'MISSING_IMAGE', error: 'Missing imageBase64 in request body.' });
  }

  const mime = String(body.mediaType || 'image/jpeg');
  const imageData = new Uint8Array(Buffer.from(imageBase64, 'base64'));

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

  const parts = [
    new vscode.LanguageModelTextPart(taskText),
    vscode.LanguageModelDataPart.image(imageData, mime)
  ];
  const response = await model.sendRequest([
    vscode.LanguageModelChatMessage.User(parts)
  ], { justification: JUSTIFICATION });
  const text = await collectResponseText(response);

  if (wantJson) {
    const json = parsePossiblyFencedJSON(text);
    return sendJson(res, 200, {
      ok: true,
      provider: 'copilot_business_bridge',
      model: model.family || model.id,
      json
    });
  }

  return sendJson(res, 200, {
    ok: true,
    provider: 'copilot_business_bridge',
    model: model.family || model.id,
    text,
    stop_reason: 'stop'
  });
}

function mapErrorStatus(err) {
  if (err?.code === 'NO_PERMISSION') return 403;
  if (err?.code === 'IMAGE_NOT_SUPPORTED') return 400;
  return 500;
}

async function requestHandler(context, req, res) {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && parsed.pathname === '/health') {
      return handleHealth(context, res);
    }
    if (req.method === 'POST' && parsed.pathname === '/chat') {
      return await handleChat(context, req, res);
    }
    if (req.method === 'POST' && parsed.pathname === '/json') {
      return await handleJson(context, req, res);
    }
    if (req.method === 'POST' && parsed.pathname === '/vision') {
      return await handleVision(context, req, res, false);
    }
    if (req.method === 'POST' && parsed.pathname === '/vision-json') {
      return await handleVision(context, req, res, true);
    }

    return sendJson(res, 404, { ok: false, error: `No route for ${req.method} ${parsed.pathname}` });
  } catch (err) {
    const status = mapErrorStatus(err);
    log(`Request error: ${err?.stack || err?.message || String(err)}`);
    return sendJson(res, status, {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || 'REQUEST_FAILED'
    });
  }
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('adaCopilotBridge');
  const host = cfg.get('host', DEFAULT_HOST);
  const port = cfg.get('port', DEFAULT_PORT);
  const autoStart = cfg.get('autoStart', true);
  return { host, port, autoStart };
}

async function startServer(context) {
  if (server) return;
  const { host, port } = getConfig();
  server = http.createServer((req, res) => {
    requestHandler(context, req, res).catch(err => {
      log(`Unhandled request exception: ${err?.stack || err?.message || String(err)}`);
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  log(`Bridge listening on http://${host}:${port}`);
}

async function stopServer() {
  if (!server) return;
  const s = server;
  server = undefined;
  await new Promise(resolve => s.close(() => resolve()));
  log('Bridge stopped');
}

async function showStatus(context) {
  const { host, port } = getConfig();
  if (!server) {
    vscode.window.showWarningMessage(`ADA Copilot Bridge is stopped. Expected URL: http://${host}:${port}`);
    return;
  }
  try {
    const model = await selectModel('gpt-5');
    const access = accessInfo(context, model);
    vscode.window.showInformationMessage(`ADA Copilot Bridge running on http://${host}:${port} (${model.family || model.id}, access: ${access.accessState})`);
  } catch (e) {
    vscode.window.showWarningMessage(`ADA Copilot Bridge running on http://${host}:${port}, but model check failed: ${e.message}`);
  }
}

async function authorizeCopilotAccess(context) {
  const model = await selectModel('gpt-5');
  const messages = [vscode.LanguageModelChatMessage.User('Reply with "ok" only.')];
  const response = await model.sendRequest(messages, { justification: JUSTIFICATION });
  await collectResponseText(response);
  vscode.window.showInformationMessage('ADA Copilot Bridge authorization completed. You can now use AI features from the web app without API key.');
}

function registerCommands(context) {
  context.subscriptions.push(vscode.commands.registerCommand('adaCopilotBridge.start', async () => {
    try {
      await startServer(context);
      vscode.window.showInformationMessage('ADA Copilot Bridge started.');
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to start ADA Copilot Bridge: ${e.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('adaCopilotBridge.stop', async () => {
    await stopServer();
    vscode.window.showInformationMessage('ADA Copilot Bridge stopped.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('adaCopilotBridge.status', async () => {
    await showStatus(context);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('adaCopilotBridge.authorize', async () => {
    try {
      await authorizeCopilotAccess(context);
    } catch (e) {
      vscode.window.showErrorMessage(`Copilot authorization failed: ${e.message}`);
    }
  }));
}

function activate(context) {
  output = vscode.window.createOutputChannel('ADA Copilot Bridge');
  context.subscriptions.push(output);
  registerCommands(context);

  const { autoStart } = getConfig();
  if (autoStart) {
    startServer(context).catch(e => {
      log(`Auto-start failed: ${e.message}`);
    });
  }

  context.languageModelAccessInformation.onDidChange(() => {
    log('Language model access information changed.');
  });
}

function deactivate() {
  return stopServer();
}

module.exports = {
  activate,
  deactivate
};
