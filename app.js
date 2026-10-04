// MetadataScrubber: the interface (ES module).
//
// Everything happens in this page; nothing is sent anywhere. The page policy forbids
// network requests, inline styles and blob: pictures, which shapes this file:
//  * previews are drawn on <canvas> from createImageBitmap(file), never <img src=blob:>
//  * positions and sizes are set through element.style, never through style attributes
//  * the only blob: URLs are download links, and old ones are revoked
//  * metadata values come from untrusted files, so they are only ever written with
//    textContent, never as HTML
//
// Two ways to make the new file:
//  * lossless: scrub() removes the ticked items and leaves the picture bytes untouched
//  * re-saved: when the user crops, resizes, changes format, or removes a rotation that
//    is not "normal", the picture is drawn on a canvas, encoded by the browser, and only
//    the kept EXIF details are written back with buildExif() and insertExif()
// Either way the new file is read back with inspect(), and its privacy word comes from
// privacyWord() on that read-back, never from what we meant to do.
//
// One button makes the new file, and it is neutral ("Prepare picture"): a person may
// only want to crop or resize. When nothing would change, no identical copy is made;
// the page says so instead.

import { GROUPS, TIERS, buildExif, detectFormat, insertExif, inspect, privacyWord, scrub } from './src/scrub-core.js?v=975bd2e8';

// ---------------------------------------------------------------------------------------
// Constants

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', heic: 'heic' };
const FORMAT_NAME = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', heic: 'HEIC' };
const TIER_ORDER = ['red', 'amber', 'green'];
const TIER_RANK = { red: 0, amber: 1, green: 2 };
const TIER_WORD = { red: 'Red', amber: 'Amber', green: 'Green' };
const GROUP_RANK = Object.fromEntries(GROUPS.map((g, i) => [g.id, i]));
const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.id, g.label]));
// The tiers ticked for removal to start with: red only (0.0.3). Free text that can name
// people (captions, titles, descriptions, keywords, comments) is red; amber holds only
// structured details (dates, time zone, camera, lens, software, the HDR details), kept
// unless the user ticks them. Green holds rotation and the colour profile; removing those
// re-saves many phone photos and can shift colours, so it starts unticked too.
const DEFAULT_TIERS = new Set(['red']);
// The HDR gain map changes how the photo looks, not who took it, so it and its XMP
// description stay unticked: the engine keeps only the fields a gain map needs to render
// and lists everything else in or around it as its own detail, ticked by tier.
const GAIN_MAP_ID = 'jpeg:trailing:gain-map';
const HEIC_GAIN_MAP_ID = 'heic:gain-map';
const GAIN_MAP_IDS = new Set([GAIN_MAP_ID, HEIC_GAIN_MAP_ID]);
// The amber details that belong to the gain map itself: unticked to start with, and named
// in the note on a result that kept them. An iPhone gain map (JPEG or HEIC) also needs the
// photo's Apple HDR brightness, two numbers the engine keeps in a maker note of their own.
const GAIN_MAP_OWN = new Set([GAIN_MAP_ID, HEIC_GAIN_MAP_ID, 'xmp:gainmap', 'exif:apple-hdr']);

// The tier words and their meanings, from the spec's file name table. The colour is the
// tier of the most sensitive kind of item that can be left in a file with that word.
const PRIVACY = {
  public: { tier: 'amber', text: 'Safe to share publicly: location, serial numbers, names, captions and the hidden preview are gone. Dates and device details may remain; check them under Amber.' },
  minimal: { tier: 'green', text: 'Only technical data left: rotation, colour, size and exposure.' },
  clean: { tier: 'green', text: 'No metadata left at all.' },
  custom: { tier: 'red', text: 'Your own selection. Check the list of what remains.' },
};
const CUSTOM_WARNING = 'Not recommended for public sharing.';
const GAIN_MAP_KEPT_NOTE = 'The HDR gain map stays, so the photo keeps its brightness on HDR screens. Tick HDR gain map under Amber for a minimal file.';

const RATIOS = { free: null, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9, '1.91:1': 1.91 };

// Re-saving with no size limit: high quality, so the loss is as small as it can be.
const RESAVE_QUALITY = { jpeg: 0.92, webp: 0.9 };
// Size limit: search on scale at a good fixed quality first, then lower the quality step
// by step to a floor, and only then make the picture smaller than FLOOR_EDGE.
const SIZE_QUALITY = 0.85;
// A size search stops once a version fits and uses at least this share of the target.
const CLOSE_ENOUGH = 0.97;
const QUALITY_STEPS = [0.8, 0.75, 0.7];
const FLOOR_EDGE = 1280;
const TARGET_SHARE = 0.95;
const MIN_EDGE = 16;

const PREVIEW_LONG_EDGE = 1600;
const THUMB_EDGE = 72;
// Canvases up to this many pixels work in every current browser, so they are not tested
// first. iOS Safari's limit is exactly this area.
const SAFE_CANVAS_AREA = 16777216;

const ROTATION_ID = /^exif:orientation(?::\d+)?$/;
const HEIC_NO_PREVIEW = 'Preview is not available for HEIC in this browser. Removing metadata still works; cropping, resizing and changing format do not.';
const OTHER_NO_PREVIEW = 'This browser could not open the picture itself, so there is no preview. Removing metadata still works; cropping, resizing and changing format do not.';
const DAMAGED_NO_PREVIEW = 'This picture looks damaged or only partly saved, so this browser cannot show it. Removing metadata still works; cropping, resizing and changing format do not.';
const RESAVE_LINE = 'Cropping, resizing or changing format re-saves the picture.';

// A tiny EXIF block holding only Orientation = 6, used once per format to learn whether
// this browser turns pictures by their rotation setting when it decodes them.
const ORIENT_TEST_TIFF = new Uint8Array([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);

// ---------------------------------------------------------------------------------------
// Small helpers

const $ = (id) => document.getElementById(id);

// Builds an element. Strings become text nodes, so untrusted text can never become markup.
function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : String(kid));
  }
  return node;
}

const intFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const fmtInt = (n) => intFormat.format(Math.round(n));
const fmtDims = (w, h) => `${fmtInt(w)} × ${fmtInt(h)} pixels`;

