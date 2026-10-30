// @ts-check
import { CONTROL, CP437, MAX_COLS, MAX_PROMPT, MAX_ROWS, PALETTE, cloneArt, createArt, decode, despeckle, encode, encodeUtf8, fill, fitSize, fromPixels, line, putChar, quantize, resize, shape, stamp, trace } from './ansi.js';
import { parseTdf, renderTdf } from './tdf.js';

const NAMES = ['Black', 'Red', 'Green', 'Brown', 'Blue', 'Magenta', 'Cyan', 'Light gray', 'Dark gray', 'Bright red', 'Bright green', 'Yellow', 'Bright blue', 'Bright magenta', 'Bright cyan', 'White'];
const CHARS = '░▒▓█▀▄▌▐■·─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▲▼◄►♥☺°∙'; // the first ten are on F1-F10
const MIRRORED = '▌▐┌┐└┘├┤╔╗╚╝╠╣◄►()<>[]{}/\\'; // pairs that swap when drawn mirrored
const RGBA = new Uint32Array(Uint8Array.from(PALETTE.flatMap((c) => [...c, 255])).buffer); // one pixel word per color
const STORE = 'ansi-studio';

const el = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
const canvas = /** @type {HTMLCanvasElement} */ (el('canvas'));
const view = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const frame = el('frame');
const overlay = Object.assign(document.createElement('img'), { alt: '', hidden: true });
el('cursor').before(overlay);
const status = (/** @type {string} */ text) => { el('status').textContent = text; };
const tool = () => /** @type {HTMLInputElement} */ (document.querySelector('input[name=tool]:checked')).value;
const font = new Uint8Array(await (await fetch('/vga.f16')).arrayBuffer());

let art = createArt(80, 25), fgColor = 15, bgColor = 0, brush = 0xb0, lastSvg = '';
/** @type {import('./ansi.js').Art[]} */
const past = [], future = [];
/** @type {{ image: HTMLImageElement, url: string, name: string } | null} */
let source = null;
/** @type {{ col: number, row: number, start: number, typed: boolean } | null} */
let cursor = null;
/** @type {{ x: number, y: number, row: number, tool: string, alt: boolean, before: import('./ansi.js').Art } | null} */
let stroke = null;
/** @type {ReturnType<typeof parseTdf>} */
let fonts = [];
let shown = createArt(0, 0), image = new ImageData(1, 1), words = new Uint32Array(1), saveTimer = 0;

/** Draw changed cells from the VGA font into the canvas (8x16 pixels per cell), then refresh the controls. */
function render() {
  const { cols, rows } = art, w = cols * 8, resized = canvas.width !== w || canvas.height !== rows * 16;
  if (resized) {
    Object.assign(canvas, { width: w, height: rows * 16 });
    frame.style.setProperty('--cols', cols);
    frame.style.setProperty('--rows', rows);
    image = view.createImageData(w, rows * 16);
    words = new Uint32Array(image.data.buffer);
  }
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
  for (let i = 0; i < art.ch.length; i++) {
    const c = art.ch[i], f = art.fg[i], b = art.bg[i];
    if (!resized && shown.ch[i] === c && shown.fg[i] === f && shown.bg[i] === b) continue;
    const col = i % cols, row = (i - col) / cols, fw = RGBA[f], bw = RGBA[b];
    for (let r = 0; r < 16; r++) {
      const bits = font[c * 16 + r], o = (row * 16 + r) * w + col * 8;
      for (let k = 0; k < 8; k++) words[o + k] = bits & (128 >> k) ? fw : bw;
    }
    [x0, y0, x1, y1] = [Math.min(x0, col), Math.min(y0, row), Math.max(x1, col), Math.max(y1, row)];
  }
  shown = cloneArt(art);
  if (x1 >= 0) view.putImageData(image, 0, 0, x0 * 8, y0 * 16, (x1 - x0 + 1) * 8, (y1 - y0 + 1) * 16);
  el('cols').value = cols;
  el('rows').value = rows;
  el('preset').value = `${cols}x${rows}`;
  if (el('preset').selectedIndex < 0) el('preset').value = '';
  placeCursor();
}

