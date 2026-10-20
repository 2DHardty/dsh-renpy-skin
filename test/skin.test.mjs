/**
 * Headless test suite — no DSH host, no browser, no game installation.
 *
 * Everything under `lib/` is plain ESM with no runtime dependencies, so the
 * whole pipeline can be exercised with `node --test`. The manifest tests build
 * a throwaway Ren'Py game in the OS temp directory, which is what keeps them
 * honest: `resolveGameDir` is fed a *real* directory layout rather than a mock.
 *
 * Usage:
 *   node --test "test/*.test.mjs"   # the default in the Makefile
 *   node --test test/skin.test.mjs
 *
 * The quoted glob is required: a directory argument (`node --test test/`)
 * fails on both Node 22 and Node 24, which is why the Makefile quotes it too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  tokenize,
  parseStatement,
  logicalLines,
  resolveTransform,
  resolveSprite,
  findBackground,
  applyStatements,
  StageStore,
  StageError,
  BUILTIN_TRANSFORMS,
  SUPPORTED_TRANSITIONS,
} from "../lib/stage.js";
import { buildManifest, normaliseColor, lighten, readableForeground, colorToRgb } from "../lib/manifest.js";
import { apply, directorBrief } from "../lib/index.js";
import {
  stripComments,
  evalValue,
  readAssignments,
  splitTopLevel,
  readAudioAliases,
  resolveMenuMusic,
  readSplashscreen,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from "../lib/renpy.js";

// ── helpers ─────────────────────────────────────────────────────────────────

/** A 1x1 GIF, the smallest valid image the size reader accepts. */
const TINY_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
/** A 1x1 PNG: the plate fixtures carry a `.png` name, so their bytes must be a PNG. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Build a throwaway Ren'Py game on disk and return its root plus a cleanup
 * function. Deliberately shaped like a real game: a `game/` subdirectory,
 * explicit `image` statements, a `bg`-prefixed background, and a sprite whose
 * filename dashes must NOT be split into attributes.
 *
 * `files` writes extra files verbatim (audio, video, splash art), so the media
 * tests exercise a real directory layout rather than a mocked index.
 */
function makeGame({ declarations = "", images = [], files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "renpy-skin-test-"));
  const gameDir = join(root, "game");
  mkdirSync(join(gameDir, "images", "backgrounds"), { recursive: true });
  mkdirSync(join(gameDir, "images", "sprites"), { recursive: true });

  writeFileSync(
    join(gameDir, "gui.rpy"),
    [
      "init python:",
      '    gui.textbox_height = 278',
      '    gui.accent_color = "#4a9eff"',
      '    gui.text_color = "#ffffff"',
      '    gui.text_size = 33',
      '    gui.name_text_size = 45',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(gameDir, "options.rpy"),
    ["define config.name = _(\"Test VN\")", "define config.version = \"9.9\"", "define config.screen_width = 1920", "define config.screen_height = 1080", ""].join("\n"),
    "utf8",
  );
  writeFileSync(join(gameDir, "script.rpy"), declarations, "utf8");

  writeFileSync(join(gameDir, "images", "backgrounds", "forest day.gif"), TINY_GIF);
  writeFileSync(join(gameDir, "images", "sprites", "eileen-happy.gif"), TINY_GIF);
  for (const relative of images) {
    const target = join(gameDir, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, TINY_GIF);
  }
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(gameDir, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }

  return {
    root,
    gameDir,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Call one route with a JSON body and resolve with the parsed reply.
 *
 * The live `webServer` hands a Node `IncomingMessage`, not a Web `Request`, so
 * the request half is an EventEmitter stand-in that emits the body synchronously.
 */
function callRoute(route, { method = "GET", url = route.path, body } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    route.handler(
      {
        method,
        url,
        on: (event, callback) => {
          if (payload === undefined) {
            if (event === "end") callback();
            return;
          }
          if (event === "data") callback(payload);
          if (event === "end") callback();
        },
      },
      {
        setHeader: () => {},
        writeHead: () => {},
        end: (reply) => resolve(JSON.parse(String(reply))),
      },
    );
  });
}

/**
 * A real 16-bit mono PCM WAV of `seconds` at `rate`, so the duration reader is
 * fed bytes a caller would actually see rather than a hand-built header.
 */
function wavBytes(seconds, rate = 8000) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A hand-built manifest, for tests that only exercise stage logic. */
function fakeManifest(overrides = {}) {
  const sprite = {
    name: "eileen happy",
    tag: "eileen",
    attributes: ["happy"],
    url: "/asset?p=eileen-happy.gif",
    path: "images/sprites/eileen-happy.gif",
  };
  return {
    game: { name: "Test VN", screen: { w: 1920, h: 1080 } },
    backgrounds: [
      { name: "bg forest", tag: "bg", attributes: ["forest"], url: "/asset?p=forest.gif", path: "images/backgrounds/forest.gif" },
    ],
    sprites: [
      sprite,
      { ...sprite, name: "eileen sad", attributes: ["sad"] },
      { ...sprite, name: "bob happy", tag: "bob", attributes: ["happy"] },
    ],
    spriteIndex: {
      "eileen happy": sprite,
      "eileen sad": { ...sprite, name: "eileen sad", attributes: ["sad"] },
      "bob happy": { ...sprite, name: "bob happy", tag: "bob", attributes: ["happy"] },
    },
    tags: [
      { tag: "eileen", total: 2, expressions: [{ label: "happy", name: "eileen happy", url: "/asset?p=x" }] },
      { tag: "bob", total: 1, expressions: [{ label: "happy", name: "bob happy", url: "/asset?p=x" }] },
    ],
    transforms: {},
    ...overrides,
  };
}

// ── renpy.rpy-expression reading ────────────────────────────────────────────

test("stripComments removes comments without touching strings", () => {
  const source = ['define config.name = "a # b"  # trailing', ''].join("\n");
  const stripped = stripComments(source);
  assert.ok(stripped.includes('"a # b"'), "a # inside a string literal must survive");
  assert.ok(!stripped.includes("trailing"), "a real comment must be removed");
});

test("evalValue handles literals, translation, tuples and Borders", () => {
  assert.equal(evalValue('"hello"'), "hello");
  assert.equal(evalValue("1920"), 1920);
  assert.equal(evalValue("1.5"), 1.5);
  assert.equal(evalValue("True"), true);
  assert.equal(evalValue("False"), false);
  assert.equal(evalValue("None"), null);
  assert.equal(evalValue("_(\"Test VN\")"), "Test VN");
  assert.deepEqual(evalValue("(1, 2)"), [1, 2]);
  assert.deepEqual(evalValue("Borders(5, 5)"), { left: 5, top: 5, right: 5, bottom: 5 });
  assert.deepEqual(evalValue("Borders(1, 2, 3, 4)"), { left: 1, top: 2, right: 3, bottom: 4 });
  // Arithmetic and concatenation are deliberately NOT evaluated: the reader
  // understands literals only, so an expression yields `undefined` and the
  // caller falls back to the game's own default.
  assert.equal(evalValue('"a" + "b"'), undefined);
  assert.equal(evalValue("300 + 6"), undefined);
});

test("splitTopLevel splits on commas outside nesting", () => {
  assert.deepEqual(splitTopLevel("a, b, c"), ["a", "b", "c"]);
  assert.deepEqual(splitTopLevel("f(1, 2), 3"), ["f(1, 2)", "3"]);
});

test("readAssignments collects define/init values", () => {
  const names = readAssignments(
    ['define config.name = _("Test VN")', 'define config.version = "9.9"', "define config.screen_width = 1920", ""].join("\n"),
  );
  assert.equal(names.get("config.name"), "Test VN");
  assert.equal(names.get("config.version"), "9.9");
  assert.equal(names.get("config.screen_width"), 1920);
});

// ── stage tokenizer and parser ──────────────────────────────────────────────

test("tokenize separates words, numbers, strings and punctuation", () => {
  const tokens = tokenize('show eileen happy at center zorder 5 alpha "1.0"');
  assert.equal(tokens[0].value, "show");
  assert.ok(tokens.some((t) => t.kind === "number" && t.value === 5));
  assert.ok(tokens.some((t) => t.kind === "string" && t.value === "1.0"));
});

/** A statement's image name, as `applyStatements` reads it. */
function imageName(statement) {
  return Array.isArray(statement.image) ? statement.image.join(" ") : statement.image;
}

test("parseStatement reads show with at / behind / zorder / as", () => {
  const statement = parseStatement("show eileen happy at left, Transform(zoom=0.9) behind bob zorder 5 as ghost");
  assert.equal(statement.kind, "show");
  assert.equal(imageName(statement), "eileen happy");
  assert.deepEqual(statement.at, [{ name: "left", props: {} }, { props: { zoom: 0.9 }, from: "Transform(...)" }]);
  assert.deepEqual(statement.behind, ["bob"]);
  assert.equal(statement.zorder, 5);
  assert.equal(statement.as, "ghost");
});

test("parseStatement: `at` terminates the image name, so zorder is not an attribute", () => {
  // Regression: the image run used to swallow the integer after `zorder`.
  const statement = parseStatement("show art angry l at center zorder 5");
  assert.equal(imageName(statement), "art angry l");
  assert.deepEqual(statement.at, [{ name: "center", props: {} }]);
  assert.equal(statement.zorder, 5);
});

test("parseStatement: a clause keyword ends the previous clause's tag list", () => {
  // Regression: `behind bob zorder 5` used to read `zorder` as a second
  // behind-tag and then swallow `5`.
  const statement = parseStatement("show eileen happy behind bob zorder 5");
  assert.equal(imageName(statement), "eileen happy");
  assert.deepEqual(statement.behind, ["bob"]);
  assert.equal(statement.zorder, 5);
});

test("parseStatement returns the image name as a joined string", () => {
  // `parseStatement` joins the components; `applyStatements` re-splits on
  // spaces to find the tag and attributes.
  const statement = parseStatement("scene bg forest with fade if persistent.seen == True");
  assert.equal(statement.kind, "scene");
  assert.equal(statement.image, "bg forest");
  assert.equal(statement.transition, "fade");
  assert.deepEqual(statement.condition, { variable: "persistent.seen", operator: "==", value: "True" });
});

test("parseStatement only accepts an `if` with a comparison operator", () => {
  // A bare truthiness check is rejected on purpose: the stage does not run
  // game expressions, so `if persistent.seen` cannot be evaluated.
  assert.throws(() => parseStatement("show eileen happy if persistent.seen"), StageError);
});

test("parseStatement rejects unsupported statements and transitions", () => {
  assert.throws(() => parseStatement("frobnicate something"), StageError);
  assert.throws(() => parseStatement("scene bg forest with wipeleft"), StageError);
});

test("logicalLines drops comments and blank lines but keeps statements", () => {
  const lines = logicalLines("# a comment\n\nshow eileen happy\nscene bg forest\n");
  assert.deepEqual(lines, ["show eileen happy", "scene bg forest"]);
});

// ── transforms ──────────────────────────────────────────────────────────────

test("resolveTransform knows the built-ins and rejects unknown names", () => {
  assert.ok(Object.keys(BUILTIN_TRANSFORMS).includes("left"));
  assert.ok(Object.keys(BUILTIN_TRANSFORMS).includes("right"));
  assert.deepEqual(resolveTransform({ name: "left" }), BUILTIN_TRANSFORMS.left);
  assert.throws(() => resolveTransform({ name: "nosuchtransform" }), StageError);
});

test("resolveTransform falls back to a game-defined transform", () => {
  // The game transform must have a name the built-ins do not claim, since
  // built-ins win by design. The manifest stores transforms as `{ props, atl }`.
  const resolved = resolveTransform({ name: "tucked" }, { tucked: { props: { xpos: 0.11, ypos: 0.4 } } });
  assert.equal(resolved.xpos, 0.11);
  assert.equal(resolved.ypos, 0.4);
});

test("resolveTransform merges inline props over the named transform", () => {
  const resolved = resolveTransform({ name: "left", props: { ypos: 0.25 } });
  assert.equal(resolved.ypos, 0.25);
  assert.equal(resolved.xpos, BUILTIN_TRANSFORMS.left.xpos, "unspecified props are inherited");
});

test("resolveTransform rejects an unknown transform and lists what exists", () => {
  try {
    resolveTransform({ name: "nosuchtransform" });
    assert.fail("expected a StageError");
  } catch (error) {
    assert.ok(error instanceof StageError);
    assert.ok(error.details.builtinTransforms.includes("left"));
  }
});

test("supported transitions are the documented set", () => {
  assert.deepEqual([...SUPPORTED_TRANSITIONS].filter((t) => t !== "None").sort(), ["dissolve", "fade", "none"]);
});

