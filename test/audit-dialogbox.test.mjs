// Regression tests for the dialogue-box geometry audit (sub-task A).
//
// Each test builds a real temporary Ren'Py game on disk, the way makeGame does
// in skin.test.mjs, and reads it back through buildManifest. Nothing is mocked:
// the script-only archive below is a real RPA-3.0 file with a real deflated
// pickle index, because the reader's behaviour on archives is exactly what
// broke.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { buildManifest } from "../lib/manifest.js";
import { readAssignments, readStyleBlocks, resolveStyleNumber, styleBackgroundAlign, styleBackgroundPath } from "../lib/renpy.js";

/** A 1x1 GIF, the smallest valid image the size reader accepts. */
const TINY_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const ASSET_URL = (p) => `/asset?p=${encodeURIComponent(p)}`;

/**
 * A single-colour RGB PNG, deflated by hand.
 *
 * The palette tests need real pixels — the dominant colour is read from them —
 * and the reader walks chunk lengths without verifying CRCs, so a zero CRC is
 * enough and no CRC32 implementation has to be trusted.
 */
function solidPng(width, height, red, green, blue) {
  const row = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x += 1) row.set([red, green, blue], x * 3);
  const raw = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), row])),
  );
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** The XOR key Ren'Py uses to obfuscate offsets and lengths in an RPA index. */
const RPA_KEY = 0x42424242;

/**
 * A throwaway game with a `game/` folder. `files` are written verbatim, relative
 * to the game folder; the caller builds whatever script layout it needs.
 */
function makeGame(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "renpy-skin-dialogbox-"));
  const gameDir = join(root, "game");
  mkdirSync(gameDir, { recursive: true });
  writeFileSync(join(gameDir, "options.rpy"), 'define config.name = _("Dialog Test")\n', "utf8");
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(gameDir, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return { root, gameDir, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Encode a protocol-2 pickle of `{ name: (offset, length, b"") }`, the shape an
 * RPA-3 index takes. Only the opcodes the reader decodes are emitted.
 */
function pickleIndex(entries) {
  const parts = [Buffer.from([0x80, 0x02, 0x7d, 0x28])]; // PROTO 2, EMPTY_DICT, MARK
  for (const [name, [offset, length]] of entries) {
    const utf8 = Buffer.from(name, "utf8");
    const header = Buffer.alloc(5);
    header[0] = 0x58; // BINUNICODE
    header.writeUInt32LE(utf8.length, 1);
    parts.push(header, utf8);
    const tuple = Buffer.alloc(11 + 2 + 1);
    tuple[0] = 0x4a; // BININT
    tuple.writeInt32LE((offset ^ RPA_KEY) | 0, 1);
    tuple[5] = 0x4a;
    tuple.writeInt32LE((length ^ RPA_KEY) | 0, 6);
    tuple[10] = 0x43; // SHORT_BINBYTES, empty prefix
    tuple[11] = 0x00;
    tuple[12] = 0x87; // TUPLE3
    parts.push(tuple.subarray(0, 13));
  }
  parts.push(Buffer.from([0x75, 0x2e])); // SETITEMS, STOP
  return Buffer.concat(parts);
}

/**
 * Write a real RPA-3.0 archive holding `files` (name to bytes) and return its
 * path. Layout matches what Ren'Py writes: header line, file bodies, then a
 * deflated index at the offset the header names.
 */
function writeRpa(path, files) {
  const HEADER_LENGTH = 26;
  const body = [];
  const entries = new Map();
  let position = HEADER_LENGTH;
  for (const [name, bytes] of files) {
    entries.set(name, [position, bytes.length]);
    body.push(bytes);
    position += bytes.length;
  }
  const index = deflateSync(pickleIndex(entries));
  const header = Buffer.from(
    `RPA-3.0 ${position.toString(16).padStart(8, "0")} ${RPA_KEY.toString(16).padStart(8, "0")}\n`,
    "latin1",
  );
  writeFileSync(path, Buffer.concat([header, ...body, index]));
  return path;
}

test("style blocks set the say window, namebox and dialogue geometry and plates", () => {
  // Symptom: a game that sizes its dialogue box in `style window:` (no gui.*
  // variable for it) showed the 278px default box, the default dialogue column,
  // and the opaque-black fallback because its `Image("...")` plate was not read.
  const game = makeGame({
    "gui.rpy": [
      "init python:",
      "    gui.dialogue_xpos = 402",
      "",
    ].join("\n"),
    "screens.rpy": [
      "style window:",
      "    yalign 0.9",
      "    ysize 320",
      '    background Image("gui/mytextbox.png", xalign=0.5, yalign=1.0)',
      "",
      "style namebox:",
      "    xpos 150",
      "    ysize 90",
      '    background Frame("gui/mybox.png", gui.namebox_borders, tile=gui.namebox_tile)',
      "",
      "style say_dialogue:",
      "    xpos gui.dialogue_xpos",
      "    xsize 1400",
      "    ypos 40",
      "    size 40",
      '    color "#112233"',
      '    font "custom.ttf"',
      "",
    ].join("\n"),
    "gui/mytextbox.png": TINY_GIF,
    "gui/mybox.png": TINY_GIF,
    "font/custom.ttf": Buffer.from("placeholder font bytes"),
  });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: ASSET_URL });
    const { dialogbox, layout } = manifest;
    assert.equal(dialogbox.height, 320, "the style's ysize is the painted box height, not the 278 default");
    assert.equal(dialogbox.yalign, 0.9);
    assert.equal(dialogbox.textboxImage, ASSET_URL("gui/mytextbox.png"), "the style's Image(...) is the plate");
    assert.equal(dialogbox.nameboxImage, ASSET_URL("gui/mybox.png"), "the style's Frame(...) is the namebox plate");
    assert.equal(layout.nameXpos, 150);
    assert.equal(layout.nameboxHeight, 90);
    assert.equal(layout.dialogueXpos, 402, "a gui.* reference inside a style resolves through gui.*");
    assert.equal(layout.dialogueWidth, 1400);
    assert.equal(layout.dialogueYpos, 40);
    assert.equal(dialogbox.textSize, 40);
    assert.equal(dialogbox.textColor, "#112233");
    assert.equal(dialogbox.font, "custom.ttf");
    assert.equal(dialogbox.fontPath, "font/custom.ttf");
  } finally {
    game.dispose();
  }
});

