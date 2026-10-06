// Browser smoke test of the MetadataScrubber interface, driven over the Chrome DevTools
// Protocol with nothing but Node 24 built-ins.
//
//   node tests/ui-smoke.mjs [--chromium /usr/bin/chromium] [--out DIR] [--keep]
//
// It serves the repository read-only with the stormberry.as zone policy as a header (so
// the browser enforces the zone policy and the page's own policy together, as in
// production), starts headless Chromium with a throwaway profile under DIR, loads the
// synthetic fixtures from tests/fixtures/out (build them first with
// tests/fixtures/make-fixtures.sh), presses the buttons a person would press, downloads
// the new files and checks them with the engine in Node, and with Pillow when python3
// has it. It is a smoke test, not the full browser suite: it proves the main paths work.
//
// The file name does not end in .test.mjs, so `node --test tests/` does not run it.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, privacyWord } from '../src/scrub-core.js';
import { SHARE_STATE, SHARE_TEXT, SKIP_CLOCK, appBridgeStub, appFileBytes, shareStub } from './share-stub.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIX = join(ROOT, 'tests', 'fixtures', 'out');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CHROMIUM = opt('--chromium', process.env.CHROMIUM || '/usr/bin/chromium');
const OUT = resolve(opt('--out', process.env.MS_UI_OUT || join(tmpdir(), 'metadatascrubber-ui')));
const KEEP = args.includes('--keep');

const ZONE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; "
  + "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; "
  + "connect-src 'self' https://stormberry-contact-form.marcos-495.workers.dev; "
  + "frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; "
  + "form-action 'self' https://stormberry-contact-form.marcos-495.workers.dev; object-src 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.md': 'text/markdown', '.txt': 'text/plain' };

for (const f of ['jpeg-everything.jpg', 'jpeg-orientation-6.jpg', 'png-transparent.png', 'heic-everything.heic', 'jpeg-large.jpg', 'not-an-image.pdf', 'webp-everything.webp']) {
  if (!existsSync(join(FIX, f))) {
    console.error(`Missing fixture ${f}. Build the fixtures first: tests/fixtures/make-fixtures.sh`);
    process.exit(2);
  }
}
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(OUT, 'profile-'));
const downloads = mkdtempSync(join(OUT, 'downloads-'));

// ---- The page as the Android app bundles it --------------------------------------------
// The APK serves the same index.html with one line added on its own line before the first
// <script> tag, which loads android/web-overlay/android-bridge.js (WebAssets.inject in
// android/app/build.gradle.kts). Asked for as /?android, this server does the same.
const BRIDGE_FILE = 'android-bridge.js';
const BRIDGE_PATH = join(ROOT, 'android', 'web-overlay', BRIDGE_FILE);
const BRIDGE_TAG = `<script src="${BRIDGE_FILE}"></script>`;
function androidIndex(text) {
  const first = text.indexOf('<script');
  const lineStart = text.lastIndexOf('\n', first) + 1;
  const indent = text.slice(lineStart, first);
  if (first < 0 || indent.trim() || text.includes(BRIDGE_FILE)) throw new Error('index.html cannot take the bridge line the way the APK adds it');
  return text.slice(0, lineStart) + indent + BRIDGE_TAG + '\n' + text.slice(lineStart);
}
const ZAPSTORE = 'https://zapstore.dev/apps/no.stormberry.metadatascrubber';
const COLOUR_NOTE = 'Colours may look a little duller and bright areas less vivid on HDR screens.';

// ---- Static server ---------------------------------------------------------------------
const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  requests.push(path);
  if (req.method === 'GET' && (path === `/${BRIDGE_FILE}` || (path === '/' && url.searchParams.has('android')))) {
    let body;
    try {
      body = path === '/' ? androidIndex(readFileSync(join(ROOT, 'index.html'), 'utf8')) : readFileSync(BRIDGE_PATH);
    } catch (err) {
      check('the page can be served the way the APK serves it', false, String(err.message || err));
      res.writeHead(500, { 'Content-Security-Policy': ZONE_CSP });
      res.end('cannot inject the bridge');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path === '/' ? '.html' : '.js'], 'Content-Security-Policy': ZONE_CSP, 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  const file = normalize(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
  if (req.method !== 'GET' || !file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Security-Policy': ZONE_CSP });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Security-Policy': ZONE_CSP, 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ---- Chromium --------------------------------------------------------------------------
const chrome = spawn(CHROMIUM, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-breakpad', '--disable-crash-reporter', 'about:blank'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  // Keeps Chromium's crash-report folder inside the throwaway profile instead of the
  // person's own ~/.config/chromium, which --user-data-dir alone does not cover.
  env: { ...process.env, XDG_CONFIG_HOME: join(profile, 'xdg-config'), CHROME_CONFIG_HOME: join(profile, 'xdg-config'), XDG_CACHE_HOME: join(profile, 'xdg-cache') },
});
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  const t = setTimeout(() => rej(new Error('Chromium did not start')), 20000);
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) { clearTimeout(t); res(m[1]); }
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const listeners = new Set();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(JSON.stringify(m.error)));
    else p.res(m.result);
  } else for (const fn of listeners) fn(m);
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Checks ----------------------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `\n     ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

const python = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;
function pil(script, ...files) {
  const r = spawnSync('python3', ['-c', script, ...files], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

// ---- One page --------------------------------------------------------------------------
// android: load the page the way the APK does (see androidIndex), with a stand-in for the
// app's message channel, window.MSBridge, that records what the bridge posts. android:
// 'app' uses the stand-in of share-stub.mjs instead, which answers as the app does.
// init: extra script run before the page's own, such as the share stand-ins (share-stub.mjs).
async function openPage(width, height, { android = false, init = null } = {}) {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  const log = { errors: [], csp: [], offsite: [] };
  const named = new Map();
  const completed = [];
  const onMsg = (m) => {
    if (m.method === 'Browser.downloadWillBegin') named.set(m.params.guid, m.params.suggestedFilename);
    if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') completed.push(m.params.guid);
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') log.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') log.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Network.requestWillBeSent' && !m.params.request.url.startsWith(BASE) && !/^(data|blob):/.test(m.params.request.url)) log.offsite.push(m.params.request.url);
  };
  listeners.add(onMsg);
  await s('Runtime.enable');
  await s('Network.enable');
  await s('Page.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true, browserContextId });
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await s('Page.addScriptToEvaluateOnNewDocument', { source: "window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI),true);" });
  if (android === 'app') {
    await s('Page.addScriptToEvaluateOnNewDocument', { source: appBridgeStub() });
  } else if (android) {
    await s('Page.addScriptToEvaluateOnNewDocument', { source: "window.__msPosted=[];window.MSBridge={postMessage:function(m){window.__msPosted.push(JSON.parse(m));},addEventListener:function(t,fn){window.__msListen=fn;}};" });
  }
  if (init) await s('Page.addScriptToEvaluateOnNewDocument', { source: init });
  await s('Page.navigate', { url: android ? `${BASE}?android` : BASE });
  await sleep(1200);
  const ev = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  // Dismiss the first-run gate the way a person would.
  await ev("document.querySelector('.sb-gate-btn')?.click()");
  await sleep(200);
  const { root } = await s('DOM.getDocument', { depth: 0 });
  const setFiles = async (names) => {
    const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
    await s('DOM.setFileInputFiles', { nodeId, files: names.map((n) => (n.startsWith('/') ? n : join(FIX, n))) });
  };
  const waitFor = async (expression, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ev(expression)) return true;
      await sleep(100);
    }
    return false;
  };
  const load = async (names) => {
    await ev("window.__loaded = false; document.getElementById('workspace').hidden = true; document.getElementById('pick-errors').hidden = true;");
    await setFiles(names);
    return waitFor("!document.getElementById('workspace').hidden || !document.getElementById('pick-errors').hidden");
  };
  const press = async () => {
    await ev("document.getElementById('go-btn').click()");
    await waitFor("document.getElementById('go-btn').getAttribute('aria-busy') === null && !document.getElementById('results').hidden", 120000);
  };
  // Pressing when nothing would change: no file, and the reason beside the button.
  // The button is focused first, as with the keyboard: a scripted click() does not move focus.
  const pressIdle = async () => {
    await ev("(() => { const b = document.getElementById('go-btn'); b.focus(); b.click(); })()");
    await waitFor("!document.getElementById('go-nothing').hidden", 10000);
    return ev("({ text: document.getElementById('go-nothing').textContent, results: document.getElementById('results').hidden, links: document.querySelectorAll('.ms-download').length, focus: document.activeElement.id })");
  };
  // Clicks every download link and returns { name: bytes }.
  const download = async () => {
    const names = await ev("[...document.querySelectorAll('.ms-download')].map(a => a.download)");
    const start = completed.length;
    await ev("document.querySelectorAll('.ms-download').forEach(a => a.click())");
    const end = Date.now() + 30000;
    while (completed.length < start + names.length && Date.now() < end) await sleep(100);
    const files = {};
    for (const guid of completed.slice(start)) files[named.get(guid)] = new Uint8Array(readFileSync(join(downloads, guid)));
    return files;
  };
  const shot = async (label) => {
    const h = await ev('document.documentElement.scrollHeight');
    const r = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(6000, h), scale: 1 } });
    writeFileSync(join(OUT, `${label}.png`), Buffer.from(r.data, 'base64'));
  };
  // A picture of one part of the page, for a person to look at.
  const shotOf = async (label, selector) => {
    const b = await ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + scrollX, r.top + scrollY, r.width, r.height]; })()`);
    const r = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: b[0], y: b[1], width: b[2], height: Math.min(6000, b[3]), scale: 1 } });
    writeFileSync(join(OUT, `${label}.png`), Buffer.from(r.data, 'base64'));
  };
  // Sets each colour section's own tick box, the way a person would: one press, or two
  // when the box is half-ticked and the colour must end up unticked. { red: true } ticks
  // red and unticks amber and green.
  const tick = (want) => ev(`(() => {
    const want = ${JSON.stringify(want)};
    for (const all of document.querySelectorAll('#meta-groups .ms-tier-check')) {
      const on = !!want[all.dataset.tier];
      if (all.indeterminate || all.checked !== on) all.click();
      if (all.checked !== on) all.click();
    }
  })()`);
  const close = async () => {
    listeners.delete(onMsg);
    await send('Target.closeTarget', { targetId });
    await send('Target.disposeBrowserContext', { browserContextId });
  };
  return { s, ev, load, press, pressIdle, download, shot, shotOf, close, log, waitFor, tick, completed };
}

