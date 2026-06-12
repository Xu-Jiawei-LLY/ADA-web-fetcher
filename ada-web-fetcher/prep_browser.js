// Starts Xvfb + Chrome on the scraper profile and idles, ready for cookie injection.
const { spawn } = require('child_process');
const delay = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  spawn('Xvfb', [':99','-screen','0','1920x1080x24','-ac'], {stdio:'ignore', detached:true}).unref();
  await delay(2000);
  spawn('chromium-browser',['--no-sandbox','--disable-gpu','--disable-blink-features=AutomationControlled',
    '--user-data-dir=/tmp/ada-scraper-profile','--remote-debugging-port=9223',
    '--no-first-run','--no-default-browser-check','--disable-extensions','about:blank'],
    {stdio:'ignore', detached:true, env:{...process.env, DISPLAY: ':99'}}).unref();
  await delay(5000);
  for (let i = 0; i < 10; i++) {
    try {
      const v = await (await fetch('http://127.0.0.1:9223/json/version')).json();
      console.log('Browser ready:', v.Browser);
      break;
    } catch { await delay(1000); }
  }
  console.log('Idle, leaving Chrome running on :9223 for cookie injection.');
})();