function placeCursor() {
  if (cursor && (cursor.col >= art.cols || cursor.row >= art.rows)) cursor = null; // the art shrank under it
  const box = el('cursor');
  box.hidden = !cursor || tool() !== 'text';
  if (!cursor || box.hidden) return;
  Object.assign(box.style, { left: `${(cursor.col / art.cols) * 100}%`, top: `${(cursor.row / art.rows) * 100}%`, width: `${100 / art.cols}%`, height: `${100 / art.rows}%` });
}

// History, autosave and sharing

/** Render after any change and autosave shortly after, as a .ans in browser storage. */
function changed() {
  render();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persist, 400);
}

/** Write a pending autosave now. Art that was only opened, not edited, never replaces the saved work. */
function persist() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(STORE, toBase64(encode(art, meta())));
  } catch {
    status('Autosave failed: browser storage is full or blocked. Download your work to keep it.');
  }
}

function save() {
  past.push(cloneArt(art));
  if (past.length > 50) past.shift();
  future.length = 0;
  if (cursor) cursor.typed = false; // typing after any other change starts its own undo step
}

function commit(/** @type {import('./ansi.js').Art} */ next) {
  stroke = null;
  save();
  art = next;
  changed();
}

/** Move one step between the undo and redo stacks. */
function step(/** @type {import('./ansi.js').Art[]} */ from, /** @type {import('./ansi.js').Art[]} */ to) {
  stroke = null;
  const next = from.pop();
  if (!next) return;
  to.push(art);
  art = next;
  if (cursor) cursor.typed = false;
  changed();
}

/** SAUCE fields; autosave and share links keep bright backgrounds whatever the export setting says. */
const meta = (ice = true) => ({ title: el('title').value, author: el('author').value, group: el('group').value, ice });

/** Show a decoded file: restores its SAUCE title, artist and group. */
function load(/** @type {ReturnType<typeof decode>} */ { art: next, clipped, title, author, group }, /** @type {string} */ message, undoable = true) {
  Object.entries({ title, author, group }).forEach(([id, value]) => { el(id).value = value; });
  if (undoable) commit(next);
  else art = next;
  status(message + (clipped ? ' Content past the size limit was dropped.' : ''));
}

const toBase64 = (/** @type {Uint8Array} */ bytes) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
};
const fromBase64 = (/** @type {string} */ text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const pipe = async (/** @type {Uint8Array<ArrayBuffer>} */ bytes, /** @type {CompressionStream | DecompressionStream} */ through) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(through)).arrayBuffer());

