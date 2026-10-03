#!/usr/bin/env node
// End-to-end test of MetadataScrubber in headless Chromium, set up to behave like production.
//
//   node tests/e2e.mjs [--out DIR] [--only name,name] [--chromium PATH] [--keep]
//
// What "like production" means here:
//  * tests/serve.py serves the repository over HTTPS with the headers the stormberry.as zone
//    sends (the zone Content-Security-Policy verbatim, HSTS, nosniff, Speed Brain speculation
//    rules and so on), and only the files GitHub Pages would publish;
//  * Chromium loads the page as https://metadata.stormberry.as/. The name is mapped to the
//    local server and the throwaway certificate is trusted by its key hash, for this browser
//    only. Every other host name is made unresolvable, so nothing can leave this machine even
//    if the page tried, and any such attempt is still recorded;
//  * every flow runs in a fresh browser context, so the first-run gate appears and is
//    dismissed with a real click, as a first-time visitor would.
//
// It drives the page over the DevTools protocol with Node's own WebSocket (no packages):
// files go in with DOM.setFileInputFiles, buttons are pressed with real mouse events (or
// taps on the phone-sized runs) after checking nothing covers them, and the new files are
// caught with Browser.setDownloadBehavior. Each download is then checked outside the browser:
// the engine reads it back in Node, exiftool lists what it can still see, the planted
// strings in tests/fixtures/out/canaries.tsv are searched for, and Pillow (or ImageMagick
// for HEIC) compares the decoded pixels.
//
// Recorded throughout: every network request, console message, browser log entry, uncaught
// exception and policy violation. Screenshots of the main states at 1280x900 and 390x844
// go to DIR/shots.
//
// Needs: /usr/bin/chromium (or --chromium), python3 with Pillow, exiftool, ImageMagick 7
// (magick) and openssl, plus the fixtures (tests/fixtures/make-fixtures.sh).
//
// Exit status: 0 when every check passes, 1 when a check of the page or of this harness
// fails, 2 when the only failures are in the scrubbing engine (src/), which this harness
// reports but does not judge the page by.
//
// The file name does not end in .test.mjs, so `node --test tests/` does not run it.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS, detectFormat, inspect, privacyWord } from '../src/scrub-core.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIX = join(ROOT, 'tests', 'fixtures', 'out');
const REGISTRY = join(FIX, 'canaries.tsv');
const HOST = 'metadata.stormberry.as';
const ORIGIN = `https://${HOST}`;
const PAGE_URL = `${ORIGIN}/`;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CHROMIUM = opt('--chromium', process.env.CHROMIUM || '/usr/bin/chromium');
const OUT = resolve(opt('--out', process.env.MS_E2E_OUT || join(tmpdir(), 'metadatascrubber-e2e')));
const ONLY = (opt('--only', '') || '').split(',').filter(Boolean);
const KEEP = args.includes('--keep');

const DESKTOP = { width: 1280, height: 900, mobile: false, label: 'desktop' };
const PHONE = { width: 390, height: 844, mobile: true, label: 'phone' };

// ---------------------------------------------------------------------------------------
// Preconditions

const NEED = ['jpeg-everything.jpg', 'jpeg-orientation-6.jpg', 'jpeg-large.jpg', 'png-transparent.png', 'webp-everything.webp',
  'heic-everything.heic', 'png-everything.png', 'jpeg-motion-photo.jpg', 'jpeg-ultrahdr-like.jpg', 'not-an-image.pdf', 'truncated.jpg', 'canaries.tsv'];
for (const f of NEED) {
  if (!existsSync(join(FIX, f))) {
    console.error(`Missing fixture ${f}. Build the fixtures first: tests/fixtures/make-fixtures.sh`);
    process.exit(1);
  }
}
for (const [tool, probe] of [['python3', ['-c', 'import PIL']], ['exiftool', ['-ver']], ['magick', ['-version']], ['openssl', ['version']]]) {
  if (spawnSync(tool, probe).status !== 0) {
    console.error(`This harness needs ${tool}${tool === 'python3' ? ' with Pillow' : ''}.`);
    process.exit(1);
  }
}
if (!existsSync(CHROMIUM)) {
  console.error(`Chromium not found at ${CHROMIUM}. Pass --chromium PATH.`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, 'run-'));
