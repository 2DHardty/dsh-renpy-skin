// The RPA half of the test suite: open archives whose INDEX is a real CPython
// pickle (see test/make-rpa-fixtures.py), and check the bytes read back.
//
// Why the fixtures come from Python: the first version of this test hand-rolled
// the pickle opcode stream in JavaScript. The fixture and the reader then shared
// my misunderstanding of the format and "verified" each other while both being
// wrong about every real archive on disk. Real bytes, from the same pickler
// Ren'Py uses, is the only version of this test that can catch that class of bug.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendFileSync,
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { isRpa, openRpa, RpaError } from "../lib/rpa3.js";

const KEY = 0x42424242;
// "RPA-3.0 " + 8 hex offset + " " + 8 hex key + "\n"
const HEADER_LENGTH = 26;
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/rpa-indexes.json", import.meta.url), "utf8"),
);

/**
 * Write a real-shaped `.rpa` for one fixture and return its path.
 * @param label fixture key.
 * @param options `deflate` false stores the index raw (Ren'Py writes raw when
 *   the archive is built without compression — the reader must accept both).
 */
function writeArchive(label, { deflate = true } = {}) {
  const fixture = fixtures[label];
  const dir = mkdtempSync(join(tmpdir(), "renpy-skin-rpa-"));
  const body = Buffer.from(fixture.body, "latin1");
  const index = Buffer.from(fixture.pickleHex, "hex");
  const stored = deflate ? deflateSync(index) : index;
  const indexOffset = HEADER_LENGTH + body.length;
  const header = Buffer.from(
    `RPA-3.0 ${indexOffset.toString(16).padStart(8, "0")} ${KEY.toString(16).padStart(8, "0")}\n`,
    "latin1",
  );
  const path = join(dir, `${label}.rpa`);
  writeFileSync(path, Buffer.concat([header, body, stored]));
  return { path, dir, fixture };
}

