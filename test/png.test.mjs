// `lib/png.js` reads PNG bytes with no decoder behind it, so its fixtures are
// built here out of the format itself: signature, IHDR, IDAT, IEND, with the
// pixel rows deflated. The chunk CRCs are written as zero on purpose — the
// reader walks chunk lengths and never verifies them, and a CRC32
// implementation inside a test would only be checked against itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import { pngDominantColor, pngOpaqueBounds } from "../lib/png.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
}

/**
 * An 8-bit PNG.
 *
 * @param rows already-packed pixel rows (no filter byte: this adds it).
 * @param palette PLTE body, for colour type 3.
 * @param transparency tRNS body.
 * @param depth bit depth to declare, for the refusal cases.
 * @param interlace the interlace byte to declare.
 */
function makePng({ rows, colorType, palette, transparency, depth = 8, interlace = 0 }) {
  const width = rows[0].length / (colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1);
  const height = rows.length;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), row])));
  const chunks = [chunk("IHDR", ihdr)];
  if (palette !== undefined) chunks.push(chunk("PLTE", palette));
  if (transparency !== undefined) chunks.push(chunk("tRNS", transparency));
  chunks.push(chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat([SIGNATURE, ...chunks]);
}

/** A single-colour RGB image. */
function solid(width, height, red, green, blue) {
  const row = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x += 1) {
    row[x * 3] = red;
    row[x * 3 + 1] = green;
    row[x * 3 + 2] = blue;
  }
  return makePng({ rows: Array.from({ length: height }, () => Buffer.from(row)), colorType: 2 });
}

test("pngDominantColor reports the colour most of the plate is painted in", () => {
  // A plate is a large flat area plus some ornament: the majority colour is the
  // plate, and a per-pixel average would report a colour no pixel has.
  const plate = [0x28, 0x3c, 0x50];
  const ornament = [0xff, 0xff, 0xff];
  const rows = [];
  for (let y = 0; y < 4; y += 1) {
    const row = Buffer.alloc(4 * 3);
    for (let x = 0; x < 4; x += 1) {
      const colour = y === 0 && x === 0 ? ornament : plate;
      row.set(colour, x * 3);
    }
    rows.push(row);
  }
  const bytes = makePng({ rows, colorType: 2 });
  assert.equal(pngDominantColor(bytes), "#283c50");
});

test("pngDominantColor ignores transparent pixels and gives up on an empty plate", () => {
  // RGBA: one visible pixel in a sea of transparent ones. The dominant colour
  // must be that pixel, not the colour stored under alpha 0 (which is what a
  // naive histogram reports for a textbox authored on an oversized canvas).
  const rows = [
    Buffer.from([0x00, 0x00, 0xff, 0x00, 0x11, 0x22, 0x33, 0xff]),
    Buffer.from([0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00]),
  ];
  assert.equal(pngDominantColor(makePng({ rows, colorType: 6 })), "#112233");

  const empty = [
    Buffer.from([0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00]),
    Buffer.from([0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00]),
  ];
  assert.equal(
    pngDominantColor(makePng({ rows: empty, colorType: 6 })),
    undefined,
    "a fully transparent image has no colour to report",
  );
});

test("pngDominantColor reads an indexed plate through PLTE and tRNS", () => {
  // Colour type 3 is common for game art: the colour lives in the palette, and
  // an index listed in tRNS is transparent.
  const rows = [
    Buffer.from([0, 1, 1, 1]),
    Buffer.from([0, 1, 1, 1]),
  ];
  const bytes = makePng({
    rows,
    colorType: 3,
    palette: Buffer.from([0xff, 0x00, 0x00, 0x00, 0x80, 0xff]),
    transparency: Buffer.from([0x00, 0xff]),
  });
  assert.equal(pngDominantColor(bytes), "#0080ff");
});

test("pngOpaqueBounds still reports the painted box", () => {
  // The colour sampler shares the chunk reader with the bounds reader, so this
  // pins the older contract: the box is the non-transparent pixels only.
  const rows = [];
  for (let y = 0; y < 6; y += 1) {
    const row = Buffer.alloc(6 * 4);
    for (let x = 0; x < 6; x += 1) {
      const inside = x >= 2 && x <= 3 && y >= 1 && y <= 2;
      row.set(inside ? [0x10, 0x20, 0x30, 0xff] : [0x00, 0x00, 0x00, 0x00], x * 4);
    }
    rows.push(row);
  }
  assert.deepEqual(pngOpaqueBounds(makePng({ rows, colorType: 6 })), {
    x: 2,
    y: 1,
    width: 2,
    height: 2,
    imageWidth: 6,
    imageHeight: 6,
  });
});

test("both readers refuse what they cannot decode instead of throwing", () => {
  const rows = [Buffer.from([0x10, 0x20, 0x30])];
  assert.equal(pngDominantColor(Buffer.from("not a png at all")), undefined);
  assert.equal(pngDominantColor(Buffer.alloc(0)), undefined);
  assert.equal(
    pngDominantColor(makePng({ rows, colorType: 2, depth: 16 })),
    undefined,
    "a 16-bit plate is refused rather than guessed at",
  );
  assert.equal(
    pngDominantColor(makePng({ rows, colorType: 2, interlace: 1 })),
    undefined,
    "an interlaced plate is refused rather than misread",
  );
  assert.equal(pngOpaqueBounds(Buffer.alloc(4)), undefined);
});
