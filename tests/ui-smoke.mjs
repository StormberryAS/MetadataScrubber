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

// ---- Static server ---------------------------------------------------------------------
const requests = [];
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  requests.push(path);
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
async function openPage(width, height) {
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
  await s('Page.navigate', { url: BASE });
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
  const close = async () => {
    listeners.delete(onMsg);
    await send('Target.closeTarget', { targetId });
    await send('Target.disposeBrowserContext', { browserContextId });
  };
  return { s, ev, load, press, pressIdle, download, shot, shotOf, close, log, waitFor };
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

    // A full JPEG, default choice: red removed, lossless.
    check(`${tag} page loads without errors`, p.log.errors.length === 0, p.log.errors);
    await p.load(['jpeg-everything.jpg']);
    const meta = await p.ev(`(() => {
      const groups = [...document.querySelectorAll('#meta-groups .ms-group-title')].map(e => e.textContent);
      const boxes = [...document.querySelectorAll('#meta-groups .ms-check')];
      const rows = boxes.map(b => ({ id: b.dataset.id, checked: b.checked, tier: b.closest('.ms-item').dataset.tier, badge: b.closest('.ms-item').querySelector('.tier-badge').textContent }));
      return { groups, rows, pressed: document.querySelector('#quick [aria-pressed="true"]')?.textContent, mode: document.getElementById('mode-line').textContent, webp: !!document.querySelector('#format-select option[value="webp"]') };
    })()`);
    const src = await inspect(new Uint8Array(readFileSync(join(FIX, 'jpeg-everything.jpg'))));
    check(`${tag} lists every item the engine finds`, meta.rows.length === src.items.length, [meta.rows.length, src.items.length]);
    check(`${tag} groups follow the engine order`, meta.groups.join() === ['Where', 'Who', 'When', 'Device', 'Hidden extras', 'Technical'].filter((g) => meta.groups.includes(g)).join(), meta.groups);
    check(`${tag} red items, and only red items, are ticked`, meta.rows.every((r) => r.checked === (r.tier === 'red')));
    check(`${tag} every tier is shown in words`, meta.rows.every((r) => r.badge === { red: 'Red', amber: 'Amber', green: 'Green' }[r.tier]));
    check(`${tag} "Red only" is the pressed quick choice`, meta.pressed === 'Red only', meta.pressed);
    check(`${tag} lossless is announced`, /^Lossless/.test(meta.mode), meta.mode);
    const buttons = await p.ev("[...document.querySelectorAll('button')].filter(b => !b.closest('[hidden]') && /remove metadata|prepare/i.test(b.textContent)).map(b => b.textContent.trim())");
    check(`${tag} one action button, "Prepare picture"`, buttons.length === 1 && buttons[0] === 'Prepare picture', buttons);
    check(`${tag} WebP is offered when Chromium can save it`, meta.webp);
    await p.shot(`${tag}-1-loaded`);
    await p.press();
    let files = await p.download();
    let name = Object.keys(files)[0];
    check(`${tag} download is named image.public.jpg`, name === 'image.public.jpg', Object.keys(files));
    if (name) {
      const out = await inspect(files[name]);
      check(`${tag} no red item is left`, !out.items.some((i) => i.tier === 'red'), out.items.filter((i) => i.tier === 'red').map((i) => i.id));
      check(`${tag} privacy word matches the read-back`, privacyWord(out.items) === 'public');
      const shown = await p.ev("document.querySelectorAll('#results-list .ms-item').length");
      check(`${tag} read-back list shows what remains`, shown === out.items.length, [shown, out.items.length]);
      if (python) check(`${tag} lossless: decoded pixels identical`, pil(LOSSLESS_PY, join(FIX, 'jpeg-everything.jpg'), tmpFile(name, files[name])));
    }
    await p.shotOf(`${tag}-2-result`, '#results');

    // The name field renames the link without making the file again.
    await p.ev("(() => { const i = document.getElementById('name-input'); i.value = 'holiday.jpg'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    check(`${tag} typed name is used, extension dropped`, await p.ev("document.querySelector('.ms-download').download") === 'holiday.public.jpg');
    await p.ev("(() => { const i = document.getElementById('name-input'); i.value = 'image'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");

    // None alone changes nothing, so no file is made and the page says why.
    await p.ev("document.querySelector('#quick [data-preset=none]').click()");
    check(`${tag} changing the choice clears the old file`, await p.ev("document.getElementById('results').hidden && !document.getElementById('go-stale').hidden"));
    const idle = await p.pressIdle();
    check(`${tag} None with nothing else chosen makes no file and says why`, idle.results && !idle.links && idle.text === 'Nothing to change yet: tick something to remove, or choose a crop, size or format.' && idle.focus === 'go-btn', idle);
    // None with a resize: everything kept, so the word is custom with the red warning.
    await p.ev("(() => { const i = document.getElementById('resize-percent'); i.value = '50'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    check(`${tag} choosing a size takes the message away`, await p.ev("document.getElementById('go-nothing').hidden"));
    await p.press();
    check(`${tag} None with a resize gives custom and the red warning`, await p.ev("document.querySelector('.ms-word').textContent === 'custom' && !!document.querySelector('.ms-word-warning')"));
    await p.ev("document.querySelector('input[name=resize][value=none]').click()");

    // Select all on a picture with normal rotation: still lossless.
    await p.ev("document.querySelector('#quick [data-preset=all]').click()");
    check(`${tag} Select all on normal rotation stays lossless`, /^Lossless/.test(await p.ev("document.getElementById('mode-line').textContent")));
    await p.press();
    files = await p.download();
    name = Object.keys(files)[0];
    if (name) {
      const out = await inspect(files[name]);
      check(`${tag} Select all leaves ${out.items.length ? out.items.map((i) => i.id).join(', ') : 'nothing'}`, name === `image.${privacyWord(out.items)}.jpg`, name);
    }

    // Rotation 6: Red only keeps the tag and stays lossless; Select all bakes it.
    await p.load(['jpeg-orientation-6.jpg']);
    const pre = await p.ev("({ summary: document.getElementById('file-summary').textContent, mode: document.getElementById('mode-line').textContent, canvas: [document.getElementById('preview-canvas').width, document.getElementById('preview-canvas').height] })");
    check(`${tag} sideways picture is shown upright`, pre.canvas[1] > pre.canvas[0] && /480 × 640/.test(pre.summary), pre);
    check(`${tag} rotation kept: lossless`, /^Lossless/.test(pre.mode), pre.mode);
    await p.ev("document.querySelector('#quick [data-preset=all]').click()");
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
    await p.ev("document.querySelector('#quick [data-preset=red]').click()");
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
      check(`${tag} HEIC: no red left`, !out.items.some((i) => i.tier === 'red'), out.items.map((i) => i.id));
    }
    await p.shot(`${tag}-6-heic`);

    // Several files at once, plus one that is not a picture.
    await p.load(['jpeg-everything.jpg', 'webp-everything.webp', 'not-an-image.pdf']);
    const multi = await p.ev("({ err: document.getElementById('pick-errors').textContent, files: document.querySelectorAll('#file-list .ms-file').length, crop: document.getElementById('crop-toggle').closest('label').hidden })");
    check(`${tag} unsupported file gets a clear message`, /not-an-image\.pdf" is not a JPEG, PNG, WebP or HEIC picture/.test(multi.err), multi.err);
    check(`${tag} two pictures listed, crop off`, multi.files === 2 && multi.crop, multi);
    check(`${tag} the button says "Prepare pictures" for several`, await p.ev("document.getElementById('go-btn').textContent") === 'Prepare pictures');
    await p.press();
    files = await p.download();
    const names = Object.keys(files).sort();
    check(`${tag} numbered names`, names.length === 2 && /^image-1\.\w+\.jpg$/.test(names[0]) && /^image-2\.\w+\.webp$/.test(names[1]), names);
    await p.shotOf(`${tag}-7-multi`, '#results');

    // Layout: nothing wider than the screen.
    const overflow = await p.ev("(() => { const vw = document.documentElement.clientWidth; const bad = []; for (const el of document.querySelectorAll('main *')) { const b = el.getBoundingClientRect(); if (b.width && (b.right > vw + 0.5 || b.left < -0.5)) bad.push(el.tagName + '.' + el.className); } return { sw: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 5) }; })()");
    check(`${tag} no horizontal overflow`, overflow.sw <= overflow.vw && !overflow.bad.length, overflow);

    // A picture with no metadata at all.
    const plain = join(downloads, 'plain.png');
    writeFileSync(plain, plainPng(32, 24));
    await p.load([plain]);
    const none = await p.ev("({ empty: !document.getElementById('meta-empty').hidden && document.getElementById('meta-empty').textContent, quick: document.getElementById('quick').hidden })");
    check(`${tag} no metadata is said plainly`, none.empty === 'This file has no metadata. There is nothing hidden to remove.' && none.quick, none);
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

const offsite = requests.filter((r) => !existsSync(join(ROOT, r)) && r !== '/');
console.log(`\n${passes} passed, ${failures} failed. Screenshots in ${OUT}${offsite.length ? `\nMissing files requested: ${[...new Set(offsite)].join(', ')}` : ''}`);
process.exit(failures ? 1 : 0);
