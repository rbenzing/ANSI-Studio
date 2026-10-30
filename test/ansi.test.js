// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL, CP437, MAX_CELLS, MAX_COLS, MAX_ROWS, PALETTE, createArt, decode, despeckle, encode, encodeUtf8, fill, fitSize,
  fromPixels, getPixel, line, putChar, quantize, resize, setPixel, shape, stamp, trace,
} from '../public/ansi.js';

/** @typedef {import('../public/ansi.js').Art} Art */

/** Deterministic pseudo-random numbers (mulberry32) so failures reproduce. */
function random(seed = 1) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random cells mixing blocks, shading, line drawing and text in all 16 colors on all 16 backgrounds. */
function randomArt(/** @type {number} */ cols, /** @type {number} */ rows, seed = 1) {
  const next = random(seed), codes = [0x20, 0xdb, 0xdc, 0xdf, 0xb0, 0xb1, 0xb2, 0xc4, 0xb3, 0x41, 0x7a, 0x01, 0xfe];
  const art = createArt(cols, rows);
  for (let i = 0; i < art.ch.length; i++) {
    putChar(art, i % cols, Math.floor(i / cols), codes[Math.floor(next() * codes.length)], Math.floor(next() * 16), Math.floor(next() * 16));
  }
  return art;
}

/** What a cell looks like: block cells by their two half colors, anything else by character and both colors. */
function look(/** @type {Art} */ art, /** @type {number} */ i) {
  const x = i % art.cols, row = Math.floor(i / art.cols), top = getPixel(art, x, row * 2);
  return top < 0 ? `${art.ch[i]}:${art.fg[i]}/${art.bg[i]}` : `${top}|${getPixel(art, x, row * 2 + 1)}`;
}
const looks = (/** @type {Art} */ art) => Array.from(art.ch, (_, i) => look(art, i));

/**
 * Check an encoded file against the quirks of real viewers: no line breaks in full-width rows, SGR limited to what
 * every viewer knows, never 1 or 5 twice without a reset (libansilove adds 8 each time), parameter strings within
 * libansilove's 14-byte limit, and a non-glyph last byte (PabloDraw drops it).
 */
function lint(/** @type {Uint8Array} */ bytes) {
  const eof = bytes.indexOf(0x1a);
  assert.equal(bytes.length - eof, 129, 'one EOF byte, then the 128-byte SAUCE record');
  let bold = false, blink = false;
  for (let i = 0; i < eof; i++) {
    assert.ok(!CONTROL.includes(bytes[i]) || (bytes[i] === 0x1b && bytes[i + 1] === 0x5b), `control byte ${bytes[i]} at ${i}`);
    if (bytes[i] !== 0x1b) continue;
    const end = bytes.indexOf(0x6d, i);
    assert.ok(end - i - 2 <= 13, 'SGR fits libansilove\'s sequence limit');
    for (const p of String.fromCharCode(...bytes.subarray(i + 2, end)).split(';').map(Number)) {
      assert.ok(p === 0 || p === 1 || p === 5 || (p >= 30 && p <= 37) || (p >= 40 && p <= 47), `SGR ${p}`);
      if (p === 0) [bold, blink] = [false, false];
      if (p === 1) assert.ok(!bold, 'bold sent twice');
      if (p === 5) assert.ok(!blink, 'blink sent twice');
      bold ||= p === 1;
      blink ||= p === 5;
    }
    i = end;
  }
  assert.deepEqual([...bytes.subarray(eof - 4, eof)], [0x1b, 0x5b, 0x30, 0x6d], 'ends with a reset, so the last glyph is not the last byte');
}

test('CP437 maps all 256 bytes to distinct characters', () => {
  assert.equal(CP437.length, 256);
  assert.equal(new Set(CP437).size, 256);
  const known = { 0x01: '☺', 0x20: ' ', 0x41: 'A', 0x7f: '⌂', 0x80: 'Ç', 0xb0: '░', 0xb1: '▒', 0xb2: '▓', 0xb3: '│', 0xc4: '─', 0xc9: '╔', 0xcd: '═', 0xdb: '█', 0xdc: '▄', 0xdf: '▀', 0xe1: 'ß', 0xfe: '■' };
  for (const [code, char] of Object.entries(known)) assert.equal(CP437[Number(code)], char, `0x${Number(code).toString(16)}`);
});