const SHOTS = join(OUT, 'shots');
const DOWNLOADS = join(RUN, 'downloads');
const CHECKS = join(RUN, 'checks');
for (const d of [SHOTS, DOWNLOADS, CHECKS]) mkdirSync(d, { recursive: true });
const PROFILE = mkdtempSync(join(RUN, 'chromium-profile-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

// ---------------------------------------------------------------------------------------
// Results

const results = []; // { flow, name, ok, category, detail, level }
let currentFlow = 'setup';
function check(name, ok, detail, category = 'ui') {
  results.push({ flow: currentFlow, name, ok: !!ok, category, detail: ok ? undefined : detail, level: ok ? 'pass' : 'fail' });
  const tag = ok ? 'ok  ' : category === 'engine' ? 'FAIL[engine]' : 'FAIL';
  console.log(`  ${tag} ${name}${!ok && detail !== undefined ? `\n         ${typeof detail === 'string' ? detail : J(detail)}` : ''}`);
  return !!ok;
}
function note(name, detail) {
  results.push({ flow: currentFlow, name, ok: true, category: 'note', detail, level: 'note' });
  console.log(`  note ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : J(detail)}` : ''}`);
}

// ---------------------------------------------------------------------------------------
// The local production stand-in

const serveLog = join(RUN, 'serve.log');
const server = spawn('python3', [join(ROOT, 'tests', 'serve.py'), '--tls', '--log', serveLog], {
  env: { ...process.env, TMPDIR: RUN }, stdio: ['ignore', 'pipe', 'inherit'],
});
const ready = await new Promise((res, rej) => {
  let buf = '';
  const t = setTimeout(() => rej(new Error('serve.py did not start')), 20000);
  server.stdout.on('data', (d) => {
    buf += d;
    const m = /READY (\S+) spki=(\S+)/.exec(buf);
    if (m) { clearTimeout(t); res({ url: m[1], spki: m[2] }); }
  });
  server.on('exit', (code) => rej(new Error(`serve.py exited with ${code}`)));
});
const PORT = Number(new URL(ready.url).port);

// ---------------------------------------------------------------------------------------
// Chromium and the DevTools protocol

const chrome = spawn(CHROMIUM, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`,
  `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${PORT}, MAP * ~NOTFOUND`,
  `--ignore-certificate-errors-spki-list=${ready.spki}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
  '--disable-sync', '--disable-component-update', '--disable-default-apps', '--password-store=basic',
  '--use-mock-keychain', '--lang=en-GB', '--hide-scrollbars', '--disable-breakpad', '--disable-crash-reporter', 'about:blank',
], {
  stdio: ['ignore', 'ignore', 'pipe'],
  // Chromium keeps its crash-report folder under the default profile location even when
  // --user-data-dir points elsewhere. Pointing the config home at the run folder keeps
  // this throwaway browser out of the person's own Chromium settings entirely.
  env: { ...process.env, XDG_CONFIG_HOME: join(RUN, 'xdg-config'), CHROME_CONFIG_HOME: join(RUN, 'xdg-config'), XDG_CACHE_HOME: join(RUN, 'xdg-cache') },
});
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  const t = setTimeout(() => rej(new Error('Chromium did not start')), 30000);
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
    if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
    else p.res(m.result);
  } else for (const fn of listeners) fn(m);
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej, method });
  ws.send(J({ id, method, params, sessionId }));
});

// Downloads are browser events, keyed by guid.
const downloads = new Map(); // guid -> { name, url, state, dir }
listeners.add((m) => {
  if (m.method === 'Browser.downloadWillBegin') downloads.set(m.params.guid, { name: m.params.suggestedFilename, url: m.params.url, state: 'started' });
  if (m.method === 'Browser.downloadProgress') {
    const d = downloads.get(m.params.guid);
    if (d) d.state = m.params.state;
  }
});

// Everything recorded, across all flows.
const record = { requests: [], failed: [], responses: [], console: [], logs: [], exceptions: [], issues: [], csp: [] };

// ---------------------------------------------------------------------------------------
// One page in a fresh browser context

async function openPage(view) {
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  const flow = currentFlow;
  const page = { view, flow, phase: 'loading', inflight: new Map(), lastNet: Date.now(), loadFired: false, dl: join(DOWNLOADS, `${flow}-${view.label}`) };
  mkdirSync(page.dl, { recursive: true });

  const onMsg = (m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    const at = { flow, view: view.label, phase: page.phase };
    switch (m.method) {
      case 'Network.requestWillBeSent':
        record.requests.push({ ...at, id: p.requestId, url: p.request.url, method: p.request.method, type: p.type, initiator: p.initiator?.type });
        page.inflight.set(p.requestId, p.request.url);
        page.lastNet = Date.now();
        break;
      case 'Network.loadingFinished':
        page.inflight.delete(p.requestId);
        page.lastNet = Date.now();
        break;
      case 'Network.loadingFailed':
        record.failed.push({ ...at, url: page.inflight.get(p.requestId), error: p.errorText, blocked: p.blockedReason, cors: p.corsErrorStatus });
        page.inflight.delete(p.requestId);
        page.lastNet = Date.now();
        break;
      case 'Network.responseReceived':
        record.responses.push({ ...at, url: p.response.url, status: p.response.status, mime: p.response.mimeType, type: p.type });
        break;
      case 'Runtime.consoleAPICalled':
        record.console.push({ ...at, type: p.type, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ') });
        break;
      case 'Log.entryAdded':
        record.logs.push({ ...at, level: p.entry.level, source: p.entry.source, text: p.entry.text, url: p.entry.url });
        break;
      case 'Runtime.exceptionThrown':
        record.exceptions.push({ ...at, text: p.exceptionDetails.exception?.description || p.exceptionDetails.text });
        break;
      case 'Audits.issueAdded':
        record.issues.push({ ...at, code: p.issue.code, details: p.issue.details });
        break;
      case 'Page.loadEventFired':
        page.loadFired = true;
        break;
      default:
    }
  };
  listeners.add(onMsg);

  await s('Page.enable');
  await s('Runtime.enable');
  await s('Network.enable');
  await s('Log.enable');
  await s('Audits.enable');
  await s('DOM.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: view.mobile ? 2 : 1, mobile: view.mobile });
  if (view.mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: page.dl, eventsEnabled: true, browserContextId });
  // Policy violations as the page sees them. DevTools-injected scripts are not subject to
  // the page policy, so this listener itself causes none.
  await s('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__e2eCsp=[];document.addEventListener('securitypolicyviolation',e=>window.__e2eCsp.push({d:e.violatedDirective,u:e.blockedURI,s:e.sourceFile,l:e.lineNumber,o:e.originalPolicy.slice(0,60)}),true);",
  });

  const ev = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 30000, label = expression) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ev(expression)) return true;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const networkIdle = async (quiet = 600, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (page.inflight.size === 0 && Date.now() - page.lastNet >= quiet) return;
      await sleep(50);
    }
  };

  // Presses an element where a person would: in its centre, after scrolling it into view,
  // and only if nothing else (an overlay, a sticky bar) is on top of it there.
  const point = async (selector, index = 0) => {
    const r = await ev(`(() => {
      const el = document.querySelectorAll(${J(selector)})[${index}];
      if (!el) return { err: 'not found' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return { err: 'not visible' };
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const hit = document.elementFromPoint(x, y);
      const ok = !!hit && (hit === el || el.contains(hit) || (el.control && el.control === hit) || (hit.control && hit.control === el));
      return { x, y, ok, hit: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/).join('.') : '') : null };
    })()`);
    if (r.err) throw new Error(`cannot press ${selector}: ${r.err}`);
    if (!r.ok) throw new Error(`cannot press ${selector}: covered by ${r.hit}`);
    return r;
  };
  const click = async (selector, index = 0) => {
    const { x, y } = await point(selector, index);
    if (view.mobile) {
      // A finger tap. (Input.synthesizeTapGesture gives a pointerdown but no click in
      // headless Chromium, so the touch events are sent directly.)
      await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 4, radiusY: 4 }] });
      await sleep(40);
      await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    await sleep(80);
  };
  const typeInto = async (selector, text) => {
    await click(selector);
    await ev(`document.querySelector(${J(selector)}).select()`);
    await s('Input.insertText', { text });
    await sleep(80);
  };
  const setSelect = async (selector, value) => {
    await point(selector);
    await ev(`(() => { const el = document.querySelector(${J(selector)}); el.focus(); el.value = ${J(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(80);
  };
  const setFiles = async (names) => {
    const { root } = await s('DOM.getDocument', { depth: 0 });
    const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
    await s('DOM.setFileInputFiles', { nodeId, files: names.map((n) => (n.startsWith('/') ? n : join(FIX, n))) });
  };
  // Loads files through the real file input and waits for the page's own announcement.
  const load = async (names) => {
    await ev("document.getElementById('announcer').textContent = ''");
    await setFiles(names);
    await waitFor("/loaded\\.|No picture could be read\\./.test(document.getElementById('announcer').textContent)", 60000, 'the files to load');
    await sleep(150);
  };
  // The page scrolls smoothly to the result; a tap sent while it still moves would land
  // somewhere else, so wait until the page is still.
  const settle = async () => {
    let last = await ev('scrollY');
    for (let i = 0; i < 40; i++) {
      await sleep(120);
      const now = await ev('scrollY');
      if (now === last) return;
      last = now;
    }
  };
  const press = async () => {
    await click('#go-btn');
    await waitFor("document.getElementById('go-btn').getAttribute('aria-busy') === null && !document.getElementById('results').hidden", 180000, 'the new file');
    await sleep(200);
    await settle();
  };
  // Presses every download link and returns [{ name, url, bytes, path }].
  const download = async () => {
    const count = await ev("document.querySelectorAll('#results-list .ms-download').length");
    const before = new Set(downloads.keys());
    for (let i = 0; i < count; i++) await click('#results-list .ms-download', i);
    const end = Date.now() + 30000;
    let mine = [];
    while (Date.now() < end) {
      mine = [...downloads.entries()].filter(([g]) => !before.has(g));
      if (mine.length >= count && mine.every(([, d]) => d.state === 'completed')) break;
      await sleep(100);
    }
    return mine.filter(([, d]) => d.state === 'completed').map(([g, d]) => {
      const path = join(page.dl, g);
      return { name: d.name, url: d.url, bytes: new Uint8Array(readFileSync(path)), path };
    });
  };
  const shot = async (label, { selector, full } = {}) => {
    const file = join(SHOTS, `${view.label}-${label}.png`);
    let clip;
    if (selector) {
      const b = await ev(`(() => { const el = document.querySelector(${J(selector)}); el.scrollIntoView({ block: 'start', behavior: 'instant' }); const r = el.getBoundingClientRect(); return [r.left + scrollX, r.top + scrollY, r.width, r.height]; })()`);
      clip = { x: Math.max(0, b[0] - 8), y: Math.max(0, b[1] - 8), width: Math.min(view.width, b[2] + 16), height: Math.min(8000, b[3] + 16), scale: 1 };
    } else if (full) {
      const h = await ev('document.documentElement.scrollHeight');
      clip = { x: 0, y: 0, width: view.width, height: Math.min(12000, h), scale: 1 };
    }
    await sleep(250);
    const r = await s('Page.captureScreenshot', clip ? { format: 'png', captureBeyondViewport: true, clip } : { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };
  // The page as a person sees it with the button in view: the loaded state, scrolled to
  // the one button at the bottom of the steps.
  const shotAtButton = async (label) => {
    await ev("document.getElementById('go-btn').scrollIntoView({ block: 'center', behavior: 'instant' })");
    return shot(label);
  };
  const layout = async (where) => {
    const o = await ev(`(() => {
      const vw = document.documentElement.clientWidth;
      const bad = [];
      for (const el of document.querySelectorAll('main *, .site-footer *')) {
        const b = el.getBoundingClientRect();
        if (!b.width || el.closest('.marquee, [class*=carousel], [class*=switcher]')) continue;
        if (b.right > vw + 0.5 || b.left < -0.5) bad.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ')[0]);
      }
      return { sw: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 6) };
    })()`);
    check(`${view.label} ${where}: no sideways scrolling, nothing wider than the screen`, o.sw <= o.vw && !o.bad.length, o);
  };
  const close = async () => {
    const csp = await ev('window.__e2eCsp || []').catch(() => []);
    for (const c of csp) record.csp.push({ flow, view: view.label, ...c });
    listeners.delete(onMsg);
    await send('Target.closeTarget', { targetId }).catch(() => {});
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  };

  Object.assign(page, { s, ev, waitFor, click, typeInto, setSelect, setFiles, load, press, settle, download, shot, shotAtButton, layout, close, networkIdle, point });

  // Open the site as a first-time visitor and accept the gate.
  await s('Page.navigate', { url: PAGE_URL });
  const end = Date.now() + 20000;
  while (!page.loadFired && Date.now() < end) await sleep(50);
  await networkIdle();
  const gate = await ev("!!document.querySelector('.sb-gate-overlay') && document.querySelector('main').inert === true");
  page.gateSeen = gate;
  if (gate) {
    await click('.sb-gate-btn');
    await waitFor("!document.querySelector('.sb-gate-overlay') && !document.querySelector('main').inert", 5000, 'the gate to close');
  }
  await networkIdle();
  page.phase = 'after-load';
  return page;
}

// ---------------------------------------------------------------------------------------
// Checking a downloaded file outside the browser

const registry = readFileSync(REGISTRY, 'utf8').trim().split('\n').slice(1).map((line) => {
  const [string, kind, file, location, group, tier, basis, encoding] = line.split('\t');
  return { string, kind, file, location, group, tier, basis, encoding };
});

function py(script, ...argv) {
  const r = spawnSync('python3', ['-c', script, ...argv], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `python exited ${r.status}`);
  return JSON.parse(r.stdout);
}
const SAME_PIXELS_PY = `
import sys, json
from PIL import Image
a = Image.open(sys.argv[1]); b = Image.open(sys.argv[2]); a.load(); b.load()
print(json.dumps({'same': a.mode == b.mode and a.size == b.size and a.tobytes() == b.tobytes(), 'a': [a.mode, a.size], 'b': [b.mode, b.size]}))`;
const UPRIGHT_PY = `
import sys, json
from PIL import Image, ImageOps, ImageChops, ImageStat
o = ImageOps.exif_transpose(Image.open(sys.argv[1])).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
def mean(img, box): return [round(v) for v in ImageStat.Stat(img.crop(box)).mean]
out = {'size': list(b.size), 'tl': mean(b, (10, 10, 100, 100)), 'tr': mean(b, (390, 10, 470, 100)), 'bc': mean(b, (190, 530, 290, 630))}
if o.size == b.size: out['diff'] = sum(ImageStat.Stat(ImageChops.difference(o, b)).mean) / 3
print(json.dumps(out))`;
const CORNERS_PY = `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]); fmt = im.format; im = im.convert('RGB'); w, h = im.size
print(json.dumps({'format': fmt, 'size': [w, h], 'corners': [im.getpixel(p) for p in [(1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2)]], 'centre': im.getpixel((w // 2, h // 2))}))`;

function exiftoolKeys(path) {
  const r = spawnSync('exiftool', ['-j', '-a', '-u', '-G1', '-ee3', '-U', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(r.stdout)[0];
  } catch {
    return { error: r.stderr };
  }
}

function rgbaHash(path) {
  const r = spawnSync('magick', [path, '-depth', '8', 'RGBA:-'], { maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return createHash('sha256').update(r.stdout).digest('hex');
}

// Searches files for planted strings with the fixture kit (raw, zlib, hex and UTF-16).
function scan(rows, file) {
  if (!rows.length) return [];
  const reg = join(CHECKS, `registry-${createHash('sha1').update(rows.map((r) => r.string).join('|') + file).digest('hex').slice(0, 10)}.tsv`);
  writeFileSync(reg, `string\tkind\tfile\tlocation\tgroup\ttier\tbasis\tencoding\texiftool_form\n${rows.map((r) => [r.string, r.kind, r.file, r.location, r.group, r.tier, r.basis, r.encoding, ''].join('\t')).join('\n')}\n`);
  const r = spawnSync('python3', [join(ROOT, 'tests', 'fixtures', 'fixturekit.py'), 'scan', reg, file], { encoding: 'utf8' });
  const found = r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t')[1]);
  return rows.filter((row) => found.includes(row.string));
}

const NAME_RE = /^(?<base>.+?)(?:-(?<n>\d+))?\.(?<word>public|minimal|clean|custom)\.(?<ext>jpg|png|webp|heic)$/;
const EXT_OF = { jpeg: 'jpg', png: 'png', webp: 'webp', heic: 'heic' };

// Whether a URL is one of this site's published files (as GitHub Pages would serve it).
const published = (url) => {
  const u = new URL(url);
  if (u.origin !== ORIGIN) return false;
  if (u.pathname === '/cdn-cgi/speculation') return true;
  const rel = decodeURIComponent(u.pathname).replace(/^\//, '') || 'index.html';
  const file = join(ROOT, rel.endsWith('/') ? `${rel}index.html` : rel);
  return file.startsWith(ROOT) && existsSync(file) && statSync(file).isFile() && !/^(tests|README|LICENSE|NOTICE|bump_assets|_config)/.test(rel);
};

// The checks every downloaded file gets. Returns the read-back for extra checks.
async function verifyDownload(page, file, { fixture, base = 'image', index = null, removed, lossless, word, expectFormat }) {
  const tag = file.name;
  const m = NAME_RE.exec(file.name);
  check(`${tag}: name follows [name].[tier].[ext]`, !!m && m.groups.base === base && (index === null ? !m.groups.n : m.groups.n === String(index)), { name: file.name, base, index });
  check(`${tag}: the download is a local blob of this page, not a network address`, file.url.startsWith(`blob:${ORIGIN}/`), file.url);
  const fmt = detectFormat(file.bytes);
  check(`${tag}: extension matches the bytes (${fmt})`, !!m && EXT_OF[fmt] === m.groups.ext && (!expectFormat || fmt === expectFormat), { fmt, expectFormat });
  const back = await inspect(file.bytes);
  const measured = privacyWord(back.items);
  check(`${tag}: privacy word in the name matches the read-back (${measured})`, !!m && m.groups.word === measured, { inName: m?.groups.word, measured });
  if (word) check(`${tag}: privacy word is "${word}"`, measured === word, measured);

  // What the page showed for this file.
  const shown = await page.ev(`(() => {
    const link = [...document.querySelectorAll('#results-list .ms-download')].find(a => a.download === ${J(file.name)});
    if (!link) return null;
    const card = link.closest('.ms-result');
    return {
      word: card.querySelector('.ms-word')?.textContent,
      wordTier: card.querySelector('.ms-word')?.dataset.tier,
      meaning: card.querySelector('.ms-word-text')?.textContent,
      warning: card.querySelector('.ms-word-warning')?.textContent || null,
      remaining: card.querySelectorAll('.ms-readback .ms-item').length,
      none: /No metadata remains\\./.test(card.textContent),
      facts: card.querySelector('.ms-result-facts')?.textContent,
    };
  })()`);
  if (check(`${tag}: the page shows a result card for it`, !!shown)) {
    check(`${tag}: the page shows the same privacy word`, shown.word === measured, shown.word);
    check(`${tag}: the read-back list on the page matches the file (${back.items.length} items)`, back.items.length ? shown.remaining === back.items.length : shown.none, { page: shown.remaining, file: back.items.length });
    const hasRed = back.items.some((it) => it.tier === 'red');
    check(`${tag}: "Not recommended for public sharing." shown exactly when red is left with the custom word`, (measured === 'custom' && hasRed) === (shown.warning === 'Not recommended for public sharing.'), shown.warning);
    check(`${tag}: the tier word comes with its one-line meaning`, !!shown.meaning && shown.meaning.length > 10, shown.meaning);
  }

  const tiers = new Set(removed);
  const leftover = back.items.filter((it) => tiers.has(it.tier));
  check(`${tag}: engine read-back holds no ${[...tiers].join(' or ')} item`, !leftover.length, leftover.map((it) => it.id), 'engine');

  const path = join(CHECKS, `${currentFlow}-${page.view.label}-${file.name}`);
  writeFileSync(path, file.bytes);
  if (fixture) {
    const rows = registry.filter((r) => r.file === fixture && tiers.has(r.tier));
    const left = scan(rows, path);
    const spec = left.filter((r) => r.basis !== 'inferred');
    const inferred = left.filter((r) => r.basis === 'inferred');
    check(`${tag}: no planted ${[...tiers].join('/')} string from ${fixture} survives (${rows.length} searched)`, !spec.length, spec.map((r) => `${r.string} [${r.tier}] ${r.location}`), 'engine');
    if (inferred.length) note(`${tag}: planted strings whose tier the fixture author inferred (not in the spec) survive`, inferred.map((r) => `${r.string} [${r.tier} inferred] ${r.location}`));
  }
  const ex = exiftoolKeys(path);
  const keys = Object.keys(ex || {});
  if (tiers.has('red')) {
    const gps = keys.filter((k) => /GPS(Latitude|Longitude|Position|Altitude|Coordinates)|GPSAreaInformation|:LocationCreated|:LocationShown/i.test(k));
    check(`${tag}: exiftool finds no GPS position`, !gps.length, gps.map((k) => `${k}=${ex[k]}`), 'engine');
    const thumbs = keys.filter((k) => /ThumbnailImage|PreviewImage|PhotoshopThumbnail|ThumbnailTIFF/i.test(k));
    check(`${tag}: exiftool finds no built-in preview image`, !thumbs.length, thumbs, 'engine');
  }
  if (lossless !== undefined && fixture) {
    const src = join(FIX, fixture);
    if (fmt === 'heic') {
      const a = rgbaHash(src);
      const b = rgbaHash(path);
      check(`${tag}: decoded pixels identical to the original (ImageMagick)`, !!a && a === b, { a, b });
    } else {
      const r = py(SAME_PIXELS_PY, src, path);
      if (lossless) check(`${tag}: decoded pixels identical to the original (Pillow)`, r.same, r);
      else check(`${tag}: picture was re-saved (pixels differ from the original)`, !r.same, r);
    }
  }
  return { back, ex, path, measured };
}

// Presses the button when nothing would change, and returns what the page did instead.
async function pressExpectingNothing(p) {
  await p.click('#go-btn');
  await p.waitFor("!document.getElementById('go-nothing').hidden", 10000, 'the "nothing to change" message');
  await sleep(300);
  return p.ev(`(() => {
    const msg = document.getElementById('go-nothing');
    const btn = document.getElementById('go-btn').getBoundingClientRect();
    const m = msg.getBoundingClientRect();
    return { text: msg.textContent, results: document.getElementById('results').hidden, links: document.querySelectorAll('#results-list .ms-download').length,
      focus: document.activeElement.id, belowButton: m.top >= btn.bottom, inView: m.top >= 0 && m.bottom <= innerHeight, busy: document.getElementById('go-btn').getAttribute('aria-busy'),
      said: document.getElementById('announcer').textContent };
  })()`);
}

// What a person reads on the page: no em dashes, no double hyphens, British spelling.
async function textCheck(page, where) {
  const text = await page.ev('document.body.innerText');
  const dashes = [...new Set((text.match(/.{0,30}(\u2014|\u2013|--).{0,30}/g) || []))];
  check(`${page.view.label} ${where}: no em dashes, en dashes or double hyphens in the text`, !dashes.length, dashes);
  const us = [...new Set((text.match(/\b(color\w*|organiz\w*|gray|center(ed|s)?|favorite\w*|behavior\w*|analyz\w*|customiz\w*|optimiz\w*|recogniz\w*|cataloged)\b/gi) || []))];
  check(`${page.view.label} ${where}: British spelling (no colour, organise, grey, centre written the American way)`, !us.length, us);
}

// ---------------------------------------------------------------------------------------
// Flows

const flows = [];
const flow = (name, view, fn) => flows.push({ name, view, fn });

// First, prove the recorders work: break the rules on purpose and check each break is
// seen. These records are then left out of the whole-run checks below.
const SELF_TEST = 'harness-self-test';
flow(SELF_TEST, DESKTOP, async (p) => {
  const mark = { req: record.requests.length, exc: record.exceptions.length, con: record.console.length };
  await p.ev("fetch('https://example.org/e2e-self-test').catch(() => 0)");
  await p.ev("document.body.setAttribute('style', 'outline: 0')");
  await p.ev("new Image().src = 'https://example.org/e2e-self-test.png'");
  await p.ev("console.error('e2e self-test')");
  await p.ev("setTimeout(() => { throw new Error('e2e self-test') }, 0)");
  await sleep(600);
  const csp = await p.ev('window.__e2eCsp');
  check('self-test: a policy violation is recorded', csp.some((c) => c.d === 'connect-src') && csp.some((c) => /^style-src/.test(c.d)) && csp.some((c) => c.d === 'img-src'), csp);
  check('self-test: an off-site attempt is recorded', record.requests.slice(mark.req).some((r) => r.url.startsWith('https://example.org/')) || csp.some((c) => /example\.org/.test(c.u)), record.requests.slice(mark.req).map((r) => r.url));
  check('self-test: an uncaught exception is recorded', record.exceptions.length > mark.exc);
  check('self-test: a console error is recorded', record.console.slice(mark.con).some((c) => c.type === 'error'));
});

flow('jpeg-default', DESKTOP, async (p) => {
  check('the first-run gate appears for a new visitor and closes with "Got it"', p.gateSeen);
  await textCheck(p, 'empty page');
  await p.layout('empty page');
  await p.shot('1-empty');
  await p.shot('1-empty-full', { full: true });
  // Every same-origin link and asset in the page points at a file GitHub Pages publishes.
  // Checked against the repository, not fetched, so it adds no requests.
  const refs = await p.ev(`[...document.querySelectorAll('a[href], img[src], link[href], script[src]')].map(e => e.href || e.src).filter(u => u.startsWith(location.origin + '/'))`);
  const broken = [...new Set(refs.filter((u) => !published(u)))];
  check(`every same-origin link and asset in the page exists and is published (${new Set(refs).size} checked)`, !broken.length, broken);

  await p.load(['jpeg-everything.jpg']);
  const src = await inspect(new Uint8Array(readFileSync(join(FIX, 'jpeg-everything.jpg'))));
  const meta = await p.ev(`(() => {
    const titles = [...document.querySelectorAll('#meta-groups .ms-group-title')].map(e => e.textContent);
    const rows = [...document.querySelectorAll('#meta-groups .ms-check')].map(b => {
      const item = b.closest('.ms-item');
      const badge = item.querySelector('.tier-badge');
      const cs = getComputedStyle(badge);
      return { id: b.dataset.id, checked: b.checked, tier: item.dataset.tier, badge: badge.textContent, badgeTier: badge.dataset.tier, colour: cs.color + '|' + cs.backgroundColor, source: item.querySelector('.ms-source')?.textContent, label: item.querySelector('.ms-item-label')?.textContent, name: b.labels[0] ? true : !!b.getAttribute('aria-labelledby') };
    });
    return { titles, rows, pressed: document.querySelector('#quick [aria-pressed="true"]')?.textContent, mode: document.getElementById('mode-line').textContent, preview: document.getElementById('name-preview').textContent, summary: document.getElementById('file-summary').textContent, canvas: [document.getElementById('preview-canvas').width, document.getElementById('preview-canvas').height], legend: document.getElementById('tier-legend').textContent };
  })()`);
  const ids = meta.rows.map((r) => r.id).sort();
  check('every item the engine finds is listed, once', J(ids) === J(src.items.map((i) => i.id).sort()), { page: ids.length, engine: src.items.length });
  check('groups appear in the agreed order', J(meta.titles) === J(GROUPS.map((g) => g.label).filter((l) => meta.titles.includes(l))), meta.titles);
  check('red items, and only red items, are ticked to start with', meta.rows.every((r) => r.checked === (r.tier === 'red')), meta.rows.filter((r) => r.checked !== (r.tier === 'red')).map((r) => r.id));
  // Decision of 2026-10-02: the computer name is its own red item; editing software stays amber.
  const computerRow = meta.rows.find((r) => r.id === 'exif:computer');
  check('"Computer name" is its own red item, ticked to start with', !!computerRow && computerRow.tier === 'red' && computerRow.checked && computerRow.label === 'Computer name', computerRow);
  const softwareRow = meta.rows.find((r) => r.id === 'exif:software');
  check('"Editing software" stays amber and is kept to start with', !!softwareRow && softwareRow.tier === 'amber' && !softwareRow.checked && softwareRow.label === 'Editing software', softwareRow);
  check('each item shows its tier as a word as well as a colour', meta.rows.every((r) => r.badge === { red: 'Red', amber: 'Amber', green: 'Green' }[r.tier] && r.badgeTier === r.tier), meta.rows.filter((r) => r.badge !== { red: 'Red', amber: 'Amber', green: 'Green' }[r.tier]).map((r) => r.id));
  const colours = new Map(meta.rows.map((r) => [r.tier, r.colour]));
  check('the three tiers have three different colours', new Set(colours.values()).size === 3, Object.fromEntries(colours));
  check('each item shows where it was found (EXIF, XMP, IPTC and so on)', meta.rows.every((r) => r.source && r.source.length > 1));
  check('the colour legend explains Red, Amber and Green', /Red/.test(meta.legend) && /Amber/.test(meta.legend) && /Green/.test(meta.legend), meta.legend);
  check('"Red only" is the pressed quick choice', meta.pressed === 'Red only', meta.pressed);
  check('the page says this is lossless', /^Lossless/.test(meta.mode), meta.mode);
  check('the expected name is image.public.jpg', /Expected name: image\.public\.jpg/.test(meta.preview), meta.preview);
  check('preview drawn at the picture shape (880 x 660)', meta.canvas[0] * 660 === meta.canvas[1] * 880 && /880 × 660/.test(meta.summary), meta);
  check('the one button says "Prepare picture"', await p.ev("document.getElementById('go-btn').textContent") === 'Prepare picture');
  await textCheck(p, 'loaded file');
  await p.layout('loaded file');
  await p.shot('2-loaded');
  await p.shot('2-loaded-list', { selector: '#meta-card' });
  await p.shot('2-loaded-full', { full: true });
  await p.shotAtButton('2-loaded-button');

  await p.press();
  const landed = await p.ev("({ focus: document.activeElement.id, top: Math.round(document.getElementById('results').getBoundingClientRect().top), label: document.getElementById('go-btn').textContent })");
  check('after pressing, focus moves to "Your new file" and it is scrolled into view', landed.focus === 'results' && Math.abs(landed.top) <= 40, landed);
  check('the button has its name back after the work ("Prepare picture")', landed.label === 'Prepare picture', landed.label);
  await p.shot('4-result-view');
  let files = await p.download();
  check('one file downloaded, named image.public.jpg', files.length === 1 && files[0].name === 'image.public.jpg', files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: true, word: 'public' });
    // Red only must keep the rest: a scrubber that wipes everything would also pass the red checks.
    const keptAmber = registry.filter((r) => r.file === 'jpeg-everything.jpg' && r.tier === 'amber');
    const stillThere = scan(keptAmber, v.path);
    check('amber details are kept with the default choice (selective, not wipe-all)', stillThere.length > 0, `${stillThere.length} of ${keptAmber.length} amber strings still present`);
    const host = registry.filter((r) => r.file === 'jpeg-everything.jpg' && /HOSTCOMPUTER/.test(r.string));
    check('the computer name is gone from the new file (read-back, bytes and exiftool)', host.length === 1 && !scan(host, v.path).length
      && !v.back.items.some((it) => /computer/.test(it.id)) && !Object.keys(v.ex || {}).some((k) => /HostComputer/i.test(k)), { registry: host.length, readBack: v.back.items.filter((it) => /computer/.test(it.id)).map((it) => it.id), exiftool: Object.keys(v.ex || {}).filter((k) => /HostComputer/i.test(k)) });
    const editor = registry.filter((r) => r.file === 'jpeg-everything.jpg' && /JPEG-EXIF-SOFTWARE/.test(r.string));
    check('the editing software is kept in the new file', editor.length === 1 && scan(editor, v.path).length === 1 && v.back.items.some((it) => it.id === 'exif:software'), editor.map((r) => r.string));
    const facts = await p.ev("document.querySelector('.ms-result-facts').textContent");
    check('the result says the picture was not re-saved', /Lossless: the picture itself was not re-saved\./.test(facts), facts);
  }
  await textCheck(p, 'result');
  await p.layout('result');
  await p.shot('4-result', { selector: '#results' });
  await p.shot('4-result-full', { full: true });

  // A typed name is used; a typed extension is dropped and added back by the page.
  await p.typeInto('#name-input', 'holiday.jpg');
  const renamed = await p.ev("document.querySelector('#results-list .ms-download').download");
  check('typing "holiday.jpg" renames the download to holiday.public.jpg', renamed === 'holiday.public.jpg', renamed);
  files = await p.download();
  check('the renamed file downloads under the new name', files.length === 1 && files[0].name === 'holiday.public.jpg', files.map((f) => f.name));
});

// Decision of 2026-10-02 (Marcos): one column on every screen, in working order, with one
// neutral button at the bottom. Not everybody wants to remove metadata, so pressing it
// with nothing to change says so instead of making an identical copy.
flow('one-column', DESKTOP, async (p) => {
  await p.load(['jpeg-everything.jpg']);
  const st = await p.ev(`(() => {
    const ids = ['pick-card', 'preview-card', 'meta-card', 'edit-card', 'action-card'];
    const boxes = ids.map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { id, left: Math.round(r.left), width: Math.round(r.width), top: r.top + scrollY, bottom: r.bottom + scrollY }; });
    const actions = [...document.querySelectorAll('button')].filter((b) => !b.closest('[hidden]') && /remove metadata|prepare|make the new file/i.test(b.textContent));
    const btn = document.getElementById('go-btn').getBoundingClientRect();
    const edit = document.getElementById('edit-card').getBoundingClientRect();
    return {
      boxes,
      oneColumn: boxes.every((b) => b.left === boxes[0].left && b.width === boxes[0].width),
      inOrder: boxes.every((b, i) => !i || b.top >= boxes[i - 1].bottom),
      actions: actions.map((b) => b.id + ': ' + b.textContent.trim()),
      gone: !document.getElementById('go-btn-end') && !document.getElementById('list-end') && !document.getElementById('save-card'),
      editTitle: document.getElementById('edit-title').textContent,
      nameInEdit: !!document.querySelector('#edit-card #name-input'),
      buttonLast: btn.top >= edit.bottom,
      resultsAfter: !!(document.getElementById('action-card').compareDocumentPosition(document.getElementById('results')) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  })()`);
  check('one column on a wide screen: every step card has the same left edge and width', st.oneColumn, st.boxes);
  check('the steps run top to bottom: choose, picture, what it reveals, size and format, the button', st.inOrder, st.boxes);
  check('there is exactly one action button, named "Prepare picture"', st.actions.length === 1 && st.actions[0] === 'go-btn: Prepare picture', st.actions);
  check('the second button and its column are gone', st.gone);
  check('the file name sits with size and format ("Size, format and name")', st.nameInEdit && st.editTitle === 'Size, format and name', st);
  check('the button comes after every choice, and the new file after the button', st.buttonLast && st.resultsAfter, st);

  // Typing a name in that card renames only; it does not count as a change of choice.
  await p.typeInto('#name-input', 'beach');
  const named = await p.ev("({ stale: !document.getElementById('go-stale').hidden, preview: document.getElementById('name-preview').textContent })");
  check('typing a name updates the expected name and clears nothing', !named.stale && /Expected name: beach\.public\.jpg/.test(named.preview), named);
  await p.typeInto('#name-input', 'image');

  // Nothing ticked, nothing else chosen: no file, a plain message beside the button.
  await p.click('#quick [data-preset="none"]');
  const idle = await pressExpectingNothing(p);
  check('with nothing ticked and nothing else chosen, no file is made', idle.results && !idle.links && idle.busy === null, idle);
  check('the page says so in plain words, under the button', idle.text === 'Nothing to change yet: tick something to remove, or choose a crop, size or format.' && idle.belowButton && idle.inView, idle);
  check('the message is announced and focus stays on the button', idle.said === idle.text && idle.focus === 'go-btn', idle);
  const mode = await p.ev("({ line: document.getElementById('mode-line').textContent, tier: document.getElementById('mode-box').dataset.tier || null })");
  check('above the button, no claim of lossless or re-saved: the new file would be the original', mode.line === 'With these choices the new file would be the same as the original.' && mode.tier === null, mode);
  await textCheck(p, 'nothing to change');
  await p.shotAtButton('2-nothing-to-change');

  // Only a resize, nothing removed: that is a real change, and the message goes.
  await p.click('input[name="resize"][value="percent"]');
  const gone = await p.ev("document.getElementById('go-nothing').hidden");
  check('choosing a size takes the message away', gone);
  await p.press();
  const files = await p.download();
  check('resize only, nothing removed: one file, image.custom.jpg', files.length === 1 && files[0].name === 'image.custom.jpg', files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: [], lossless: false, word: 'custom', expectFormat: 'jpeg' });
    check('it is half the size: 440 x 330', v.back.width === 440 && v.back.height === 330, [v.back.width, v.back.height]);
    check('the location stays, because nothing was ticked (EXIF GPS read back)', v.back.items.some((it) => it.id === 'exif:gps'), v.back.items.map((it) => it.id));
  }

  // A size limit the file already meets changes nothing either.
  await p.click('input[name="resize"][value="size"]');
  const fits = await pressExpectingNothing(p);
  check('a size limit the file already meets, with nothing ticked: no file, and the reason', fits.results && /^Nothing to change yet: the picture is already under the size limit\. Tick something to remove, or choose a crop, a smaller size or another format\.$/.test(fits.text), fits);
});

flow('jpeg-select-all', DESKTOP, async (p) => {
  await p.load(['jpeg-everything.jpg']);
  // "None" alone would give back the same file, so no file is made.
  await p.click('#quick [data-preset="none"]');
  const idle = await pressExpectingNothing(p);
  check('"None" with nothing else chosen makes no file and says why', idle.results && !idle.links && /^Nothing to change yet/.test(idle.text), idle);
  // "None" with a resize: everything kept, so the word is custom with the red warning.
  await p.typeInto('#resize-percent', '50');
  await p.press();
  let none = await p.download();
  check('"None" with a resize downloads image.custom.jpg', none.length === 1 && none[0].name === 'image.custom.jpg', none.map((f) => f.name));
  if (none[0]) await verifyDownload(p, none[0], { removed: [], word: 'custom' });
  const warn = await p.ev("(() => { const w = document.querySelector('.ms-word-warning'); if (!w) return null; const c = getComputedStyle(w).color.match(/\\d+/g).map(Number); return { text: w.textContent, c }; })()");
  check('custom with red left says "Not recommended for public sharing." in red', !!warn && warn.text === 'Not recommended for public sharing.' && warn.c[0] > 200 && warn.c[1] < 180, warn);
  await p.click('input[name="resize"][value="none"]');
  await p.click('#quick [data-preset="all"]');
  const st = await p.ev("({ pressed: document.querySelector('#quick [aria-pressed=\"true\"]')?.textContent, all: [...document.querySelectorAll('#meta-groups .ms-check')].every(b => b.checked), mode: document.getElementById('mode-line').textContent })");
  check('"Select all" ticks every item and shows as pressed', st.all && st.pressed === 'Select all', st);
  check('normal rotation: Select all stays lossless', /^Lossless/.test(st.mode), st.mode);
  await p.press();
  const files = await p.download();
  check('one file downloaded', files.length === 1, files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red', 'amber', 'green'], lossless: true });
    check('Select all leaves no metadata items (clean)', v.measured === 'clean', v.back.items.map((i) => i.id));
    const extra = Object.keys(v.ex).filter((k) => !/^(SourceFile|ExifTool:|System:|File:|Composite:(ImageSize|Megapixels))/.test(k));
    note('exiftool still lists (structure only expected)', extra.map((k) => `${k}=${String(v.ex[k]).slice(0, 40)}`));
  }
});

flow('jpeg-rotation', DESKTOP, async (p) => {
  await p.load(['jpeg-orientation-6.jpg']);
  const pre = await p.ev("({ summary: document.getElementById('file-summary').textContent, mode: document.getElementById('mode-line').textContent, canvas: [document.getElementById('preview-canvas').width, document.getElementById('preview-canvas').height] })");
  check('the sideways photo is previewed upright (480 x 640)', pre.canvas[1] > pre.canvas[0] && /480 × 640/.test(pre.summary), pre);
  check('keeping the rotation stays lossless', /^Lossless/.test(pre.mode), pre.mode);
  await p.click('#quick [data-preset="all"]');
  const said = await p.ev("document.getElementById('mode-line').textContent + ' | ' + document.getElementById('mode-reasons').textContent");
  check('removing the rotation says the picture is re-saved and turned the right way up', /re-saves the picture/.test(said) && /right way up/.test(said), said);
  await p.press();
  const files = await p.download();
  check('one file downloaded', files.length === 1, files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-orientation-6.jpg', removed: ['red', 'amber', 'green'], lossless: false, expectFormat: 'jpeg' });
    check('baked file is 480 x 640 with no rotation setting left', v.back.width === 480 && v.back.height === 640 && v.back.orientation === 1 && !Object.keys(v.ex).some((k) => /Orientation/.test(k) && !/^Composite/.test(k) && v.ex[k] !== 'Horizontal (normal)'), { w: v.back.width, h: v.back.height, o: v.back.orientation });
    const r = py(UPRIGHT_PY, join(FIX, 'jpeg-orientation-6.jpg'), v.path);
    const isRed = (c) => c[0] > 150 && c[1] < 110 && c[2] < 110;
    const isGreen = (c) => c[1] > 120 && c[0] < 110 && c[2] < 110;
    const isBlue = (c) => c[2] > 150 && c[0] < 110 && c[1] < 110;
    check('picture is upright: red top left, green top right, blue bottom centre', isRed(r.tl) && isGreen(r.tr) && isBlue(r.bc), r);
    check('pixels match the original turned upright (mean difference under 6)', r.diff !== undefined && r.diff < 6, r.diff);
  }
  await p.shot('rotation-result', { selector: '#results' });
});

flow('jpeg-size-limit', DESKTOP, async (p) => {
  await p.load(['jpeg-large.jpg']);
  await p.click('input[name="resize"][value="size"]');
  const val = await p.ev("[document.getElementById('resize-size').value, document.getElementById('resize-unit').value]");
  check('the size limit defaults to 1 MB', val[0] === '1' && val[1] === '1000000', val);
  const mode = await p.ev("document.getElementById('mode-line').textContent");
  check('the page explains a size limit may re-save the picture', /size limit/.test(mode), mode);
  const t0 = Date.now();
  await p.press();
  const ms = Date.now() - t0;
  const files = await p.download();
  check('one file downloaded', files.length === 1, files.map((f) => f.name));
  if (files[0]) {
    const size = files[0].bytes.length;
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-large.jpg', removed: ['red'], lossless: false, expectFormat: 'jpeg' });
    check(`file is at most 1,000,000 bytes and close to 950,000 (${size.toLocaleString('en-GB')} bytes, ${ms} ms)`, size <= 950000 && size >= 0.85 * 950000, size);
    const ratio = v.back.width / v.back.height;
    check(`shape kept: ${v.back.width} x ${v.back.height} (6000 x 4000 is 1.5)`, Math.abs(v.back.width * 4000 - v.back.height * 6000) <= 6000, ratio);
    const facts = await p.ev("document.querySelector('.ms-result-facts').textContent");
    check('the result shows size in pixels, file size and the quality used', /× [\d,]+ pixels/.test(facts) && /\d (KB|MB)/.test(facts) && /quality \d+ per cent/.test(facts), facts);
    note('size limit result', facts);
  }
});

flow('resize-and-convert', DESKTOP, async (p) => {
  await p.load(['jpeg-everything.jpg']);
  // A Norwegian-style decimal in the percentage box.
  await p.typeInto('#resize-percent', '33,5');
  let st = await p.ev("({ radio: document.querySelector('input[name=resize][value=percent]').checked, err: document.getElementById('resize-error').hidden ? '' : document.getElementById('resize-error').textContent, mode: document.getElementById('mode-line').textContent, reasons: document.getElementById('mode-reasons').textContent })");
  check('typing in the percentage box picks that option and accepts "33,5"', st.radio && !st.err, st);
  check('the page says resizing re-saves the picture and gives the new size (295 x 221)', /re-saves the picture/.test(st.mode) && /295 × 221/.test(st.reasons), st);
  await p.press();
  let files = await p.download();
  if (check('one file downloaded', files.length === 1, files.map((f) => f.name))) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: false, expectFormat: 'jpeg' });
    check(`33,5 % of 880 x 660 gives 295 x 221 (got ${v.back.width} x ${v.back.height})`, v.back.width === 295 && v.back.height === 221);
  }
  // Longest side, and a change of format to WebP.
  await p.typeInto('#resize-edge', '400');
  await p.setSelect('#format-select', 'webp');
  st = await p.ev("({ radio: document.querySelector('input[name=resize][value=edge]').checked, preview: document.getElementById('name-preview').textContent })");
  check('the expected name follows the new format (.webp)', st.radio && /\.webp\./.test(st.preview + '.'), st);
  await p.press();
  files = await p.download();
  if (check('one .webp file downloaded', files.length === 1 && /^image\.\w+\.webp$/.test(files[0].name), files.map((f) => f.name))) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: false, expectFormat: 'webp' });
    check(`longest side 400 gives 400 x 300 (got ${v.back.width} x ${v.back.height})`, v.back.width === 400 && v.back.height === 300);
  }
  // A typing mistake is explained, and the button then moves to the field.
  await p.typeInto('#resize-edge', 'abc');
  await p.click('#go-btn');
  st = await p.ev("({ err: document.getElementById('resize-error').hidden ? '' : document.getElementById('resize-error').textContent, focus: document.activeElement.id, results: document.getElementById('results').hidden })");
  check('a typing mistake is explained in words and focus moves to the field', /Enter a number of pixels/.test(st.err) && st.focus === 'resize-edge' && st.results, st);
});

