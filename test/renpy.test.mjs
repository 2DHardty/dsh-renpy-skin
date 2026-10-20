import test from "node:test";
import assert from "node:assert/strict";

import {
  evalValue,
  readCharacterDeclarations,
  readScreenBlocks,
} from "../lib/renpy.js";

// The say screen a commercial game ships instead of the template's. Verbatim
// from docs/questions/03-screens.md (game/newScreens.rpy:418). Every value the
// dialogue box needs lives here and none of it is in a `style` block, so when
// this body went unread the manifest reported dialogueXpos 0, dialogueYpos 0,
// textSize 33, textColor "#ffffff" and the template's near-transparent
// `gui/textbox.png` — six plausible-looking values, all wrong.
const CSE_SAY = `
screen say(who, what):              # game/newScreens.rpy:418
    hbox:                            # pos=(1100, 850) 存盘/设置/历史/回退/隐藏/自动/快进 七个按钮
    add 'newgui/say/textbox.png' with align=(0.5, 1.0)
    add 'newgui/say/graffiti.png' with pos=(1490, 885)
    if who is not None:
        frame:
            pos (265, 798)
            background Frame('newgui/say/namebox.png', 30, 30)
            padding (60, 30)
            text who color '#624B34' kerning 10 font 'fonts/ChillReunion_Round.otf'
    text what:
        id 'what'
        pos (335, 905)
        xmaximum 1150
        color '#624B34'
        kerning 2
        size 30
        font 'fonts/ChillReunion_Round.otf'
        line_spacing 20
`;

/** The `adds` entry of one kind, failing loudly when the parser dropped it. */
function kind(entry, name) {
  return entry.adds.filter((add) => add.kind === name);
}

test("readScreenBlocks reads the real CSE say screen", () => {
  const screens = readScreenBlocks(CSE_SAY);
  assert.equal(screens.size, 1);
  const say = screens.get("say");
  assert.ok(say, "screen say must be found");

  // Both textboxes are top-level `add`s; dropping either one sends the caller
  // back to the template's almost fully transparent `gui/textbox.png`.
  const background = kind(say, "add");
  assert.equal(background.length, 2);
  assert.equal(background[0].raw, "'newgui/say/textbox.png' with align=(0.5, 1.0)");
  assert.equal(background[1].raw, "'newgui/say/graffiti.png' with pos=(1490, 885)");

  // The name box is a `frame` nested inside `if who is not None:`, so reading
  // only the direct children of the screen would lose its position entirely.
  // `depth` counts the containers above it: `if` is one, the screen body is not.
  const frames = kind(say, "frame");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].properties.get("pos"), "(265, 798)");
  assert.equal(frames[0].properties.get("padding"), "(60, 30)");
  assert.equal(
    frames[0].properties.get("background"),
    "Frame('newgui/say/namebox.png', 30, 30)",
  );
  assert.equal(frames[0].depth, 1);
  assert.deepEqual(frames[0].ancestors.map((outer) => outer.kind), ["if"]);

  // The `text who ...` one-liner carries the name colour; the property names
  // after the leading expression must not be shifted by one. `raw` keeps the
  // whole statement head (the `who` expression plus its properties) because it
  // is the raw text after the keyword, the same rule the `add ... with align=`
  // form follows.
  const texts = kind(say, "text");
  assert.equal(texts.length, 2);
  assert.equal(
    texts[0].raw,
    "who color '#624B34' kerning 10 font 'fonts/ChillReunion_Round.otf'",
  );
  assert.equal(texts[0].properties.get("color"), "'#624B34'");
  assert.equal(texts[0].properties.get("kerning"), "10");
  assert.equal(texts[0].properties.get("font"), "'fonts/ChillReunion_Round.otf'");

  // The dialogue body: the values that were reported as 0 / 33 / #ffffff. It is
  // a direct child of the screen, so its `pos` is a canvas coordinate and there
  // is no ancestor that could make it relative.
  const what = texts[1];
  assert.equal(what.raw, "what");
  assert.equal(what.depth, 0);
  assert.deepEqual(what.ancestors, []);
  assert.equal(what.properties.get("id"), "'what'");
  assert.equal(what.properties.get("pos"), "(335, 905)");
  assert.equal(what.properties.get("xmaximum"), "1150");
  assert.equal(what.properties.get("color"), "'#624B34'");
  assert.equal(what.properties.get("size"), "30");
  assert.equal(what.properties.get("line_spacing"), "20");

  // `hbox:` has no geometry of its own here, but it must not swallow the lines
  // that follow it.
  assert.equal(say.hasVariant, undefined);
});

