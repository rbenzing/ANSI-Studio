// @ts-check
// TheDraw fonts (.TDF), the scene's standard for big logo lettering: parse a font file, then render text with one
// of its fonts into a block of cells that ansi.js's stamp() places on the art.
import { CP437, createArt } from './ansi.js';

const SIGNATURE = '\x13TheDraw FONTS file\x1a';
const [OUTLINE, COLOR] = [0, 2]; // font types; 1 is a block font, drawn in the chosen colors
// Outline fonts store the letters '@' to 'O' as stand-ins for line-drawing pieces. This is the first of the 19 styles
// in THEDRAW.EXE 4.63: '@' is a plain space and 'O' the solid space, character 255.
const STYLE = [0x20, 0xc4, 0xc4, 0xb3, 0xb3, 0xda, 0xbf, 0xda, 0xbf, 0xc0, 0xd9, 0xc0, 0xd9, 0xb4, 0xc3, 0xff];

/**
 * @typedef {{ width: number, data: Uint8Array }} Glyph
 * @typedef {{ name: string, type: number, spacing: number, glyphs: (Glyph | null)[] }} Font glyphs cover '!' to '~'
 */

/**
 * Read every font in a TheDraw font file. Each font is a 213-byte header (signature 55 AA 00 FF, name length and
 * 12-byte name, 4 reserved bytes, type, letter spacing, data size, 94 glyph offsets) followed by its glyph data.
 * @returns {Font[]}
 */
export function parseTdf(/** @type {Uint8Array} */ bytes) {
  if (String.fromCharCode(...bytes.subarray(0, 20)) !== SIGNATURE) throw new Error('not a TheDraw font file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), fonts = [];
  for (let at = 20; at + 213 <= bytes.length && view.getUint32(at) === 0x55aa00ff; ) {
    const data = at + 213, end = Math.min(bytes.length, data + view.getUint16(at + 23, true));
    const glyphs = Array.from({ length: 94 }, (_, k) => {
      const offset = view.getUint16(at + 25 + k * 2, true);
      return offset === 0xffff || data + offset + 2 > end ? null : { width: bytes[data + offset], data: bytes.subarray(data + offset + 2, end) };
    });
    const name = Array.from(bytes.subarray(at + 5, at + 5 + Math.min(12, bytes[at + 4])), (c) => CP437[c]).join('').split('\0')[0].trim();
    fonts.push({ name: name || `Font ${fonts.length + 1}`, type: bytes[at + 21], spacing: bytes[at + 22], glyphs });
    at = end;
  }
  if (!fonts.length) throw new Error('the file holds no fonts');
  return fonts;
}

/**
 * Decode one glyph into rows of [code, fg, bg] cells, clipped to the glyph's width. A row may end early; the rest of
 * it is transparent. Block and outline glyphs take the given colors.
 */
function cells(/** @type {Font} */ font, /** @type {Glyph} */ glyph, /** @type {number} */ fg, /** @type {number} */ bg) {
  /** @type {[number, number, number][][]} */
  const rows = [[]], { data } = glyph;
  for (let i = 0; i < data.length && data[i] !== 0; i++) {
    const code = data[i], row = rows[rows.length - 1];
    if (code === 0x0d) {
      rows.push([]);
      continue;
    }
    if (code === 0x26 && [0, 0x0d, undefined].includes(data[i + 1])) continue; // '&' ending a row marks a descender line
    if (font.type === COLOR && i + 1 >= data.length) break; // a character cut off before its attribute
    let [f, b] = [fg, bg];
    if (font.type === COLOR) {
      const attr = data[++i];
      [f, b] = [attr & 15, (attr >> 4) & 7]; // the high bit is blink, so backgrounds stay dark
    }
    if (row.length < glyph.width) row.push([font.type === OUTLINE ? STYLE[code - 0x40] ?? 0x20 : code, f, b]);
  }
  return rows;
}

/**
 * Render text with a font into a block of cells and a mask of the cells the glyphs paint. A letter the font lacks
 * falls back to its other case, else is skipped; a space is as wide as the font's average letter. TheDraw stores the
 * gap between letters plus one.
 * @returns {import('./ansi.js').Art & { mask: Uint8Array }}
 */
export function renderTdf(/** @type {Font} */ font, /** @type {string} */ text, /** @type {number} */ fg, /** @type {number} */ bg) {
  const defined = font.glyphs.filter((g) => g !== null), gap = Math.max(0, font.spacing - 1);
  const space = Math.max(1, Math.round(defined.reduce((sum, g) => sum + g.width, 0) / Math.max(1, defined.length)));
  /** @type {{ x: number, rows: [number, number, number][][] }[]} */
  const placed = [];
  let x = 0, width = 1, height = 1;
  for (const char of text) {
    const glyph = [char, char.toUpperCase(), char.toLowerCase()].map((c) => font.glyphs[c.charCodeAt(0) - 33]).find(Boolean);
    if (glyph) {
      const rows = cells(font, glyph, fg, bg);
      placed.push({ x, rows });
      [width, height] = [Math.max(width, x + glyph.width), Math.max(height, rows.length)];
      x += glyph.width + gap;
    } else if (char === ' ') x += space + gap;
  }
  const block = { ...createArt(width, height), mask: new Uint8Array(width * height) };
  for (const { x: left, rows } of placed) {
    rows.forEach((row, r) => row.forEach(([code, f, b], c) => {
      const i = r * block.cols + left + c;
      [block.ch[i], block.fg[i], block.bg[i], block.mask[i]] = [code, f, b, 1];
    }));
  }
  return block;
}