test("a gui.* variable beats a style default when the game sets both", () => {
  // Symptom: the style and gui.* spellings disagreed and the wrong one won. The
  // style is what the engine paints with, so an explicit style value wins; a
  // style that only names a gui.* reference must not override a gui.* literal.
  const game = makeGame({
    "gui.rpy": "define gui.textbox_height = 278\ndefine gui.name_xpos = 360\n",
    "screens.rpy": "style window:\n    ysize gui.textbox_height\n\nstyle namebox:\n    xpos gui.name_xpos\n",
  });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: ASSET_URL });
    assert.equal(manifest.dialogbox.height, 278);
    assert.equal(manifest.layout.nameXpos, 360);
  } finally {
    game.dispose();
  }
});

test("a phone-only @gui.variant block does not change the desktop values", () => {
  // Symptom: SharedHouse's desktop build showed a 400px dialogue box with the
  // phone's dialogue column (x=245). The phone layout is written as
  // `@gui.variant` above `def small():`, which the variant guard did not match.
  const script = [
    "init python:",
    "    gui.textbox_height = 278",
    "    gui.dialogue_xpos = 402",
    "",
    "    @gui.variant",
    "    def small():",
    "",
    "        gui.textbox_height = 400",
    "        gui.dialogue_xpos = 245",
    "",
  ].join("\n");
  const values = readAssignments(script);
  assert.equal(values.get("gui.textbox_height"), 278);
  assert.equal(values.get("gui.dialogue_xpos"), 402);

  const game = makeGame({ "gui.rpy": script });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: ASSET_URL });
    assert.equal(manifest.dialogbox.height, 278);
    assert.equal(manifest.layout.dialogueXpos, 402);
  } finally {
    game.dispose();
  }
});