/** The art travels compressed inside the link's #fragment, so it never reaches the server. */
async function share() {
  const packed = await pipe(encode(art, meta()), new CompressionStream('deflate-raw'));
  const url = `${location.origin}${location.pathname}#art=${toBase64(packed).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  if (url.length > 60000) return status('Too large to share as a link. Download the .ans instead.');
  try {
    await navigator.clipboard.writeText(url);
    status('Share link copied.');
  } catch {
    window.prompt('Copy this link:', url);
  }
}

/** Open the art in the address's share link, if any. Undo returns to the art before it, which stays autosaved until the next edit. */
async function openShared() {
  const shared = /^#art=([\w-]+)$/.exec(location.hash)?.[1];
  if (!shared) return;
  history.replaceState(null, '', location.pathname);
  persist();
  try {
    const next = decode(await pipe(fromBase64(shared), new DecompressionStream('deflate-raw')));
    save();
    load(next, 'Opened shared art. Undo returns to your own work.', false);
  } catch {
    status('That share link is damaged.');
  }
  render();
}

// Images and generation

/** Scale an image to the art grid, flattening transparency onto black, then quantize and clean it up. */
function rasterize(/** @type {CanvasImageSource} */ picture, /** @type {number} */ cols, /** @type {number} */ rows, adjust = false) {
  const [w, h] = [cols, rows * 2];
  const g = /** @type {CanvasRenderingContext2D} */ (Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d', { willReadFrequently: true }));
  g.fillRect(0, 0, w, h);
  if (adjust) g.filter = `brightness(${el('brightness').value}%) contrast(${el('contrast').value}%) saturate(${el('saturation').value}%)`;
  g.imageSmoothingQuality = 'high';
  g.drawImage(picture, 0, 0, w, h);
  const px = quantize(g.getImageData(0, 0, w, h).data, w, h, el('dither').value);
  despeckle(px, w, Number(el('cleanup').value));
  return fromPixels(cols, rows, px);
}

/** Convert the loaded image at the current width, keeping its aspect ratio. Undo restores the previous art. */
function convert() {
  if (!source) return;
  const { naturalWidth: nw, naturalHeight: nh } = source.image;
  const [cols, rows] = fitSize(art.cols, (art.cols * nh) / nw / 2 || art.rows);
  commit(rasterize(source.image, cols, rows, true));
  status(`Converted ${source.name} to ${cols}x${rows}.`);
}

async function importImage(/** @type {File} */ file) {
  const url = URL.createObjectURL(file), picture = new Image();
  picture.src = url;
  try {
    await picture.decode();
  } catch {
    URL.revokeObjectURL(url);
    return status('Could not read that image.');
  }
  if (source) URL.revokeObjectURL(source.url);
  source = { image: picture, url, name: file.name };
  el('reference').disabled = false;
  showOverlay();
  convert();
}

function showOverlay() {
  overlay.hidden = !source || !el('trace').checked;
  if (source && !overlay.hidden) overlay.src = source.url;
  overlay.style.opacity = String(el('opacity').value / 100);
}

/** The loaded image as a JPEG data URL no larger than 512 pixels, for the model to look at. */
function referenceImage() {
  const picture = /** @type {HTMLImageElement} */ (source?.image), w = picture.naturalWidth || 512, h = picture.naturalHeight || 512;
  const scale = Math.min(1, 512 / Math.max(w, h));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(w * scale), height: Math.round(h * scale) });
  /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).drawImage(picture, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

/** Pin the SVG to the canvas size with hard edges, drop foreignObject (it taints canvases), and decode it. */
async function svgImage(/** @type {string} */ svg, /** @type {number} */ w, /** @type {number} */ h) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg' || doc.querySelector('parsererror')) throw new Error('The picture came back malformed. Try again.');
  doc.querySelectorAll('foreignObject').forEach((node) => node.remove());
  Object.entries({ width: w, height: h, 'shape-rendering': 'crispEdges' }).forEach(([k, v]) => root.setAttribute(k, String(v)));
  const picture = new Image();
  picture.src = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' }));
  try {
    await picture.decode();
    return picture;
  } finally {
    URL.revokeObjectURL(picture.src);
  }
}

async function generate() {
  const prompt = el('prompt').value.trim();
  if (!prompt) return status('Describe something to draw first.');
  const { cols, rows } = art;
  const request = {
    prompt, cols, rows, model: el('model').value || undefined,
    previous: el('revise').checked && lastSvg ? lastSvg : undefined,
    image: el('reference').checked && source ? referenceImage() : undefined,
  };
  el('generate').disabled = true;
  status('Generating. This can take a minute.');
  try {
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Generation failed (${res.status}).`);
    commit(rasterize(await svgImage(body.svg, cols, rows * 2), cols, rows));
    lastSvg = body.svg;
    el('revise').disabled = false;
    status('Done. Touch it up, revise it, or download it.');
  } catch (err) {
    status(err instanceof TypeError ? 'Network error. Check your connection and try again.' : String(/** @type {Error} */ (err).message));
  } finally {
    el('generate').disabled = false;
  }
}

