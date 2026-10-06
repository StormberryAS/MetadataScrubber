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
import { crc32, deflateSync } from 'node:zlib';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS, detectFormat, inspect, privacyWord, scrub } from '../src/scrub-core.js';
import { SHARE_STATE, SHARE_TEXT, SKIP_CLOCK, appBridgeStub, appFileBytes, shareStub } from './share-stub.mjs';

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
// The page as the Android app loads it, on a phone-sized screen (see openPage). The share
// and clipboard stand-ins say yes here, so only the bridge can hide Share and Copy.
const ANDROID = { ...PHONE, label: 'android', android: true, init: shareStub({ share: true, clipboard: true }) };
// The page as the Android app runs it (1.0.1): the bridge line, plus a stand-in for the app's
// message channel that answers as MainActivity does (share-stub.mjs). The share and
// clipboard stand-ins say no, as Android's WebView does, so only the app can show the buttons.
const ANDROID_APP = { ...PHONE, label: 'android-app', android: true, init: `${appBridgeStub()}\n${shareStub({ share: false, clipboard: false })}` };
// A phone with a share sheet (Linux Chromium has none, so share-stub.mjs stands in for it
// and for the clipboard, and records what the page hands over).
const SHARE_PHONE = { ...PHONE, label: 'phone-share', init: shareStub({ share: true, clipboard: true }) };
// A browser with neither the Web Share API nor image copy.
const NO_SHARE = { ...DESKTOP, label: 'desktop-no-share', init: shareStub({ share: false, clipboard: false }) };

// The APK serves the same index.html with one line added on its own line before the first
// <script> tag, which loads android/web-overlay/android-bridge.js (WebAssets.inject in
// android/app/build.gradle.kts). The android flow does the same in the browser: the page
// still comes from tests/serve.py, and the line and the file are added on the way in.
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

// ---------------------------------------------------------------------------------------
// Preconditions

