// @ts-check
// DOM-free core shared by the browser, the server and the tests: palette, cells, pixel tools,
// image conversion and the .ANS / UTF-8 encoders and .ANS decoder.

export const MAX_COLS = 320;
export const MAX_ROWS = 1000;
export const MAX_CELLS = 100_000; // keeps the 8x16-per-cell canvas inside every browser's size limit
export const MAX_PROMPT = 500;

/** IBM VGA palette in ANSI order (SGR 30-37), followed by the bright (bold) variants. */
export const PALETTE = [
  [0, 0, 0], [170, 0, 0], [0, 170, 0], [170, 85, 0], [0, 0, 170], [170, 0, 170], [0, 170, 170], [170, 170, 170],
  [85, 85, 85], [255, 85, 85], [85, 255, 85], [255, 255, 85], [85, 85, 255], [255, 85, 255], [85, 255, 255], [255, 255, 255],
];

/** Code page 437 as Unicode, indexed by byte. NUL is '\0' so that looking up a typed space finds 0x20. */
export const CP437 = '\0☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼'
  + Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')
  + '⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

const [SPACE, FULL, LOWER, UPPER] = [0x20, 0xdb, 0xdc, 0xdf];
/** Bytes viewers act on instead of drawing (tab, line feed, carriage return, SUB, ESC); never written as glyphs. */
export const CONTROL = [0x09, 0x0a, 0x0d, 0x1a, 0x1b];

/**
 * Artwork is a grid of text cells, each a CP437 character with foreground and background palette indices.
 * Pixel tools see a cell as two square pixels, its upper and lower half-blocks.
 * @typedef {{ cols: number, rows: number, ch: Uint8Array, fg: Uint8Array, bg: Uint8Array }} Art
 */

/** @returns {Art} a blank canvas: spaces on black */
export function createArt(/** @type {number} */ cols, /** @type {number} */ rows) {
  const n = cols * rows;
  return { cols, rows, ch: new Uint8Array(n).fill(SPACE), fg: new Uint8Array(n).fill(7), bg: new Uint8Array(n) };
}

export const cloneArt = (/** @type {Art} */ art) => ({ ...art, ch: art.ch.slice(), fg: art.fg.slice(), bg: art.bg.slice() });

/**
 * Clamp a requested size to the limits; the row cap shrinks as columns grow so the cell count stays renderable.
 * @returns {[number, number]} columns and rows
 */
export function fitSize(/** @type {number} */ cols, /** @type {number} */ rows) {
  const c = Math.min(MAX_COLS, Math.max(1, Math.round(cols) || 1));
  return [c, Math.min(MAX_ROWS, Math.floor(MAX_CELLS / c), Math.max(1, Math.round(rows) || 1))];
}

/** Copy art into a new size, keeping the top-left overlap; new cells are blank. */
export function resize(/** @type {Art} */ art, /** @type {number} */ cols, /** @type {number} */ rows) {
  const out = createArt(cols, rows), w = Math.min(cols, art.cols);
  for (let r = 0; r < Math.min(rows, art.rows); r++) {
    for (const k of /** @type {const} */ (['ch', 'fg', 'bg'])) out[k].set(art[k].subarray(r * art.cols, r * art.cols + w), r * cols);
  }
  return out;
}

/** The [upper, lower] colors of a block cell, or [-1, -1] for any other character (text, shading, lines). */
function halves(/** @type {Art} */ art, /** @type {number} */ i) {
  const c = art.ch[i], f = art.fg[i], b = art.bg[i];
  return c === SPACE ? [b, b] : c === FULL ? [f, f] : c === UPPER ? [f, b] : c === LOWER ? [b, f] : [-1, -1];
}

const inBounds = (/** @type {Art} */ art, /** @type {number} */ x, /** @type {number} */ y) => x >= 0 && x < art.cols && y >= 0 && y < art.rows * 2;

/** Color of the half-block pixel at (x, y): -1 when off the canvas or on a non-block character. */
export const getPixel = (/** @type {Art} */ art, /** @type {number} */ x, /** @type {number} */ y) =>
  (inBounds(art, x, y) ? halves(art, (y >> 1) * art.cols + x)[y & 1] : -1);