// ── sprite / background resolution ──────────────────────────────────────────

test("resolveSprite tolerates a missing attribute group", () => {
  const manifest = fakeManifest();
  assert.equal(resolveSprite(manifest, "eileen happy").name, "eileen happy");
  assert.equal(resolveSprite(manifest, "eileen").name, "eileen happy", "a bare tag picks the plainest expression");
  assert.equal(resolveSprite(manifest, "nobody"), undefined);
});

test("resolveSprite falls back to the full index for names the caps trimmed", () => {
  const trimmed = fakeManifest({ sprites: [] });
  assert.equal(resolveSprite(trimmed, "eileen sad").name, "eileen sad");
});

test("show side restores the stripped side prefix before resolving", () => {
  const manifest = fakeManifest({
    spriteIndex: {
      ...fakeManifest().spriteIndex,
      "side head_meteor angry": {
        name: "side head_meteor angry",
        tag: "side",
        attributes: ["head_meteor", "angry"],
        url: "/asset?p=side.png",
        path: "images/textbox/meteor/head_meteor_face_angry.png",
      },
    },
  });
  const store = new StageStore();
  const stage = store.get("side-test");
  applyStatements(stage, [parseStatement("show side head_meteor angry at center")], manifest);
  assert.equal(stage.sprites.length, 1);
  assert.equal(stage.sprites[0].image, "side head_meteor angry");
  assert.equal(stage.sprites[0].tag, "side");
  assert.equal(stage.sprites[0].side, true);
});

test("findBackground matches a bare or prefixed name", () => {
  const manifest = fakeManifest();
  assert.equal(findBackground(manifest, "bg forest").name, "bg forest");
  assert.equal(findBackground(manifest, "forest").name, "bg forest");
  assert.equal(findBackground(manifest, "nowhere"), undefined);
});

// ── stage state machine ─────────────────────────────────────────────────────

test("applyStatements: scene resets, show is idempotent per tag, hide removes", () => {
  const store = new StageStore();
  const manifest = fakeManifest();
  const stage = store.get("s1");

  applyStatements(stage, [parseStatement("scene bg forest with fade")], manifest);
  assert.equal(stage.scene.image, "bg forest");
  assert.equal(stage.transition, "fade");

  applyStatements(stage, [parseStatement("show eileen happy at center")], manifest);
  applyStatements(stage, [parseStatement("show eileen sad at left")], manifest);
  assert.equal(stage.sprites.length, 1, "re-showing a tag swaps its expression in place");
  assert.equal(stage.sprites[0].image, "eileen sad");

  applyStatements(stage, [parseStatement("show bob happy")], manifest);
  const hidden = applyStatements(stage, [parseStatement("hide bob")], manifest);
  assert.equal(stage.sprites.length, 1);
  assert.ok(hidden.applied.some((entry) => entry.kind === "hide"));

  const missing = applyStatements(stage, [parseStatement("hide nobody")], manifest);
  assert.equal(missing.warnings.length, 1, "hiding an absent tag warns instead of throwing");
});

test("applyStatements: re-showing a tag keeps its zorder but adopts the new expression", () => {
  const store = new StageStore();
  const manifest = fakeManifest();
  const stage = store.get("s1");
  applyStatements(stage, [parseStatement("show eileen happy at center zorder 7")], manifest);
  applyStatements(stage, [parseStatement("show eileen sad at left")], manifest);
  assert.equal(stage.sprites[0].zorder, 7);
  assert.equal(stage.sprites[0].image, "eileen sad");
});

test("applyStatements throws a StageError naming the alternatives", () => {
  const store = new StageStore();
  const manifest = fakeManifest();
  const stage = store.get("s1");
  try {
    applyStatements(stage, [parseStatement("show nobody happy")], manifest);
    assert.fail("expected a StageError");
  } catch (error) {
    assert.ok(error instanceof StageError);
    assert.match(error.message, /unknown image/);
    assert.ok(Array.isArray(error.details.tags), "the rejection carries the options that do exist");
  }
  try {
    applyStatements(stage, [parseStatement("scene bg nowhere")], manifest);
    assert.fail("expected a StageError");
  } catch (error) {
    assert.equal(error.details.backgroundCount, 1);
  }
});

test("safe area: collision warns by default and is shifted when autoAvoid is on", () => {
  const store = new StageStore();
  const manifest = fakeManifest();
  const safeArea = [{ id: "namebox", x: 0.1, y: 0.8, w: 0.3, h: 0.15, coversX: true }];

  const stage = store.get("s1");
  const warned = applyStatements(stage, [parseStatement("show eileen happy at center")], manifest, { safeArea });
  assert.equal(stage.sprites[0].xpos, 0.5, "without autoAvoid the placement is left alone");
  assert.match(warned.warnings.join(" "), /reserved area/);

  const shifted = applyStatements(stage, [parseStatement("show eileen happy at center")], manifest, {
    safeArea,
    autoAvoid: true,
  });
  assert.notEqual(stage.sprites[0].xpos, 0.5, "autoAvoid moves the sprite out of the reserved area");
  assert.ok(stage.sprites[0].xpos > 0.4, "it shifts to the right of the reserved x range");
  assert.match(shifted.warnings.join(" "), /auto-avoid/);
});

test("an explicit xoffset is treated as a deliberate override and never warns", () => {
  const store = new StageStore();
  const manifest = fakeManifest();
  const stage = store.get("s1");
  const result = applyStatements(
    stage,
    [parseStatement("show eileen happy at Transform(xoffset=10, xpos=0.5)")],
    manifest,
    { safeArea: [{ id: "namebox", x: 0.1, y: 0.8, w: 0.3, h: 0.15, coversX: true }], autoAvoid: true },
  );
  assert.equal(result.warnings.filter((line) => line.includes("reserved area")).length, 0);
});

test("StageStore keeps sessions independent", () => {
  const store = new StageStore();
  const manifest = fakeManifest();
  applyStatements(store.get("a"), [parseStatement("scene bg forest")], manifest);
  assert.equal(store.get("a").scene.image, "bg forest");
  assert.equal(store.get("b").scene, undefined, "one conversation's stage must not leak into another");
});

// ── colour helpers ──────────────────────────────────────────────────────────

test("normaliseColor accepts the spellings Ren'Py uses", () => {
  assert.equal(normaliseColor("#fff"), "#ffffff");
  assert.equal(normaliseColor("#FFFFFF"), "#ffffff");
  assert.equal(normaliseColor("#4a9eff"), "#4a9eff");
  assert.equal(normaliseColor("#4a9effcc"), "#4a9eff");
  assert.equal(normaliseColor("not a colour"), undefined);
});

test("colorToRgb / lighten / readableForeground behave", () => {
  assert.deepEqual(colorToRgb("#000000"), [0, 0, 0]);
  assert.deepEqual(colorToRgb("#ffffff"), [255, 255, 255]);
  assert.equal(lighten("#000000", 0.5), "#808080");
  assert.equal(readableForeground("#000000"), "#ffffff");
  assert.equal(readableForeground("#ffffff"), "#111111");
});

// ── manifest pipeline against a real directory layout ───────────────────────

test("buildManifest reads a game directory end to end", () => {
  const game = makeGame({
    declarations: [
      'image bg forest = "images/backgrounds/forest day.gif"',
      'image eileen happy = "images/sprites/eileen-happy.gif"',
      "",
    ].join("\n"),
  });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    assert.equal(manifest.game.name, "Test VN");
    assert.equal(manifest.game.version, "9.9");
    assert.deepEqual(manifest.game.screen, { w: 1920, h: 1080 });
    assert.equal(manifest.dialogbox.height, 278);
    assert.equal(manifest.dialogbox.textColor, "#ffffff");
    assert.ok(manifest.backgrounds.some((bg) => bg.name === "bg forest"), "an explicit bg statement is a background");
    assert.ok(manifest.tags.some((tag) => tag.tag === "eileen"), "the sprite tag is discovered");
    assert.ok(manifest.theme["--dsw-alias-brand-primary"].dark, "the theme suggestion is derived from the accent");
    // The tool block answers "is unrpyc on this machine", which is a different
    // question from "did this run decompile anything". It must be filled even
    // when a script was read, or a partial decompile looks like a clean run.
    assert.equal(typeof manifest.scripts.tool?.python, "object", "the Python probe is reported");
    assert.equal(typeof manifest.scripts.tool?.unrpyc, "object", "the unrpyc probe is reported");
    assert.ok(manifest.scripts.found.looseRpy >= 1, "loose scripts are counted");
  } finally {
    game.dispose();
  }
});

test("buildManifest does not split dashes in a filename into attributes", () => {
  // Regression: `eileen-happy.gif` must not become `eileen happy` with two
  // attributes — the dash is part of the filename, not a component separator.
  const game = makeGame({ declarations: "" });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    const derived = manifest.sprites.map((sprite) => sprite.name);
    assert.ok(
      !derived.includes("happy"),
      `a dashed filename must not yield a bare 'happy' attribute; got ${JSON.stringify(derived)}`,
    );
  } finally {
    game.dispose();
  }
});

test("buildManifest resolves a declared path that carries the images/ prefix", () => {
  const game = makeGame({
    declarations: 'image eileen happy = "images/sprites/eileen-happy.gif"\n',
  });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    const sprite = manifest.sprites.find((entry) => entry.name === "eileen happy");
    assert.ok(sprite !== undefined, "the explicit statement must resolve against the indexed files");
    assert.ok(sprite.url.startsWith("/asset?p="));
  } finally {
    game.dispose();
  }
});

