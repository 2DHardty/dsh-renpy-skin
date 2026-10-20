// Asset index behaviour for the VN read audit (subtask C): which copy of a file
// wins when several exist, damaged archives, RPA-2.0, the file-cap flag, and the
// image-size header read for files whose dimensions sit past the first 4 KiB.
//
// The archives are written with CPython's pickler, the same one Ren'Py uses, so
// the index bytes are real. Tests that need Python skip when none is installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildManifest, listGameMedia } from "../lib/manifest.js";
import { listFiles } from "../lib/renpy.js";
import { findPython as findPluginPython, rpycDiagnostics } from "../lib/rpyc.js";

/**
 * The interpreter the plugin itself would use, or `undefined`.
 *
 * Not a hand-rolled PATH probe: this machine has no `python` on PATH at all, and
 * the one real interpreter is the runtime DSH ships (`$DSH_HOME/dsh-runtimes/
 * …/python.exe`). Probing only PATH found nothing here, so four archive tests
 * crashed on `spawnSync(undefined, …)` instead of skipping — a red suite that
 * said nothing about the archives.
 */
function findPython() {
  try {
    return findPluginPython() ?? undefined;
  } catch {
    return undefined;
  }
}
const python = findPython();
const needsPython =
  python === undefined
    ? `no Python interpreter found (${rpycDiagnostics().python.reason ?? "checked PATH and the DSH runtime"})`
    : false;

/**
 * Pickle an index the way Ren'Py writes it: protocol 2, each entry a tuple of
 * `(offset, length)` (already XOR-obfuscated by the caller for RPA-3), and the
 * whole pickle zlib-compressed.
 *
 * The result goes to a FILE, not to stdout. A confined sandbox refuses to let a
 * process have a piped stdout (`EPERM` on spawn, with `stdout` left null), which
 * made every archive test here fail for a reason that had nothing to do with
 * archives. `stdio: "ignore"` plus a temp file sidesteps the pipe entirely and
 * works the same way on a machine with no such restriction.
 */
function pickleIndex(index) {
  // Under `-c` the script's own arguments start at `sys.argv[1]`; `sys.argv[0]`
  // is the literal `-c`. Off by one here the script dies with an IndexError that
  // says nothing about archives, which is how this read for a while.
  const script = `
import json, pickle, sys, zlib
with open(sys.argv[1], "rb") as handle:
    raw = json.load(handle)
index = {name: [tuple(t) for t in pairs] for name, pairs in raw.items()}
with open(sys.argv[2], "wb") as handle:
    handle.write(zlib.compress(pickle.dumps(index, 2)))
`;
  const scratch = mkdtempSync(join(tmpdir(), "rsk-pickle-"));
  const inPath = join(scratch, "index.json");
  const outPath = join(scratch, "index.bin");
  try {
    writeFileSync(inPath, JSON.stringify(index), "utf8");
    const out = spawnSync(python, ["-I", "-c", script, inPath, outPath], { stdio: "ignore" });
    // The exit code is all that can be read here: a captured stderr is exactly
    // the pipe this sandbox refuses. So the failure has to carry the one piece
    // of outside context that explains it — the interpreter's own diagnosis.
    assert.equal(
      out.status,
      0,
      `pickling the index failed: python=${python} probe=${(out.error && out.error.code) || "spawned"}; ${rpycDiagnostics().python.reason ?? "the interpreter answered"}`,
    );
    return readFileSync(outPath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Write a real `.rpa` holding `entries` (name -> Buffer). The header is the
 * one-line form Ren'Py reads: `RPA-3.0 <index offset> <key>` or `RPA-2.0 <offset>`.
 * Offsets are absolute file offsets, so the header length is part of the layout.
 */
function writeArchive(path, entries, { version = "3", key = 0x42424242 } = {}) {
  const headerFor = (indexOffset) =>
    version === "2"
      ? Buffer.from(`RPA-2.0 ${indexOffset.toString(16).padStart(16, "0")}\n`, "latin1")
      : Buffer.from(
          `RPA-3.0 ${indexOffset.toString(16).padStart(16, "0")} ${key.toString(16).padStart(8, "0")}\n`,
          "latin1",
        );
  const start = headerFor(0).length;
  const index = {};
  const chunks = [];
  let cursor = start;
  for (const [name, bytes] of Object.entries(entries)) {
    index[name] = [version === "2" ? [cursor, bytes.length] : [cursor ^ key, bytes.length ^ key]];
    chunks.push(bytes);
    cursor += bytes.length;
  }
  const indexBytes = pickleIndex(index);
  writeFileSync(
    path,
    Buffer.concat([headerFor(cursor), ...chunks, indexBytes]),
  );
}

/**
 * The first 33 bytes of a PNG: signature and IHDR, which is all the size reader
 * consumes. Only the dimensions are meaningful here; the CRC is not checked.
 */
function pngHead(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

/**
 * A JPEG whose SOF0 frame header starts after a 5000-byte APP1 segment, so the
 * dimensions are beyond the first 4 KiB that the index reads for every image.
 */
function jpegWithLateFrame(width, height) {
  const app1 = Buffer.alloc(2 + 5000);
  app1.writeUInt16BE(5002, 0);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), app1, sof]);
}

/** A game root with `game/options.rpy` plus the given files (relative -> Buffer|string). */
function makeGame(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "renpy-assets-"));
  const gameDir = join(root, "game");
  mkdirSync(gameDir, { recursive: true });
  writeFileSync(join(gameDir, "options.rpy"), 'define config.name = _("Assets Test")\n', "utf8");
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(gameDir, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return { root, gameDir };
}

