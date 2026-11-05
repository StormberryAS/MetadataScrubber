"use strict";
/*! android-bridge.js is compiled from android-bridge.ts beside it by tools/build-ts.sh, which leaves
    out every comment but this one: the explanations are in the source. Edit the TypeScript, never
    the .js: the build refuses to overwrite a hand edit, and its check mode fails on one. */
(function () {
    'use strict';
    function hideWebOnly(root) {
        if (root.nodeType !== 1 && root.nodeType !== 9)
            return;
        if (root.nodeType === 1 && root.hasAttribute('data-web-only'))
            root.hidden = true;
        var els = root.querySelectorAll('[data-web-only]');
        for (var i = 0; i < els.length; i++)
            els[i].hidden = true;
    }
    function watchWebOnly() {
        hideWebOnly(document);
        if (typeof MutationObserver !== 'function')
            return;
        new MutationObserver(function (records) {
            for (var r = 0; r < records.length; r++) {
                var added = records[r].addedNodes;
                for (var n = 0; n < added.length; n++)
                    hideWebOnly(added[n]);
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('readystatechange', function onState() {
            if (document.readyState === 'loading')
                return;
            document.removeEventListener('readystatechange', onState);
            watchWebOnly();
        });
    }
    else {
        watchWebOnly();
    }
    var bridge = window.MSBridge;
    if (!bridge || typeof bridge.postMessage !== 'function')
        return;
    var CHUNK = 256 * 1024;
    function post(msg) {
        bridge.postMessage(JSON.stringify(msg));
    }
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
        for (var i = 0; i < bin.length; i++)
            out[i] = bin.charCodeAt(i);
        return out;
    }
    var blobs = new Map();
    var nativeCreate = URL.createObjectURL;
    var nativeRevoke = URL.revokeObjectURL;
    URL.createObjectURL = function (obj) {
        var url = nativeCreate.call(URL, obj);
        if (obj instanceof Blob)
            blobs.set(url, obj);
        return url;
    };
    URL.revokeObjectURL = function (url) {
        blobs.delete(url);
        return nativeRevoke.call(URL, url);
    };
    var nextOutId = 1;
    var outQueue = [];
    var outCurrent = null;
    var outJobs = [];
    var MAX_OUT = 512 * 1024 * 1024;
    function finishJob(job, ok) {
        var i = outJobs.indexOf(job);
        if (i >= 0)
            outJobs.splice(i, 1);
        job.resolve(ok);
    }
    function sendOut(blob, name, action) {
        for (var i = 0; i < outJobs.length; i++) {
            if (outJobs[i].blob === blob && outJobs[i].action === action)
                return outJobs[i].promise;
        }
        var job = { blob: blob, name: name, mime: blob.type || '', action: action };
        job.promise = new Promise(function (resolve) { job.resolve = resolve; });
        outJobs.push(job);
        outQueue.push(job);
        startNextOut();
        return job.promise;
    }
    function startNextOut() {
        if (outCurrent || !outQueue.length)
            return;
        var job = outQueue.shift();
        outCurrent = { id: nextOutId++, bytes: null, job: job };
        var current = outCurrent;
        job.blob.arrayBuffer().then(function (buf) {
            if (outCurrent !== current)
                return;
            var bytes = new Uint8Array(buf);
            if (!bytes.length || bytes.length > MAX_OUT) {
                endOut(current, false);
                return;
            }
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
            if (outCurrent === current)
                endOut(current, false);
        });
    }
    function endOut(current, ok, msg) {
        if (outCurrent !== current)
            return;
        outCurrent = null;
        var result = ok;
        if (ok && current.job.action === 'copy') {
            var left = msg && typeof msg.expiresIn === 'number' && isFinite(msg.expiresIn) ? msg.expiresIn : CLIP_LIFETIME;
            result = Object.freeze({ expiresIn: Math.max(0, Math.min(left, CLIP_LIFETIME)) });
        }
        finishJob(current.job, result);
        startNextOut();
    }
    var CLIP_LIFETIME = 2 * 60 * 1000;
    function onOutPull(msg) {
        if (!outCurrent || !outCurrent.bytes || msg.id !== outCurrent.id)
            return;
        var start = msg.index * CHUNK;
        if (!(start >= 0 && start < outCurrent.bytes.length))
            return;
        var piece = outCurrent.bytes.subarray(start, Math.min(start + CHUNK, outCurrent.bytes.length));
        post({ t: 'out-chunk', id: outCurrent.id, index: msg.index, data: toBase64(piece) });
    }
    function onOutEnd(msg) {
        if (!outCurrent || msg.id !== outCurrent.id)
            return;
        endOut(outCurrent, msg.t === 'out-done' && msg.ok !== false, msg);
    }
    document.addEventListener('click', function (ev) {
        var target = ev.target;
        var link = target && target.closest ? target.closest('a[download]') : null;
        if (!link)
            return;
        var href = link.getAttribute('href') || '';
        if (href.indexOf('blob:') !== 0)
            return;
        ev.preventDefault();
        var blob = blobs.get(link.href) || blobs.get(href);
        if (!blob)
            return;
        sendOut(blob, link.getAttribute('download') || 'image', 'save');
    }, true);
    var cameraPromise = null;
    var cameraResolve = null;
    function onCameraResult(msg) {
        var resolve = cameraResolve;
        cameraPromise = null;
        cameraResolve = null;
        if (resolve)
            resolve(msg.ok === true);
    }
    function isBlob(x) { return typeof Blob === 'function' && x instanceof Blob; }
    var api = {
        share: function (file, name) {
            if (!isBlob(file) || !file.size)
                return Promise.resolve(false);
            return sendOut(file, String(name || file.name || 'image'), 'share');
        },
        copyImage: function (png) {
            if (!isBlob(png) || !png.size || png.type !== 'image/png')
                return Promise.resolve(false);
            return sendOut(png, 'image.png', 'copy');
        },
        takePhoto: function () {
            if (cameraPromise)
                return cameraPromise;
            cameraPromise = new Promise(function (resolve) { cameraResolve = resolve; });
            post({ t: 'camera-open' });
            return cameraPromise;
        }
    };
    Object.freeze(api);
    Object.defineProperty(window, 'MSAndroid', { value: api, writable: false, configurable: false, enumerable: false });
    var inBatch = null;
    var domReady = false;
    document.addEventListener('DOMContentLoaded', function () { domReady = true; }, { once: true });
    function pageReady() {
        return domReady &&
            !!document.getElementById('file-input') &&
            !document.querySelector('.sb-gate-overlay');
    }
    function whenReady(fn) {
        if (pageReady()) {
            fn();
            return;
        }
        window.setTimeout(function () { whenReady(fn); }, 250);
    }
    function onIncoming(msg) {
        inBatch = { id: msg.batch, files: msg.files || [], done: [], file: 0, parts: [], source: msg.source === 'camera' ? 'camera' : 'share' };
        if (!inBatch.files.length) {
            inBatch = null;
            return;
        }
        var id = inBatch.id;
        whenReady(function () {
            if (inBatch && inBatch.id === id)
                post({ t: 'in-pull', batch: id, file: 0, index: 0 });
        });
    }
    function onInChunk(msg) {
        var b = inBatch;
        if (!b || msg.batch !== b.id || msg.file !== b.file)
            return;
        if (msg.data)
            b.parts.push(fromBase64(msg.data));
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
        if (!b || msg.batch !== b.id)
            return;
        b.parts = [];
        b.file = msg.file + 1;
        if (b.file < b.files.length) {
            post({ t: 'in-pull', batch: b.id, file: b.file, index: 0 });
        }
        else {
            deliver(b);
        }
    }
    function deliver(b) {
        inBatch = null;
        post({ t: 'in-done', batch: b.id });
        if (!b.done.length)
            return;
        if (b.source === 'camera') {
            if (b.done.length === 1 && b.done[0].type === 'image/jpeg') {
                window.dispatchEvent(new CustomEvent('msandroid:photo', { detail: Object.freeze({ file: b.done[0] }) }));
            }
            return;
        }
        var input = document.getElementById('file-input');
        var dt = new DataTransfer();
        b.done.forEach(function (f) { dt.items.add(f); });
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    bridge.addEventListener('message', function (ev) {
        var msg;
        try {
            msg = JSON.parse(ev.data);
        }
        catch (e) {
            return;
        }
        if (!msg || typeof msg.t !== 'string')
            return;
        switch (msg.t) {
            case 'out-pull':
                onOutPull(msg);
                break;
            case 'out-done':
            case 'out-error':
                onOutEnd(msg);
                break;
            case 'incoming':
                onIncoming(msg);
                break;
            case 'in-chunk':
                onInChunk(msg);
                break;
            case 'in-error':
                onInError(msg);
                break;
            case 'clip-expired':
                window.dispatchEvent(new Event('msandroid:clip-expired'));
                break;
            case 'camera-result':
                onCameraResult(msg);
                break;
            default: break;
        }
    });
    post({ t: 'hello' });
})();