test('encode round-trips text, shading and block cells through decode and passes viewer quirk checks', () => {
  for (const [cols, rows, seed] of [[80, 25, 1], [1, 1, 2], [3, 7, 3], [160, 50, 4], [79, 3, 5]]) {
    const art = randomArt(cols, rows, seed), bytes = encode(art, { title: 'round trip', author: 'Zoë', group: 'dd' });
    lint(bytes);
    const back = decode(bytes);
    assert.equal(back.art.cols, cols);
    assert.equal(back.art.rows, rows);
    assert.deepEqual(looks(back.art), looks(art), `${cols}x${rows}`);
    assert.deepEqual([back.title, back.author, back.group], ['round trip', 'Zoë', 'dd'], 'SAUCE text is CP437 both ways');
  }
});

test('iCE colors are flagged exactly when a cell needs a bright background', () => {
  const needsIce = (/** @type {Art} */ art) => art.ch.some((_, i) => {
    const x = i % art.cols, row = Math.floor(i / art.cols), top = getPixel(art, x, row * 2), bottom = getPixel(art, x, row * 2 + 1);
    return top < 0 ? art.bg[i] > 7 : top > 7 && bottom > 7 && top !== bottom;
  });
  const iceFlag = (/** @type {Uint8Array} */ bytes) => (bytes[bytes.length - 128 + 105] & 1) === 1;
  for (let seed = 1; seed < 30; seed++) {
    const art = randomArt(4, 2, seed);
    assert.equal(iceFlag(encode(art)), needsIce(art), `seed ${seed}`);
  }
  assert.equal(iceFlag(encode(fromPixels(3, 1, [9, 1, 12, 1, 9, 4]))), false, 'one bright half per cell needs no iCE');
});

test('with iCE off, bright backgrounds are avoided where possible and darkened where not', () => {
  const art = fromPixels(3, 1, [9, 12, 14, 1, 13, 14]); // cells: 9/1, 12/13 (two brights), 14/14
  putChar(art, 2, 0, 0x41, 15, 12); // text on a bright background
  const bytes = encode(art, { ice: false });
  lint(bytes);
  assert.equal(bytes[bytes.length - 128 + 105] & 1, 0);
  const back = decode(bytes).art;
  assert.equal(look(back, 0), '9|1', 'one bright half survives exactly');
  assert.ok(['12|5', '4|13'].includes(look(back, 1)), 'one half of a two-bright cell is darkened');
  assert.equal(look(back, 2), '65:15/4', 'text on a bright background gets the dark background');
});

test('encode emits minimal attribute changes and resets only to clear bold', () => {
  const bytes = encode(fromPixels(4, 1, [9, 1, 4, 2, 1, 1, 13, 6])); // upper halves, then lower halves
  const body = Buffer.from(bytes.subarray(0, bytes.indexOf(0x1a))).toString('latin1');
  assert.equal(body, '\x1b[0m\x1b[1;31;41m\xdf \x1b[35;44m\xdc\x1b[0;32;46m\xdf\x1b[0m');
});

test('encode keeps blank art compact and never writes control bytes as glyphs', () => {
  const blank = encode(createArt(80, 25));
  assert.equal(blank.indexOf(0x1a), 80 * 25 + 8, 'two resets and one byte per cell');
  const art = createArt(5, 1);
  CONTROL.forEach((code, x) => putChar(art, x, 0, code, 7, 0));
  lint(encode(art));
});