flow('jpeg-crop', DESKTOP, async (p) => {
  await p.load(['jpeg-everything.jpg']);
  await p.click('label[for="crop-toggle"]');
  check('ticking "Crop the picture" shows the crop frame and the shapes', await p.ev("!document.getElementById('crop-layer').hidden && !document.getElementById('crop-options').hidden"));
  await p.click('#crop-ratios [data-ratio="1:1"]');
  const first = await p.ev("document.getElementById('crop-readout').textContent");
  check('1:1 starts as the largest square (660 x 660)', /Crop: 660 × 660/.test(first), first);
  const mode = await p.ev("document.getElementById('mode-line').textContent");
  check('the page says cropping re-saves the picture before the button is pressed', mode === 'Cropping, resizing or changing format re-saves the picture.', mode);
  // Drag the bottom-right corner in with the mouse, then move the frame.
  const h = await p.point('[data-handle="se"]');
  await p.s('Input.dispatchMouseEvent', { type: 'mousePressed', x: h.x, y: h.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) await p.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h.x - i * 12, y: h.y - i * 9, button: 'left', buttons: 1 });
  await p.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h.x - 72, y: h.y - 54, button: 'left', clickCount: 1 });
  const box = await p.point('#crop-box');
  await p.s('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) await p.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + i * 6, y: box.y + i * 4, button: 'left', buttons: 1 });
  await p.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 30, y: box.y + 20, button: 'left', clickCount: 1 });
  const readout = await p.ev("document.getElementById('crop-readout').textContent");
  check('dragging the corner and the frame changes the crop', readout !== first, [first, readout]);
  const m = /Crop: ([\d,]+) × ([\d,]+)/.exec(readout);
  const dims = m ? [Number(m[1].replace(/,/g, '')), Number(m[2].replace(/,/g, ''))] : null;
  check('the crop stays square', dims && dims[0] === dims[1], readout);
  await p.layout('crop view');
  await p.shot('3-crop', { selector: '#preview-card' });
  await p.press();
  const files = await p.download();
  check('one file downloaded', files.length === 1, files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: false, expectFormat: 'jpeg' });
    check(`output is the square shown on screen (${v.back.width} x ${v.back.height})`, dims && v.back.width === dims[0] && v.back.height === dims[1], { out: [v.back.width, v.back.height], dims });
    check('cropped file has no built-in preview image (engine read-back)', !v.back.items.some((i) => /thumbnail|preview/i.test(i.id + i.label)), v.back.items.map((i) => i.id));
    const thumbs = scan(registry.filter((r) => r.file === 'jpeg-everything.jpg' && /THUMB/.test(r.string)), v.path);
    check('the uncropped preview images are gone byte for byte', !thumbs.length, thumbs.map((r) => r.string), 'engine');
    const lostNote = await p.ev("[...document.querySelectorAll('#results-list .ms-note')].map(n => n.textContent).find(t => /left them out/.test(t)) || ''");
    check('the page lists the kept items that re-saving left out', /left them out: .+\./.test(lostNote), lostNote);
    check('that list names each source once (no "(C2PA) (C2PA)")', !/\(([^()]+)\) \(\1\)/.test(lostNote), lostNote);
  }
  await p.shot('3-crop-result', { selector: '#results' });
});