test("buildManifest on a directory with no game/ subdirectory reads the path as the game dir", () => {
  // `resolveGameDir` accepts either a Ren'Py root (with `game/` inside) or the
  // `game/` directory itself. An empty directory therefore yields a manifest
  // with defaults rather than throwing.
  const empty = mkdtempSync(join(tmpdir(), "renpy-skin-empty-"));
  try {
    const { manifest } = buildManifest(empty, { assetUrl: (p) => p });
    assert.equal(manifest.backgrounds.length, 0);
    assert.equal(manifest.sprites.length, 0);
    // With no options.rpy the name falls back to the directory name, which is
    // what Ren'Py itself does.
    assert.equal(manifest.game.name, empty.split(/[\\/]/).pop());
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("buildManifest on a missing path yields an empty manifest instead of throwing", () => {
  // Documented behaviour: a wrong `gameDir` surfaces as an empty manifest in
  // the settings page, not as a failed request.
  const missing = join(tmpdir(), `renpy-skin-missing-${Date.now()}-${process.pid}`);
  const { manifest } = buildManifest(missing, { assetUrl: (p) => p });
  assert.equal(manifest.backgrounds.length, 0);
  assert.equal(manifest.sprites.length, 0);
});

// ── layeredimage ────────────────────────────────────────────────────────────

test("buildManifest turns a layeredimage into a layered sprite with group attributes", () => {
  const game = makeGame({
    declarations: "",
    images: [
      "images/sprite/enid/enid_body_normal.gif",
      "images/sprite/enid/enid_body_outside.gif",
      "images/sprite/enid/enid_face_smile.gif",
      "images/sprite/enid/enid_glasses_glasses.gif",
    ],
  });
  // The layeredimage block lives in a loose script; makeGame writes it to
  // script.rpy via `declarations`, so re-open and append for clarity.
  try {
    writeFileSync(
      join(game.gameDir, "script.rpy"),
      [
        "layeredimage enid:",
        "    zoom 0.36",
        "    xcenter 0.5",
        "    yalign 1.0",
        "    group body:",
        "        attribute normal default",
        "        attribute outside",
        "    group face:",
        "        attribute def default null",
        "        attribute smile",
        "    group glasses:",
        "        attribute no_glasses default null",
        "        attribute glasses",
        "",
      ].join("\n"),
      "utf8",
    );
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    const sprite = manifest.sprites.find((entry) => entry.name === "enid");
    assert.ok(sprite !== undefined, "the layeredimage tag is discovered as a sprite");
    assert.equal(sprite.layered, true);
    // Group attributes are the flat union of every non-default-null attribute.
    assert.ok(sprite.attributes.includes("smile"));
    assert.ok(sprite.attributes.includes("glasses"));
    assert.ok(sprite.attributes.includes("outside"));
    assert.ok(!sprite.attributes.includes("def"), "default-null attributes draw no layer");
    // The block-level ATL becomes the base transform (xcenter→xalign, yalign kept).
    assert.equal(sprite.base.zoom, 0.36);
    assert.equal(sprite.base.xalign, 0.5);
    assert.equal(sprite.base.yalign, 1);
    // `tags` offers each attribute as its own expression line.
    const tag = manifest.tags.find((entry) => entry.tag === "enid");
    assert.ok(tag !== undefined);
    const labels = tag.expressions.map((expression) => expression.label);
    assert.ok(labels.includes("smile"));
    assert.ok(labels.includes("glasses"));
    assert.ok(labels.includes("outside"));
    // The index carries the layer map so the stage can stack it.
    assert.equal(manifest.spriteIndex.enid.layered, true);
    assert.ok(manifest.spriteIndex.enid.layers.body.normal.url.startsWith("/asset?p="));
  } finally {
    game.dispose();
  }
});

test("applyStatements stacks the chosen layers for a layered show", () => {
  const manifest = fakeManifest({
    sprites: [
      {
        name: "enid",
        tag: "enid",
        attributes: ["normal", "outside", "smile", "thinking", "glasses"],
        layered: true,
        base: { zoom: 0.36, xalign: 0.5, yalign: 1 },
        groups: [
          { name: "body", attributes: [
            { name: "normal", default: true, url: "/asset?p=body_normal" },
            { name: "outside", default: false, url: "/asset?p=body_outside" },
          ] },
          { name: "face", attributes: [
            { name: "def", default: true, defaultNull: true },
            { name: "smile", default: false, url: "/asset?p=face_smile" },
            { name: "thinking", default: false, url: "/asset?p=face_thinking" },
          ] },
          { name: "glasses", attributes: [
            { name: "no_glasses", default: true, defaultNull: true },
            { name: "glasses", default: false, url: "/asset?p=glasses" },
          ] },
        ],
        layers: {},
      },
    ],
    spriteIndex: { enid: {
      name: "enid", tag: "enid",
      attributes: ["normal", "outside", "smile", "thinking", "glasses"],
      layered: true,
      base: { zoom: 0.36, xalign: 0.5, yalign: 1 },
      groups: [
        { name: "body", attributes: [
          { name: "normal", default: true, url: "/asset?p=body_normal" },
          { name: "outside", default: false, url: "/asset?p=body_outside" },
        ] },
        { name: "face", attributes: [
          { name: "def", default: true, defaultNull: true },
          { name: "smile", default: false, url: "/asset?p=face_smile" },
          { name: "thinking", default: false, url: "/asset?p=face_thinking" },
        ] },
        { name: "glasses", attributes: [
          { name: "no_glasses", default: true, defaultNull: true },
          { name: "glasses", default: false, url: "/asset?p=glasses" },
        ] },
      ],
      layers: {},
    } },
  });
  const store = new StageStore();
  const stage = store.get("s");
  applyStatements(stage, [parseStatement("show enid glasses thinking")], manifest, {});
  const sprite = stage.sprites[0];
  assert.equal(sprite.layered, true);
  // Three groups stack: body (unset → default `normal`), face (thinking),
  // glasses (glasses).
  assert.deepEqual(
    sprite.activeLayers.map((layer) => layer.attribute),
    ["normal", "thinking", "glasses"],
  );
  // The base ATL zoom is applied as the default transform.
  assert.equal(sprite.zoom, 0.36);
  assert.equal(sprite.ypos, 1);
});

test("an empty background and a layered sprite keep the tool result lossless JSON", () => {
  // Regression: DSH snapshots every tool result as lossless JSON and rejects a
  // present-but-undefined property. A bare `scene` cleared the background to
  // `undefined`, and a layeredimage had no single `url`; from that call on every
  // `renpy_stage` returned "value is not lossless JSON" — the model saw no
  // sprites and no reason, and only a `clear` + `scene bg …` recovered.
  const manifest = fakeManifest({
    sprites: [{
      name: "enid",
      tag: "enid",
      attributes: ["normal", "glasses"],
      layered: true,
      base: {},
      groups: [
        { name: "body", attributes: [
          { name: "normal", default: true, url: "/asset?p=body_normal" },
          { name: "glasses", default: false, url: "/asset?p=glasses" },
        ] },
      ],
      layers: {},
    }],
    spriteIndex: {},
  });
  const store = new StageStore();
  const stage = store.get("s");
  const cleared = applyStatements(stage, [parseStatement("scene")], manifest, {});
  assert.deepEqual(cleared.applied, [{ kind: "scene" }]);
  const empty = store.snapshot("s");
  assert.ok(!("scene" in empty), "an empty background must be an absent key");

  applyStatements(stage, [parseStatement("show enid glasses")], manifest, {});
  const shown = store.snapshot("s");
  assert.ok(!("url" in shown.sprites[0]), "a layered sprite has no single file to draw");
  assert.deepEqual(shown.sprites[0].activeLayers.map((layer) => layer.attribute), ["glasses"]);
  // The round trip IS the host's validation: anything JSON drops must be absent.
  assert.deepEqual(JSON.parse(JSON.stringify(cleared)), cleared);
  assert.deepEqual(JSON.parse(JSON.stringify(shown)), shown);
});

test("applyStatements falls back to the group default when a layered attribute is unset", () => {
  const manifest = fakeManifest({
    sprites: [
      {
        name: "enid", tag: "enid", attributes: ["normal", "smile", "glasses"],
        layered: true, base: {},
        groups: [
          { name: "body", attributes: [
            { name: "normal", default: true, url: "/asset?p=body_normal" },
            { name: "outside", default: false, url: "/asset?p=body_outside" },
          ] },
          { name: "face", attributes: [
            { name: "def", default: true, defaultNull: true },
            { name: "smile", default: false, url: "/asset?p=face_smile" },
          ] },
        ],
        layers: {},
      },
    ],
    spriteIndex: { enid: {
      name: "enid", tag: "enid", attributes: ["normal", "smile", "glasses"],
      layered: true, base: {},
      groups: [
        { name: "body", attributes: [
          { name: "normal", default: true, url: "/asset?p=body_normal" },
          { name: "outside", default: false, url: "/asset?p=body_outside" },
        ] },
        { name: "face", attributes: [
          { name: "def", default: true, defaultNull: true },
          { name: "smile", default: false, url: "/asset?p=face_smile" },
        ] },
      ],
      layers: {},
    } },
  });
  const store = new StageStore();
  const stage = store.get("s");
  applyStatements(stage, [parseStatement("show enid smile")], manifest, {});
  assert.deepEqual(
    stage.sprites[0].activeLayers.map((layer) => layer.attribute),
    ["normal", "smile"],
  );
});

// ── audio, playlist and splash ──────────────────────────────────────────────

test("readAudioAliases reads `define -500 audio.x = \"...\"`, priority token and all", () => {
  // The `-500` priority is legal Ren'Py and appears in every real game's audio
  // table. readAssignments' grammar only accepts `gui|config|preferences|store`
  // prefixes, so a table written with `audio.` is invisible to it and needs its
  // own reader — this is the shape that made `config.main_menu_music` resolve to
  // `undefined` before the resolver existed.
  const sources = [
    {
      path: "audio.rpy",
      text: [
        'define -500 audio.gotosnowtown = "audio/music/go to snowtown.mp3"  # loop 1.741',
        'define audio.plain = "audio/music/x.mp3"',
        "define audio.notastring = some_function()",
        "",
      ].join("\n"),
    },
  ];
  const aliases = readAudioAliases(sources);
  assert.equal(aliases.get("gotosnowtown"), "audio/music/go to snowtown.mp3");
  assert.equal(aliases.get("plain"), "audio/music/x.mp3");
  // A non-literal value is not a path, so it must not enter the table at all.
  assert.equal(aliases.has("notastring"), false);
});

test("resolveMenuMusic follows a function-call config through to every branch", () => {
  // The real shape, taken from 出发！去落雪镇's options.rpy: the config is a CALL,
  // and the branch taken depends on a persistent the save file owns. Both paths
  // must come back, with the default branch first — a game that writes
  // `config.main_menu_music = main_menu_music()` otherwise yields `undefined`.
  const sources = [
    {
      path: "audio.rpy",
      text: [
        'define -500 audio.gotosnowtown = "audio/music/go to snowtown.mp3"',
        'define -500 audio.ourfirststep = "audio/music/our first step.mp3"',
        "",
      ].join("\n"),
    },
    { path: "script.rpy", text: 'define persistent.theme = "序章"\n' },
    {
      path: "options.rpy",
      text: [
        "init python:",
        "    def main_menu_music():",
        "        if persistent.theme == '硫石篇':",
        "            return audio.ourfirststep",
        "        else:",
        "            return audio.gotosnowtown",
        "",
        "define config.main_menu_music = main_menu_music()",
        "",
      ].join("\n"),
    },
  ];
  const resolved = resolveMenuMusic(sources);
  assert.deepEqual(
    resolved.tracks.map((track) => track.path),
    ["audio/music/go to snowtown.mp3", "audio/music/our first step.mp3"],
  );
  assert.equal(resolved.tracks[0].preferred, true, "the branch a fresh save takes plays first");
  assert.deepEqual(resolved.unresolved, [], "every branch was followed");
});

test("resolveMenuMusic keeps a plain literal and reports what it cannot follow", () => {
  // Arches writes `config.main_menu_music = "audio/music/mainmenu.ogg"` — one
  // answer, no branch, and it must still be marked preferred.
  const literal = resolveMenuMusic([
    { path: "options.rpy", text: 'define config.main_menu_music = "audio/music/mainmenu.ogg"\n' },
  ]);
  assert.deepEqual(literal.tracks, [{ path: "audio/music/mainmenu.ogg", preferred: true }]);

  // An expression the static reader cannot evaluate must be REPORTED rather
  // than silently producing an empty menu-music list.
  const opaque = resolveMenuMusic([
    { path: "options.rpy", text: "define config.main_menu_music = pick_theme_music(store.theme)\n" },
  ]);
  assert.equal(opaque.tracks.length, 0);
  assert.ok(opaque.unresolved.length > 0, "an unfollowable expression is surfaced, not swallowed");
});

test("readSplashscreen takes only what `label splashscreen:` shows", () => {
  const sources = [
    {
      path: "splash.rpy",
      text: [
        "label splashscreen:",
        "    $ renpy.movie_cutscene('video/open.webm')",
        "    scene black with fade",
        "    show white with dissolve",
        "    play audio ['<silence 0.3>', audio.meow]",
        "    call screen antipiracy_splash",
        "    return",
        "",
        "screen antipiracy_splash():",
        "    add 'images/splash/watermark.png'",
        "    timer 3.0 action Return()",
        "",
      ].join("\n"),
    },
  ];
  const splash = readSplashscreen(sources);
  assert.equal(splash.found, true);
  assert.deepEqual(splash.videos, ["video/open.webm"], "a movie_cutscene is the strongest signal");
  assert.deepEqual(splash.images, ["images/splash/watermark.png"], "the screen's own art is collected");
  assert.deepEqual(splash.screens, ["antipiracy_splash"]);
  // The timer is the splash's own statement of how long it lasts. Read from the
  // screen it calls, not the label, because that is where Ren'Py puts it.
  assert.deepEqual(splash.timers, [3], "the screen's own `timer 3.0` is the splash's length");

  // A text-only splash is still `found`, with no media at all. Documented
  // limitation rather than a gap: 落雪镇's first_splash is a pure notice screen.
  const textual = readSplashscreen([
    { path: "s.rpy", text: ["label splashscreen:", "    call screen notice", "    return", "", "screen notice():", "    text 'hi'", ""].join("\n") },
  ]);
  assert.equal(textual.found, true);
  assert.deepEqual(textual.videos, []);
  assert.deepEqual(textual.images, []);
});

test("a still splash gets a deadline, because an <img> never fires `ended`", () => {
  // The regression: the client showed an image splash until the user clicked,
  // and the Rusty Mouths probe sat on one forever. A still has to expire on its
  // own, so the manifest carries the length the game declared.
  const game = makeGame({
    files: { "images/splash/wide.png": TINY_GIF },
    declarations: "define config.name = _(\"Still\")",
  });
  writeFileSync(
    join(game.root, "game", "splash.rpy"),
    ["label splashscreen:", "    call screen notice", "    return", "", "screen notice():", "    add 'images/splash/wide.png'", "    timer 3.0 action Return()", ""].join("\n"),
  );
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    assert.equal(manifest.splash.kind, "image");
    assert.equal(manifest.splash.path, "images/splash/wide.png");
    assert.equal(manifest.splash.duration, 3, "the game's own `timer` is the deadline");
    assert.deepEqual(manifest.splash.timers, [3]);
  } finally {
    game.dispose();
  }
});

test("a still splash with no declared timer still gets a bounded fallback", () => {
  // Same symptom, the other half: a game that never says how long its splash
  // lasts must not be able to pin the shell. The clamp is the contract, so a
  // missing timer is 4 s and an absurd one is capped rather than trusted.
  const game = makeGame({ files: { "images/splash/wide.png": TINY_GIF } });
  writeFileSync(
    join(game.root, "game", "splash.rpy"),
    ["label splashscreen:", "    call screen notice", "    return", "", "screen notice():", "    add 'images/splash/wide.png'", ""].join("\n"),
  );
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    assert.equal(manifest.splash.kind, "image");
    assert.equal(manifest.splash.duration, 4, "no timer means the documented fallback, not infinity");
  } finally {
    game.dispose();
  }
});

test("buildManifest indexes audio and video, not just images", () => {
  // The regression: indexAssets only knew IMAGE_EXTENSIONS, so no audio file was
  // ever discovered and the playlist and menu music had nothing to point at.
  const game = makeGame({
    files: {
      "audio/music/first track.wav": wavBytes(30),
      "audio/music/second track.wav": wavBytes(45),
      "audio/sound/blip.wav": wavBytes(1),
      "video/open.webm": Buffer.from("not really a video"),
    },
  });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    assert.equal(manifest.stats.audio, 3, "every audio file is indexed");
    assert.equal(manifest.stats.videos, 1, "video is indexed too — it is what a splash usually is");
    // The digest carries no path list, so the directory histogram is the only
    // way an agent learns the art lives under `audio/music` rather than the root.
    // Ties are broken by name, and `makeGame()` already ships its own images.
    assert.deepEqual(manifest.stats.assetDirs[0], { dir: "audio/music", count: 2 });
    assert.ok(
      manifest.stats.assetDirs.some((entry) => entry.dir === "audio/sound"),
      "every indexed directory is represented",
    );
    assert.ok(
      manifest.stats.assetDirs.every((entry, index, list) => index === 0 || list[index - 1].count >= entry.count),
      "largest directory first",
    );
    assert.ok(AUDIO_EXTENSIONS.has(".ogg") && VIDEO_EXTENSIONS.has(".webm"));
  } finally {
    game.dispose();
  }
});

