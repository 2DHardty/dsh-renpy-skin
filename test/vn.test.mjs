/**
 * The agent-written VN profile: naming, reading, and what it is allowed to
 * override.
 *
 * The failure this guards against is not a crash. A profile is a file a model
 * edits, so it can be half-written, truncated mid-JSON, or carry a section the
 * plugin never agreed to honour — and the worst outcome is not an error, it is
 * a profile that silently empties a manifest the scan had filled. So every
 * assertion here is about what does NOT happen: an unreadable file changes
 * nothing, an unknown section is dropped rather than merged, and a section the
 * plugin reads structurally cannot be replaced by a scalar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyProfile,
  inspectProfileConfig,
  OVERLAY_SECTIONS,
  profileBelongsToGame,
  profileDirName,
  profileOverlay,
  readProfile,
} from "../lib/vn.js";

function tempDir(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "renpy-skin-vn-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test("a VN name becomes a directory name that is legal on Windows", () => {
  // The name comes from the game, so it can carry a colon (`Remember the
  // Flowers: Part 2`) or a path separator, either of which would make the write
  // land somewhere else entirely — or fail.
  assert.equal(profileDirName("Remember the Flowers"), "Remember the Flowers");
  assert.equal(profileDirName("A/B"), "A_B");
  assert.equal(profileDirName("C: drive"), "C_ drive");
  assert.equal(profileDirName('He said "hi"'), "He said _hi_");
  assert.equal(profileDirName("trailing."), "trailing");
  assert.equal(profileDirName("  spaced  "), "spaced");
});

test("a name that reduces to nothing falls back instead of writing to the parent", () => {
  // `..` used to survive as a path segment, which would put the profile one
  // level up from where the plugin reads it.
  assert.equal(profileDirName(".."), "vn");
  assert.equal(profileDirName("   "), "vn");
  assert.equal(profileDirName(undefined), "vn");
  assert.equal(profileDirName("..."), "vn");
});

test("a profile that is missing, empty or corrupt reads as none", () => {
  const root = tempDir({
    "good/vn.json": JSON.stringify({ dialogbox: { textColor: "#fff" } }),
    "empty/vn.json": "",
    "broken/vn.json": '{"dialogbox": {"textColor": "#fff"',
    "array/vn.json": "[1, 2, 3]",
    "scalar/vn.json": "42",
  });
  try {
    assert.deepEqual(readProfile(join(root, "good", "vn.json")), { dialogbox: { textColor: "#fff" } });
    for (const name of ["empty", "broken", "array", "scalar", "absent"]) {
      assert.equal(readProfile(join(root, name, "vn.json")), undefined, name);
    }
    assert.equal(readProfile(undefined), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the agreed sections survive, and a scalar section is dropped", () => {
  const overlay = profileOverlay({
    game: { name: "X", version: "1.0", screen: { w: 1920, h: 1080 } },
    dialogbox: { textColor: "#101010", junk: 1 },
    // A section the plugin reads structurally must not be replaceable by an
    // object the agent invented: `tags` is built from the game, not from here.
    tags: { enid: "hello" },
    sprites: [],
    weird: "value",
    layout: "not an object",
  });
  assert.deepEqual(
    Object.keys(overlay).sort(),
    ["dialogbox", "game"],
    "only whitelisted, object-valued sections get through",
  );
  assert.deepEqual(overlay.game, { name: "X", version: "1.0", screen: { w: 1920, h: 1080 } });
  // An unrecognised key is still passed through: dropping it silently would
  // turn "the agent misspelled a field" into "the profile applied nothing",
  // which is the false success this module exists to prevent.
  assert.deepEqual(overlay.dialogbox, { textColor: "#101010", junk: 1 });
  assert.ok(OVERLAY_SECTIONS.includes("dialogbox"));
  assert.ok(OVERLAY_SECTIONS.includes("sprites"));
  assert.ok(OVERLAY_SECTIONS.includes("characters"));
});

test("a game section without a usable canvas size does not blank the screen size", () => {
  const overlay = profileOverlay({ game: { name: "X", screen: { w: "wide" } } });
  assert.deepEqual(overlay.game, { name: "X" }, "the scan's canvas survives a malformed one");
});

test("the overlay corrects fields and reports what moved, leaving the rest of the scan alone", () => {
  // The symptom behind this test: an agent that knew only the text colour
  // replaced the whole dialogue box, so every field it had not mentioned came
  // back as `undefined` and the composer lost its plate.
  const manifest = {
    game: { name: "Scanned", screen: { w: 1280, h: 720 } },
    dialogbox: { textColor: "#000000", fill: "#222222", textSize: 33, height: 278 },
    stats: { backgrounds: 12 },
  };
  const changed = applyProfile(manifest, profileOverlay({ dialogbox: { textColor: "#ff0000" } }));
  assert.deepEqual(changed, ["dialogbox.textColor"]);
  assert.equal(manifest.dialogbox.textColor, "#ff0000");
  assert.equal(manifest.dialogbox.fill, "#222222", "a field the profile never mentioned is untouched");
  assert.equal(manifest.dialogbox.textSize, 33);
  assert.equal(manifest.stats.backgrounds, 12);
});

test("a value equal to the scan's is reported as no change", () => {
  // Otherwise every profile would report every field it restates, and the
  // "applied over the scan" line would be unreadable.
  const manifest = { dialogbox: { textColor: "#000000" } };
  assert.deepEqual(applyProfile(manifest, profileOverlay({ dialogbox: { textColor: "#000000" } })), []);
});

test("a game section merges key by key instead of replacing the scanned one", () => {
  // The symptom: writing `{ game: { name, version } }` to correct a title
  // replaced the whole section, so the scanned `screen` disappeared — and the
  // client derives every `cqw` unit in the dialogue box from
  // `manifest.game.screen.w/h`, so the entire UI collapsed to defaults while
  // the reply said the fields were applied.
  const manifest = {
    game: { name: "Scanned", version: "0.0", screen: { w: 1920, h: 1080 }, showName: true },
  };
  const changed = applyProfile(manifest, profileOverlay({ game: { name: "CSE", version: "2.1.0" } }));
  assert.deepEqual(changed, ["game.name", "game.version"]);
  assert.deepEqual(manifest.game, {
    name: "CSE",
    version: "2.1.0",
    screen: { w: 1920, h: 1080 },
    showName: true,
  });
});

test("a partial canvas size is merged into the scanned one, not swapped for it", () => {
  // `screen` is the one nested object the client reads field by field, so
  // stating only the height has to keep the width.
  const manifest = { game: { name: "X", screen: { w: 1920, h: 1080 } } };
  const changed = applyProfile(manifest, profileOverlay({ game: { screen: { h: 720 } } }));
  assert.deepEqual(changed, ["game.screen.h"]);
  assert.deepEqual(manifest.game.screen, { w: 1920, h: 720 });
});

test("a null in a profile keeps the scanned value instead of erasing it", () => {
  // `renpy_read_manifest` emits the same shape `renpy_save_vn` accepts, so an
  // agent that reads the manifest, edits one field and writes it back would
  // otherwise carry every `null` the scan could not fill straight into the
  // manifest — wiping the values that were read. `null` means "I am not saying
  // anything about this field"; clearing is stated as `""` or `[]`.
  const manifest = {
    game: { name: "CSE", version: "2.1.0", screen: { w: 1920, h: 1080 } },
    dialogbox: { textColor: "#fff8ee", fill: "#000000" },
  };
  const changed = applyProfile(
    manifest,
    profileOverlay({ game: { version: null }, dialogbox: { textColor: null } }),
  );
  assert.deepEqual(changed, [], "null states nothing, so nothing changed");
  assert.equal(manifest.dialogbox.textColor, "#fff8ee");
  assert.equal(manifest.game.version, "2.1.0");

  // An empty string, by contrast, is a real value: that is how a field is
  // cleared on purpose.
  const cleared = { dialogbox: { textColor: "#fff8ee" } };
  assert.deepEqual(applyProfile(cleared, profileOverlay({ dialogbox: { textColor: "" } })), [
    "dialogbox.textColor",
  ]);
  assert.equal(cleared.dialogbox.textColor, "");
});

test("the transcript is kept whole and is not merged field by field", () => {
  // It is the agent's own narrative, so replacing it entirely is the point.
  const manifest = { transcript: { summary: "old" } };
  applyProfile(manifest, profileOverlay({ transcript: { notes: "new" } }));
  assert.deepEqual(manifest.transcript, { notes: "new" });
});

test("an empty profile changes nothing at all", () => {
  const manifest = { dialogbox: { textColor: "#000000" } };
  assert.deepEqual(applyProfile(manifest, profileOverlay({})), []);
  assert.equal(applyProfile(manifest, profileOverlay(undefined)).length, 0);
  assert.deepEqual(manifest, { dialogbox: { textColor: "#000000" } });
});

test("a profile is only applied to the game it was written for", () => {
  // The symptom: the folder is named after the VN, so two games that answer to
  // the same name share one profile — and the second one to be loaded was
  // re-skinned with the first one's colours, font and box geometry, with
  // nothing anywhere saying why.
  assert.equal(profileBelongsToGame("D:\\Games\\X\\game", "D:\\Games\\X\\game"), true);
  assert.equal(profileBelongsToGame("D:/Games/X/game/", "D:\\Games\\X\\game"), true, "separator spelling is not identity");
  assert.equal(profileBelongsToGame("D:\\Games\\X\\game", "E:\\Games\\X\\game"), false);
  assert.equal(profileBelongsToGame("D:\\Games\\X\\game", "D:\\Games\\X\\extra\\game"), false);
  // Unknown on either side keeps the old behaviour: a profile written before
  // the field existed must not stop being applied.
  assert.equal(profileBelongsToGame(undefined, "D:\\Games\\X"), true);
  assert.equal(profileBelongsToGame("", "D:\\Games\\X"), true);
  assert.equal(profileBelongsToGame("D:\\Games\\X", undefined), true);
  // Case is a difference only where the filesystem does not fold it.
  const folded = process.platform === "win32" || process.platform === "darwin";
  assert.equal(profileBelongsToGame("d:\\games\\x", "D:\\Games\\X"), folded);
});

test("the config report names what the overlay will use, ignore and drop", () => {
  const config = {
    game: { name: "X", screen: { w: "1920", h: 1080 } },
    dialogbox: { textColor: "#ff0000" },
    layout: {},
    sprites: { enid: { attributes: ["happy"] } },
    theme: "dark",
    choice: 3,
    tags: { enid: "hello" },
  };
  const report = inspectProfileConfig(config);
  assert.deepEqual(report.accepted, ["game", "dialogbox", "sprites"]);
  assert.deepEqual(report.ignored, ["tags"], "a section the plugin never agreed to honour");
  assert.deepEqual(
    report.malformed,
    ["game.screen", "layout", "theme", "choice"],
    "a recognised section that contributes nothing is reported too, down to the game sub-field",
  );
  assert.deepEqual(report.unknownKeys, [], "every key here is either known or in a free-shape section");

  // The report describes the overlay, so the two must not drift apart: every
  // accepted section really is in the overlay, and nothing it reports as
  // dropped reaches it.
  const overlay = profileOverlay({ savedAt: "now", gameDir: "D:\\Games\\X", name: "X", ...config });
  for (const section of report.accepted) {
    assert.notEqual(overlay[section], undefined, `${section} has to reach the overlay`);
  }
  for (const dropped of [...report.ignored, ...report.malformed]) {
    if (dropped.includes(".")) continue; // `game.screen` shares the section it is reported under
    assert.equal(overlay[dropped], undefined, `${dropped} has to be dropped`);
  }

  // Nothing is a section problem when there is no config at all.
  for (const value of [undefined, null, [], "config"]) {
    assert.deepEqual(inspectProfileConfig(value), {
      accepted: [],
      ignored: [],
      malformed: [],
      unknownKeys: [],
    });
  }
  // The stored metadata is not a section, and is not reported as one.
  assert.deepEqual(inspectProfileConfig({ dialogbox: { fill: "#000" } }).accepted, ["dialogbox"]);
});

test("a misspelled key inside a section is reported instead of counting as applied", () => {
  // The symptom: `{ layout: { dialogueWidht: 1150 } }` was accepted, written
  // into the manifest and listed in `applied`, and the interface showed "1
  // field applied" — while `dialogueWidth` never changed, because nothing reads
  // `dialogueWidht`. A silent false success, which is worse than a rejection.
  const report = inspectProfileConfig({ layout: { dialogueWidht: 1150 } });
  assert.deepEqual(report.accepted, [], "no key anything reads was stated");
  assert.deepEqual(report.unknownKeys, ["layout.dialogueWidht"]);
  assert.deepEqual(report.ignored, []);
  // `unknownKeys` already names the exact key, so the section is not repeated as
  // malformed: the fix is to correct that one key, not to replace `layout`.
  assert.deepEqual(report.malformed, []);

  // It is still written through — dropping it silently would hide the typo in
  // the other direction, and the stored file would then disagree with the
  // manifest — but it is not reported as a change: `applyProfile`'s list is read
  // as "what took effect", and a key nothing reads never takes effect.
  const manifest = { layout: { dialogueWidth: 1185 } };
  const overlay = profileOverlay({ layout: { dialogueWidht: 1150 } });
  assert.deepEqual(applyProfile(manifest, overlay), [], "nothing that anything reads changed");
  assert.equal(manifest.layout.dialogueWidth, 1185, "the field the client reads is untouched");
  assert.equal(manifest.layout.dialogueWidht, 1150, "the typo is kept, so the file and the manifest agree");

  // A section mixing a real key with a typo is applied, and still reports the
  // typo: the half that worked must not make the half that did not disappear.
  const mixed = inspectProfileConfig({ layout: { dialogueWidth: 1185, dialogueWidht: 1 } });
  assert.deepEqual(mixed.accepted, ["layout"]);
  assert.deepEqual(mixed.unknownKeys, ["layout.dialogueWidht"]);

  // Sections whose shape is defined by the game or the agent are not
  // whitelisted: a tag or a CSS variable name is not this module's to guess.
  for (const config of [
    { theme: { "--dsw-alias-brand-primary": { light: "#111", dark: "#eee" } } },
    { transcript: { anything: 1 } },
    { characters: { qc: { name: "启诚", color: "#624B34" } } },
    { sprites: { qc: { attributes: ["happy"] } } },
  ]) {
    const report = inspectProfileConfig(config);
    assert.deepEqual(report.unknownKeys, [], JSON.stringify(config));
    assert.equal(report.accepted.length, 1, JSON.stringify(config));
  }
});

test("a character patch edits one field and keeps the rest of the record", () => {
  // The symptom this prevents: the cast is a map of records the scan assembled,
  // so the one-level rule every flat section uses would replace the whole
  // `qc` record. Correcting a mis-read display name would then delete the
  // `image` tag the scan read correctly, and `show qc` would stop resolving.
  const manifest = {
    characters: { qc: { name: "qc", color: "#624B34", image: "qc" } },
  };
  const changed = applyProfile(manifest, profileOverlay({ characters: { qc: { name: "启诚" } } }));
  assert.deepEqual(changed, ["characters.qc.name"]);
  assert.deepEqual(manifest.characters.qc, {
    name: "启诚",
    color: "#624B34",
    image: "qc",
  });

  // A variable the scan never found is added: with the scripts unreadable the
  // scan's cast is empty, and the profile is then the only place a speaker can
  // come from.
  const empty = { characters: {} };
  assert.deepEqual(applyProfile(empty, profileOverlay({ characters: { wq: { name: "未乾" } } })), [
    "characters.wq.name",
  ]);
  assert.deepEqual(empty.characters, { wq: { name: "未乾" } });

  // A field nothing reads is named where it sits, and is not written.
  const typo = inspectProfileConfig({ characters: { qc: { colour: "#624B34" } } });
  assert.deepEqual(typo.unknownKeys, ["characters.qc.colour"]);
  assert.deepEqual(typo.accepted, []);
});

test("a sprite patch edits the records the scan found and never replaces the list", () => {
  // The symptom: `manifest.sprites` is a LIST the stage resolves `show` against,
  // so the generic "section replaces" rule would swap it for the profile's map.
  // Every sprite the profile did not mention would vanish, and `resolveSprite`
  // would then reject valid commands — which looks like a broken game, not a
  // bad profile.
  const manifest = {
    sprites: [
      { name: "qc happy", tag: "qc", attributes: ["happy"], url: "/a.png" },
      { name: "qc sad", tag: "qc", attributes: ["sad"], url: "/b.png" },
      { name: "wq", tag: "wq", attributes: [], url: "/c.png" },
    ],
  };
  const changed = applyProfile(manifest, profileOverlay({ sprites: { wq: { url: "/fixed.png" } } }), {});
  assert.deepEqual(changed, ["sprites.wq.url"]);
  assert.equal(manifest.sprites.length, 3, "the other records survive, and stay a list");
  assert.equal(manifest.sprites[2].url, "/fixed.png");
  assert.equal(manifest.sprites[0].url, "/a.png");

  // Keying on a tag hits every expression of that character; keying on a full
  // name hits one. Both spellings are how the manifest itself names them.
  const byTag = { sprites: [{ name: "qc happy", tag: "qc", url: "/a.png" }, { name: "qc sad", tag: "qc", url: "/b.png" }] };
  applyProfile(byTag, profileOverlay({ sprites: { qc: { source: "profile" } } }));
  assert.deepEqual(byTag.sprites.map((sprite) => sprite.source), ["profile", "profile"]);

  const byName = { sprites: [{ name: "qc happy", tag: "qc", url: "/a.png" }, { name: "qc sad", tag: "qc", url: "/b.png" }] };
  applyProfile(byName, profileOverlay({ sprites: { "qc happy": { url: "/only.png" } } }));
  assert.deepEqual(byName.sprites.map((sprite) => sprite.url), ["/only.png", "/b.png"]);

  // A tag no record carries is reported rather than silently dropped: the file
  // would otherwise say the sprite is fixed while the stage never saw it.
  const diagnostics = {};
  const missing = { sprites: [{ name: "qc", tag: "qc", url: "/a.png" }] };
  assert.deepEqual(applyProfile(missing, profileOverlay({ sprites: { nope: { url: "/x.png" } } }), diagnostics), []);
  assert.deepEqual(diagnostics.unmatched, ["sprites.nope"]);
});

test("a module list is validated node by node and replaces the scanned list whole", () => {
  // `dialogbox.modules` is a LIST the client draws in order. Merging it field by
  // field would either resurrect nodes the profile meant to remove or leave a
  // half-valid node drawn next to the game's own pieces, so the key is replaced
  // whole — the same rule as every other flat section field.
  const ornament = { kind: "image", rect: { x: 10, y: 20, w: 30, h: 40 }, image: "gui/ornament.png", z: 3 };
  const report = inspectProfileConfig({ dialogbox: { modules: [ornament] } });
  assert.deepEqual(report.accepted, ["dialogbox"]);
  assert.deepEqual(report.malformed, [], "a well-formed node is not a malformed section");

  const overlay = profileOverlay({ dialogbox: { modules: [ornament] } });
  const manifest = { dialogbox: { modules: [{ kind: "text", rect: { x: 0, y: 0, w: 1, h: 1 }, text: "scan" }] } };
  assert.deepEqual(applyProfile(manifest, overlay), ["dialogbox.modules"]);
  assert.deepEqual(manifest.dialogbox.modules, [ornament], "the scanned node is gone, not merged with");

  // An empty list is a statement ("draw none of the scanned pieces"), not the
  // absence of one. Reading it as silence would leave the scan's modules drawn
  // while the receipt said the overlay had been applied.
  const cleared = { dialogbox: { modules: [] } };
  assert.deepEqual(inspectProfileConfig(cleared).accepted, ["dialogbox"]);
  const clearedManifest = { dialogbox: { modules: [ornament] } };
  assert.deepEqual(applyProfile(clearedManifest, profileOverlay(cleared)), ["dialogbox.modules"]);
  assert.deepEqual(clearedManifest.dialogbox.modules, []);
  assert.deepEqual(applyProfile({ dialogbox: { modules: [] } }, profileOverlay(cleared)), [], "clearing an empty list changes nothing");

  // One bad node must not take the whole box down: the good ones are written
  // and the bad one is named by index, which is how the digest writes it too.
  const mixed = inspectProfileConfig({
    dialogbox: {
      modules: [
        ornament,
        { kind: "hologram", rect: { x: 0, y: 0, w: 1, h: 1 } },
        { kind: "text", rect: { x: 0, y: "wide", w: 1, h: 1 }, text: "no" },
      ],
    },
  });
  assert.deepEqual(mixed.accepted, ["dialogbox"]);
  assert.deepEqual(mixed.malformed, ["dialogbox.modules[1]", "dialogbox.modules[2]"]);

  // Past the cap the list is truncated, not rejected outright, and the dropped
  // indices are reported so the agent can see what did not fit.
  const many = Array.from({ length: 42 }, (_, index) => ({ kind: "box", rect: { x: index, y: 0, w: 1, h: 1 } }));
  const capped = inspectProfileConfig({ dialogbox: { modules: many } });
  assert.deepEqual(capped.accepted, ["dialogbox"]);
  assert.deepEqual(capped.malformed, ["dialogbox.modules[40]", "dialogbox.modules[41]"]);
  assert.equal(profileOverlay({ dialogbox: { modules: many } }).dialogbox.modules.length, 40);

  // A non-list is malformed rather than silently swapping the list for an object.
  const wrongShape = inspectProfileConfig({ dialogbox: { modules: { kind: "box" } } });
  assert.deepEqual(wrongShape.accepted, []);
  assert.deepEqual(wrongShape.malformed, ["dialogbox.modules"]);
});
