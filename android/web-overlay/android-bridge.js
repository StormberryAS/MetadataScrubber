/* MetadataScrubber for Android: the bridge between the page and the app.
 *
 * This file exists ONLY inside the APK. The build copies the web app byte for byte and
 * adds one line to index.html that loads this script before gate.js and app.js; nothing
 * else in the page is changed. On the website this file is never loaded.
 *
 * It does two jobs, and both keep the page's own Content Security Policy intact
 * (connect-src 'none'): no fetch, no XHR, nothing leaves the device.
 *
 *  1. SAVING AND SHARING. A WebView cannot follow a download link to a blob: address, so a
 *     click on the page's "Download" link is caught here. The Blob behind it is read in the
 *     page (Blob.arrayBuffer) and handed to the app in chunks, which then offers Save or
 *     Share. The file name is the page's own, for example image.public.jpg.
 *
 *  2. PICTURES SHARED INTO THE APP. When a gallery shares a picture to the app, the app
 *     hands it over in chunks; this script rebuilds it as a File, puts it in the page's
 *     file input and fires the same change event a user's pick would, so the page's normal
 *     flow takes over.
 *
 * The channel is window.MSBridge, injected by the app through
 * WebViewCompat.addWebMessageListener and ONLY into pages from
 * https://appassets.androidplatform.net, the bundled app's own origin.
 */
(function () {
  'use strict';

  var bridge = window.MSBridge;
  if (!bridge || typeof bridge.postMessage !== 'function') return;

  var CHUNK = 256 * 1024;

  function post(msg) {
    bridge.postMessage(JSON.stringify(msg));
  }

  /* ---------- Bytes and base64, without fetch ---------- */

  function toBase64(bytes) {
    var parts = [];
    var STEP = 0x8000;
    for (var i = 0; i < bytes.length; i += STEP) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + STEP, bytes.length))));
    }
    return btoa(parts.join(''));
  }

  function fromBase64(text) {
    var bin = atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------- 1. Saving and sharing ---------- */

  /* Remember which Blob each blob: address stands for, so a click can hand over the
     bytes without fetching the address (the page forbids fetch, and rightly). */
  var blobs = new Map();
  var nativeCreate = URL.createObjectURL;
  var nativeRevoke = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    var url = nativeCreate.call(URL, obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    blobs.delete(url);
    return nativeRevoke.call(URL, url);
  };

  var nextOutId = 1;
  var outQueue = [];
  var outCurrent = null;
  /* Every Blob that is queued or on its way to the app. A second tap on the same Download
     link while it is still being handed over does nothing, so one result never arrives
     twice. */
  var outPending = new Set();

  function startNextOut() {
    if (outCurrent || !outQueue.length) return;
    var job = outQueue.shift();
    job.blob.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      if (!bytes.length) { outPending.delete(job.blob); startNextOut(); return; }
      outCurrent = { id: nextOutId++, bytes: bytes, blob: job.blob };
      post({
        t: 'out-begin',
        id: outCurrent.id,
        name: job.name,
        mime: job.mime,
        size: bytes.length,
        chunks: Math.ceil(bytes.length / CHUNK)
      });
    }, function () {
      outPending.delete(job.blob);
      startNextOut();
    });
  }

  function onOutPull(msg) {
    if (!outCurrent || msg.id !== outCurrent.id) return;
    var start = msg.index * CHUNK;
    var piece = outCurrent.bytes.subarray(start, Math.min(start + CHUNK, outCurrent.bytes.length));
    post({ t: 'out-chunk', id: outCurrent.id, index: msg.index, data: toBase64(piece) });
  }

  function onOutEnd(msg) {
    if (!outCurrent || msg.id !== outCurrent.id) return;
    outPending.delete(outCurrent.blob);
    outCurrent = null;
    startNextOut();
  }

  document.addEventListener('click', function (ev) {
    var target = ev.target;
    var link = target && target.closest ? target.closest('a[download]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.indexOf('blob:') !== 0) return;
    ev.preventDefault();
    var blob = blobs.get(link.href) || blobs.get(href);
    if (!blob || outPending.has(blob)) return;
    outPending.add(blob);
    outQueue.push({
      blob: blob,
      name: link.getAttribute('download') || 'image',
      mime: blob.type || ''
    });
    startNextOut();
  }, true);

  /* ---------- 2. Pictures shared into the app ---------- */

  var inBatch = null;

  /* readyState turns 'interactive' BEFORE deferred and module scripts run, so it cannot
     say whether app.js has started listening to its file input yet. DOMContentLoaded fires
     only after gate.js (defer) and app.js (module) have run: by then app.js listens, and
     gate.js has put up the first-run notice if it is needed. This script loads first, so
     its listener runs before theirs, but nothing is delivered from inside that event. */
  var domReady = false;
  document.addEventListener('DOMContentLoaded', function () { domReady = true; }, { once: true });

  function pageReady() {
    return domReady &&
      !!document.getElementById('file-input') &&
      !document.querySelector('.sb-gate-overlay');
  }

  /* Waits for the page to be ready and for the first-run notice to be dismissed, so a
     shared picture never arrives behind the notice. */
  function whenReady(fn) {
    if (pageReady()) { fn(); return; }
    window.setTimeout(function () { whenReady(fn); }, 250);
  }

  function onIncoming(msg) {
    inBatch = { id: msg.batch, files: msg.files || [], done: [], file: 0, parts: [] };
    if (!inBatch.files.length) { inBatch = null; return; }
    var id = inBatch.id;
    whenReady(function () {
      if (inBatch && inBatch.id === id) post({ t: 'in-pull', batch: id, file: 0, index: 0 });
    });
  }

  function onInChunk(msg) {
    var b = inBatch;
    if (!b || msg.batch !== b.id || msg.file !== b.file) return;
    if (msg.data) b.parts.push(fromBase64(msg.data));
    if (!msg.last) {
      post({ t: 'in-pull', batch: b.id, file: b.file, index: msg.index + 1 });
      return;
    }
    var meta = b.files[b.file];
    b.done.push(new File(b.parts, meta.name, { type: meta.mime }));
    b.parts = [];
    b.file += 1;
    if (b.file < b.files.length) {
      post({ t: 'in-pull', batch: b.id, file: b.file, index: 0 });
      return;
    }
    deliver(b);
  }

  function onInError(msg) {
    var b = inBatch;
    if (!b || msg.batch !== b.id) return;
    /* Skip the unreadable file and carry on with the rest. The app has already said why. */
    b.parts = [];
    b.file = msg.file + 1;
    if (b.file < b.files.length) {
      post({ t: 'in-pull', batch: b.id, file: b.file, index: 0 });
    } else {
      deliver(b);
    }
  }

  function deliver(b) {
    inBatch = null;
    post({ t: 'in-done', batch: b.id });
    if (!b.done.length) return;
    var input = document.getElementById('file-input');
    var dt = new DataTransfer();
    b.done.forEach(function (f) { dt.items.add(f); });
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ---------- Messages from the app ---------- */

  bridge.addEventListener('message', function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'out-pull': onOutPull(msg); break;
      case 'out-done':
      case 'out-error': onOutEnd(msg); break;
      case 'incoming': onIncoming(msg); break;
      case 'in-chunk': onInChunk(msg); break;
      case 'in-error': onInError(msg); break;
      default: break;
    }
  });

  post({ t: 'hello' });
})();
