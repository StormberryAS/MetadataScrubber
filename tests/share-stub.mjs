// Stand-ins for the Web Share API and the async clipboard, for the browser tests
// (tests/ui-smoke.mjs and tests/e2e.mjs). Desktop Chromium on Linux has no share sheet,
// and a headless browser has no clipboard a test can read, so the tests replace both
// before the page loads and record what the page hands them. Nothing is sent anywhere:
// the stand-ins only keep the bytes in the page for the test to read back.
//
//   shareStub({ share: true, clipboard: true })  returns the source for
//   Page.addScriptToEvaluateOnNewDocument.
//
// share: true      navigator.canShare says yes to JPEG, PNG and WebP files (as Chrome on
//                  Android does; HEIC is not on its list), navigator.share records each
//                  call with the file's bytes in base64, then resolves, or rejects when
//                  window.__share.mode is 'abort' (AbortError) or 'fail' (DataError).
// share: false     navigator.canShare and navigator.share do not exist.
// clipboard: true  Clipboard.prototype.write records the PNG it is given, in base64, and
//                  resolves, or rejects when window.__clip.mode is 'fail'.
// clipboard: false ClipboardItem does not exist, as in browsers without image copy.
//
// The names the stand-ins create: window.__share = { mode, calls: [{ title, n, name, type,
// b64 }] } and window.__clip = { mode, calls: [{ types, type, b64 }] }.

export function shareStub({ share = true, clipboard = true } = {}) {
  return `(() => {
  const b64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  window.__share = { mode: 'ok', calls: [] };
  window.__clip = { mode: 'ok', calls: [] };
  if (${share ? 'true' : 'false'}) {
    Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, writable: true, value: function (d) {
      return !!d && Array.isArray(d.files) && d.files.length > 0 && d.files.every((f) => f instanceof File && /^image\\/(jpeg|png|webp)$/.test(f.type));
    } });
    Object.defineProperty(Navigator.prototype, 'share', { configurable: true, writable: true, value: async function (d) {
      const files = (d && d.files) || [];
      const call = { title: d && d.title, n: files.length, name: files[0] && files[0].name, type: files[0] && files[0].type, b64: null };
      window.__share.calls.push(call);
      if (files[0]) call.b64 = b64(await files[0].arrayBuffer());
      if (window.__share.mode === 'abort') throw new DOMException('Share canceled', 'AbortError');
      if (window.__share.mode === 'fail') throw new DOMException('Share failed', 'DataError');
    } });
  } else {
    delete Navigator.prototype.canShare;
    delete Navigator.prototype.share;
  }
  if (${clipboard ? 'true' : 'false'}) {
    Clipboard.prototype.write = async function (items) {
      const call = { types: items.map((it) => it.types.join(',')), type: null, b64: null };
      window.__clip.calls.push(call);
      if (window.__clip.mode === 'fail') throw new DOMException('Write blocked', 'NotAllowedError');
      const blob = await items[0].getType('image/png');
      call.type = blob.type;
      call.b64 = b64(await blob.arrayBuffer());
    };
  } else {
    delete window.ClipboardItem;
  }
})();`;
}

// The page's own words, so both tests check the same text.
export const SHARE_TEXT = {
  button: 'Share the new image',
  note: 'Once it is online, you cannot take it back. Your device will open the app you choose.',
  failed: 'The file could not be shared. Save it and share it from your device instead.',
  copied: 'Copied. The image is on your clipboard without its file details. Once you paste it online, you cannot take it back.',
  // The Android app's own line after Copy (1.0.1): the copy expires after 2 minutes there.
  copiedApp: 'Copied. You can paste it for the next 2 minutes.',
  // ... and in its place once the app's copy has ended (2 minutes, or a newer Copy).
  copyExpiredApp: 'The copy has expired. Tap Copy image again to paste it.',
  copyFailed: 'The image could not be copied. Save it instead.',
};

// Take a photo (1.1.0): the page's own words, so both tests check the same text.
export const CAMERA_TEXT = {
  button: 'Take a photo',
  note: 'Taken in MetadataScrubber: made without a location or device details.',
  done: 'Photo taken. No metadata in it. It is ready to save or share.',
  // Above that photo's result, and when Prepare picture is pressed with nothing changed.
  idle: 'This photo is already your new file, below. To make another version, crop, resize or change the format first.',
  // The Android app section at the foot of the website.
  appLine: 'Android app: the same tool on your phone, with no internet. Share a photo into it straight from your gallery, or take one with its camera.',
};

