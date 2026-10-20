// Script-source discovery: load precedence, undecompilable bytecode, and the
// bounded batch. Every fixture is a real file: loose scripts are written to a
// temp game directory, `.rpyc` bytes are copied from unrpyc's own Ren'Py 8.2
// testcases, and archives are real RPA-3 files built from the pickled index in
// test/fixtures/rpa-indexes.json (same bytes the rpa suite already trusts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

import { openRpa } from "../lib/rpa3.js";
import { decompileRpycMany, findPython, findUnrpyc } from "../lib/rpyc.js";
import { readScriptSources } from "../lib/manifest.js";

const UNRPYC = findUnrpyc();
const DECOMPILER_SKIP = UNRPYC === null || findPython() === null
  ? "python/unrpyc not available on this machine"
  : false;

// unrpyc ships its own compiled fixtures, and they live in the checkout the
// lookup above already resolved — so the tests do not need this machine's drive
// letter, and a checkout anywhere works. `DSH_RENPY_TOOLS` is honoured by that
// lookup, and the resolved file's directory is preferred over the tools
// directory, because the fixtures sit inside the versioned checkout
// (`unrpyc-2.0.4/`), not directly in `Tools/`.
const UNRPYC_ROOT = process.env.DSH_RENPY_UNRPYC_ROOT
  ?? (UNRPYC === null ? "" : dirname(UNRPYC));
const COMPILED_OPTIONS = join(UNRPYC_ROOT, "testcases", "compiled", "the_question-8.2", "options.rpyc");
// Ren'Py 8.5 bytecode from a real release. There is no right default for this
// one: the file only exists inside a game the user happens to have installed,
// so the test is skipped unless the path is given.
const CSE_RPYC = process.env.DSH_RENPY_CSE_RPYC ?? "";

const RPA_KEY = 0x42424242;
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/rpa-indexes.json", import.meta.url), "utf8"),
);

/**
 * Create a temp game. `files` maps game-relative paths to text or Buffer.
 * Returns `{ root, gameDir }`; the caller removes `root`.
 */