test("buildPlaylist prefers audio/music and drops tracks of 10 seconds or less", () => {
  // The stingers in `audio/sound` are the reason the duration filter exists:
  // without it a playlist would be mostly one-second cues. `audio/music` wins
  // outright, so the sound folder is not even scanned.
  const game = makeGame({
    files: {
      "audio/music/keeper.wav": wavBytes(30),
      "audio/music/stinger.wav": wavBytes(10),
      "audio/music/tiny.wav": wavBytes(0.5),
      "audio/sound/blip.wav": wavBytes(1),
      "audio/theme.wav": wavBytes(40),
    },
  });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    assert.deepEqual(
      manifest.audio.playlist.map((track) => track.path),
      ["audio/music/keeper.wav"],
      "exactly 10s is dropped, 30s is kept, and the sound/ folder is not the source",
    );
    assert.equal(manifest.audio.playlist[0].title, "keeper");
    assert.equal(manifest.audio.playlist[0].directory, "audio/music");
    assert.ok(manifest.audio.playlist[0].url.startsWith("/asset?p="));
    assert.ok(Math.abs(manifest.audio.playlist[0].duration - 30) < 0.2, "a real duration is measured");
  } finally {
    game.dispose();
  }
});

test("buildPlaylist falls back to audio/ and then the whole game when music/ is absent", () => {
  // Not every game uses the conventional folder; an empty playlist would be a
  // worse answer than the game's own audio.
  const flat = makeGame({ files: { "audio/theme.wav": wavBytes(40) } });
  const loose = makeGame({ files: { "custom/bed.wav": wavBytes(50) } });
  try {
    assert.deepEqual(
      buildManifest(flat.root, { assetUrl: (p) => p }).manifest.audio.playlist.map((t) => t.path),
      ["audio/theme.wav"],
      "audio/ is the next prefix down",
    );
    assert.deepEqual(
      buildManifest(loose.root, { assetUrl: (p) => p }).manifest.audio.playlist.map((t) => t.path),
      ["custom/bed.wav"],
      "a game with no audio/ at all still gets a playlist",
    );
  } finally {
    flat.dispose();
    loose.dispose();
  }
});

test("an unknown duration KEEPS the track", () => {
  // The contract that matters most: the duration reader exists to drop
  // stingers, and a file it cannot parse must not be silently dropped with
  // them. `.m4a` is deliberately unreadable by lib/audio.js.
  const game = makeGame({ files: { "audio/music/opaque.m4a": Buffer.from("not an m4a at all") } });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => p });
    assert.deepEqual(
      manifest.audio.playlist.map((track) => track.path),
      ["audio/music/opaque.m4a"],
    );
    assert.equal(manifest.audio.playlist[0].duration, undefined, "no invented duration is published");
  } finally {
    game.dispose();
  }
});

test("buildManifest resolves a splash from the label, and menu music from options.rpy", () => {
  const game = makeGame({
    files: {
      "video/open.webm": Buffer.from("not really a video"),
      "audio/music/mainmenu.wav": wavBytes(60),
    },
  });
  // makeGame writes `declarations` to script.rpy; the splash label is a script
  // statement, so it belongs there.
  try {
    writeFileSync(
      join(game.gameDir, "script.rpy"),
      [
        "label splashscreen:",
        "    $ renpy.movie_cutscene('video/open.webm')",
        "    return",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(game.gameDir, "options.rpy"),
      [
        'define config.name = _("Test VN")',
        'define config.main_menu_music = "audio/music/mainmenu.wav"',
        "",
      ].join("\n"),
      "utf8",
    );

    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    assert.equal(manifest.splash.found, true);
    assert.equal(manifest.splash.kind, "video", "a movie_cutscene outranks any still");
    assert.equal(manifest.splash.path, "video/open.webm");
    assert.equal(manifest.splash.source, "splashscreen");
    assert.ok(manifest.splash.url.startsWith("/asset?p="));

    assert.deepEqual(manifest.audio.menuMusic.map((track) => track.path), ["audio/music/mainmenu.wav"]);
    assert.equal(manifest.audio.menuMusic[0].inPlaylist, true);
  } finally {
    game.dispose();
  }
});

test("menu music matches the playlist case-insensitively when the game miscases its own path", () => {
  // The symptom: Remember the Flowers declares
  // `config.main_menu_music = "audio/music/motion.ogg"` while the file on disk
  // is `Motion.ogg`, so an exact-case lookup reported `inPlaylist: false` for
  // the game's own title theme and the playlist row disagreed with the manifest.
  const game = makeGame({
    files: { "audio/music/Motion.wav": wavBytes(60) },
  });
  try {
    writeFileSync(
      join(game.gameDir, "options.rpy"),
      'define config.main_menu_music = "audio/music/motion.wav"\n',
      "utf8",
    );
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    assert.deepEqual(manifest.audio.menuMusic.map((track) => track.path), ["audio/music/motion.wav"]);
    assert.equal(manifest.audio.menuMusic[0].inPlaylist, true, "the declared spelling still finds the file");
    assert.equal(manifest.audio.menuMusic[0].title, "Motion", "the title comes from the real file");
    assert.ok(
      Math.abs(manifest.audio.menuMusic[0].duration - 60) < 0.2,
      "the measured duration follows the same case-insensitive match",
    );
  } finally {
    game.dispose();
  }
});

test("a game with no splash yields `found: false` rather than an empty selection", () => {
  const game = makeGame({ declarations: "" });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => p });
    assert.deepEqual(manifest.splash, { found: false });
    assert.deepEqual(manifest.audio.playlist, []);
    assert.deepEqual(manifest.audio.menuMusic, []);
  } finally {
    game.dispose();
  }
});

// ── host half: service readiness ────────────────────────────────────────────

/**
 * A Cordis-shaped stand-in that records how `apply` reaches for its services.
 *
 * `inject` is captured rather than invoked so a test can decide *when* the
 * dependency appears — which is the whole point of the regression below.
 */
function fakeHostCtx(services = {}) {
  const injected = [];
  const effects = [];
  const provided = {};
  return {
    ctx: {
      get: (name) => services[name],
      inject: (names, callback) => { injected.push({ names, callback }); },
      effect: (fn, label) => { effects.push({ fn, label }); return () => {}; },
      provide: (name, value) => { provided[name] = value; },
      on: () => () => {},
      logger: () => () => {},
    },
    injected,
    effects,
    provided,
  };
}

/**
 * Run one `ctx.inject` callback and hand back what it registered.
 *
 * The host reaches every optional service through `ctx.inject`, so this is the
 * same wait it performs: nothing exists until the callback runs. The callback
 * receives exactly the named services plus `effect`, and the effects it
 * installs run immediately — the host runs an effect when its fiber starts.
 *
 * @param host the fake context returned by `fakeHostCtx`.
 * @param names the service names of the injection to run.
 * @param services the services to hand that callback.
 */
function runInject(host, names, services) {
  const entry = host.injected.find((candidate) => candidate.names.join(",") === names.join(","));
  assert.ok(entry, `apply must wait on ${names.join(" + ")}`);
  const childEffects = [];
  entry.callback({
    ...services,
    effect: (fn, label) => {
      childEffects.push({ fn, label, dispose: undefined });
      return () => {};
    },
  });
  // The host runs an effect once, when its fiber starts. Record the disposer it
  // returned so a test can unwind the registration instead of running it twice.
  for (const effect of childEffects) effect.dispose = effect.fn();
  return childEffects;
}

/**
 * Run the `webServer` injection callback and hand back the routes it
 * registered. The host reaches the HTTP server through `ctx.inject`, so this
 * is the same wait it performs — routes do not exist until the callback runs.
 */
function routesOf(host) {
  const routes = [];
  runInject(host, ["webServer"], {
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
  });
  return routes;
}

/**
 * Run the `tools` injection callback and hand back the registered tools.
 *
 * Tool registration lives behind `ctx.inject(["tools"])`, so a test that calls
 * `apply` and then looks for `renpy_stage` has to run the callback first —
 * exactly the wait a real host performs.
 */
function toolsOf(host) {
  const registered = [];
  runInject(host, ["tools"], {
    tools: { register: (tool) => { registered.push(tool); return () => {}; } },
  });
  return registered;
}