/** Paint one half-block pixel; off-canvas points are clipped. A non-block cell becomes blocks on its background. */
export function setPixel(/** @type {Art} */ art, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ color) {
  if (!inBounds(art, x, y)) return;
  const i = (y >> 1) * art.cols + x, h = halves(art, i);
  if (h[0] < 0) h.fill(art.bg[i]);
  h[y & 1] = color;
  [art.ch[i], art.fg[i], art.bg[i]] = [UPPER, h[0], h[1]];
}

/** Write one character cell; off-canvas cells are clipped. */
export function putChar(/** @type {Art} */ art, /** @type {number} */ col, /** @type {number} */ row, /** @type {number} */ code, /** @type {number} */ fg, /** @type {number} */ bg) {
  if (col < 0 || col >= art.cols || row < 0 || row >= art.rows) return;
  const i = row * art.cols + col;
  [art.ch[i], art.fg[i], art.bg[i]] = [code, fg, bg];
}

/** Build art from a pixel grid (two pixel rows per text row). */
export function fromPixels(/** @type {number} */ cols, /** @type {number} */ rows, /** @type {ArrayLike<number>} */ px) {
  const art = createArt(cols, rows);
  for (let y = 0; y < rows * 2; y++) for (let x = 0; x < cols; x++) setPixel(art, x, y, px[y * cols + x]);
  return art;
}

/** Nearest palette index by "redmean" weighted RGB distance, a cheap perceptual approximation. */
export function nearest(/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) {
  let best = 0, bestDistance = Infinity;
  PALETTE.forEach(([pr, pg, pb], i) => {
    const m = (r + pr) / 2, dr = r - pr, dg = g - pg, db = b - pb;
    const d = (2 + m / 256) * dr * dr + 4 * dg * dg + (2 + (255 - m) / 256) * db * db;
    if (d < bestDistance) [best, bestDistance] = [i, d];
  });
  return best;
}

const DIFFUSION = [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]; // Floyd-Steinberg
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]; // 4x4 ordered-dither thresholds

/**
 * Map opaque RGBA pixels to palette indices. 'diffusion' spreads the error (Floyd-Steinberg, photo-like);
 * 'ordered' adds a 4x4 Bayer pattern (regular hand-shaded texture); 'none' picks the nearest color.
 */
export function quantize(/** @type {ArrayLike<number>} */ rgba, /** @type {number} */ w, /** @type {number} */ h, /** @type {'none' | 'diffusion' | 'ordered'} */ mode = 'diffusion') {
  const out = new Uint8Array(w * h);
  const rgb = Float32Array.from({ length: w * h * 3 }, (_, i) => rgba[Math.floor(i / 3) * 4 + (i % 3)]);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = Math.floor(i / w);
    const bias = mode === 'ordered' ? (BAYER[(y % 4) * 4 + (x % 4)] / 16 - 15 / 32) * 85 : 0; // 85 = palette step
    const c = rgb.subarray(i * 3, i * 3 + 3).map((v) => Math.min(255, Math.max(0, v + bias)));
    out[i] = nearest(c[0], c[1], c[2]);
    if (mode !== 'diffusion') continue;
    for (const [dx, dy, k] of DIFFUSION) {
      if (x + dx < 0 || x + dx >= w || y + dy >= h) continue;
      const j = ((y + dy) * w + x + dx) * 3;
      for (let ch = 0; ch < 3; ch++) rgb[j + ch] += (c[ch] - PALETTE[out[i]][ch]) * k;
    }
  }
  return out;
}

/**
 * Remove speckle noise from a pixel grid in one pass. A pixel with fewer than `strength` same-colored pixels among
 * its eight neighbors takes their most common color, when that color outnumbers its own by at least two.
 * Strength 1 removes isolated pixels and keeps lines, edges and checkerboard dithering; 2 also removes pairs and
 * one-pixel spurs; 0 is off.
 */