test('SAUCE record carries size, metadata, font and flags', () => {
  const bytes = encode(createArt(132, 60), { title: 'Neon Skull ☠', author: 'me', group: 'dd', date: '20261029' });
  const rec = bytes.subarray(bytes.length - 128);
  const str = (/** @type {number} */ at, /** @type {number} */ len) => String.fromCharCode(...rec.subarray(at, at + len));
  assert.equal(bytes[bytes.length - 129], 0x1a);
  assert.equal(str(0, 7), 'SAUCE00');
  assert.equal(str(7, 35), 'Neon Skull ?'.padEnd(35));
  assert.equal(str(42, 20), 'me'.padEnd(20));
  assert.equal(str(62, 20), 'dd'.padEnd(20));
  assert.equal(str(82, 8), '20261029');
  assert.deepEqual([rec[94], rec[95]], [1, 1], 'Character / ANSi');
  assert.equal(rec[96] | (rec[97] << 8), 132);
  assert.equal(rec[98] | (rec[99] << 8), 60);
  assert.equal(rec[104], 0, 'no comment block');
  assert.equal(rec[105] & ~1, 0x12, '8-pixel font and square pixels');
  assert.equal(str(106, 22), 'IBM VGA'.padEnd(22, '\0'));
  const localToday = new Date().toLocaleDateString('sv').replaceAll('-', '');
  assert.equal(String.fromCharCode(...encode(createArt(1, 1)).subarray(-128 + 82, -128 + 90)), localToday);
  const long = encode(createArt(1, 1), { title: 'x'.repeat(50), author: 'y'.repeat(30) }).subarray(-128);
  assert.equal(String.fromCharCode(...long.subarray(7, 62)), 'x'.repeat(35) + 'y'.repeat(20), 'fields truncate');
});

/** Build an .ANS file from a string of CP437 bytes (as latin1) with an optional SAUCE record. */
function ans(/** @type {string} */ body, /** @type {{ cols?: number, rows?: number, flags?: number, comments?: number }} */ sauce = {}) {
  if (sauce.cols === undefined) return Uint8Array.from(Buffer.from(body, 'latin1'));
  const rec = new Uint8Array(128), view = new DataView(rec.buffer);
  rec.set(Buffer.from('SAUCE00Imported'), 0);
  rec[94] = 1;
  view.setUint16(96, sauce.cols, true);
  view.setUint16(98, sauce.rows ?? 0, true);
  rec[104] = sauce.comments ?? 0;
  rec[105] = sauce.flags ?? 0;
  const comment = sauce.comments ? [...Buffer.from('COMNT'), ...new Uint8Array(64 * sauce.comments).fill(0x20)] : [];
  return Uint8Array.from([...Buffer.from(body, 'latin1'), 0x1a, ...comment, ...rec]);
}
const text = (/** @type {Art} */ art, /** @type {number} */ row) => Array.from(art.ch.subarray(row * art.cols, (row + 1) * art.cols), (c) => CP437[c]).join('');

test('decode reads the line endings, cursor moves and erases real files use', () => {
  const { art } = decode(ans('AB\r\nCD\x1b[3CE\x1b[sF\x1b[1;1HG\x1b[uH\x1b[2;2fI\tJ\x1b[1BK\x1b[2DL', { cols: 12 }));
  assert.equal(text(art, 0), 'GB          ');
  assert.equal(text(art, 1), 'CI   EH J   ');
  assert.equal(text(art, 2), '        LK  ');
  const wrap = decode(ans('ABCD\r\nEF', { cols: 4 })).art;
  assert.deepEqual([text(wrap, 0), text(wrap, 1), text(wrap, 2)], ['ABCD', '    ', 'EF  '], 'a full row plus CR LF leaves a blank row, as in every viewer');
  const erased = decode(ans('ABCDEF\x1b[1;3H\x1b[K', { cols: 6 })).art;
  assert.equal(text(erased, 0), 'AB    ');
  const blue = decode(ans('ABC\x1b[44m\x1b[1K', { cols: 4 })).art;
  assert.deepEqual([text(blue, 0), blue.bg[0], blue.bg[3]], ['    ', 4, 4], 'erasing to the cursor fills with the current background');
  const moves = decode(ans('AB\r\nC\x1b[AD\x1b[?2J\x1b[0;40 DE\x1b[200CF', { cols: 6 })).art;
  assert.deepEqual([text(moves, 0), text(moves, 1)], ['ADE  F', 'C     '], 'up; private and font-select sequences ignored; forward stops at the last column');
  assert.equal(text(decode(ans('A\x1b[12\nB', { cols: 2 })).art, 1), 'B ', 'a sequence cut off by a line feed is dropped, and the line feed kept');
  assert.equal(decode(ans('x'.repeat(100))).art.cols, 80, 'no SAUCE means 80 columns');
});

