// Regression tests for background/sprite classification, the splash opening,
// and main-menu music (task D of docs/VN-READ-AUDIT.md). Each game is a real
// temporary directory on disk; no file system or extractor is mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildManifest } from "../lib/manifest.js";
import { resolveMenuMusic } from "../lib/renpy.js";

/**
 * A GIF whose logical screen descriptor carries the given size. `readImageSize`
 * reads only the header, so this is the smallest real file that reports a
 * width and height.
 */
function gifOfSize(width, height) {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

/**
 * Lay out `files` (game-relative path to content) under a fresh `game/` folder
 * and return the parent directory that `buildManifest` expects.
 */
function makeGame(files) {
  const root = mkdtempSync(join(tmpdir(), "renpy-media-test-"));
  const gameDir = join(root, "game");
  mkdirSync(gameDir, { recursive: true });
  writeFileSync(join(gameDir, "gui.rpy"), "init python:\n    gui.textbox_height = 278\n", "utf8");
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(gameDir, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function build(root) {
  return buildManifest(root, { assetUrl: (path) => `u:${path}` }).manifest;
}

test("UI icons under gui/ are neither characters nor scenery", () => {
  // Symptom: the sprite index held the music-room `repeat 1` control (67x57) as
  // a stage character, and the background list was padded with button art,
  // because every file under gui/ counted as a background.
  const game = makeGame({
    "images/sprites/eileen/eileen happy.gif": gifOfSize(400, 800),
    "gui/music_room/repeat 1.gif": gifOfSize(67, 57),
    "gui/button/choice_idle_background.gif": gifOfSize(600, 80),
    "gui/main_menu.gif": gifOfSize(1920, 1080),
  });
  try {
    const manifest = build(game.root);
    const spritePaths = Object.values(manifest.spriteIndex).map((entry) => entry.path);
    assert.ok(spritePaths.includes("images/sprites/eileen/eileen happy.gif"));
    assert.equal(spritePaths.some((path) => path.startsWith("gui/")), false);
    const backgroundPaths = manifest.backgrounds.map((entry) => entry.path);
    assert.ok(backgroundPaths.includes("gui/main_menu.gif"), "the title plate is still the main-menu background");
    assert.equal(backgroundPaths.some((path) => path.includes("choice_idle")), false);
  } finally {
    game.dispose();
  }
});

test("a scenery file with a space in its name is a background, not a character", () => {
  // Symptom: `images/backgrounds/crystal corridor.webp` split on the space into
  // tag `crystal` with attribute `corridor`, so every scenery file with a space
  // was offered to the model as a character called `crystal`.
  const game = makeGame({
    "images/backgrounds/crystal corridor.gif": gifOfSize(1920, 1080),
    "images/sprites/alfred/alf eyes.gif": gifOfSize(500, 900),
  });
  try {
    const manifest = build(game.root);
    assert.ok(manifest.backgrounds.some((entry) => entry.path === "images/backgrounds/crystal corridor.gif"));
    assert.equal(
      Object.values(manifest.spriteIndex).some((entry) => entry.path.includes("crystal corridor")),
      false,
    );
    assert.ok(manifest.spriteIndex["alf eyes"], "a real character still resolves");
  } finally {
    game.dispose();
  }
});

test("a splash shows its logo, not the black fade frame, and sums its pauses", () => {
  // Symptom: `scene black` before the logo was taken as the opening's still, so
  // the skin covered the game with a black rectangle for 4 seconds; and
  // `pause 2.0` / `pause 3.5` were ignored, so the still dropped after the
  // fallback 4 seconds instead of the 5.5 the game actually waits.
  const game = makeGame({
    "images/backgrounds/black.gif": gifOfSize(1920, 1080),
    "images/logo.gif": gifOfSize(1920, 1080),
    "script.rpy": [
      "label splashscreen:",
      "    scene black",
      "    show logo at truecenter",
      "    pause 2.0",
      "    scene black",
      "    pause 3.5",
      "    return",
      "",
    ].join("\n"),
  });
  try {
    const manifest = build(game.root);
    assert.equal(manifest.splash.kind, "image");
    assert.equal(manifest.splash.path, "images/logo.gif");
    assert.equal(manifest.splash.duration, 5.5);
  } finally {
    game.dispose();
  }
});

test("main-menu music from label main_menu is found when config declares none", () => {
  // Symptom: a game that starts its title music with `play music` inside
  // `label main_menu` reported `menuMusic: []`, so the header had no track to
  // follow and the title screen was silent in the skin.
  const game = makeGame({
    "audio/music/title.ogg": Buffer.from("OggS"),
    "script.rpy": [
      "label main_menu:",
      '    play music "audio/music/title.ogg" fadein 1.0',
      "    return",
      "",
    ].join("\n"),
  });
  try {
    const manifest = build(game.root);
    assert.deepEqual(
      manifest.audio.menuMusic.map((track) => track.path),
      ["audio/music/title.ogg"],
    );
  } finally {
    game.dispose();
  }
});

test("main-menu music from a screen's Play action resolves an audio alias", () => {
  // Symptom: `on "show" action Play("music", audio.theme)` in `screen main_menu`
  // was not read at all, because only `config.main_menu_music` was consulted.
  const game = makeGame({
    "audio/music/theme.ogg": Buffer.from("OggS"),
    "script.rpy": [
      'define audio.theme = "audio/music/theme.ogg"',
      "screen main_menu():",
      '    on "show" action Play("music", audio.theme)',
      "",
    ].join("\n"),
  });
  try {
    const manifest = build(game.root);
    assert.deepEqual(
      manifest.audio.menuMusic.map((track) => track.path),
      ["audio/music/theme.ogg"],
    );
  } finally {
    game.dispose();
  }
});

test("a `<loop N>` audio prefix is not part of the menu track's file name", () => {
  // Symptom (Tavern of Spear): the title music was requested as
  // `<loop 5.3194>music/tavern_menu_base.ogg`, a URL that does not exist, so the
  // main-menu music never played.
  const menu = resolveMenuMusic([{ path: "options.rpy", text: 'define config.main_menu_music = "<loop 5.3194>music/menu.ogg"\n' }]);
  assert.equal(menu.tracks[0].path, "music/menu.ogg");
});