export function despeckle(/** @type {Uint8Array} */ px, /** @type {number} */ cols, strength = 1) {
  const src = px.slice(), rows = px.length / cols, counts = new Uint8Array(16);
  for (let i = 0; i < px.length; i++) {
    const x = i % cols, y = (i - x) / cols;
    counts.fill(0);
    for (let ny = Math.max(0, y - 1); ny <= Math.min(rows - 1, y + 1); ny++) {
      for (let nx = Math.max(0, x - 1); nx <= Math.min(cols - 1, x + 1); nx++) if (nx !== x || ny !== y) counts[src[ny * cols + nx]]++;
    }
    const common = counts.indexOf(Math.max(...counts));
    if (counts[src[i]] < strength && counts[common] >= counts[src[i]] + 2) px[i] = common;
  }
}

/** Flood-fill the 4-connected pixel region at (x, y). Text and shading characters act as walls. */
export function fill(/** @type {Art} */ art, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ color) {
  const from = getPixel(art, x, y);
  if (from < 0 || from === color) return;
  for (let stack = [[x, y]], p = stack.pop(); p; p = stack.pop()) {
    if (getPixel(art, p[0], p[1]) !== from) continue;
    setPixel(art, p[0], p[1], color);
    stack.push([p[0] + 1, p[1]], [p[0] - 1, p[1]], [p[0], p[1] + 1], [p[0], p[1] - 1]);
  }
}

/** Visit every grid point on the line between two points (Bresenham), so fast pointer strokes leave no gaps. */
export function trace(/** @type {number} */ x0, /** @type {number} */ y0, /** @type {number} */ x1, /** @type {number} */ y1, /** @type {(x: number, y: number) => void} */ plot) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  for (let err = dx + dy; ; ) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) [err, x0] = [err + dy, x0 + sx];
    if (e2 <= dx) [err, y0] = [err + dx, y0 + sy];
  }
}

/** Paint a one-pixel line. Parts off the canvas are clipped. */
export const line = (/** @type {Art} */ art, /** @type {number} */ x0, /** @type {number} */ y0, /** @type {number} */ x1, /** @type {number} */ y1, /** @type {number} */ color) =>
  trace(x0, y0, x1, y1, (x, y) => setPixel(art, x, y, color));

/** Copy the painted cells of a block (a TheDraw text render) onto art with its top-left at (col, row). */
export function stamp(/** @type {Art} */ art, /** @type {Art & { mask: Uint8Array }} */ block, /** @type {number} */ col, /** @type {number} */ row) {
  for (let i = 0; i < block.ch.length; i++) {
    if (block.mask[i]) putChar(art, col + (i % block.cols), row + Math.floor(i / block.cols), block.ch[i], block.fg[i], block.bg[i]);
  }
}

/**
 * Paint a box or ellipse fitted to the rectangle between two corner pixels, filled or as a one-pixel outline.
 * A pixel is on the outline when it is inside but one of its four neighbors is not. Parts off the canvas are clipped.
 */
export function shape(/** @type {Art} */ art, /** @type {'box' | 'ellipse'} */ kind, /** @type {number} */ x0, /** @type {number} */ y0, /** @type {number} */ x1, /** @type {number} */ y1, /** @type {number} */ color, filled = false) {
  const [left, right, top, bottom] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
  const rx = (right - left + 1) / 2, ry = (bottom - top + 1) / 2;
  const inside = (/** @type {number} */ x, /** @type {number} */ y) => x >= left && x <= right && y >= top && y <= bottom
    && (kind === 'box' || ((x + 0.5 - left - rx) / rx) ** 2 + ((y + 0.5 - top - ry) / ry) ** 2 <= 1);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      if (inside(x, y) && (filled || edge)) setPixel(art, x, y, color);
    }
  }
}

/** The local calendar date as CCYYMMDD. */
const today = (d = new Date()) => String(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());