test('decode maps every color notation onto the palette', () => {
  const { art } = decode(ans('\x1b[1;31mA\x1b[0;5;44mB\x1b[0;7;32;41mC\x1b[0;93;101mD\x1b[38;5;196;48;5;21mE\x1b[38;2;0;170;0;48;2;85;85;85mF\x1b[0;255;255;255t\x1b[1;0;0;170tG\x1b[0;1;34m\x1b[22mH\x1b[0;1;37;44;7mI\x1b[0;32;38;9;1mJ', { cols: 10 }));
  const cell = (/** @type {number} */ i) => [CP437[art.ch[i]], art.fg[i], art.bg[i]];
  assert.deepEqual(cell(0), ['A', 9, 0], 'bold is a bright foreground');
  assert.deepEqual(cell(1), ['B', 7, 4], 'blink without the iCE flag keeps the dark background');
  assert.deepEqual(cell(2), ['C', 1, 2], 'inverse swaps the colors');
  assert.deepEqual(cell(3), ['D', 11, 9], 'aixterm bright codes');
  assert.deepEqual(cell(4), ['E', 1, 4], '256-color codes map to the perceptually nearest color');
  assert.deepEqual(cell(5), ['F', 2, 8], '24-bit codes map to the nearest color');
  assert.deepEqual(cell(6), ['G', 4, 15], 'PabloDraw 24-bit t sequences: 0 sets the background, 1 the foreground');
  assert.deepEqual(cell(7), ['H', 4, 0], 'SGR 22 turns bold off');
  assert.deepEqual(cell(8), ['I', 12, 7], 'inverse swaps the hues but leaves the brightness in place');
  assert.deepEqual(cell(9), ['J', 2, 0], 'an unknown 38 form ends the SGR, so its data is not read as attributes');
  const ice = decode(ans('\x1b[5;44mX', { cols: 1, flags: 1 })).art;
  assert.equal(ice.bg[0], 12, 'blink under the iCE flag is a bright background');
});

test('decode honors SAUCE size, metadata, comments and SUB, and caps the size', () => {
  const file = ans('HI', { cols: 4, rows: 3, comments: 1 });
  const { art, title } = decode(file);
  assert.deepEqual([art.cols, art.rows, title, text(art, 0)], [4, 3, 'Imported', 'HI  ']);
  assert.equal(text(decode(ans('AB\x1aCD')).art, 0).trim(), 'AB', 'SUB ends the text');
  const huge = decode(ans('\x1b[5000BX', { cols: 320 }));
  assert.deepEqual([huge.art.cols, huge.art.rows], fitSize(320, 5001));
  assert.ok(huge.art.cols * huge.art.rows <= MAX_CELLS);
  assert.equal(decode(ans('HI', { cols: 0 })).art.cols, 80, 'a SAUCE width of 0 means 80');
  const wide = decode(ans('A'.repeat(320) + 'B'.repeat(80) + 'A', { cols: 400 }));
  assert.deepEqual([wide.art.cols, wide.art.rows, text(wide.art, 0), text(wide.art, 1).trim(), wide.clipped], [MAX_COLS, 2, 'A'.repeat(320), 'A', true],
    'wider files keep their own line breaks and lose the right side');
  const deep = decode(ans(`\x1b[50000000BX${'\n'.repeat(2000)}Y`));
  assert.deepEqual([deep.art.rows, deep.clipped], [MAX_ROWS, true], 'far cursor moves stop at the last row; later content is dropped');
  assert.equal(decode(ans('HI', { cols: 2 })).clipped, false);
  const bogus = ans('HI', { cols: 4 });
  bogus[bogus.length - 128 + 104] = 255;
  assert.equal(text(decode(bogus).art, 0), 'HI  ', 'a comment count without a COMNT block is ignored');
  const commented = ans('HI', { cols: 4, comments: 1 }), noEof = Uint8Array.from([...commented.subarray(0, 2), ...commented.subarray(3)]);
  assert.deepEqual([decode(noEof).art.rows, text(decode(noEof).art, 0)], [1, 'HI  '], 'the comment block is not art, even without SUB');
});

