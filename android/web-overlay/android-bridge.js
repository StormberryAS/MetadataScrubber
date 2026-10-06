/* MetadataScrubber for Android: the bridge between the page and the app.
 *
 * This file exists ONLY inside the APK. The build copies the web app byte for byte and
 * adds one line to index.html that loads this script before gate.js and app.js; nothing
 * else in the page is changed. On the website this file is never loaded.
 *
 * It does three jobs, and all keep the page's own Content Security Policy intact
 * (connect-src 'none'): no fetch, no XHR, nothing leaves the device.
 *
 *  0. WEBSITE-ONLY PARTS. Every element marked data-web-only (the "Get the Android app on
 *     Zapstore" section) is hidden: the ones in the page once it has been parsed, and the
 *     ones the page adds later as soon as they are added.
 *
 *  1. SAVE, SHARE AND COPY. A WebView cannot follow a download link to a blob: address, so
 *     a click on the page's "Save" link is caught here. The Blob behind it is read in the
 *     page (Blob.arrayBuffer) and handed to the app in chunks, and the app opens Android's
 *     save screen with it. The file name is the page's own, for example image.minimal.jpg.
 *     Share and Copy go the same way, through window.MSAndroid, which this script adds
 *     (1.0.1): share(file, name) hands the exact file Save gives to Android's share sheet,
 *     and copyImage(png) hands the fresh PNG the page draws (no file details) to Android's
 *     clipboard. share returns a Promise of true once the app has done it, or false;
 *     copyImage a Promise of { expiresIn } (the milliseconds the copy can still be pasted,
 *     as the app counts them) or false. When the app ends a copy's 2 minutes (or finds it
 *     ended while the app was away) it says so, and this script fires the window event
 *     'msandroid:clip-expired', so the page's line and the app's file provider agree. The
 *     page shows its Share and Copy buttons, and the warning under them, only because
 *     window.MSAndroid exists; without the message channel it is never added, and the page
 *     marks that block data-web-only, so it is hidden as before.
 *
 *  2. PICTURES SHARED INTO THE APP. When a gallery shares a picture to the app, the app
 *     hands it over in chunks; this script rebuilds it as a File, puts it in the page's
 *     file input and fires the same change event a user's pick would, so the page's normal
 *     flow takes over.
 *
 * The channel is window.MSBridge, injected by the app through
 * WebViewCompat.addWebMessageListener and ONLY into pages from
 * https://appassets.androidplatform.net, the bundled app's own origin. window.MSAndroid is
 * plain JavaScript on top of that channel: it adds no Java object to the page (no
 * addJavascriptInterface), it carries bytes only (never an address or a path), and the
 * app checks every request again (OutgoingRequest.kt) before it saves, shares or copies.
 */
