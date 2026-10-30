// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CP437 } from '../public/ansi.js';
import { parseTdf, renderTdf } from '../public/tdf.js';

/**
 * Build a TheDraw font file. Glyph rows hold cells as [code] (block/outline fonts) or [code, attribute] (color fonts).
 * @param {{ name: string, type: number, spacing: number, glyphs: Record<string, { width: number, height: number, rows: number[][][] }> }[]} fonts
 */
function tdfFile(fonts) {
  const bytes = [...Buffer.from('\x13TheDraw FONTS file\x1a', 'latin1')];
  for (const font of fonts) {
    const data = [], offsets = new Array(94).fill(0xffff);
    for (const [char, glyph] of Object.entries(font.glyphs)) {
      offsets[char.charCodeAt(0) - 33] = data.length;
      data.push(glyph.width, glyph.height);
      glyph.rows.forEach((row, r) => {
        if (r) data.push(0x0d);
        row.forEach((cell) => data.push(...cell));
      });
      data.push(0);
    }
    const header = new Uint8Array(213), view = new DataView(header.buffer);
    header.set([0x55, 0xaa, 0x00, 0xff]);
    header[4] = font.name.length;
    header.set(Buffer.from(font.name, 'latin1'), 5);
    [header[21], header[22]] = [font.type, font.spacing];
    view.setUint16(23, data.length, true);
    offsets.forEach((offset, k) => view.setUint16(25 + k * 2, offset, true));
    bytes.push(...header, ...data);
  }
  return Uint8Array.from(bytes);
}

const FILE = tdfFile([
  { name: 'COLORFONT', type: 2, spacing: 1, glyphs: {
    A: { width: 2, height: 2, rows: [[[0xdb, 0x1e], [0xdb, 0x1e]], [[0xdf, 0xc4]]] },
    B: { width: 1, height: 1, rows: [[[0x42, 0x0f]]] },
    // A drawn '&' (it has an attribute), then a descender row that ends in the bare '&' mark.
    Q: { width: 2, height: 1, rows: [[[0x26, 0x0f], [0xdb, 0x0f]], [[0xdf, 0x0f], [0x26]]] },
  } },
  { name: 'BLOCKY', type: 1, spacing: 0, glyphs: { A: { width: 1, height: 1, rows: [[[0xb2]]] } } },
  // Outline letters E A F / C O @ stand for corner, beam, corner / side, solid space, plain space.
  { name: 'OUTLINED', type: 0, spacing: 3, glyphs: { A: { width: 3, height: 2, rows: [[[0x45], [0x41], [0x46]], [[0x43], [0x4f], [0x40]]] } } },
]);

/** Rows of a block as text, with unpainted cells shown as dots. */
const view = (/** @type {ReturnType<typeof renderTdf>} */ block) => Array.from({ length: block.rows }, (_, r) =>
  Array.from({ length: block.cols }, (_, c) => (block.mask[r * block.cols + c] ? CP437[block.ch[r * block.cols + c]] : '.')).join(''));

test('parseTdf reads every font in a file with its name, type and letter spacing', () => {
  const fonts = parseTdf(FILE);
  assert.deepEqual(fonts.map((f) => [f.name, f.type, f.spacing]), [['COLORFONT', 2, 1], ['BLOCKY', 1, 0], ['OUTLINED', 0, 3]]);
  assert.equal(fonts[0].glyphs['Z'.charCodeAt(0) - 33], null, 'undefined letters are null');
  assert.throws(() => parseTdf(Uint8Array.from(Buffer.from('not a font file at all'))), /not a TheDraw font/);
  assert.equal(parseTdf(FILE.subarray(0, FILE.length - 3))[0].name, 'COLORFONT', 'a truncated file still yields what it holds');
});

test('color fonts carry their own colors; letter spacing, spaces and missing letters lay out as expected', () => {
  const [color] = parseTdf(FILE);
  const block = renderTdf(color, 'A B?a', 7, 0);
  // Spacing 1 is no gap (TheDraw stores the gap plus one). A space is as wide as the average letter (2), '?' is
  // missing so it is skipped, and the missing 'a' falls back to 'A'.
  assert.deepEqual(view(block), ['██..B██', '▀....▀.']);
  assert.deepEqual([block.fg[0], block.bg[0]], [14, 1], 'attribute low nibble is the foreground, high nibble the background');
  assert.deepEqual([block.fg[block.cols], block.bg[block.cols]], [4, 4], 'the high bit is blink, so the background stays dark');
});

test("'&' ending a row marks a descender line; anywhere else it is drawn", () => {
  const [color] = parseTdf(FILE);
  assert.deepEqual(view(renderTdf(color, 'Q', 7, 0)), ['&█', '▀.']);
});

test('outline fonts draw line pieces and solid spaces; spacing above one adds gap columns', () => {
  const [, , outlined] = parseTdf(FILE);
  const block = renderTdf(outlined, 'AA', 7, 0), solid = CP437[0xff];
  assert.deepEqual(view(block), ['┌─┐..┌─┐', `│${solid} ..│${solid} `]);
  assert.equal(block.ch[block.cols + 1], 0xff, "'O' is TheDraw's solid space, character 255");
});

test('block fonts take the chosen colors', () => {
  const [, blocky] = parseTdf(FILE);
  const block = renderTdf(blocky, 'AA', 10, 5);
  assert.deepEqual(view(block), ['▓▓']);
  assert.deepEqual([block.fg[1], block.bg[1]], [10, 5]);
});