test('encodeUtf8 writes Unicode with 16-color codes and a reset per row', () => {
  const art = createArt(2, 2);
  putChar(art, 0, 0, 0xb0, 9, 4);
  putChar(art, 1, 0, 0xdb, 9, 4);
  putChar(art, 0, 1, 0x41, 7, 12);
  putChar(art, 1, 1, 0, 7, 0); // NUL, which imported files use as a blank, must not shift the line in a terminal
  assert.equal(encodeUtf8(art), '\x1b[91;44m░█\x1b[0m\n\x1b[37;104mA\x1b[37;40m \x1b[0m\n');
});

test('pixel tools treat text as walls and repaint it only where they draw', () => {
  const art = createArt(4, 2);
  putChar(art, 2, 0, 0x41, 15, 0);
  putChar(art, 2, 1, 0x41, 15, 0);
  fill(art, 0, 0, 4);
  assert.equal(getPixel(art, 3, 0), 0, 'fill stops at the text column');
  assert.equal(getPixel(art, 1, 3), 4);
  assert.equal(art.ch[2], 0x41, 'text survives the fill');
  setPixel(art, 2, 1, 9);
  assert.deepEqual([art.ch[2], getPixel(art, 2, 0), getPixel(art, 2, 1)], [0xdf, 0, 9], 'painting a text cell starts from its background');
  fill(art, 2, 2, 7);
  assert.equal(art.ch[6], 0x41, 'fill started on text does nothing');
});

/** Pixels as rows of '#' and '.' so shape expectations read like pictures. */
const picture = (/** @type {Art} */ art) => Array.from({ length: art.rows * 2 }, (_, y) => Array.from({ length: art.cols }, (_, x) => (getPixel(art, x, y) ? '#' : '.')).join(''));
const fromPicture = (/** @type {string[]} */ rows) => fromPixels(rows[0].length, rows.length / 2, Uint8Array.from(rows.join(''), Number));

test('line paints one pixel per step in every direction and clips off-canvas parts', () => {
  for (let i = 0; i < 6 ** 4; i++) {
    const [x0, y0, x1, y1] = [i % 6, Math.floor(i / 6) % 6, Math.floor(i / 36) % 6, Math.floor(i / 216)];
    const art = createArt(6, 3);
    line(art, x0, y0, x1, y1, 1);
    const lit = picture(art).join('').split('').flatMap((c, j) => (c === '#' ? [[j % 6, Math.floor(j / 6)]] : []));
    assert.equal(lit.length, Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1, `${x0},${y0} to ${x1},${y1}`);
    assert.ok(getPixel(art, x0, y0) && getPixel(art, x1, y1), 'both endpoints painted');
  }
  const art = createArt(5, 1);
  line(art, -3, 1, 8, 1, 4);
  line(art, -5, -5, -1, -1, 4);
  assert.deepEqual(picture(art), ['.....', '#####']);
  const visited = [];
  trace(0, 0, 3, 1, (x, y) => visited.push([x, y]));
  assert.deepEqual(visited, [[0, 0], [1, 0], [2, 1], [3, 1]]);
});

test('shapes draw outlines or fills from any corner order and clip at the edge', () => {
  const box = createArt(6, 3);
  shape(box, 'box', 4, 4, 1, 1, 7);
  assert.deepEqual(picture(box), ['......', '.####.', '.#..#.', '.#..#.', '.####.', '......']);
  const ellipse = createArt(9, 4);
  shape(ellipse, 'ellipse', 0, 0, 8, 6, 3, true);
  assert.deepEqual(picture(ellipse), ['..#####..', '.#######.', '#########', '#########', '#########', '.#######.', '..#####..', '.........']);
  const clipped = createArt(4, 2);
  shape(clipped, 'box', -2, -2, 2, 2, 7);
  assert.deepEqual(picture(clipped), ['..#.', '..#.', '###.', '....']);
});