(function () {
  'use strict';

  /* ---------- 0. Website-only parts of the page ---------- */

  /* This runs before the check for window.MSBridge below, on purpose: it depends only on
     this file being loaded, which happens only inside the APK, so the website-only parts
     stay hidden even on a WebView too old for the message channel. The script loads in the
     head, before the body exists, so it waits for the end of parsing: readyState leaves
     'loading' before the deferred gate.js and the app.js module run, whereas
     DOMContentLoaded fires only after them. A page without any data-web-only element is
     left as it is.
     The page also builds parts after loading (the result of each new file, with its Share
     and Copy buttons). A MutationObserver hides any data-web-only element among them; its
     callback runs before the browser paints, so such a part is never shown, not even
     briefly. */
  function hideWebOnly(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1 && root.hasAttribute('data-web-only')) root.hidden = true;
    var els = root.querySelectorAll('[data-web-only]');
    for (var i = 0; i < els.length; i++) els[i].hidden = true;
  }
  function watchWebOnly() {
    hideWebOnly(document);
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(function (records) {
      for (var r = 0; r < records.length; r++) {
        var added = records[r].addedNodes;
        for (var n = 0; n < added.length; n++) hideWebOnly(added[n]);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('readystatechange', function onState() {
      if (document.readyState === 'loading') return;
      document.removeEventListener('readystatechange', onState);
      watchWebOnly();
    });
  } else {
    watchWebOnly();
  }

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

  /* ---------- 1. Save, Share and Copy ---------- */

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
  /* Every job queued or on its way to the app. The same Blob asked for the same action
     again while it is still being handed over gets the job already under way, so a second
     tap on Save never makes the file arrive twice. */
  var outJobs = [];

  /* Largest file handed to the app; the app refuses anything bigger in any case
     (ChunkAssembler.DEFAULT_MAX_BYTES). */
  var MAX_OUT = 512 * 1024 * 1024;

  function finishJob(job, ok) {
    var i = outJobs.indexOf(job);
    if (i >= 0) outJobs.splice(i, 1);
    job.resolve(ok);
  }

  /* Queues one Blob for the app. action is 'save', 'share' or 'copy'. Resolves to true
     once the app reports it done, or false. */
  function sendOut(blob, name, action) {
    for (var i = 0; i < outJobs.length; i++) {
      if (outJobs[i].blob === blob && outJobs[i].action === action) return outJobs[i].promise;
    }
    var job = { blob: blob, name: name, mime: blob.type || '', action: action };
    job.promise = new Promise(function (resolve) { job.resolve = resolve; });
    outJobs.push(job);
    outQueue.push(job);
    startNextOut();
    return job.promise;
  }

  function startNextOut() {
    if (outCurrent || !outQueue.length) return;
    var job = outQueue.shift();
    outCurrent = { id: nextOutId++, bytes: null, job: job };
    var current = outCurrent;
    job.blob.arrayBuffer().then(function (buf) {
      if (outCurrent !== current) return;
      var bytes = new Uint8Array(buf);
      if (!bytes.length || bytes.length > MAX_OUT) { endOut(current, false); return; }
      current.bytes = bytes;
      post({
        t: 'out-begin',
        id: current.id,
        action: job.action,
        name: job.name,
        mime: job.mime,
        size: bytes.length,
        chunks: Math.ceil(bytes.length / CHUNK)
      });
    }, function () {
      if (outCurrent === current) endOut(current, false);
    });
  }

  function endOut(current, ok, msg) {
    if (outCurrent !== current) return;
    outCurrent = null;
    var result = ok;
    if (ok && current.job.action === 'copy') {
      var left = msg && typeof msg.expiresIn === 'number' && isFinite(msg.expiresIn) ? msg.expiresIn : CLIP_LIFETIME;
      result = Object.freeze({ expiresIn: Math.max(0, Math.min(left, CLIP_LIFETIME)) });
    }
    finishJob(current.job, result);
    startNextOut();
  }

  /* A copied picture can be pasted for 2 minutes (ClipboardFiles.LIFETIME_MS in the app). */
  var CLIP_LIFETIME = 2 * 60 * 1000;

  function onOutPull(msg) {
    if (!outCurrent || !outCurrent.bytes || msg.id !== outCurrent.id) return;
    var start = msg.index * CHUNK;
    if (!(start >= 0 && start < outCurrent.bytes.length)) return;
    var piece = outCurrent.bytes.subarray(start, Math.min(start + CHUNK, outCurrent.bytes.length));
    post({ t: 'out-chunk', id: outCurrent.id, index: msg.index, data: toBase64(piece) });
  }

  function onOutEnd(msg) {
    if (!outCurrent || msg.id !== outCurrent.id) return;
    endOut(outCurrent, msg.t === 'out-done' && msg.ok !== false, msg);
  }

  document.addEventListener('click', function (ev) {
    var target = ev.target;
    var link = target && target.closest ? target.closest('a[download]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.indexOf('blob:') !== 0) return;
    ev.preventDefault();
    var blob = blobs.get(link.href) || blobs.get(href);
    if (!blob) return;
    sendOut(blob, link.getAttribute('download') || 'image', 'save');
  }, true);

  /* Share and Copy for the page. Only Blobs go in: no address, no path. The page checks
     for both functions before it shows its buttons. */
  function isBlob(x) { return typeof Blob === 'function' && x instanceof Blob; }
  var api = {
    share: function (file, name) {
      if (!isBlob(file) || !file.size) return Promise.resolve(false);
      return sendOut(file, String(name || file.name || 'image'), 'share');
    },
    copyImage: function (png) {
      if (!isBlob(png) || !png.size || png.type !== 'image/png') return Promise.resolve(false);
      return sendOut(png, 'image.png', 'copy');
    }
  };
  Object.freeze(api);
  Object.defineProperty(window, 'MSAndroid', { value: api, writable: false, configurable: false, enumerable: false });

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
      case 'clip-expired': window.dispatchEvent(new Event('msandroid:clip-expired')); break;
      default: break;
    }
  });

  post({ t: 'hello' });
})();