test("readScreenBlocks skips the variant \"small\" redefinition", () => {
  // Ren'Py writes the phone layout after the desktop one, so a plain
  // last-definition-wins merge hands the desktop shell 470px of textbox.
  const source = `
screen say(who, what):
    text what:
        pos (335, 905)
        size 30

screen say(who, what):
    variant "small"
    text what:
        pos (245, 720)
        size 43
`;
  const say = readScreenBlocks(source).get("say");
  assert.equal(say.properties.get("variant"), undefined);
  assert.equal(say.adds.length, 1);
  assert.equal(say.adds[0].properties.get("pos"), "(335, 905)");
  assert.equal(say.adds[0].properties.get("size"), "30");
});

test("readScreenBlocks skips the @variant decorator form", () => {
  const source = `
screen say(who, what):
    text what:
        pos (335, 905)

@gui.variant("small")
screen say(who, what):
    text what:
        pos (245, 720)

@variant "touch"
screen choice:
    text "phone only"
`;
  const screens = readScreenBlocks(source);
  assert.equal(screens.get("say").adds[0].properties.get("pos"), "(335, 905)");
  // The decorator applies to its own screen only: `choice` was never defined
  // for the desktop, so it stays absent rather than arriving with phone values.
  assert.equal(screens.has("choice"), false);
});

test("readScreenBlocks lets a later definition of the same name win", () => {
  // The template defines `screen say` in screens.rpy and the game overrides it
  // in newScreens.rpy; keeping the first would leave every value at the default.
  const source = `
screen say(who, what):
    text what:
        size 22

screen say(who, what):
    text what:
        size 30
`;
  const say = readScreenBlocks(source).get("say");
  assert.equal(say.adds.length, 1);
  assert.equal(say.adds[0].properties.get("size"), "30");
});

test("readScreenBlocks reads the screen's own properties and hasVariant", () => {
  const source = `
screen main_menu:
    tag menu
    variant "large"
    add "gui/main_menu.png"
    use navigation
`;
  const menu = readScreenBlocks(source).get("main_menu");
  assert.equal(menu.properties.get("tag"), "menu");
  assert.equal(menu.properties.get("variant"), '"large"');
  assert.equal(menu.hasVariant, "large");
  assert.equal(menu.adds.length, 1);
  assert.equal(menu.adds[0].kind, "add");
  assert.equal(menu.adds[0].raw, '"gui/main_menu.png"');
  // `use navigation` opens no block and is not a known statement: dropped
  // rather than reported as a property.
  assert.equal(menu.properties.has("use"), false);
});