test("a script-only archive still supplies the gui.* values", () => {
  // Symptom: Castle&Myosotis ships `scripts.rpa` with no art in it. The asset
  // index only kept archives that contributed an image, so `scripts/gui.rpy`
  // was never read and the box fell back to the 278px / x=0 defaults although
  // the game sets 300px and x=320.
  const game = makeGame({});
  try {
    writeRpa(join(game.gameDir, "scripts.rpa"), [
      [
        "scripts/gui.rpy",
        Buffer.from("define gui.textbox_height = 300\ndefine gui.name_xpos = 320\n", "utf8"),
      ],
    ]);
    const { manifest } = buildManifest(game.root, { assetUrl: ASSET_URL });
    assert.equal(manifest.dialogbox.height, 300, "the archived gui.rpy is read");
    assert.equal(manifest.layout.nameXpos, 320);
  } finally {
    game.dispose();
  }
});

test("readStyleBlocks reads column-0 style headers and lets a later block win", () => {
  const styles = readStyleBlocks(
    [
      "style window is default",
      "style window:",
      "    ysize 300",
      "    yalign 1.0",
      "style window:",
      "    ysize 360",
      "init python:",
      "    style namebox:",
      "        xpos 999",
      "",
    ].join("\n"),
  );
  assert.equal(styles.get("window").get("ysize"), "360", "the later block overwrites the earlier one");
  assert.equal(styles.get("window").get("yalign"), "1.0");
  assert.equal(styles.has("namebox"), false, "an indented style inside init python is not read");
});

test("resolveStyleNumber and styleBackgroundPath read the forms the games write", () => {
  const names = new Map([["gui.name_xpos", 360]]);
  assert.equal(resolveStyleNumber("320", names), 320);
  assert.equal(resolveStyleNumber("gui.name_xpos", names), 360);
  assert.equal(resolveStyleNumber("gui.unknown", names), undefined);
  assert.equal(resolveStyleNumber("center", names), undefined);
  assert.equal(styleBackgroundPath('Image("gui/textbox.png", xalign=0.5)'), "gui/textbox.png");
  assert.equal(styleBackgroundPath('Frame("gui/namebox_base.png", gui.namebox_borders)'), "gui/namebox_base.png");
  assert.equal(styleBackgroundPath('"gui/plain.png"'), "gui/plain.png", "a bare string names its picture too");
});

test("a phone `variant` style block does not replace the desktop textbox", () => {
  // Symptom: every Ren'Py template restates `style window` for phones further
  // down screens.rpy (`variant "small"`, `background "gui/phone/textbox.png"`).
  // The later block overwrote the desktop background, the lookup found nothing,
  // and the textbox only appeared because a file happened to be named
  // gui/textbox.png; a game with another file name lost its plate.
  const source = [
    "style window:",
    '    background Image("gui/my_plate.png", xalign=0.5, yalign=0.9)',
    "    ysize 300",
    "",
    "style window:",
    '    variant "small"',
    '    background "gui/phone/textbox.png"',
    "    ysize 400",
    "",
  ].join("\n");
  const window = readStyleBlocks(source).get("window");
  assert.equal(styleBackgroundPath(window.get("background")), "gui/my_plate.png");
  assert.equal(window.get("ysize"), "300");
  assert.deepEqual(styleBackgroundAlign(window.get("background")), { x: 0.5, y: 0.9 });
});