flow('png-to-jpeg', DESKTOP, async (p) => {
  await p.load(['png-transparent.png']);
  await p.setSelect('#format-select', 'jpeg');
  const st = await p.ev("({ bg: !document.getElementById('background-field').hidden, colour: document.getElementById('background-input').value, notes: document.getElementById('edit-notes').textContent, preview: document.getElementById('name-preview').textContent })");
  check('PNG to JPEG asks for a fill colour, white by default', st.bg && st.colour === '#ffffff', st);
  check('the page explains JPEG has no see-through areas', /see-through/.test(st.notes), st.notes);
  check('the expected name ends in .jpg', /\.jpg\./.test(st.preview + '.'), st.preview);
  await p.press();
  const files = await p.download();
  check('one .jpg file downloaded', files.length === 1 && /\.jpg$/.test(files[0].name), files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'png-transparent.png', removed: ['red'], lossless: false, expectFormat: 'jpeg' });
    const r = py(CORNERS_PY, v.path);
    check('see-through corners come out white, not the hidden orange', r.format === 'JPEG' && r.corners.every((c) => c.every((x) => x > 245)), r);
    check('the opaque centre is kept (white disc)', r.centre.every((x) => x > 230), r.centre);
    check('size kept at 400 x 300', r.size[0] === 400 && r.size[1] === 300, r.size);
  }
});