// Files

async function openFile(/** @type {File} */ file) {
  try {
    load(decode(new Uint8Array(await file.arrayBuffer())), `Opened ${file.name}.`);
  } catch {
    status('Could not read that file.');
  }
}

const baseName = () => el('title').value.trim().replace(/[^\w-]+/g, '_') || 'art';

function download(/** @type {Blob} */ blob, /** @type {string} */ name) {
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href));
}

// Colors and characters

const swatches = PALETTE.map((rgb, i) => {
  const button = document.createElement('button');
  button.style.background = `rgb(${rgb})`;
  button.addEventListener('click', (e) => setColors(e.shiftKey ? fgColor : i, e.shiftKey ? i : bgColor));
  button.addEventListener('contextmenu', (e) => { e.preventDefault(); setColors(fgColor, i); });
  return button;
});
el('palette').append(...swatches);
function setColors(/** @type {number} */ f, /** @type {number} */ b) {
  [fgColor, bgColor] = [f, b];
  swatches.forEach((s, j) => {
    s.setAttribute('aria-pressed', String(j === f));
    s.classList.toggle('bg', j === b);
    s.title = NAMES[j] + (j === f ? ', foreground' : '') + (j === b ? ', background' : '');
  });
}

const charButtons = [...CHARS].map((c, i) => {
  const button = Object.assign(document.createElement('button'), { textContent: c, title: i < 10 ? `${c} (F${i + 1})` : c });
  button.addEventListener('click', () => {
    pickChar(CP437.indexOf(c));
    if (cursor && tool() === 'text') type(CP437.indexOf(c), 1);
  });
  return button;
});
el('chars').append(...charButtons);
function pickChar(/** @type {number} */ code) {
  brush = code;
  charButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === CP437[code])));
}
const flipChar = (/** @type {number} */ code) => {
  const k = MIRRORED.indexOf(CP437[code]);
  return k < 0 ? code : CP437.indexOf(MIRRORED[k ^ 1]);
};

// Drawing

/** Pointer position as a half-block pixel (x, y) and text row. Not clamped: the drawing functions clip. */
const at = (/** @type {PointerEvent} */ e) => {
  const fx = e.offsetX / canvas.clientWidth, fy = e.offsetY / canvas.clientHeight;
  return { x: Math.floor(fx * art.cols), y: Math.floor(fy * art.rows * 2), row: Math.floor(fy * art.rows) };
};

/** Run a paint step, then again mirrored across the vertical center when Mirror is on. */
function both(/** @type {(mx: (x: number) => number, flipped: boolean) => void} */ paint) {
  paint((x) => x, false);
  if (el('mirror').checked) paint((x) => art.cols - 1 - x, true);
}