function fmtBytes(n) {
  if (n < 1000) return `${fmtInt(n)} bytes`;
  const unit = n < 1e6 ? ['KB', 1e3] : ['MB', 1e6];
  const v = n / unit[1];
  const digits = v < 10 ? 1 : 0;
  return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits }).format(v)} ${unit[0]}`;
}

const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;

function listText(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// Reads a number typed by a person: accepts "59,4" and "59.4", spaces, a Unicode minus
// and a unit after the number ("50 %", "2048 px"). A comma followed by groups of exactly
// three digits is a thousands separator ("2,048").
function parseNumber(text) {
  let t = String(text || '').trim()
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/\u2212/g, '-')
    .replace(/(%|[a-z]+)$/i, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else t = t.replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  return parseFloat(t);
}

function announce(text) {
  const node = $('announcer');
  node.textContent = '';
  // A fresh text node after a tick makes screen readers read repeated messages too.
  setTimeout(() => { node.textContent = text; }, 60);
}

const canvasBlob = (canvas, type, quality) => new Promise((resolve) => {
  try { canvas.toBlob(resolve, type, quality); } catch { resolve(null); }
});

function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

// ---------------------------------------------------------------------------------------
// Browser abilities, learned once

let webpSupport = null;
function canEncodeWebp() {
  if (!webpSupport) {
    webpSupport = (async () => {
      const c = document.createElement('canvas');
      c.width = 2;
      c.height = 2;
      const blob = await canvasBlob(c, 'image/webp', 0.8);
      releaseCanvas(c);
      return !!blob && blob.type === 'image/webp';
    })();
  }
  return webpSupport;
}

// Whether createImageBitmap() turns a picture by its EXIF rotation, per format: true,
// false, or null when it cannot be tested here.
const orientationTests = {};
function decodeAppliesRotation(format) {
  if (!(format in orientationTests)) {
    orientationTests[format] = (async () => {
      try {
        const c = document.createElement('canvas');
        c.width = 2;
        c.height = 1;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#808080';
        ctx.fillRect(0, 0, 2, 1);
        const blob = await canvasBlob(c, MIME[format], 0.9);
        releaseCanvas(c);
        if (!blob || blob.type !== MIME[format]) return null;
        const tagged = insertExif(new Uint8Array(await blob.arrayBuffer()), format, ORIENT_TEST_TIFF);
        const bmp = await createImageBitmap(new Blob([tagged], { type: MIME[format] }));
        const turned = bmp.width === 1 && bmp.height === 2;
        bmp.close();
        return turned;
      } catch {
        return null;
      }
    })();
  }
  return orientationTests[format];
}

// ---------------------------------------------------------------------------------------
// State

const state = {
  entries: [],        // one per loaded file, see loadFiles()
  rows: [],           // the metadata list: items merged by id across files
  selected: new Set(),
  crop: { on: false, ratio: 'free', rect: null },
  results: [],
  urls: [],
  busy: false,
  loadToken: 0,
  choiceVersion: 0,
};

const single = () => state.entries.length === 1;
const current = () => (single() ? state.entries[0] : null);
const goLabel = () => (state.entries.length > 1 ? 'Prepare pictures' : 'Prepare picture');

// ---------------------------------------------------------------------------------------
// Loading files

async function loadFiles(fileList) {
  const files = [...fileList].filter((f) => f && typeof f.arrayBuffer === 'function');
  if (!files.length) return;
  resetAll();
  const token = ++state.loadToken;
  const errors = [];
  const entries = [];
  announce(files.length === 1 ? 'Reading the picture.' : `Reading ${files.length} pictures.`);

  for (const file of files) {
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      errors.push(`"${file.name}" could not be opened.`);
      continue;
    }
    if (token !== state.loadToken) return;
    const format = detectFormat(bytes);
    if (!format) {
      errors.push(`"${file.name}" is not a JPEG, PNG, WebP or HEIC picture, so it cannot be cleaned here.`);
      continue;
    }
    let info;
    try {
      info = await inspect(bytes);
    } catch {
      errors.push(`"${file.name}" could not be read. It may be damaged or only partly saved.`);
      continue;
    }
    if (token !== state.loadToken) return;
    entries.push({ file, bytes, format, info, bitmap: null, decodable: false, turned: true, w: 0, h: 0 });
  }

  showPickErrors(errors);
  if (!entries.length) {
    announce(errors.length ? 'No picture could be read.' : '');
    return;
  }

  const keepBitmap = entries.length === 1;
  for (const entry of entries) {
    await prepareEntry(entry, keepBitmap);
    if (token !== state.loadToken) {
      if (entry.bitmap) entry.bitmap.close();
      return;
    }
  }

  state.entries = entries;
  state.rows = mergeRows(entries);
  state.selected = defaultIds();
  state.crop = { on: false, ratio: 'free', rect: null };
  renderWorkspace();
  // On a phone the workspace starts below the picker; bring it into view.
  if (matchMedia('(max-width: 879px)').matches) $('workspace').scrollIntoView({ behavior: 'instant', block: 'start' });

  const ticked = state.selected.size;
  const found = state.rows.length;
  const what = entries.length === 1 ? 'Picture loaded.' : `${entries.length} pictures loaded.`;
  const tickedText = ticked
    ? `${fmtInt(ticked)} of them ${ticked === 1 ? 'is' : 'are'} red and ticked for removal.`
    : state.rows.some((row) => row.tier === 'red')
      // In a batch, the only red rows can be merged rows of a kept HDR gain map, which
      // defaultIds() leaves unticked.
      ? 'Nothing is ticked: the red details belong to the HDR gain map, which is kept.'
      : 'None of them is red, so nothing is ticked.';
  announce(found
    ? `${what} ${plural(found, 'metadata detail', 'metadata details')} found. ${tickedText}`
    : `${what} No metadata found.`);
}

// Decodes the picture (when the browser can) to learn its size the right way up, and
// whether createImageBitmap already applied the rotation setting.
async function prepareEntry(entry, keepBitmap) {
  const { info } = entry;
  const o = info.orientation || 1;
  const sideways = o >= 5;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(entry.file);
  } catch {
    bitmap = null;
  }
  if (!bitmap) {
    entry.decodable = false;
    entry.w = sideways ? info.height : info.width;
    entry.h = sideways ? info.width : info.height;
    return;
  }
  entry.decodable = true;
  if (o === 1 || entry.format === 'heic') {
    entry.turned = true;
  } else {
    let turned = await decodeAppliesRotation(entry.format);
    const square = info.width === info.height;
    if (sideways && !square && info.width && info.height) {
      // The picture itself settles it when it is not square.
      turned = bitmap.width === info.height && bitmap.height === info.width;
    } else if (turned === null) {
      turned = false;
    }
    entry.turned = turned;
  }
  entry.w = entry.turned || !sideways ? bitmap.width : bitmap.height;
  entry.h = entry.turned || !sideways ? bitmap.height : bitmap.width;
  if (keepBitmap) {
    entry.bitmap = bitmap;
  } else {
    entry.thumb = drawThumb(entry, bitmap);
    bitmap.close();
  }
}

async function getBitmap(entry) {
  if (entry.bitmap) return { bitmap: entry.bitmap, owned: false };
  const bitmap = await createImageBitmap(entry.file);
  return { bitmap, owned: true };
}

// The matrix that maps the decoded picture onto the right-way-up picture, for each EXIF
// rotation value. w and h are the decoded picture's size.
function orientMatrix(o, w, h) {
  switch (o) {
    case 2: return [-1, 0, 0, 1, w, 0];
    case 3: return [-1, 0, 0, -1, w, h];
    case 4: return [1, 0, 0, -1, 0, h];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, h, 0];
    case 7: return [0, -1, -1, 0, h, w];
    case 8: return [0, -1, 1, 0, 0, w];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

// Draws the part `region` (in right-way-up picture pixels) of the picture into a target
// of tw x th pixels.
function drawRegion(ctx, entry, bitmap, region, tw, th) {
  const sx = tw / region.w;
  const sy = th / region.h;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(sx, 0, 0, sy, -region.x * sx, -region.y * sy);
  const o = entry.info.orientation || 1;
  if (!entry.turned && o !== 1) ctx.transform(...orientMatrix(o, bitmap.width, bitmap.height));
  ctx.drawImage(bitmap, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function fullRegion(entry) {
  return { x: 0, y: 0, w: entry.w, h: entry.h };
}

function fitSize(w, h, longEdge) {
  const s = Math.min(1, longEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

function drawThumb(entry, bitmap) {
  const size = fitSize(entry.w, entry.h, THUMB_EDGE * 2);
  const canvas = h('canvas', { class: 'ms-thumb', width: size.w, height: size.h, 'aria-hidden': 'true' });
  const ctx = canvas.getContext('2d');
  if (ctx) drawRegion(ctx, entry, bitmap, fullRegion(entry), size.w, size.h);
  return canvas;
}

// Merges the items of every loaded file by id, so one tick applies to all files.
function mergeRows(entries) {
  const rows = new Map();
  for (const entry of entries) {
    for (const item of entry.info.items) {
      let row = rows.get(item.id);
      if (!row) {
        row = { id: item.id, group: item.group, tier: item.tier, label: item.label, value: item.value, source: item.source, note: item.note, count: 0, values: new Set() };
        rows.set(item.id, row);
      }
      row.count += 1;
      row.values.add(item.value);
      if (TIER_RANK[item.tier] < TIER_RANK[row.tier]) row.tier = item.tier;
    }
  }
  return [...rows.values()];
}

// The details ticked for removal to start with: every red one, except the HDR gain map and
// its description when a file holds an amber gain map. That holds whatever tier the merged
// rows have: in a batch, another file's second picture that is not plausibly
// a gain map makes its description red, but that description still goes with its own red
// picture, while ticking the row would leave the real gain map without one. Red details in
// or around a gain map stay ticked.
function defaultIds() {
  const hdr = hdrKept();
  return new Set(state.rows.filter((row) => DEFAULT_TIERS.has(row.tier)
    && !(hdr && GAIN_MAP_OWN.has(row.id))).map((row) => row.id));
}

// Whether the files hold an amber HDR gain map (JPEG or HEIC), which starts unticked.
function hdrKept() {
  return state.rows.some((row) => GAIN_MAP_IDS.has(row.id) && row.tier === 'amber');
}

// ---------------------------------------------------------------------------------------
// Rendering the workspace

function showPickErrors(errors) {
  const box = $('pick-errors');
  box.replaceChildren();
  if (!errors.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (errors.length === 1) box.append(h('p', { text: errors[0] }));
  else box.append(h('ul', { class: 'ms-plain-list' }, errors.map((e) => h('li', { text: e }))));
}

function renderWorkspace() {
  const entries = state.entries;
  $('workspace').hidden = false;
  $('pick-card').classList.add('is-loaded');
  $('choose-btn').textContent = 'Choose other pictures';
  $('preview-title').textContent = single() ? 'Your picture' : `Your pictures (${entries.length})`;
  $('results-title').textContent = single() ? 'Your new file' : 'Your new files';
  $('go-btn').textContent = goLabel();
  $('go-stale').textContent = single()
    ? `Your choices have changed, so the new file was cleared. Press ${goLabel()} to make it again.`
    : `Your choices have changed, so the new files were cleared. Press ${goLabel()} to make them again.`;
  renderPreview();
  renderMetadata();
  renderEditAvailability();
  updateFormatOptions();
  refreshDerived();
}

// The engine says so when a file stops early or has broken parts.
function looksDamaged(entry) {
  return entry.info.warnings.some((w) => /cut short|damaged|ends without/i.test(w)) || entry.info.items.some((it) => /:damaged$/.test(it.id));
}

function fileFacts(entry) {
  return `${FORMAT_NAME[entry.format]}, ${fmtDims(entry.w, entry.h)}, ${fmtBytes(entry.bytes.length)}`;
}

function renderPreview() {
  const stage = $('stage');
  const missing = $('preview-missing');
  const list = $('file-list');
  const entry = current();
  $('crop-toggle').checked = false;
  $('crop-options').hidden = true;
  $('crop-layer').hidden = true;

  if (entry) {
    $('file-summary').textContent = fileFacts(entry);
    list.hidden = true;
    list.replaceChildren();
    if (entry.bitmap) {
      stage.hidden = false;
      missing.hidden = true;
      const canvas = $('preview-canvas');
      const size = fitSize(entry.w, entry.h, PREVIEW_LONG_EDGE);
      canvas.width = size.w;
      canvas.height = size.h;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, size.w, size.h);
      drawRegion(ctx, entry, entry.bitmap, fullRegion(entry), size.w, size.h);
      canvas.classList.toggle('is-pixelated', size.w < 400 && size.h < 400);
      layoutStage();
    } else {
      stage.hidden = true;
      missing.hidden = false;
      missing.textContent = entry.format === 'heic' ? HEIC_NO_PREVIEW : looksDamaged(entry) ? DAMAGED_NO_PREVIEW : OTHER_NO_PREVIEW;
    }
    $('crop-controls').hidden = false;
    $('crop-toggle').closest('label').hidden = !entry.bitmap;
    $('crop-multi').hidden = true;
    return;
  }

  stage.hidden = true;
  const total = state.entries.reduce((n, e) => n + e.bytes.length, 0);
  $('file-summary').textContent = `${state.entries.length} pictures, ${fmtBytes(total)} in all.`;
  const undecodable = state.entries.filter((e) => !e.decodable);
  missing.hidden = !undecodable.length;
  missing.textContent = undecodable.length
    ? `${plural(undecodable.length, 'picture cannot', 'pictures cannot')} be opened by this browser, so only their metadata can be removed. Cropping, resizing and changing format do not work for ${undecodable.length === 1 ? 'it' : 'them'}.`
    : '';
  list.hidden = false;
  list.replaceChildren(...state.entries.map((e, i) => {
    const reds = e.info.items.filter((it) => it.tier === 'red').length;
    const thumb = e.thumb || h('span', { class: 'ms-thumb ms-thumb-none', 'aria-hidden': 'true', text: FORMAT_NAME[e.format] });
    return h('li', { class: 'ms-file' },
      thumb,
      h('div', { class: 'ms-file-text' },
        h('p', { class: 'ms-file-name' }, h('span', { class: 'ms-file-number', text: `Picture ${i + 1}: ` }), e.file.name),
        h('p', { class: 'ms-file-meta', text: `${fileFacts(e)}. ${e.info.items.length ? `${plural(e.info.items.length, 'detail', 'details')}, ${fmtInt(reds)} red.` : 'No metadata.'}` })));
  }));
  $('crop-controls').hidden = false;
  $('crop-toggle').closest('label').hidden = true;
  $('crop-multi').hidden = false;
}

// Sizes the preview to the space available, keeping its shape. The crop frame is placed
// in percentages, so it follows without being recalculated.
function layoutStage() {
  const entry = current();
  const stage = $('stage');
  if (!entry || !entry.bitmap || stage.hidden) return;
  const avail = $('preview-wrap').clientWidth || 300;
  const maxH = Math.max(220, Math.round(window.innerHeight * 0.62));
  const s = Math.min(avail / entry.w, maxH / entry.h);
  const w = Math.max(1, Math.floor(entry.w * s));
  const ht = Math.max(1, Math.floor(entry.h * s));
  stage.style.width = `${w}px`;
  stage.style.height = `${ht}px`;
}

function tierBadge(tier) {
  return h('span', { class: 'tier-badge', dataset: { tier }, text: TIER_WORD[tier] });
}

// The read-only list of what remains in a new file, one block per group (Where, Who and
// so on), most sensitive first within a group.
function renderGroups(items, { idPrefix }) {
  const frag = document.createDocumentFragment();
  for (const group of GROUPS) {
    const inGroup = items
      .filter((it) => it.group === group.id)
      .map((it, n) => ({ it, n }))
      .sort((a, b) => (TIER_RANK[a.it.tier] - TIER_RANK[b.it.tier]) || (a.n - b.n))
      .map((x) => x.it);
    if (!inGroup.length) continue;
    const titleId = `${idPrefix}-g-${group.id}`;
    const block = h('section', { class: 'ms-group', 'aria-labelledby': titleId },
      h('h4', { class: 'ms-group-title', id: titleId, text: group.label }),
      h('p', { class: 'ms-group-desc', text: group.description }),
      h('ul', { class: 'ms-items' }, inGroup.map((it, n) => renderItem(it, { pick: false, id: `${idPrefix}-${group.id}-${n}` }))));
    frag.append(block);
  }
  return frag;
}

// The selection list, one section per tier (red, amber, green), each holding only the
// details this file has. A section has a tick box that ticks or unticks every detail of its
// tier, the tier's meaning, a count, and an arrow that shows or hides the details. Every
// section starts closed; the tick boxes say what goes. Details go by their own tier, so a
// red Content Credentials detail sits with the other red details. Within a section the
// details follow the group order (Where, Who, When, Device, Hidden extras, Technical),
// then the order the engine found them in, and each names its group.
function renderTiers(items) {
  const frag = document.createDocumentFragment();
  for (const tier of TIER_ORDER) {
    const inTier = items
      .map((it, n) => ({ it, n }))
      .filter((x) => x.it.tier === tier)
      .sort((a, b) => ((GROUP_RANK[a.it.group] ?? 99) - (GROUP_RANK[b.it.group] ?? 99)) || (a.n - b.n))
      .map((x) => x.it);
    if (!inTier.length) continue;
    // The group word is shown only when a section mixes groups; a tag that is the same on
    // every item (all green items are Technical) tells the reader nothing.
    const mixed = new Set(inTier.map((it) => it.group)).size > 1;
    const base = `m-tier-${tier}`;
    const open = false;
    const all = h('input', {
      type: 'checkbox', class: 'ms-tier-check', id: `${base}-all`,
      'aria-labelledby': `${base}-name ${base}-every`,
      'aria-describedby': `${base}-desc ${base}-count`,
      dataset: { tier },
    });
    const toggle = h('button', {
      type: 'button', class: 'ms-tier-toggle', id: `${base}-toggle`,
      'aria-expanded': String(open), 'aria-controls': `${base}-list`,
      dataset: { tier },
    },
    h('span', { class: 'visually-hidden', text: `${TIER_WORD[tier]} details` }),
    chevron());
    const block = h('section', { class: 'ms-tier', id: base, role: 'group', dataset: { tier }, 'aria-labelledby': `${base}-name` },
      h('div', { class: 'ms-tier-head' },
        all,
        h('div', { class: 'ms-tier-text' },
          // Only the badge is the tick box's label: a click on the heading words must not
          // untick a whole colour by surprise.
          h('h3', { class: 'ms-tier-title', id: `${base}-title`, 'aria-labelledby': `${base}-name` },
            h('label', { for: `${base}-all`, class: 'ms-tier-label' }, tierBadge(tier)),
            ' ',
            h('span', { class: 'ms-tier-name', text: `${TIERS[tier].label}.` })),
          // The name screen readers hear for the heading, the section and its tick box, with
          // a pause after the colour: "Red: Remove before sharing." The heading is a flex
          // box, so a colon placed inside it would be read as "Red :". Hidden from reading
          // order because the heading already says it.
          h('span', { class: 'visually-hidden', id: `${base}-name`, 'aria-hidden': 'true', text: `${TIER_WORD[tier]}: ${TIERS[tier].label}.` }),
          h('span', { class: 'visually-hidden', id: `${base}-every`, text: `Every ${tier} detail.` }),
          h('p', { class: 'ms-tier-desc', id: `${base}-desc`, text: TIERS[tier].description }),
          h('p', { class: 'ms-tier-count', id: `${base}-count` })),
        toggle),
      h('ul', { class: 'ms-items ms-tier-items', id: `${base}-list`, hidden: !open },
        inTier.map((it, n) => renderItem(it, { pick: true, id: `m-${tier}-${n}`, showGroup: mixed }))));
    frag.append(block);
  }
  return frag;
}

// The arrow on a tier section: it points down when the section is closed and turns to
// point up when it is open (see .ms-tier-toggle in style.css).
function chevron() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'ms-chevron');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2.2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function setTierOpen(tier, open) {
  const toggle = $(`m-tier-${tier}-toggle`);
  const list = $(`m-tier-${tier}-list`);
  if (!toggle || !list) return;
  toggle.setAttribute('aria-expanded', String(open));
  list.hidden = !open;
}

function itemValue(it) {
  if (!it.values || state.entries.length < 2) return it.value;
  const where = it.count === state.entries.length ? 'in every picture' : `in ${fmtInt(it.count)} of ${fmtInt(state.entries.length)} pictures`;
  return it.values.size > 1 ? `Differs between pictures, ${where}` : `${it.value} (${where})`;
}

// One item: its name with the tier and source beside it, then its value and note. The
// tier is always a word next to the colour. For a checkbox, the name is the label and the
// value, note and tier are its description, read in that order.
function renderItem(it, { pick, id, showGroup = false }) {
  // An item whose value cannot be read is still in the file and can still be removed.
  const value = itemValue(it) || 'Present, but its value cannot be read.';
  const valueEl = value ? h('span', { class: 'ms-item-value', id: `${id}-v`, text: value }) : null;
  const noteEl = it.note ? h('span', { class: 'ms-item-note', id: `${id}-n`, text: it.note }) : null;
  const meta = h('span', { class: 'ms-item-meta', id: `${id}-m` },
    // The spaces keep the words apart when read aloud; a flex row does not draw them.
    showGroup ? h('span', { class: 'ms-group-word', text: GROUP_LABEL[it.group] || it.group }) : null,
    showGroup ? ' ' : null,
    tierBadge(it.tier),
    ' ',
    h('span', { class: 'ms-source', text: it.source }),
    h('span', { class: 'visually-hidden', text: `, ${TIERS[it.tier].label}.` }));
  const top = h('span', { class: 'ms-item-top' },
    pick ? h('span', { class: 'visually-hidden', id: `${id}-r`, text: 'Remove' }) : null,
    h('span', { class: 'ms-item-label', id: `${id}-l`, text: it.label }),
    meta);
  const body = h('span', { class: 'ms-item-body' }, top, valueEl, noteEl);
  if (!pick) return h('li', { class: 'ms-item ms-item-static', dataset: { tier: it.tier, id: it.id } }, body);
  const box = h('input', {
    type: 'checkbox', class: 'ms-check', id: `${id}-c`,
    'aria-labelledby': `${id}-r ${id}-l`,
    'aria-describedby': [valueEl && `${id}-v`, noteEl && `${id}-n`, `${id}-m`].filter(Boolean).join(' '),
    dataset: { id: it.id },
  });
  box.checked = state.selected.has(it.id);
  return h('li', { class: 'ms-item-li' },
    h('label', { class: `ms-item${box.checked ? ' is-ticked' : ''}`, for: `${id}-c`, dataset: { tier: it.tier } }, box, body));
}

function renderMetadata() {
  const groups = $('meta-groups');
  const empty = $('meta-empty');
  const hasItems = state.rows.length > 0;
  groups.replaceChildren(renderTiers(state.rows));
  empty.hidden = hasItems;
  empty.textContent = single()
    ? 'This file has no metadata. There is nothing hidden to remove.'
    : 'These files have no metadata. There is nothing hidden to remove.';
  $('meta-intro').hidden = !hasItems;
  $('select-count').hidden = !hasItems;

  const warnings = [];
  state.entries.forEach((e, i) => {
    for (const w of e.info.warnings) warnings.push(single() ? w : `Picture ${i + 1}: ${w}`);
  });
  const list = $('meta-warnings');
  list.hidden = !warnings.length;
  list.replaceChildren(...warnings.map((w) => h('li', { class: 'ms-note', dataset: { tier: 'amber' }, text: w })));
  syncSelectionUi();
}

function syncSelectionUi() {
  for (const box of document.querySelectorAll('#meta-groups .ms-check')) {
    box.checked = state.selected.has(box.dataset.id);
    box.closest('.ms-item').classList.toggle('is-ticked', box.checked);
  }
  // Each tier's own tick box: ticked when every detail of the tier is, half-ticked when some are.
  for (const all of document.querySelectorAll('#meta-groups .ms-tier-check')) {
    const tier = all.dataset.tier;
    const rows = state.rows.filter((r) => r.tier === tier);
    const n = rows.filter((r) => state.selected.has(r.id)).length;
    all.checked = rows.length > 0 && n === rows.length;
    all.indeterminate = n > 0 && n < rows.length;
    const count = $(`m-tier-${tier}-count`);
    if (count) count.textContent = `${plural(rows.length, 'detail', 'details')}, ${fmtInt(n)} ticked`;
  }
  const total = state.rows.length;
  const ticked = state.rows.filter((r) => state.selected.has(r.id)).length;
  $('select-count').textContent = `${fmtInt(ticked)} of ${plural(total, 'detail', 'details')} ticked for removal.`;
}

// Size and format need the picture itself. When the browser cannot open any of the
// pictures, the controls are hidden and disabled, and the reason is shown instead.
function renderEditAvailability() {
  const decodable = state.entries.some((e) => e.decodable);
  const note = $('edit-unavailable');
  const controls = [...document.querySelectorAll('#resize-set input, #resize-set select, #format-select, #background-input')];
  for (const c of controls) c.disabled = !decodable;
  $('resize-set').hidden = !decodable;
  $('format-field').hidden = !decodable;
  if (!decodable) {
    note.hidden = false;
    const heic = state.entries.every((e) => e.format === 'heic');
    // The preview card already shows the full sentence, so this card says only what it
    // means here, and in the singular when there is one picture.
    if (heic && single()) note.textContent = 'This browser cannot open HEIC pictures, so the size and format cannot be changed here. Removing metadata still works.';
    else if (single()) note.textContent = 'This browser cannot open this picture, so it can only have its metadata removed. Cropping, resizing and changing format do not work here.';
    else note.textContent = 'This browser cannot open these pictures, so they can only have their metadata removed. Cropping, resizing and changing format do not work here.';
    document.querySelector('input[name="resize"][value="none"]').checked = true;
    $('format-select').value = 'same';
  } else {
    note.hidden = true;
  }
}

async function updateFormatOptions() {
  const select = $('format-select');
  const webp = await canEncodeWebp();
  const option = select.querySelector('option[value="webp"]');
  // Hidden options are not hidden on every phone, so an unusable one is removed.
  if (!webp && option) {
    if (select.value === 'webp') select.value = 'same';
    option.remove();
  }
  const same = select.querySelector('option[value="same"]');
  const entry = current();
  same.textContent = entry ? `Same as the original (${FORMAT_NAME[entry.format]})` : 'Same as each original';
}

// ---------------------------------------------------------------------------------------
// Reading the options

function readOptions() {
  const mode = document.querySelector('input[name="resize"]:checked')?.value || 'none';
  const resize = { mode };
  let error = null;
  let field = null;
  if (mode === 'percent') {
    const v = parseNumber($('resize-percent').value);
    if (!(v >= 1 && v <= 100)) { error = 'Enter a percentage from 1 to 100.'; field = 'resize-percent'; }
    resize.value = v;
  } else if (mode === 'edge') {
    const v = Math.round(parseNumber($('resize-edge').value));
    if (!(v >= MIN_EDGE)) { error = `Enter a number of pixels, ${MIN_EDGE} or more.`; field = 'resize-edge'; }
    resize.value = v;
  } else if (mode === 'size') {
    // A unit typed in the box wins over the list beside it: "500 KB" means 500 KB.
    const text = $('resize-size').value;
    const typed = /kb\s*$/i.test(text) ? 1000 : /mb\s*$/i.test(text) ? 1000000 : 0;
    const v = parseNumber(text);
    const bytes = Math.round(v * (typed || Number($('resize-unit').value)));
    if (!(bytes >= 5000)) { error = 'Enter a file size of at least 5 KB.'; field = 'resize-size'; }
    resize.bytes = bytes;
  }
  const format = $('format-select').value;
  const background = $('background-input').value || '#ffffff';
  const cropOn = single() && state.crop.on && !!state.crop.rect;
  // A copy of the choices, so a click while the files are being made cannot change
  // the work half way through.
  return {
    resize, format, background, cropOn, error, field,
    selected: new Set(state.selected),
    cropRect: cropOn ? { ...state.crop.rect } : null,
  };
}

function cropRegion(entry, opts) {
  if (!opts.cropOn || !opts.cropRect || entry !== current()) return null;
  const r = opts.cropRect;
  const x = Math.max(0, Math.min(entry.w - 1, Math.round(r.x)));
  const y = Math.max(0, Math.min(entry.h - 1, Math.round(r.y)));
  const w = Math.max(1, Math.min(entry.w - x, Math.round(r.w)));
  const ht = Math.max(1, Math.min(entry.h - y, Math.round(r.h)));
  if (x === 0 && y === 0 && w === entry.w && ht === entry.h) return null;
  return { x, y, w, h: ht };
}

// What will happen to one file with the current choices. Used both to explain the choice
// before the button is pressed and to do the work after.
function planEntry(entry, opts, webpOk) {
  const info = entry.info;
  const remove = new Set(info.items.filter((it) => opts.selected.has(it.id)).map((it) => it.id));
  const rotationIds = info.items.filter((it) => ROTATION_ID.test(it.id)).map((it) => it.id);
  const warnings = [];
  const notes = [];
  let bake = (info.orientation || 1) !== 1 && rotationIds.some((id) => remove.has(id));
  const crop = cropRegion(entry, opts);
  const region = crop || fullRegion(entry);
  let scale = 1;
  if (opts.resize.mode === 'percent' && opts.resize.value) scale = Math.min(1, opts.resize.value / 100);
  else if (opts.resize.mode === 'edge' && opts.resize.value) scale = Math.min(1, opts.resize.value / Math.max(region.w, region.h));
  const outW = Math.max(1, Math.round(region.w * scale));
  const outH = Math.max(1, Math.round(region.h * scale));
  const resized = outW < region.w || outH < region.h;
  const wanted = opts.format === 'same' ? entry.format : opts.format;
  const convert = wanted !== entry.format;
  const sizeLimit = opts.resize.mode === 'size' ? opts.resize.bytes : null;

  if (!entry.decodable) {
    if (bake) {
      for (const id of rotationIds) remove.delete(id);
      bake = false;
      warnings.push('This browser cannot open the picture, so its rotation setting was kept to keep it the right way up.');
    }
    if (crop || resized || convert || sizeLimit) {
      warnings.push('This browser cannot open the picture, so it was not cropped, resized or converted. Only the metadata was removed.');
    }
    return { remove, region, bake: false, crop: null, resized: false, convert: false, resave: false, sizeLimit: null, scale: 1, outW: region.w, outH: region.h, enc: entry.format, warnings, notes, decodable: false };
  }

  let enc = wanted;
  if (enc === 'heic') {
    enc = 'jpeg';
    notes.push('HEIC cannot be saved by a browser, so the re-saved picture is a JPEG.');
  }
  if (enc === 'webp' && !webpOk) {
    enc = 'png';
    notes.push('This browser cannot save WebP, so the re-saved picture is a PNG.');
  }
  const resave = bake || !!crop || resized || convert;
  return { remove, region, bake, crop, resized, convert, resave, sizeLimit, scale, outW, outH, enc, warnings, notes, decodable: true };
}

// Whether the new file would be the original again: nothing ticked that it holds, and
// nothing that re-saves it. A size limit the file already meets changes nothing either.
// XMP that is not yet in the engine's standard form is always written again (normalise),
// so such a file changes even with nothing ticked.
function changesNothing(entry, plan) {
  if (plan.remove.size || plan.resave || (entry.info && entry.info.normalise)) return false;
  return !plan.sizeLimit || entry.bytes.length <= plan.sizeLimit;
}

const nothingToDo = (plans) => plans.every((p, i) => changesNothing(state.entries[i], p));

// What the page says, instead of making an identical copy, when the button is pressed
// and no file would change. It names only the choices this page can actually offer.
function nothingMessage(plans) {
  const many = state.entries.length > 1;
  const hasItems = state.rows.length > 0;
  const editable = plans.some((p) => p.decodable);
  const fits = plans.some((p) => p.sizeLimit);
  if (!hasItems && !editable) {
    return many
      ? 'Nothing to change: these files have no metadata, and this browser cannot crop, resize or convert them.'
      : 'Nothing to change: this file has no metadata, and this browser cannot crop, resize or convert it.';
  }
  const facts = [];
  if (!hasItems) facts.push(many ? 'these files have no metadata' : 'this file has no metadata');
  if (fits) facts.push(many ? 'the pictures are already under the size limit' : 'the picture is already under the size limit');
  const choose = fits
    ? (many ? 'choose a smaller size or another format' : 'choose a crop, a smaller size or another format')
    : (many ? 'choose a size or format' : 'choose a crop, size or format');
  const asks = [hasItems ? 'tick something to remove' : null, editable ? choose : null].filter(Boolean).join(', or ');
  if (!facts.length) return `Nothing to change yet: ${asks}.`;
  return `Nothing to change yet: ${listText(facts)}. ${asks[0].toUpperCase()}${asks.slice(1)}.`;
}

// ---------------------------------------------------------------------------------------
// Explaining the current choice

let webpKnown = true;

function refreshDerived() {
  if (!state.entries.length) return;
  const opts = readOptions();
  const err = $('resize-error');
  err.hidden = !opts.error;
  err.textContent = opts.error || '';
  const plans = state.entries.map((e) => planEntry(e, opts, webpKnown));

  // Edit notes
  const notes = [];
  const fromAlpha = state.entries.some((e) => e.decodable && (e.format === 'png' || e.format === 'webp'));
  $('background-field').hidden = !(fromAlpha && opts.format === 'jpeg');
  if (fromAlpha && opts.format === 'jpeg') notes.push('JPEG has no see-through areas, so they are filled with the colour you choose. White is the default.');
  if (opts.format === 'png' && state.entries.some((e) => e.format === 'jpeg')) notes.push('PNG makes a photo much larger and does not improve its quality.');
  if (opts.resize.mode === 'size' && plans.some((p) => p.decodable && p.enc === 'png')) notes.push('PNG is lossless, so the only way to make the file smaller is to make the picture smaller. Choose JPEG for a much smaller file.');
  if (state.entries.some((e) => e.format === 'heic' && e.decodable) && (opts.format === 'same' || opts.format === 'heic')) notes.push('If the picture is re-saved, it becomes a JPEG: browsers cannot save HEIC.');
  const editNotes = $('edit-notes');
  editNotes.hidden = !notes.length;
  editNotes.replaceChildren(...notes.map((n) => h('li', { class: 'ms-note', text: n })));

  // Mode line
  const line = $('mode-line');
  const reasons = $('mode-reasons');
  const box = $('mode-box');
  const items = [];
  const anyResave = plans.some((p) => p.resave);
  if (plans.some((p) => p.bake)) items.push('The rotation setting is being removed, so the picture is turned the right way up in its pixels and re-saved. Without this it would appear on its side.');
  if (plans.some((p) => p.crop)) {
    const p = plans.find((x) => x.crop);
    items.push(`Cropped to ${fmtDims(p.crop.w, p.crop.h)}.`);
  }
  if (plans.some((p) => p.resized)) {
    if (single()) items.push(`Resized to ${fmtDims(plans[0].outW, plans[0].outH)}.`);
    else items.push(opts.resize.mode === 'percent' ? `Resized to ${fmtInt(opts.resize.value)} per cent.` : `Resized so the longest side is at most ${fmtInt(opts.resize.value)} pixels.`);
  }
  if (plans.some((p) => p.convert)) items.push(`Saved as ${FORMAT_NAME[opts.format] || 'a new format'}.`);
  const keptOther = anyResave && state.entries.some((e, i) => plans[i].resave && e.info.items.some((it) => !plans[i].remove.has(it.id) && !it.id.startsWith('exif:') && it.tier !== 'green'));
  if (anyResave) items.push(keptOther
    ? 'Only the EXIF details you keep are written back. Other kept details, such as XMP, IPTC and PNG text, are left out, and colours are converted to sRGB, the standard web colour space.'
    : 'Only the EXIF details you keep are written back, and colours are converted to sRGB, the standard web colour space.');
  for (const p of plans) for (const w of p.warnings) if (!items.includes(w)) items.push(w);

  if (anyResave) {
    line.textContent = RESAVE_LINE;
    box.dataset.tier = 'amber';
  } else if (opts.resize.mode === 'size' && plans.some((p) => p.decodable)) {
    line.textContent = 'Lossless if the file is already under the size limit. If it is not, the picture is re-saved at a smaller size, which is lossy.';
    box.dataset.tier = 'amber';
  } else {
    line.textContent = 'Lossless: only the metadata is touched. The picture itself is not re-saved.';
    box.dataset.tier = 'green';
  }
  // With nothing to change no file is made, so neither lossless nor re-saved applies.
  const idle = nothingToDo(plans);
  if (idle) {
    line.textContent = single()
      ? 'With these choices the new file would be the same as the original.'
      : 'With these choices each new file would be the same as its original.';
    delete box.dataset.tier;
  }
  if (!plans.some((p) => p.remove.size) && state.rows.length && !idle) items.unshift('Nothing is ticked, so the new file keeps all its metadata.');
  reasons.hidden = !items.length;
  reasons.replaceChildren(...items.map((t) => h('li', { class: 'ms-note', text: t })));

  // Expected name
  const base = cleanName($('name-input').value);
  if (single()) {
    const p = plans[0];
    const items = state.entries[0].info.items;
    // As the engine does: the HDR gain map and its XMP description go together (a gain map
    // without its description cannot be found), and take along what lives in it and the
    // index and ISO segment that point to it. Rebuilding the multi-picture index for its
    // image IDs or layout details also leaves out its unexplained data.
    const gainGone = items.some((it) => GAIN_MAP_IDS.has(it.id)) && [...GAIN_MAP_OWN].some((id) => p.remove.has(id));
    const mpfRebuilt = p.remove.has('jpeg:mpf:ids') || p.remove.has('jpeg:mpf:layout');
    const withGainMap = (id) => GAIN_MAP_OWN.has(id) || id.startsWith(`${GAIN_MAP_ID}:`) || id.startsWith(`${HEIC_GAIN_MAP_ID}:`) || id.startsWith('jpeg:mpf:') || id.startsWith('jpeg:isogain:');
    const gone = (id) => p.remove.has(id) || (gainGone && withGainMap(id)) || (id === 'jpeg:mpf:extra' && mpfRebuilt);
    const remaining = items.filter((it) => !gone(it.id));
    const ext = EXT[p.resave || p.sizeLimit ? p.enc : state.entries[0].format];
    $('name-preview').textContent = `Expected name: ${base}.${privacyWord(remaining)}.${ext}. The privacy word is confirmed by reading the new file back.`;
  } else {
    $('name-preview').textContent = `Expected names: ${base}-1, ${base}-2 and so on, each followed by its privacy word and file type.`;
  }
  // Once shown, the "nothing to change" message follows the choices: it goes as soon as
  // there is something to do.
  const nothing = $('go-nothing');
  if (!nothing.hidden) {
    if (idle && !opts.error) nothing.textContent = nothingMessage(plans);
    else nothing.hidden = true;
  }
  // The button stays usable with a typing mistake in a size field, and when nothing would
  // change: pressing it then explains why, which a disabled button cannot do.
  $('go-btn').disabled = state.busy;
}

// The name typed by the user, made safe for a file name. The tier and extension are
// always added by us, so a typed extension or tier word is dropped.
function cleanName(text) {
  let name = String(text || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+|[.\s]+$/g, '');
  name = name.replace(/\.(jpe?g|png|webp|heic|heif)$/i, '').replace(/\.(public|minimal|clean|custom)$/i, '');
  if (name.length > 80) name = name.slice(0, 80).trim();
  return name || 'image';
}

// ---------------------------------------------------------------------------------------
// Making the new files

class TooBig extends Error {
  constructor(w, h, fit) {
    super('canvas too large');
    this.w = w;
    this.h = h;
    this.fit = fit;
  }
}

function canvasWorks(w, h) {
  const c = document.createElement('canvas');
  try {
    c.width = w;
    c.height = h;
    if (c.width !== w || c.height !== h) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#000';
    ctx.fillRect(w - 1, h - 1, 1, 1);
    return ctx.getImageData(w - 1, h - 1, 1, 1).data[3] === 255;
  } catch {
    return false;
  } finally {
    releaseCanvas(c);
  }
}

// The nearest size, keeping the shape, that this browser can actually draw. Known limits
// first (desktop browsers, then iOS), so only a few test canvases are ever made.
function nearestWorkable(w, h) {
  const limits = [[32767, 268435456], [16384, 268435456], [16384, 16777216], [8192, 16777216], [4096, 4194304], [2048, 4194304]];
  for (const [side, area] of limits) {
    const s = Math.min(1, side / Math.max(w, h), Math.sqrt(area / (w * h))) * 0.999;
    const tw = Math.max(1, Math.floor(w * s));
    const th = Math.max(1, Math.floor(h * s));
    if (canvasWorks(tw, th)) return { w: tw, h: th };
  }
  return null;
}

function makeCanvas(w, h) {
  if (w * h > SAFE_CANVAS_AREA || w > 16384 || h > 16384) {
    if (!canvasWorks(w, h)) throw new TooBig(w, h, nearestWorkable(w, h));
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' }) || canvas.getContext('2d');
  if (!ctx || canvas.width !== w || canvas.height !== h) throw new TooBig(w, h, nearestWorkable(w, h));
  return { canvas, ctx };
}

// Re-saves one picture: draw, encode, write back the kept EXIF, then remove anything the
// encoder added or the user ticked, so the file holds only what the user chose to keep.
function makeEncoder(entry, plan, bitmap, opts) {
  const kept = entry.info.items.filter((it) => !plan.remove.has(it.id)).map((it) => it.id);
  const sourceIds = new Set(entry.info.items.map((it) => it.id));
  const exif = buildExif(entry.bytes, kept);
  const fill = plan.enc === 'jpeg' ? opts.background : null;
  const region = plan.region;
  const cache = new Map();
  return async (scale, quality) => {
    const tw = Math.max(1, Math.round(region.w * scale));
    const th = Math.max(1, Math.round(region.h * scale));
    const key = `${tw}x${th}@${quality}`;
    if (cache.has(key)) return cache.get(key);
    const { canvas, ctx } = makeCanvas(tw, th);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, tw, th);
    }
    drawRegion(ctx, entry, bitmap, region, tw, th);
    const blob = await canvasBlob(canvas, MIME[plan.enc], quality);
    releaseCanvas(canvas);
    if (!blob || blob.type !== MIME[plan.enc]) {
      if (!blob) throw new TooBig(tw, th, nearestWorkable(tw, th));
      throw new Error(`This browser could not save a ${FORMAT_NAME[plan.enc]} file.`);
    }
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (exif) bytes = insertExif(bytes, plan.enc, exif);
    const after = await inspect(bytes);
    const extra = after.items.filter((it) => plan.remove.has(it.id) || !sourceIds.has(it.id)).map((it) => it.id);
    if (extra.length) bytes = (await scrub(bytes, extra)).bytes;
    const result = { bytes, width: tw, height: th, quality: plan.enc === 'png' ? null : quality, scale };
    cache.set(key, result);
    return result;
  };
}

// Finds the largest scale in [lo, hi] whose file fits `target` bytes, in a handful of tries.
// File size grows roughly with the number of pixels, so each guess scales by the square
// root of the size ratio, and the search narrows between the best fit and the smallest miss.
async function searchScale(encode, quality, lo, hi, target, tries) {
  let fit = null;
  let miss = null;
  let smallest = null;
  let s = hi;
  for (let i = 0; i < tries; i++) {
    const r = await encode(s, quality);
    if (!smallest || r.bytes.length < smallest.bytes.length) smallest = r;
    if (r.bytes.length <= target) {
      if (!fit || s > fit.scale) fit = r;
      if (s >= hi || r.bytes.length >= target * CLOSE_ENOUGH) break;
    } else {
      if (!miss || s < miss.scale) miss = r;
      if (s <= lo) break;
    }
    let next = s * Math.sqrt(target / r.bytes.length) * (r.bytes.length > target ? 0.97 : 1);
    if (fit && miss && !(next > fit.scale && next < miss.scale)) next = (fit.scale + miss.scale) / 2;
    next = Math.min(hi, Math.max(lo, next));
    if (miss && next >= miss.scale) next = Math.max(lo, miss.scale * 0.85);
    if (fit && next <= fit.scale) break;
    if (Math.abs(next - s) < 1e-4) break;
    s = next;
  }
  return { fit, smallest };
}

async function fitToSize(encode, plan, maxBytes) {
  const target = Math.floor(maxBytes * TARGET_SHARE);
  const long = Math.max(plan.region.w, plan.region.h);
  const tiny = Math.min(1, MIN_EDGE / long);
  if (plan.enc === 'png') {
    const { fit, smallest } = await searchScale(encode, undefined, tiny, 1, target, 9);
    return fit ? { ...fit, fitted: true } : { ...smallest, fitted: false };
  }
  const floor = Math.min(1, FLOOR_EDGE / long);
  let { fit, smallest } = await searchScale(encode, SIZE_QUALITY, floor, 1, target, 7);
  if (fit) return { ...fit, fitted: true };
  for (const q of QUALITY_STEPS) {
    const r = await encode(floor, q);
    if (r.bytes.length < smallest.bytes.length) smallest = r;
    if (r.bytes.length <= target) return { ...r, fitted: true };
  }
  const last = await searchScale(encode, QUALITY_STEPS[QUALITY_STEPS.length - 1], tiny, floor, target, 7);
  if (last.fit) return { ...last.fit, fitted: true };
  return { ...(last.smallest.bytes.length < smallest.bytes.length ? last.smallest : smallest), fitted: false };
}

async function processEntry(entry, opts, webpOk) {
  const plan = planEntry(entry, opts, webpOk);
  const notes = [...plan.notes];
  const warnings = [...plan.warnings];
  let out = null;

  if (!plan.resave) {
    const res = await scrub(entry.bytes, plan.remove);
    warnings.push(...res.warnings);
    const over = plan.sizeLimit && res.bytes.length > plan.sizeLimit;
    if (!over || !plan.decodable) {
      if (plan.sizeLimit && !over) notes.push('The file is already under the size limit, so the picture was not re-saved.');
      if (over) warnings.push(`The file is still over the size limit (${fmtBytes(res.bytes.length)}).`);
      out = { bytes: res.bytes, format: entry.format, width: plan.region.w, height: plan.region.h, quality: null, lossless: true };
    } else {
      notes.push('The file was over the size limit, so the picture was re-saved at a smaller size.');
    }
  }

  if (!out) {
    const { bitmap, owned } = await getBitmap(entry);
    try {
      const encode = makeEncoder(entry, plan, bitmap, opts);
      let r;
      if (plan.sizeLimit) {
        r = await fitToSize(encode, plan, plan.sizeLimit);
        if (!r.fitted) warnings.push(`This picture could not be brought under ${fmtBytes(plan.sizeLimit)}. The smallest version is shown.`);
        if (plan.enc === 'png' && r.scale < 1) notes.push('PNG can only be made smaller by making the picture smaller.');
      } else {
        r = await encode(plan.scale, RESAVE_QUALITY[plan.enc]);
      }
      out = { bytes: r.bytes, format: plan.enc, width: r.width, height: r.height, quality: r.quality, lossless: false };
      if (plan.bake) notes.push('The picture was turned the right way up in its pixels, because its rotation setting was removed.');
    } finally {
      if (owned) bitmap.close();
    }
  }

  const readback = await inspect(out.bytes);
  if (!out.lossless) {
    // Measured, not assumed: whatever the user kept that the new file does not hold.
    const present = new Set(readback.items.map((it) => it.id));
    const lost = entry.info.items.filter((it) => !plan.remove.has(it.id) && !present.has(it.id));
    // "Content Credentials (C2PA)" already names its source, so it is not repeated.
    const named = (it) => (it.label.includes(`(${it.source})`) ? it.label : `${it.label} (${it.source})`);
    if (lost.length) notes.push(`You kept these, but re-saving the picture left them out: ${listText([...new Set(lost.map(named))])}.`);
  }
  return { ...out, readback, word: privacyWord(readback.items), notes, warnings };
}

async function run() {
  if (state.busy || !state.entries.length) return;
  const opts = readOptions();
  if (opts.error) {
    $('resize-error').hidden = false;
    $('resize-error').textContent = opts.error;
    if (opts.field) $(opts.field).focus();
    announce(opts.error);
    return;
  }
  const webpOk = await canEncodeWebp();
  const nothing = $('go-nothing');
  const plans = state.entries.map((e) => planEntry(e, opts, webpOk));
  if (nothingToDo(plans)) {
    // Every file would come out as it went in. Say so beside the button, where the
    // person is, and leave the focus there.
    const msg = nothingMessage(plans);
    nothing.textContent = msg;
    nothing.hidden = false;
    $('go-stale').hidden = true;
    nothing.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
    announce(msg);
    return;
  }
  nothing.hidden = true;
  const loadToken = state.loadToken;
  const version = state.choiceVersion;
  state.busy = true;
  const btn = $('go-btn');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = 'Working…';
  clearResults();
  $('go-stale').hidden = true;
  announce(single() ? 'Making the new file.' : 'Making the new files.');
  // Let the button repaint before the work starts.
  await new Promise((r) => setTimeout(r, 30));

  const results = [];
  for (const [index, entry] of state.entries.entries()) {
    try {
      results.push({ entry, index, ...(await processEntry(entry, opts, webpOk)) });
    } catch (err) {
      results.push({ entry, index, error: err });
    }
  }

  state.busy = false;
  btn.removeAttribute('aria-busy');
  btn.textContent = goLabel();
  // Other pictures were loaded, or the choices changed, while this was running: the
  // files made no longer match the screen, so they are not offered.
  if (loadToken !== state.loadToken) {
    refreshDerived();
    return;
  }
  if (version !== state.choiceVersion) {
    $('go-stale').hidden = false;
    refreshDerived();
    announce(`Your choices changed while the ${single() ? 'file was' : 'files were'} being made. Press ${goLabel()} again.`);
    return;
  }
  state.results = results;
  renderResults();
  refreshDerived();

  const ok = results.filter((r) => !r.error);
  const names = ok.map((r) => resultName(r));
  const remaining = ok.reduce((n, r) => n + r.readback.items.length, 0);
  let msg;
  if (!ok.length) msg = 'The new file could not be made. The reason is shown under Your new file.';
  else if (ok.length === 1 && results.length === 1) msg = `Done. ${names[0]} is ready to save. ${remaining ? `${plural(remaining, 'detail remains', 'details remain')} in it.` : 'No metadata remains.'}`;
  else msg = `Done. ${plural(ok.length, 'file is', 'files are')} ready to save${ok.length < results.length ? `, ${fmtInt(results.length - ok.length)} failed` : ''}.`;
  announce(msg);
  const section = $('results');
  section.focus({ preventScroll: true });
  section.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------------------
// Results

function resultName(r) {
  const base = cleanName($('name-input').value);
  const n = state.entries.length > 1 ? `-${r.index + 1}` : '';
  return `${base}${n}.${r.word}.${EXT[r.format]}`;
}

function clearResults() {
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls = [];
  state.results = [];
  $('results-list').replaceChildren();
  $('results').hidden = true;
}

function renderResults() {
  const list = $('results-list');
  list.replaceChildren(...state.results.map((r) => renderResult(r)));
  $('results').hidden = false;
}

function tierCounts(items) {
  const parts = TIER_ORDER.map((t) => ({ t, n: items.filter((it) => it.tier === t).length })).filter((x) => x.n);
  return parts.map((x) => `${fmtInt(x.n)} ${x.t}`).join(', ');
}

function renderResult(r) {
  const many = state.entries.length > 1;
  const headId = `r${r.index}-name`;
  if (r.error) {
    const err = r.error;
    const body = [];
    if (err instanceof TooBig) {
      body.push(h('p', { text: `This browser cannot make a picture of ${fmtDims(err.w, err.h)}.` }));
      if (err.fit) {
        body.push(h('p', { text: `The largest it can make here is ${fmtDims(err.fit.w, err.fit.h)}.` }));
        body.push(h('button', {
          type: 'button', class: 'btn btn-secondary',
          onclick: () => useWorkableSize(err.fit),
        }, `Use ${fmtDims(err.fit.w, err.fit.h)} instead`));
      } else {
        body.push(h('p', { text: 'Try a smaller size with Limit the longest side.' }));
      }
    } else {
      body.push(h('p', { text: `The new file could not be made. ${err && err.message ? err.message : ''}`.trim() }));
    }
    return h('article', { class: 'ms-result', 'aria-labelledby': headId },
      h('h3', { class: 'ms-result-title', id: headId, text: many ? `Picture ${r.index + 1}: ${r.entry.file.name}` : 'Something went wrong' }),
      h('div', { class: 'ms-notice', dataset: { tier: 'red' }, role: 'alert' }, body));
  }

  const name = resultName(r);
  const blob = new Blob([r.bytes], { type: MIME[r.format] });
  const url = URL.createObjectURL(blob);
  state.urls.push(url);
  const info = PRIVACY[r.word];
  const hasRed = r.readback.items.some((it) => it.tier === 'red');
  // The word is public only because the HDR gain map stayed, still usable (with its XMP
  // description when the photo had one): say why, and how to get minimal.
  const notGreen = r.readback.items.filter((it) => it.tier !== 'green');
  const kept = (id) => notGreen.some((it) => it.id === id);
  const hadDescription = r.entry.info.items.some((it) => it.id === 'xmp:gainmap');
  const keptOnlyGainMap = r.word === 'public' && [...GAIN_MAP_IDS].some(kept) && (!hadDescription || kept('xmp:gainmap'))
    && notGreen.every((it) => it.tier === 'amber' && GAIN_MAP_OWN.has(it.id));
  const facts = [`${FORMAT_NAME[r.format]}, ${fmtDims(r.width, r.height)}, ${fmtBytes(r.bytes.length)}.`];
  facts.push(r.lossless
    ? 'Lossless: the picture itself was not re-saved.'
    : `Re-saved${r.quality ? ` at quality ${Math.round(r.quality * 100)} per cent` : ''}.`);

  const link = h('a', { class: 'btn btn-primary ms-download', href: url, download: name, dataset: { result: String(r.index) } },
    h('span', { text: 'Save ' }), h('span', { class: 'ms-download-name', text: name }));

  const notes = [...r.notes.map((t) => ({ t, tier: null })), ...r.warnings.map((t) => ({ t, tier: 'amber' }))];
  const items = r.readback.items;
  const remainsTitle = 'This is what remains in the new file';
  let readback;
  if (!items.length) {
    readback = h('p', { class: 'ms-notice', dataset: { tier: 'green' }, text: 'No metadata remains.' });
  } else {
    const groups = renderGroups(items, { idPrefix: `r${r.index}` });
    readback = many
      ? h('details', { class: 'ms-readback' },
        h('summary', { text: `${remainsTitle}: ${plural(items.length, 'detail', 'details')} (${tierCounts(items)})` }),
        h('div', { class: 'ms-groups' }, groups))
      : h('div', { class: 'ms-readback' },
        h('h4', { class: 'ms-readback-title', text: remainsTitle }),
        h('div', { class: 'ms-groups' }, groups));
  }
  if (many && !items.length) readback = h('p', { class: 'ms-notice', dataset: { tier: 'green' }, text: `${remainsTitle}: nothing. No metadata remains.` });

  const article = h('article', { class: 'ms-result', 'aria-labelledby': headId },
    h('div', { class: 'ms-result-head' },
      single() ? h('canvas', { class: 'ms-result-preview', 'aria-hidden': 'true', hidden: true }) : null,
      h('div', { class: 'ms-result-main' },
        many ? h('p', { class: 'ms-result-from', text: `Picture ${r.index + 1}, from ${r.entry.file.name}` }) : null,
        h('h3', { class: 'ms-result-title', id: headId }, h('span', { class: 'ms-result-name', text: name })),
        h('p', { class: 'ms-result-facts', text: facts.join(' ') }),
        h('div', { class: 'ms-word-row', dataset: { tier: info.tier } },
          h('span', { class: 'tier-badge ms-word', dataset: { tier: info.tier }, text: r.word }),
          h('span', { class: 'ms-word-text', text: info.text })),
        r.word === 'custom' && hasRed ? h('p', { class: 'ms-word-warning', text: CUSTOM_WARNING }) : null,
        keptOnlyGainMap ? h('p', { class: 'ms-word-note', text: GAIN_MAP_KEPT_NOTE }) : null,
        link)),
    notes.length ? h('ul', { class: 'ms-notes' }, notes.map((n) => h('li', { class: 'ms-note', dataset: n.tier ? { tier: n.tier } : null, text: n.t }))) : null,
    readback);

  if (single()) drawResultPreview(article.querySelector('.ms-result-preview'), blob);
  return article;
}

async function drawResultPreview(canvas, blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const size = fitSize(bmp.width, bmp.height, 480);
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, size.w, size.h);
    bmp.close();
    canvas.hidden = false;
  } catch {
    canvas.hidden = true;
  }
}

function renameResults() {
  for (const link of document.querySelectorAll('#results-list .ms-download')) {
    const r = state.results.find((x) => String(x.index) === link.dataset.result);
    if (!r) continue;
    const name = resultName(r);
    link.download = name;
    link.querySelector('.ms-download-name').textContent = name;
    const title = link.closest('.ms-result').querySelector('.ms-result-name');
    if (title) title.textContent = name;
  }
}

function useWorkableSize(fit) {
  document.querySelector('input[name="resize"][value="edge"]').checked = true;
  $('resize-edge').value = String(Math.max(fit.w, fit.h));
  refreshDerived();
  run();
}

// Any change to the choices clears the new file, so what can be saved always
// matches what is on screen.
function choicesChanged() {
  state.choiceVersion += 1;
  if (state.results.length) {
    clearResults();
    $('go-stale').hidden = false;
  }
  refreshDerived();
}

// ---------------------------------------------------------------------------------------
// Crop frame

function cropMin(entry) {
  return Math.max(1, Math.min(MIN_EDGE, entry.w, entry.h));
}

// The largest frame of the given shape, centred on the picture.
function largestWithRatio(entry, ratio) {
  let w = entry.w;
  let ht = w / ratio;
  if (ht > entry.h) {
    ht = entry.h;
    w = ht * ratio;
  }
  return { x: (entry.w - w) / 2, y: (entry.h - ht) / 2, w, h: ht };
}

function setCropRect(rect) {
  const entry = current();
  if (!entry) return;
  const min = cropMin(entry);
  let { x, y, w, h: ht } = rect;
  w = Math.max(min, Math.min(entry.w, w));
  ht = Math.max(min, Math.min(entry.h, ht));
  x = Math.max(0, Math.min(entry.w - w, x));
  y = Math.max(0, Math.min(entry.h - ht, y));
  state.crop.rect = { x, y, w, h: ht };
  placeCropBox();
}

function placeCropBox() {
  const entry = current();
  const r = state.crop.rect;
  if (!entry || !r) return;
  const box = $('crop-box');
  box.style.left = `${(r.x / entry.w) * 100}%`;
  box.style.top = `${(r.y / entry.h) * 100}%`;
  box.style.width = `${(r.w / entry.w) * 100}%`;
  box.style.height = `${(r.h / entry.h) * 100}%`;
  box.classList.toggle('is-locked', !!RATIOS[state.crop.ratio]);
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  $('crop-readout').textContent = `Crop: ${fmtDims(Math.round(r.w), Math.round(r.h))}, starting ${fmtInt(x)} from the left and ${fmtInt(y)} from the top.`;
}

function setCropOn(on) {
  const entry = current();
  state.crop.on = on && !!entry && !!entry.bitmap;
  $('crop-options').hidden = !state.crop.on;
  $('crop-layer').hidden = !state.crop.on;
  if (state.crop.on && !state.crop.rect) applyRatio(state.crop.ratio);
  choicesChanged();
}

function applyRatio(id) {
  const entry = current();
  if (!entry) return;
  state.crop.ratio = id in RATIOS ? id : 'free';
  for (const btn of document.querySelectorAll('#crop-ratios [data-ratio]')) btn.setAttribute('aria-pressed', String(btn.dataset.ratio === state.crop.ratio));
  const ratio = RATIOS[state.crop.ratio];
  if (ratio) setCropRect(largestWithRatio(entry, ratio));
  else if (!state.crop.rect) setCropRect({ x: entry.w * 0.05, y: entry.h * 0.05, w: entry.w * 0.9, h: entry.h * 0.9 });
  else placeCropBox();
}

// Resizing from a handle. Edges move freely; with a fixed shape only the corners are
// shown, and the size follows whichever direction the pointer moved further.
function resizeFrom(start, handle, dx, dy) {
  const entry = current();
  const ratio = RATIOS[state.crop.ratio];
  const min = cropMin(entry);
  let l = start.x;
  let t = start.y;
  let r = start.x + start.w;
  let b = start.y + start.h;
  if (!ratio) {
    if (handle.includes('w')) l = Math.max(0, Math.min(r - min, l + dx));
    if (handle.includes('e')) r = Math.min(entry.w, Math.max(l + min, r + dx));
    if (handle.includes('n')) t = Math.max(0, Math.min(b - min, t + dy));
    if (handle.includes('s')) b = Math.min(entry.h, Math.max(t + min, b + dy));
    return { x: l, y: t, w: r - l, h: b - t };
  }
  const west = handle.includes('w');
  const north = handle.includes('n');
  const wFromX = start.w + (west ? -dx : dx);
  const wFromY = (start.h + (north ? -dy : dy)) * ratio;
  let w = Math.abs(dx) >= Math.abs(dy * ratio) ? wFromX : wFromY;
  const maxW = Math.min(west ? r : entry.w - l, (north ? b : entry.h - t) * ratio);
  w = Math.max(Math.max(min, min * ratio), Math.min(maxW, w));
  const ht = w / ratio;
  return { x: west ? r - w : l, y: north ? b - ht : t, w, h: ht };
}

let drag = null;

function onCropPointerDown(ev) {
  const handleEl = ev.target.closest('[data-handle]');
  const boxEl = ev.target.closest('#crop-box');
  if (!boxEl || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
  ev.preventDefault();
  boxEl.focus({ preventScroll: true });
  const stageRect = $('stage').getBoundingClientRect();
  drag = {
    id: ev.pointerId,
    mode: handleEl ? handleEl.dataset.handle : 'move',
    x: ev.clientX,
    y: ev.clientY,
    start: { ...state.crop.rect },
    kx: current().w / stageRect.width,
    ky: current().h / stageRect.height,
  };
  try { $('crop-layer').setPointerCapture(ev.pointerId); } catch { /* capture is a nicety */ }
}

function onCropPointerMove(ev) {
  if (!drag || ev.pointerId !== drag.id) return;
  ev.preventDefault();
  const dx = (ev.clientX - drag.x) * drag.kx;
  const dy = (ev.clientY - drag.y) * drag.ky;
  if (drag.mode === 'move') setCropRect({ ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy });
  else setCropRect(resizeFrom(drag.start, drag.mode, dx, dy));
}

function onCropPointerUp(ev) {
  if (!drag || ev.pointerId !== drag.id) return;
  drag = null;
  try { $('crop-layer').releasePointerCapture(ev.pointerId); } catch { /* already released */ }
  choicesChanged();
}

let cropAnnounceTimer = 0;
function onCropKey(ev) {
  const keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const move = keys[ev.key];
  if (!move) return;
  ev.preventDefault();
  const entry = current();
  const r = state.crop.rect;
  const step = Math.max(1, Math.round(Math.max(entry.w, entry.h) / 100));
  const [mx, my] = move;
  if (!ev.shiftKey) {
    setCropRect({ ...r, x: r.x + mx * step, y: r.y + my * step });
  } else {
    const ratio = RATIOS[state.crop.ratio];
    if (ratio) {
      const grow = mx > 0 || my > 0 ? 1 : -1;
      const w = Math.min(r.w + grow * step, entry.w - r.x, (entry.h - r.y) * ratio);
      setCropRect({ ...r, w: Math.max(cropMin(entry), w), h: Math.max(cropMin(entry), w) / ratio });
    } else {
      setCropRect({ ...r, w: Math.min(entry.w - r.x, r.w + mx * step), h: Math.min(entry.h - r.y, r.h + my * step) });
    }
  }
  choicesChanged();
  // Read the new size out once the keys stop, not on every press.
  clearTimeout(cropAnnounceTimer);
  cropAnnounceTimer = setTimeout(() => announce($('crop-readout').textContent), 400);
}

// ---------------------------------------------------------------------------------------
// Starting again

function resetAll() {
  state.loadToken += 1;
  clearResults();
  for (const e of state.entries) if (e.bitmap) e.bitmap.close();
  state.entries = [];
  state.rows = [];
  state.selected = new Set();
  state.crop = { on: false, ratio: 'free', rect: null };
  $('meta-groups').replaceChildren();
  $('select-count').textContent = '';
  $('workspace').hidden = true;
  $('pick-card').classList.remove('is-loaded');
  $('go-stale').hidden = true;
  $('go-nothing').hidden = true;
  if (!state.busy) $('go-btn').textContent = goLabel();
  $('choose-btn').textContent = 'Choose pictures';
  for (const btn of document.querySelectorAll('#crop-ratios [data-ratio]')) btn.setAttribute('aria-pressed', String(btn.dataset.ratio === 'free'));
}

// ---------------------------------------------------------------------------------------
// Wiring

function gateOpen() {
  return !!document.querySelector('.sb-gate-overlay');
}

function init() {
  canEncodeWebp().then((ok) => { webpKnown = ok; });

  const input = $('file-input');
  $('choose-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    loadFiles(files);
  });

  // Dropping anywhere on the page loads the pictures, so a near miss never makes the
  // browser leave the page to show the file instead.
  const zone = $('drop-zone');
  let depth = 0;
  const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (ev) => {
    if (!hasFiles(ev)) return;
    depth += 1;
    zone.classList.add('is-over');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('is-over');
  });
  window.addEventListener('dragover', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = gateOpen() ? 'none' : 'copy';
  });
  window.addEventListener('drop', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth = 0;
    zone.classList.remove('is-over');
    if (gateOpen() || state.busy) return;
    loadFiles(ev.dataTransfer.files);
  });

  $('reset-btn').addEventListener('click', () => {
    resetAll();
    // Starting again also brings the size and format back to their defaults.
    document.querySelector('input[name="resize"][value="none"]').checked = true;
    $('format-select').value = 'same';
    $('background-input').value = '#ffffff';
    showPickErrors([]);
    announce('Cleared. Choose pictures to start again.');
    $('choose-btn').focus();
  });

  $('meta-groups').addEventListener('change', (ev) => {
    const all = ev.target.closest('.ms-tier-check');
    if (all) {
      // A half-ticked box becomes ticked when pressed, so a press ticks the whole tier.
      for (const r of state.rows) {
        if (r.tier !== all.dataset.tier) continue;
        if (all.checked) state.selected.add(r.id);
        else state.selected.delete(r.id);
      }
      syncSelectionUi();
      choicesChanged();
      announce($('select-count').textContent);
      return;
    }
    const box = ev.target.closest('.ms-check');
    if (!box) return;
    if (box.checked) state.selected.add(box.dataset.id);
    else state.selected.delete(box.dataset.id);
    syncSelectionUi();
    choicesChanged();
  });
  $('meta-groups').addEventListener('click', (ev) => {
    const toggle = ev.target.closest('.ms-tier-toggle');
    if (!toggle) return;
    setTierOpen(toggle.dataset.tier, toggle.getAttribute('aria-expanded') !== 'true');
  });

  $('crop-toggle').addEventListener('change', (ev) => setCropOn(ev.target.checked));
  $('crop-ratios').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-ratio]');
    if (!btn) return;
    applyRatio(btn.dataset.ratio);
    choicesChanged();
  });
  const layer = $('crop-layer');
  layer.addEventListener('pointerdown', onCropPointerDown);
  layer.addEventListener('pointermove', onCropPointerMove);
  layer.addEventListener('pointerup', onCropPointerUp);
  layer.addEventListener('pointercancel', onCropPointerUp);
  $('crop-box').addEventListener('keydown', onCropKey);

  // The file name sits in this card too, but a new name changes no picture: it only
  // renames the file to save (below), so it never clears the new file.
  const editCard = $('edit-card');
  const isName = (ev) => ev.target.id === 'name-input';
  editCard.addEventListener('change', (ev) => {
    if (!isName(ev)) choicesChanged();
  });
  editCard.addEventListener('input', (ev) => {
    if (isName(ev)) return;
    // Typing in a size field picks its option, so the number typed is the one used.
    const field = ev.target.closest('.ms-radio-row')?.querySelector('input[type="radio"]');
    if (field && ev.target.type === 'text') field.checked = true;
    choicesChanged();
  });

  $('name-input').addEventListener('input', () => {
    renameResults();
    refreshDerived();
  });
  $('go-btn').addEventListener('click', run);

  if (typeof ResizeObserver === 'function') new ResizeObserver(() => layoutStage()).observe($('preview-wrap'));
  window.addEventListener('resize', layoutStage);
}

init();