flow('webp-default', DESKTOP, async (p) => {
  await p.load(['webp-everything.webp']);
  const n = await p.ev("document.querySelectorAll('#meta-groups .ms-check').length");
  const src = await inspect(new Uint8Array(readFileSync(join(FIX, 'webp-everything.webp'))));
  check(`all ${src.items.length} WebP items are listed`, n === src.items.length, n);
  await p.press();
  const files = await p.download();
  check('one file downloaded, named image.public.webp', files.length === 1 && files[0].name === 'image.public.webp', files.map((f) => f.name));
  if (files[0]) await verifyDownload(p, files[0], { fixture: 'webp-everything.webp', removed: ['red'], lossless: true, word: 'public', expectFormat: 'webp' });
});

flow('png-default', DESKTOP, async (p) => {
  await p.load(['png-everything.png']);
  const n = await p.ev("document.querySelectorAll('#meta-groups .ms-check').length");
  const src = await inspect(new Uint8Array(readFileSync(join(FIX, 'png-everything.png'))));
  check(`all ${src.items.length} PNG items are listed`, n === src.items.length, n);
  await p.press();
  const files = await p.download();
  check('one file downloaded, named image.public.png', files.length === 1 && files[0].name === 'image.public.png', files.map((f) => f.name));
  if (files[0]) await verifyDownload(p, files[0], { fixture: 'png-everything.png', removed: ['red'], lossless: true, word: 'public', expectFormat: 'png' });
});