test("apply waits on every optional service instead of reading it once", () => {
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);

    // A `ctx.get("tools")` at mount time dropped every `renpy_*` tool for the
    // whole process whenever this row applied before the tool registry — the
    // model then had no way to load or direct a game, and nothing logged it.
    assert.deepEqual(
      host.injected.map((entry) => entry.names),
      [["systemPrompt"], ["tools"], ["webServer"]],
      "each optional service is waited for, not read once",
    );
    assert.equal(
      host.effects.filter((entry) => entry.label === "dsh-renpy-skin: http routes").length,
      0,
      "no route effect may run before the service exists",
    );
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("apply registers no HTTP route while webServer is unavailable at mount", () => {
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    // A profile whose web server has not mounted yet: `inject` never fires.
    const host = fakeHostCtx();
    apply(host.ctx);

    assert.equal(
      host.effects.filter((entry) => entry.label === "dsh-renpy-skin: http routes").length,
      0,
      "no route effect may run before the service exists",
    );
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("apply registers every /renpy-skin route once webServer mounts", () => {
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);

    // The regression: DSH used to read `ctx.get("webServer")` once at mount
    // time. Rows mount concurrently, so the web server could still be absent
    // and EVERY route below was silently skipped — the SPA fallback then
    // answered 404, so the settings page rendered but no control reacted and
    // no write ever landed. Routes must come from `ctx.inject`, which waits.
    const routes = [];
    const childEffects = runInject(host, ["webServer"], {
      webServer: {
        register: (route) => { routes.push(route); return () => {}; },
      },
    });
    assert.equal(childEffects.length, 1, "the route table is one effect");
    const dispose = childEffects[0].dispose;

    assert.deepEqual(
      routes.map((route) => route.path),
      [
        "/renpy-skin/manifest",
        "/renpy-skin/media",
        "/renpy-skin/asset",
        "/renpy-skin/stage",
        "/renpy-skin/settings",
        "/renpy-skin/doctor",
        "/renpy-skin/memory",
        "/renpy-skin/dialogbox",
        "/renpy-skin/library",
        "/renpy-skin/layout",
        "/renpy-skin/export",
        "/renpy-skin/import",
        "/renpy-skin/agent/prepare",
        "/renpy-skin/vn",
      ],
    );
    assert.ok(
      routes.every((route) => route.kind === "exact" && typeof route.handler === "function"),
      "every route is an exact Node-style handler",
    );
    assert.equal(typeof dispose, "function", "the route table unwinds on unload");

    // The settings write path the inert page depended on: a GET must be
    // answered rather than rejected, since the client reads settings back.
    const settingsRoute = routes.find((route) => route.path === "/renpy-skin/settings");
    let responded = false;
    settingsRoute.handler(
      { method: "GET", url: "/renpy-skin/settings" },
      {
        setHeader: () => {},
        writeHead: () => {},
        end: () => { responded = true; },
      },
    );
    assert.equal(responded, true, "GET /settings must answer the client");
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("GET /renpy-skin/asset answers a Range request with 206 and content-range", async () => {
  // `<video>` and `<audio>` issue a Range request the moment the user seeks and
  // refuse to play media that answers 200 with the whole file: the element
  // reports the media as unseekable. The route therefore has to slice, and a
  // syntactically valid-but-unsatisfiable range has to be a 416 rather than a
  // silently wrong 200.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame({ files: { "audio/music/track.wav": wavBytes(1) } });
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const assetRoute = routes.find((route) => route.path === "/renpy-skin/asset");
    const fetchAsset = (headers) =>
      new Promise((resolve) => {
        const sent = { headers: {} };
        assetRoute.handler(
          { method: "GET", url: "/renpy-skin/asset?p=audio%2Fmusic%2Ftrack.wav", headers },
          {
            setHeader: (name, value) => { sent.headers[name] = value; },
            end: (body) => resolve({ ...sent, body, status: sent.statusCode }),
            set statusCode(value) { sent.statusCode = value; },
            get statusCode() { return sent.statusCode; },
          },
        );
      });

    const whole = await fetchAsset({});
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["accept-ranges"], "bytes");
    assert.equal(whole.headers["content-type"], "audio/wav");
    assert.equal(whole.headers["content-length"], whole.body.length);

    const partial = await fetchAsset({ range: "bytes=0-43" });
    assert.equal(partial.status, 206, "a seek must not get the whole file");
    assert.equal(partial.body.length, 44);
    assert.equal(partial.headers["content-range"], `bytes 0-43/${whole.body.length}`);

    const suffix = await fetchAsset({ range: "bytes=-10" });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.body.length, 10, "`bytes=-n` is the LAST n bytes");
    assert.equal(suffix.headers["content-range"], `bytes ${whole.body.length - 10}-${whole.body.length - 1}/${whole.body.length}`);

    const unsatisfiable = await fetchAsset({ range: "bytes=999999-" });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers["content-range"], `bytes */${whole.body.length}`);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("switching games changes every asset URL, so the browser cache cannot serve the old game", async () => {
  // The regression: every game's `gui/main_menu.png` resolved to the SAME
  // `/renpy-skin/asset?p=gui%2Fmain_menu.png`, and that route answers
  // `cache-control: private, max-age=3600`. After a switch the browser replayed
  // the first game's bytes out of its own cache, so the background stayed on the
  // previous VN's image however correct the new manifest was. The per-build
  // token in the URL is the whole fix; if it ever leaves the URL, nothing else
  // notices — which is why this asserts on the URL rather than on `assetToken`.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const betaOptions = [
    'define config.name = _("Beta VN")',
    'define config.version = "1.0"',
    "define config.screen_width = 1920",
    "define config.screen_height = 1080",
    "",
  ].join("\n");
  const alpha = makeGame({ files: { "gui/main_menu.png": TINY_GIF } });
  const beta = makeGame({
    files: { "gui/main_menu.png": TINY_GIF, "options.rpy": betaOptions },
  });
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: alpha.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const manifestRoute = routes.find((route) => route.path === "/renpy-skin/manifest");
    const getManifest = (url) =>
      new Promise((resolve) => {
        let status = 200;
        manifestRoute.handler(
          { method: "GET", url },
          {
            setHeader: () => {},
            writeHead: () => {},
            end: (body) => resolve({ status, body: JSON.parse(body) }),
            set statusCode(value) { status = value; },
            get statusCode() { return status; },
          },
        );
      });

    const first = await getManifest("/renpy-skin/manifest");
    const second = await getManifest(
      `/renpy-skin/manifest?gameDir=${encodeURIComponent(beta.root)}`,
    );
    assert.equal(first.body.ok, true, first.body.error);
    assert.equal(second.body.ok, true, second.body.error);

    // Prove these really are two different games, not one read twice — both
    // fixtures ship the same file layout on purpose.
    assert.equal(first.body.manifest.game.name, "Test VN");
    assert.equal(second.body.manifest.game.name, "Beta VN");

    const alphaBackground = first.body.manifest.backgrounds[0];
    const betaBackground = second.body.manifest.backgrounds[0];
    assert.ok(alphaBackground?.url, "the first game exposes a background");
    assert.ok(betaBackground?.url, "the second game exposes a background");

    const relativePath = (url) => new URL(url, "http://localhost").searchParams.get("p");
    assert.equal(
      relativePath(alphaBackground.url),
      relativePath(betaBackground.url),
      "the collision only exists because both games resolve the SAME relative path",
    );
    assert.notEqual(
      alphaBackground.url,
      betaBackground.url,
      "the same relative path in two games must not share a cache key",
    );
    assert.match(alphaBackground.url, /[?&]v=[^&]+&p=/);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    alpha.dispose();
    beta.dispose();
  }
});

test("GET /renpy-skin/media feeds the opening picker, and a reload re-reads it", async () => {
  // Why this route exists instead of reusing `manifest.backgrounds`: a splash
  // VIDEO is not a displayable, so it never reaches that index — and the picker
  // exists to choose exactly such a file. The second half pins the cache: a
  // video dropped into the game must show up after 「重读这个游戏」 rather than
  // being answered from the list built before the file existed.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame({ files: { "video/echosplash.webm": Buffer.from("not really a webm") } });
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });

    const json = (routePath, request) =>
      new Promise((resolve) => {
        let status = 200;
        routes.find((route) => route.path === routePath).handler(request, {
          setHeader: () => {},
          writeHead: () => {},
          end: (payload) => resolve({ status, body: JSON.parse(String(payload)) }),
          set statusCode(value) { status = value; },
          get statusCode() { return status; },
        });
      });
    const getMedia = () =>
      json("/renpy-skin/media", { method: "GET", url: "/renpy-skin/media?session=global" });
    const postLibrary = (payload) => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      return json("/renpy-skin/library", {
        method: "POST",
        url: "/renpy-skin/library",
        on: (event, callback) => {
          if (event === "data") callback(body);
          if (event === "end") callback();
        },
      });
    };

    const manifest = await json("/renpy-skin/manifest", {
      method: "GET",
      url: "/renpy-skin/manifest?session=global",
    });
    const first = await getMedia();
    assert.equal(first.body.ok, true, first.body.error);
    assert.ok(
      first.body.videos.includes("video/echosplash.webm"),
      `the picker must offer the splash video: ${JSON.stringify(first.body.videos)}`,
    );
    assert.ok(
      first.body.images.includes("images/backgrounds/forest day.gif"),
      "the picker also offers the game's images",
    );
    assert.equal(
      manifest.body.manifest.backgrounds.some((entry) => entry.path === "video/echosplash.webm"),
      false,
      "a splash video is not a displayable — which is why /media is a separate route",
    );

    writeFileSync(join(game.gameDir, "video", "new-splash.webm"), Buffer.from("fresh"));
    const reloaded = await postLibrary({ gameDir: "" });
    assert.equal(reloaded.body.ok, true, reloaded.body.error);
    const second = await getMedia();
    assert.ok(
      second.body.videos.includes("video/new-splash.webm"),
      `a reload must drop the cached media list: ${JSON.stringify(second.body.videos)}`,
    );

    // The server-side filter exists because the full list is unusable on a real
    // game (CSE returns 748 image paths). Both counts come back: `matched` alone
    // cannot tell "3 matches" from "the game only has 3 files", and reading it
    // the wrong way ends in "nothing lives under images/".
    const filtered = await json("/renpy-skin/media", {
      method: "GET",
      url: "/renpy-skin/media?session=global&under=video&match=splash",
    });
    assert.equal(filtered.body.ok, true, filtered.body.error);
    assert.deepEqual(
      filtered.body.videos,
      ["video/echosplash.webm", "video/new-splash.webm"],
      "`under` is a directory prefix and `match` a case-insensitive substring",
    );
    assert.equal(filtered.body.images.length, 0, "a directory prefix excludes every other directory");
    assert.deepEqual(filtered.body.filter, {
      under: "video",
      match: "splash",
      matched: 2,
      total: second.body.videos.length + second.body.images.length,
    });
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

// ── the character roster (Settings → Characters) ────────────────────────────