test("readScreenBlocks keeps both spellings of every statement", () => {
  // The bare `frame:` spells its properties on the lines below, while
  // `frame: pos (265, 798)` keeps them on the same line. Only reading one of
  // the two drops the name box geometry for half the games in the wild.
  const source = `
screen say(who, what):
    background "gui/overlay/say.png"
    add "gui/say.png"
    window:
        style "say_window"
        padding (40, 20)
    frame:
        pos (265, 798)
        background Frame('newgui/say/namebox.png', 30, 30)
    text what:
        pos (335, 905)
        size 30

screen say_one_line(who, what):
    window: style "say_window"
    frame: pos (265, 798)
    text what: pos (335, 905) size 30
    add "gui/say.png" with align=(0.5, 1.0)
    background: "gui/overlay/say.png"
`;
  const block = readScreenBlocks(source).get("say");
  const oneLine = readScreenBlocks(source).get("say_one_line");

  // `background` and `add` written without a colon have no block at all. The
  // frame's own `background Frame(...)` is a displayable too, so it is a second
  // entry — one container deeper — rather than only a property of the frame.
  const backgrounds = block.adds.filter((add) => add.kind === "background");
  assert.equal(backgrounds.length, 2);
  assert.equal(backgrounds[0].depth, 0);
  assert.equal(backgrounds[0].raw, '"gui/overlay/say.png"');
  assert.equal(backgrounds[1].depth, 1);
  assert.deepEqual(backgrounds[1].ancestors.map((outer) => outer.kind), ["frame"]);
  assert.equal(backgrounds[1].raw, "Frame('newgui/say/namebox.png', 30, 30)");
  assert.equal(block.adds.filter((add) => add.kind === "add").length, 1);

  const windowEntry = block.adds.find((add) => add.kind === "window");
  assert.equal(windowEntry.raw, "");
  // `style "say_window"` is a statement, not a `key value` property: the window
  // block's contents are read for geometry, and `style` names a style instead.
  assert.equal(windowEntry.properties.get("padding"), "(40, 20)");

  const blockFrame = block.adds.find((add) => add.kind === "frame");
  assert.equal(blockFrame.raw, "");
  assert.equal(blockFrame.properties.get("pos"), "(265, 798)");
  assert.equal(
    blockFrame.properties.get("background"),
    "Frame('newgui/say/namebox.png', 30, 30)",
  );

  const blockText = block.adds.find((add) => add.kind === "text");
  assert.equal(blockText.raw, "what");
  assert.equal(blockText.properties.get("pos"), "(335, 905)");
  assert.equal(blockText.properties.get("size"), "30");

  // Same statements, one line each: `raw` carries the text after the colon and
  // the inline properties are already split out of it.
  const lineWindow = oneLine.adds.find((add) => add.kind === "window");
  assert.equal(lineWindow.raw, 'style "say_window"');
  assert.equal(lineWindow.properties.get("style"), '"say_window"');

  const lineFrame = oneLine.adds.find((add) => add.kind === "frame");
  assert.equal(lineFrame.raw, "pos (265, 798)");
  assert.equal(lineFrame.properties.get("pos"), "(265, 798)");

  const lineText = oneLine.adds.find((add) => add.kind === "text");
  assert.equal(lineText.raw, "what");
  assert.equal(lineText.properties.get("pos"), "(335, 905)");
  assert.equal(lineText.properties.get("size"), "30");

  const lineAdd = oneLine.adds.find((add) => add.kind === "add");
  assert.equal(lineAdd.raw, '"gui/say.png" with align=(0.5, 1.0)');
  assert.equal(lineAdd.properties.get("align"), "(0.5, 1.0)");

  const lineBackground = oneLine.adds.find((add) => add.kind === "background");
  assert.equal(lineBackground.raw, '"gui/overlay/say.png"');
  // The displayable text is the only content of a bare `background`, so no
  // property may be invented from it.
  assert.equal(lineBackground.properties.size, 0);
});

test("readScreenBlocks ignores indentation width and tab bodies", () => {
  // Files in the wild are written with 2 spaces or tabs; hardcoding 4 would
  // make every child look like a sibling of the screen header.
  const twoSpace = `
screen say(who, what):
  text what:
    pos (335, 905)
    size 30
`;
  const tabbed = "screen say(who, what):\n\ttext what:\n\t\tpos (335, 905)\n\t\tsize 30\n";
  for (const source of [twoSpace, tabbed]) {
    const what = readScreenBlocks(source).get("say").adds[0];
    assert.equal(what.kind, "text");
    assert.equal(what.properties.get("pos"), "(335, 905)");
    assert.equal(what.properties.get("size"), "30");
  }
});

