/**
 * Tests for where the plugin keeps its data, and the one-time move there.
 *
 * `resolveDataHome` takes the environment and the user's home as arguments
 * precisely so this file never touches the real ones: a test that read
 * `process.env` would either follow the machine it runs on or corrupt the
 * developer's own `~/.dsh`, and both make failures unreproducible.
 *
 * Usage:
 *   node --test "test/*.test.mjs"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HARNESS_DIRECTORY, LEGACY_DIRECTORY, migrateLegacyHome, resolveDataHome } from "../lib/home.js";

/** A throwaway home directory that the test removes afterwards. */
function scratch() {
  return mkdtempSync(join(tmpdir(), "rsk-home-test-"));
}

test("the data directory resolves override, then $DSH_HOME, then the old home", () => {
  const userHome = "C:\\Users\\someone";

  // The plugin's own variable wins over everything: it is how the test suite
  // and a user with a second install point the plugin somewhere specific.
  assert.deepEqual(
    resolveDataHome(
      { DSH_RENPY_SKIN_HOME: "D:\\plugin", DSH_HOME: "C:\\Users\\someone\\.dsh" },
      userHome,
    ),
    { path: "D:\\plugin", source: "override", legacy: "" },
  );

  // Otherwise the harness home, so the plugin sits beside `profiles/` and
  // `sessions/` instead of beside the user's other dot-directories.
  assert.deepEqual(
    resolveDataHome({ DSH_HOME: "C:\\Users\\someone\\.dsh" }, userHome),
    {
      path: join("C:\\Users\\someone\\.dsh", HARNESS_DIRECTORY),
      source: "harness",
      legacy: join(userHome, LEGACY_DIRECTORY),
    },
  );

  // A build that never set `DSH_HOME` keeps reading where it always did —
  // resolving to `$DSH_HOME/renpy-skin` there would silently lose the settings.
  assert.deepEqual(resolveDataHome({}, userHome), {
    path: join(userHome, LEGACY_DIRECTORY),
    source: "legacy",
    legacy: "",
  });
});

test("a blank environment variable is treated as unset", () => {
  const userHome = "C:\\Users\\someone";

  // A shell that does `export DSH_HOME=""` must not resolve to a relative
  // `renpy-skin` folder in whatever directory the process happens to run in.
  assert.deepEqual(
    resolveDataHome({ DSH_HOME: "   " }, userHome),
    { path: join(userHome, LEGACY_DIRECTORY), source: "legacy", legacy: "" },
    "a blank DSH_HOME falls through to the old home, not to a relative path",
  );
  assert.deepEqual(
    resolveDataHome({ DSH_RENPY_SKIN_HOME: "", DSH_HOME: "C:\\harness" }, userHome),
    { path: join("C:\\harness", HARNESS_DIRECTORY), source: "harness", legacy: join(userHome, LEGACY_DIRECTORY) },
    "a blank override falls through instead of resolving to an empty path",
  );
});

test("the first start under $DSH_HOME copies the old directory over", () => {
  const root = scratch();
  try {
    const legacy = join(root, LEGACY_DIRECTORY);
    const home = join(root, "harness", HARNESS_DIRECTORY);
    mkdirSync(join(legacy, "game", "Remember the Flowers"), { recursive: true });
    writeFileSync(join(legacy, "config.json"), JSON.stringify({ gameDir: "D:\\VN" }), "utf8");
    writeFileSync(join(legacy, "library.json"), "[]", "utf8");
    writeFileSync(join(legacy, "game", "Remember the Flowers", "vn.json"), "{\"name\":\"Remember the Flowers\"}", "utf8");

    // The symptom this prevents: every saved profile and the loaded game
    // vanish on the first start after the directory changed, so the settings
    // page looks freshly installed and the agent has nothing to load.
    const copied = migrateLegacyHome({ path: home, legacy, source: "harness" });
    assert.deepEqual(copied.sort(), ["config.json", "game", "library.json"]);
    assert.equal(
      JSON.parse(readFileSync(join(home, "config.json"), "utf8")).gameDir,
      "D:\\VN",
      "the saved game survives the move",
    );
    assert.equal(
      existsSync(join(home, "game", "Remember the Flowers", "vn.json")),
      true,
      "the agent-written profiles come along",
    );
    assert.equal(
      existsSync(join(legacy, "config.json")),
      true,
      "the old directory is copied, never moved or deleted",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the copy runs once: a configured home is never overwritten", () => {
  const root = scratch();
  try {
    const legacy = join(root, LEGACY_DIRECTORY);
    const home = join(root, "harness", HARNESS_DIRECTORY);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), JSON.stringify({ gameDir: "D:\\OLD" }), "utf8");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: "D:\\NEW" }), "utf8");

    // `config.json` only exists once settings were written, so its presence
    // means the new location is in use — copying over it would undo whatever
    // the user changed since the move.
    assert.deepEqual(migrateLegacyHome({ path: home, legacy, source: "harness" }), []);
    assert.equal(
      JSON.parse(readFileSync(join(home, "config.json"), "utf8")).gameDir,
      "D:\\NEW",
      "the live settings are left alone",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the copy is per entry: an existing config.json no longer strands the profiles", () => {
  const root = scratch();
  try {
    const legacy = join(root, LEGACY_DIRECTORY);
    const home = join(root, "harness", HARNESS_DIRECTORY);
    mkdirSync(join(legacy, "game", "Remember the Flowers"), { recursive: true });
    writeFileSync(join(legacy, "config.json"), JSON.stringify({ gameDir: "D:\\OLD" }), "utf8");
    writeFileSync(join(legacy, "library.json"), "[]", "utf8");
    writeFileSync(join(legacy, "game", "Remember the Flowers", "vn.json"), "{}", "utf8");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: "D:\\NEW" }), "utf8");

    // The symptom this prevents: a user who saved settings once before the move
    // got a `config.json` in the new home, and from then on the whole old game
    // library and every profile stayed behind — silently, because the copy
    // simply declined to run.
    assert.deepEqual(migrateLegacyHome({ path: home, legacy, source: "harness" }), [
      "library.json",
      "game",
    ]);
    assert.equal(
      JSON.parse(readFileSync(join(home, "config.json"), "utf8")).gameDir,
      "D:\\NEW",
      "the live settings are left alone",
    );
    assert.equal(existsSync(join(home, "game", "Remember the Flowers", "vn.json")), true);

    // Running again copies nothing: the entries are there now.
    assert.deepEqual(migrateLegacyHome({ path: home, legacy, source: "harness" }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the copy is skipped when there is nothing to move it from", () => {
  const root = scratch();
  try {
    const home = join(root, "harness", HARNESS_DIRECTORY);

    // A fresh install: no old directory, nothing to copy, and no crash.
    assert.deepEqual(migrateLegacyHome({ path: home, legacy: join(root, "missing"), source: "harness" }), []);
    assert.equal(existsSync(home), false, "a fruitless migration does not create the directory");

    // Resolving to the legacy directory itself: copying a directory onto
    // itself would recurse through its own copies.
    const legacy = join(root, LEGACY_DIRECTORY);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), "{}", "utf8");
    assert.deepEqual(migrateLegacyHome({ path: legacy, legacy, source: "legacy" }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