test("directorBrief offers the whole cast when no character is ticked", () => {
  // An empty selection is the fresh-install state and MUST NOT read as "no
  // character is allowed": that would ship a stage the model cannot use.
  const brief = directorBrief(fakeManifest(), { settings: { enabledCharacters: [], maxStageSprites: 3 } });
  assert.match(brief, /### Available characters/);
  assert.match(brief, /- eileen:/);
  assert.match(brief, /- bob:/);

  // Absent/undefined/non-array all behave like the empty list.
  for (const value of [undefined, null, "eileen"]) {
    const loose = directorBrief(fakeManifest(), { settings: { enabledCharacters: value } });
    assert.match(loose, /- eileen:/, `enabledCharacters=${JSON.stringify(value)} keeps the whole cast`);
    assert.match(loose, /- bob:/);
  }
});

test("directorBrief narrows the roster to the ticked characters", () => {
  const brief = directorBrief(fakeManifest(), {
    settings: { enabledCharacters: ["eileen"], maxStageSprites: 3 },
  });
  assert.match(brief, /- eileen:/);
  assert.ok(!brief.includes("- bob:"), "an unticked character is absent from the roster");
});

test("a non-empty enabledCharacters list is a hard roster for `show`", () => {
  const store = new StageStore();
  const manifest = fakeManifest();
  const stage = store.get("s1");
  const options = { enabledCharacters: ["eileen"] };

  applyStatements(stage, [parseStatement("show eileen happy at center")], manifest, options);
  assert.equal(stage.sprites.length, 1, "a ticked character shows normally");

  // The spec's own wording for this rejection.
  try {
    applyStatements(stage, [parseStatement("show bob happy at left")], manifest, options);
    assert.fail("expected a StageError");
  } catch (error) {
    assert.ok(error instanceof StageError);
    assert.match(error.message, /not enabled/);
    assert.match(error.message, /未启用，请到设置勾选/);
    assert.deepEqual(error.details.enabledCharacters, ["eileen"]);
  }

  // An unspecified list stays permissive, so the setting is opt-in.
  applyStatements(stage, [parseStatement("show bob happy at left")], manifest, {});
  assert.equal(stage.sprites.length, 2);
});

test("writeSettings keeps enabledCharacters a de-duplicated tag list", async () => {
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    // The routes are registered *inside* the effect, so it has to run — which
    // is what `runInject` does for every injection it drives.
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const settingsRoute = routes.find((route) => route.path === "/renpy-skin/settings");

    const post = (patch) =>
      new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(patch), "utf8");
        settingsRoute.handler(
          {
            method: "POST",
            url: "/renpy-skin/settings",
            on: (event, callback) => {
              if (event === "data") callback(body);
              if (event === "end") callback();
            },
          },
          {
            setHeader: () => {},
            writeHead: () => {},
            end: (payload) => resolve(JSON.parse(String(payload))),
          },
        );
      });

    const saved = await post({ enabledCharacters: ["eileen", "eileen", 7, "", "bob"] });
    assert.deepEqual(saved.settings.enabledCharacters, ["eileen", "bob"]);
    // Reading back must not resurrect the raw list.
    assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).enabledCharacters, ["eileen", "bob"]);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeSettings accepts the composer backdrop modes and drops anything else", async () => {
  // The value drives a CSS rule on the shell's own `.Dc7zOa_composerSeat`, so an
  // unknown string would be interpolated straight into the stylesheet. Clamping
  // to the three known modes is what keeps it a value and not an injection.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const settingsRoute = routes.find((route) => route.path === "/renpy-skin/settings");
    const post = (patch) =>
      new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(patch), "utf8");
        settingsRoute.handler(
          {
            method: "POST",
            url: "/renpy-skin/settings",
            on: (event, callback) => {
              if (event === "data") callback(body);
              if (event === "end") callback();
            },
          },
          { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
        );
      });

    assert.equal((await post({ composerBackdrop: "transparent" })).settings.composerBackdrop, "transparent");
    assert.equal((await post({ composerBackdrop: "solid" })).settings.composerBackdrop, "solid");
    assert.equal((await post({ composerBackdrop: "default" })).settings.composerBackdrop, "default");
    // A rejected value must leave the previous one alone rather than storing it.
    assert.equal((await post({ composerBackdrop: "transparent; }" })).settings.composerBackdrop, "default");
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("splashOnSwitch is its own persisted toggle, independent of splashOnStart", async () => {
  // The two were conflated in the client: `resetForNewGame` cleared the startup
  // latch, so switching a game replayed the startup splash even with that toggle
  // off. They are separate settings, so each must round-trip on its own.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const settingsRoute = routes.find((route) => route.path === "/renpy-skin/settings");
    const post = (patch) =>
      new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(patch), "utf8");
        settingsRoute.handler(
          {
            method: "POST",
            url: "/renpy-skin/settings",
            on: (event, callback) => {
              if (event === "data") callback(body);
              if (event === "end") callback();
            },
          },
          { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
        );
      });

    // Defaults: the startup splash is off and a switch must not conjure one.
    const initial = await post({});
    assert.equal(initial.settings.splashOnStart, false);
    assert.equal(initial.settings.splashOnSwitch, false);

    const on = await post({ splashOnSwitch: true });
    assert.equal(on.settings.splashOnSwitch, true);
    assert.equal(on.settings.splashOnStart, false, "turning on the switch toggle must not turn on startup");
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeSettings keeps the three tool paths apart and trims them", async () => {
  // These are the only settings whose value is handed to `spawn`. A newline
  // pasted from Explorer must not survive into a path that never resolves, and
  // one shared "tool path" key would let a pasted unrpyc path overwrite the
  // interpreter.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const settingsRoute = routes.find((route) => route.path === "/renpy-skin/settings");
    const post = (patch) =>
      new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(patch), "utf8");
        settingsRoute.handler(
          {
            method: "POST",
            url: "/renpy-skin/settings",
            on: (event, callback) => {
              if (event === "data") callback(body);
              if (event === "end") callback();
            },
          },
          { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
        );
      });

    const saved = await post({
      pythonPath: "  C:\\Python312\\python.exe\r\n",
      unrpycPath: "C:\\Tools\\unrpyc\\unrpyc.py",
      toolsDir: " C:\\Tools ",
    });
    assert.equal(saved.settings.pythonPath, "C:\\Python312\\python.exe");
    assert.equal(saved.settings.unrpycPath, "C:\\Tools\\unrpyc\\unrpyc.py");
    assert.equal(saved.settings.toolsDir, "C:\\Tools");
    assert.equal(
      JSON.parse(readFileSync(join(home, "config.json"), "utf8")).pythonPath,
      "C:\\Python312\\python.exe",
      "the trimmed value is what reaches the file, not only the reply",
    );

    // A drag-and-dropped blob is not a path; the cap keeps it out of the file
    // without clearing the other two.
    const blob = await post({ unrpycPath: `C:\\${"x".repeat(900)}` });
    assert.equal(blob.settings.unrpycPath.length, 400);
    assert.equal(blob.settings.pythonPath, "C:\\Python312\\python.exe", "capping one path must not clear the rest");
    assert.equal(blob.settings.toolsDir, "C:\\Tools");
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("GET /renpy-skin/doctor lists every requirement, its state and its download", async () => {
  // The environment card is driven entirely by this payload: the browser cannot
  // stat a path, and re-deriving the lookup order there would drift from what
  // `lib/rpyc.js` actually probes. Missing and broken are separate states on
  // purpose — telling someone to download a tool they already pointed at sends
  // them to the wrong fix.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const doctor = routes.find((route) => route.path === "/renpy-skin/doctor");
    assert.ok(doctor, "the environment card needs a route to read");
    const get = (suffix = "") =>
      new Promise((resolve) => {
        doctor.handler(
          { method: "GET", url: `/renpy-skin/doctor${suffix}` },
          { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
        );
      });

    const report = await get();
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.requirements.map((row) => row.id),
      ["node", "python", "unrpyc", "dataHome"],
      "the card renders these rows in this order",
    );
    const rows = Object.fromEntries(report.requirements.map((row) => [row.id, row]));
    assert.equal(rows.node.status, "ok", "the Node the plugin runs on is never missing");
    assert.equal(rows.node.required, true);
    assert.match(rows.python.download, /^https:\/\/www\.python\.org\/downloads\//);
    assert.match(rows.unrpyc.download, /^https:\/\/github\.com\/CensoredUsername\/unrpyc$/);
    // The v2.0.4 release assets contain no unrpyc.py, so the archive link is
    // the one a user can actually act on.
    assert.match(rows.unrpyc.archive, /^https:\/\/codeload\.github\.com\/CensoredUsername\/unrpyc\/zip\//);
    assert.ok(
      rows.dataHome.detail.toLowerCase().includes(home.toLowerCase()),
      `the report names the folder the host really reads: ${rows.dataHome.detail}`,
    );
    assert.equal(typeof rows.dataHome.legacyPresent, "boolean");
    assert.ok(
      typeof report.pluginRoot === "string" && existsSync(join(report.pluginRoot, "lib", "rpyc.js")),
      "the card names the installed plugin folder, which is where a vendored unrpyc.py goes",
    );

    // Point the interpreter at a path that cannot run, exactly as the settings
    // page would: the next diagnosis must call it broken, not missing.
    const missing = join(tmpdir(), "dsh-renpy-skin-no-such-interpreter.exe");
    const settingsRoute = routes.find((route) => route.path === "/renpy-skin/settings");
    await new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify({ pythonPath: missing }), "utf8");
      settingsRoute.handler(
        {
          method: "POST",
          url: "/renpy-skin/settings",
          on: (event, callback) => {
            if (event === "data") callback(body);
            if (event === "end") callback();
          },
        },
        { setHeader: () => {}, writeHead: () => {}, end: () => resolve() },
      );
    });

    const refreshed = await get("?refresh=1");
    const after = Object.fromEntries(refreshed.requirements.map((row) => [row.id, row]));
    assert.equal(refreshed.configured.python, missing, "the saved path is what the host probes");
    assert.equal(after.python.status, "broken");
    assert.equal(after.python.chosen, missing);
    assert.equal(refreshed.python.path, null, "a path that does not run is not a found interpreter");
    assert.equal(after.python.checked[0], missing, "the path from the page is tried before anything else");
    assert.match(after.python.detail, /settings page/i);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── the analysed-VN library ─────────────────────────────────────────────────

test("hideSidebar and hideComposer persist as plain booleans", async () => {
  // They are presentation switches the client applies as CSS, but they still
  // have to survive a reload; `writeSettings` only keeps keys it knows, so a
  // missing DEFAULT_SETTINGS entry would silently drop the switch.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const settingsRoute = routes.find((route) => route.path === "/renpy-skin/settings");
    const post = (patch) =>
      new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(patch), "utf8");
        settingsRoute.handler(
          {
            method: "POST",
            url: "/renpy-skin/settings",
            on: (event, callback) => {
              if (event === "data") callback(body);
              if (event === "end") callback();
            },
          },
          { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
        );
      });

    const saved = await post({ hideSidebar: true, hideComposer: 1 });
    assert.equal(saved.settings.hideSidebar, true);
    assert.equal(saved.settings.hideComposer, false, "only literal true counts");
    const stored = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(stored.hideSidebar, true);
    assert.equal(stored.hideComposer, false);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeSettings keeps only real colours in paletteOverrides", async () => {
  // The client feeds each value straight into a colour input and the token
  // derivation, so a slot that is not a colour must not reach the file — and a
  // cleared slot must actually clear, or a picker could never go back to the
  // game's own colour.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const settingsRoute = routes.find((route) => route.path === "/renpy-skin/settings");
    const post = (patch) =>
      new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(patch), "utf8");
        settingsRoute.handler(
          {
            method: "POST",
            url: "/renpy-skin/settings",
            on: (event, callback) => {
              if (event === "data") callback(body);
              if (event === "end") callback();
            },
          },
          { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
        );
      });

    const saved = await post({
      paletteOverrides: {
        accent: "#ABC",
        hover: "#11223344",
        idle: "red",
        text: "",
        uiText: "#0F0",
        name: 7,
        Unknown: "#fff",
      },
    });
    assert.deepEqual(
      saved.settings.paletteOverrides,
      { accent: "#abc", uiText: "#0f0" },
      "only #rgb/#rrggbb slots survive, and they are lowercased",
    );

    const cleared = await post({ paletteOverrides: {} });
    assert.deepEqual(cleared.settings.paletteOverrides, {});
    assert.deepEqual(
      JSON.parse(readFileSync(join(home, "config.json"), "utf8")).paletteOverrides,
      {},
      "the file carries the cleared object, not the previous palette",
    );
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("POST /renpy-skin/library switches the game, persists it and drops the old session pin", async () => {
  // The bug: switching VNs used to be a settings write plus a manifest refetch,
  // which left the previous game's stage, safe areas and manifests alive. The
  // switch is now one host call that clears them, so this pins the observable
  // contract: one round-trip answers with the NEW manifest and the index.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const first = makeGame({ files: { "options.rpy": 'define config.name = _("First VN")\n' } });
  const second = makeGame({ files: { "options.rpy": 'define config.name = _("Second VN")\n' } });
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: first.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const libraryRoute = routes.find((route) => route.path === "/renpy-skin/library");

    const post = (payload) =>
      new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(payload), "utf8");
        libraryRoute.handler(
          {
            method: "POST",
            url: "/renpy-skin/library",
            on: (event, callback) => {
              if (event === "data") callback(body);
              if (event === "end") callback();
            },
          },
          { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
        );
      });
    const get = () =>
      new Promise((resolve) => {
        libraryRoute.handler(
          { method: "GET", url: "/renpy-skin/library" },
          { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
        );
      });

    // Analysing the first game through the manifest route is what seeds the
    // index; the switch below is then a real move between two known games.
    const manifestRoute = routes.find((route) => route.path === "/renpy-skin/manifest");
    await new Promise((resolve) => {
      manifestRoute.handler(
        { method: "GET", url: "/renpy-skin/manifest?session=global" },
        { setHeader: () => {}, writeHead: () => {}, end: () => resolve() },
      );
    });

    const switched = await post({ gameDir: second.root });
    assert.equal(switched.ok, true);
    assert.equal(switched.manifest.game.name, "Second VN", "the answer already carries the new game");
    assert.equal(
      JSON.parse(readFileSync(join(home, "config.json"), "utf8")).gameDir,
      second.root,
      "the switch persists so a restart comes back to the same VN",
    );

    const listed = await get();
    assert.equal(listed.gameDir, second.root);
    assert.ok(
      listed.library.some((entry) => entry.gameDir === second.root) &&
        listed.library.some((entry) => entry.gameDir === first.root),
      "both analysed games are remembered, not just the active one",
    );
    // Newest first: the game that was just switched to leads the dropdown.
    assert.equal(listed.library[0].gameDir, second.root);
    assert.equal(listed.library[0].name, "Second VN");
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    first.dispose();
    second.dispose();
  }
});