/**
 * Encode art as a classic .ANS file: CP437 bytes, SGR colors (bold = bright foreground, blink = bright background
 * under iCE colors) and a SAUCE record. Rows fill the full width and carry no line breaks, because viewers wrap at
 * the SAUCE width. Block cells are re-expressed with whichever of space, full, upper or lower block needs the
 * fewest attribute changes. With `ice: false`, bright backgrounds are avoided where a cell allows and darkened
 * where it does not, for BBS software that would blink them.
 * @param {Art} art
 * @param {{ title?: string, author?: string, group?: string, date?: string, ice?: boolean }} [meta] date is CCYYMMDD
 */
export function encode(art, { title = '', author = '', group = '', date = today(), ice = true } = {}) {
  /** @type {number[]} */
  const out = [];
  const put = (/** @type {string} */ s) => { for (const ch of s) out.push(ch.charCodeAt(0)); };
  let fg = 7, bg = 0, usedIce = false;
  put('\x1b[0m');
  for (let i = 0; i < art.ch.length; i++) {
    const [top, bottom] = halves(art, i);
    /** @type {[number, number, number][]} */
    const ways = top < 0 ? [[art.ch[i], art.fg[i], art.bg[i]]]
      : top === bottom ? [[SPACE, fg, top], [FULL, top, bg]] : [[UPPER, top, bottom], [LOWER, bottom, top]];
    const cost = (/** @type {[number, number, number]} */ [, f, g]) => +(f !== fg) + +(g !== bg) + (g > 7 ? (ice ? 3 : 100) : 0);
    const [ch, f, wanted] = ways.reduce((a, b) => (cost(b) < cost(a) ? b : a));
    const g = ice ? wanted : wanted & 7;
    if (f !== fg || g !== bg) {
      const sgr = [];
      if ((fg > 7 && f < 8) || (bg > 7 && g < 8)) { // only a reset clears bold/blink in every viewer
        sgr.push(0);
        [fg, bg] = [7, 0];
      }
      if (f > 7 && fg < 8) sgr.push(1);
      if (g > 7 && bg < 8) sgr.push(5);
      if ((f & 7) !== (fg & 7)) sgr.push(30 + (f & 7));
      if ((g & 7) !== (bg & 7)) sgr.push(40 + (g & 7));
      put(`\x1b[${sgr.join(';')}m`);
      [fg, bg, usedIce] = [f, g, usedIce || g > 7];
    }
    out.push(CONTROL.includes(ch) ? SPACE : ch);
  }
  put('\x1b[0m'); // also keeps the last glyph off the final byte, which PabloDraw never draws
  return Uint8Array.from([...out, 0x1a, ...sauce(art, out.length, usedIce, { title, author, group, date })]);
}

/** The 128-byte SAUCE 00 record (https://www.acid.org/info/sauce/sauce.htm). */
function sauce(/** @type {Art} */ art, /** @type {number} */ size, /** @type {boolean} */ ice, /** @type {Record<string, string>} */ m) {
  const rec = new Uint8Array(128), view = new DataView(rec.buffer);
  const text = (/** @type {number} */ at, /** @type {number} */ len, /** @type {string} */ s, pad = 0x20) => {
    for (let i = 0; i < len; i++) rec[at + i] = i >= s.length ? pad : CP437.indexOf(s[i]) >= 0x20 ? CP437.indexOf(s[i]) : 0x3f;
  };
  text(0, 7, 'SAUCE00');
  text(7, 35, m.title);
  text(42, 20, m.author);
  text(62, 20, m.group);
  text(82, 8, m.date);
  view.setUint32(90, size, true);
  rec[94] = 1; // DataType: Character
  rec[95] = 1; // FileType: ANSi
  view.setUint16(96, art.cols, true);
  view.setUint16(98, art.rows, true);
  rec[105] = (ice ? 1 : 0) | 0x02 | 0x10; // TFlags: iCE colors when used, 8-pixel font, square pixels (no DOS stretch)
  text(106, 22, 'IBM VGA', 0);
  return rec;
}