canvas.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary) return;
  const p = at(e), t = tool(), alt = e.button === 2;
  if (t === 'text') {
    cursor = { col: p.x, row: p.row, start: p.x, typed: false };
    return placeCursor();
  }
  save();
  if (t === 'fill') {
    both((mx) => fill(art, mx(p.x), p.y, alt ? bgColor : fgColor));
    return changed();
  }
  stroke = { ...p, tool: t, alt, before: cloneArt(art) };
  canvas.setPointerCapture(e.pointerId);
  paintTo(p);
});
canvas.addEventListener('pointermove', (e) => { if (stroke && e.isPrimary) paintTo(at(e)); });
for (const name of ['pointerup', 'pointercancel']) canvas.addEventListener(name, (e) => { if (/** @type {PointerEvent} */ (e).isPrimary) stroke = null; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function paintTo(/** @type {{ x: number, y: number, row: number }} */ p) {
  const s = stroke;
  if (!s) return;
  const ink = s.alt ? bgColor : fgColor;
  if (s.tool === 'pencil') both((mx) => line(art, mx(s.x), s.y, mx(p.x), p.y, ink));
  else if (s.tool === 'brush') {
    both((mx, flipped) => trace(mx(s.x), s.row, mx(p.x), p.row, (c, r) => putChar(art, c, r, s.alt ? 0x20 : flipped ? flipChar(brush) : brush, fgColor, bgColor)));
  } else {
    for (const k of /** @type {const} */ (['ch', 'fg', 'bg'])) art[k].set(s.before[k]); // shapes preview from the pre-stroke art
    const kind = /** @type {'box' | 'ellipse'} */ (s.tool);
    both((mx) => (s.tool === 'line' ? line(art, mx(s.x), s.y, mx(p.x), p.y, ink) : shape(art, kind, mx(s.x), s.y, mx(p.x), p.y, ink, el('filled').checked)));
  }
  if (s.tool === 'pencil' || s.tool === 'brush') Object.assign(s, p);
  changed();
}

/** Type a character at the text cursor (dir 1) or erase the one before it (dir -1). One undo step per click. */
function type(/** @type {number} */ code, /** @type {number} */ dir) {
  if (!cursor) return;
  if (!cursor.typed) {
    save();
    cursor.typed = true;
  }
  if (dir < 0) cursor.col = Math.max(0, cursor.col - 1);
  putChar(art, cursor.col, cursor.row, code, fgColor, bgColor);
  if (dir > 0) cursor.col = Math.min(art.cols - 1, cursor.col + 1);
  changed();
}

document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('textarea, select, input:not([type=file], [type=checkbox], [type=radio])')) return;
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (mod && (key === 'z' || key === 'y')) {
    e.preventDefault();
    return key === 'y' || e.shiftKey ? step(future, past) : step(past, future);
  }
  // AltGr (Ctrl+Alt) and Option compose characters such as @ [ ] { } on many keyboards, so only Ctrl alone and Meta are shortcuts.
  if (!cursor || tool() !== 'text' || e.metaKey || (e.ctrlKey && !e.altKey)) return;
  const fkey = /^F([1-9]|10)$/.exec(e.key)?.[1];
  const code = fkey ? CP437.indexOf(CHARS[Number(fkey) - 1]) : e.key.length === 1 ? CP437.indexOf(e.key) : -1;
  const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (code > 0 && !CONTROL.includes(code)) type(code, 1);
  else if (e.key === 'Backspace') type(0x20, -1);
  else if (e.key === 'Enter') cursor = { ...cursor, col: cursor.start, row: Math.min(art.rows - 1, cursor.row + 1) };
  else if (e.key in moves) {
    const [dx, dy] = moves[/** @type {keyof typeof moves} */ (e.key)];
    cursor = { ...cursor, col: Math.min(art.cols - 1, Math.max(0, cursor.col + dx)), row: Math.min(art.rows - 1, Math.max(0, cursor.row + dy)) };
  } else if (e.key === 'Escape') cursor = null;
  else return;
  e.preventDefault();
  placeCursor();
});

// Wiring

/** Handle a picked file, then clear the input so picking the same file again works. */
const onFile = (/** @type {string} */ id, /** @type {(file: File) => void} */ handle) => el(id).addEventListener('change', (/** @type {any} */ e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) handle(file);
});
onFile('file', importImage);
onFile('open', openFile);
const stage = el('stage');
document.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
document.addEventListener('dragleave', () => stage.classList.remove('drop'));
document.addEventListener('drop', (e) => {
  stage.classList.remove('drop');
  const file = e.dataTransfer?.files[0];
  if (!file) return; // let text drops into the prompt box through
  e.preventDefault();
  if (/\.(ans|asc|diz|nfo|txt)$/i.test(file.name)) openFile(file);
  else importImage(file);
});
for (const id of ['dither', 'cleanup', 'brightness', 'contrast', 'saturation']) el(id).addEventListener('change', convert);
el('trace').addEventListener('change', showOverlay);
el('opacity').addEventListener('input', showOverlay);
el('grid').addEventListener('change', () => frame.classList.toggle('grid', el('grid').checked));
document.querySelectorAll('input[name=tool]').forEach((radio) => radio.addEventListener('change', placeCursor));