flow('heic', DESKTOP, async (p) => {
  await p.load(['heic-everything.heic']);
  const st = await p.ev(`({
    note: document.getElementById('preview-missing').textContent,
    noteShown: !document.getElementById('preview-missing').hidden,
    formatHidden: document.getElementById('format-field').hidden, formatDisabled: document.getElementById('format-select').disabled,
    resizeHidden: document.getElementById('resize-set').hidden,
    cropHidden: document.getElementById('crop-toggle').closest('label').hidden,
    items: document.querySelectorAll('#meta-groups .ms-check').length,
    mode: document.getElementById('mode-line').textContent })`);
  check('HEIC that the browser cannot decode: the page says so, word for word', st.note === 'Preview is not available for HEIC in this browser. Removing metadata still works; cropping, resizing and changing format do not.' && st.noteShown, st.note);
  check('crop, size and format are disabled for it', st.formatHidden && st.formatDisabled && st.resizeHidden && st.cropHidden, st);
  const editNote = await p.ev("document.getElementById('edit-unavailable').hidden ? '' : document.getElementById('edit-unavailable').textContent");
  check('the size and format card explains why, without repeating the preview sentence word for word', editNote.length > 20 && editNote !== st.note, editNote);
  check('its metadata is still listed', st.items > 0, st.items);
  check('removal is lossless', /^Lossless/.test(st.mode), st.mode);
  await p.shot('heic-loaded', { selector: '#workspace' });
  await p.press();
  const files = await p.download();
  check('one file downloaded, named image.public.heic', files.length === 1 && files[0].name === 'image.public.heic', files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'heic-everything.heic', removed: ['red'], lossless: true, word: 'public', expectFormat: 'heic' });
    check('HEIC keeps its exact size (edited in place)', files[0].bytes.length === statSync(join(FIX, 'heic-everything.heic')).size, files[0].bytes.length);
    check('ImageMagick still decodes the HEIC', !!rgbaHash(v.path));
  }
});

flow('motion-photo', DESKTOP, async (p) => {
  await p.load(['jpeg-motion-photo.jpg']);
  const rows = await p.ev("[...document.querySelectorAll('#meta-groups .ms-check')].map(b => ({ id: b.dataset.id, checked: b.checked, tier: b.closest('.ms-item').dataset.tier, label: b.closest('.ms-item').querySelector('.ms-item-label').textContent }))");
  const video = rows.find((r) => r.id === 'jpeg:trailing:motion-video');
  check('the hidden video clip is offered', !!video, rows.map((r) => r.id));
  check('the hidden video is red and ticked by default', video && video.tier === 'red' && video.checked, video);
  const xmp = rows.find((r) => r.id === 'xmp:motion');
  check('the XMP that points at the video is red and ticked', xmp && xmp.tier === 'red' && xmp.checked, xmp);
  await p.press();
  const files = await p.download();
  check('one file downloaded', files.length === 1, files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-motion-photo.jpg', removed: ['red'], lossless: true, word: 'public' });
    const before = statSync(join(FIX, 'jpeg-motion-photo.jpg')).size;
    const tail = Buffer.from(files[0].bytes).indexOf('ftyp');
    check(`the video is gone: no MP4 left after the picture (${before.toLocaleString('en-GB')} to ${files[0].bytes.length.toLocaleString('en-GB')} bytes)`, tail < 0 && before - files[0].bytes.length > 60000, { tail, size: files[0].bytes.length });
    const mp4 = Object.keys(v.ex).filter((k) => /QuickTime|Track\d|Keys:|ItemList|UserData|EmbeddedVideo|MotionPhotoVideo/i.test(k));
    check('exiftool finds no embedded video or its tags', !mp4.length, mp4, 'engine');
    const amber = scan(registry.filter((r) => r.file === 'jpeg-motion-photo.jpg' && /MP4/.test(r.string)), v.path);
    check('the video title and comment went with the video', !amber.length, amber.map((r) => r.string), 'engine');
  }
});