// A snapshot of Take a photo and of the first result, for page.evaluate.
export const CAMERA_STATE = `(() => {
  const vis = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
  const btn = document.getElementById('camera-btn');
  const choose = document.getElementById('choose-btn');
  const input = document.getElementById('camera-input');
  const result = document.querySelector('#results-list .ms-result');
  const notes = result ? [...result.querySelectorAll('.ms-camera-note')] : [];
  const lines = document.body.innerText.split('Taken in MetadataScrubber').length - 1;
  return {
    button: !!btn, shown: vis(btn), text: btn && btn.textContent, secondary: !!btn && btn.matches('.btn.btn-secondary'),
    app: !!btn && btn.hasAttribute('data-app'), webOnly: !!btn && btn.hasAttribute('data-web-only'), disabled: !!btn && btn.disabled,
    afterChoose: !!btn && choose.nextElementSibling === btn, row: btn && btn.parentElement.id, height: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
    input: !!input && { accept: input.getAttribute('accept'), capture: input.getAttribute('capture'), hidden: input.hidden, multiple: input.multiple },
    workspace: !document.getElementById('workspace').hidden, results: !document.getElementById('results').hidden,
    resultCount: document.querySelectorAll('#results-list .ms-result').length,
    name: result && result.querySelector('.ms-result-name')?.textContent, word: result && result.querySelector('.ms-word')?.textContent,
    facts: result && result.querySelector('.ms-result-facts')?.textContent,
    note: notes.length === 1 ? notes[0].textContent : notes.length, noteAfterWord: notes.length === 1 && notes[0].previousElementSibling === result.querySelector('.ms-word-row'),
    lines, save: result && result.querySelector('.ms-download')?.download,
    share: !!result && vis(result.querySelector('.ms-share-btn')), copy: !!result && vis(result.querySelector('.ms-copy-btn')), warning: !!result && vis(result.querySelector('.ms-share-note')),
    readback: result && result.querySelector('.ms-readback, .ms-notice[data-tier="green"]')?.textContent,
    ticked: [...document.querySelectorAll('#meta-groups .ms-check')].filter((b) => b.checked).map((b) => b.closest('.ms-item').dataset.tier),
    detailCount: document.querySelectorAll('#meta-groups .ms-check').length,
    focus: document.activeElement && (document.activeElement.id || document.activeElement.className),
    said: document.getElementById('announcer').textContent,
    stale: !document.getElementById('go-stale').hidden,
  };
})()`;

// A snapshot of Save and the Share and Copy block under the first result, for
// page.evaluate. order lists the parts present, in document order: save, copy, share,
// note, status. primary: Share is a btn-primary with the same background as Save.
export const SHARE_STATE = `(() => {
  const vis = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
  const save = document.querySelector('#results-list .ms-download');
  const block = document.querySelector('#results-list .ms-share');
  const share = document.querySelector('#results-list .ms-share-btn');
  const copy = document.querySelector('#results-list .ms-copy-btn');
  const note = document.querySelector('#results-list .ms-share-note');
  const status = document.querySelector('#results-list .ms-share-status');
  const parts = [['save', save], ['copy', copy], ['share', share], ['note', note], ['status', status]].filter(([, el]) => el);
  parts.sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const bg = (el) => el && getComputedStyle(el).backgroundColor;
  return {
    block: !!block, webOnly: !!block && block.hasAttribute('data-web-only'), blockShown: vis(block),
    share: !!share, shareShown: vis(share), shareText: share && share.textContent,
    primary: !!share && share.matches('.btn.btn-primary') && !!save && bg(share) === bg(save), shareBg: bg(share), saveBg: bg(save),
    describedBy: share && share.getAttribute('aria-describedby'), expanded: share && share.getAttribute('aria-expanded'),
    copy: !!copy, copyShown: vis(copy), copyText: copy && copy.textContent,
    note: !!note, noteShown: vis(note), noteText: note && note.textContent, noteId: note && note.id,
    noteAmber: !!note && note.matches('p.ms-notice') && note.dataset.tier === 'amber',
    noteOwnsDescription: !!note && !!share && share.getAttribute('aria-describedby') === note.id && document.getElementById(note.id) === note,
    order: parts.map(([k]) => k),
    confirm: !!document.querySelector('#results-list .ms-share-confirm, #results-list .ms-share-continue, #results-list .ms-share-cancel'),
    focus: document.activeElement && (document.activeElement.className || document.activeElement.id),
    status: status && status.textContent, live: status && status.getAttribute('aria-live'),
    shares: window.__share ? window.__share.calls.length : null, copies: window.__clip ? window.__clip.calls.length : null,
  };
})()`;