test("the say screen's own pieces become modules, and unmappable buttons are only reported", () => {
  // Symptom: the dialogue box was only ever the plate and the text column, so a
  // game whose say screen draws a name plate or its own quick-menu row lost all
  // of it. The scan translates the parts the client can actually drive and
  // reports the rest in `quickMenu`, because a button the client cannot perform
  // is worse than no button at all.
  const game = makeGame({
    "gui.rpy": [
      "define gui.name_xpos = 360",
      "define gui.name_ypos = 12",
      "define gui.namebox_width = 300",
      "define gui.namebox_height = 90",
      'define gui.namebox_background = "gui/namebox.gif"',
      "",
    ].join("\n"),
    "screens.rpy": [
      "screen say(who, what):",
      '    add "gui/plate.gif" pos (0, 802) xsize 1920 ysize 278',
      '    add "gui/ornament.gif" pos (100, 200) xsize 120 ysize 60 zorder 3',
      '    add "gui/tiny.gif"',
      "    window:",
      "        text who pos (390, 840)",
      "        text what pos (335, 905)",
      "",
      "screen quick_menu():",
      "    hbox:",
      "        xalign 0.5",
      "        yalign 1.0",
      '        textbutton _("History") action ShowMenu("history")',
      '        textbutton _("QuickSave") action QuickSave()',
      '        textbutton _("Prefs") action ShowMenu("preferences")',
      "",
    ].join("\n"),
    "gui/plate.gif": TINY_GIF,
    "gui/ornament.gif": TINY_GIF,
    "gui/tiny.gif": TINY_GIF,
    "gui/namebox.gif": TINY_GIF,
  });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: ASSET_URL });
    const { modules, quickMenu } = manifest.dialogbox;

    // The say screen's own `add` is art the client can draw. The first one is
    // the plate itself (the existing scan already takes it), so only the rest
    // become modules.
    assert.equal(manifest.dialogbox.textboxPath, "gui/plate.gif", "the first add stays the plate");
    assert.equal(modules.some((module) => module.image === "gui/plate.gif"), false, "the plate is not also a module");
    const ornament = modules.find((module) => module.image === "gui/ornament.gif");
    assert.ok(ornament, "the say screen's own image becomes a module");
    assert.deepEqual(ornament.rect, { x: 100, y: 200, w: 120, h: 60 }, "pos and xsize/ysize survive the add's inline properties");
    assert.equal(ornament.z, 3, "the zorder travels with the image");
    assert.equal(ornament.source, "screen");
    assert.equal(ornament.imageUrl, ASSET_URL("gui/ornament.gif"), "the scan serves the URL as well");
    const natural = modules.find((module) => module.image === "gui/tiny.gif");
    assert.ok(natural, "an add with no size falls back to the file's own size");
    assert.deepEqual(natural.rect, { x: 0, y: 0, w: 1, h: 1 }, "a 1x1 fixture is drawn at 1x1");

    // The name box the client never drew. The fixture's own plate states the
    // window top as 802 (the default 1080-high canvas minus the 278px box), and
    // `layout.nameYpos` is already relative to it; a module rect is canvas
    // space, so the offset is added back. The screen's `text who pos` beats the
    // `gui.name_xpos` variable, which is why x is 390 and not 360.
    const WINDOW_TOP = 802;
    assert.equal(manifest.layout.nameYpos, 38, "the reader already subtracted the window offset");
    const plate = modules.find((module) => module.image === "gui/namebox.gif");
    assert.ok(plate, "the name box plate becomes a module");
    assert.deepEqual(plate.rect, {
      x: 390,
      y: WINDOW_TOP + 38,
      w: 300,
      h: 90,
    });

    // Quick-menu buttons: two map onto client actions, History does not.
    const buttons = modules.filter((module) => module.kind === "button");
    assert.deepEqual(
      buttons.map((button) => [button.text, button.action]),
      [["QuickSave", "settings"], ["Prefs", "settings"]],
    );
    assert.equal(buttons.every((button) => button.source === "flow"), true, "the hbox row is laid out, not positioned");
    assert.deepEqual(
      quickMenu,
      [{ label: "History", action: 'ShowMenu("history")' }],
      "a button with no client equivalent is reported, never drawn",
    );

    // The row's anchor is the hbox's own `yalign 1.0`, so its bottom edge is the
    // canvas bottom; the buttons advance along the row instead of stacking.
    const [first, second] = buttons;
    assert.equal(first.rect.y + first.rect.h, 1080, "yalign 1.0 puts the row's bottom at the canvas bottom");
    assert.ok(second.rect.x >= first.rect.x + first.rect.w, "the buttons advance instead of stacking");
  } finally {
    game.dispose();
  }
});

test("a missing gui.accent_color is sampled from the dialogue plate", () => {
  // `gui.accent_color` is optional, and the hardcoded fallback is a colour no
  // game chose. The plate is painted in the game's own palette, so the colour
  // most of it is made of stands in — and the manifest records `image-sample`,
  // which is the row source the settings page shows.
  const game = makeGame({
    "gui.rpy": 'define gui.textbox_image = "gui/plate.png"\n',
    "gui/plate.png": solidPng(6, 6, 0x28, 0x3c, 0x50),
  });
  try {
    const { manifest } = buildManifest(game.root, { assetUrl: ASSET_URL });
    const entry = (key) => manifest.palette.find((row) => row.key === key);
    assert.deepEqual(
      manifest.palette.map((row) => row.key),
      ["accent", "hover", "idle", "text", "uiText", "name", "choiceIdle", "choiceHover"],
      "every editable slot is reported, in a stable order",
    );
    assert.equal(entry("accent").value, "#283c50");
    assert.equal(entry("accent").source, "image-sample");
    // The slots that merely default to the accent have to follow the sample, or
    // the settings page would offer a colour the theme does not actually use.
    assert.equal(entry("hover").value, "#283c50");
    assert.equal(entry("name").value, "#283c50");
    assert.equal(manifest.sources["theme.accent"], "image-sample");
    assert.equal(manifest.theme["--dsw-alias-brand-primary"].dark, "#283c50");
  } finally {
    game.dispose();
  }
});