flow('ultrahdr', DESKTOP, async (p) => {
  await p.load(['jpeg-ultrahdr-like.jpg']);
  const rows = await p.ev("[...document.querySelectorAll('#meta-groups .ms-check')].map(b => ({ id: b.dataset.id, checked: b.checked, tier: b.closest('.ms-item').dataset.tier }))");
  const gain = rows.find((r) => r.id === 'jpeg:trailing:gain-map');
  check('the extra HDR image (gain map) is offered', !!gain, rows.map((r) => r.id));
  note('gain map tier and default', gain ? `${gain.tier}, ${gain.checked ? 'ticked' : 'kept'} by default (the spec does not tier gain maps; the engine calls them amber)` : 'missing');
  // The gain map is a second JPEG with its own metadata (here an author name). That is
  // offered on its own, so the gain map can stay while what it says about the photo goes.
  const inner = rows.find((r) => r.id === 'jpeg:trailing:gain-map:metadata');
  check('the metadata inside the gain map is offered on its own, red and ticked', inner && inner.tier === 'red' && inner.checked, inner || rows.map((r) => r.id));
  await p.press();
  let files = await p.download();
  check('one file downloaded', files.length === 1, files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-ultrahdr-like.jpg', removed: ['red'], lossless: true, word: 'public' });
    const gm = spawnSync('exiftool', ['-b', '-MPImage2', v.path], { maxBuffer: 16 * 1024 * 1024 }).stdout;
    const orig = spawnSync('exiftool', ['-b', '-MPImage2', join(FIX, 'jpeg-ultrahdr-like.jpg')], { maxBuffer: 16 * 1024 * 1024 }).stdout;
    const gmFile = join(CHECKS, 'ultrahdr-gainmap-out.jpg');
    const origFile = join(CHECKS, 'ultrahdr-gainmap-orig.jpg');
    writeFileSync(gmFile, gm);
    writeFileSync(origFile, orig);
    const ends = gm.length > 100 && gm[0] === 0xff && gm[1] === 0xd8 && gm[gm.length - 2] === 0xff && gm[gm.length - 1] === 0xd9;
    check('the kept gain map is still found through the MPF index, as a whole JPEG', ends, { out: gm.length, orig: orig.length });
    let px = null;
    try { px = py(SAME_PIXELS_PY, origFile, gmFile); } catch (e) { px = { error: String(e.message).slice(0, 200) }; }
    check('the kept gain map has the same pixels as before (Pillow)', px && px.same, px);
    const gmKeys = exiftoolKeys(gmFile);
    check('the kept gain map still carries its gain map description (hdrgm)', Object.keys(gmKeys).some((k) => /^XMP-hdrgm:/.test(k)), Object.keys(gmKeys).filter((k) => /XMP/.test(k)));
    const inside = scan(registry.filter((r) => r.file === 'jpeg-ultrahdr-like.jpg' && /GAINMAP/.test(r.string) && r.tier === 'red'), v.path);
    check('the author name inside the gain map is gone', !inside.length, inside.map((r) => r.string), 'engine');
  }
  // Red and amber removes the gain map too.
  await p.click('#quick [data-preset="amber"]');
  await p.press();
  files = await p.download();
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-ultrahdr-like.jpg', removed: ['red', 'amber'], lossless: true, word: 'minimal' });
    check('"Red and amber" removes the gain map', !v.back.items.some((i) => i.id === 'jpeg:trailing:gain-map') && !Object.keys(v.ex).some((k) => /MPImage2/.test(k)), Object.keys(v.ex).filter((k) => /MP/.test(k)));
  }
});

flow('two-files', DESKTOP, async (p) => {
  await p.load(['jpeg-everything.jpg', 'webp-everything.webp']);
  const st = await p.ev("({ files: document.querySelectorAll('#file-list .ms-file').length, crop: document.getElementById('crop-toggle').closest('label').hidden, multi: !document.getElementById('crop-multi').hidden, title: document.getElementById('preview-title').textContent, preview: document.getElementById('name-preview').textContent })");
  check('both pictures are listed, with crop turned off for several', st.files === 2 && st.crop && st.multi, st);
  check('the expected names are numbered', /image-1, image-2/.test(st.preview), st.preview);
  const label = await p.ev("document.getElementById('go-btn').textContent");
  check('with two pictures the button says "Prepare pictures"', label === 'Prepare pictures', label);
  await p.shot('two-files-loaded', { selector: '#preview-card' });
  await p.press();
  const files = await p.download();
  const names = files.map((f) => f.name).sort();
  check('two files: image-1.<word>.jpg and image-2.<word>.webp', names.length === 2 && /^image-1\.\w+\.jpg$/.test(names[0]) && /^image-2\.\w+\.webp$/.test(names[1]), names);
  for (const f of files) {
    const fixture = f.name.endsWith('.jpg') ? 'jpeg-everything.jpg' : 'webp-everything.webp';
    await verifyDownload(p, f, { fixture, index: f.name.startsWith('image-1') ? 1 : 2, removed: ['red'], lossless: true, word: 'public' });
  }
  await p.layout('two results');
  await p.shot('two-files-result', { selector: '#results' });
});

flow('bad-files', DESKTOP, async (p) => {
  await p.load(['not-an-image.pdf']);
  const pdf = await p.ev("({ err: document.getElementById('pick-errors').textContent, shown: !document.getElementById('pick-errors').hidden, ws: document.getElementById('workspace').hidden, role: document.getElementById('pick-errors').getAttribute('role') })");
  check('a PDF is refused with a clear message', pdf.shown && /"not-an-image\.pdf" is not a JPEG, PNG, WebP or HEIC picture/.test(pdf.err) && pdf.ws, pdf);
  check('the message is announced (role alert)', pdf.role === 'alert');
  await p.shot('bad-pdf', { selector: '#pick-card' });

  await p.load(['truncated.jpg']);
  const tr = await p.ev("({ err: document.getElementById('pick-errors').hidden ? '' : document.getElementById('pick-errors').textContent, ws: !document.getElementById('workspace').hidden, warnings: document.getElementById('meta-warnings').hidden ? '' : document.getElementById('meta-warnings').textContent })");
  check('a cut-off JPEG is opened or refused plainly, without crashing', tr.ws || tr.err.length > 0, tr);
  if (tr.ws) {
    check('it warns that the file is damaged', /end/i.test(tr.warnings), tr.warnings);
    const missing = await p.ev("document.getElementById('preview-missing').hidden ? '' : document.getElementById('preview-missing').textContent");
    if (missing) check('the preview card says the picture looks damaged, not just that it cannot be opened', /looks damaged or only partly saved/.test(missing), missing);
    const edit = await p.ev("document.getElementById('edit-unavailable').hidden ? '' : document.getElementById('edit-unavailable').textContent");
    if (edit) check('one picture is talked about in the singular', !/these pictures|them\b/.test(edit), edit);
    await p.press();
    const outcome = await p.ev("({ links: document.querySelectorAll('#results-list .ms-download').length, error: document.querySelector('#results-list [role=alert]')?.textContent || '' })");
    check('pressing the button gives a file or a plain explanation', outcome.links === 1 || outcome.error.length > 0, outcome);
    if (outcome.links) {
      const files = await p.download();
      if (files[0]) await verifyDownload(p, files[0], { fixture: 'truncated.jpg', removed: ['red'] });
    }
    await p.shot('bad-truncated', { selector: '#workspace' });
  }
  // Both at once, then a good file: the page recovers.
  await p.load(['not-an-image.pdf', 'jpeg-everything.jpg']);
  const mix = await p.ev("({ err: document.getElementById('pick-errors').textContent, ws: !document.getElementById('workspace').hidden, n: document.querySelectorAll('#meta-groups .ms-check').length })");
  check('a bad file next to a good one: the good one loads, the bad one is named', mix.ws && mix.n > 0 && /not-an-image\.pdf/.test(mix.err), mix);
  await p.press();
  const files = await p.download();
  check('and the good one still downloads as image.public.jpg', files.length === 1 && files[0].name === 'image.public.jpg', files.map((f) => f.name));
});

