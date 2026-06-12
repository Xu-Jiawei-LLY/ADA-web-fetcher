// Reads a cookie string from argv[2] and injects each cookie into the running Chrome at :9223.
const fs = require('fs');
const CDP_PORT = 9223;
const delay = ms => new Promise(r => setTimeout(r, ms));

class CDPClient {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.msgId = 0; this.pending = new Map(); }
  connect() { return new Promise((resolve, reject) => {
    this.ws = new WebSocket(this.wsUrl); this.ws.onopen = () => resolve(); this.ws.onerror = () => reject();
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } };
  }); }
  send(method, params={}) { return new Promise(r => { const id = ++this.msgId; this.pending.set(id, r); this.ws.send(JSON.stringify({id, method, params})); }); }
  close() { if (this.ws) this.ws.close(); }
}

(async () => {
  const cookieStr = process.argv[2] || fs.readFileSync(0, 'utf8').trim();
  if (!cookieStr) { console.error('Usage: node inject_cookies.js "name1=value1; name2=..."'); process.exit(1); }
  const pairs = cookieStr.split(/;\s*/).map(p => {
    const eq = p.indexOf('=');
    return eq < 0 ? null : { name: p.slice(0, eq).trim(), value: p.slice(eq+1).trim() };
  }).filter(Boolean);
  console.log(`Parsed ${pairs.length} cookie(s)`);

  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) { console.error('No CDP page target'); process.exit(1); }
  const cdp = new CDPClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Network.enable');

  for (const { name, value } of pairs) {
    await cdp.send('Network.setCookie', {
      name, value,
      domain: '.diabetesjournals.org',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'None'
    });
    await cdp.send('Network.setCookie', {
      name, value,
      domain: 'diabetesjournals.org',
      path: '/',
      secure: true,
      httpOnly: false
    });
    console.log(`  set: ${name}=${value.substring(0, 30)}${value.length > 30 ? '...' : ''}`);
  }
  console.log('All cookies set.');
  cdp.close();
})();