el('cols').max = MAX_COLS;
el('rows').max = MAX_ROWS;
el('prompt').maxLength = MAX_PROMPT;
el('preset').addEventListener('change', () => {
  const [cols, rows] = el('preset').value.split('x').map(Number);
  if (cols) commit(resize(art, cols, rows));
});
for (const id of ['cols', 'rows']) {
  el(id).addEventListener('change', () => commit(resize(art, ...fitSize(+el('cols').value || art.cols, +el('rows').value || art.rows))));
}
for (const id of ['title', 'author', 'group']) el(id).addEventListener('change', changed);

el('undo').addEventListener('click', () => step(past, future));
el('redo').addEventListener('click', () => step(future, past));
el('clear').addEventListener('click', () => commit(createArt(art.cols, art.rows)));
el('generate').addEventListener('click', generate);
el('download').addEventListener('click', () => download(new Blob([encode(art, meta(el('ice').checked))]), `${baseName()}.ans`));
el('png').addEventListener('click', () => canvas.toBlob((blob) => blob && download(blob, `${baseName()}.png`)));
el('utf8').addEventListener('click', () => download(new Blob([encodeUtf8(art)], { type: 'text/plain;charset=utf-8' }), `${baseName()}.utf8.ans`));
el('share').addEventListener('click', share);
addEventListener('pagehide', persist);
addEventListener('hashchange', openShared);

onFile('tdf', async (file) => {
  try {
    fonts = parseTdf(new Uint8Array(await file.arrayBuffer()));
    el('tdf-font').replaceChildren(...fonts.map((f, i) => new Option(f.name, String(i))));
    el('tdf-font').hidden = fonts.length < 2;
    status(`Loaded ${fonts.length} font${fonts.length === 1 ? '' : 's'} from ${file.name}.`);
  } catch (err) {
    fonts = [];
    status(`Could not read that TheDraw font: ${/** @type {Error} */ (err).message}`);
  }
});
el('tdf-place').addEventListener('click', () => {
  const font = fonts[Number(el('tdf-font').value) || 0], text = el('tdf-text').value;
  if (!font) return status('Load a TheDraw font first.');
  if (!text.trim()) return status('Type some logo text first.');
  const block = renderTdf(font, text, fgColor, bgColor), next = cloneArt(art);
  stamp(next, block, cursor?.col ?? 0, cursor?.row ?? 0);
  commit(next);
  status(`Placed "${text}" (${block.cols}x${block.rows}). Use the Text tool to choose where it goes.`);
});

fetch('/api/models')
  .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
  .then((/** @type {{ models: string[] }} */ { models }) => {
    el('model').replaceChildren(...models.map((id) => new Option(id, id)));
    el('model').hidden = models.length < 2;
  })
  .catch(() => status('Prompt generation is unavailable right now. Drawing and images still work.'));

// Panels remember being collapsed in this browser. Storage can be unavailable (private mode); panels then start open.
document.querySelectorAll('aside details').forEach((panel, i) => {
  const key = `${STORE}-panel-${i}`, details = /** @type {HTMLDetailsElement} */ (panel);
  try { details.open = localStorage.getItem(key) !== 'closed'; } catch { /* keep the default */ }
  details.addEventListener('toggle', () => { try { localStorage.setItem(key, details.open ? 'open' : 'closed'); } catch { /* best effort */ } });
});

setColors(fgColor, bgColor);
pickChar(brush);
try {
  const saved = localStorage.getItem(STORE);
  if (saved) load(decode(fromBase64(saved)), '', false);
} catch {
  status('Could not restore your autosaved work.');
}
render();
await openShared();
