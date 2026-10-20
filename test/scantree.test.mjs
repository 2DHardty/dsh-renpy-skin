/**
 * Tests for the two listings the agent is handed when a game loads.
 *
 * The budgets are the contract here, not an implementation detail: 400 lines and
 * 12 KB is what keeps a 20 000-file game from spending the whole context window
 * on a file listing. A test that only checked "some text came back" would pass
 * while the map quietly grew to the size of the game.
 *
 * Usage:
 *   node --test "test/*.test.mjs"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  COMPACT_BYTE_LIMIT,
  COMPACT_LINE_LIMIT,
  FULL_ENTRY_LIMIT,
  renderUnderBudget,
  scanGameTree,
} from "../lib/scantree.js";

/**
 * A Ren'Py game with a script, a config, fonts, and one image per directory.
 *
 * Built on disk rather than mocked: the scan calls `readdirSync` and `statSync`,
 * so a fixture object would only test the fixture.
 */
function makeScannedGame() {
  const root = mkdtempSync(join(tmpdir(), "rsk-scan-"));
  const game = join(root, "game");
  const write = (relative, body = "x") => {
    const path = join(game, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
  };
  writeFileSync(join(root, "MyNovel.exe"), "stub", "utf8");
  write("gui.rpy", "define gui.text_color = \"#ffe6b0\"\n");
  write("options.rpy", "define config.name = \"My Novel\"\n");
  write("script.rpyc");
  write("font/body.ttf");
  for (const name of ["beach", "school", "rooftop"]) write(`images/bg/${name}.jpg`);
  for (const name of ["happy", "sad"]) write(`images/sprites/aiko/${name}.png`);
  write("audio/music/theme.ogg");
  write("audio/sfx/door.ogg");
  // Directories the scan must not walk into.
  write("saves/slot1.sav");
  write("cache/bytecode.rpyc");
  write("tl/chinese/script.rpy");
  return { root, game };
}

test("the scan writes a compact map and a complete listing", () => {
  const game = makeScannedGame();
  try {
    const scanned = scanGameTree(game.root, { manifest: undefined });
    assert.equal(scanned.gameDir, game.game);

    // The compact map must name the things an agent has to decide about: where
    // the game is, which script holds the look, and what art it has.
    assert.match(scanned.compact, /^# /, "it starts with a heading naming the game");
    assert.match(scanned.compact, /## scripts and config/, "the scripts are listed");
    assert.match(scanned.compact, /gui\.rpy/, "the file that decides the skin is named");
    assert.match(scanned.compact, /## images \(\d+\) by directory/, "the images are aggregated");
    assert.match(scanned.compact, /images\/bg\/ — 3/, "a directory is summarised with a count, not one path per line");
    assert.match(scanned.compact, /## audio \(\d+\) by directory/, "audio is aggregated too");
    assert.match(scanned.compact, /## fonts \(\d+\)/, "the fonts are listed, since the skin serves them");

    // The full listing is the other half: every path, so a later question about
    // one file can be answered by reading it back instead of re-walking.
    for (const path of ["gui.rpy", "images/bg/beach.jpg", "audio/sfx/door.ogg"]) {
      assert.ok(scanned.full.includes(path), `${path} appears in the full listing`);
    }
  } finally {
    rmSync(game.root, { recursive: true, force: true });
  }
});

test("the scan skips the directories a Ren'Py game keeps no displayables in", () => {
  const game = makeScannedGame();
  try {
    const scanned = scanGameTree(game.root);

    // These hold saves, engine bytecode and translation copies. Listing them
    // wastes the budget and would make `tl/chinese/` look like game content.
    for (const path of ["saves/slot1.sav", "cache/bytecode.rpyc", "tl/chinese/script.rpy"]) {
      assert.equal(scanned.full.includes(path), false, `${path} is not scanned`);
    }
  } finally {
    rmSync(game.root, { recursive: true, force: true });
  }
});

test("a big game is clipped to the compact budget and says so", () => {
  const root = mkdtempSync(join(tmpdir(), "rsk-scan-big-"));
  try {
    const game = join(root, "game");
    mkdirSync(game, { recursive: true });
    writeFileSync(join(game, "gui.rpy"), "define gui.text_color = \"#fff\"\n", "utf8");
    // Archives are the one section that cannot be count-summarised — each entry
    // needs its own line — so this is how a real game reaches the cap.
    for (let index = 0; index < 500; index += 1) {
      writeFileSync(join(game, `archive-${String(index).padStart(3, "0")}.rpa`), "not an archive", "utf8");
    }

    const scanned = scanGameTree(root);
    const lines = scanned.compact.split("\n").length - 1;
    assert.ok(lines <= COMPACT_LINE_LIMIT, `compact map is ${lines} lines, limit ${COMPACT_LINE_LIMIT}`);
    assert.ok(
      scanned.stats.compactBytes <= COMPACT_BYTE_LIMIT,
      `compact map is ${scanned.stats.compactBytes} bytes, limit ${COMPACT_BYTE_LIMIT}`,
    );
    assert.match(
      scanned.compact,
      /clipped at \d+ lines/,
      "a clipped map points at the full listing instead of just stopping",
    );
    assert.match(scanned.compact, /scan-tree\.full\.txt/, "the note names the file that has the rest");

    // The full listing is not budgeted the same way: it is the fallback the note
    // points at, so it has to actually be complete.
    assert.match(scanned.full, /archive-499\.rpa/, "the full listing keeps every archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderUnderBudget keeps priority order and never exceeds its budget", () => {
  const block = (label, count) => ({
    lines: Array.from({ length: count }, (_, index) => `${label}-${index}`),
  });

  // Everything fits: no note, nothing dropped.
  const roomy = renderUnderBudget([block("a", 2), block("b", 2)], 10, 1024, "full.txt");
  assert.equal(roomy, "a-0\na-1\nb-0\nb-1\n");
  assert.equal(roomy.includes("clipped"), false);

  // Too many lines: the earlier block survives, the later one is cut, and the
  // result says where the rest went. Dropping the *first* block instead would
  // lose the header and the paths, which are the whole point of the map.
  const tight = renderUnderBudget([block("a", 3), block("b", 20)], 5, 1024, "full.txt");
  assert.match(tight, /^a-0\na-1\na-2\n/, "the earlier block is preserved");
  assert.match(tight, /b-0/);
  assert.match(tight, /clipped at 5 lines/);
  assert.match(tight, /full\.txt/);
  assert.ok(tight.split("\n").length - 1 <= 6, "the reserved note fits inside the same budget");
});

test("the full listing reports the cap instead of ending silently", () => {
  const game = makeScannedGame();
  try {
    // The cap is 20 000 entries, and this fixture has far fewer, so the honest
    // case is "not truncated". The flag is what a caller checks before treating
    // an absent path as proof it does not exist.
    const scanned = scanGameTree(game.root);
    assert.equal(scanned.stats.truncated, false);
    assert.equal(scanned.stats.limit, FULL_ENTRY_LIMIT);
    assert.match(scanned.full, /^# full tree/m);
    assert.match(scanned.full, /# \d+ files$/m);
  } finally {
    rmSync(game.root, { recursive: true, force: true });
  }
});

test("a game whose scripts all live inside an archive still produces a map", () => {
  // User-visible symptom: `scanGameTree` threw `The "string" argument must be of
  // type string or an instance of Buffer or ArrayBuffer. Received an instance of
  // Array` and `POST /renpy-skin/agent/prepare` answered 400, so "Load with
  // Agent" failed before a session could open. Only archive-only games hit it:
  // the scripts block wrapped its sentence in a second array, which is fine
  // until `Buffer.byteLength()` measures the block and rejects a nested array.
  // A commercial build that keeps every `.rpyc` inside `scripts.rpa` is exactly
  // that shape.
  const root = mkdtempSync(join(tmpdir(), "rsk-scan-archived-"));
  try {
    const game = join(root, "game");
    mkdirSync(join(game, "fonts"), { recursive: true });
    writeFileSync(join(game, "fonts", "body.ttf"), "x");
    // A real RPA-3.0 archive, written from the same index fixture the readers
    // are tested against, holding `scripts/start.rpy`.
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/rpa-indexes.json", import.meta.url), "utf8")).simple;
    const body = Buffer.from(fixture.body, "latin1");
    const index = deflateSync(Buffer.from(fixture.pickleHex, "hex"));
    const header = Buffer.from(
      `RPA-3.0 ${(26 + body.length).toString(16).padStart(8, "0")} ${(0x42424242).toString(16).padStart(8, "0")}\n`,
      "latin1",
    );
    writeFileSync(join(game, "scripts.rpa"), Buffer.concat([header, body, index]));

    const scanned = scanGameTree(root);
    assert.equal(scanned.stats.scripts, 0, "no loose scripts on disk");
    assert.ok(scanned.stats.archiveEntries.scripts > 0, "the archive is where the scripts are");
    assert.match(
      scanned.compact,
      /no loose scripts; \d+ compiled scripts live inside the archives/,
      "the map says where the scripts are instead of claiming there are none",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
