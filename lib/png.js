/**
 * Where a PNG is actually painted.
 *
 * A game's textbox is often authored on a canvas far larger than the visible
 * plate (GoToSnowTown ships a 1920x1080 file whose paper covers only the bottom
 * quarter), so the file's own size says nothing about the box the player sees.
 * The bounding box of the non-transparent pixels does.
 *
 * Zero dependencies: only `node:zlib`. Anything this reader does not handle
 * (interlaced files, 1/2/4-bit depths, other formats) returns `undefined` and
 * the caller falls back to the whole image.
 */
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Pixels at or below this alpha count as empty (soft shadows are not the box). */
const ALPHA_THRESHOLD = 24;
/** A decode this big is not a UI plate; do not spend the memory on it. */
const MAX_PIXELS = 16_000_000;

/**
 * @param bytes whole PNG file.
 * @returns `{ x, y, width, height, imageWidth, imageHeight }` of the painted
 *   region, or `undefined` when the file cannot be read this way or is empty.
 */
export function pngOpaqueBounds(bytes) {
  try {
    return readBounds(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The colour a plate is mostly painted in.
 *
 * Stands in for a missing `gui.accent_color`: the textbox is drawn in the
 * game's own palette, so the colour most of it is made of is a better accent
 * than a hardcoded blue. Returns `#rrggbb`, or `undefined` when the file
 * cannot be decoded this way.
 *
 * @param bytes whole PNG file.
 */
export function pngDominantColor(bytes) {
  try {
    return readDominantColor(bytes);
  } catch {
    return undefined;
  }
}

/** Parse the chunk stream once; both readers start from this. */
function readChunks(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) return undefined;
  let offset = 8;
  let header;
  let palette;
  let transparency;
  const data = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (header === undefined || data.length === 0 || header.interlace !== 0) return undefined;
  if (header.width * header.height > MAX_PIXELS) return undefined;
  return { header, palette, transparency, data };
}

function readBounds(bytes) {
  const image = readChunks(bytes);
  if (image === undefined) return undefined;
  const { width, height, depth, colorType } = image.header;
  const { palette, transparency, data } = image;
  const full = { x: 0, y: 0, width, height, imageWidth: width, imageHeight: height };

  // Colour types with no alpha channel and no transparency chunk paint every
  // pixel, so the whole image is the box.
  const hasAlphaChannel = colorType === 4 || colorType === 6;
  if (!hasAlphaChannel && !(colorType === 3 && transparency !== undefined)) return full;
  if (colorType === 3 ? depth !== 8 : depth !== 8 && depth !== 16) return undefined;

  const channels = { 6: 4, 4: 2, 3: 1 }[colorType];
  const bytesPerPixel = (channels * depth) / 8;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length < (stride + 1) * height) return undefined;

  const alphaAt = (row, column) => {
    if (colorType === 3) {
      const index = row[column];
      return transparency !== undefined && index < transparency.length ? transparency[index] : 255;
    }
    // The alpha sample is the last channel; for 16-bit its high byte decides.
    return row[column * bytesPerPixel + (colorType === 6 ? 3 : 1) * (depth / 8)];
  };

  let previous = Buffer.alloc(stride);
  let current = Buffer.alloc(stride);
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    raw.copy(current, 0, start + 1, start + 1 + stride);
    unfilter(filter, current, previous, bytesPerPixel);
    let rowMin = -1;
    let rowMax = -1;
    for (let x = 0; x < width; x += 1) {
      if (alphaAt(current, x) > ALPHA_THRESHOLD) {
        if (rowMin < 0) rowMin = x;
        rowMax = x;
      }
    }
    if (rowMin >= 0) {
      if (rowMin < minX) minX = rowMin;
      if (rowMax > maxX) maxX = rowMax;
      if (y < minY) minY = y;
      maxY = y;
    }
    [previous, current] = [current, previous];
  }
  if (maxX < 0) return undefined;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, imageWidth: width, imageHeight: height };
}

/** Undo one scanline filter in place (PNG spec, section 9). */
function unfilter(filter, line, above, bpp) {
  const length = line.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < length; i += 1) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < length; i += 1) line[i] = (line[i] + above[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < length; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + above[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < length; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = above[i];
        const c = i >= bpp ? above[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + predictor) & 0xff;
      }
      return;
    default:
      throw new Error(`bad PNG filter ${filter}`);
  }
}

/**
 * The most common paint colour, averaged inside a coarse bucket.
 *
 * Buckets are 5 bits per channel: a plate is a large flat area, so one bucket
 * holds one visible colour, and averaging the exact pixels inside it keeps the
 * hex from drifting to a value no pixel actually has. Fully transparent pixels
 * are skipped — the empty part of an oversized canvas is not a colour.
 */
function readDominantColor(bytes) {
  const image = readChunks(bytes);
  if (image === undefined) return undefined;
  const { width, height, depth, colorType } = image.header;
  const { palette, transparency } = image;
  // Only the 8-bit forms are decoded: 16-bit plates are rare and their colour
  // is the high byte anyway, so a second reader would buy nothing visible.
  if (depth !== 8) return undefined;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) return undefined;
  if (colorType === 3 && palette === undefined) return undefined;
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(image.data));
  if (raw.length < (stride + 1) * height) return undefined;

  // A 4K plate is sampled every other column; a colour histogram does not need
  // every pixel to find the one that fills half the file.
  const step = width * height > 4_000_000 ? 2 : 1;
  const buckets = new Map();
  let previous = Buffer.alloc(stride);
  let current = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    raw.copy(current, 0, start + 1, start + 1 + stride);
    unfilter(filter, current, previous, bytesPerPixel);
    for (let x = 0; x < width; x += step) {
      const at = x * bytesPerPixel;
      let red;
      let green;
      let blue;
      let alpha = 255;
      if (colorType === 3) {
        const index = current[at];
        if (index * 3 + 2 >= palette.length) continue;
        red = palette[index * 3];
        green = palette[index * 3 + 1];
        blue = palette[index * 3 + 2];
        if (transparency !== undefined && index < transparency.length) alpha = transparency[index];
      } else if (colorType === 0 || colorType === 4) {
        red = green = blue = current[at];
        if (colorType === 4) alpha = current[at + 1];
      } else {
        red = current[at];
        green = current[at + 1];
        blue = current[at + 2];
        if (colorType === 6) alpha = current[at + 3];
      }
      if (alpha <= ALPHA_THRESHOLD) continue;
      const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, { count: 1, red, green, blue });
      else {
        bucket.count += 1;
        bucket.red += red;
        bucket.green += green;
        bucket.blue += blue;
      }
    }
    [previous, current] = [current, previous];
  }

  let best;
  for (const bucket of buckets.values()) {
    if (best === undefined || bucket.count > best.count) best = bucket;
  }
  if (best === undefined) return undefined;
  const channel = (sum) => Math.round(sum / best.count).toString(16).padStart(2, "0");
  return `#${channel(best.red)}${channel(best.green)}${channel(best.blue)}`;
}