flow('offline', DESKTOP, async (p) => {
  // "Disconnect and try it": cut the network after the page has loaded.
  await p.s('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const mark = record.requests.length;
  check('the browser reports being offline', await p.ev('navigator.onLine === false'));
  await p.load(['jpeg-everything.jpg']);
  await p.click('#quick [data-preset="amber"]');
  await p.press();
  const files = await p.download();
  check('offline: the file is still made and downloaded', files.length === 1 && files[0].name === 'image.minimal.jpg', files.map((f) => f.name));
  if (files[0]) await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red', 'amber'], lossless: true, word: 'minimal' });
  const tried = record.requests.slice(mark).filter((r) => r.flow === 'offline' && /^https?:/.test(r.url));
  check('offline: the page did not even try the network', !tried.length, tried.map((r) => r.url));
  await p.s('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
});

flow('phone', PHONE, async (p) => {
  check('the first-run gate appears on a phone and closes with a tap', p.gateSeen);
  await textCheck(p, 'empty page');
  await p.layout('empty page');
  await p.shot('1-empty');
  await p.shot('1-empty-full', { full: true });
  await p.load(['jpeg-everything.jpg']);
  const view = await p.ev(`({ top: Math.round(document.getElementById('workspace').getBoundingClientRect().top),
    actions: [...document.querySelectorAll('button')].filter((b) => !b.closest('[hidden]') && /remove metadata|prepare/i.test(b.textContent)).map((b) => b.textContent.trim()),
    last: document.getElementById('go-btn').getBoundingClientRect().top >= document.getElementById('edit-card').getBoundingClientRect().bottom })`);
  check('after choosing a file, the phone shows the workspace, not the picker', Math.abs(view.top) <= 40, view);
  check('one button on a phone too, "Prepare picture", after size, format and name', view.actions.length === 1 && view.actions[0] === 'Prepare picture' && view.last, view);
  const chip = await p.ev("parseFloat(getComputedStyle(document.querySelector('#meta-groups .ms-source')).fontSize)");
  check(`the source chips (EXIF, XMP and so on) are at least 12 px (${chip} px)`, chip >= 12, chip);
  await p.layout('loaded file');
  const sizes = await p.ev(`(() => {
    const small = [];
    for (const el of document.querySelectorAll('#workspace button, #workspace input, #workspace select, #workspace label.ms-item, #quick button')) {
      const r = el.getBoundingClientRect();
      if (!r.width || el.type === 'file' || el.closest('[hidden]')) continue;
      if (el.matches('input[type=checkbox], input[type=radio]')) continue;
      if (r.height < 32) small.push(el.tagName.toLowerCase() + '#' + el.id + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    const texts = [...document.querySelectorAll('#workspace *')].filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
    const fs = texts.map(e => parseFloat(getComputedStyle(e).fontSize));
    const tiny = [...new Set(texts.filter(e => parseFloat(getComputedStyle(e).fontSize) < 12).map(e => '.' + String(e.className).split(' ')[0] + ' ' + getComputedStyle(e).fontSize))];
    return { small, minFont: Math.min(...fs), tiny };
  })()`);
  check('controls are at least 32 px tall for a finger', !sizes.small.length, sizes.small);
  check(`no text smaller than 11 px (smallest ${sizes.minFont} px)`, sizes.minFont >= 11, sizes.minFont);
  if (sizes.tiny.length) note('text under 12 px on a phone', sizes.tiny);
  await p.shot('2-loaded');
  await p.shot('2-loaded-list', { selector: '#meta-card' });
  await p.shot('2-loaded-full', { full: true });
  await p.shotAtButton('2-loaded-button');

  await p.click('label[for="crop-toggle"]');
  await p.click('#crop-ratios [data-ratio="4:5"]');
  const first = await p.ev("document.getElementById('crop-readout').textContent");
  const mid = await p.point('#crop-box');
  await p.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mid.x, y: mid.y }] });
  for (let i = 1; i <= 8; i++) await p.s('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mid.x + i * 3, y: mid.y + i * 2 }] });
  await p.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const moved = await p.ev("document.getElementById('crop-readout').textContent");
  check('a finger moves the crop frame', moved !== first, [first, moved]);
  await p.layout('crop view');
  await p.shot('3-crop', { selector: '#preview-card' });
  await p.press();
  const landed = await p.ev("({ focus: document.activeElement.id, top: Math.round(document.getElementById('results').getBoundingClientRect().top) })");
  check('phone: after pressing, focus moves to the new file and it is scrolled into view', landed.focus === 'results' && Math.abs(landed.top) <= 40, landed);
  await p.shot('4-result-view');
  let files = await p.download();
  check('cropped file downloaded as image.<word>.jpg', files.length === 1 && /^image\.\w+\.jpg$/.test(files[0].name), files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: false });
    check('4:5 crop gives a 4:5 picture', Math.abs(v.back.width * 5 - v.back.height * 4) <= 5, [v.back.width, v.back.height]);
  }
  await p.layout('result');
  await textCheck(p, 'result');
  await p.shot('4-result', { selector: '#results' });
  await p.shot('4-result-full', { full: true });

  // Default, no crop, on the phone too.
  await p.click('label[for="crop-toggle"]');
  await p.press();
  files = await p.download();
  check('phone: default scrub downloads image.public.jpg', files.length === 1 && files[0].name === 'image.public.jpg', files.map((f) => f.name));
  if (files[0]) await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: true, word: 'public' });

  // Start again returns to the beginning.
  await p.click('#reset-btn');
  const reset = await p.ev("({ ws: document.getElementById('workspace').hidden, res: document.getElementById('results').hidden, focus: document.activeElement.id })");
  check('"Start again" clears the page and puts focus on the picker', reset.ws && reset.res && reset.focus === 'choose-btn', reset);
});

// ---------------------------------------------------------------------------------------
// Run

const t0 = Date.now();
try {
  for (const f of flows) {
    if (ONLY.length && !ONLY.includes(f.name) && f.name !== SELF_TEST) continue;
    currentFlow = f.name;
    console.log(`\n# ${f.name} (${f.view.width}x${f.view.height})`);
    let p = null;
    try {
      p = await openPage(f.view);
      await Promise.race([
        f.fn(p),
        sleep(300000).then(() => { throw new Error('flow took longer than 5 minutes'); }),
      ]);
    } catch (err) {
      check(`flow ran to the end`, false, String(err.stack || err).split('\n').slice(0, 4).join(' | '), 'harness');
      if (p) await p.shot('error', { full: true }).catch(() => {});
    } finally {
      if (p) await p.close();
    }
  }
} finally {
  currentFlow = 'whole run';
}

// ---------------------------------------------------------------------------------------
// Network, policy and error checks over the whole run

console.log('\n# network, policy and errors (all flows)');
await sleep(300);
for (const key of Object.keys(record)) record[key] = record[key].filter((r) => r.flow !== SELF_TEST);
const web = record.requests.filter((r) => /^(https?|wss?):/.test(r.url));
const offsite = web.filter((r) => new URL(r.url).origin !== ORIGIN);
check('no request to any other origin, at any time', !offsite.length, offsite.map((r) => `${r.flow}: ${r.url}`));
const after = web.filter((r) => r.phase === 'after-load');
const afterBad = after.filter((r) => !published(r.url));
check(`after load, only the page's own files are requested (${after.length} requests after load)`, !afterBad.length, afterBad.map((r) => `${r.flow}: ${r.type} ${r.url}`));
if (after.length) note('requests after load', [...new Set(after.map((r) => `${r.type} ${new URL(r.url).pathname}`))]);
const fetches = record.requests.filter((r) => r.type === 'Fetch' || r.type === 'XHR' || r.type === 'EventSource' || r.type === 'WebSocket' || r.type === 'Ping');
check('no fetch, XHR, beacon or socket of anything, data: URLs included', !fetches.length, fetches.map((r) => `${r.flow}: ${r.type} ${r.url.slice(0, 80)}`));
const loadSet = [...new Set(web.filter((r) => r.phase === 'loading').map((r) => new URL(r.url).pathname))].sort();
note('files a visitor loads', loadSet);
check('every file the page loads is one GitHub Pages publishes', web.every((r) => published(r.url)), web.filter((r) => !published(r.url)).map((r) => r.url));
const badStatus = record.responses.filter((r) => r.status >= 400);
check('no failed responses (404 and so on)', !badStatus.length, badStatus.map((r) => `${r.status} ${r.url}`));
const failed = record.failed.filter((r) => !/^blob:/.test(r.url || ''));
check('no failed or blocked loads', !failed.length, failed);
const serverLines = existsSync(serveLog) ? readFileSync(serveLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const serverBad = serverLines.filter((l) => l.status >= 400 || l.host.split(':')[0] !== HOST);
check(`the server saw only good requests for ${HOST} (${serverLines.length} requests)`, serverLines.length > 0 && !serverBad.length, serverBad);
const unstamped = loadSet.filter((p) => /\.(js|css)$/.test(p)).filter((p) => !web.some((r) => new URL(r.url).pathname === p && /[?&]v=/.test(r.url)));
note('scripts and stylesheets fetched without a ?v= cache stamp (served for up to 4 hours from cache after a deploy)', unstamped);

const cspIssues = record.issues.filter((i) => i.code === 'ContentSecurityPolicyIssue');
const cspLogs = record.logs.filter((l) => /Content Security Policy|Refused to/i.test(l.text));
check('zero policy (CSP) violations', !record.csp.length && !cspIssues.length && !cspLogs.length, { events: record.csp, issues: cspIssues.map((i) => i.details), logs: cspLogs.map((l) => l.text) });
check('zero uncaught exceptions', !record.exceptions.length, record.exceptions);
const consoleErrors = [...record.console.filter((c) => c.type === 'error' || c.type === 'assert'), ...record.logs.filter((l) => l.level === 'error')];
check('zero console errors', !consoleErrors.length, consoleErrors);
const consoleOther = record.console.filter((c) => c.type !== 'error');
if (consoleOther.length) note('console messages from the page', consoleOther.map((c) => `${c.flow}: ${c.type} ${c.text}`));
const warnings = [...new Set(record.logs.filter((l) => l.level === 'warning').map((l) => `${l.source}: ${l.text}`))];
if (warnings.length) note('browser warnings (not from the page code)', warnings);
const otherIssues = [...new Set(record.issues.filter((i) => i.code !== 'ContentSecurityPolicyIssue').map((i) => i.code))];
if (otherIssues.length) note('DevTools issues raised', otherIssues);

// ---------------------------------------------------------------------------------------
// Report

const shots = existsSync(SHOTS) ? readdirSync(SHOTS).filter((f) => f.endsWith('.png')).sort().map((f) => join(SHOTS, f)) : [];
const failures = results.filter((r) => !r.ok);
const engine = failures.filter((r) => r.category === 'engine');
const page = failures.filter((r) => r.category !== 'engine');
const report = {
  when: new Date().toISOString(),
  seconds: Math.round((Date.now() - t0) / 1000),
  url: PAGE_URL,
  chromium: spawnSync(CHROMIUM, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  passed: results.filter((r) => r.level === 'pass').length,
  failed: failures.length,
  failedPage: page.length,
  failedEngine: engine.length,
  results,
  network: { requests: record.requests, failed: record.failed, server: serverLines },
  console: record.console,
  logs: record.logs,
  exceptions: record.exceptions,
  csp: record.csp,
  screenshots: shots,
};
writeFileSync(join(OUT, 'e2e-report.json'), J(report, null, 2));

ws.close();
chrome.kill();
server.kill();
await sleep(500);
rmSync(PROFILE, { recursive: true, force: true });
if (!KEEP) rmSync(RUN, { recursive: true, force: true });

console.log(`\n${report.passed} passed, ${failures.length} failed (${page.length} page or harness, ${engine.length} engine) in ${report.seconds} s.`);
if (failures.length) {
  // The same finding often shows up in several flows (the same fixture is used more than
  // once), so failures are grouped by what was found, with the flows listed.
  console.log('\nFailures, grouped:');
  const groups = new Map();
  for (const f of failures) {
    const key = `${f.category}|${f.name.replace(/^[^:]+\.(jpg|png|webp|heic): /, '')}|${typeof f.detail === 'string' ? f.detail : J(f.detail)}`;
    if (!groups.has(key)) groups.set(key, { ...f, flows: [] });
    groups.get(key).flows.push(f.flow);
  }
  for (const g of groups.values()) {
    console.log(`  [${g.category}] ${g.name.replace(/^[^:]+\.(jpg|png|webp|heic): /, '')}  (${[...new Set(g.flows)].join(', ')})`);
    if (g.detail !== undefined) console.log(`      ${typeof g.detail === 'string' ? g.detail : J(g.detail)}`);
  }
}
console.log(`\nReport: ${join(OUT, 'e2e-report.json')}\nScreenshots: ${SHOTS}${KEEP ? `\nDownloads and checked files: ${RUN}` : ''}`);
process.exit(page.length ? 1 : engine.length ? 2 : 0);