/** Text for modern terminals: Unicode characters, 16-color SGR with aixterm bright codes, and a reset per row. */
export function encodeUtf8(/** @type {Art} */ art) {
  let text = '';
  for (let r = 0; r < art.rows; r++) {
    let last = '';
    for (let i = r * art.cols; i < (r + 1) * art.cols; i++) {
      const f = art.fg[i], b = art.bg[i];
      const sgr = `\x1b[${f > 7 ? 82 + f : 30 + f};${b > 7 ? 92 + b : 40 + b}m`;
      if (sgr !== last) text += last = sgr;
      text += art.ch[i] ? CP437[art.ch[i]] : ' ';
    }
    text += '\x1b[0m\n';
  }
  return text;
}

/** xterm 256-color index to RGB, for importing files that use 38;5;n / 48;5;n. */
const xterm = (/** @type {number} */ n) => (n < 16 ? PALETTE[n] : n < 232
  ? [Math.floor((n - 16) / 36), Math.floor((n - 16) / 6) % 6, (n - 16) % 6].map((v) => (v ? 55 + v * 40 : 0))
  : Array(3).fill(8 + (n - 232) * 10));

/**
 * Read an .ANS file leniently, the way common viewers do: SAUCE width (default 80), immediate wrap at the last
 * column, SGR colors (classic, aixterm bright, 256-color and 24-bit mapped to the palette, PabloDraw's 24-bit 't'),
 * cursor movement, save/restore, erase, tabs, and SUB (0x1A) as end of text. Blink is a bright background only
 * under the SAUCE iCE flag. Content beyond the size limits is dropped, and `clipped` says so.
 */