test("readScreenBlocks records depth and ancestors on every entry", () => {
  // Without these two fields the callers cannot tell a canvas coordinate from a
  // frame-relative one: `text what: pos (335, 905)` and the `pos` of a name box
  // frame nested inside `if who is not None:` are both a bare pair of numbers,
  // so a name box position read at the wrong depth silently becomes the
  // dialogue position and nothing anywhere reports an error.
  const source = `
screen say(who, what):
    add "gui/say.png" with align=(0.5, 1.0)
    if who is not None:
        frame:
            pos (265, 798)
            background Frame("gui/namebox.png", 30, 30)
            vbox:
                spacing 4
                text who color '#624B34'
    text what:
        pos (335, 905)
        size 30
`;
  const say = readScreenBlocks(source).get("say");

  // Every entry carries the field pair, and the two never disagree.
  for (const add of say.adds) {
    assert.equal(typeof add.depth, "number", `depth missing on ${add.kind}`);
    assert.ok(Array.isArray(add.ancestors), `ancestors missing on ${add.kind}`);
    assert.equal(add.depth, add.ancestors.length, `depth/ancestors on ${add.kind}`);
  }

  const topAdd = say.adds.find((add) => add.kind === "add");
  assert.equal(topAdd.depth, 0);
  assert.deepEqual(topAdd.ancestors, []);
  assert.equal(topAdd.properties.get("align"), "(0.5, 1.0)");
  assert.equal(topAdd.properties.has("with"), false);

  // The name box frame sits one `if` inside the screen body, so its `pos` is
  // already relative to a container and the chain says which one.
  const frame = say.adds.find((add) => add.kind === "frame");
  assert.equal(frame.depth, 1);
  assert.deepEqual(frame.ancestors.map((outer) => outer.kind), ["if"]);
  assert.equal(frame.properties.get("pos"), "(265, 798)");

  // The name box image, one container deeper again.
  const namebox = say.adds.find((add) => add.kind === "background");
  assert.equal(namebox.depth, 2);
  assert.deepEqual(namebox.ancestors.map((outer) => outer.kind), ["if", "frame"]);

  const whoText = say.adds.find((add) => add.raw.startsWith("who"));
  assert.equal(whoText.depth, 3);
  assert.deepEqual(
    whoText.ancestors.map((outer) => outer.kind),
    ["if", "frame", "vbox"],
  );
  assert.equal(whoText.properties.get("color"), "'#624B34'");

  // Each ancestor keeps only its own properties: the frame's `pos` must not
  // arrive as the text's, nor the text's `color` as the vbox's.
  assert.equal(whoText.ancestors[1].properties.get("pos"), "(265, 798)");
  assert.equal(whoText.ancestors[1].properties.has("color"), false);
  assert.equal(whoText.ancestors[2].properties.get("spacing"), "4");
  assert.equal(whoText.ancestors[2].properties.has("pos"), false);

  // The dialogue body is a direct child of the screen: depth 0 is what says its
  // `pos` is a canvas coordinate rather than something relative.
  const whatText = say.adds.find((add) => add.raw === "what");
  assert.equal(whatText.depth, 0);
  assert.deepEqual(whatText.ancestors, []);
  assert.equal(whatText.properties.get("pos"), "(335, 905)");

  // `if` and `vbox` are containers only: they never become entries of their
  // own, but they still appear in the chain.
  assert.equal(say.adds.some((add) => add.kind === "if"), false);
  assert.equal(say.adds.some((add) => add.kind === "vbox"), false);
  // `text who` and `text what` are the only two text entries, so a container
  // was not reported as if it were a displayable.
  assert.equal(say.adds.filter((add) => add.kind === "text").length, 2);
});

test("readScreenBlocks returns an empty Map for junk without throwing", () => {
  for (const source of ["", "   \n\n", "label start:\n    pass\n", null, undefined]) {
    const screens = readScreenBlocks(source);
    assert.ok(screens instanceof Map);
    assert.equal(screens.size, 0);
  }
  // Unbalanced input is skipped line by line instead of throwing, so one broken
  // file does not abort the whole manifest build.
  const screens = readScreenBlocks("screen say(who, what):\n    text what:\n        size\n");
  assert.ok(screens instanceof Map);
});