const LOSSLESS_PY = `
import sys, json
from PIL import Image
a = Image.open(sys.argv[1]); b = Image.open(sys.argv[2])
a.load(); b.load()
print(json.dumps(a.size == b.size and a.tobytes() == b.tobytes()))`;
const ORIENT_PY = `
import sys, json
from PIL import Image, ImageOps, ImageChops, ImageStat
a = ImageOps.exif_transpose(Image.open(sys.argv[1])).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
if a.size != b.size: print(json.dumps({'size': [a.size, b.size]})); sys.exit()
d = ImageStat.Stat(ImageChops.difference(a, b)).mean
print(json.dumps({'size': list(b.size), 'diff': sum(d) / 3}))`;
const CORNER_PY = `
import sys, json
from PIL import Image
b = Image.open(sys.argv[1]).convert('RGB')
print(json.dumps({'mode': Image.open(sys.argv[1]).format, 'corner': b.getpixel((0, 0)), 'size': list(b.size)}))`;

// A small PNG with no metadata at all: only IHDR, IDAT and IEND.
function plainPng(w, h) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([x * 8, y * 8, 128], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const tmpFile = (name, bytes) => {
  const p = join(downloads, `check-${name}`);
  writeFileSync(p, bytes);
  return p;
};

// ---- Scenarios -------------------------------------------------------------------------
try {
  for (const [w, h] of [[360, 780], [1280, 900]]) {
    const p = await openPage(w, h);
    const tag = `w${w}`;

    // A full JPEG, default choice: red removed (0.0.3: red only is ticked), lossless.
    check(`${tag} page loads without errors`, p.log.errors.length === 0, p.log.errors);

    // The Android app section at the foot of the page, on the website.
    const app = await p.ev(`(() => {
      const sec = document.querySelector('[data-web-only]');
      if (!sec) return null;
      const a = sec.querySelector('a');
      const main = document.querySelector('main');
      const r = sec.getBoundingClientRect();
      return { id: sec.id, n: document.querySelectorAll('[data-web-only]').length, hidden: sec.hidden, shown: r.height > 0 && getComputedStyle(sec).display !== 'none', last: main.lastElementChild === sec,
        href: a && a.getAttribute('href'), target: a && a.getAttribute('target'), rel: a && a.getAttribute('rel'), btn: !!a && a.matches('.btn.btn-secondary'), height: a ? a.getBoundingClientRect().height : 0,
        text: a && a.textContent, extra: a && a.querySelector('.visually-hidden')?.textContent, line: sec.querySelector('p')?.textContent,
        bridge: !!document.querySelector('script[src="${BRIDGE_FILE}"]') };
    })()`);
    check(`${tag} the Android app section is the last thing in main, marked data-web-only, and shown on the website`, !!app && app.id === 'android-app' && app.n === 1 && app.last && !app.hidden && app.shown && !app.bridge, app);
    check(`${tag} it links to the Zapstore listing in a new tab`, !!app && app.href === ZAPSTORE && app.target === '_blank' && app.rel === 'noopener', app);
    check(`${tag} the link is a button, says where it goes, and that it opens a new tab`, !!app && app.btn && app.height >= 44 && app.text === 'Get the Android app on Zapstore (opens in a new tab)' && app.extra === ' (opens in a new tab)', app);
    check(`${tag} the line says what the app is`, !!app && app.line === 'Android app: the same tool on your phone, with no permissions and no internet. Share a photo into it straight from your gallery.', app && app.line);
    await p.shotOf(`${tag}-0-android-app`, '#android-app');
    await p.load(['jpeg-everything.jpg']);
    const meta = await p.ev(`(() => {
      const tiers = [...document.querySelectorAll('#meta-groups .ms-tier')].map(e => e.dataset.tier);
      const boxes = [...document.querySelectorAll('#meta-groups .ms-check')];
      const rows = boxes.map(b => ({ id: b.dataset.id, checked: b.checked, tier: b.closest('.ms-item').dataset.tier, section: b.closest('.ms-tier').dataset.tier, group: b.closest('.ms-item').querySelector('.ms-group-word')?.textContent, badge: b.closest('.ms-item').querySelector('.tier-badge').textContent }));
      return { tiers, rows, legend: !!document.getElementById('tier-legend'), quick: !!document.getElementById('quick') || !!document.querySelector('[data-preset]'), intro: document.getElementById('meta-intro').textContent, preview: document.getElementById('name-preview').textContent, mode: document.getElementById('mode-line').textContent, webp: !!document.querySelector('#format-select option[value="webp"]') };
    })()`);
    const src = await inspect(new Uint8Array(readFileSync(join(FIX, 'jpeg-everything.jpg'))));
    check(`${tag} lists every detail the engine finds`, meta.rows.length === src.items.length, [meta.rows.length, src.items.length]);
    check(`${tag} sections are red, amber, green, in that order`, meta.tiers.join() === 'red,amber,green', meta.tiers);
    check(`${tag} each detail sits in its own tier's section; red and amber name their group, green (all Technical) does not repeat it`, meta.rows.every((r) => r.section === r.tier && (r.tier === 'green' ? r.group === undefined : ['Where', 'Who', 'When', 'Device', 'Hidden extras'].includes(r.group))), meta.rows.filter((r) => r.section !== r.tier || (r.tier === 'green') === !!r.group).map((r) => [r.id, r.group]));
    check(`${tag} the separate colour legend is gone`, !meta.legend);
    check(`${tag} red details are ticked to start with, amber and green details are not`, meta.rows.every((r) => r.checked === (r.tier === 'red')), meta.rows.filter((r) => r.checked !== (r.tier === 'red')).map((r) => r.id));
    check(`${tag} every tier is shown in words`, meta.rows.every((r) => r.badge === { red: 'Red', amber: 'Amber', green: 'Green' }[r.tier]));

    // The colour note above the button: hidden with the default red-only choice, shown with
    // its exact text while Green (and so the colour profile) is ticked, hidden again after.
    const colourNote = () => p.ev(`(() => {
      const n = document.getElementById('colour-note');
      const r = n.getBoundingClientRect();
      return { hidden: n.hidden, shown: r.height > 0, text: n.textContent, live: n.parentElement.getAttribute('aria-live'), amber: n.dataset.tier === 'amber',
        aboveButton: n.parentElement.nextElementSibling === document.getElementById('go-btn'), mode: !document.getElementById('mode-box').hidden };
    })()`);
    let cn = await colourNote();
    check(`${tag} colour note: hidden with the default red-only choice`, cn.hidden && !cn.shown && cn.text === '' && cn.live === 'polite' && cn.aboveButton, cn);
    check(`${tag} colour note: the photo has a colour profile (green)`, meta.rows.some((r) => r.id === 'icc:profile' && r.tier === 'green'), meta.rows.map((r) => r.id));
    await p.tick({ red: true, green: true });
    cn = await colourNote();
    check(`${tag} colour note: shown with its exact text when Green is ticked, next to the mode box`, !cn.hidden && cn.shown && cn.amber && cn.mode && cn.text === COLOUR_NOTE, cn);
    await p.tick({ red: true });
    cn = await colourNote();
    check(`${tag} colour note: hidden again when Green is unticked`, cn.hidden && !cn.shown && cn.text === '', cn);
    await p.ev("document.querySelector('#meta-groups .ms-check[data-id=\"icc:profile\"]').click()");
    cn = await colourNote();
    check(`${tag} colour note: shown for the colour profile box alone`, !cn.hidden && cn.text === COLOUR_NOTE, cn);
    await p.ev("document.querySelector('#meta-groups .ms-check[data-id=\"icc:profile\"]').click()");
    cn = await colourNote();
    check(`${tag} colour note: hidden once that box is unticked`, cn.hidden, cn);
    check(`${tag} the quick choice buttons are gone`, !meta.quick);
    check(`${tag} the intro says red is ticked to start with and amber and green are kept`, meta.intro === 'Ticked details will be removed. Red details are ticked to start with; amber and green are kept unless you tick them.', meta.intro);
    check(`${tag} the expected name uses the public word, as amber stays`, /Expected name: image\.public\.jpg\./.test(meta.preview), meta.preview);
    const tierText = await p.ev("[...document.querySelectorAll('#meta-groups .ms-tier-desc')].map((d) => d.textContent)");
    check(`${tag} the section descriptions: red removed, amber kept unless ticked, green kept`, JSON.stringify(tierText) === JSON.stringify(['Can identify you, your camera or the place. Removed by default.', 'Can reveal routines, devices or history. Kept unless you tick it.', 'Helps the picture display correctly. Kept by default.']), tierText);
    check(`${tag} lossless is announced`, /^Lossless/.test(meta.mode), meta.mode);
    const buttons = await p.ev("[...document.querySelectorAll('button')].filter(b => !b.closest('[hidden]') && /remove metadata|prepare/i.test(b.textContent)).map(b => b.textContent.trim())");
    check(`${tag} one action button, "Prepare picture"`, buttons.length === 1 && buttons[0] === 'Prepare picture', buttons);
    check(`${tag} WebP is offered when Chromium can save it`, meta.webp);
    await p.shot(`${tag}-1-loaded`);

    // ---- Tier sections: tick boxes and arrows.
    const tiers = () => p.ev(`Object.fromEntries([...document.querySelectorAll('#meta-groups .ms-tier')].map((sec) => {
      const all = sec.querySelector('.ms-tier-check'); const btn = sec.querySelector('.ms-tier-toggle'); const list = sec.querySelector('.ms-tier-items');
      const boxes = [...list.querySelectorAll('.ms-check')];
      return [sec.dataset.tier, { checked: all.checked, mixed: all.indeterminate, expanded: btn.getAttribute('aria-expanded'), hidden: list.hidden, shown: list.getBoundingClientRect().height > 0, n: boxes.length, ticked: boxes.filter((b) => b.checked).length, count: sec.querySelector('.ms-tier-count').textContent }];
    }))`);
    const closed = (x) => ['red', 'amber', 'green'].every((k) => x[k].expanded === 'false' && x[k].hidden && !x[k].shown);
    const countLine = () => p.ev("document.getElementById('select-count').textContent");
    let t = await tiers();
    check(`${tag} every section starts closed`, closed(t), t);
    check(`${tag} the red tick box ticked, amber and green not, with counts`, t.red.checked && !t.amber.checked && !t.amber.mixed && !t.green.checked && !t.green.mixed
      && t.red.count === `${t.red.n} details, ${t.red.n} ticked` && t.amber.count === `${t.amber.n} details, 0 ticked` && t.green.count === `${t.green.n} details, 0 ticked`, t);
    check(`${tag} the count line says how many details are ticked`, await countLine() === `${t.red.n} of ${t.red.n + t.amber.n + t.green.n} details ticked for removal.`, await countLine());
    await p.ev("document.getElementById('m-tier-amber-toggle').click()");
    t = await tiers();
    check(`${tag} the amber arrow opens amber (aria-expanded true)`, t.amber.expanded === 'true' && t.amber.shown, t.amber);
    await p.shotOf(`${tag}-1b-amber-open`, '#meta-card');
    await p.ev("document.getElementById('m-tier-amber-toggle').click()");
    t = await tiers();
    check(`${tag} and closes it again (aria-expanded false)`, t.amber.expanded === 'false' && !t.amber.shown, t.amber);
    await p.ev("document.getElementById('m-tier-amber-all').click()");
    t = await tiers();
    check(`${tag} the amber tick box ticks every amber detail while amber stays closed`, t.amber.checked && !t.amber.mixed && t.amber.ticked === t.amber.n && t.amber.expanded === 'false' && !t.amber.shown, t.amber);
    await p.ev("document.getElementById('m-tier-amber-all').click()");
    t = await tiers();
    check(`${tag} and unticks them all again`, !t.amber.checked && !t.amber.mixed && t.amber.ticked === 0, t.amber);
    await p.ev("document.getElementById('m-tier-green-toggle').click()");
    await p.ev("document.querySelector('#m-tier-green-list .ms-check').click()");
    t = await tiers();
    check(`${tag} one green detail ticked by hand: green half-ticked`, t.green.mixed && !t.green.checked && t.green.ticked === 1 && t.green.count === `${t.green.n} details, 1 ticked`, t.green);
    await p.ev("document.getElementById('m-tier-green-all').click()");
    t = await tiers();
    check(`${tag} pressing the half-ticked green box ticks all green`, t.green.checked && !t.green.mixed && t.green.ticked === t.green.n, t.green);
    await p.ev("document.getElementById('m-tier-green-toggle').click()");
    await p.tick({});
    t = await tiers();
    check(`${tag} the three tick boxes untick everything`, !t.red.checked && !t.amber.checked && !t.green.checked && !t.red.mixed && !t.green.mixed && /^0 of /.test(await countLine()), t);
    await p.tick({ red: true, amber: true, green: true });
    t = await tiers();
    check(`${tag} and tick everything`, t.red.checked && t.amber.checked && t.green.checked, t);

    // Prepare removes exactly the ticked details: proved by the engine and the page read-back.
    const ofTier = (...ts) => src.items.filter((i) => ts.includes(i.tier)).map((i) => i.id);
    const exactly = async (label, want) => {
      const ticked = await p.ev("[...document.querySelectorAll('#meta-groups .ms-check')].filter((b) => b.checked).map((b) => b.dataset.id).sort()");
      check(`${tag} ${label}: ticked details as meant`, ticked.join() === [...want].sort().join(), ticked);
      await p.press();
      const got = await p.download();
      const n = Object.keys(got)[0];
      if (!n) { check(`${tag} ${label}: a file was made`, false); return; }
      const out = await inspect(got[n]);
      const expect = src.items.map((i) => i.id).filter((id) => !want.includes(id)).sort();
      check(`${tag} ${label}: the new file holds exactly the details not ticked (${expect.length})`, out.items.map((i) => i.id).sort().join() === expect.join(), out.items.map((i) => i.id));
      const shown = await p.ev("[...document.querySelectorAll('#results-list .ms-readback .ms-item')].map((li) => li.dataset.id).sort()");
      check(`${tag} ${label}: the page read-back names the same details`, shown.join() === expect.join(), shown);
    };
    await p.tick({ red: true });
    await exactly('all red by the red tick box', ofTier('red'));
    await p.tick({});
    await p.ev("document.querySelector('#m-tier-amber-list .ms-check[data-id=\"exif:software\"]').click()");
    await exactly('a single detail', ['exif:software']);
    await p.tick({ red: true });
    await exactly('the default (red, by its tick box)', ofTier('red'));

    // The default file is on screen now: red gone, amber kept, so the word is public.
    let files = await p.download();
    let name = Object.keys(files)[0];
    check(`${tag} the default download is named image.public.jpg`, name === 'image.public.jpg', Object.keys(files));
    if (name) {
      const out = await inspect(files[name]);
      check(`${tag} the default leaves no red detail and keeps every amber one`, !out.items.some((i) => i.tier === 'red') && ofTier('amber').every((id) => out.items.some((i) => i.id === id)), out.items.map((i) => i.tier + ':' + i.id));
      check(`${tag} the default: privacy word public`, privacyWord(out.items) === 'public');
      check(`${tag} the description beside the download fits public`, await p.ev("document.querySelector('.ms-word-text').textContent") === 'Safe to share publicly: location, serial numbers, names, captions and the hidden preview are gone. Dates and device details may remain; check them under Amber.');
      const btn = await p.ev("(() => { const a = document.querySelector('#results-list .ms-download'); return a && a.textContent; })()");
      check(`${tag} the result button says "Save image.public.jpg"`, btn === 'Save image.public.jpg', btn);
    }

    // Amber ticked as well gives the minimal word.
    await p.tick({ red: true, amber: true });
    await exactly('red and amber, by their tick boxes', ofTier('red', 'amber'));
    files = await p.download();
    name = Object.keys(files)[0];
    check(`${tag} download is named image.minimal.jpg`, name === 'image.minimal.jpg', Object.keys(files));
    if (name) {
      const out = await inspect(files[name]);
      check(`${tag} no red or amber detail is left`, !out.items.some((i) => i.tier !== 'green'), out.items.filter((i) => i.tier !== 'green').map((i) => i.id));
      check(`${tag} privacy word matches the read-back`, privacyWord(out.items) === 'minimal');
      check(`${tag} the description beside the download fits minimal`, await p.ev("document.querySelector('.ms-word-text').textContent") === 'Only technical data left: rotation, colour, size and exposure.');
      const btn = await p.ev("(() => { const a = document.querySelector('#results-list .ms-download'); return a && { tag: a.tagName, text: a.textContent, blob: (a.getAttribute('href') || '').startsWith('blob:'), dl: a.hasAttribute('download') }; })()");
      check(`${tag} the result button says "Save image.minimal.jpg" and is still an <a download> to a blob:`, btn && btn.text === 'Save image.minimal.jpg' && btn.tag === 'A' && btn.dl && btn.blob, btn);
      const shown = await p.ev("document.querySelectorAll('#results-list .ms-item').length");
      check(`${tag} read-back list shows what remains`, shown === out.items.length, [shown, out.items.length]);
      if (python) check(`${tag} lossless: decoded pixels identical`, pil(LOSSLESS_PY, join(FIX, 'jpeg-everything.jpg'), tmpFile(name, files[name])));
    }
    await p.shotOf(`${tag}-2-result`, '#results');

    // The name field renames the link without making the file again.
    await p.ev("(() => { const i = document.getElementById('name-input'); i.value = 'holiday.jpg'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    check(`${tag} typed name is used, extension dropped`, await p.ev("document.querySelector('.ms-download').download") === 'holiday.minimal.jpg');
    await p.ev("(() => { const i = document.getElementById('name-input'); i.value = 'image'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");

    // Nothing ticked: this file's XMP is not in the engine's standard form (it has spare
    // white space), and XMP is only ever kept in that form, so a file is still made: it
    // keeps every detail, and its XMP is written again. (A file already in that form makes
    // no copy; see the plain file and jpeg-orientation-6.jpg below.)
    await p.tick({});
    check(`${tag} changing the choice clears the old file`, await p.ev("document.getElementById('results').hidden && !document.getElementById('go-stale').hidden"));
    await p.press();
    files = await p.download();
    name = Object.keys(files)[0];
    {
      const src = await inspect(new Uint8Array(readFileSync(join(FIX, 'jpeg-everything.jpg'))));
      const kept = name ? await inspect(files[name]) : null;
      check(`${tag} nothing ticked still writes the XMP in the standard form and keeps every detail`, !!kept && src.normalise && !kept.normalise
        && JSON.stringify(kept.items.map((i) => i.id).sort()) === JSON.stringify(src.items.map((i) => i.id).sort()), kept && { name, normalise: kept.normalise, ids: kept.items.map((i) => i.id) });
    }
    // Nothing ticked with a resize: everything kept, so the word is custom with the red warning.
    await p.ev("(() => { const i = document.getElementById('resize-percent'); i.value = '50'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    check(`${tag} choosing a size takes the message away`, await p.ev("document.getElementById('go-nothing').hidden"));
    await p.press();
    check(`${tag} nothing ticked with a resize gives custom and the red warning`, await p.ev("document.querySelector('.ms-word').textContent === 'custom' && !!document.querySelector('.ms-word-warning')"));
    await p.ev("document.querySelector('input[name=resize][value=none]').click()");

    // Everything ticked on a picture with normal rotation: still lossless.
    await p.tick({ red: true, amber: true, green: true });
    check(`${tag} everything ticked on normal rotation stays lossless`, /^Lossless/.test(await p.ev("document.getElementById('mode-line').textContent")));
    await p.press();
    files = await p.download();
    name = Object.keys(files)[0];
    if (name) {
      const out = await inspect(files[name]);
      check(`${tag} everything ticked leaves ${out.items.length ? out.items.map((i) => i.id).join(', ') : 'nothing'}`, name === `image.${privacyWord(out.items)}.jpg`, name);
    }

    // Loading another file closes every section again and brings back the default ticks,
    // whatever was open or ticked before.
    await p.ev("document.getElementById('m-tier-amber-toggle').click(); document.getElementById('m-tier-green-toggle').click()");
    await p.tick({ green: true });
    // Rotation 6: the default keeps the tag and stays lossless; ticking green bakes it.
    await p.load(['jpeg-orientation-6.jpg']);
    t = await tiers();
    check(`${tag} a second file: every section closed again`, ['red', 'amber', 'green'].filter((k) => t[k]).every((k) => t[k].expanded === 'false' && !t[k].shown), t);
    check(`${tag} a second file: red ticked again, amber and green not`, (!t.red || t.red.checked) && (!t.amber || (!t.amber.checked && !t.amber.mixed)) && (!t.green || (!t.green.checked && !t.green.mixed)), t);
    const pre = await p.ev("({ summary: document.getElementById('file-summary').textContent, mode: document.getElementById('mode-line').textContent, canvas: [document.getElementById('preview-canvas').width, document.getElementById('preview-canvas').height] })");
    check(`${tag} sideways picture is shown upright`, pre.canvas[1] > pre.canvas[0] && /480 × 640/.test(pre.summary), pre);
    check(`${tag} rotation kept: lossless`, /^Lossless/.test(pre.mode), pre.mode);
    // This file has no XMP, so with nothing ticked nothing changes: no file, and the reason.
    await p.tick({});
    const idle = await p.pressIdle();
    check(`${tag} nothing ticked and nothing else chosen makes no file and says why`, idle.results && !idle.links && idle.text === 'Nothing to change yet: tick something to remove, or choose a crop, size or format.' && idle.focus === 'go-btn', idle);
    await p.tick({ red: true, amber: true, green: true });
    const bake = await p.ev("document.getElementById('mode-line').textContent + ' | ' + document.getElementById('mode-reasons').textContent");
    check(`${tag} removing rotation says the picture is re-saved and turned`, /re-saves the picture/.test(bake) && /right way up/.test(bake), bake);
    await p.press();
    files = await p.download();
    name = Object.keys(files)[0];
    if (name) {
      const out = await inspect(files[name]);
      check(`${tag} baked file is ${out.width}x${out.height}, rotation normal`, out.width === 480 && out.height === 640 && out.orientation === 1, [out.width, out.height, out.orientation]);
      if (python) {
        const r = pil(ORIENT_PY, join(FIX, 'jpeg-orientation-6.jpg'), tmpFile(name, files[name]));
        check(`${tag} baked pixels match the upright original`, r.diff !== undefined && r.diff < 6, r);
      }
    }
    await p.shot(`${tag}-3-rotation`);

    // Crop with a fixed shape, then keyboard moves.
    await p.tick({ red: true, amber: true });
    await p.ev("document.getElementById('crop-toggle').click()");
    await p.ev("document.querySelector('#crop-ratios [data-ratio=\"1:1\"]').click()");
    const before = await p.ev("document.getElementById('crop-readout').textContent");
    await p.ev("document.getElementById('crop-box').focus()");
    await p.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, modifiers: 8 });
    await p.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, modifiers: 8 });
    await p.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await p.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await sleep(600);
    const after = await p.ev("document.getElementById('crop-readout').textContent");
    check(`${tag} keyboard moves and resizes the crop`, before !== after, [before, after]);
    // Drag the bottom-right corner inwards with the mouse, then move the frame by touch.
    // Input events use screen coordinates, so the frame is scrolled into view first.
    const centre = (sel) => p.ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: 'center', behavior: 'instant' }); const b = el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
    const handle = await centre('[data-handle=se]');
    await p.s('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle[0], y: handle[1], button: 'left', clickCount: 1 });
    await p.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle[0] - 40, y: handle[1] - 10, button: 'left' });
    await p.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle[0] - 40, y: handle[1] - 10, button: 'left', clickCount: 1 });
    const dragged = await p.ev("document.getElementById('crop-readout').textContent");
    check(`${tag} dragging a corner resizes the crop`, dragged !== after, [after, dragged]);
    if (w < 600) {
      const mid = await centre('#crop-box');
      await p.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mid[0], y: mid[1] }] });
      // A finger moves in many small steps; one big jump can fall inside the touch slop.
      for (let i = 1; i <= 8; i++) await p.s('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mid[0] + i * 3, y: mid[1] + i * 4 }] });
      await p.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const touched = await p.ev("document.getElementById('crop-readout').textContent");
      check(`${tag} a finger moves the crop`, touched !== dragged, [dragged, touched]);
    }
    const crop = await p.ev("(() => { const m = /Crop: ([\\d,]+) × ([\\d,]+)/.exec(document.getElementById('crop-readout').textContent); return [parseInt(m[1].replace(/,/g, '')), parseInt(m[2].replace(/,/g, ''))]; })()");
    await p.press();
    files = await p.download();
    name = Object.keys(files)[0];
    if (name) {
      const out = await inspect(files[name]);
      check(`${tag} crop gives a square ${crop.join('x')}`, out.width === crop[0] && out.height === crop[1] && Math.abs(out.width - out.height) <= 1, [out.width, out.height, crop]);
      check(`${tag} cropped file keeps no preview image`, !out.items.some((i) => /thumbnail|preview/.test(i.id)));
    }
    await p.shotOf(`${tag}-4-crop`, '#preview-card');
    await p.shotOf(`${tag}-4-crop-result`, '#results');
    await p.ev("document.getElementById('crop-toggle').click()");

    // Transparent PNG to JPEG on a chosen background.
    await p.load(['png-transparent.png']);
    const pngTiers = await p.ev("[...document.querySelectorAll('#meta-groups .ms-tier')].map((s) => s.dataset.tier).join()");
    check(`${tag} a file with no green details has no green section`, pngTiers === 'red,amber' && !(await p.ev("!!document.getElementById('m-tier-green')")), pngTiers);
    await p.ev("(() => { const s = document.getElementById('format-select'); s.value = 'jpeg'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    check(`${tag} PNG to JPEG asks for a background colour`, await p.ev("!document.getElementById('background-field').hidden"));
    await p.press();
    files = await p.download();
    name = Object.keys(files)[0];
    check(`${tag} converted file is a .jpg`, /^image\.\w+\.jpg$/.test(name || ''), name);
    if (name && python) {
      const r = pil(CORNER_PY, tmpFile(name, files[name]));
      check(`${tag} see-through corner is white`, r.mode === 'JPEG' && r.corner.every((c) => c > 245), r);
    }

    // Size limit on a large JPEG.
    if (w === 1280) {
      await p.load(['jpeg-large.jpg']);
      await p.ev("(() => { document.querySelector('input[name=resize][value=size]').click(); const i = document.getElementById('resize-size'); i.value = '0,5'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
      const t0 = Date.now();
      await p.press();
      files = await p.download();
      name = Object.keys(files)[0];
      if (name) {
        const size = files[name].length;
        check(`${tag} 0,5 MB limit gives ${size} bytes in ${Date.now() - t0} ms`, size <= 475000 && size > 250000, size);
        check(`${tag} the result shows size and quality`, /quality \d+ per cent/.test(await p.ev("document.querySelector('.ms-result-facts').textContent")));
      }
      await p.shot(`${tag}-5-size`);
      await p.ev("document.querySelector('input[name=resize][value=none]').click()");

      // A browser that cannot draw a canvas this large: the page must say so and offer
      // the nearest size that works. Simulated by refusing 2D canvases over 4 million
      // pixels, which no real browser limit is this low, for this check only.
      await p.ev(`(() => {
        const real = HTMLCanvasElement.prototype.getContext;
        window.__realGetContext = real;
        HTMLCanvasElement.prototype.getContext = function (kind, o) { return this.width * this.height > 4000000 ? null : real.call(this, kind, o); };
      })()`);
      await p.ev("(() => { const s = document.getElementById('format-select'); s.value = 'png'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
      await p.press();
      const offer = await p.ev("(() => { const b = [...document.querySelectorAll('#results-list button')].find(x => /^Use /.test(x.textContent)); return { text: document.getElementById('results-list').textContent, button: b ? b.textContent : null }; })()");
      check(`${tag} too-large canvas is explained, with a size that works`, /cannot make a picture of 6,000 × 4,000 pixels/.test(offer.text) && /^Use [\d,]+ × [\d,]+ pixels instead$/.test(offer.button || ''), offer);
      await p.ev("[...document.querySelectorAll('#results-list button')].find(x => /^Use /.test(x.textContent)).click()");
      await p.waitFor("!!document.querySelector('.ms-download')", 120000);
      files = await p.download();
      name = Object.keys(files)[0];
      if (name) {
        const out = await inspect(files[name]);
        check(`${tag} the offered size works: ${out.width}x${out.height} PNG`, out.format === 'png' && out.width * out.height <= 4000000 && out.width > 1000, [out.format, out.width, out.height]);
      }
      await p.ev("HTMLCanvasElement.prototype.getContext = window.__realGetContext");
      await p.ev("(() => { document.querySelector('input[name=resize][value=none]').click(); const s = document.getElementById('format-select'); s.value = 'same'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    }

    // HEIC: Chromium cannot decode it, so only metadata removal is offered.
    await p.load(['heic-everything.heic']);
    const heic = await p.ev("({ note: document.getElementById('preview-missing').textContent, disabled: document.getElementById('format-select').disabled, crop: document.getElementById('crop-toggle').closest('label').hidden })");
    check(`${tag} HEIC without a decoder says so and disables edits`, heic.note === 'Preview is not available for HEIC in this browser. Removing metadata still works; cropping, resizing and changing format do not.' && heic.disabled && heic.crop, heic);
    await p.press();
    files = await p.download();
    name = Object.keys(files)[0];
    check(`${tag} HEIC download keeps its type`, /^image\.\w+\.heic$/.test(name || ''), name);
    if (name) {
      const out = await inspect(files[name]);
      check(`${tag} HEIC: no red left, word ${privacyWord(out.items)}`, !out.items.some((i) => i.tier === 'red') && name === `image.${privacyWord(out.items)}.heic`, out.items.map((i) => i.id));
    }
    await p.shot(`${tag}-6-heic`);

    // An HDR photo: amber starts unticked, the gain map and its details with it, and the
    // amber tick box then ticks every amber detail, the gain map included.
    await p.load(['jpeg-ultrahdr-like.jpg']);
    const gm = () => p.ev("['jpeg:trailing:gain-map', 'xmp:gainmap'].map((id) => document.querySelector(`#meta-groups .ms-check[data-id=\"${id}\"]`).checked)");
    t = await tiers();
    check(`${tag} HDR photo: amber starts unticked, the gain map and its details with it; red is ticked`, !t.amber.mixed && !t.amber.checked && t.amber.ticked === 0 && JSON.stringify(await gm()) === '[false,false]' && t.red.checked, t);
    await p.ev("document.getElementById('m-tier-amber-all').click()");
    t = await tiers();
    check(`${tag} HDR photo: pressing the amber box ticks every amber detail, the gain map included`, t.amber.checked && !t.amber.mixed && t.amber.ticked === t.amber.n && JSON.stringify(await gm()) === '[true,true]', t);
    let hn = await p.ev("({ hidden: document.getElementById('colour-note').hidden, text: document.getElementById('colour-note').textContent })");
    check(`${tag} HDR photo: the colour note shows with its exact text once the gain map is ticked`, !hn.hidden && hn.text === COLOUR_NOTE, hn);
    await p.ev("document.getElementById('m-tier-amber-all').click()");
    hn = await p.ev("({ hidden: document.getElementById('colour-note').hidden, gm: document.querySelector('#meta-groups .ms-check[data-id=\"jpeg:trailing:gain-map\"]').checked })");
    check(`${tag} HDR photo: the colour note hides again when the gain map is unticked`, hn.hidden && !hn.gm, hn);
    await p.ev("document.querySelector('#meta-groups .ms-check[data-id=\"jpeg:trailing:gain-map\"]').click()");
    hn = await p.ev("({ hidden: document.getElementById('colour-note').hidden, text: document.getElementById('colour-note').textContent })");
    check(`${tag} HDR photo: the gain map box alone shows the colour note`, !hn.hidden && hn.text === COLOUR_NOTE, hn);
    await p.ev("document.querySelector('#meta-groups .ms-check[data-id=\"jpeg:trailing:gain-map\"]').click()");
    check(`${tag} HDR photo: and hides it again`, await p.ev("document.getElementById('colour-note').hidden"));

    // Several files at once, plus one that is not a picture.
    await p.load(['jpeg-everything.jpg', 'webp-everything.webp', 'not-an-image.pdf']);
    const multi = await p.ev("({ err: document.getElementById('pick-errors').textContent, files: document.querySelectorAll('#file-list .ms-file').length, crop: document.getElementById('crop-toggle').closest('label').hidden })");
    check(`${tag} unsupported file gets a clear message`, /not-an-image\.pdf" is not a JPEG, PNG, WebP or HEIC picture/.test(multi.err), multi.err);
    check(`${tag} two pictures listed, crop off`, multi.files === 2 && multi.crop, multi);
    check(`${tag} the button says "Prepare pictures" for several`, await p.ev("document.getElementById('go-btn').textContent") === 'Prepare pictures');
    t = await tiers();
    check(`${tag} several files: every section closed, red ticked for all of them, amber and green not`, closed(t) && t.red.checked && t.red.ticked === t.red.n && !t.amber.checked && t.amber.ticked === 0 && !t.green.checked && t.green.ticked === 0, t);
    await p.press();
    files = await p.download();
    const names = Object.keys(files).sort();
    check(`${tag} numbered names`, names.length === 2 && /^image-1\.\w+\.jpg$/.test(names[0]) && /^image-2\.\w+\.webp$/.test(names[1]), names);
    for (const nm of names) {
      const out = await inspect(files[nm]);
      check(`${tag} ${nm}: red gone, amber kept, word public`, !out.items.some((i) => i.tier === 'red') && out.items.some((i) => i.tier === 'amber') && /\.public\./.test(nm), out.items.map((i) => i.tier + ':' + i.id));
    }
    await p.shotOf(`${tag}-7-multi`, '#results');

    // Layout: nothing wider than the screen.
    const overflow = await p.ev("(() => { const vw = document.documentElement.clientWidth; const bad = []; for (const el of document.querySelectorAll('main *')) { const b = el.getBoundingClientRect(); if (b.width && (b.right > vw + 0.5 || b.left < -0.5)) bad.push(el.tagName + '.' + el.className); } return { sw: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 5) }; })()");
    check(`${tag} no horizontal overflow`, overflow.sw <= overflow.vw && !overflow.bad.length, overflow);

    // A picture with no metadata at all.
    const plain = join(downloads, 'plain.png');
    writeFileSync(plain, plainPng(32, 24));
    await p.load([plain]);
    const none = await p.ev("({ empty: !document.getElementById('meta-empty').hidden && document.getElementById('meta-empty').textContent, intro: document.getElementById('meta-intro').hidden, count: document.getElementById('select-count').hidden })");
    check(`${tag} no metadata is said plainly, with no intro or count`, none.empty === 'This file has no metadata. There is nothing hidden to remove.' && none.intro && none.count, none);
    check(`${tag} no metadata: no tier sections at all`, await p.ev("document.querySelectorAll('#meta-groups .ms-tier').length === 0"));
    const plainIdle = await p.pressIdle();
    check(`${tag} no metadata and no change: no identical copy, and the reason`, plainIdle.results && !plainIdle.links && plainIdle.text === 'Nothing to change yet: this file has no metadata. Choose a crop, size or format.', plainIdle);
    // Only a resize, on a file with nothing to remove: a real change, and still clean.
    await p.ev("(() => { const i = document.getElementById('resize-percent'); i.value = '50'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await p.press();
    check(`${tag} resize only, no metadata: clean and says so`, await p.ev("document.querySelector('.ms-word').textContent === 'clean' && /No metadata remains\\./.test(document.getElementById('results-list').textContent) && /16 × 12 pixels/.test(document.querySelector('.ms-result-facts').textContent)"));

    // Start again clears everything and returns to the start.
    await p.ev("document.getElementById('reset-btn').click()");
    check(`${tag} Start again clears the page`, await p.ev("document.getElementById('workspace').hidden && document.getElementById('results').hidden && document.activeElement.id === 'choose-btn'"));

    const csp = await p.ev('window.__csp');
    check(`${tag} no policy violations`, csp.length === 0, csp);
    check(`${tag} no errors in the console`, p.log.errors.length === 0, p.log.errors);
    check(`${tag} nothing fetched from elsewhere`, p.log.offsite.length === 0, p.log.offsite);
    await p.close();
  }

  // Share and Copy under Save. Linux Chromium has no share sheet and a headless browser no
  // clipboard to read, so share-stub.mjs stands in for both and records what it is given.
  {
    const tag = 'share';
    const p = await openPage(360, 780, { init: shareStub({ share: true, clipboard: true }) });
    await p.load(['jpeg-everything.jpg']);
    await p.press();
    let st = await p.ev(SHARE_STATE);
    check(`${tag} with canShare: "${SHARE_TEXT.button}" and Copy image under Save, in a data-web-only block`, st.block && st.webOnly && st.blockShown && st.shareShown && st.shareText === SHARE_TEXT.button && st.copyShown && st.copyText === 'Copy image', st);
    check(`${tag} Share is a primary button, the same colour as Save`, st.primary, { shareBg: st.shareBg, saveBg: st.saveBg });
    check(`${tag} the warning is shown under the buttons, amber, with the exact text, and Share points to it`, st.note && st.noteShown && st.noteText === SHARE_TEXT.note && st.noteAmber && st.noteOwnsDescription, st);
    check(`${tag} the order is Save, Copy, Share, the warning, then the status line`, st.order.join() === 'save,copy,share,note,status', st.order);
    check(`${tag} no confirm step: no Continue, no Cancel, no aria-expanded on Share`, !st.confirm && st.expanded === null, st);
    check(`${tag} nothing is shared before a press`, st.shares === 0 && st.copies === 0, st);
    check(`${tag} the status line is a polite live region and starts empty`, st.live === 'polite' && st.status === '', st);
    await p.shotOf(`${tag}-1-buttons`, '#results .ms-result-main');

    // A press shares straight away: exactly one file, the one Save downloads.
    await p.ev("document.querySelector('#results-list .ms-share-btn').click()");
    await p.waitFor('window.__share.calls.length === 1 && window.__share.calls[0].b64 !== null', 10000);
    const call = await p.ev('window.__share.calls[0]');
    const files = await p.download();
    const saved = files['image.public.jpg'];
    const shared = call && call.b64 !== null ? new Uint8Array(Buffer.from(call.b64, 'base64')) : null;
    check(`${tag} a press shares one file, image.public.jpg, as image/jpeg, titled with its name`, !!call && call.n === 1 && call.name === 'image.public.jpg' && call.type === 'image/jpeg' && call.title === 'image.public.jpg', call && { ...call, b64: undefined });
    check(`${tag} the shared bytes are exactly the bytes Save downloads`, !!saved && !!shared && saved.length === shared.length && Buffer.compare(Buffer.from(saved), Buffer.from(shared)) === 0, { saved: saved && saved.length, shared: shared && shared.length });
    if (shared) {
      const out = await inspect(shared);
      check(`${tag} the shared file has no red detail left`, !out.items.some((i) => i.tier === 'red'), out.items.map((i) => i.tier + ':' + i.id));
    }
    st = await p.ev(SHARE_STATE);
    check(`${tag} after sharing nothing is said, and the warning is still there`, st.status === '' && st.noteShown && st.noteText === SHARE_TEXT.note, st);

    // Every press shares at once.
    await p.ev("document.querySelector('#results-list .ms-share-btn').click()");
    await p.waitFor('window.__share.calls.length === 2', 10000);
    st = await p.ev(SHARE_STATE);
    check(`${tag} the second press shares at once too`, st.shares === 2 && !st.confirm, st);

    // The person closes the share sheet: AbortError, and nothing to say.
    await p.ev("window.__share.mode = 'abort'; document.querySelector('#results-list .ms-share-btn').click()");
    await p.waitFor('window.__share.calls.length === 3', 10000);
    await sleep(200);
    st = await p.ev(SHARE_STATE);
    check(`${tag} a closed share sheet (AbortError) says nothing and logs no error`, st.status === '' && p.log.errors.length === 0, { st, errors: p.log.errors });
    // Any other failure: a short message in the live region.
    await p.ev("window.__share.mode = 'fail'; document.querySelector('#results-list .ms-share-btn').click()");
    await p.waitFor(`document.querySelector('#results-list .ms-share-status').textContent !== ''`, 10000);
    st = await p.ev(SHARE_STATE);
    check(`${tag} another share failure says "${SHARE_TEXT.failed}"`, st.status === SHARE_TEXT.failed, st.status);
    await p.ev("window.__share.mode = 'ok'");

    // A new name: the button keeps its words, and the shared file carries the new name.
    await p.ev("(() => { const i = document.getElementById('name-input'); i.value = 'holiday.jpg'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    st = await p.ev(SHARE_STATE);
    check(`${tag} a typed name leaves the Share button as "${SHARE_TEXT.button}"`, st.shareText === SHARE_TEXT.button, st.shareText);
    await p.ev("document.querySelector('#results-list .ms-share-btn').click()");
    await p.waitFor('window.__share.calls.length === 5', 10000);
    check(`${tag} and the shared file carries the new name`, (await p.ev('window.__share.calls[4].name')) === 'holiday.public.jpg');
    await p.ev("(() => { const i = document.getElementById('name-input'); i.value = 'image'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");

    // Copy: a fresh PNG of the picture, without the file's details.
    await p.ev("document.querySelector('#results-list .ms-copy-btn').click()");
    await p.waitFor('window.__clip.calls.length === 1 && window.__clip.calls[0].b64 !== null', 20000);
    await p.waitFor(`document.querySelector('#results-list .ms-share-status').textContent === ${JSON.stringify(SHARE_TEXT.copied)}`, 5000);
    const clip = await p.ev('window.__clip.calls[0]');
    st = await p.ev(SHARE_STATE);
    check(`${tag} Copy writes one PNG to the clipboard and says "${SHARE_TEXT.copied}"`, clip.types.join() === 'image/png' && clip.type === 'image/png' && st.status === SHARE_TEXT.copied, { types: clip.types, type: clip.type, status: st.status });
    await p.ev(SKIP_CLOCK(5 * 60000));
    await sleep(200);
    check(`${tag} on the website the Copy line never expires (no 2 minutes there)`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.copied);
    check(`${tag} Copy shares nothing`, st.shares === 5, st.shares);
    if (clip.b64) {
      const png = new Uint8Array(Buffer.from(clip.b64, 'base64'));
      const out = await inspect(png);
      const src = await inspect(saved);
      check(`${tag} the copied PNG has the picture's size and no metadata at all`, out.format === 'png' && out.items.length === 0 && out.width === src.width && out.height === src.height, { format: out.format, items: out.items.map((i) => i.id), size: [out.width, out.height], src: [src.width, src.height] });
    }
    await p.ev("window.__clip.mode = 'fail'; document.querySelector('#results-list .ms-copy-btn').click()");
    await p.waitFor(`document.querySelector('#results-list .ms-share-status').textContent === ${JSON.stringify(SHARE_TEXT.copyFailed)}`, 10000);
    check(`${tag} a refused copy says "${SHARE_TEXT.copyFailed}"`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.copyFailed);

    // HEIC in Chromium: no share (not on the share list) and no copy (cannot be opened).
    await p.load(['heic-everything.heic']);
    await p.press();
    st = await p.ev(SHARE_STATE);
    check(`${tag} HEIC that the browser cannot open or share: neither Share nor Copy, and no warning`, !st.block && !st.share && !st.copy && !st.note, st);
    // A PNG: both, with the warning.
    await p.load(['png-everything.png']);
    await p.press();
    st = await p.ev(SHARE_STATE);
    check(`${tag} a PNG result offers Share and Copy, with the warning`, st.shareShown && st.copyShown && st.shareText === SHARE_TEXT.button && st.noteShown && st.noteText === SHARE_TEXT.note && st.order.join() === 'save,copy,share,note,status', st);
    // Several files: each result has its own buttons and its own warning.
    await p.load(['jpeg-everything.jpg', 'webp-everything.webp']);
    await p.press();
    const multi = await p.ev(`[...document.querySelectorAll('#results-list .ms-result')].map((a) => {
      const b = a.querySelector('.ms-share-btn');
      const n = a.querySelector('.ms-share-note');
      return { text: b && b.textContent, copy: !!a.querySelector('.ms-copy-btn'), note: n && n.textContent, own: !!b && !!n && b.getAttribute('aria-describedby') === n.id && document.getElementById(n.id) === n };
    })`);
    check(`${tag} several files: a Share, a Copy and a warning for each, each Share pointing to its own warning`, multi.length === 2 && multi.every((m) => m.text === SHARE_TEXT.button && m.copy && m.note === SHARE_TEXT.note && m.own), multi);
    const before = await p.ev('window.__share.calls.length');
    await p.ev("document.querySelectorAll('#results-list .ms-share-btn')[1].click()");
    await p.waitFor(`window.__share.calls.length === ${before + 1}`, 10000);
    const second = await p.ev(`window.__share.calls[${before}].name`);
    check(`${tag} several files: the second result's Share sends its own file`, /^image-2\.\w+\.webp$/.test(second || ''), second);

    const csp = await p.ev('window.__csp');
    check(`${tag} no policy violations`, csp.length === 0, csp);
    check(`${tag} no errors in the console`, p.log.errors.length === 0, p.log.errors);
    check(`${tag} nothing fetched from elsewhere`, p.log.offsite.length === 0, p.log.offsite);
    await p.close();
  }

  // Without the Web Share API: no Share button. Without ClipboardItem as well: no block.
  for (const [label, opts, want] of [
    ['no canShare', { share: false, clipboard: true }, { share: false, copy: true }],
    ['no canShare, no ClipboardItem', { share: false, clipboard: false }, { share: false, copy: false }],
    ['canShare, no ClipboardItem', { share: true, clipboard: false }, { share: true, copy: false }],
  ]) {
    const p = await openPage(360, 780, { init: shareStub(opts) });
    await p.load(['jpeg-everything.jpg']);
    await p.press();
    const st = await p.ev(SHARE_STATE);
    check(`share, ${label}: Share ${want.share ? 'shown' : 'absent'}, Copy ${want.copy ? 'shown' : 'absent'}`, st.share === want.share && st.shareShown === want.share && st.copy === want.copy && st.copyShown === want.copy && st.block === (want.share || want.copy), st);
    check(`share, ${label}: the warning ${want.share ? `shown with the exact text, after Share` : 'absent'}`, want.share ? st.note && st.noteShown && st.noteText === SHARE_TEXT.note && st.noteOwnsDescription && st.order.join() === (want.copy ? 'save,copy,share,note,status' : 'save,share,note,status') : !st.note && !st.noteShown, st);
    check(`share, ${label}: Save is still there`, await p.ev("document.querySelector('#results-list .ms-download')?.textContent") === 'Save image.public.jpg');
    check(`share, ${label}: no errors in the console`, p.log.errors.length === 0, p.log.errors);
    await p.close();
  }

  // The page as the Android app loads it: android-bridge.js first, then the page as usual.
  {
    // The share and clipboard stand-ins say yes, so only the bridge can hide Share and Copy.
    const p = await openPage(360, 780, { android: true, init: shareStub({ share: true, clipboard: true }) });
    const tag = 'android';
    const st = await p.ev(`(() => {
      const sec = document.querySelector('[data-web-only]');
      const r = sec ? sec.getBoundingClientRect() : null;
      return { first: document.scripts[0]?.getAttribute('src'), sec: !!sec, hidden: !!sec && sec.hidden, gone: !!sec && r.height === 0 && getComputedStyle(sec).display === 'none', link: !!sec && sec.querySelector('a').getBoundingClientRect().height, hello: (window.__msPosted || []).map((m) => m.t) };
    })()`);
    check(`${tag} the bridge loads before every other script, as in the APK`, st.first === BRIDGE_FILE, st);
    check(`${tag} page loads without errors`, p.log.errors.length === 0, p.log.errors);
    check(`${tag} the bridge hides the Android app section (hidden, not displayed, link takes no space)`, st.sec && st.hidden && st.gone && st.link === 0, st);
    check(`${tag} the bridge greets the app as before`, st.hello.join() === 'hello', st.hello);
    // The page otherwise works: load, prepare, and Save hands the file to the app.
    await p.load(['jpeg-everything.jpg']);
    check(`${tag} the picture loads and the details are listed`, await p.ev("document.querySelectorAll('#meta-groups .ms-check').length > 0 && !document.getElementById('workspace').hidden"));
    await p.press();
    const link = await p.ev("(() => { const a = document.querySelector('.ms-download'); return a ? { name: a.download, text: a.textContent } : null; })()");
    check(`${tag} the result offers Save image.public.jpg`, !!link && link.name === 'image.public.jpg' && link.text === 'Save image.public.jpg', link);
    const shareSt = await p.ev(SHARE_STATE);
    check(`${tag} with the app's channel, Copy, Share and the warning are shown as on the website, and not marked data-web-only`, shareSt.block && !shareSt.webOnly && shareSt.blockShown && shareSt.shareShown && shareSt.copyShown && shareSt.noteShown && shareSt.noteText === SHARE_TEXT.note && shareSt.order.join() === 'save,copy,share,note,status', shareSt);
    const before = p.completed.length;
    await p.ev("document.querySelector('.ms-download').click()");
    await p.waitFor("window.__msPosted.some((m) => m.t === 'out-begin')", 10000);
    await sleep(500);
    const begin = (await p.ev("window.__msPosted.find((m) => m.t === 'out-begin')")) || {};
    check(`${tag} Save is caught by the bridge and handed to the app as a save, not downloaded by the browser`, begin.action === 'save' && begin.name === 'image.public.jpg' && begin.mime === 'image/jpeg' && begin.size > 0 && begin.chunks >= 1 && p.completed.length === before, { begin, downloads: p.completed.length - before });
    // Pull the chunks the way the app does and check the file that arrives.
    const parts = [];
    for (let i = 0; i < begin.chunks; i++) {
      await p.ev(`window.__msListen({ data: JSON.stringify({ t: 'out-pull', id: ${begin.id}, index: ${i} }) })`);
      const c = await p.ev(`window.__msPosted.filter((m) => m.t === 'out-chunk' && m.id === ${begin.id} && m.index === ${i}).pop()`);
      parts.push(Buffer.from(c ? c.data : '', 'base64'));
    }
    await p.ev(`window.__msListen({ data: JSON.stringify({ t: 'out-done', id: ${begin.id} }) })`);
    const got = new Uint8Array(Buffer.concat(parts));
    const out = await inspect(got);
    check(`${tag} the file handed to the app is whole and has no red left`, got.length === begin.size && out.format === 'jpeg' && !out.items.some((i) => i.tier === 'red'), { size: got.length, expected: begin.size, left: out.items.map((i) => i.tier + ':' + i.id) });
    const csp = await p.ev('window.__csp');
    check(`${tag} no policy violations`, csp.length === 0, csp);
    check(`${tag} no errors in the console`, p.log.errors.length === 0, p.log.errors);
    check(`${tag} nothing fetched from elsewhere`, p.log.offsite.length === 0, p.log.offsite);
    await p.shot(`${tag}-1-result`);
    await p.close();
  }

  // The app (1.0.1): the same Save, Copy and Share as the website, through window.MSAndroid.
  // The stand-in channel answers as MainActivity does; the share and clipboard stand-ins say
  // no, as in Android's WebView, so only the app's channel can make the buttons appear.
  {
    const tag = 'app-mode';
    const p = await openPage(360, 780, { android: 'app', init: shareStub({ share: false, clipboard: false }) });
    const api = await p.ev(`(() => {
      const a = window.MSAndroid;
      let swapped = false;
      try { window.MSAndroid = { share() {}, copyImage() {} }; } catch { /* refused, as intended */ }
      swapped = window.MSAndroid !== a;
      return { has: !!a, frozen: !!a && Object.isFrozen(a), keys: a ? Object.keys(a).sort().join() : '', swapped };
    })()`);
    check(`${tag} the bridge adds window.MSAndroid with share and copyImage only, frozen and not replaceable`, api.has && api.frozen && api.keys === 'copyImage,share' && !api.swapped, api);
    const junk = await p.ev(`(async () => {
      const before = window.__ms.posted.length;
      const r = [
        await MSAndroid.share('https://example.com/x.jpg', 'x.jpg'),
        await MSAndroid.share({ size: 3, type: 'image/jpeg' }, 'x.jpg'),
        await MSAndroid.share(new Blob([]), 'x.jpg'),
        await MSAndroid.copyImage(new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' })),
        await MSAndroid.copyImage('file:///sdcard/DCIM/x.png'),
      ];
      return { results: r, posted: window.__ms.posted.length - before };
    })()`);
    check(`${tag} MSAndroid refuses anything but a non-empty Blob (a PNG for Copy): no address, no path, nothing posted`, junk.results.every((x) => x === false) && junk.posted === 0, junk);
    await p.load(['jpeg-everything.jpg']);
    await p.press();
    let st = await p.ev(SHARE_STATE);
    check(`${tag} Copy image, "${SHARE_TEXT.button}" and the warning show under Save, in the website's order`, st.block && !st.webOnly && st.blockShown && st.copyShown && st.copyText === 'Copy image' && st.shareShown && st.shareText === SHARE_TEXT.button && st.order.join() === 'save,copy,share,note,status', st);
    check(`${tag} Share is pink like Save, and the amber warning is always shown under it with the exact text`, st.primary && st.noteShown && st.noteAmber && st.noteText === SHARE_TEXT.note && st.noteOwnsDescription, st);
    check(`${tag} nothing reaches the app before a press`, (await p.ev('window.__ms.files.length')) === 0);

    // Save: one save, nothing else.
    const before = p.completed.length;
    await p.ev("document.querySelector('#results-list .ms-download').click()");
    await p.waitFor('window.__ms.files.length === 1', 10000);
    const saved = await p.ev('window.__ms.files[0]');
    check(`${tag} Save hands the app image.public.jpg as a save only (no share, no copy), and the browser downloads nothing`, !!saved && saved.action === 'save' && saved.name === 'image.public.jpg' && saved.mime === 'image/jpeg' && p.completed.length === before && (await p.ev("window.__ms.posted.filter((m) => m.t === 'out-begin').map((m) => m.action).join()")) === 'save', saved && { ...saved, parts: saved.parts.length });
    const savedBytes = appFileBytes(saved);
    check(`${tag} the saved file is whole`, savedBytes.length === saved.size && savedBytes.length > 0, { got: savedBytes.length, size: saved.size });

    // Share: exactly the saved bytes and name, straight away.
    await p.ev("document.querySelector('#results-list .ms-share-btn').click()");
    await p.waitFor('window.__ms.files.length === 2', 10000);
    const shared = await p.ev('window.__ms.files[1]');
    const sharedBytes = appFileBytes(shared);
    check(`${tag} Share hands the app one file to share, image.public.jpg, image/jpeg`, !!shared && shared.action === 'share' && shared.name === 'image.public.jpg' && shared.mime === 'image/jpeg', shared && { ...shared, parts: shared.parts.length });
    check(`${tag} the shared bytes are exactly the saved bytes`, savedBytes.length > 0 && Buffer.compare(savedBytes, sharedBytes) === 0, { saved: savedBytes.length, shared: sharedBytes.length });
    await sleep(200);
    st = await p.ev(SHARE_STATE);
    check(`${tag} after sharing nothing is said and the warning is still there`, st.status === '' && st.noteShown, st);

    // Copy: a fresh PNG without file details, called image.png.
    await p.ev("document.querySelector('#results-list .ms-copy-btn').click()");
    await p.waitFor('window.__ms.files.length === 3', 20000);
    await p.waitFor(`document.querySelector('#results-list .ms-share-status').textContent === ${JSON.stringify(SHARE_TEXT.copiedApp)}`, 5000);
    const copied = await p.ev('window.__ms.files[2]');
    const png = await inspect(new Uint8Array(appFileBytes(copied)));
    const src = await inspect(new Uint8Array(savedBytes));
    check(`${tag} Copy hands the app image.png, a PNG with no metadata at all, at the picture's size, and says "${SHARE_TEXT.copiedApp}"`, !!copied && copied.action === 'copy' && copied.name === 'image.png' && copied.mime === 'image/png' && png.format === 'png' && png.items.length === 0 && png.width === src.width && png.height === src.height, copied && { action: copied.action, name: copied.name, mime: copied.mime, items: png.items.map((i) => i.id), size: [png.width, png.height] });
    check(`${tag} in the app, the line after Copy is "${SHARE_TEXT.copiedApp}", not the website's`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.copiedApp && SHARE_TEXT.copiedApp !== SHARE_TEXT.copied);

    // The copy's end (1.0.1, Marcos: "fix it"). The stand-in reports a shortened time left
    // (copyLife) instead of 2 minutes, and SKIP_CLOCK moves Date.now on and fires
    // 'visibilitychange', as when Android shows the app again after freezing it.
    {
      const is = (t) => `document.querySelector('#results-list .ms-share-status').textContent === ${JSON.stringify(t)}`;
      const copyNow = async (life) => {
        await p.ev(`window.__ms.copyLife = ${life}; document.querySelector('#results-list .ms-share-status').textContent = ''; document.querySelector('#results-list .ms-copy-btn').click()`);
        return p.waitFor(is(SHARE_TEXT.copiedApp), 20000);
      };
      check(`${tag} the line after Copy is a polite live region`, (await p.ev(SHARE_STATE)).live === 'polite');
      await copyNow(1500);
      const t1 = Date.now();
      const ended = await p.waitFor(is(SHARE_TEXT.copyExpiredApp), 10000);
      check(`${tag} when the copy's time is up, the line becomes "${SHARE_TEXT.copyExpiredApp}"`, ended && Date.now() - t1 >= 1000, { ended, after: Date.now() - t1 });
      await copyNow(120000);
      await sleep(300);
      const before = await p.ev(SHARE_STATE);
      await p.ev('window.__ms.expire()');
      check(`${tag} the app's own word that the copy ended changes the line at once`, before.status === SHARE_TEXT.copiedApp && await p.waitFor(is(SHARE_TEXT.copyExpiredApp), 2000));
      await copyNow(120000);
      await p.ev(SKIP_CLOCK(60000));
      await sleep(200);
      check(`${tag} back after 1 minute, the copy still reads as live`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.copiedApp);
      await p.ev(SKIP_CLOCK(61000));
      await sleep(200);
      check(`${tag} back after 2 minutes (timers frozen meanwhile), the line already reads as expired`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.copyExpiredApp);
      await copyNow(2500);
      await sleep(1500);
      await copyNow(2500);
      await sleep(1500);
      check(`${tag} a new Copy starts the time again`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.copiedApp);
      check(`${tag} and then it ends in turn`, await p.waitFor(is(SHARE_TEXT.copyExpiredApp), 10000));
      await p.ev('window.__ms.copyLife = 120000');
    }

    // The app reports a failure: the page says so.
    await p.ev("window.__ms.mode = 'fail'; document.querySelector('#results-list .ms-share-btn').click()");
    await p.waitFor(`document.querySelector('#results-list .ms-share-status').textContent === ${JSON.stringify(SHARE_TEXT.failed)}`, 10000);
    check(`${tag} a share the app could not do says "${SHARE_TEXT.failed}"`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.failed);
    await p.ev("document.querySelector('#results-list .ms-copy-btn').click()");
    await p.waitFor(`document.querySelector('#results-list .ms-share-status').textContent === ${JSON.stringify(SHARE_TEXT.copyFailed)}`, 20000);
    check(`${tag} a copy the app could not do says "${SHARE_TEXT.copyFailed}"`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.copyFailed);
    await p.ev("window.__ms.mode = 'ok'");

    // A typed name: Share carries the new name, as Save does.
    await p.ev("(() => { const i = document.getElementById('name-input'); i.value = 'holiday.jpg'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await sleep(200);
    const n = await p.ev('window.__ms.files.length');
    await p.ev("document.querySelector('#results-list .ms-share-btn').click()");
    await p.waitFor(`window.__ms.files.length === ${n + 1}`, 10000);
    const renamed = await p.ev(`window.__ms.files[${n}]`);
    check(`${tag} after a typed name, Share hands the app holiday.public.jpg`, !!renamed && renamed.name === 'holiday.public.jpg' && renamed.action === 'share', renamed && { name: renamed.name, action: renamed.action });
    const csp = await p.ev('window.__csp');
    check(`${tag} no policy violations`, csp.length === 0, csp);
    check(`${tag} no errors in the console`, p.log.errors.length === 0, p.log.errors);
    check(`${tag} nothing fetched from elsewhere`, p.log.offsite.length === 0, p.log.offsite);
    await p.shot(`${tag}-1-result`);
    await p.close();
  }

  // The privacy page, reached the way a person reaches it: the footer's Privacy link. It
  // must load with the app's own policy, no errors, nothing from elsewhere, and lead back.
  {
    const tag = 'privacy';
    const metaCsp = (file) => (/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(readFileSync(join(ROOT, file), 'utf8')) || [])[1];
    check(`${tag} privacy.html carries exactly the policy of index.html`, !!metaCsp('privacy.html') && metaCsp('privacy.html') === metaCsp('index.html'), { privacy: metaCsp('privacy.html'), index: metaCsp('index.html') });
    const html = readFileSync(join(ROOT, 'privacy.html'), 'utf8');
    const local = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]).filter((r) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(r));
    const missing = local.filter((r) => { const f = join(ROOT, r.split(/[?#]/)[0] || 'index.html'); return !existsSync(f.endsWith('/') ? join(f, 'index.html') : f); });
    check(`${tag} every local file privacy.html refers to exists`, local.length > 0 && missing.length === 0, missing);
    check(`${tag} disclaimer.html links to the app's own privacy page`, /<a href="privacy\.html">Privacy<\/a><\/footer>/.test(readFileSync(join(ROOT, 'disclaimer.html'), 'utf8')));

    const p = await openPage(360, 780);
    const link = await p.ev(`(() => {
      const all = [...document.querySelectorAll('a')].filter((a) => a.textContent.trim() === 'Privacy');
      return all.map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), footer: !!a.closest('.site-footer') }));
    })()`);
    check(`${tag} the app's footer has one Privacy link, to privacy.html, opening in place`, link.length === 1 && link[0].href === 'privacy.html' && link[0].target === null && link[0].footer, link);
    // A click starts a navigation, during which evaluation can fail; ask again until the new page answers.
    const until = async (expression, ms = 10000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try { if (await p.ev(expression)) return true; } catch { /* the page is changing */ }
        await sleep(100);
      }
      return false;
    };
    await p.ev("document.querySelector('.site-footer a[href=\"privacy.html\"]').click()");
    const arrived = await until("location.pathname === '/privacy.html' && document.readyState === 'complete'");
    await sleep(300);
    check(`${tag} the footer link opens privacy.html`, arrived, await p.ev('location.href').catch(() => null));
    const st = await p.ev(`(() => {
      const first = document.head.firstElementChild;
      const body = getComputedStyle(document.body);
      const cur = document.querySelector('.site-footer a[aria-current="page"]');
      return { title: document.title, h1: document.querySelector('h1')?.textContent, scripts: document.scripts.length,
        firstMeta: first && first.getAttribute('http-equiv'), sheets: document.styleSheets.length, bg: body.backgroundColor, font: body.fontFamily,
        card: !!document.querySelector('main .card.pp-doc'), sections: [...document.querySelectorAll('.pp-doc h2')].map((h) => h.textContent),
        updated: document.querySelector('.pp-updated')?.textContent, current: cur && cur.getAttribute('href'), disclaimer: !!document.querySelector('.site-footer a[href="disclaimer.html"]'),
        overflow: document.documentElement.scrollWidth - innerWidth, back: document.querySelector('.pp-back')?.getAttribute('href'), gate: !!document.querySelector('.sb-gate-overlay') };
    })()`);
    check(`${tag} title, heading and date`, st.title === 'Privacy · MetadataScrubber · Stormberry AS' && st.h1 === 'Privacy' && st.updated === 'Last updated: 5 October 2026', st);
    check(`${tag} the policy is the first element in head, and the page runs no scripts`, st.firstMeta === 'Content-Security-Policy' && st.scripts === 0, st);
    check(`${tag} the app's own stylesheets apply: dark page, Inter, the card`, st.sheets === 2 && st.bg === 'rgb(12, 10, 18)' && /Inter/.test(st.font) && st.card, st);
    check(`${tag} the sections a reader looks for are there`, ['Who is responsible', 'Your photos stay on your device', 'What we receive', 'Sharing and copying', 'Where you got the app', 'Your rights', 'Changes to this page'].join() === st.sections.join(), st.sections);
    check(`${tag} the same footer, with Privacy marked as the current page and the Disclaimer link`, st.current === 'privacy.html' && st.disclaimer, st);
    check(`${tag} no sideways scrolling at 360 pixels`, st.overflow <= 0, st.overflow);
    check(`${tag} no first-run notice on the privacy page`, !st.gate);
    const csp = await p.ev('window.__csp');
    check(`${tag} no policy violations`, csp.length === 0, csp);
    check(`${tag} no errors in the console`, p.log.errors.length === 0, p.log.errors);
    check(`${tag} nothing fetched from elsewhere`, p.log.offsite.length === 0, p.log.offsite);
    await p.shot(`${tag}-360`);
    // Back to the app: the notice, already dismissed, stays away.
    await p.ev("document.querySelector('.pp-back').click()");
    const back = await until("location.pathname === '/' && document.readyState === 'complete' && !!document.getElementById('choose-btn')");
    await sleep(300);
    check(`${tag} "Back to MetadataScrubber" returns to the app, without the first-run notice`, st.back === './' && back && !(await p.ev("!!document.querySelector('.sb-gate-overlay')")));
    check(`${tag} no errors in the console after going back`, p.log.errors.length === 0, p.log.errors);
    await p.close();
  }
} catch (err) {
  failures += 1;
  console.log(`FAIL harness: ${err.stack || err}`);
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  if (!KEEP) rmSync(downloads, { recursive: true, force: true });
}

const offsite = requests.filter((r) => !existsSync(join(ROOT, r)) && r !== '/' && r !== `/${BRIDGE_FILE}`);
console.log(`\n${passes} passed, ${failures} failed. Screenshots in ${OUT}${offsite.length ? `\nMissing files requested: ${[...new Set(offsite)].join(', ')}` : ''}`);
process.exit(failures ? 1 : 0);