function withArchive(label, run, options) {
  const { path, dir, fixture } = writeArchive(label, options);
  try {
    return run(path, fixture);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("openRpa reads a deflated protocol-5 index and returns file bytes", () => {
  withArchive("simple", (path, fixture) => {
    const archive = openRpa(path);
    assert.deepEqual(archive.names, ["scripts/start.rpy"]);
    assert.equal(archive.has("scripts/start.rpy"), true);
    assert.equal(archive.read("scripts/start.rpy").toString("latin1"), fixture.expect["scripts/start.rpy"][0]);
  });
});

test("openRpa reads several names in one index", () => {
  withArchive("multi", (path, fixture) => {
    const archive = openRpa(path);
    assert.deepEqual(archive.names.sort(), [
      "audio/click.mp3",
      "gui/bar.png",
      "scripts/start.rpy",
    ]);
    for (const [name, [expected]] of Object.entries(fixture.expect)) {
      assert.equal(archive.read(name).toString("latin1"), expected, name);
    }
  });
});

test("openRpa prepends an index prefix to the body bytes", () => {
  withArchive("prefix", (path, fixture) => {
    const archive = openRpa(path);
    assert.equal(archive.read("p.txt").toString("latin1"), fixture.expect["p.txt"][0]);
    assert.equal(archive.read("p.txt").toString("latin1"), "PREFIXEDOF-IT");
  });
});

test("openRpa uses the first candidate when a name repeats", () => {
  withArchive("repeated-name", (path, fixture) => {
    const archive = openRpa(path);
    // One name, two (offset, length, prefix) tuples. Ren'Py uses the first, so
    // advancing to the second would be a silent behaviour change.
    assert.deepEqual(archive.names, ["dup.txt"]);
    assert.equal(archive.read("dup.txt").toString("latin1"), fixture.expect["dup.txt"][0]);
    assert.equal(archive.read("dup.txt").toString("latin1"), "AAAAA");
  });
});

test("openRpa advances past a candidate that runs outside the archive", () => {
  withArchive("stale-first", (path, fixture) => {
    const archive = openRpa(path);
    // The first tuple's offset is far outside the file, so it cannot be read;
    // the second one fits and is what read() must fall through to. Dropping the
    // name instead would hide the file from the manifest entirely.
    assert.deepEqual(archive.names, ["dup.txt"]);
    assert.equal(archive.read("dup.txt").toString("latin1"), fixture.expect["dup.txt"][0]);
    assert.equal(archive.read("dup.txt").toString("latin1"), "SECOND");
  });
});

test("openRpa accepts offsets above 2^31", () => {
  // Offsets that wide exercise LONG/LONG1 rather than BININT. The entry sits at
  // 0x70000000, which cannot fit in a small archive, so the name is skipped —
  // and importantly this must not throw while walking the index.
  withArchive("wide-offsets", (path) => {
    const archive = openRpa(path);
    assert.deepEqual(archive.names, []);
  });
});

test("openRpa accepts a plain (non-deflated) index", () => {
  withArchive("simple", (path, fixture) => {
    const archive = openRpa(path);
    assert.equal(archive.read("scripts/start.rpy").toString("latin1"), fixture.expect["scripts/start.rpy"][0]);
  }, { deflate: false });
});

test("isRpa distinguishes an RPA archive from other files", () => {
  withArchive("simple", (path) => {
    assert.equal(isRpa(path), true);
    assert.equal(isRpa(new URL("./fixtures/rpa-indexes.json", import.meta.url).pathname.replace(/^\//, "")), false);
  });
});

test("openRpa rejects a file that is not an RPA archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "renpy-skin-rpa-"));
  const path = join(dir, "nope.rpa");
  writeFileSync(path, "just some text, no header\n");
  try {
    assert.throws(() => openRpa(path), RpaError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openRpa reports a missing entry by name", () => {
  withArchive("simple", (path) => {
    const archive = openRpa(path);
    assert.throws(
      () => archive.read("not/there.txt"),
      (error) => error instanceof RpaError && /no entry not\/there\.txt/.test(error.message),
    );
  });
});

test("an archive larger than the string limit is still recognised and read", (t) => {
  // Symptom: a 1.7 GB game archive (SharedHouse) answered "not an archive", so
  // the game showed 8 backgrounds and 2 sprites although it held 4000+ images.
  // `isRpa` loaded the whole file as a string to look at five characters.
  // The padding sits between the body and the index, which is where a real
  // archive keeps its bulk, and is a hole rather than 600 MB of written zeros.
  const fixture = fixtures.simple;
  const dir = mkdtempSync(join(tmpdir(), "renpy-skin-rpa-big-"));
  try {
    const body = Buffer.from(fixture.body, "latin1");
    const padding = 600 * 1024 * 1024;
    const indexOffset = HEADER_LENGTH + body.length + padding;
    const header = Buffer.from(
      `RPA-3.0 ${indexOffset.toString(16).padStart(8, "0")} ${KEY.toString(16).padStart(8, "0")}\n`,
      "latin1",
    );
    const path = join(dir, "big.rpa");
    const descriptor = openSync(path, "w");
    writeSync(descriptor, Buffer.concat([header, body]));
    try {
      ftruncateSync(descriptor, indexOffset);
    } catch (error) {
      // A volume that cannot hold the 600 MB hole cannot run this check.
      closeSync(descriptor);
      if (error.code === "ENOSPC") return t.skip("not enough free disk space for a 600 MB archive");
      throw error;
    }
    closeSync(descriptor);
    appendFileSync(path, deflateSync(Buffer.from(fixture.pickleHex, "hex")));

    assert.equal(isRpa(path), true);
    const archive = openRpa(path);
    assert.deepEqual(archive.names, ["scripts/start.rpy"]);
    assert.equal(archive.read("scripts/start.rpy").toString("latin1"), fixture.expect["scripts/start.rpy"][0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