test("readCharacterDeclarations reads the real CSE Character declaration", () => {
  // game/characters.rpy. The name box showed the sprite tag (`qc`) instead of
  // 「启诚」 and fell back to the accent colour, because this line was dropped
  // before any consumer saw it.
  const characters = readCharacterDeclarations(
    `define qc = Character('启诚', color="#624B34", image="qc", callback=auto_highlight, cb_name='qc')\n`,
  );
  assert.equal(characters.size, 1);
  const qc = characters.get("qc");
  assert.deepEqual(qc, { name: "启诚", color: "#624B34", image: "qc", kind: "character" });
});

test("readCharacterDeclarations handles multi-line arguments", () => {
  const source = `
define el = Character(
    "Eileen",
    color="#c8ffc8",
    image="eileen",
    callback=auto_highlight,
    cb_name="Eileen",
)
default mc = DynamicCharacter(_("玩家"), color=ACCENT, image="mc")
`;
  const characters = readCharacterDeclarations(source);
  const el = characters.get("el");
  assert.equal(el.name, "Eileen");
  assert.equal(el.color, "#c8ffc8");
  assert.equal(el.image, "eileen");
  assert.equal(el.kind, "character");

  // `default` declares characters in some games, a named colour is left for the
  // caller to resolve, and `_()` is unwrapped like every other translated value.
  const mc = characters.get("mc");
  assert.equal(mc.name, "玩家");
  assert.equal(mc.color, "ACCENT");
  assert.equal(mc.image, "mc");
  assert.equal(mc.kind, "dynamiccharacter");
});

test("readCharacterDeclarations keeps unknown parts null and never throws", () => {
  const characters = readCharacterDeclarations(
    "define narrator = Character(None)\ndefine e = Character()\nstyle x:\n    color \"#fff\"\n",
  );
  assert.deepEqual(characters.get("narrator"), {
    name: null,
    color: null,
    image: null,
    kind: "character",
  });
  assert.deepEqual(characters.get("e"), {
    name: null,
    color: null,
    image: null,
    kind: "character",
  });
  // A non-character assignment is not invented as one.
  assert.equal(characters.has("x"), false);
  // Only character constructors count. Every Ren'Py template writes
  // `default page_name_value = FilePageNameInputValue(...)` inside the save/load
  // screen; reading that as a speaker added a cast member with no name, no
  // colour and no sprite to a real game (138 "characters" on one probe), and
  // made `stats.characters` meaningless.
  const template = readCharacterDeclarations(
    'default page_name_value = FilePageNameInputValue(pattern=_("Page {}"))\ndefine e = Character("Eileen")\n',
  );
  assert.equal(template.size, 1, "a screen-local default is not a cast member");
  assert.equal(template.has("page_name_value"), false);
  assert.equal(template.get("e").name, "Eileen");
  for (const source of ["", null, undefined, "define = Character("]) {
    const empty = readCharacterDeclarations(source);
    assert.ok(empty instanceof Map);
    assert.equal(empty.size, 0);
  }
});

test("evalValue keeps keyword arguments in kwargs", () => {
  // Before this field existed the colour and the sprite tag of a character
  // declaration were unreachable: they came back only as `undefined` slots.
  const value = evalValue(
    `Character('启诚', color="#624B34", image="qc", callback=auto_highlight)`,
  );
  assert.equal(value.call, "Character");
  // `args` deliberately keeps its old length and order, with the keyword slots
  // still `undefined`, so no existing caller changes behaviour.
  assert.deepEqual(value.args, ["启诚", undefined, undefined, undefined]);
  assert.deepEqual(value.kwargs, {
    color: "#624B34",
    image: "qc",
    callback: undefined,
  });

  // A call with no keyword arguments gains an empty object, not a numeric-keyed
  // one, and a call with no arguments at all still resolves.
  assert.deepEqual(evalValue("Color('#fff', 1.0)"), {
    call: "Color",
    args: ["#fff", 1],
    kwargs: {},
  });
  assert.deepEqual(evalValue("Foo()"), { call: "Foo", args: [], kwargs: {} });

  // `==` inside an argument is not a keyword argument.
  assert.deepEqual(evalValue("Bar(a == b)").kwargs, {});
});