test("a stated accent is never replaced by a sample, and the settings page wins over both", () => {
  const game = makeGame({
    "gui.rpy": 'define gui.accent_color = "#ff0000"\ndefine gui.textbox_image = "gui/plate.png"\n',
    "gui/plate.png": solidPng(6, 6, 0x28, 0x3c, 0x50),
  });
  try {
    const stated = buildManifest(game.root, { assetUrl: ASSET_URL }).manifest;
    assert.equal(stated.palette.find((row) => row.key === "accent").value, "#ff0000");
    assert.equal(
      stated.palette.find((row) => row.key === "accent").source,
      "gui-variable",
      "a colour the game states is not second-guessed by the image",
    );

    const pinned = buildManifest(game.root, {
      assetUrl: ASSET_URL,
      palette: { accent: "#112233" },
    }).manifest;
    assert.equal(pinned.palette.find((row) => row.key === "accent").value, "#112233");
    assert.equal(pinned.palette.find((row) => row.key === "accent").source, "settings");
    assert.equal(pinned.sources["theme.accent"], "settings");
    assert.equal(pinned.theme["--dsw-alias-brand-primary"].dark, "#112233");
    // A slot nobody pinned still follows the game — and since this game states
    // no `gui.hover_color`, `hover` follows the accent that is now pinned.
    assert.equal(pinned.palette.find((row) => row.key === "hover").value, "#112233");
  } finally {
    game.dispose();
  }
});

test("pinning the dialogue text and the interface text move independently", () => {
  // The two slots start out equal — a game whose dialogue is gold wants gold UI
  // text — so the split is only observable by pinning one and checking that the
  // other did not move. It used to move: `--dsw-alias-label-primary` was taken
  // straight from `dialogbox.textColor`, so recolouring the box recoloured
  // every label in the shell.
  const game = makeGame({ "gui.rpy": 'define gui.text_color = "#ffcc00"\n' });
  try {
    const entry = (manifest, key) => manifest.palette.find((row) => row.key === key);

    const plain = buildManifest(game.root, { assetUrl: ASSET_URL }).manifest;
    assert.equal(entry(plain, "text").value, "#ffcc00");
    assert.equal(entry(plain, "uiText").value, "#ffcc00", "the shell follows the game's dialogue colour by default");
    assert.equal(entry(plain, "uiText").source, "dialogue-text");
    assert.equal(plain.theme["--dsw-alias-label-primary"].dark, "#ffcc00");

    const boxOnly = buildManifest(game.root, { assetUrl: ASSET_URL, palette: { text: "#112233" } }).manifest;
    assert.equal(entry(boxOnly, "text").value, "#112233");
    assert.equal(entry(boxOnly, "uiText").value, "#ffcc00", "pinning the box must not recolour the shell");
    assert.equal(boxOnly.theme["--dsw-alias-label-primary"].dark, "#ffcc00");

    const shellOnly = buildManifest(game.root, { assetUrl: ASSET_URL, palette: { uiText: "#445566" } }).manifest;
    assert.equal(entry(shellOnly, "text").value, "#ffcc00", "pinning the shell must not recolour the box");
    assert.equal(entry(shellOnly, "uiText").value, "#445566");
    assert.equal(entry(shellOnly, "uiText").source, "settings");
    // One picked colour has to serve both surfaces, or the light theme would
    // keep a label colour the user cannot see in the picker.
    assert.equal(shellOnly.theme["--dsw-alias-label-primary"].light, "#445566");
    assert.equal(shellOnly.theme["--dsw-alias-label-primary"].dark, "#445566");
  } finally {
    game.dispose();
  }
});
