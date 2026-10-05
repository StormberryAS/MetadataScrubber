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
  copyFailed: 'The image could not be copied. Save it instead.',
};

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