const NEED = ['jpeg-everything.jpg', 'jpeg-orientation-6.jpg', 'jpeg-large.jpg', 'png-transparent.png', 'webp-everything.webp',
  'heic-everything.heic', 'png-everything.png', 'jpeg-motion-photo.jpg', 'jpeg-ultrahdr-like.jpg', 'not-an-image.pdf', 'truncated.jpg', 'jpeg-ifd-overflow.jpg', 'canaries.tsv',
  'jpeg-uhdr-hdrgm-extra.jpg', 'jpeg-uhdr-bare-after-eoi.jpg'];
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
      case 'Fetch.requestPaused':
        androidServe(p).catch((err) => record.exceptions.push({ ...at, text: `harness: Android injection failed: ${err.message}` }));
        break;
      default:
    }
  };
  listeners.add(onMsg);

  // Android view only: add the bridge line to the page and serve the bridge itself.
  const androidServe = async (p) => {
    if (p.request.url === `${ORIGIN}/${BRIDGE_FILE}`) {
      await s('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }], body: readFileSync(BRIDGE_PATH).toString('base64') });
      return;
    }
    if (p.request.url === PAGE_URL && p.responseStatusCode === 200) {
      const r = await s('Fetch.getResponseBody', { requestId: p.requestId });
      const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
      const headers = (p.responseHeaders || []).filter((h) => !/^(content-length|etag|content-encoding)$/i.test(h.name));
      await s('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(androidIndex(text), 'utf8').toString('base64') });
      page.androidInjected = true;
      return;
    }
    await s('Fetch.continueRequest', { requestId: p.requestId });
  };

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
  if (view.init) await s('Page.addScriptToEvaluateOnNewDocument', { source: view.init });
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
  const shot = async (label, { selector, full, bottomFrom } = {}) => {
    const file = join(SHOTS, `${view.label}-${label}.png`);
    let clip;
    if (bottomFrom) {
      // From just above this element to the end of the page.
      const b = await ev(`(() => { const el = document.querySelector(${J(bottomFrom)}); el.scrollIntoView({ block: 'start', behavior: 'instant' }); return [el.getBoundingClientRect().top + scrollY, document.documentElement.scrollHeight]; })()`);
      const y = Math.max(0, b[0] - 24);
      clip = { x: 0, y, width: view.width, height: Math.min(8000, b[1] - y), scale: 1 };
    } else if (selector) {
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

  Object.assign(page, { browserContextId, s, ev, waitFor, click, typeInto, setSelect, setFiles, load, press, settle, download, shot, shotAtButton, layout, close, networkIdle, point });

  if (view.android) {
    await s('Fetch.enable', { patterns: [{ urlPattern: PAGE_URL, requestStage: 'Response' }, { urlPattern: `${ORIGIN}/${BRIDGE_FILE}`, requestStage: 'Request' }] });
  }

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
// keep: ids allowed to stay although their tier is in removed (the gain map kept by default).
async function verifyDownload(page, file, { fixture, base = 'image', index = null, removed, keep = [], lossless, word, expectFormat }) {
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
    check(`${tag}: the read-back list on the page matches the file (${back.items.length} details)`, back.items.length ? shown.remaining === back.items.length : shown.none, { page: shown.remaining, file: back.items.length });
    const hasRed = back.items.some((it) => it.tier === 'red');
    check(`${tag}: "Not recommended for public sharing." shown exactly when red is left with the custom word`, (measured === 'custom' && hasRed) === (shown.warning === 'Not recommended for public sharing.'), shown.warning);
    check(`${tag}: the tier word comes with its one-line meaning`, !!shown.meaning && shown.meaning.length > 10, shown.meaning);
  }

  const tiers = new Set(removed);
  const leftover = back.items.filter((it) => tiers.has(it.tier) && !keep.includes(it.id));
  check(`${tag}: engine read-back holds no ${[...tiers].join(' or ')} detail${keep.length ? ` beyond the kept ${keep.join(', ')}` : ''}`, !leftover.length, leftover.map((it) => it.id), 'engine');

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
// A fixture with its XMP already in the engine's standard form (0.0.3: XMP is only ever
// kept in that form, so a file whose XMP is not yet so changes even with nothing ticked).
// Flows that need "nothing ticked, nothing changes" load this copy.
async function standardCopy(name) {
  mkdirSync(CHECKS, { recursive: true });
  const out = join(CHECKS, name.replace(/\.(\w+)$/, '.standard.$1'));
  if (!existsSync(out)) writeFileSync(out, (await scrub(new Uint8Array(readFileSync(join(FIX, name))), [])).bytes);
  return out;
}

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

// The Android app section at the foot of the page, as the page shows it.
async function appSection(p) {
  return p.ev(`(() => {
    const sec = document.querySelector('[data-web-only]');
    if (!sec) return null;
    const a = sec.querySelector('a');
    const r = sec.getBoundingClientRect();
    const main = document.querySelector('main');
    return { id: sec.id, n: document.querySelectorAll('[data-web-only]').length, hidden: sec.hidden, display: getComputedStyle(sec).display, height: r.height, last: main.lastElementChild === sec,
      href: a && a.getAttribute('href'), target: a && a.getAttribute('target'), rel: a && a.getAttribute('rel'), btn: !!a && a.matches('.btn.btn-secondary'), linkHeight: a ? a.getBoundingClientRect().height : 0,
      text: a && a.textContent, extra: a && a.querySelector('.visually-hidden')?.textContent, line: sec.querySelector('p')?.textContent,
      firstScript: document.scripts[0]?.getAttribute('src') || null };
  })()`);
}

async function checkAppSectionShown(p) {
  const app = await appSection(p);
  const v = p.view.label;
  check(`${v}: the Android app section is the last thing in main, marked data-web-only, and shown on the website`, !!app && app.id === 'android-app' && app.n === 1 && app.last && !app.hidden && app.display !== 'none' && app.height > 0 && app.firstScript !== BRIDGE_FILE, app);
  check(`${v}: it links to ${ZAPSTORE} in a new tab (target _blank, rel noopener)`, !!app && app.href === ZAPSTORE && app.target === '_blank' && app.rel === 'noopener', app);
  check(`${v}: the link is a 44 px button that says where it goes and that it opens a new tab`, !!app && app.btn && app.linkHeight >= 44 && app.text === 'Get the Android app on Zapstore (opens in a new tab)' && app.extra === ' (opens in a new tab)', app);
  check(`${v}: the line says what the app is`, !!app && app.line === 'Android app: the same tool on your phone, with no permissions and no internet. Share a photo into it straight from your gallery.', app && app.line);
  await p.shot('0-android-app-bottom', { bottomFrom: '#android-app' });
  await p.ev("scrollTo({ top: 0, behavior: 'instant' })");
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
  await checkAppSectionShown(p);

  await p.load(['jpeg-everything.jpg']);
  const src = await inspect(new Uint8Array(readFileSync(join(FIX, 'jpeg-everything.jpg'))));
  const meta = await p.ev(`(() => {
    const sections = [...document.querySelectorAll('#meta-groups .ms-tier')].map(sec => ({
      tier: sec.dataset.tier,
      badge: sec.querySelector('.ms-tier-title .tier-badge')?.textContent,
      text: sec.querySelector('.ms-tier-title').textContent + ' ' + sec.querySelector('.ms-tier-desc').textContent,
    }));
    const rows = [...document.querySelectorAll('#meta-groups .ms-check')].map(b => {
      const item = b.closest('.ms-item');
      const badge = item.querySelector('.tier-badge');
      const cs = getComputedStyle(badge);
      return { id: b.dataset.id, checked: b.checked, tier: item.dataset.tier, section: b.closest('.ms-tier').dataset.tier, group: item.querySelector('.ms-group-word')?.textContent, badge: badge.textContent, badgeTier: badge.dataset.tier, colour: cs.color + '|' + cs.backgroundColor, source: item.querySelector('.ms-source')?.textContent, label: item.querySelector('.ms-item-label')?.textContent, name: b.labels[0] ? true : !!b.getAttribute('aria-labelledby') };
    });
    return { sections, rows, legend: !!document.getElementById('tier-legend'), quick: !!document.getElementById('quick') || !!document.querySelector('[data-preset]'), intro: document.getElementById('meta-intro').textContent, count: document.getElementById('select-count').textContent, mode: document.getElementById('mode-line').textContent, preview: document.getElementById('name-preview').textContent, summary: document.getElementById('file-summary').textContent, canvas: [document.getElementById('preview-canvas').width, document.getElementById('preview-canvas').height] };
  })()`);
  const ids = meta.rows.map((r) => r.id).sort();
  check('every detail the engine finds is listed, once', J(ids) === J(src.items.map((i) => i.id).sort()), { page: ids.length, engine: src.items.length });
  // Decision of 2026-10-03 (Marcos): the list is sorted by tier, red, amber and green, and
  // only shows the details the file has.
  check('the list is in three tier sections, in the order red, amber, green', J(meta.sections.map((x) => x.tier)) === J(['red', 'amber', 'green']), meta.sections.map((x) => x.tier));
  check('each detail sits in the section of its own tier', meta.rows.every((r) => r.section === r.tier), meta.rows.filter((r) => r.section !== r.tier).map((r) => r.id));
  const groupWord = Object.fromEntries(GROUPS.map((g) => [g.id, g.label]));
  const srcGroup = new Map(src.items.map((i) => [i.id, groupWord[i.group]]));
  // The group word is shown only in a section that mixes groups; every green detail is
  // Technical, so green details look as the Technical group did before.
  const mixedTier = (tier) => new Set(src.items.filter((i) => i.tier === tier).map((i) => i.group)).size > 1;
  check('in a section that mixes groups, each detail names its group (Where, Who, When, Device, Hidden extras)', meta.rows.filter((r) => mixedTier(r.tier)).every((r) => r.group && r.group === srcGroup.get(r.id)), meta.rows.filter((r) => mixedTier(r.tier) && r.group !== srcGroup.get(r.id)).map((r) => [r.id, r.group]));
  check('in a section of one group (green, all Technical), no detail repeats the group word', !mixedTier('green') && meta.rows.filter((r) => !mixedTier(r.tier)).every((r) => r.group === undefined), meta.rows.filter((r) => !mixedTier(r.tier) && r.group !== undefined).map((r) => [r.id, r.group]));
  const groupOrder = (tier) => meta.rows.filter((r) => r.tier === tier).map((r) => GROUPS.findIndex((g) => g.label === srcGroup.get(r.id)));
  check('within a section, details follow the group order', ['red', 'amber', 'green'].every((t) => groupOrder(t).every((g, i, a) => !i || a[i - 1] <= g)), ['red', 'amber', 'green'].map(groupOrder));
  // Decision of 2026-10-04 (Marcos, 0.0.3): only red is ticked to start with; amber and
  // green are kept unless the user ticks them.
  check('red details are ticked to start with, amber and green details are not', meta.rows.every((r) => r.checked === (r.tier === 'red')), meta.rows.filter((r) => r.checked !== (r.tier === 'red')).map((r) => r.id));
  // Decision of 2026-10-02: the computer name is its own red detail; editing software stays amber.
  const computerRow = meta.rows.find((r) => r.id === 'exif:computer');
  check('"Computer name" is its own red detail, ticked to start with', !!computerRow && computerRow.tier === 'red' && computerRow.checked && computerRow.label === 'Computer name', computerRow);
  const softwareRow = meta.rows.find((r) => r.id === 'exif:software');
  check('"Editing software" stays amber and, like all amber, starts unticked', !!softwareRow && softwareRow.tier === 'amber' && !softwareRow.checked && softwareRow.label === 'Editing software', softwareRow);
  // Decision of 2026-10-04: free text that can name people is red, so it is ticked.
  const freeText = meta.rows.filter((r) => ['exif:description', 'xmp:description', 'iptc:caption', 'iptc:keywords', 'jpeg:comment'].includes(r.id));
  check('captions, descriptions, keywords and comments are red and ticked to start with', freeText.length >= 4 && freeText.every((r) => r.tier === 'red' && r.checked), freeText);
  check('each detail shows its tier as a word as well as a colour', meta.rows.every((r) => r.badge === { red: 'Red', amber: 'Amber', green: 'Green' }[r.tier] && r.badgeTier === r.tier), meta.rows.filter((r) => r.badge !== { red: 'Red', amber: 'Amber', green: 'Green' }[r.tier]).map((r) => r.id));
  const colours = new Map(meta.rows.map((r) => [r.tier, r.colour]));
  check('the three tiers have three different colours', new Set(colours.values()).size === 3, Object.fromEntries(colours));
  check('each detail shows where it was found (EXIF, XMP, IPTC and so on)', meta.rows.every((r) => r.source && r.source.length > 1));
  const MEANING = {
    red: 'Red Remove before sharing. Can identify you, your camera or the place. Removed by default.',
    amber: 'Amber Think about it. Can reveal routines, devices or history. Kept unless you tick it.',
    green: 'Green Harmless and useful. Helps the picture display correctly. Kept by default.',
  };
  check('each section carries its tier word and its explanation, word for word', meta.sections.every((x) => x.text.replace(/\s+/g, ' ').trim() === MEANING[x.tier] && x.badge === { red: 'Red', amber: 'Amber', green: 'Green' }[x.tier]), meta.sections);
  check('the separate colour legend is gone', !meta.legend);
  check('there are no quick choice buttons (Red only, Red and amber, Select all, None)', !meta.quick);
  check('the intro says what is ticked to start with, word for word', meta.intro === 'Ticked details will be removed. Red details are ticked to start with; amber and green are kept unless you tick them.', meta.intro);
  check(`the count line counts details: "${src.items.filter((i) => i.tier === 'red').length} of ${src.items.length} details ticked for removal."`, meta.count === `${src.items.filter((i) => i.tier === 'red').length} of ${src.items.length} details ticked for removal.`, meta.count);
  check('the page says this is lossless', /^Lossless/.test(meta.mode), meta.mode);
  check('the expected name is image.public.jpg', /Expected name: image\.public\.jpg\./.test(meta.preview), meta.preview);
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
  // The result is saved, not fetched: the button says Save, and the screen reader hears
  // "ready to save". It stays an <a download> with a blob: address, because the Android
  // app catches clicks on exactly that and hands the file to its Save and Share sheet.
  const saveBtn = await p.ev(`(() => {
    const a = document.querySelector('#results-list .ms-download');
    return a && { tag: a.tagName, text: a.textContent, hasDownload: a.hasAttribute('download'), blob: (a.getAttribute('href') || '').startsWith('blob:'), name: a.download,
      said: document.getElementById('announcer').textContent, words: (document.getElementById('results').innerText.match(/\\bdownload\\w*/gi) || []) };
  })()`);
  check('the result button says "Save image.public.jpg"', saveBtn && saveBtn.text === 'Save image.public.jpg', saveBtn);
  check('the result button is still a download link to a blob: address (the Android bridge relies on it)', saveBtn && saveBtn.tag === 'A' && saveBtn.hasDownload && saveBtn.blob && saveBtn.name === 'image.public.jpg', saveBtn);
  check('the announcement says the file is ready to save', saveBtn && /^Done\. image\.public\.jpg is ready to save\./.test(saveBtn.said), saveBtn && saveBtn.said);
  check('the result card never says "download" to the reader', saveBtn && !saveBtn.words.length, saveBtn && saveBtn.words);
  let files = await p.download();
  check('one file downloaded, named image.public.jpg', files.length === 1 && files[0].name === 'image.public.jpg', files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: true, word: 'public' });
    // The default must keep amber and green: a scrubber that wipes everything would also pass the red checks.
    const kept = src.items.filter((i) => i.tier !== 'red').map((i) => i.id).sort();
    check(`the default removes exactly red: the read-back holds every amber and green detail and nothing else (${kept.length})`, J(v.back.items.map((i) => i.id).sort()) === J(kept), v.back.items.map((i) => `${i.tier}:${i.id}`));
    const meaning = await p.ev("document.querySelector('#results-list .ms-word-text').textContent");
    check('beside the save button, the public word is explained: "Safe to share publicly: location, serial numbers, names, captions and the hidden preview are gone. Dates and device details may remain; check them under Amber."', meaning === 'Safe to share publicly: location, serial numbers, names, captions and the hidden preview are gone. Dates and device details may remain; check them under Amber.', meaning);
    const host = registry.filter((r) => r.file === 'jpeg-everything.jpg' && /HOSTCOMPUTER/.test(r.string));
    check('the computer name is gone from the new file (read-back, bytes and exiftool)', host.length === 1 && !scan(host, v.path).length
      && !v.back.items.some((it) => /computer/.test(it.id)) && !Object.keys(v.ex || {}).some((k) => /HostComputer/i.test(k)), { registry: host.length, readBack: v.back.items.filter((it) => /computer/.test(it.id)).map((it) => it.id), exiftool: Object.keys(v.ex || {}).filter((k) => /HostComputer/i.test(k)) });
    const editor = registry.filter((r) => r.file === 'jpeg-everything.jpg' && /JPEG-EXIF-SOFTWARE/.test(r.string));
    check('the editing software (amber) stays in the new file', editor.length === 1 && scan(editor, v.path).length === 1 && v.back.items.some((it) => it.id === 'exif:software'), editor.map((r) => r.string));
    const captions = registry.filter((r) => r.file === 'jpeg-everything.jpg' && /JPEG-(IPTC-CAPTION|IPTC-KEYWORD|EXIF-DESCRIPTION|EXIF-USERCOMMENT|COM-)/.test(r.string));
    check('the caption, keywords, description, user comment and JPEG comment (red) are gone from the new file', captions.length === 5 && !scan(captions, v.path).length, captions.map((r) => r.string));
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

// ---------------------------------------------------------------------------------------
// The tier sections of the selection list (decision of 2026-10-03)

// Each section as the page shows it: its tick box, its arrow and its details.
const tierState = (p) => p.ev(`(() => Object.fromEntries([...document.querySelectorAll('#meta-groups .ms-tier')].map((sec) => {
  const all = sec.querySelector('.ms-tier-check');
  const btn = sec.querySelector('.ms-tier-toggle');
  const list = sec.querySelector('.ms-tier-items');
  const boxes = [...list.querySelectorAll('.ms-check')];
  const first = list.querySelector('.ms-item');
  return [sec.dataset.tier, {
    checked: all.checked, mixed: all.indeterminate,
    expanded: btn.getAttribute('aria-expanded'), controls: btn.getAttribute('aria-controls') === list.id && !!list.id,
    hidden: list.hidden, visible: !!first && first.getBoundingClientRect().height > 0,
    n: boxes.length, ticked: boxes.filter((b) => b.checked).length,
    count: sec.querySelector('.ms-tier-count').textContent,
    turned: getComputedStyle(sec.querySelector('.ms-chevron')).transform,
  }];
})))()`);
const tickedIds = (p) => p.ev("[...document.querySelectorAll('#meta-groups .ms-check')].filter((b) => b.checked).map((b) => b.dataset.id).sort()");
const countLine = (p) => p.ev("document.getElementById('select-count').textContent");
// Whether every section shown is closed: arrow collapsed, list hidden, nothing visible.
const allClosed = (st) => Object.values(st).every((x) => x.expanded === 'false' && x.hidden && !x.visible);

// Sets each colour section's own tick box as a person would, by pressing it: once, or
// twice when it is half-ticked and the colour must end up unticked. { red: true } ticks
// red and unticks amber and green.
async function setTiers(p, want) {
  for (const tier of Object.keys(await tierState(p))) {
    const on = !!want[tier];
    for (let i = 0; i < 2; i++) {
      const box = await p.ev(`(() => { const b = document.getElementById('m-tier-${tier}-all'); return { checked: b.checked, mixed: b.indeterminate }; })()`);
      if (!box.mixed && box.checked === on) break;
      await p.click(`#m-tier-${tier}-all`);
    }
  }
}

// A small PNG built here: IHDR, the given text chunks, an optional pHYs (a green detail),
// IDAT and IEND. Each text chunk is [type, keyword, text].
function textPng(texts, phys) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const w = 32;
  const h = 24;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([x * 8, y * 8, 128], y * (w * 3 + 1) + 1 + x * 3);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  for (const [type, kw, text] of texts) parts.push(chunk(type, Buffer.concat([Buffer.from(kw, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])));
  if (phys) {
    const d = Buffer.alloc(9);
    d.writeUInt32BE(2835, 0);
    d.writeUInt32BE(2835, 4);
    d[8] = 1;
    parts.push(chunk('pHYs', d));
  }
  parts.push(chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// The accessible name and description Chromium computes for one element.
async function axOf(p, selector) {
  const { root } = await p.s('DOM.getDocument', { depth: 0 });
  const { nodeId } = await p.s('DOM.querySelector', { nodeId: root.nodeId, selector });
  const { nodes } = await p.s('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  const n = nodes.find((x) => !x.ignored) || nodes[0];
  const prop = (name) => n.properties?.find((x) => x.name === name)?.value?.value;
  return { role: n.role?.value, name: n.name?.value, description: n.description?.value, checked: prop('checked'), expanded: prop('expanded') };
}

async function pressKey(p, key) {
  const k = key === 'Space' ? { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' } : { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
  await p.s('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await p.s('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
  await sleep(120);
}

// Presses the button with the details that are ticked now, downloads the file and proves,
// from the engine's read-back and from the list on the page, that exactly the ticked
// details are gone and everything else is still there.
async function prepareExactly(p, label, fixture, src, want, removed) {
  const ticked = await tickedIds(p);
  check(`${label}: the ticked details are exactly the ones meant`, J(ticked) === J([...want].sort()), { ticked, want: [...want].sort() });
  await p.press();
  const files = await p.download();
  if (!check(`${label}: one file downloaded`, files.length === 1, files.map((f) => f.name))) return null;
  const v = await verifyDownload(p, files[0], { fixture, removed, lossless: true });
  const expect = src.items.map((i) => i.id).filter((id) => !want.includes(id)).sort();
  const got = v.back.items.map((i) => i.id).sort();
  check(`${label}: the new file holds every detail that was not ticked and none that was (${got.length} of ${src.items.length} left)`, J(got) === J(expect), { missing: expect.filter((x) => !got.includes(x)), extra: got.filter((x) => !expect.includes(x)) });
  const shown = await p.ev("[...document.querySelectorAll('#results-list .ms-readback .ms-item')].map((li) => li.dataset.id).sort()");
  check(`${label}: the page's read-back list names the same details`, J(shown) === J(expect), { page: shown.length, expect: expect.length });
  return v;
}

flow('tier-sections', DESKTOP, async (p) => {
  await p.load(['jpeg-everything.jpg']);
  const src = await inspect(new Uint8Array(readFileSync(join(FIX, 'jpeg-everything.jpg'))));
  const of = (t) => src.items.filter((i) => i.tier === t).map((i) => i.id);
  const n = { red: of('red').length, amber: of('amber').length, green: of('green').length };
  const total = src.items.length;
  // Decision of 2026-10-04 (Marcos, 0.0.3): only red starts ticked.
  const defaults = of('red').sort();

  const said = await p.ev("document.getElementById('announcer').textContent");
  check(`the load is announced with the count of red details: "Picture loaded. ${total} metadata details found. ${n.red} of them are red and ticked for removal."`,
    said === `Picture loaded. ${total} metadata details found. ${n.red} of them are red and ticked for removal.`, said);
  // Decision of 2026-10-03 (Marcos): every colour starts closed.
  let st = await tierState(p);
  check('every section starts closed: red, amber and green', allClosed(st) && J(Object.keys(st)) === J(['red', 'amber', 'green']), st);
  check('each arrow names the list it opens (aria-controls)', st.red.controls && st.amber.controls && st.green.controls, st);
  check(`each section counts its details: "${n.red} details, ${n.red} ticked", "${n.amber} details, 0 ticked", "${n.green} details, 0 ticked"`,
    st.red.count === `${n.red} details, ${n.red} ticked` && st.amber.count === `${n.amber} details, 0 ticked` && st.green.count === `${n.green} details, 0 ticked`, [st.red.count, st.amber.count, st.green.count]);
  check('the red tick box is ticked, amber and green are not, none half-ticked', st.red.checked && !st.red.mixed && !st.amber.checked && !st.amber.mixed && !st.green.checked && !st.green.mixed, st);
  check('every closed arrow points down', st.red.turned === 'none' && st.amber.turned === 'none' && st.green.turned === 'none', [st.red.turned, st.amber.turned, st.green.turned]);
  check('there are no quick choice buttons', await p.ev("!document.getElementById('quick') && !document.querySelector('[data-preset]')"));

  // The tick box and the arrow, as a screen reader hears them.
  const box = await axOf(p, '#m-tier-red-all');
  check('the red tick box is a checkbox named after its tier ("Red: Remove before sharing. Every red detail."), with the meaning and count as its description',
    box.role === 'checkbox' && /^Red: Remove before sharing\. Every red detail\.$/.test(box.name || '') && /Can identify you/.test(box.description || '') && (box.description || '').includes(`${n.red} details, ${n.red} ticked`), box);
  const amberBox = await axOf(p, '#m-tier-amber-all');
  check('the amber tick box says amber is kept unless ticked', /^Amber: Think about it\. Every amber detail\.$/.test(amberBox.name || '') && /Can reveal routines, devices or history\. Kept unless you tick it\./.test(amberBox.description || ''), amberBox);
  const arrow = await axOf(p, '#m-tier-amber-toggle');
  check('the amber arrow is a button, "Amber details", collapsed', arrow.role === 'button' && arrow.name === 'Amber details' && arrow.expanded === false, arrow);
  const grp = await axOf(p, '#m-tier-red');
  check('each section is a group of tick boxes, not a landmark, named "Red: Remove before sharing."', grp.role === 'group' && grp.name === 'Red: Remove before sharing.', grp);
  const head = await axOf(p, '#m-tier-red-title');
  check('the red heading is read with a pause after the colour ("Red: Remove before sharing.")', head.role === 'heading' && head.name === 'Red: Remove before sharing.', head);

  // The arrow shows and hides the details, by mouse and by keyboard.
  await p.click('#m-tier-amber-toggle');
  st = await tierState(p);
  check('pressing the amber arrow shows the amber details and says so (aria-expanded true)', st.amber.expanded === 'true' && !st.amber.hidden && st.amber.visible && st.amber.turned !== 'none', st.amber);
  check('opening amber leaves red and green closed', st.red.expanded === 'false' && st.green.expanded === 'false', st);
  await p.shot('tiers-amber-open', { selector: '#meta-card' });
  await p.click('#m-tier-amber-toggle');
  st = await tierState(p);
  check('pressing it again hides them (aria-expanded false)', st.amber.expanded === 'false' && st.amber.hidden && !st.amber.visible, st.amber);
  await p.ev("document.getElementById('m-tier-green-toggle').focus()");
  await pressKey(p, 'Enter');
  st = await tierState(p);
  check('Enter on the green arrow opens green', st.green.expanded === 'true' && st.green.visible, st.green);
  await pressKey(p, 'Space');
  st = await tierState(p);
  check('Space on the green arrow closes it again', st.green.expanded === 'false' && !st.green.visible, st.green);
  check('opening and closing a section changes no tick', J(await tickedIds(p)) === J(defaults));

  // The tick box ticks and unticks a whole colour while its section stays closed.
  await p.click('#m-tier-amber-all');
  st = await tierState(p);
  check('ticking the amber tick box from a closed section ticks every amber detail, and amber stays closed', st.amber.checked && !st.amber.mixed && st.amber.ticked === n.amber && st.amber.count === `${n.amber} details, ${n.amber} ticked` && st.amber.expanded === 'false' && !st.amber.visible, st.amber);
  check('the count line follows', await countLine(p) === `${n.red + n.amber} of ${total} details ticked for removal.`, await countLine(p));
  await p.click('#m-tier-amber-all');
  await p.click('#m-tier-red-all');
  st = await tierState(p);
  check('unticking the red tick box from a closed section unticks every red detail', !st.red.checked && !st.red.mixed && st.red.ticked === 0 && st.red.count === `${n.red} details, 0 ticked` && st.red.expanded === 'false', st.red);
  check('with nothing ticked the count line says 0', await countLine(p) === `0 of ${total} details ticked for removal.`, await countLine(p));
  await p.click('#m-tier-red-all');
  st = await tierState(p);
  check('ticking red again brings back the starting selection, sections still closed', J(await tickedIds(p)) === J(defaults) && allClosed(st), st);

  // Opening a section and unticking one detail makes its tick box half-ticked; pressing
  // the tick box then ticks the whole colour again.
  await p.click('#m-tier-red-toggle');
  const redArrow = await axOf(p, '#m-tier-red-toggle');
  check('the open red arrow is "Red details", expanded (its name holds no verb that is wrong half the time)', redArrow.role === 'button' && redArrow.name === 'Red details' && redArrow.expanded === true, redArrow);
  await p.click('#m-tier-red-list .ms-item', 0);
  st = await tierState(p);
  check('opening red and unticking one red detail makes the red tick box half-ticked (indeterminate)', st.red.mixed && !st.red.checked && st.red.ticked === n.red - 1 && st.red.count === `${n.red} details, ${n.red - 1} ticked`, st.red);
  check('the count line follows the single detail', await countLine(p) === `${n.red - 1} of ${total} details ticked for removal.`, await countLine(p));
  const mixedAx = await axOf(p, '#m-tier-red-all');
  check('a screen reader hears the half-ticked state ("mixed")', mixedAx.checked === 'mixed', mixedAx);
  await p.click('#m-tier-red-all');
  st = await tierState(p);
  check('pressing a half-ticked tick box ticks the whole colour', st.red.checked && !st.red.mixed && st.red.ticked === n.red, st.red);
  await p.ev("document.getElementById('m-tier-red-all').focus()");
  await pressKey(p, 'Space');
  st = await tierState(p);
  check('Space on the red tick box unticks the colour', !st.red.checked && st.red.ticked === 0, st.red);
  await pressKey(p, 'Space');
  await p.click('#m-tier-red-toggle');
  await p.click('#m-tier-amber-toggle');
  const sw0 = await p.ev("[...document.querySelectorAll('#m-tier-amber-list .ms-check')].findIndex((b) => b.dataset.id === 'exif:software')");
  await p.click('#m-tier-amber-list .ms-item', sw0);
  st = await tierState(p);
  check('opening amber and ticking "Editing software" makes amber half-ticked, red stays fully ticked', st.amber.mixed && st.amber.ticked === 1 && st.red.checked && !st.red.mixed, st);
  await p.click('#m-tier-amber-all');
  await p.click('#m-tier-amber-toggle');

  // The three tick boxes cover what the quick choices used to do.
  await setTiers(p, { red: true, amber: true, green: true });
  st = await tierState(p);
  check('ticking all three tick boxes ticks every detail', st.red.checked && st.amber.checked && st.green.checked && (await tickedIds(p)).length === total, st);
  check('and the count line says so', await countLine(p) === `${total} of ${total} details ticked for removal.`, await countLine(p));
  await setTiers(p, {});
  st = await tierState(p);
  check('unticking all three unticks every detail', !st.red.checked && !st.amber.checked && !st.green.checked && !st.red.mixed && !st.amber.mixed && !st.green.mixed, st);
  // The badge beside the tick box ticks it too (it is its label); the heading words do not,
  // so a click meant to open a section never unticks a whole colour by surprise.
  await setTiers(p, { red: true });
  await p.click('#m-tier-amber .ms-tier-label');
  check('pressing the Amber badge ticks the amber colour', (await tierState(p)).amber.checked);
  const beforeWords = J(await tickedIds(p));
  await p.click('#m-tier-red .ms-tier-name');
  await p.click('#m-tier-amber .ms-tier-name');
  check('pressing the heading words "Remove before sharing." or "Think about it." changes no tick', J(await tickedIds(p)) === beforeWords && (await tierState(p)).red.checked && (await tierState(p)).amber.checked);

  // Prepare removes exactly what is ticked.
  await setTiers(p, { red: true });
  await prepareExactly(p, 'only red, by the red tick box', 'jpeg-everything.jpg', src, of('red'), ['red']);
  await setTiers(p, { red: true, amber: true });
  await prepareExactly(p, 'red and amber, by their tick boxes', 'jpeg-everything.jpg', src, [...of('red'), ...of('amber')], ['red', 'amber']);
  await setTiers(p, {});
  await p.click('#m-tier-amber-toggle');
  const sw = await p.ev("[...document.querySelectorAll('#m-tier-amber-list .ms-check')].findIndex((b) => b.dataset.id === 'exif:software')");
  await p.click('#m-tier-amber-list .ms-item', sw);
  st = await tierState(p);
  check('one amber detail ticked by hand: amber half-ticked, red and green unticked', st.amber.mixed && !st.red.checked && !st.red.mixed && !st.green.checked, st);
  const one = await prepareExactly(p, 'a single detail (Editing software)', 'jpeg-everything.jpg', src, ['exif:software'], []);
  if (one) check('the single detail is gone and the red details are all still there', !one.back.items.some((i) => i.id === 'exif:software') && of('red').every((id) => one.back.items.some((i) => i.id === id)));
  // Nothing ticked: the file's XMP is not in the standard form yet, so a file is still made.
  // It keeps every detail; only the layout of its XMP changes.
  await setTiers(p, {});
  await p.press();
  const kept = await p.download();
  if (check('nothing ticked, XMP not yet in the standard form: one file is still made', kept.length === 1, kept.map((f) => f.name))) {
    const back = await inspect(kept[0].bytes);
    check('it keeps every detail, and its XMP is now in the standard form', !back.normalise && JSON.stringify(back.items.map((i) => i.id).sort()) === JSON.stringify(src.items.map((i) => i.id).sort()), back.items.map((i) => i.id));
  }

  // A second file: whatever was open or ticked, every section closes again and the
  // starting selection comes back. Prepare with it removes exactly red.
  await p.click('#m-tier-green-toggle');
  await setTiers(p, { green: true });
  await p.load(['jpeg-everything.jpg']);
  st = await tierState(p);
  check('after loading another file every section is closed again', allClosed(st), st);
  check('after loading another file red is ticked again and amber and green are not', st.red.checked && !st.amber.checked && !st.amber.mixed && !st.green.checked && !st.green.mixed && J(await tickedIds(p)) === J(defaults), st);
  const preview = await p.ev("document.getElementById('name-preview').textContent");
  check('the expected name uses the public word again', /Expected name: image\.public\.jpg\./.test(preview), preview);
  const v = await prepareExactly(p, 'Prepare with the starting selection', 'jpeg-everything.jpg', src, defaults, ['red']);
  if (v) {
    check('the starting selection gives the public word in the name and the read-back', v.measured === 'public' && await p.ev("document.querySelector('#results-list .ms-download').download") === 'image.public.jpg', v.measured);
    check('the description beside the download matches public', await p.ev("document.querySelector('#results-list .ms-word-text').textContent") === 'Safe to share publicly: location, serial numbers, names, captions and the hidden preview are gone. Dates and device details may remain; check them under Amber.');
  }

  // Start again after changing the selection: the hidden list is emptied, and the next
  // file comes back closed with the starting selection.
  await p.click('#m-tier-amber-toggle');
  await setTiers(p, { amber: true, green: true });
  await p.click('#reset-btn');
  const cleared = await p.ev("({ ws: document.getElementById('workspace').hidden, sections: document.querySelectorAll('#meta-groups .ms-tier').length, boxes: document.querySelectorAll('#meta-groups .ms-check').length, count: document.getElementById('select-count').textContent })");
  check('Start again empties the list and the count line, not just hides them', cleared.ws && !cleared.sections && !cleared.boxes && cleared.count === '', cleared);
  await p.load(['jpeg-everything.jpg']);
  st = await tierState(p);
  check('after Start again and a new load, every section is closed and only red is ticked again', allClosed(st) && st.red.checked && !st.amber.checked && !st.amber.mixed && !st.green.checked && !st.green.mixed && J(await tickedIds(p)) === J(defaults), st);
  check('and the count line is back to the starting count', await countLine(p) === `${n.red} of ${total} details ticked for removal.`, await countLine(p));
  await p.layout('tier sections');
  await textCheck(p, 'tier sections');
});

flow('tier-absent', DESKTOP, async (p) => {
  for (const [fixture, missing] of [['png-transparent.png', 'green'], ['truncated.jpg', 'amber']]) {
    await p.load([fixture]);
    const src = await inspect(new Uint8Array(readFileSync(join(FIX, fixture))));
    const tiers = ['red', 'amber', 'green'].filter((t) => src.items.some((i) => i.tier === t));
    const shown = await p.ev("[...document.querySelectorAll('#meta-groups .ms-tier')].map((s) => s.dataset.tier)");
    check(`${fixture}: only the tiers it has are shown (${tiers.join(', ')})`, J(shown) === J(tiers), shown);
    check(`${fixture}: no ${missing} section at all, not even an empty one`, !shown.includes(missing) && !(await p.ev(`!!document.getElementById('m-tier-${missing}')`)), shown);
    const n = await p.ev("document.querySelectorAll('#meta-groups .ms-check').length");
    check(`${fixture}: every detail it has is listed (${src.items.length})`, n === src.items.length, n);
    const st = await tierState(p);
    check(`${fixture}: its sections start closed, red ticked, amber and green not`, allClosed(st) && Object.entries(st).every(([t, x]) => x.checked === (t === 'red') && !x.mixed), st);
  }
  // A file with no red details: a PNG with only an editing software text (amber) and a
  // print resolution (green), built here so no fixture has to change.
  const noRed = join(CHECKS, 'no-red.png');
  writeFileSync(noRed, textPng([['tEXt', 'Software', 'E2E-NO-RED-SOFTWARE']], true));
  await p.load([noRed]);
  {
    const src = await inspect(new Uint8Array(readFileSync(noRed)));
    const tiers = ['red', 'amber', 'green'].filter((t) => src.items.some((i) => i.tier === t));
    check('no-red.png: the engine finds amber and green details and no red ones', J(tiers) === J(['amber', 'green']), src.items.map((i) => `${i.tier}:${i.id}`));
    const shown = await p.ev("[...document.querySelectorAll('#meta-groups .ms-tier')].map((s) => s.dataset.tier)");
    check('no-red.png: only the amber and green sections are shown', J(shown) === J(['amber', 'green']), shown);
    const st = await tierState(p);
    check('no-red.png: both sections start closed and unticked', allClosed(st) && !st.amber.checked && !st.amber.mixed && !st.green.checked && !st.green.mixed, st);
    const total = src.items.length;
    check(`no-red.png: the count line reads "0 of ${total} details ticked for removal."`, await countLine(p) === `0 of ${total} details ticked for removal.`, await countLine(p));
    const said = await p.ev("document.getElementById('announcer').textContent");
    check('no-red.png: the load is announced as "None of them is red, so nothing is ticked."', said === `Picture loaded. ${total} metadata details found. None of them is red, so nothing is ticked.`, said);
    const idle = await pressExpectingNothing(p);
    check('no-red.png: with nothing ticked no file is made, and the page says why', idle.results && !idle.links && idle.text === 'Nothing to change yet: tick something to remove, or choose a crop, size or format.', idle);
    // Ticking amber by its tick box removes the software text.
    await setTiers(p, { amber: true });
    const preview = await p.ev("document.getElementById('name-preview').textContent");
    check('no-red.png: with amber ticked, the expected name is image.minimal.png', /Expected name: image\.minimal\.png\./.test(preview), preview);
    await p.press();
    const files = await p.download();
    check('no-red.png: one file downloaded, named image.minimal.png', files.length === 1 && files[0].name === 'image.minimal.png', files.map((f) => f.name));
    if (files[0]) {
      const v = await verifyDownload(p, files[0], { removed: ['red', 'amber'], word: 'minimal' });
      const green = src.items.filter((i) => i.tier === 'green').map((i) => i.id).sort();
      check(`no-red.png: the read-back holds only the green detail (${green.join(', ')})`, J(v.back.items.map((i) => i.id).sort()) === J(green), v.back.items.map((i) => `${i.tier}:${i.id}`));
      check('no-red.png: the software text is gone byte for byte', !Buffer.from(files[0].bytes).includes('E2E-NO-RED-SOFTWARE'));
    }
  }
  // A file with only green details: the announcement says nothing is ticked, not "0 ... are".
  const onlyGreen = join(CHECKS, 'only-green.png');
  writeFileSync(onlyGreen, textPng([], true));
  await p.load([onlyGreen]);
  {
    const said = await p.ev("document.getElementById('announcer').textContent");
    check('only-green.png: the load is announced as "1 metadata detail found. None of them is red, so nothing is ticked."', said === 'Picture loaded. 1 metadata detail found. None of them is red, so nothing is ticked.', said);
    const st = await tierState(p);
    check('only-green.png: only the green section, closed and unticked', J(Object.keys(st)) === J(['green']) && allClosed(st) && !st.green.checked && !st.green.mixed, st);
  }

  // A detail whose value cannot be read is still listed, and says so. Since the review of
  // 4 October 2026 a damaged make and model cannot be checked, so they are the red detail
  // Unexpected text in date or device details.
  await p.load(['jpeg-ifd-overflow.jpg']);
  const cam = await p.ev("(() => { const b = [...document.querySelectorAll('#meta-groups .ms-check')].find((x) => x.dataset.id === 'exif:device-text'); return b ? b.closest('.ms-item').querySelector('.ms-item-value')?.textContent : null; })()");
  check('jpeg-ifd-overflow.jpg: the damaged camera detail is listed with "Present, but its value cannot be read."', cam === 'Present, but its value cannot be read.', cam);
});

// Decision of 2026-10-02 (Marcos): one column on every screen, in working order, with one
// neutral button at the bottom. Not everybody wants to remove metadata, so pressing it
// with nothing to change says so instead of making an identical copy.
flow('one-column', DESKTOP, async (p) => {
  await p.load([await standardCopy('jpeg-everything.jpg')]);
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
  await setTiers(p, {});
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

flow('jpeg-tick-all', DESKTOP, async (p) => {
  await p.load([await standardCopy('jpeg-everything.jpg')]);
  // Nothing ticked alone would give back the same file, so no file is made.
  await setTiers(p, {});
  const idle = await pressExpectingNothing(p);
  check('nothing ticked and nothing else chosen makes no file and says why', idle.results && !idle.links && /^Nothing to change yet/.test(idle.text), idle);
  // Nothing ticked with a resize: everything kept, so the word is custom with the red warning.
  await p.typeInto('#resize-percent', '50');
  await p.press();
  let none = await p.download();
  check('nothing ticked with a resize downloads image.custom.jpg', none.length === 1 && none[0].name === 'image.custom.jpg', none.map((f) => f.name));
  if (none[0]) await verifyDownload(p, none[0], { removed: [], word: 'custom' });
  const warn = await p.ev("(() => { const w = document.querySelector('.ms-word-warning'); if (!w) return null; const c = getComputedStyle(w).color.match(/\\d+/g).map(Number); return { text: w.textContent, c }; })()");
  check('custom with red left says "Not recommended for public sharing." in red', !!warn && warn.text === 'Not recommended for public sharing.' && warn.c[0] > 200 && warn.c[1] < 180, warn);
  await p.click('input[name="resize"][value="none"]');
  await setTiers(p, { red: true, amber: true, green: true });
  const st = await p.ev("({ all: [...document.querySelectorAll('#meta-groups .ms-check')].every(b => b.checked), mode: document.getElementById('mode-line').textContent })");
  check('the three tick boxes tick every detail', st.all, st);
  check('normal rotation: everything ticked stays lossless', /^Lossless/.test(st.mode), st.mode);
  await p.press();
  const files = await p.download();
  check('one file downloaded', files.length === 1, files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red', 'amber', 'green'], lossless: true });
    check('everything ticked leaves no metadata details (clean)', v.measured === 'clean', v.back.items.map((i) => i.id));
    const extra = Object.keys(v.ex).filter((k) => !/^(SourceFile|ExifTool:|System:|File:|Composite:(ImageSize|Megapixels))/.test(k));
    note('exiftool still lists (structure only expected)', extra.map((k) => `${k}=${String(v.ex[k]).slice(0, 40)}`));
  }
});

flow('jpeg-rotation', DESKTOP, async (p) => {
  await p.load(['jpeg-orientation-6.jpg']);
  const pre = await p.ev("({ summary: document.getElementById('file-summary').textContent, mode: document.getElementById('mode-line').textContent, canvas: [document.getElementById('preview-canvas').width, document.getElementById('preview-canvas').height] })");
  check('the sideways photo is previewed upright (480 x 640)', pre.canvas[1] > pre.canvas[0] && /480 × 640/.test(pre.summary), pre);
  check('keeping the rotation (green, unticked to start with) stays lossless', /^Lossless/.test(pre.mode), pre.mode);
  await setTiers(p, { red: true, amber: true, green: true });
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
  const src0 = await inspect(new Uint8Array(readFileSync(join(FIX, 'jpeg-everything.jpg'))));
  await p.click('label[for="crop-toggle"]');
  check('ticking "Crop the picture" shows the crop frame and the shapes', await p.ev("!document.getElementById('crop-layer').hidden && !document.getElementById('crop-options').hidden"));
  await p.click('#crop-ratios [data-ratio="1:1"]');
  const first = await p.ev("document.getElementById('crop-readout').textContent");
  check('1:1 starts as the largest square (660 x 660)', /Crop: 660 × 660/.test(first), first);
  const mode = await p.ev("document.getElementById('mode-line').textContent");
  check('the page says cropping re-saves the picture before the button is pressed', mode === 'Cropping, resizing or changing format re-saves the picture.', mode);
  const reasonsDefault = await p.ev("document.getElementById('mode-reasons').textContent");
  check('with the starting selection (red only) amber is kept, so the page warns that kept XMP, IPTC and PNG text are left out', /Other kept details, such as XMP, IPTC and PNG text, are left out/.test(reasonsDefault), reasonsDefault);
  await setTiers(p, { red: true, amber: true });
  const reasonsRedAmber = await p.ev("document.getElementById('mode-reasons').textContent");
  check('with red and amber ticked only green is kept, so the page does not warn that kept XMP, IPTC or PNG text is left out', /Only the EXIF details you keep are written back, and colours are converted to sRGB/.test(reasonsRedAmber) && !/Other kept details/.test(reasonsRedAmber), reasonsRedAmber);
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
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red', 'amber'], lossless: false, expectFormat: 'jpeg' });
    check(`output is the square shown on screen (${v.back.width} x ${v.back.height})`, dims && v.back.width === dims[0] && v.back.height === dims[1], { out: [v.back.width, v.back.height], dims });
    check('cropped file has no built-in preview image (engine read-back)', !v.back.items.some((i) => /thumbnail|preview/i.test(i.id + i.label)), v.back.items.map((i) => i.id));
    const thumbs = scan(registry.filter((r) => r.file === 'jpeg-everything.jpg' && /THUMB/.test(r.string)), v.path);
    check('the uncropped preview images are gone byte for byte', !thumbs.length, thumbs.map((r) => r.string), 'engine');
    const lostNote = await p.ev("[...document.querySelectorAll('#results-list .ms-note')].map(n => n.textContent).find(t => /left them out/.test(t)) || ''");
    check('with red and amber ticked every kept detail survives the re-save, so no "left them out" note', lostNote === '' && v.back.items.length === src0.items.filter((i) => i.tier === 'green').length, { lostNote, kept: v.back.items.map((i) => i.id) });
  }
  await p.shot('3-crop-result', { selector: '#results' });
  // With amber kept, re-saving drops the kept XMP, IPTC and similar details, and the page says which.
  await setTiers(p, { red: true });
  const reasonsRed = await p.ev("document.getElementById('mode-reasons').textContent");
  check('with amber kept, the page warns before Prepare that kept XMP, IPTC and PNG text are left out', /Other kept details, such as XMP, IPTC and PNG text, are left out/.test(reasonsRed), reasonsRed);
  await p.press();
  const redOnly = await p.download();
  check('red only: one file downloaded', redOnly.length === 1, redOnly.map((f) => f.name));
  if (redOnly[0]) {
    await verifyDownload(p, redOnly[0], { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: false, expectFormat: 'jpeg' });
    const lostNote = await p.ev("[...document.querySelectorAll('#results-list .ms-note')].map(n => n.textContent).find(t => /left them out/.test(t)) || ''");
    check('the page lists the kept details that re-saving left out', /left them out: .+\./.test(lostNote), lostNote);
    check('that list names each source once (no "(C2PA) (C2PA)")', !/\(([^()]+)\) \(\1\)/.test(lostNote), lostNote);
  }
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
  check(`all ${src.items.length} WebP details are listed`, n === src.items.length, n);
  await p.press();
  const files = await p.download();
  check('one file downloaded, named image.public.webp', files.length === 1 && files[0].name === 'image.public.webp', files.map((f) => f.name));
  if (files[0]) await verifyDownload(p, files[0], { fixture: 'webp-everything.webp', removed: ['red'], lossless: true, word: 'public', expectFormat: 'webp' });
});

flow('png-default', DESKTOP, async (p) => {
  await p.load(['png-everything.png']);
  const n = await p.ev("document.querySelectorAll('#meta-groups .ms-check').length");
  const src = await inspect(new Uint8Array(readFileSync(join(FIX, 'png-everything.png'))));
  check(`all ${src.items.length} PNG details are listed`, n === src.items.length, n);
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
    // Only the XMP changes length (written in the standard form): the same boxes, and no
    // more than the XMP's own difference in size.
    const inSize = statSync(join(FIX, 'heic-everything.heic')).size;
    check('HEIC: only the XMP changed length (written in the standard form), everything else edited in place', files[0].bytes.length <= inSize && inSize - files[0].bytes.length < 4096, [inSize, files[0].bytes.length]);
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

// The checks a kept HDR gain map must pass in a downloaded file: found through MPF as a
// whole JPEG with the input's pixels, the length the Container directory gives, and its
// hdrgm description in both the photo and the gain map.
function keptGainMap(v, fixture, label) {
  const gm = spawnSync('exiftool', ['-b', '-MPImage2', v.path], { maxBuffer: 16 * 1024 * 1024 }).stdout;
  const orig = spawnSync('exiftool', ['-b', '-MPImage2', join(FIX, fixture)], { maxBuffer: 16 * 1024 * 1024 }).stdout;
  const gmFile = join(CHECKS, `${label}-gainmap-out.jpg`);
  const origFile = join(CHECKS, `${label}-gainmap-orig.jpg`);
  writeFileSync(gmFile, gm);
  writeFileSync(origFile, orig);
  const whole = gm.length > 100 && gm[0] === 0xff && gm[1] === 0xd8 && gm[gm.length - 2] === 0xff && gm[gm.length - 1] === 0xd9;
  check(`${label}: the kept gain map is still found through the MPF index, as a whole JPEG`, whole, { out: gm.length, orig: orig.length }, 'engine');
  let px = null;
  try { px = py(SAME_PIXELS_PY, origFile, gmFile); } catch (e) { px = { error: String(e.message).slice(0, 200) }; }
  check(`${label}: the kept gain map has the same pixels as before (Pillow)`, px && px.same, px, 'engine');
  const text = readFileSync(v.path).toString('utf8');
  const item = /<Container:Item\b[^>]*Item:Semantic="GainMap"[^>]*>/.exec(text);
  const len = item && /Item:Length="(\d+)"/.exec(item[0]);
  check(`${label}: the Container directory gives the gain map's real length`, !!len && Number(len[1]) === gm.length, { directory: len && len[1], mpf: gm.length }, 'engine');
  const gmKeys = exiftoolKeys(gmFile);
  check(`${label}: the kept gain map still carries its gain map description (hdrgm)`, Object.keys(gmKeys).some((k) => /^XMP-hdrgm:/.test(k)), Object.keys(gmKeys).filter((k) => /XMP/.test(k)), 'engine');
  check(`${label}: the photo itself still says it has a gain map (hdrgm in its XMP)`, Object.keys(v.ex).some((k) => /^XMP-hdrgm:/.test(k)), Object.keys(v.ex).filter((k) => /XMP/.test(k)), 'engine');
}

const GAIN_KEEP = ['jpeg:trailing:gain-map', 'xmp:gainmap'];
const GAIN_NOTE = 'The HDR gain map stays, so the photo keeps its brightness on HDR screens. Tick HDR gain map under Amber for a minimal file.';
const rowsOf = (p) => p.ev("[...document.querySelectorAll('#meta-groups .ms-check')].map(b => ({ id: b.dataset.id, checked: b.checked, tier: b.closest('.ms-item').dataset.tier, group: b.closest('.ms-item').querySelector('.ms-group-word')?.textContent || '' }))");

flow('ultrahdr', DESKTOP, async (p) => {
  await p.load(['jpeg-ultrahdr-like.jpg']);
  const rows = await rowsOf(p);
  const gain = rows.find((r) => r.id === 'jpeg:trailing:gain-map');
  const desc = rows.find((r) => r.id === 'xmp:gainmap');
  check('the extra HDR image (gain map) is offered, amber', gain && gain.tier === 'amber', gain || rows.map((r) => r.id));
  // The gain map changes how the photo looks, not who took it, so it starts unticked; the
  // engine keeps only what it needs to render and lists everything else on its own.
  check('the gain map starts unticked', gain && !gain.checked, gain);
  check('its XMP description (HDR gain map details) is amber and starts unticked', desc && desc.tier === 'amber' && !desc.checked, desc || rows.map((r) => r.id));
  const others = rows.filter((r) => r.tier !== 'green' && !GAIN_KEEP.includes(r.id));
  check('every other red detail starts ticked, and every other amber detail unticked (0.0.3)', others.length > 0 && others.every((r) => r.checked === (r.tier === 'red')), others.filter((r) => r.checked !== (r.tier === 'red')));
  // The gain map is a second JPEG with its own metadata (here an author name). That is
  // offered on its own and follows its own tier, so the gain map can stay while what it says
  // about the photo goes.
  const inner = rows.find((r) => r.id === 'jpeg:trailing:gain-map:metadata');
  check('the metadata inside the gain map is offered on its own, red and ticked', inner && inner.tier === 'red' && inner.checked, inner || rows.map((r) => r.id));
  const said = await p.ev("document.getElementById('announcer').textContent");
  check('the load announcement counts the red details only (amber, the gain map with it, is kept)', /of them (is|are) red and ticked for removal\.$/.test(said) && !/HDR gain map/.test(said), said);
  const amberBox = () => p.ev("(() => { const b = document.getElementById('m-tier-amber-all'); return { checked: b.checked, mixed: b.indeterminate, count: document.getElementById('m-tier-amber-count').textContent }; })()");
  const box0 = await amberBox();
  check('the amber tick box starts unticked', !box0.checked && !box0.mixed, box0);
  const preview0 = await p.ev("document.getElementById('name-preview').textContent");
  check('the expected name uses the public word (an amber gain map stays)', /Expected name: image\.public\.jpg\./.test(preview0), preview0);

  // Prepare with the starting selection (red only): the gain map stays with its description
  // and the other amber details, and everything red in and around it goes.
  const uSrc = await inspect(new Uint8Array(readFileSync(join(FIX, 'jpeg-ultrahdr-like.jpg'))));
  await p.press();
  let files = await p.download();
  check('one file downloaded, named image.public.jpg', files.length === 1 && files[0].name === 'image.public.jpg', files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-ultrahdr-like.jpg', removed: ['red'], lossless: true, word: 'public' });
    const left = v.back.items.filter((i) => i.tier !== 'green').map((i) => i.id).sort();
    const amber = uSrc.items.filter((i) => i.tier === 'amber').map((i) => i.id).sort();
    check('no red stays; every amber detail stays, the gain map and its description among them', J(left) === J(amber) && GAIN_KEEP.every((id) => left.includes(id)), left);
    const note = await p.ev("(document.querySelector('#results-list .ms-word-note') || {}).textContent || ''");
    check('no gain map note, since other amber details stay too', note === '', note);
    keptGainMap(v, 'jpeg-ultrahdr-like.jpg', 'ultrahdr');
    const inside = scan(registry.filter((r) => r.file === 'jpeg-ultrahdr-like.jpg' && /GAINMAP/.test(r.string) && r.tier === 'red'), v.path);
    check('the author name inside the gain map is gone', !inside.length, inside.map((r) => r.string), 'engine');
  }

  // Amber ticked too, the gain map and its description unticked: they alone stay of red and
  // amber, and the result says why the word is public and how to get minimal.
  await setTiers(p, { red: true, amber: true });
  for (const id of GAIN_KEEP) await p.ev(`document.querySelector('#meta-groups .ms-check[data-id="${id}"]').click()`);
  await p.press();
  files = await p.download();
  check('amber ticked, gain map kept: one file downloaded, named image.public.jpg', files.length === 1 && files[0].name === 'image.public.jpg', files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-ultrahdr-like.jpg', removed: ['red', 'amber'], keep: GAIN_KEEP, lossless: true, word: 'public' });
    const left = v.back.items.filter((i) => i.tier !== 'green').map((i) => i.id).sort();
    check('only the gain map and its description stay of red and amber', J(left) === J(GAIN_KEEP), left);
    const note = await p.ev("(document.querySelector('#results-list .ms-word-note') || {}).textContent || ''");
    check('the result says why the word is public and how to get minimal', note === GAIN_NOTE, note);
    keptGainMap(v, 'jpeg-ultrahdr-like.jpg', 'ultrahdr-amber');
  }

  // Ticking the gain map gives the minimal word: the gain map, its MPF index, any ISO
  // segment and the hdrgm description all go.
  await p.ev("document.querySelector('#meta-groups .ms-check[data-id=\"jpeg:trailing:gain-map\"]').click()");
  const ticked = await p.ev("document.querySelector('#meta-groups .ms-check[data-id=\"jpeg:trailing:gain-map\"]').checked");
  check('the gain map can be ticked', ticked === true, ticked);
  const preview1 = await p.ev("document.getElementById('name-preview').textContent");
  check('the expected name then uses the minimal word', /Expected name: image\.minimal\.jpg\./.test(preview1), preview1);
  await p.press();
  files = await p.download();
  check('gain map ticked: one file downloaded, named image.minimal.jpg', files.length === 1 && files[0].name === 'image.minimal.jpg', files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-ultrahdr-like.jpg', removed: ['red', 'amber'], lossless: true, word: 'minimal' });
    check('the gain map, its MPF index and its description are gone', !v.back.items.some((i) => /gain|mpf|isogain/.test(i.id)) && !Object.keys(v.ex).some((k) => /MPImage2|XMP-hdrgm|MPF0/.test(k)), { readBack: v.back.items.map((i) => i.id), exiftool: Object.keys(v.ex).filter((k) => /MP|hdrgm/.test(k)) });
    const raw = readFileSync(v.path).toString('latin1');
    check('no MPF index, ISO 21496-1 segment or hdrgm text is left in the bytes', !raw.includes('MPF\0') && !raw.includes('urn:iso:std:iso:ts:21496') && !raw.includes('hdrgm'), null, 'engine');
    const note0 = await p.ev("(document.querySelector('#results-list .ms-word-note') || {}).textContent || ''");
    check('no gain map note when the gain map went', note0 === '', note0);
  }
});

// An HDR photo in a batch with another photo: the gain map stays for the HDR photo only.
// The colour note above the button (Marcos, 2026-10-05): shown only while the choices
// remove a colour profile or the HDR gain map, with the exact text, and gone when those
// boxes are unticked. Never shown with the default red-only choice.
const COLOUR_NOTE = 'Colours may look a little duller and bright areas less vivid on HDR screens.';
const colourNote = (p) => p.ev(`(() => {
  const n = document.getElementById('colour-note');
  const r = n.getBoundingClientRect();
  const b = document.getElementById('go-btn').getBoundingClientRect();
  return { hidden: n.hidden, shown: r.height > 0 && getComputedStyle(n).display !== 'none', text: n.textContent, live: n.parentElement.getAttribute('aria-live'), above: r.height > 0 ? r.bottom <= b.top : null, resave: document.getElementById('mode-line').textContent };
})()`);
// Opens the amber section (closed to start with) so its tick boxes can be pressed.
const openAmber = async (p) => {
  if (await p.ev("document.getElementById('m-tier-amber-toggle').getAttribute('aria-expanded') !== 'true'")) await p.click('#m-tier-amber-toggle');
};
flow('colour-note', DESKTOP, async (p) => {
  await p.load(['jpeg-everything.jpg']);
  let n = await colourNote(p);
  check('colour note: hidden with the default red-only choice, inside a polite live region', n.hidden && !n.shown && n.text === '' && n.live === 'polite', n);
  await setTiers(p, { red: true, green: true });
  n = await colourNote(p);
  check('colour note: Green ticked on a photo with a colour profile shows the exact text above the button', !n.hidden && n.shown && n.text === COLOUR_NOTE && n.above === true, n);
  await setTiers(p, { red: true });
  n = await colourNote(p);
  check('colour note: hidden again when Green is unticked', n.hidden && !n.shown, n);
  // With a re-save (a resize), the note sits beside the re-save line, not instead of it.
  await setTiers(p, { red: true, green: true });
  await p.typeInto('#resize-percent', '50');
  n = await colourNote(p);
  check('colour note: shown beside the re-save line, not instead of it', !n.hidden && n.text === COLOUR_NOTE && /re-save/i.test(n.resave), n);
  await p.click('input[name="resize"][value="none"]');
  await setTiers(p, { red: true });

  // An HDR photo: the gain map alone, then the Apple HDR brightness alone.
  await p.load(['jpeg-ultrahdr-like.jpg']);
  await openAmber(p);
  n = await colourNote(p);
  check('colour note: hidden on an HDR photo with the default choice', n.hidden, n);
  await p.click('#meta-groups .ms-check[data-id="jpeg:trailing:gain-map"]');
  n = await colourNote(p);
  check('colour note: shown when the HDR gain map is ticked', !n.hidden && n.shown && n.text === COLOUR_NOTE, n);
  await p.click('#meta-groups .ms-check[data-id="jpeg:trailing:gain-map"]');
  n = await colourNote(p);
  check('colour note: hidden again when the HDR gain map is unticked', n.hidden && !n.shown, n);
  await p.load(['jpeg-uhdr-apple-16e.jpg']);
  await openAmber(p);
  n = await colourNote(p);
  check('colour note: hidden on an iPhone HDR photo with the default choice', n.hidden, n);
  await p.click('#meta-groups .ms-check[data-id="exif:apple-hdr"]');
  n = await colourNote(p);
  check('colour note: shown when Apple HDR brightness is ticked', !n.hidden && n.text === COLOUR_NOTE, n);
  await p.click('#meta-groups .ms-check[data-id="exif:apple-hdr"]');
  n = await colourNote(p);
  check('colour note: hidden again when Apple HDR brightness is unticked', n.hidden, n);
  await textCheck(p, 'colour note');
});

flow('hdr-batch', DESKTOP, async (p) => {
  await p.load(['jpeg-ultrahdr-like.jpg', 'jpeg-everything.jpg']);
  const rows = await rowsOf(p);
  const kept = rows.filter((r) => GAIN_KEEP.includes(r.id));
  const others = rows.filter((r) => r.tier !== 'green' && !GAIN_KEEP.includes(r.id));
  check('batch: the gain map and its description start unticked', kept.length === 2 && kept.every((r) => !r.checked), kept);
  check('batch: every other red detail starts ticked, every other amber detail unticked', others.length > 0 && others.every((r) => r.checked === (r.tier === 'red')), others.filter((r) => r.checked !== (r.tier === 'red')));
  await p.press();
  const files = await p.download();
  const names = files.map((f) => f.name).sort();
  check('batch: both photos are public (amber stays; the HDR photo keeps its gain map)', J(names) === J(['image-1.public.jpg', 'image-2.public.jpg']), names);
  for (const f of files) {
    const hdr = f.name.startsWith('image-1');
    const fixture = hdr ? 'jpeg-ultrahdr-like.jpg' : 'jpeg-everything.jpg';
    const v = await verifyDownload(p, f, { fixture, index: hdr ? 1 : 2, removed: ['red'], lossless: true, word: 'public' });
    if (hdr) keptGainMap(v, fixture, 'hdr-batch');
    else check(`batch: ${f.name} has no gain map`, !v.back.items.some((i) => /gain|mpf/.test(i.id)), v.back.items.map((i) => i.id));
  }
});

// An HDR photo in a batch with a file whose second picture is not plausibly a gain map: that
// file's gain map description is red, which makes the merged row red. It still starts
// unticked, so the real gain map keeps its description; the other file's description goes
// with its own red picture.
flow('hdr-batch-mixed', DESKTOP, async (p) => {
  await p.load(['jpeg-ultrahdr-like.jpg', 'jpeg-uhdr-not-gainmap.jpg']);
  const rows = await rowsOf(p);
  const desc = rows.find((r) => r.id === 'xmp:gainmap');
  const gain = rows.find((r) => r.id === 'jpeg:trailing:gain-map');
  check('mixed batch: the merged description row is red but starts unticked', desc && desc.tier === 'red' && !desc.checked, desc);
  check('mixed batch: the gain map starts unticked', gain && !gain.checked, gain);
  const extra = rows.find((r) => r.id === 'jpeg:trailing:mpf-image');
  check('mixed batch: the other second picture is red and ticked', extra && extra.tier === 'red' && extra.checked, extra);
  await p.press();
  const files = await p.download();
  const names = files.map((f) => f.name).sort();
  check('mixed batch: image-1.public.jpg keeps its gain map, image-2 is minimal', J(names) === J(['image-1.public.jpg', 'image-2.minimal.jpg']), names);
  for (const f of files) {
    const hdr = f.name.startsWith('image-1');
    const fixture = hdr ? 'jpeg-ultrahdr-like.jpg' : 'jpeg-uhdr-not-gainmap.jpg';
    const v = await verifyDownload(p, f, { fixture, index: hdr ? 1 : 2, removed: ['red'], lossless: true, word: hdr ? 'public' : 'minimal' });
    if (hdr) {
      keptGainMap(v, fixture, 'hdr-batch-mixed');
      const text = readFileSync(v.path).toString('utf8');
      check('mixed batch: the HDR photo keeps hdrgm:Version and its Container directory', /hdrgm:Version="1\.0"/.test(text) && /Container:Directory/.test(text), null, 'engine');
    } else {
      check('mixed batch: the other file has no gain map description, index or second picture', !v.back.items.some((i) => /gain|mpf/.test(i.id)) && !readFileSync(v.path).toString('latin1').includes('hdrgm'), v.back.items.map((i) => i.id), 'engine');
    }
  }
});

// Ticking only "HDR gain map details" takes the gain map along, so no gain map is left that
// readers could no longer find; the expected name says minimal before the file is made.
flow('hdr-description', DESKTOP, async (p) => {
  await p.load(['jpeg-ultrahdr-like.jpg']);
  // Every red and amber detail ticked except the gain map itself, so only its description
  // is ticked of the two.
  await setTiers(p, { red: true, amber: true });
  await p.ev("document.querySelector('#meta-groups .ms-check[data-id=\"jpeg:trailing:gain-map\"]').click()");
  check('description ticked, gain map unticked', J(await p.ev("['jpeg:trailing:gain-map', 'xmp:gainmap'].map((id) => document.querySelector(`#meta-groups .ms-check[data-id=\"${id}\"]`).checked)")) === J([false, true]));
  const preview = await p.ev("document.getElementById('name-preview').textContent");
  check('description ticked: the expected name uses the minimal word', /Expected name: image\.minimal\.jpg\./.test(preview), preview);
  await p.press();
  const files = await p.download();
  check('description ticked: image.minimal.jpg', files.length === 1 && files[0].name === 'image.minimal.jpg', files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-ultrahdr-like.jpg', removed: ['red', 'amber'], lossless: true, word: 'minimal' });
    const raw = readFileSync(v.path).toString('latin1');
    check('description ticked: no gain map, MPF index or hdrgm text is left', !v.back.items.some((i) => /gain|mpf|isogain/.test(i.id)) && !raw.includes('MPF\0') && !raw.includes('hdrgm'), v.back.items.map((i) => i.id), 'engine');
  }
});

// HDR photos with something hidden in or around the gain map: each extra is listed, red and
// ticked, under the group its name says; the gain map stays and the extras go.
flow('hdr-planted', DESKTOP, async (p) => {
  await p.load(['jpeg-uhdr-hdrgm-extra.jpg', 'jpeg-uhdr-bare-after-eoi.jpg']);
  const rows = await rowsOf(p);
  const want = [['xmp:serial', 'Who'], ['xmp:gps', 'Where'], ['jpeg:trailing:gain-map:after', 'Hidden extras']];
  for (const [id, group] of want) {
    const r = rows.find((x) => x.id === id);
    check(`${id} is offered red and ticked, under ${group}`, r && r.tier === 'red' && r.checked && r.group === group, r || rows.map((x) => x.id));
  }
  check('the gain map and its description start unticked', rows.filter((r) => GAIN_KEEP.includes(r.id)).every((r) => !r.checked), rows.filter((r) => GAIN_KEEP.includes(r.id)));
  await p.press();
  const files = await p.download();
  const names = files.map((f) => f.name).sort();
  check('both HDR photos are public', J(names) === J(['image-1.public.jpg', 'image-2.public.jpg']), names);
  for (const f of files) {
    const fixture = f.name.startsWith('image-1') ? 'jpeg-uhdr-hdrgm-extra.jpg' : 'jpeg-uhdr-bare-after-eoi.jpg';
    const v = await verifyDownload(p, f, { fixture, index: f.name.startsWith('image-1') ? 1 : 2, removed: ['red'], lossless: true, word: 'public' });
    keptGainMap(v, fixture, `hdr-planted-${fixture.replace(/\.jpg$/, '')}`);
  }
});

// An iPhone HDR JPEG: the gain map, Apple's HDR brightness (two numbers from the MakerNote)
// and the gain map's apdi label stay; the rest of the MakerNote and the extra apdi field go.
flow('hdr-apple', DESKTOP, async (p) => {
  const fixture = 'jpeg-uhdr-apple.jpg';
  await p.load([fixture]);
  const rows = await rowsOf(p);
  const row = (id) => rows.find((r) => r.id === id);
  check('apple: the gain map is amber and starts unticked', row('jpeg:trailing:gain-map') && row('jpeg:trailing:gain-map').tier === 'amber' && !row('jpeg:trailing:gain-map').checked, row('jpeg:trailing:gain-map') || rows.map((r) => r.id));
  check('apple: the HDR brightness is amber and starts unticked', row('exif:apple-hdr') && row('exif:apple-hdr').tier === 'amber' && !row('exif:apple-hdr').checked, row('exif:apple-hdr') || rows.map((r) => r.id));
  check('apple: the rest of the maker notes is red and ticked', row('exif:makernote') && row('exif:makernote').tier === 'red' && row('exif:makernote').checked, row('exif:makernote'));
  const preview = await p.ev("document.getElementById('name-preview').textContent");
  check('apple: the expected name uses the public word', /Expected name: image\.public\.jpg\./.test(preview), preview);
  const keep = ['jpeg:trailing:gain-map', 'exif:apple-hdr'];
  // The starting selection (red only): the gain map, the HDR brightness and the camera
  // (amber) stay; the rest of the maker notes goes.
  await p.press();
  const first = await p.download();
  check('apple: the starting selection gives image.public.jpg', first.length === 1 && first[0].name === 'image.public.jpg', first.map((f) => f.name));
  if (first[0]) {
    const v0 = await verifyDownload(p, first[0], { fixture, removed: ['red'], lossless: true, word: 'public' });
    const left0 = v0.back.items.filter((i) => i.tier !== 'green').map((i) => i.id).sort();
    check('apple: with the starting selection the gain map, the HDR brightness and the camera stay, nothing red', J(left0) === J([...keep, 'exif:camera'].sort()), left0);
    check('apple: and the photo keeps the two HDR numbers', v0.ex['Apple:HDRHeadroom'] !== undefined && v0.ex['Apple:HDRGain'] !== undefined, Object.keys(v0.ex).filter((k) => /^Apple:/.test(k)), 'engine');
  }
  // Amber ticked too, the gain map and the HDR brightness unticked.
  await setTiers(p, { red: true, amber: true });
  for (const id of keep) await p.ev(`document.querySelector('#meta-groups .ms-check[data-id="${id}"]').click()`);
  await p.press();
  const files = await p.download();
  check('apple: amber ticked, gain map kept: one file downloaded, named image.public.jpg', files.length === 1 && files[0].name === 'image.public.jpg', files.map((f) => f.name));
  if (!files[0]) return;
  const v = await verifyDownload(p, files[0], { fixture, removed: ['red', 'amber'], keep, lossless: true, word: 'public' });
  const left = v.back.items.filter((i) => i.tier !== 'green').map((i) => i.id).sort();
  check('apple: only the gain map and the HDR brightness stay of red and amber', J(left) === J([...keep].sort()), left);
  const noteText = await p.ev("(document.querySelector('#results-list .ms-word-note') || {}).textContent || ''");
  check('apple: the result says why the word is public', noteText === GAIN_NOTE, noteText);
  check('apple: the photo keeps the two HDR numbers Chrome and Apple read', v.ex['Apple:HDRHeadroom'] !== undefined && v.ex['Apple:HDRGain'] !== undefined, Object.keys(v.ex).filter((k) => /^Apple:/.test(k)), 'engine');
  check('apple: and nothing else from the maker notes', Object.keys(v.ex).filter((k) => /^Apple:/.test(k)).every((k) => /HDRHeadroom|HDRGain$/.test(k)), Object.keys(v.ex).filter((k) => /^Apple:/.test(k)), 'engine');
  const gm = spawnSync('exiftool', ['-b', '-MPImage2', v.path], { maxBuffer: 16 * 1024 * 1024 }).stdout;
  const orig = spawnSync('exiftool', ['-b', '-MPImage2', join(FIX, fixture)], { maxBuffer: 16 * 1024 * 1024 }).stdout;
  const gmFile = join(CHECKS, 'hdr-apple-gainmap-out.jpg');
  const origFile = join(CHECKS, 'hdr-apple-gainmap-orig.jpg');
  writeFileSync(gmFile, gm);
  writeFileSync(origFile, orig);
  check('apple: the kept gain map is a whole JPEG found through MPF', gm.length > 100 && gm[0] === 0xff && gm[1] === 0xd8 && gm[gm.length - 2] === 0xff && gm[gm.length - 1] === 0xd9, gm.length, 'engine');
  let px = null;
  try { px = py(SAME_PIXELS_PY, origFile, gmFile); } catch (e) { px = { error: String(e.message).slice(0, 200) }; }
  check('apple: the kept gain map has the same pixels (Pillow)', px && px.same, px, 'engine');
  const gk = exiftoolKeys(gmFile);
  const xmp = Object.keys(gk).filter((k) => /^XMP-/.test(k)).sort();
  check('apple: the gain map keeps HDRGainMapVersion and the apdi label, and nothing else in XMP', J(xmp) === J(['XMP-HDRGainMap:HDRGainMapVersion', 'XMP-apdi:AuxiliaryImageType']) && gk['XMP-apdi:AuxiliaryImageType'] === 'urn:com:apple:photo:2020:aux:hdrgainmap', { xmp, type: gk['XMP-apdi:AuxiliaryImageType'] }, 'engine');
});

// Free text in green details: names in a colour profile and in technical XMP fields are red
// and ticked; the colour profile and the numbers stay, and the colours do not change.
flow('green-text', DESKTOP, async (p) => {
  await p.load(['jpeg-icc-text.jpg', 'jpeg-green-xmp.jpg']);
  const rows = await rowsOf(p);
  const row = (id) => rows.find((r) => r.id === id);
  // The group word shows only in a section that mixes kinds; here every red detail is hidden.
  check('green text: the text inside the colour profile is red and ticked', row('icc:text') && row('icc:text').tier === 'red' && row('icc:text').checked && ['', 'Hidden extras'].includes(row('icc:text').group), row('icc:text') || rows.map((r) => r.id));
  check('green text: the colour profile itself is green and unticked', row('icc:profile') && row('icc:profile').tier === 'green' && !row('icc:profile').checked, row('icc:profile'));
  check('green text: unexpected text in technical XMP fields is red and ticked', row('xmp:technical-text') && row('xmp:technical-text').tier === 'red' && row('xmp:technical-text').checked, row('xmp:technical-text') || rows.map((r) => r.id));
  check('green text: the technical XMP fields that hold numbers stay green and unticked', row('xmp:technical') && row('xmp:technical').tier === 'green' && !row('xmp:technical').checked, row('xmp:technical'));
  await p.press();
  const files = await p.download();
  const names = files.map((f) => f.name).sort();
  check('green text: both files are minimal', J(names) === J(['image-1.minimal.jpg', 'image-2.minimal.jpg']), names);
  for (const f of files) {
    const fixture = f.name.startsWith('image-1') ? 'jpeg-icc-text.jpg' : 'jpeg-green-xmp.jpg';
    const v = await verifyDownload(p, f, { fixture, index: f.name.startsWith('image-1') ? 1 : 2, removed: ['red', 'amber'], lossless: true, word: 'minimal' });
    if (fixture === 'jpeg-icc-text.jpg') {
      check('green text: the colour profile stays and still opens', !!v.ex['ICC_Profile:ProfileDescription'] && v.back.items.some((i) => i.id === 'icc:profile'), Object.keys(v.ex).filter((k) => /ICC/.test(k)), 'engine');
      const a = spawnSync('exiftool', ['-b', '-ICC_Profile', join(FIX, fixture)], { maxBuffer: 1 << 24 }).stdout;
      const b = spawnSync('exiftool', ['-b', '-ICC_Profile', v.path], { maxBuffer: 1 << 24 }).stdout;
      const tags = (x) => { const o = {}; for (let i = 0; i < x.readUInt32BE(128); i++) { const e = 132 + i * 12; const off = x.readUInt32BE(e + 4); const len = x.readUInt32BE(e + 8); o[x.toString('latin1', e, e + 4)] = x.subarray(off, off + len).toString('hex'); } return o; };
      const ta = tags(a);
      const tb = tags(b);
      const changed = Object.keys(ta).filter((k) => /^(rXYZ|gXYZ|bXYZ|rTRC|gTRC|bTRC|wtpt|chad|chrm|A2B0|B2A0)$/.test(k) && ta[k] !== tb[k]);
      check('green text: every colour tag of the profile is byte for byte the same', a.length === b.length && !changed.length, { sizes: [a.length, b.length], changed }, 'engine');
    } else {
      const raw = readFileSync(v.path).toString('utf8');
      check('green text: the numbers in technical XMP fields stay', /photoshop:ColorMode="3"/.test(raw) && /GPano:PoseHeadingDegrees="12.5"/.test(raw), null, 'engine');
    }
  }
});

// The default result loaded again: nothing is red, amber (the gain map with it) stays
// unticked, so nothing would change and the page says so instead of making a copy.
flow('hdr-again', DESKTOP, async (p) => {
  await p.load(['jpeg-ultrahdr-like.jpg']);
  await p.press();
  const files = await p.download();
  check('first pass: image.public.jpg', files.length === 1 && files[0].name === 'image.public.jpg', files.map((f) => f.name));
  if (!files[0]) return;
  const again = join(CHECKS, 'hdr-again.jpg');
  writeFileSync(again, files[0].bytes);
  await p.click('#reset-btn');
  await p.load([again]);
  const ticked = await tickedIds(p);
  check('loaded again, nothing is ticked', ticked.length === 0, ticked);
  const said = await p.ev("document.getElementById('announcer').textContent");
  check('the announcement says nothing is ticked, as nothing is red', /None of them is red, so nothing is ticked\.$/.test(said), said);
  const r = await pressExpectingNothing(p);
  check('pressing the button makes no copy and says there is nothing to change', r.links === 0 && /^Nothing to change yet/.test(r.text), r);
});

// Cropping re-saves the picture, and a re-saved picture cannot carry a gain map: the result
// says so, because the gain map was kept.
flow('hdr-crop', DESKTOP, async (p) => {
  await p.load(['jpeg-ultrahdr-like.jpg']);
  await p.click('label[for="crop-toggle"]');
  await p.click('#crop-ratios [data-ratio="1:1"]');
  await p.press();
  const files = await p.download();
  check('one file downloaded', files.length === 1, files.map((f) => f.name));
  if (files[0]) {
    const v = await verifyDownload(p, files[0], { fixture: 'jpeg-ultrahdr-like.jpg', removed: ['red'], lossless: false, expectFormat: 'jpeg' });
    check('the cropped file has no gain map', !v.back.items.some((i) => /gain|mpf/.test(i.id)), v.back.items.map((i) => i.id), 'engine');
    const lostNote = await p.ev("[...document.querySelectorAll('#results-list .ms-note')].map(n => n.textContent).find(t => /left them out/.test(t)) || ''");
    check('the result says re-saving left out the HDR gain map', /left them out: .*HDR gain map/.test(lostNote), lostNote);
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

  // The tier sections work across both files: one tick box for a tier ticks it in both.
  const a = await inspect(new Uint8Array(readFileSync(join(FIX, 'jpeg-everything.jpg'))));
  const b = await inspect(new Uint8Array(readFileSync(join(FIX, 'webp-everything.webp'))));
  const amberIds = [...new Set([...a.items, ...b.items].filter((i) => i.tier === 'amber').map((i) => i.id))];
  let ts = await tierState(p);
  check('two files: the sections are red, amber and green, all closed, only red ticked', J(Object.keys(ts)) === J(['red', 'amber', 'green']) && allClosed(ts) && ts.red.checked && !ts.amber.checked && !ts.green.checked, ts);
  check(`two files: amber counts the details of both files once each (${amberIds.length})`, ts.amber.n === amberIds.length, ts.amber);
  await p.click('#m-tier-amber-all');
  ts = await tierState(p);
  check('two files: the amber tick box ticks amber in both, from a closed section', ts.amber.checked && ts.amber.ticked === ts.amber.n && ts.amber.expanded === 'false', ts.amber);
  await p.press();
  const both = await p.download();
  check('two files with red and amber ticked: two files, each with the minimal word', both.length === 2 && both.every((f) => /\.minimal\./.test(f.name)), both.map((f) => f.name));
  for (const f of both) {
    const fixture = f.name.endsWith('.jpg') ? 'jpeg-everything.jpg' : 'webp-everything.webp';
    await verifyDownload(p, f, { fixture, index: f.name.startsWith('image-1') ? 1 : 2, removed: ['red', 'amber'], lossless: true, word: 'minimal' });
  }
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
  await p.press();
  const files = await p.download();
  check('offline: the file is still made and downloaded', files.length === 1 && files[0].name === 'image.public.jpg', files.map((f) => f.name));
  if (files[0]) await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: true, word: 'public' });
  const tried = record.requests.slice(mark).filter((r) => r.flow === 'offline' && /^https?:/.test(r.url));
  check('offline: the page did not even try the network', !tried.length, tried.map((r) => r.url));
  await p.s('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
});

flow('phone', PHONE, async (p) => {
  check('the first-run gate appears on a phone and closes with a tap', p.gateSeen);
  await textCheck(p, 'empty page');
  await p.layout('empty page');
  await checkAppSectionShown(p);
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
  // The tier sections by finger: the arrows open and close, the tick box ticks a tier.
  await p.click('#m-tier-amber-toggle');
  await p.click('#m-tier-green-toggle');
  let tiers = await tierState(p);
  check('phone: a tap on the amber and green arrows opens both', tiers.amber.expanded === 'true' && tiers.amber.visible && tiers.green.expanded === 'true' && tiers.green.visible, tiers);
  await p.layout('all tier sections open');
  await p.shot('2-tiers-all-open', { selector: '#meta-card' });
  await p.click('#m-tier-amber-all');
  tiers = await tierState(p);
  check('phone: a tap on the amber tick box ticks every amber detail', tiers.amber.checked && tiers.amber.ticked === tiers.amber.n, tiers.amber);
  await p.click('#m-tier-amber-all');
  await p.click('#m-tier-amber-toggle');
  await p.click('#m-tier-green-toggle');
  tiers = await tierState(p);
  check('phone: and taps close them again, back to only red ticked', allClosed(tiers) && tiers.red.checked && !tiers.amber.checked && !tiers.amber.mixed && !tiers.green.checked, tiers);
  const sizes = await p.ev(`(() => {
    const small = [];
    for (const el of document.querySelectorAll('#workspace button, #workspace input, #workspace select, #workspace label.ms-item')) {
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

// Share and Copy under Save, tapped by finger on a phone with a share sheet.
flow('share', SHARE_PHONE, async (p) => {
  await p.load(['jpeg-everything.jpg']);
  await p.press();
  let st = await p.ev(SHARE_STATE);
  check(`share: "${SHARE_TEXT.button}" and Copy image under Save, in a data-web-only block`, st.webOnly && st.shareShown && st.shareText === SHARE_TEXT.button && st.copyShown && st.copyText === 'Copy image', st);
  check('share: Share is a primary button, the same colour as Save', st.primary, { shareBg: st.shareBg, saveBg: st.saveBg });
  check(`share: the warning "${SHARE_TEXT.note}" is shown, amber, and Share points to it`, st.note && st.noteShown && st.noteText === SHARE_TEXT.note && st.noteAmber && st.noteOwnsDescription, st);
  check('share: the order is Save, Copy, Share, the warning, then the status line', st.order.join() === 'save,copy,share,note,status', st.order);
  check('share: no confirm step (no Continue, no Cancel) and nothing shared before a tap', !st.confirm && st.expanded === null && st.shares === 0 && st.copies === 0, st);
  const sizes = await p.ev("[...document.querySelectorAll('#results-list .ms-share button')].filter((b) => b.getClientRects().length).map((b) => Math.round(b.getBoundingClientRect().height))");
  check('share: Share and Copy are at least 44 px tall', sizes.length === 2 && sizes.every((h) => h >= 44), sizes);
  await textCheck(p, 'result with Share and Copy');
  await p.layout('result with Share and Copy');
  await p.shot('5-share-buttons', { selector: '#results .ms-result-main' });

  // A tap shares straight away: the share sheet gets exactly the file Save downloads.
  await p.click('#results-list .ms-share-btn');
  await p.waitFor('window.__share.calls.length === 1 && window.__share.calls[0].b64 !== null', 10000, 'the share call');
  const call = await p.ev('window.__share.calls[0]');
  check('share: a tap shares one file, image.public.jpg, image/jpeg, titled with its name', call.n === 1 && call.name === 'image.public.jpg' && call.type === 'image/jpeg' && call.title === 'image.public.jpg', { ...call, b64: undefined });
  const files = await p.download();
  const saved = files.find((f) => f.name === 'image.public.jpg');
  const shared = new Uint8Array(Buffer.from(call.b64, 'base64'));
  check('share: the shared bytes are exactly the bytes Save downloads', !!saved && Buffer.compare(Buffer.from(saved.bytes), Buffer.from(shared)) === 0, { saved: saved && saved.bytes.length, shared: shared.length });
  if (saved) await verifyDownload(p, { ...saved, name: 'image.public.jpg' }, { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: true, word: 'public' });
  st = await p.ev(SHARE_STATE);
  check('share: after sharing nothing is said, and the warning is still there', st.status === '' && st.noteShown && st.noteText === SHARE_TEXT.note, st);

  // Every tap shares at once; a closed share sheet says nothing; a failure says so.
  await p.click('#results-list .ms-share-btn');
  await p.waitFor('window.__share.calls.length === 2', 10000, 'the second share call');
  st = await p.ev(SHARE_STATE);
  check('share: the second tap shares at once too', !st.confirm && st.shares === 2, st);
  await p.ev("window.__share.mode = 'abort'");
  await p.click('#results-list .ms-share-btn');
  await p.waitFor('window.__share.calls.length === 3', 10000, 'the third share call');
  await sleep(200);
  check('share: a closed share sheet (AbortError) says nothing', (await p.ev(SHARE_STATE)).status === '');
  await p.ev("window.__share.mode = 'fail'");
  await p.click('#results-list .ms-share-btn');
  await p.waitFor("document.querySelector('#results-list .ms-share-status').textContent !== ''", 10000, 'the failure message');
  check(`share: another failure says "${SHARE_TEXT.failed}"`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.failed);
  await p.ev("window.__share.mode = 'ok'");
  await textCheck(p, 'share failure');
  await p.layout('share failure');

  // Copy: a fresh PNG with the picture only.
  await p.click('#results-list .ms-copy-btn');
  await p.waitFor('window.__clip.calls.length === 1 && window.__clip.calls[0].b64 !== null', 20000, 'the copy');
  await p.waitFor(`document.querySelector('#results-list .ms-share-status').textContent === ${J(SHARE_TEXT.copied)}`, 5000, 'the copy message');
  const clip = await p.ev('window.__clip.calls[0]');
  const png = await inspect(new Uint8Array(Buffer.from(clip.b64, 'base64')));
  const src = saved ? await inspect(saved.bytes) : null;
  check('share: Copy puts a PNG with no metadata at all on the clipboard, at the picture\'s size', clip.type === 'image/png' && png.format === 'png' && png.items.length === 0 && !!src && png.width === src.width && png.height === src.height, { type: clip.type, format: png.format, items: png.items.map((i) => i.id), size: [png.width, png.height] });
  await textCheck(p, 'after copy');
  await p.layout('after copy');
  await p.shot('5-copied', { selector: '#results .ms-result-main' });
});

// Real Chromium, no stand-ins: Share follows navigator.canShare, Copy follows ClipboardItem,
// and with clipboard permission granted, Copy really puts a clean PNG on the clipboard.
flow('share-native', DESKTOP, async (p) => {
  await p.load(['jpeg-everything.jpg']);
  await p.press();
  const can = await p.ev("({ share: typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([new Uint8Array([255, 216, 255])], 'x.jpg', { type: 'image/jpeg' })] }), copy: !!navigator.clipboard && typeof ClipboardItem === 'function' })");
  const st = await p.ev(SHARE_STATE);
  check(`share-native: Share is shown exactly when navigator.canShare accepts the file (here ${can.share ? 'yes' : 'no'})`, st.shareShown === can.share && st.share === can.share, { can, st });
  check(`share-native: the warning is shown exactly when Share is (here ${can.share ? 'yes' : 'no'})`, st.noteShown === can.share && st.note === can.share && (!can.share || st.noteText === SHARE_TEXT.note), { can, st });
  check(`share-native: Copy is shown exactly when ClipboardItem exists (here ${can.copy ? 'yes' : 'no'})`, st.copyShown === can.copy, { can, st });
  if (!can.copy) return;
  const granted = await send('Browser.grantPermissions', { origin: ORIGIN, browserContextId: p.browserContextId, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).then(() => true, () => false);
  if (!granted) { note('share-native: clipboard permission could not be granted; real copy not checked'); return; }
  await p.ev('window.focus()');
  await p.click('#results-list .ms-copy-btn');
  await p.waitFor("document.querySelector('#results-list .ms-share-status').textContent !== ''", 20000, 'the copy message');
  const status = (await p.ev(SHARE_STATE)).status;
  if (status !== SHARE_TEXT.copied) { note('share-native: headless Chromium refused the real clipboard write', status); return; }
  const back = await p.ev(`(async () => {
    const items = await navigator.clipboard.read();
    const blob = await items[0].getType('image/png');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  })()`).catch((err) => ({ err: String(err.message || err) }));
  if (back && back.err) { note('share-native: the clipboard could not be read back', back.err); return; }
  const out = await inspect(new Uint8Array(Buffer.from(back, 'base64')));
  check('share-native: the real clipboard holds a PNG with no metadata', out.format === 'png' && out.items.length === 0, { format: out.format, items: out.items.map((i) => i.id) });
});

// Neither API: no Share, no Copy, and Save as before.
flow('share-absent', NO_SHARE, async (p) => {
  await p.load(['jpeg-everything.jpg']);
  await p.press();
  const st = await p.ev(SHARE_STATE);
  check('share-absent: without canShare and ClipboardItem there is no Share, no Copy, no warning and no empty block', !st.block && !st.share && !st.copy && !st.note, st);
  check('share-absent: Save image.public.jpg is still there', await p.ev("document.querySelector('#results-list .ms-download')?.textContent") === 'Save image.public.jpg');
});

// The page as the Android app loads it: index.html with the bridge line, android-bridge.js
// served beside it. A plain browser has no window.MSBridge, so the bridge's message channel
// stays off and Save downloads as on the website; hiding the website-only parts must still
// happen, because it depends only on the bridge file being loaded.
const ANDROID_FLOW = 'android-app';
flow(ANDROID_FLOW, ANDROID, async (p) => {
  check('android: the page came with the bridge line added, as the APK serves it', p.androidInjected === true);
  check('android: the first-run gate still appears and closes with a tap', p.gateSeen);
  const app = await appSection(p);
  check('android: the bridge loads before every other script', !!app && app.firstScript === BRIDGE_FILE, app);
  check('android: no message channel in a plain browser (window.MSBridge is absent)', await p.ev("typeof window.MSBridge === 'undefined'"));
  check('android: the bridge hides the Android app section (hidden, not displayed, takes no space)', !!app && app.hidden && app.display === 'none' && app.height === 0 && app.linkHeight === 0, app);
  await textCheck(p, 'empty page');
  await p.layout('empty page');
  await p.shot('0-android-app-bottom', { bottomFrom: 'main > .ms-limits' });
  await p.ev("scrollTo({ top: 0, behavior: 'instant' })");
  // The page otherwise works as on the website.
  await p.load(['jpeg-everything.jpg']);
  const n = await p.ev("document.querySelectorAll('#meta-groups .ms-check').length");
  check('android: the picture loads and its details are listed', n > 0, n);
  let cn = await colourNote(p);
  check('android: the colour note is hidden with the default choice', cn.hidden, cn);
  await setTiers(p, { red: true, green: true });
  cn = await colourNote(p);
  check('android: the colour note shows in the app too when Green is ticked', !cn.hidden && cn.shown && cn.text === COLOUR_NOTE, cn);
  await setTiers(p, { red: true });
  cn = await colourNote(p);
  check('android: and hides again when Green is unticked', cn.hidden, cn);
  await p.press();
  const files = await p.download();
  check('android: Save gives image.public.jpg', files.length === 1 && files[0].name === 'image.public.jpg', files.map((f) => f.name));
  if (files[0]) await verifyDownload(p, files[0], { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: true, word: 'public' });
  await p.layout('result');
  const share = await p.ev(SHARE_STATE);
  check('android: Share, Copy and the warning are made but the bridge hides them, though the browser could share and copy', share.block && share.webOnly && !share.blockShown && !share.shareShown && !share.copyShown && share.note && !share.noteShown, share);
  check('android: the section stays hidden after a result', await p.ev("document.getElementById('android-app').hidden && document.getElementById('android-app').getBoundingClientRect().height === 0"));
});

// The app (1.0.1) with its message channel: the website's Save, Copy and Share, tapped by
// finger, each handed to the app by the bridge (window.MSAndroid) with what to do with it.
const ANDROID_APP_FLOW = 'android-app-bridge';
flow(ANDROID_APP_FLOW, ANDROID_APP, async (p) => {
  check('android-app: the page came with the bridge line added, as the APK serves it', p.androidInjected === true);
  check('android-app: the bridge adds window.MSAndroid (share and copyImage) on top of the channel', await p.ev("!!window.MSAndroid && Object.isFrozen(window.MSAndroid) && Object.keys(window.MSAndroid).sort().join() === 'copyImage,share'"));
  check('android-app: the Zapstore section is still hidden', await p.ev("document.getElementById('android-app').hidden && document.getElementById('android-app').getBoundingClientRect().height === 0"));
  await p.load(['jpeg-everything.jpg']);
  await p.press();
  let st = await p.ev(SHARE_STATE);
  check(`android-app: Copy image, "${SHARE_TEXT.button}" and the warning show under Save, not marked data-web-only`, st.block && !st.webOnly && st.blockShown && st.copyShown && st.shareShown && st.noteShown && st.order.join() === 'save,copy,share,note,status', st);
  check('android-app: Share is pink like Save; the warning is amber, with the exact text, and Share points to it', st.primary && st.noteAmber && st.noteText === SHARE_TEXT.note && st.noteOwnsDescription, st);
  const sizes = await p.ev("[...document.querySelectorAll('#results-list .ms-share button')].filter((b) => b.getClientRects().length).map((b) => Math.round(b.getBoundingClientRect().height))");
  check('android-app: Share and Copy are at least 44 px tall', sizes.length === 2 && sizes.every((h) => h >= 44), sizes);
  await textCheck(p, 'app result with Save, Copy and Share');
  await p.layout('app result with Save, Copy and Share');
  await p.shot('6-app-buttons', { selector: '#results .ms-result-main' });

  // Save: the app gets a save, and only a save.
  await p.click('#results-list .ms-download');
  await p.waitFor('window.__ms.files.length === 1', 10000, 'the save hand-over');
  const saved = await p.ev('window.__ms.files[0]');
  const savedBytes = appFileBytes(saved);
  check('android-app: Save hands the app image.public.jpg as a save, and nothing else (no share option in the Save path)', saved.action === 'save' && saved.name === 'image.public.jpg' && saved.mime === 'image/jpeg' && savedBytes.length === saved.size && (await p.ev("window.__ms.posted.filter((m) => m.t === 'out-begin').map((m) => m.action).join()")) === 'save', { ...saved, parts: saved.parts.length });
  await verifyDownload(p, { name: 'image.public.jpg', url: await p.ev("document.querySelector('#results-list .ms-download').href"), bytes: new Uint8Array(savedBytes) }, { fixture: 'jpeg-everything.jpg', removed: ['red'], lossless: true, word: 'public' });

  // Share: exactly the saved bytes and name, on the first tap.
  await p.click('#results-list .ms-share-btn');
  await p.waitFor('window.__ms.files.length === 2', 10000, 'the share hand-over');
  const shared = await p.ev('window.__ms.files[1]');
  const sharedBytes = appFileBytes(shared);
  check('android-app: a tap on Share hands the app image.public.jpg to share, at once', shared.action === 'share' && shared.name === 'image.public.jpg' && shared.mime === 'image/jpeg', { ...shared, parts: shared.parts.length });
  check('android-app: the shared bytes are exactly the saved bytes', Buffer.compare(savedBytes, sharedBytes) === 0, { saved: savedBytes.length, shared: sharedBytes.length });
  await sleep(200);
  st = await p.ev(SHARE_STATE);
  check('android-app: after sharing nothing is said, and the warning is still there', st.status === '' && st.noteShown, st);

  // Copy: a fresh PNG without file details, image.png.
  await p.click('#results-list .ms-copy-btn');
  await p.waitFor('window.__ms.files.length === 3', 20000, 'the copy hand-over');
  await p.waitFor(`document.querySelector('#results-list .ms-share-status').textContent === ${J(SHARE_TEXT.copiedApp)}`, 5000, 'the copy message');
  check(`android-app: the line after Copy is the app's own, "${SHARE_TEXT.copiedApp}"`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.copiedApp);
  const copied = await p.ev('window.__ms.files[2]');
  const png = await inspect(new Uint8Array(appFileBytes(copied)));
  const src = await inspect(new Uint8Array(savedBytes));
  check('android-app: Copy hands the app image.png, a PNG with no metadata at all, at the picture\'s size', copied.action === 'copy' && copied.name === 'image.png' && copied.mime === 'image/png' && png.format === 'png' && png.items.length === 0 && png.width === src.width && png.height === src.height, { action: copied.action, name: copied.name, items: png.items.map((i) => i.id), size: [png.width, png.height] });
  await textCheck(p, 'app after copy');
  await p.layout('app after copy');
  await p.shot('6-app-copied', { selector: '#results .ms-result-main' });

  // The copy's end, by finger, with the stand-in's time left shortened from 2 minutes.
  const isLine = (t) => `document.querySelector('#results-list .ms-share-status').textContent === ${J(t)}`;
  await p.ev("window.__ms.copyLife = 1500; document.querySelector('#results-list .ms-share-status').textContent = ''");
  await p.click('#results-list .ms-copy-btn');
  await p.waitFor(isLine(SHARE_TEXT.copiedApp), 20000, 'the copy line');
  check(`android-app: when the copy's time is up, the line becomes "${SHARE_TEXT.copyExpiredApp}"`, await p.waitFor(isLine(SHARE_TEXT.copyExpiredApp), 10000, 'the expired line'));
  const live = await p.ev(SHARE_STATE);
  check('android-app: the expired line is in the polite live region', live.live === 'polite' && live.status === SHARE_TEXT.copyExpiredApp, live);
  await textCheck(p, 'app copy expired');
  await p.layout('app copy expired');
  await p.shot('6-app-copy-expired', { selector: '#results .ms-result-main' });
  await p.ev("window.__ms.copyLife = 120000; document.querySelector('#results-list .ms-share-status').textContent = ''");
  await p.click('#results-list .ms-copy-btn');
  await p.waitFor(isLine(SHARE_TEXT.copiedApp), 20000, 'the copy line again');
  await p.ev(SKIP_CLOCK(121000));
  await sleep(200);
  check('android-app: back after 2 minutes away (timers frozen), the line already reads as expired', (await p.ev(SHARE_STATE)).status === SHARE_TEXT.copyExpiredApp);
  await p.ev('window.__ms.copyLife = 120000');

  // When the app reports a failure, the page says so.
  await p.ev("window.__ms.mode = 'fail'");
  await p.click('#results-list .ms-share-btn');
  await p.waitFor(`document.querySelector('#results-list .ms-share-status').textContent === ${J(SHARE_TEXT.failed)}`, 10000, 'the share failure');
  check(`android-app: a share the app could not do says "${SHARE_TEXT.failed}"`, (await p.ev(SHARE_STATE)).status === SHARE_TEXT.failed);
  await p.ev("window.__ms.mode = 'ok'");
  check('android-app: a tap on Save never makes the browser download (the app saves)', (await p.download()).length === 0);
  // Start again clears the line, and a late end of the copy does not bring it back.
  await p.ev("window.__ms.copyLife = 800");
  await p.click('#results-list .ms-copy-btn');
  await p.waitFor(isLine(SHARE_TEXT.copiedApp), 20000, 'the copy line, third time');
  await p.click('#reset-btn');
  await sleep(1500);
  const cleared = await p.ev(`({ lines: document.querySelectorAll('#results-list .ms-share-status').length, results: document.getElementById('results').hidden, expired: document.body.innerText.includes(${J(SHARE_TEXT.copyExpiredApp)}) })`);
  check('android-app: Start again clears the line, and the copy ending later brings nothing back', cleared.lines === 0 && cleared.results && !cleared.expired, cleared);
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
// android-bridge.js is not a website file; the harness serves it in the android flow only.
const bridgeLoad = (r) => (r.flow === ANDROID_FLOW || r.flow === ANDROID_APP_FLOW) && new URL(r.url).pathname === `/${BRIDGE_FILE}`;
const servedOk = (r) => published(r.url) || bridgeLoad(r);
const offsite = web.filter((r) => new URL(r.url).origin !== ORIGIN);
check('no request to any other origin, at any time', !offsite.length, offsite.map((r) => `${r.flow}: ${r.url}`));
const after = web.filter((r) => r.phase === 'after-load');
const afterBad = after.filter((r) => !servedOk(r));
check(`after load, only the page's own files are requested (${after.length} requests after load)`, !afterBad.length, afterBad.map((r) => `${r.flow}: ${r.type} ${r.url}`));
if (after.length) note('requests after load', [...new Set(after.map((r) => `${r.type} ${new URL(r.url).pathname}`))]);
const fetches = record.requests.filter((r) => r.type === 'Fetch' || r.type === 'XHR' || r.type === 'EventSource' || r.type === 'WebSocket' || r.type === 'Ping');
check('no fetch, XHR, beacon or socket of anything, data: URLs included', !fetches.length, fetches.map((r) => `${r.flow}: ${r.type} ${r.url.slice(0, 80)}`));
const loadSet = [...new Set(web.filter((r) => r.phase === 'loading' && !bridgeLoad(r)).map((r) => new URL(r.url).pathname))].sort();
note('files a visitor loads', loadSet);
check('every file the page loads is one GitHub Pages publishes (android-bridge.js only in the android flow)', web.every(servedOk), web.filter((r) => !servedOk(r)).map((r) => `${r.flow}: ${r.url}`));
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