test("renpy_save_vn writes the profile into the data home and reports what it overrode", async () => {
  // The end of the agent's investigation: it hands over a tree, the values the
  // scan could not read, and its own summary. The host writes because an
  // agent's file tools are sandboxed to its workspace, and the profile has to
  // land under the plugin's data home instead.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame();
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const registered = toolsOf(host);

    const save = registered.find((tool) => tool.name === "renpy_save_vn");
    assert.ok(save, "renpy_save_vn registers when a tools service is present");
    assert.equal(typeof save.execute, "function");

    const result = await save.execute(
      { tree: "# game/\n", config: { dialogbox: { textColor: "#ff0000" } }, summary: "notes" },
      { agent: { id: "session-1" } },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.files, ["tree.md", "summary.md", "vn.json"]);

    const dir = join(home, "game", "Test VN");
    assert.equal(result.dir, dir, "the profile lands under the data home, named after the VN");
    assert.ok(existsSync(join(dir, "tree.md")));
    assert.ok(existsSync(join(dir, "summary.md")));

    const profile = JSON.parse(readFileSync(join(dir, "vn.json"), "utf8"));
    assert.equal(profile.name, "Test VN", "the name comes from the scan when none is passed");
    // The RESOLVED directory, not the configured spelling: the same game can be
    // configured as its Ren'Py root or as its `game/` folder, and the profile
    // has to identify one game either way.
    assert.equal(profile.gameDir, game.gameDir);
    assert.deepEqual(profile.dialogbox, { textColor: "#ff0000" });
    assert.ok(typeof profile.savedAt === "string" && profile.savedAt.length > 0);

    // The override is applied over a fresh scan, and only the field it changed
    // is reported — the scan's other dialogbox values survive.
    assert.deepEqual(result.applied, ["dialogbox.textColor"]);

    // And it is really read back the next time the manifest is built, which is
    // the whole point of writing it: the plugin loads its own profile.
    const manifestRoute = routesOf(host).find((route) => route.path === "/renpy-skin/manifest");
    const body = await new Promise((resolve) => {
      manifestRoute.handler(
        { method: "GET", url: "/renpy-skin/manifest?session=global" },
        { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
      );
    });
    assert.equal(body.manifest.dialogbox.textColor, "#ff0000");
    assert.deepEqual(body.manifest.profileApplied, ["dialogbox.textColor"]);
    // Provenance must follow the merge: this value no longer comes from the
    // scan, and saying it does would send the next reader looking in gui.rpy
    // for a colour that only exists in vn.json.
    assert.equal(
      body.manifest.sources["dialogbox.textColor"],
      "profile",
      "the overlaid field is sourced to the profile, not to the scan",
    );
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("a profile naming an asset gets a served URL and the geometry of that file", async () => {
  // The scan mints URLs and measures images; the overlay only copies strings.
  // A profile naming `images/ui/box.gif` therefore used to reach the browser as
  // a bare path, which `url(...)` resolves against the page — the box simply
  // vanished — and a profile naming a font kept the PREVIOUS `fontUrl`, so the
  // interface went on drawing the old face while the file said otherwise.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame({
    files: {
      "images/ui/box.gif": TINY_GIF,
      "font/Other.ttf": Buffer.from("not really a font"),
    },
  });
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const save = toolsOf(host).find((tool) => tool.name === "renpy_save_vn");

    const result = await save.execute(
      {
        config: {
          dialogbox: { textboxImage: "images/ui/box.gif", font: "font/Other.ttf" },
        },
      },
      { agent: { id: "session-1" } },
    );
    assert.equal(result.unresolved, undefined, "both paths are readable, so nothing is reported missing");
    assert.deepEqual(result.applied, ["dialogbox.textboxImage", "dialogbox.font"]);

    const manifestRoute = routesOf(host).find((route) => route.path === "/renpy-skin/manifest");
    const body = await new Promise((resolve) => {
      manifestRoute.handler(
        { method: "GET", url: "/renpy-skin/manifest?session=global" },
        { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
      );
    });
    const dialogbox = body.manifest.dialogbox;
    assert.match(dialogbox.textboxImage, /^\/renpy-skin\/asset\?v=.+&p=images%2Fui%2Fbox\.gif$/);
    assert.deepEqual(dialogbox.textboxImageBounds, { width: 1, height: 1 });
    assert.equal(dialogbox.fontPath, "font/Other.ttf");
    assert.match(dialogbox.fontUrl, /^\/renpy-skin\/asset\?v=.+&p=font%2FOther\.ttf$/);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("a profile's module list gets served URLs, and a missing image is named by node", async () => {
  // The module list stores game-relative paths (that is what the digest and the
  // profile hold), while the browser half paints `imageUrl`. Without the
  // derivation the layer handed a bare path to `url(...)` and drew nothing, and
  // without a node-indexed report the agent was told "dialogbox.modules" was
  // unresolved and could not tell which of forty rows was broken.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame({ files: { "images/ui/ornament.gif": TINY_GIF } });
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const save = toolsOf(host).find((tool) => tool.name === "renpy_save_vn");

    const result = await save.execute(
      {
        config: {
          dialogbox: {
            modules: [
              { kind: "image", rect: { x: 0, y: 0, w: 100, h: 40 }, image: "images/ui/ornament.gif" },
              {
                kind: "image",
                rect: { x: 120, y: 0, w: 100, h: 40 },
                image: "images/ui/missing.gif",
                hover: { image: "images/ui/also-missing.gif" },
              },
            ],
          },
        },
      },
      { agent: { id: "session-1" } },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.applied, ["dialogbox.modules"]);
    assert.deepEqual(result.unresolved, [
      "dialogbox.modules[1].image",
      "dialogbox.modules[1].hover.image",
    ]);

    const manifestRoute = routesOf(host).find((route) => route.path === "/renpy-skin/manifest");
    const body = await new Promise((resolve) => {
      manifestRoute.handler(
        { method: "GET", url: "/renpy-skin/manifest?session=global" },
        { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
      );
    });
    const modules = body.manifest.dialogbox.modules;
    assert.equal(modules[0].image, "images/ui/ornament.gif", "the profile's path stays the stored form");
    assert.match(modules[0].imageUrl, /^\/renpy-skin\/asset\?v=.+&p=images%2Fui%2Fornament\.gif$/);
    assert.match(
      modules[1].imageUrl,
      /^\/renpy-skin\/asset\?v=.+&p=images%2Fui%2Fmissing\.gif$/,
      "a path still gets its token; the unresolved report is what says the file is missing",
    );
    assert.equal(body.manifest.sources["dialogbox.modules"], "profile", "the list came from the profile, not the scan");
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("the scan lists every dialogue plate it can find, chosen one first", async () => {
  // A remake ships a second say plate under `newgui/say/`, a spare box sits in
  // `images/ui/`, and a phone build carries a third under `gui/phone/`. The scan
  // used to resolve exactly one and forget the rest, so neither the settings
  // page nor the agent could offer the others — and the phone variant is a
  // different aspect ratio, so it must not be offered at all.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame({
    files: {
      "gui/textbox.png": TINY_PNG,
      "newgui/say/textbox.png": TINY_PNG,
      "images/ui/message_box.png": TINY_PNG,
      "gui/phone/textbox.png": TINY_PNG,
    },
  });
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const route = routesOf(host).find((entry) => entry.path === "/renpy-skin/manifest");
    const body = await callRoute(route, { method: "GET", url: "/renpy-skin/manifest?session=global" });
    const dialogbox = body.manifest.dialogbox;

    const paths = dialogbox.candidates.map((entry) => entry.path);
    assert.equal(paths[0], "gui/textbox.png", "the plate the manifest already uses leads the list");
    assert.ok(paths.includes("newgui/say/textbox.png"), "a swept plate is offered");
    assert.ok(paths.includes("images/ui/message_box.png"), "a swept plate in images/ is offered");
    assert.ok(!paths.includes("gui/phone/textbox.png"), "a phone variant is not a candidate");
    assert.equal(dialogbox.textboxPath, dialogbox.candidates[0].path, "the path field names the chosen plate");
    assert.equal(dialogbox.textboxSource, "conventional-path", "with no gui variable or style, the conventional file wins");
    for (const entry of dialogbox.candidates) {
      assert.equal(typeof entry.source, "string", "every candidate says where it came from");
      assert.match(entry.url, /^\/renpy-skin\/asset\?v=/, "every candidate has a served URL");
      assert.deepEqual(entry.bounds, { width: 1, height: 1 }, "and the geometry of the real file");
    }
    assert.deepEqual(
      dialogbox.candidates.map((entry) => entry.source),
      ["conventional-path", "sweep", "sweep"],
      "the winner's own provenance is kept, and sweep only supplies the rest",
    );
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("POST /dialogbox switches the plate and rebuilds the manifest around it", async () => {
  // The settings page picks a plate from the scan's candidates. The choice is
  // per game — it belongs in that game's profile, not in the global settings —
  // and it has to survive the rebuild, or the next manifest fetch would put the
  // old box back on screen.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame({
    files: { "gui/textbox.png": TINY_PNG, "images/ui/message_box.png": TINY_PNG },
  });
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const route = routesOf(host).find((entry) => entry.path === "/renpy-skin/dialogbox");

    // A path the game does not ship must be refused: accepting it would write a
    // 404 into the profile, and the composer would paint a broken image.
    const refused = await callRoute(route, { method: "POST", body: { session: "global", path: "images/nope.png" } });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not a dialogue plate/);
    assert.ok(refused.candidates.includes("gui/textbox.png"), "the refusal names the plates that would work");

    const reply = await callRoute(route, {
      method: "POST",
      body: { session: "global", path: "images/ui/message_box.png" },
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.path, "images/ui/message_box.png");
    assert.deepEqual(reply.applied, ["dialogbox.textboxImage"], "the reply reports the profile field it wrote");
    assert.equal(reply.manifest.dialogbox.textboxPath, "images/ui/message_box.png");
    assert.equal(reply.manifest.dialogbox.candidates[0].path, "images/ui/message_box.png");
    assert.match(reply.manifest.dialogbox.textboxImage, /p=images%2Fui%2Fmessage_box\.png$/);

    const profileDir = join(home, "game", readdirSync(join(home, "game"))[0]);
    const profile = JSON.parse(readFileSync(join(profileDir, "vn.json"), "utf8"));
    assert.equal(profile.dialogbox.textboxImage, "images/ui/message_box.png");
    assert.equal(profile.gameDir, game.gameDir, "the profile stays bound to the game it was written for");

    // A later fetch reads the same choice back out of the profile.
    const manifestRoute = routesOf(host).find((entry) => entry.path === "/renpy-skin/manifest");
    const body = await callRoute(manifestRoute, { method: "GET", url: "/renpy-skin/manifest?session=global" });
    assert.equal(body.manifest.dialogbox.textboxPath, "images/ui/message_box.png");
    assert.equal(body.manifest.sources["dialogbox.textboxImage"], "profile");
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("renpy_save_vn refuses rather than writing a profile for no game", async () => {
  // A profile written for the wrong game is worse than none: it would re-skin
  // the interface from another VN's values. With nothing loaded there is
  // nothing to name the folder after, so it must decline.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const registered = toolsOf(host);
    const save = registered.find((tool) => tool.name === "renpy_save_vn");

    const result = await save.execute({ tree: "# game/\n" }, { agent: { id: "session-1" } });
    assert.equal(result.ok, false);
    assert.match(result.error, /no game is loaded/);
    assert.equal(existsSync(join(home, "game")), false, "nothing is written without a game");
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("GET /renpy-skin/vn reports the profile directory and what it overrode", async () => {
  // The browser asks for this before opening the agent session, because the
  // session's workspace IS that directory. It is read-only: the writing half
  // is the tool, for the same sandbox reason as above.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame();
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const route = routesOf(host).find((entry) => entry.path === "/renpy-skin/vn");

    const read = () =>
      new Promise((resolve) => {
        route.handler(
          { method: "GET", url: "/renpy-skin/vn?session=global" },
          { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
        );
      });

    // Before anything is written there is no profile, but the directory it
    // WOULD go in is still reported, which is what the session needs.
    const empty = await read();
    assert.equal(empty.ok, true);
    assert.equal(empty.profile, null);
    assert.equal(empty.dir, join(home, "game", "Test VN"));
    assert.deepEqual(empty.applied, []);
    assert.equal(empty.rejected, null, "nothing to reject when nothing is on disk");

    // Written by hand — the route must read whatever is on disk, not only
    // what the tool produced.
    const dir = join(home, "game", "Test VN");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "vn.json"),
      JSON.stringify({ name: "Test VN", dialogbox: { textColor: "#00ff00" } }),
      "utf8",
    );
    const filled = await read();
    assert.deepEqual(filled.profile.dialogbox, { textColor: "#00ff00" });
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("a profile written for another game with the same name is not applied to this one", async () => {
  // The folder is keyed by the VN's NAME, so two games that answer to the same
  // name share one profile file — and without the directory check the second
  // one to be loaded was re-skinned with the first one's colours, font and box
  // geometry, with nothing anywhere saying why.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame();
  const elsewhere = join(tmpdir(), "renpy-skin-neighbour", "game");
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const dir = join(home, "game", "Test VN");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "vn.json"),
      JSON.stringify({ name: "Test VN", gameDir: elsewhere, dialogbox: { textColor: "#ff00ff" } }),
      "utf8",
    );
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = routesOf(host);
    const read = (path) =>
      new Promise((resolve) => {
        routes
          .find((entry) => entry.path === path.split("?")[0])
          .handler(
            { method: "GET", url: path },
            { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
          );
      });

    const body = await read("/renpy-skin/manifest?session=global");
    assert.notEqual(body.manifest.dialogbox.textColor, "#ff00ff", "the neighbour's values must not be applied");
    assert.equal(body.manifest.profileApplied, undefined);
    assert.equal(body.manifest.profileRejected.savedGameDir, elsewhere);

    // The read route says the same thing, and still reports the directory the
    // agent should write into: it is the profile's home, just not this game's.
    const vn = await read("/renpy-skin/vn?session=global");
    assert.equal(vn.dir, dir);
    assert.deepEqual(vn.applied, []);
    assert.equal(vn.rejected.savedGameDir, elsewhere);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("one game configured by its root and by its game/ folder is still one game", async () => {
  // The two spellings reach the plugin from different places — the user browses
  // to the Ren'Py root, an agent is handed the `game/` folder — and a profile
  // written under one must keep applying under the other. Identity is compared
  // after resolving both, so the same game is not mistaken for a neighbour.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame();
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.gameDir }), "utf8");
    const dir = join(home, "game", "Test VN");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "vn.json"),
      JSON.stringify({ name: "Test VN", gameDir: game.root, dialogbox: { textColor: "#00ffff" } }),
      "utf8",
    );
    const host = fakeHostCtx();
    apply(host.ctx);
    const route = routesOf(host).find((entry) => entry.path === "/renpy-skin/manifest");
    const body = await new Promise((resolve) => {
      route.handler(
        { method: "GET", url: "/renpy-skin/manifest?session=global" },
        { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
      );
    });
    assert.equal(body.manifest.dialogbox.textColor, "#00ffff", "the same game's profile still applies");
    assert.equal(body.manifest.profileRejected, undefined);
    assert.deepEqual(body.manifest.profileApplied, ["dialogbox.textColor"]);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("renpy_save_vn names the sections it used, ignored and dropped", async () => {
  // The overlay drops what it does not recognise — deliberately, so a model
  // cannot break a section the client reads structurally — but silently. An
  // agent that wrote `spritez` instead of `sprites` therefore reported success
  // while the interface did not change, and repeated the mistake next time.
  // "Nothing changed" has four causes and the reply has to tell them apart.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame();
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const registered = toolsOf(host);
    const save = registered.find((tool) => tool.name === "renpy_save_vn");
    const said = (result) => save.output.render({}, result).map((part) => part.text).join("");

    const ignored = await save.execute(
      { tree: "# game/\n", config: { spritez: { enid: 1 } } },
      { agent: { id: "session-1" } },
    );
    assert.deepEqual(ignored.ignored, ["spritez"]);
    assert.deepEqual(ignored.malformed, []);
    assert.deepEqual(ignored.applied, [], "an unknown section overrides nothing");
    assert.match(said(ignored), /Ignored spritez/);
    assert.doesNotMatch(said(ignored), /already matched/, "an ignored section is not the scan agreeing");

    const malformed = await save.execute(
      { config: { dialogbox: "#ff0000" } },
      { agent: { id: "session-1" } },
    );
    assert.deepEqual(malformed.malformed, ["dialogbox"]);
    assert.match(said(malformed), /Dropped dialogbox/);

    // A real section with a misspelled field: the section exists, so it is not
    // "ignored", and it holds something, so it is not "malformed" either. It is
    // written and consumed by nobody, which is exactly the case that used to
    // report a clean success.
    const typo = await save.execute(
      { config: { layout: { dialogueWidht: 1150 } } },
      { agent: { id: "session-1" } },
    );
    assert.deepEqual(typo.unknownKeys, ["layout.dialogueWidht"]);
    assert.deepEqual(typo.applied, [], "a typo overrides nothing the client reads");
    assert.match(said(typo), /Check the spelling of layout\.dialogueWidht/);

    // A dry run reports the same verdicts and touches nothing at all. The file
    // exists by now from the writes above, so the check is that its bytes are
    // unchanged — a dry run that quietly rewrote the profile would be the same
    // "looks fine, changed nothing you can see" failure in a new place.
    const vnPath = join(home, "game", "Test VN", "vn.json");
    const before = readFileSync(vnPath, "utf8");
    const dry = await save.execute(
      { config: { dialogbox: { textColor: "#00ff00" } }, dryRun: true },
      { agent: { id: "session-1" } },
    );
    assert.equal(dry.dryRun, true);
    assert.deepEqual(
      dry.applied,
      ["dialogbox.textColor"],
      "a dry run answers in the same field paths a real save reports",
    );
    assert.match(said(dry), /nothing was written/);
    assert.equal(readFileSync(vnPath, "utf8"), before, "a dry run leaves the profile byte for byte");

    // The case the old wording claimed every empty result was: the scan really
    // does already say this.
    const matched = await save.execute(
      { config: { dialogbox: { textColor: "#ffffff" } } },
      { agent: { id: "session-1" } },
    );
    assert.deepEqual(matched.applied, []);
    assert.deepEqual(matched.ignored, []);
    assert.deepEqual(matched.malformed, []);
    assert.match(said(matched), /already matched/);

    // And a config that does change something still reports what it dropped.
    const applied = await save.execute(
      { config: { dialogbox: { textColor: "#ff0000" }, layout: {} } },
      { agent: { id: "session-1" } },
    );
    assert.deepEqual(applied.applied, ["dialogbox.textColor"]);
    assert.deepEqual(applied.malformed, ["layout"], "an empty section overrides nothing");
    assert.match(said(applied), /Applied over the scan: dialogbox\.textColor/);
    assert.match(said(applied), /Dropped layout/);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("the title-screen fallback prefers the engine's own gui/main_menu.png over a nested copy", () => {
  // Symptom (CSE): a game that ships both `gui/gui/main_menu.png` and
  // `gui/main_menu.png` showed the nested one, because the alphabetical list put
  // it first. With no splashscreen label the title art is the splash.
  const game = makeGame({
    files: { "gui/gui/main_menu.png": TINY_GIF, "gui/main_menu.png": TINY_GIF },
  });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: (p) => `/asset?p=${p}` });
    assert.equal(manifest.splash.source, "main-menu");
    assert.equal(manifest.splash.path, "gui/main_menu.png");
  } finally {
    game.dispose();
  }
});

test("renpy_read_manifest reads the scan back so the profile can correct real values", async () => {
  // The agent's `config` is meant to CORRECT what the scanner read rather than
  // replace it with guesses, so the values the scanner did read have to be
  // reachable. The reply is JSON in a fence for exactly that reason: the
  // sections come back in the same shape the profile takes them.
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame();
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const registered = toolsOf(host);

    const read = registered.find((tool) => tool.name === "renpy_read_manifest");
    assert.ok(read, "the read-only tool registers when a tools service is present");

    const result = await read.execute({}, { agent: { id: "session-1" } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.gameDir, game.gameDir, "the resolved folder, the same one the profile records");
    assert.equal(result.game.name, "Test VN");
    assert.equal(result.game.screen.w > 0 && result.game.screen.h > 0, true);
    assert.equal(result.dialogbox.textColor, "#ffffff", "the value the scan read, not a fallback");
    assert.ok(Array.isArray(result.characters), "a bounded cast list");
    assert.ok(Array.isArray(result.backgrounds));
    assert.equal(typeof result.stats.displayables, "number");
    assert.deepEqual(result.profile, { applied: [], rejected: null, unmatched: [] });

    const text = read.output.render({}, result).map((part) => part.text).join("");
    assert.match(text, /```json/);
    assert.match(text, /Test VN/);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("renpy_read_manifest refuses when no game is loaded", async () => {
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const registered = toolsOf(host);
    const read = registered.find((tool) => tool.name === "renpy_read_manifest");
    const result = await read.execute({}, { agent: { id: "session-1" } });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /renpy_configure/);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the /vn route hands back the notes and the record of what the write ignored", async () => {
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame();
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: game.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const registered = toolsOf(host);

    const save = registered.find((tool) => tool.name === "renpy_save_vn");
    const saved = await save.execute(
      {
        tree: "# game/\nbee.rpy — the opening chapter",
        summary: "Decided the text colour is #ff0000.",
        config: { dialogbox: { textColor: "#ff0000" }, spritez: { enid: 1 } },
      },
      { agent: { id: "session-1" } },
    );
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const route = routesOf(host).find((entry) => entry.path === "/renpy-skin/vn");
    const read = () =>
      new Promise((resolve) => {
        route.handler(
          { method: "GET", url: "/renpy-skin/vn?session=global" },
          { setHeader: () => {}, writeHead: () => {}, end: (payload) => resolve(JSON.parse(String(payload))) },
        );
      });

    const body = await read();
    assert.equal(body.summary, "Decided the text colour is #ff0000.", "the agent's own notes are readable");
    assert.match(body.tree, /the opening chapter/);
    assert.deepEqual(body.applied, ["dialogbox.textColor"]);
    // What the write was told to ignore is part of the record: the overlay
    // silently drops sections it does not know, and only this remembers it.
    assert.deepEqual(body.profile.report, { ignored: ["spritez"], malformed: [], unknownKeys: [] });

    // The notes are bounded — they are a glance for the settings page, not a way
    // to pull an arbitrarily large file into the browser.
    writeFileSync(join(home, "game", "Test VN", "summary.md"), "x".repeat(4100), "utf8");
    const again = await read();
    assert.equal(again.summary.length, 4002, "one bounded head: 4000 characters, a newline and the ellipsis");
    assert.ok(again.summary.endsWith("…"));
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

// ── host half: handing a loaded game to a new agent session ─────────────────

test("POST /agent/prepare writes both listings and answers with real paths", async () => {
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const game = makeGame({
    files: { "font/body.ttf": "not really a font", "audio/music/theme.ogg": "not really audio" },
  });
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const prepare = routes.find((route) => route.path === "/renpy-skin/agent/prepare");

    // The symptom this prevents: the button pasted a prompt that asked the model
    // to find the game, so its first move was to ask the user for a path — the
    // model cannot read the disk outside its workspace, and the conversation
    // ended there. Prepare has already resolved everything by the time the
    // prompt is sent.
    const reply = await callRoute(prepare, {
      method: "POST",
      body: { session: "session-1", gameDir: game.root },
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.gameDir, game.gameDir, "the resolved game/ folder, which is what the asset route serves");
    assert.equal(reply.name, "Test VN");
    assert.equal(reply.paths.gameDir, game.gameDir);
    assert.ok(reply.paths.compactTree.endsWith("scan-tree.md"));
    assert.ok(reply.paths.fullTree.endsWith("scan-tree.full.txt"));

    // Both files must exist and say something useful: the prompt names the
    // compact one, and the agent is told to read the full one when it needs a
    // path the compact map aggregated away.
    const compact = readFileSync(join(reply.profileDir, "scan-tree.md"), "utf8");
    assert.match(compact, /# Test VN/);
    assert.match(compact, /## scripts and config/);
    assert.match(compact, /gui\.rpy/, "the compact map names the file that decides the look");
    const full = readFileSync(join(reply.profileDir, "scan-tree.full.txt"), "utf8");
    assert.match(full, /images\/backgrounds\/forest day\.gif/, "the full listing keeps individual paths");
    assert.equal(reply.stats.files > 0, true);
    assert.equal(reply.stats.gameName, "Test VN");
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    game.dispose();
  }
});

test("POST /agent/prepare loads the game it is told to, not the one already set", async () => {
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  const first = makeGame({ files: { "options.rpy": 'define config.name = _("First VN")\n' } });
  const second = makeGame({ files: { "options.rpy": 'define config.name = _("Second VN")\n' } });
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gameDir: first.root }), "utf8");
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const prepare = routes.find((route) => route.path === "/renpy-skin/agent/prepare");

    const reply = await callRoute(prepare, { method: "POST", body: { session: "session-1", gameDir: second.root } });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.name, "Second VN");
    // Switching away must not leave the previous game's stage or pinned
    // directory behind, or the tool would keep painting the first novel.
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(saved.gameDir, second.root, "the switch is persisted, so a restart comes back to it");

    // And the new session is pinned to it: prepare runs before the session has
    // an id of its own, so this pin is what the tool's default resolves through.
    const manifest = routes.find((route) => route.path === "/renpy-skin/manifest");
    const read = await callRoute(manifest, { url: "/renpy-skin/manifest?session=session-1" });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.manifest.game.name, "Second VN");
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
    first.dispose();
    second.dispose();
  }
});

test("POST /agent/prepare refuses with a reason instead of a half-built profile", async () => {
  const home = mkdtempSync(join(tmpdir(), "rsk-home-"));
  process.env.DSH_RENPY_SKIN_HOME = home;
  try {
    const host = fakeHostCtx();
    apply(host.ctx);
    const routes = [];
    runInject(host, ["webServer"], {
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    });
    const prepare = routes.find((route) => route.path === "/renpy-skin/agent/prepare");

    // Nothing configured: the button has to say what is missing, because the
    // alternative — sending a prompt that cannot work — is the bug this route
    // exists to remove.
    const empty = await callRoute(prepare, { method: "POST", body: {} });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /no game is loaded/);

    // A directory that is not a Ren'Py game: the scan's own error is the useful
    // message, not a generic failure.
    const root = mkdtempSync(join(tmpdir(), "rsk-not-a-game-"));
    mkdirSync(join(root, "documents"), { recursive: true });
    const wrong = await callRoute(prepare, { method: "POST", body: { gameDir: root } });
    assert.equal(wrong.ok, false);
    assert.equal(typeof wrong.error, "string");
    assert.equal(existsSync(join(home, "game")), false, "no profile directory is created for a failed prepare");
    rmSync(root, { recursive: true, force: true });

    // A GET must not re-scan: preparing replaces the active game, so it has to
    // be an explicit POST or a browser prefetch would switch games by itself.
    const viaGet = await callRoute(prepare, { method: "GET" });
    assert.equal(viaGet.ok, false);
    assert.match(viaGet.error, /method not allowed/);
  } finally {
    delete process.env.DSH_RENPY_SKIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