/** The background record for one game-relative path, or `undefined`. */
function backgroundAt(root, path) {
  const { manifest } = buildManifest(root, { assetUrl: (p) => `/a?p=${encodeURIComponent(p)}` });
  return manifest.backgrounds.find((bg) => bg.path === path);
}

test("listFiles reports truncation when the cap cuts the walk short", () => {
  // Symptom: a game past the file cap lost resources without any sign; the
  // picker and the manifest looked complete. The report must say so.
  const { root, gameDir } = makeGame({
    "images/a.png": "x",
    "images/b.png": "x",
    "images/c.png": "x",
  });
  try {
    const total = listFiles(gameDir).length;
    const capped = {};
    assert.equal(listFiles(gameDir, { limit: 2, report: capped }).length, 2);
    assert.equal(capped.truncated, true);

    const whole = {};
    assert.equal(listFiles(gameDir, { limit: total, report: whole }).length, total);
    assert.notEqual(whole.truncated, true, "exact fit is not truncation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later-sorted archive wins a name shared by two archives", { skip: needsPython }, () => {
  // Symptom: a background showed the older art after a DLC archive shipped a
  // replacement. Ren'Py sorts archives in reverse and the first holder answers.
  const { root, gameDir } = makeGame();
  try {
    writeArchive(join(gameDir, "a.rpa"), { "images/bg/sky.png": pngHead(100, 100) });
    writeArchive(join(gameDir, "b.rpa"), { "images/bg/sky.png": pngHead(200, 200) });
    const bg = backgroundAt(root, "images/bg/sky.png");
    assert.ok(bg, "sky background is indexed");
    assert.equal(bg.width, 200, "b.rpa sorts after a.rpa, so it answers first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a loose file overrides an archived file of the same name", { skip: needsPython }, () => {
  // Symptom: the game displayed the packed copy of a background even though a
  // loose file in game/images replaced it, because archives were preferred.
  const { root, gameDir } = makeGame({ "images/bg/room.png": pngHead(300, 200) });
  try {
    writeArchive(join(gameDir, "x.rpa"), { "images/bg/room.png": pngHead(100, 100) });
    const bg = backgroundAt(root, "images/bg/room.png");
    assert.ok(bg, "room background is indexed");
    assert.equal(bg.width, 300, "Ren'Py reads the loose file before any archive");
    assert.equal(listGameMedia(root).images.filter((p) => p === "images/bg/room.png").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a damaged archive is skipped and the other archives still index", { skip: needsPython }, () => {
  // Symptom: one corrupt .rpa made every background in the game disappear from
  // the picker. Only the bad archive may be dropped.
  const { root, gameDir } = makeGame();
  try {
    // Index offset past end of file: the header parses, the archive cannot.
    writeFileSync(join(gameDir, "broken.rpa"), "RPA-3.0 00000000000fffff 00000000\nnot an index");
    writeFileSync(join(gameDir, "junk.rpa"), "this is not an archive at all");
    writeArchive(join(gameDir, "good.rpa"), { "images/bg/hall.png": pngHead(640, 480) });
    const media = listGameMedia(root);
    assert.ok(media.images.includes("images/bg/hall.png"), "good archive still listed");
    assert.equal(media.images.some((p) => p.includes("broken") || p.includes("junk")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RPA-2.0 archives (no header key, plain index) are read", { skip: needsPython }, () => {
  // Symptom: backgrounds packed by an older Ren'Py build were missing entirely.
  // RPA-2.0 has no XOR key; its entries are plain (offset, length) pairs.
  const { root, gameDir } = makeGame();
  try {
    writeArchive(join(gameDir, "legacy.rpa"), { "images/bg/old.png": pngHead(320, 240) }, { version: "2" });
    const bg = backgroundAt(root, "images/bg/old.png");
    assert.ok(bg, "RPA-2.0 entry is indexed");
    assert.equal(bg.width, 320);
    assert.equal(bg.height, 240);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a case-only difference between a loose file and an archive entry is one asset", { skip: needsPython }, () => {
  // Symptom: the same background was listed twice, once per spelling, and the
  // duplicate was sized from the wrong copy. Names are compared ignoring case,
  // the loose file wins, and the listing uses the loose spelling.
  const { root, gameDir } = makeGame({ "images/bg/hall.png": pngHead(1024, 768) });
  try {
    writeArchive(join(gameDir, "mixed.rpa"), { "Images/BG/Hall.PNG": pngHead(800, 600) });
    const halls = buildManifest(root, { assetUrl: (p) => `/a?p=${p}` }).manifest.backgrounds.filter(
      (bg) => bg.path.toLowerCase() === "images/bg/hall.png",
    );
    assert.equal(halls.length, 1, "one asset, not one per spelling");
    assert.equal(halls[0].path, "images/bg/hall.png");
    assert.equal(halls[0].width, 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("image size is read past the first 4 KiB when the frame header is late", () => {
  // Symptom: a large JPEG was listed without dimensions, and the background
  // switcher then could not size its preview. The 4 KiB first read must fall
  // back to a larger read rather than give up.
  const { root } = makeGame({ "images/bg/tall.jpg": jpegWithLateFrame(1110, 291) });
  try {
    const bg = backgroundAt(root, "images/bg/tall.jpg");
    assert.ok(bg, "late-frame JPEG is indexed");
    assert.equal(bg.width, 1110);
    assert.equal(bg.height, 291);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