export function decode(/** @type {Uint8Array} */ bytes) {
  let end = bytes.length, width = 80, sauceRows = 0, ice = false;
  const meta = { title: '', author: '', group: '' };
  const rec = bytes.subarray(bytes.length - 128);
  if (bytes.length >= 128 && String.fromCharCode(...rec.subarray(0, 5)) === 'SAUCE') {
    const view = new DataView(rec.buffer, rec.byteOffset), text = (/** @type {number} */ at, /** @type {number} */ len) =>
      Array.from(rec.subarray(at, at + len), (c) => CP437[c]).join('').split('\0')[0].trimEnd();
    const notes = Math.max(0, bytes.length - 133 - 64 * rec[104]); // the comment block, if its COMNT id is really there
    end = rec[104] && String.fromCharCode(...bytes.subarray(notes, notes + 5)) === 'COMNT' ? notes : bytes.length - 128;
    Object.assign(meta, { title: text(7, 35), author: text(42, 20), group: text(62, 20) });
    if (rec[94] === 1) [width, sauceRows, ice] = [view.getUint16(96, true) || 80, view.getUint16(98, true), (rec[105] & 1) === 1];
  }
  const sub = bytes.indexOf(0x1a);
  if (sub >= 0 && sub < end) end = sub;

  // Lines wrap at the file's own width; cells past the size limits are dropped.
  const [cols, rows] = fitSize(width, MAX_ROWS);
  let art = createArt(cols, rows);
  let x = 0, y = 0, fg = 7, bg = 0, bold = false, blink = false, inverse = false, saved = [0, 0], used = 0, clipped = false;
  /** @returns {[number, number]} the pen's colors: bold brightens the foreground, inverse swaps hues but keeps brightness */
  const pen = () => {
    const f = fg + (bold && fg < 8 ? 8 : 0), g = bg < 8 && blink && ice ? bg + 8 : bg;
    return inverse ? [(g & 7) | (f & 8), (f & 7) | (g & 8)] : [f, g];
  };
  for (let i = 0; i < end; i++) {
    if (x >= width) [x, y] = [0, y + 1]; // libansilove wraps lazily, before whatever byte follows a full row
    const b = bytes[i];
    if (b === 0x1b && bytes[i + 1] === 0x5b) {
      let j = i + 2;
      while (j < end && j < i + 64 && bytes[j] >= 0x20 && bytes[j] < 0x40) j++;
      if (!(j < end && bytes[j] >= 0x40 && bytes[j] <= 0x7e)) { // not a complete sequence: drop it, keep the byte that ended it
        i = j - 1;
        continue;
      }
      const params = String.fromCharCode(...bytes.subarray(i + 2, j)), cmd = String.fromCharCode(bytes[j]);
      i = j;
      if (/[^\d;:]/.test(params)) continue; // private modes (?, =) and intermediates such as font selection: ignored
      const p = params.split(/[;:]/).map((s) => parseInt(s, 10) || 0), n = Math.max(1, p[0]);
      if (cmd === 'm') {
        for (let k = 0; k < p.length; k++) {
          const v = p[k];
          if (v === 0) [fg, bg, bold, blink, inverse] = [7, 0, false, false, false];
          else if (v === 1) bold = true;
          else if (v === 5 || v === 6) blink = true;
          else if (v === 7) inverse = true;
          else if (v === 22) bold = false;
          else if (v === 25) blink = false;
          else if (v === 27) inverse = false;
          else if (v >= 30 && v <= 37) fg = v - 30;
          else if (v === 39) fg = 7;
          else if (v >= 40 && v <= 47) bg = v - 40;
          else if (v === 49) bg = 0;
          else if (v >= 90 && v <= 97) fg = v - 82;
          else if (v >= 100 && v <= 107) bg = v - 92;
          else if (v === 38 || v === 48) {
            if (p[k + 1] !== 5 && p[k + 1] !== 2) break; // an unknown color form: the rest is its data, not attributes
            const rgb = p[k + 1] === 5 ? xterm(p[k + 2] & 255) : p.slice(k + 2, k + 5);
            k += p[k + 1] === 5 ? 2 : 4;
            if (v === 38) fg = nearest(rgb[0], rgb[1], rgb[2]);
            else bg = nearest(rgb[0], rgb[1], rgb[2]);
          }
        }
      } else if (cmd === 't' && p.length === 4 && p[0] < 2) { // PabloDraw 24-bit: 0 = background, 1 = foreground
        if (p[0]) fg = nearest(p[1], p[2], p[3]);
        else bg = nearest(p[1], p[2], p[3]);
      } else if (cmd === 'A') y = Math.max(0, y - n);
      else if (cmd === 'B') y = Math.min(rows - 1, y + n);
      else if (cmd === 'C') x = Math.min(width - 1, x + n);
      else if (cmd === 'D') x = Math.max(0, x - n);
      else if (cmd === 'E') [x, y] = [0, y + n];
      else if (cmd === 'F') [x, y] = [0, Math.max(0, y - n)];
      else if (cmd === 'G') x = Math.min(width - 1, n - 1);
      else if (cmd === 'd') y = Math.min(rows - 1, n - 1);
      else if (cmd === 'H' || cmd === 'f') [y, x] = [Math.min(rows, Math.max(1, p[0])) - 1, Math.min(width, Math.max(1, p[1] ?? 1)) - 1];
      else if (cmd === 's') saved = [x, y];
      else if (cmd === 'u') [x, y] = saved;
      else if (cmd === 'J' && p[0] === 2) [art, x, y, used] = [createArt(cols, rows), 0, 0, 0];
      else if (cmd === 'K') {
        const [f, g] = pen();
        for (let c = p[0] ? 0 : x; c < Math.min(cols, p[0] === 1 ? x + 1 : width); c++) putChar(art, c, y, SPACE, f, g);
        if (g && y < rows) used = Math.max(used, y + 1); // a colored erase is visible
      }
      continue;
    }
    if (b === 0x0a) [x, y] = [0, y + 1];
    else if (b === 0x09) x = Math.min(width, (x & ~7) + 8);
    else if (b !== 0x0d && b !== 0x1b) {
      if (y >= rows) { // past the row limit: the rest is dropped
        clipped = true;
        break;
      }
      if (x < cols) {
        const [f, g] = pen();
        putChar(art, x, y, b, f, g);
        used = Math.max(used, y + 1);
      } else clipped = true;
      x++;
    }
  }
  return { art: resize(art, cols, Math.min(rows, Math.max(used, sauceRows, 1))), clipped, ...meta };
}