test('fill stays inside the canvas', () => {
  const art = fromPicture(['110', '011']);
  fill(art, 2, 0, 5);
  assert.deepEqual(picture(art), ['###', '.##'], 'does not leak from the right edge into the next row');
  for (const [x, y] of [[3, 0], [-1, 0], [0, 2], [0, -1]]) fill(art, x, y, 7);
  assert.deepEqual(picture(art), ['###', '.##']);
});

test('quantize maps exact colors exactly; diffusion and ordered dithering mix in-between colors', () => {
  const rgba = PALETTE.flatMap((c) => [...c, 255]);
  for (const mode of /** @type {const} */ (['none', 'diffusion'])) assert.deepEqual([...quantize(rgba, 16, 1, mode)], [...PALETTE.keys()], mode);
  const gray = Array.from({ length: 64 }, () => [128, 128, 128, 255]).flat();
  assert.equal(new Set(quantize(gray, 8, 8, 'none')).size, 1);
  for (const mode of /** @type {const} */ (['diffusion', 'ordered'])) {
    const out = quantize(gray, 8, 8, mode);
    assert.ok(new Set(out).size > 1, `${mode} mixes colors`);
    const mean = [...out].reduce((sum, c) => sum + PALETTE[c][0], 0) / out.length;
    assert.ok(Math.abs(mean - 128) < 20, `${mode} brightness ${mean} stays near 128`);
  }
  const ordered = quantize(gray, 8, 8, 'ordered');
  for (let i = 0; i < 64; i++) assert.equal(ordered[i], ordered[(i + 4) % 8 + Math.floor(i / 8) * 8], 'ordered dithering repeats every 4 pixels');
});

test('despeckle light removes isolated pixels but keeps lines, edges and checkerboard dithering', () => {
  const grid = (/** @type {string[]} */ rows) => Uint8Array.from(rows.join(''), Number);
  const px = grid(['000000', '010000', '000000', '000220', '333333', '000000']);
  despeckle(px, 6, 1);
  assert.deepEqual([...px], [...grid(['000000', '000000', '000000', '000220', '333333', '000000'])]);
  const checker = grid(['0101', '1010', '0101', '1010']);
  despeckle(checker, 4, 1);
  assert.deepEqual([...checker], [...grid(['0101', '1010', '0101', '1010'])]);
  const strong = grid(['000000', '022000', '000000', '000330', '000330', '000000']);
  despeckle(strong, 6, 2);
  assert.deepEqual([...strong], [...grid(['000000', '000000', '000000', '000330', '000330', '000000'])]);
  const pair = Uint8Array.of(5, 0);
  despeckle(pair, 1, 2);
  assert.deepEqual([...pair], [5, 0], 'two lone neighbors do not swap colors');
  const off = grid(['00', '01']);
  despeckle(off, 2, 0);
  assert.deepEqual([...off], [0, 0, 0, 1], 'strength 0 is a no-op');
});

test('resize keeps the overlap, fitSize respects every limit, and stamp copies only painted cells', () => {
  const art = randomArt(4, 2, 7), grown = resize(art, 6, 3);
  for (let i = 0; i < 8; i++) assert.equal(look(grown, Math.floor(i / 4) * 6 + (i % 4)), look(art, i));
  assert.deepEqual(looks(resize(grown, 4, 2)), looks(art));
  assert.deepEqual(fitSize(0, -5), [1, 1]);
  assert.deepEqual(fitSize(9999, 9999), [MAX_COLS, Math.floor(MAX_CELLS / MAX_COLS)]);
  assert.deepEqual(fitSize(80, 9999), [80, MAX_ROWS]);
  const target = createArt(3, 2), block = { ...createArt(2, 1), mask: Uint8Array.of(1, 0) };
  putChar(block, 0, 0, 0x41, 14, 1);
  putChar(block, 1, 0, 0x42, 14, 1);
  stamp(target, block, 2, 1);
  assert.deepEqual([text(target, 1), target.fg[5], target.bg[5]], ['  A', 14, 1], 'clipped at the edge, unmasked cells skipped');
});