// A stand-in for the Android app's side of the message channel (window.MSBridge), for the
// app-mode tests (1.0.1). The bridge (android/web-overlay/android-bridge.js) sees a channel,
// so it adds window.MSAndroid and the page shows Save, Copy and Share as in the app. The
// stand-in answers the way MainActivity does: on 'out-begin' it pulls every chunk in order,
// keeps the file, and answers 'out-done' (or 'out-error' when window.__ms.mode is 'fail').
// Nothing is sent anywhere: the bytes stay in the page for the test to read back.
//
//   window.__ms = { mode, copyLife, posted: [{ t, id, action, name, mime, size, chunks, index }],
//                   files: [{ action, name, mime, size, chunks, parts: [base64, ...] }], expire() }
// copyLife is the expiresIn the stand-in reports for a copy (the app reports the copy's time
// left, 2 minutes after a Copy); tests shorten it instead of waiting 2 minutes. expire() sends
// the app's 'clip-expired' message, as the app does when it ends the copy.
// Each file's parts are the chunks exactly as the bridge sent them; decode each one and
// join the bytes (a chunk's base64 cannot simply be joined to the next one's).
//
// The camera (1.1.0): window.__ms.camera = { mode, b64, opens, pulls, done, answer(ok) }.
// On 'camera-open' the stand-in answers as MainActivity does after the camera screen
// closes: mode 'cancel' gives { t: 'camera-result', ok: false }; mode 'ok' gives ok: true,
// then announces the photo in b64 (the whole file in base64) as a batch with source
// 'camera', and serves it through 'in-pull' in chunks; mode 'hold' answers nothing until
// answer(ok) is called. done lists the batches the page reported as received ('in-done'),
// after which the app deletes its copy.
export function appBridgeStub() {
  return `(() => {
  const b64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const ms = window.__ms = { mode: 'ok', copyLife: 120000, posted: [], files: [] };
  let listen = null;
  let cur = null;
  let photo = null;
  let nextBatch = 100;
  const reply = (msg) => setTimeout(() => { if (listen) listen({ data: JSON.stringify(msg) }); }, 0);
  const sendPhoto = (ok) => {
    const c = ms.camera;
    if (!ok || !c.b64) { reply({ t: 'camera-result', ok: false }); return; }
    const bin = atob(c.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    photo = { id: nextBatch++, bytes };
    reply({ t: 'camera-result', ok: true });
    reply({ t: 'incoming', batch: photo.id, files: [{ name: 'photo.jpg', mime: 'image/jpeg', size: bytes.length }], source: 'camera' });
  };
  ms.camera = { mode: 'ok', b64: '', opens: 0, pulls: 0, done: [], answer: (ok) => sendPhoto(ok) };
  const CHUNK = 192 * 1024;
  window.MSBridge = {
    postMessage(text) {
      const m = JSON.parse(text);
      ms.posted.push({ t: m.t, id: m.id, batch: m.batch, action: m.action, name: m.name, mime: m.mime, size: m.size, chunks: m.chunks, index: m.index });
      if (m.t === 'camera-open') {
        ms.camera.opens += 1;
        if (ms.camera.mode !== 'hold') sendPhoto(ms.camera.mode === 'ok');
      } else if (m.t === 'in-pull' && photo && m.batch === photo.id) {
        ms.camera.pulls += 1;
        const start = m.index * CHUNK;
        const piece = photo.bytes.subarray(start, Math.min(start + CHUNK, photo.bytes.length));
        reply({ t: 'in-chunk', batch: photo.id, file: m.file, index: m.index, data: b64(piece), last: start + CHUNK >= photo.bytes.length });
      } else if (m.t === 'in-done' && photo && m.batch === photo.id) {
        ms.camera.done.push(photo.id);
        photo = null;
      } else if (m.t === 'out-begin') {
        cur = { id: m.id, action: m.action, name: m.name, mime: m.mime, size: m.size, chunks: m.chunks, parts: [] };
        reply({ t: 'out-pull', id: m.id, index: 0 });
      } else if (m.t === 'out-chunk' && cur && m.id === cur.id) {
        cur.parts.push(m.data);
        if (m.index + 1 < cur.chunks) { reply({ t: 'out-pull', id: m.id, index: m.index + 1 }); return; }
        const done = cur;
        cur = null;
        ms.files.push(done);
        const ok = { t: 'out-done', id: done.id, ok: true };
        if (done.action === 'copy') ok.expiresIn = ms.copyLife;
        reply(ms.mode === 'fail' ? { t: 'out-error', id: done.id } : ok);
      }
    },
    addEventListener(type, fn) { if (type === 'message') listen = fn; },
  };
  ms.expire = () => reply({ t: 'clip-expired' });
})();`;
}

// Joins one recorded file's chunks back into its bytes (Node side).
export function appFileBytes(file) {
  return Buffer.concat((file && file.parts ? file.parts : []).map((p) => Buffer.from(p, 'base64')));
}

// A clock moved on by ms for Date.now only, then a 'visibilitychange' as when Android shows
// the app again after freezing it (its timers did not run meanwhile). For page.evaluate.
export const SKIP_CLOCK = (ms) => `(() => {
  const real = window.__realNow || (window.__realNow = Date.now.bind(Date));
  const skew = (window.__skew || 0) + ${ms};
  window.__skew = skew;
  Date.now = () => real() + skew;
  document.dispatchEvent(new Event('visibilitychange'));
  return document.visibilityState;
})()`;