function makeGame(files) {
  const root = mkdtempSync(join(tmpdir(), "renpy-skin-scripts-"));
  const gameDir = join(root, "game");
  for (const [rel, content] of Object.entries(files)) {
    const full = join(gameDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, gameDir };
}

/**
 * Write a real RPA-3 archive whose index is the `simple` fixture
 * (`scripts/start.rpy`), then open it with the production reader.
 */
function openSimpleArchive(root) {
  const fixture = fixtures.simple;
  const body = Buffer.from(fixture.body, "latin1");
  const index = deflateSync(Buffer.from(fixture.pickleHex, "hex"));
  const offset = 26 + body.length;
  const header = Buffer.from(
    `RPA-3.0 ${offset.toString(16).padStart(8, "0")} ${RPA_KEY.toString(16).padStart(8, "0")}\n`,
    "latin1",
  );
  const path = join(root, "archive.rpa");
  writeFileSync(path, Buffer.concat([header, body, index]));
  return openRpa(path);
}

function textsFor(sources, endsWith) {
  return sources
    .filter((source) => source.path.replace(/\\/g, "/").endsWith(endsWith))
    .map((source) => source.text);
}

test("a loose .rpy beats an archived .rpy of the same path (no duplicate, loose text wins)", () => {
  // User-visible symptom: a loose override of scripts/start.rpy was ignored
  // because loose labels are absolute paths and archive names are relative,
  // so the archived copy was also parsed and, being later, overwrote the loose
  // values in buildManifest's last-wins name map.
  const { root, gameDir } = makeGame({ "scripts/start.rpy": "define gui.text_size = 31\n" });
  try {
    const archive = openSimpleArchive(root);
    const sources = readScriptSources(gameDir, { archives: new Map([["a", archive]]) });
    const matches = textsFor(sources, "start.rpy");
    assert.deepEqual(matches, ["define gui.text_size = 31\n"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the archived .rpy is used when no loose copy exists", () => {
  const { root, gameDir } = makeGame({ "readme.txt": "no scripts loose" });
  try {
    const archive = openSimpleArchive(root);
    const sources = readScriptSources(gameDir, { archives: new Map([["a", archive]]) });
    assert.deepEqual(textsFor(sources, "start.rpy"), [
      archive.read("scripts/start.rpy").toString("utf8"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a loose .rpy and a loose .rpyc side by side: only the .rpy is read", () => {
  // User-visible symptom: a game whose gui.rpy and gui.rpyc both ship was read
  // from the compiled file, so the values reflected the bytecode build rather
  // than the source the author edits. The .rpyc here is real compiler output.
  if (DECOMPILER_SKIP) return;
  const { root, gameDir } = makeGame({
    "scripts/gui.rpy": "define gui.text_size = 22\n",
  });
  try {
    copyFileSync(COMPILED_OPTIONS, join(gameDir, "scripts", "gui.rpyc"));
    const sources = readScriptSources(gameDir, { archives: new Map() });
    assert.deepEqual(textsFor(sources, "gui.rpy"), ["define gui.text_size = 22\n"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("translations under tl/ never contribute gui values", () => {
  // User-visible symptom: a German translation's gui.rpy (which only holds
  // dialogue strings) replaced the game's own GUI sizes, so the skin used the
  // translated copy's values.
  const { root, gameDir } = makeGame({
    "gui.rpy": "define gui.text_size = 22\n",
    "tl/german/gui.rpy": "define gui.text_size = 99\n",
  });
  try {
    const sources = readScriptSources(gameDir, { archives: new Map() });
    assert.deepEqual(textsFor(sources, "gui.rpy"), ["define gui.text_size = 22\n"]);
    assert.equal(sources.some((source) => source.path.includes("tl")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bad .rpyc does not drop the good ones in the same batch", () => {
  // User-visible symptom: one corrupt or unsupported compiled script made the
  // whole bytecode batch come back empty, so options.rpyc (which decompiles
  // fine) was lost too and the skin fell back to the default GUI.
  if (DECOMPILER_SKIP) return;
  const { root, gameDir } = makeGame({
    "scripts/broken.rpyc": Buffer.from("RENPY RPC2 this is not a real archive"),
  });
  try {
    copyFileSync(COMPILED_OPTIONS, join(gameDir, "scripts", "options.rpyc"));
    const sources = readScriptSources(gameDir, { archives: new Map() });
    assert.equal(textsFor(sources, "options.rpy").length, 1, "good options.rpyc must survive");
    assert.equal(textsFor(sources, "broken.rpy").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with many bytecode scripts, the GUI-defining one is still decompiled", () => {
  // User-visible symptom: in a game with hundreds of .rpyc story scripts, the
  // unbounded batch timed out and returned nothing, so gui/options were lost.
  // Ranking puts options.rpyc ahead of the story files under the cap.
  if (DECOMPILER_SKIP) return;
  const files = {};
  for (let i = 0; i < 60; i += 1) {
    files[`story/chapter_${String(i).padStart(3, "0")}.rpyc`] = Buffer.from("RENPY RPC2 junk");
  }
  const { root, gameDir } = makeGame(files);
  try {
    copyFileSync(COMPILED_OPTIONS, join(gameDir, "options.rpyc"));
    const sources = readScriptSources(gameDir, { archives: new Map() });
    assert.equal(textsFor(sources, "options.rpy").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Ren'Py 8.5 bytecode decompiles with the newest unrpyc found, and never throws", () => {
  // Real-game symptom behind "script read as empty": CSE-2.1.0 ships Ren'Py 8.5
  // bytecode. unrpyc 2.0.2 fails on it with "too many values to unpack (expected
  // 5, got 7)" yet exits 0, so the missing output is the only signal; 2.0.3+
  // reads it. The lookup must prefer the newest install beside the old one.
  if (DECOMPILER_SKIP || !existsSync(CSE_RPYC)) return;
  const bytes = readFileSync(CSE_RPYC);
  const result = decompileRpycMany([{ name: "renpy/common/000statements.rpyc", bytes }]);
  assert.ok(result instanceof Map, "a failure is an empty map, not an exception");
  if (/unrpyc-2.0.[0-2]/.test(findUnrpyc() ?? "")) assert.equal(result.size, 0);
  else assert.equal(result.size, 1, "a 2.0.3+ unrpyc reads Ren'Py 8.5");
});
