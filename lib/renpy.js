/**
 * Ren'Py source reading for the skin manifest.
 *
 * Two jobs, both deliberately narrow — this is NOT a Ren'Py script parser:
 *
 *  1. **GUI/config facts** — pull `gui.*` and `config.*` assignments out of
 *     `gui.rpy` / `options.rpy` (the standard Ren'Py GUI variables, as
 *     documented in the GUI Customization Guide). Statement-level regexes over
 *     comment-stripped text are enough here and stay cheap on a big `game/`
 *     directory.
 *  2. **Transform table** — read top-level `transform <name>:` blocks so the
 *     stage parser can resolve `at my_slide` to real `xpos`/`zoom` values.
 *
 * Display-statement token rules (image components, `at` lists, attribute
 * order) live in `stage.js`, aligned node-by-node with the official
 * `renpy/lexer.py` grammar. Nothing here tries to understand labels,
 * dialogue, or Python.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Image extensions Ren'Py treats as displayable assets. */
export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".bmp",
  ".tga",
  ".svg",
]);

/** Names carrying `bg`/`background` semantics rather than a character tag. */
export const BACKGROUND_PREFIXES = new Set(["bg", "background", "scene"]);

/**
 * Audio extensions the asset index treats as playable.
 *
 * Ren'Py itself accepts these through `renpy.loadable`, so a playlist built
 * from a directory listing must accept the same set or a game whose music is
 * `.opus` would show an empty list.
 */
export const AUDIO_EXTENSIONS = new Set([".ogg", ".opus", ".mp3", ".wav", ".m4a", ".flac", ".aac"]);

/**
 * Video extensions a splash screen can actually be played from.
 *
 * `.webm` is the only container Ren'Py ships a decoder for out of the box, but
 * games do ship `.mp4` and `.ogv`, and the browser half is what plays it — so
 * the index accepts everything a `<video>` element can plausibly render.
 */
export const VIDEO_EXTENSIONS = new Set([".webm", ".mp4", ".ogv", ".avi", ".mkv", ".mov"]);

/**
 * Font extensions the skin can serve to `@font-face`.
 *
 * `gui.text_font` names a real file inside the game, and the whole point of
 * reading it is to hand the browser the game's own typeface — so fonts are
 * indexed alongside the displayables even though Ren'Py never draws one.
 */
export const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".woff", ".woff2"]);

/**
 * Remove `#` comments while leaving strings intact, so a `#` inside a quoted
 * path or colour literal does not truncate the line. Ren'Py comments run to
 * end of line and do not nest.
 * @param source raw `.rpy` text.
 * @returns the same text with comments blanked to spaces.
 */
export function stripComments(source) {
  let out = "";
  let quote = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < source.length) out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Interpret one Ren'Py literal/expression from an assignment right-hand side.
 * Supports the forms the GUI files actually use: quoted strings (with `u` and
 * `_()` wrappers), numbers, booleans, `None`, tuples, colour hex strings, and
 * references to another known name (e.g. `gui.text_font`) or a `Borders(...)` /
 * `Color(...)` style call, which is resolved structurally rather than
 * evaluated.
 *
 * @param raw right-hand side text.
 * @param names already-resolved values, for `gui.x = gui.y` references.
 * @returns the value, or `undefined` when the expression is not understood.
 */
export function evalValue(raw, names = new Map()) {
  // A leading comma appears when the caller passes an unparsed argument list
  // (e.g. a `image name = , filename` style declaration), so drop it.
  const text = raw.trim().replace(/^,\s*/, "").trim();
  if (text.length === 0) return undefined;

  const translated = /^_\(\s*(.*?)\s*\)$/s.exec(text);
  if (translated !== null) return evalValue(translated[1], names);

  if (/^[uUrRbB]{0,2}["']/.test(text)) {
    const quoted = /^[uUrRbB]{0,2}(["'])((?:\\.|(?!\1)[\s\S])*)\1$/.exec(text);
    // The `$` anchor plus the no-unescaped-quote body is what rejects a
    // concatenation (`"a" + "b"`): the reader must not silently return the
    // mangled inner text of an expression it cannot evaluate.
    if (quoted !== null) return quoted[2].replace(/\\(["'\\])/g, "$1");
    return undefined;
  }

  if (text === "True") return true;
  if (text === "False") return false;
  if (text === "None") return null;

  if (/^[-+]?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(text)) return Number.parseFloat(text);

  const tuple = /^\((.*)\)$/s.exec(text);
  if (tuple !== null) {
    const inner = tuple[1].trim();
    if (inner.length === 0) return [];
    return splitTopLevel(inner).map((part) => evalValue(part, names));
  }

  const borders = /^Borders\(\s*([^)]*)\)$/.exec(text);
  if (borders !== null) {
    const parts = borders[1]
      .split(",")
      .map((part) => evalValue(part, names))
      .filter((value) => typeof value === "number");
    if (parts.length === 4) return { left: parts[0], top: parts[1], right: parts[2], bottom: parts[3] };
    if (parts.length === 2) return { left: parts[0], top: parts[1], right: parts[0], bottom: parts[1] };
    return undefined;
  }

  if (names.has(text)) return names.get(text);

  const fn = /^([A-Za-z_]\w*)\((.*)\)$/s.exec(text);
  if (fn !== null) {
    const args = [];
    const kwargs = {};
    for (const part of splitTopLevel(fn[2])) {
      // A keyword argument used to fall through every branch above and come
      // back as `undefined`, so `Character('启诚', color="#624B34", image="qc")`
      // lost both the colour and the sprite tag: nobody could read them at all.
      // `args` keeps its old slot-for-slot content (`undefined` for a keyword),
      // so the only change existing callers can observe is the added field.
      args.push(evalValue(part, names));
      const keyword = /^([A-Za-z_]\w*)[ \t]*=(?!=)[ \t]*([\s\S]*)$/.exec(part);
      if (keyword !== null) kwargs[keyword[1]] = evalValue(keyword[2].trim(), names);
    }
    return { call: fn[1], args, kwargs };
  }

  return undefined;
}

/**
 * Split a comma-separated argument list at top level, respecting nested
 * brackets and quotes.
 * @param text the argument list text.
 * @returns the individual argument texts.
 */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0 || parts.length > 0) parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Collect every `gui.*` / `config.*` assignment in one file.
 *
 * A `renpy.variant("small")` block re-defines the whole GUI for phones, and it
 * comes LAST in `gui.rpy` — so a flat scan handed the desktop shell the phone
 * metrics (a 470px say window, 43px text, `dialogue_xpos` 245 instead of 402,
 * and a phone-size choice button). Those values are kept, but only for keys the
 * file never assigns outside such a block, which also keeps a mobile-first game
 * readable.
 *
 * @param source raw `.rpy` text.
 * @returns a `Map` of dotted name to resolved value.
 */
export function readAssignments(source) {
  const plain = new Map();
  const guarded = new Map();
  const text = stripComments(source);
  const assignment =
    /^[ \t]*(?:define|default)?[ \t]*((?:gui|config|preferences|store)\.[A-Za-z_]\w*)[ \t]*=[ \t]*(.+?)[ \t]*$/;
  const variantGuard = /^[ \t]*if[ \t]+.*renpy\.variant[ \t]*\(/;
  // SharedHouse writes its phone layout as `@gui.variant` above `def small():`,
  // which is the same variant guard in a different spelling. Without this the
  // phone's 400px textbox and 245px dialogue_xpos became the desktop values.
  const variantDecorator = /^[ \t]*@(?:gui\.|renpy\.)?variant[ \t]*$/;
  let afterVariantDecorator = false;
  /** Open indentation blocks: their column, and whether a variant guard encloses them. */
  const blocks = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    while (blocks.length > 0 && indent <= blocks[blocks.length - 1].indent) blocks.pop();
    const guardedNow = blocks.length > 0 && blocks[blocks.length - 1].guarded === true;
    const isVariantDef = afterVariantDecorator && /^[ \t]*def\b/.test(line);
    afterVariantDecorator = variantDecorator.test(line);
    // A colon-terminated statement opens a block. Only a variant guard changes
    // how the block's body is treated; `init python:` and friends do not.
    if (/:[ \t]*$/.test(line)) {
      blocks.push({ indent, guarded: guardedNow || variantGuard.test(line) || isVariantDef });
    }
    const match = assignment.exec(line);
    if (match === null) continue;
    const right = match[2].trim();
    // A multi-line expression is not a value this parser claims to read.
    if (right.endsWith("\\") || right.endsWith("(") || right.endsWith("[")) continue;
    const value = evalValue(right, guardedNow ? guarded : plain);
    if (value === undefined) continue;
    (guardedNow ? guarded : plain).set(match[1], value);
  }
  for (const [key, value] of guarded) if (!plain.has(key)) plain.set(key, value);
  return plain;
}

/**
 * Read the top-level `style <name>:` blocks, keeping each property as the raw
 * text the game wrote.
 *
 * A game often positions its say window in a style rather than a `gui.*`
 * variable (`style window: ysize 300`), and the style is what the engine
 * actually paints with. Values are returned unevaluated so the caller decides
 * what a `gui.*` reference resolves to; `resolveStyleNumber` does the common
 * case. Only column-0 headers are read, which matches how Ren'Py's own
 * `00style.rpy` and the game's `screens.rpy` are written.
 *
 * @param source raw `.rpy` text.
 * @returns `Map` of style name to `Map` of property to raw value. A later block
 *   for the same style overwrites earlier properties, as Ren'Py does.
 */
const MOBILE_VARIANT = /small|touch|mobile|android|ios|tablet|phone/i;

export function readStyleBlocks(source) {
  const styles = new Map();
  const lines = stripComments(source).split(/\r?\n/);
  const header = /^style[ \t]+([A-Za-z_]\w*)(?:[ \t]+is[ \t]+[A-Za-z_]\w*)?[ \t]*:[ \t]*$/;
  const property = /^[ \t]+([a-z_]\w*)[ \t]+(.+?)[ \t]*$/;
  for (let i = 0; i < lines.length; i++) {
    const head = header.exec(lines[i]);
    if (head === null) continue;
    const props = styles.get(head[1]) ?? new Map();
    const block = new Map();
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim().length === 0) continue;
      if (line.length === line.trimStart().length) break;
      const match = property.exec(line);
      if (match !== null) block.set(match[1], match[2]);
    }
    // A `variant "small"` block restates the style for phones. Applying it
    // would let the touch layout's values (and its `gui/phone/textbox.png`)
    // replace the desktop ones, because it nearly always comes later in the file.
    if (!MOBILE_VARIANT.test(block.get("variant") ?? "")) {
      for (const [name, value] of block) props.set(name, value);
    }
    styles.set(head[1], props);
    i = j - 1;
  }
  return styles;
}

/**
 * Resolve a raw style value to a number: a literal, or a `gui.*` / `config.*`
 * name the caller already resolved. Anything else (an expression the reader does
 * not evaluate) is `undefined`, so the caller keeps its own fallback.
 *
 * @param raw raw property text from `readStyleBlocks`.
 * @param names resolved `gui.*` / `config.*` values.
 */
export function resolveStyleNumber(raw, names) {
  if (typeof raw !== "string") return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(raw.trim())) return Number(raw);
  if (/^(?:gui|config)\.\w+$/.test(raw.trim())) {
    const value = names.get(raw.trim());
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}

/**
 * Index of the last line in `lines` that is indented deeper than `indent`,
 * starting at `start`. Blank lines inside the body are skipped; the first
 * non-blank line at or above `indent` ends the block.
 * @param lines the whole file split into lines.
 * @param start index of the first candidate line.
 * @param indent column the body must stay deeper than.
 */
function blockEnd(lines, start, indent) {
  // `start - 1` is the correct answer for an empty body: the caller's
  // `for (k = start; k <= end; ...)` must then run zero times instead of
  // reading the next statement as if it were a child.
  let end = start - 1;
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].trim().length === 0) continue;
    if (indentOf(lines[i]) <= indent) break;
    end = i;
  }
  return end;
}

/** Leading whitespace width of one line. Tabs count as one column, which is
 *  consistent between a header and its children as long as the file uses one
 *  of the two, and that is all the block walk needs. */
function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

/** Screen statements whose own geometry a skin wants. Every one of these is
 *  reported as an `adds` entry; other containers (`hbox`, `if`) only act as
 *  ancestors, because a skin never reads their position, only what they wrap.
 *
 *  `textbutton` and `imagebutton` are here for the quick menu: a button carries
 *  its own `action` and its label, and a skin that cannot see the entry can
 *  only guess that the screen has buttons at all. They are displayables in
 *  Ren'Py, so a nested `text` inside one still gets its own entry as before. */
const SCREEN_DISPLAYABLE = new Set([
  "add", "background", "frame", "window", "text", "textbutton", "imagebutton",
]);

/** Whether a line is a statement rather than a `key value` property.
 *
 *  The first word is the only discriminator available without a real grammar:
 *  `pos (265, 798)` and `text who:` are both `word something`, so the keyword
 *  list decides. Without this, a frame's `background` would be read as a
 *  property of the screen and a nested `text`'s `pos` as a property of its
 *  parent frame, which silently moves the name box to the wrong place. */
function isStatementLine(line) {
  const first = /^[A-Za-z_]\w*/.exec(line.trim());
  return first !== null && SCREEN_KEYWORDS.has(first[0]);
}

/**
 * Statements that are not properties.
 *
 * A screen body interleaves `key value` properties with statements, and
 * `use navigation` is indistinguishable from one by shape alone. Left
 * unfiltered it arrives as `properties.get("use")`, so a caller reading `tag`
 * and `style` also gets nonsense it has to know to ignore.
 */
const SCREEN_KEYWORDS = new Set([
  "add", "background", "bar", "button", "call", "default", "elif", "else",
  "fixed", "for", "frame", "grid", "has", "hbox", "hide", "if", "image",
  "imagebutton", "init", "key", "label", "layeredimage", "nvl", "on", "python",
  "return", "screen", "show", "side", "style", "text", "textbutton",
  "timer", "transform", "translate", "use", "vbox", "viewport", "while",
  "window", "with",
]);

/** Index of the first `:` outside a string or a bracket, or -1. `add
 *  'a:b.png'` and `pos (1, 2)` must not be taken for block openers. */
function topLevelColon(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

/** Whether the line opens an indentation block (`frame:`, `if x:`, `hbox:`). */
function isBlockLine(line) {
  const text = line.trim();
  return text.endsWith(":") && topLevelColon(text) === text.length - 1;
}

/** Split one statement into whitespace-separated tokens, keeping quoted and
 *  bracketed runs together so `align=(0.5, 1.0)` stays a single token. */
function tokenizeStatement(text) {
  const tokens = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Displayable clause keywords.
 *
 * `add 'textbox.png' with align=(0.5, 1.0)` puts a clause after the displayable,
 * and pairing tokens right to left would otherwise read `with align=(0.5, 1.0)`
 * as a property named `with`. These words introduce a clause, never a property.
 */
const SCREEN_CLAUSE = new Set(["with", "at", "as", "behind", "zorder", "onlayer"]);

/** Read the `key value` properties of a statement written on one line.
 *
 *  Properties come last, so the tokens are paired from the right: that leaves
 *  `who` in `text who color '#624B34'` as the leading expression instead of
 *  mistaking it for a property name and shifting every pair by one. */
function inlineProperties(text) {
  const tokens = tokenizeStatement(text);
  const pairs = [];
  let end = tokens.length - 1;
  while (
    end >= 1 &&
    /^[A-Za-z_]\w*$/.test(tokens[end - 1]) &&
    !SCREEN_CLAUSE.has(tokens[end - 1])
  ) {
    pairs.push([tokens[end - 1], tokens[end]]);
    end -= 2;
  }
  const properties = new Map();
  // Written left to right so a repeated property keeps its last spelling, which
  // is the one Ren'Py would use.
  for (let i = pairs.length - 1; i >= 0; i -= 1) properties.set(pairs[i][0], pairs[i][1]);
  // `align=(0.5, 1.0)` is a keyword argument rather than a `key value` pair.
  // Exposing it on its own keeps the caller from having to re-parse `raw`.
  for (const token of tokens) {
    const keyword = /^([A-Za-z_]\w*)=([\s\S]+)$/.exec(token);
    if (keyword !== null) properties.set(keyword[1], keyword[2]);
  }
  return properties;
}

/** Read one `key value` line, including the `key (a, b)` spelling. */
function readPropertyLine(line) {
  const text = line.trim();
  const attached = /^([A-Za-z_]\w*)[ \t]*(\([^)]*\))$/.exec(text);
  if (attached !== null) return { key: attached[1], value: attached[2] };
  const spaced = /^([A-Za-z_]\w*)[ \t]+([\s\S]+)$/.exec(text);
  if (spaced !== null) return { key: spaced[1], value: spaced[2].trim() };
  return null;
}

/** Strip the quotes around a variant name if the game wrote any. */
function variantName(raw) {
  return typeof raw === "string" ? raw.trim().replace(/^["']|["']$/g, "") : null;
}

/**
 * Collect the screen statements a skin reads geometry from, at any depth, and
 * record which containers each one sits inside.
 *
 * Depth matters: the name box lives in `frame:` inside `if who is not None:`,
 * so reading only the direct children of the screen would drop exactly the
 * geometry this reader exists for. Entries stay flat because the caller looks
 * them up by kind, not by position.
 *
 * The ancestor chain is what makes a `pos` interpretable. In `screen say`,
 * `text what: pos (335, 905)` is a canvas coordinate, while the same `pos`
 * inside `frame: pos (265, 798)` is relative to that frame — and the frame's own
 * `pos` is what locates the name box. Both look like an ordinary pair of
 * numbers, so a caller that cannot tell the two apart attributes the name box
 * position to the dialogue window and nothing anywhere reports an error.
 * `ancestors` therefore lists the containers from the outermost to the direct
 * parent, each with its own `kind` / `raw` / `properties` and none of its
 * children's, and `depth` is its length kept in the same object so the two can
 * never drift apart.
 *
 * @param depth recursion guard; the count of containers enclosing this body.
 *   Line indices only ever increase, so the walk terminates on its own, but an
 *   indentation cycle in a hand-edited file must not spin forever.
 * @param ancestors containers enclosing this body, outermost first.
 */
function walkScreenBody(lines, from, to, parentIndent, adds, depth, ancestors) {
  if (depth > 64) return;
  for (let k = from; k <= to; k += 1) {
    const line = lines[k];
    if (line.trim().length === 0) continue;
    const column = indentOf(line);
    if (column <= parentIndent) continue;
    const text = line.trim();
    const leading = /^([A-Za-z_]\w*)/.exec(text);
    const kind = leading === null ? null : leading[0];
    const displayable = kind !== null && SCREEN_DISPLAYABLE.has(kind);
    if (!displayable) {
      // `hbox:` and `if who:` scope displayables the skin needs, so their bodies
      // are walked as well instead of being skipped as unknown syntax. They are
      // containers for the entries below them even though they never get an
      // entry of their own.
      if (isBlockLine(line)) {
        const inner = blockEnd(lines, k + 1, column);
        const container = containerEntry(
          text, kind, column, lines, k + 1, inner, depth, ancestors,
        );
        walkScreenBody(lines, k + 1, inner, column, adds, depth + 1, [...ancestors, container]);
        k = inner;
      }
      continue;
    }
    let rest = text.slice(kind.length).trim();
    let inline = null;
    let block = false;
    const colon = topLevelColon(rest);
    if (colon >= 0) {
      block = true;
      inline = rest.slice(colon + 1).trim();
      rest = rest.slice(0, colon).trim();
      if (inline.length === 0) inline = null;
    }
    const end = block ? blockEnd(lines, k + 1, column) : k;
    const properties = new Map();
    // A one-line statement carries its own properties, e.g. `frame: pos (265,
    // 798)` or `text who color '#624B34'`, so they are read from the same line
    // and not only from the children.
    const inlineText = inline ?? (block ? "" : rest);
    for (const [key, value] of inlineProperties(inlineText)) properties.set(key, value);
    // `background` is collected as its own entry below, but inside a frame it
    // also names the name box image, which is what the caller reads the frame
    // for — so it stays on this entry too. Every other nested statement is left
    // to its own entry and must not leak its `pos` up here.
    directProperties(lines, k + 1, end, column, properties);
    for (let m = k + 1; m <= end; m += 1) {
      const child = lines[m];
      if (child.trim().length === 0) continue;
      if (indentOf(child) <= column) break;
      if (!/^background\b/.test(child.trim())) continue;
      const property = readPropertyLine(child.trim());
      if (property !== null) properties.set(property.key, property.value);
    }
    // `raw` is what the game wrote after the keyword: the displayable text, or
    // the properties after the colon when the statement is written on one line.
    // With no displayable and no inline properties (`frame:` with a body) the
    // caller has no text to read, so the empty string is the honest answer.
    const raw = rest.length > 0 ? rest : inlineText ?? "";
    const entry = { kind, raw, properties, depth, ancestors };
    // Pushed before its body is walked so the entry order stays the order the
    // game wrote: a parent appears above its children, as in the source.
    adds.push(entry);
    if (block) {
      walkScreenBody(lines, k + 1, end, column, adds, depth + 1, [...ancestors, entry]);
    }
    k = end;
  }
}

/** Read the `key value` lines that belong to a block itself, skipping anything
 *  written deeper.
 *
 *  The indent of the first child sets the block's own level; lines below it
 *  belong to a nested statement, and letting them through would make a `frame`
 *  inherit its `text`'s `pos` and a screen report the properties of the `text
 *  what` block as its own. Both look like ordinary values, so the mistake only
 *  shows up as dialogue geometry that is subtly off.
 *
 *  @param parentIndent column the block header sits at.
 *  @returns a Map of property name to raw value.
 */
function directProperties(lines, from, to, parentIndent, properties = new Map()) {
  let ownIndent = -1;
  for (let m = from; m <= to; m += 1) {
    const line = lines[m];
    if (line.trim().length === 0) continue;
    const column = indentOf(line);
    if (column <= parentIndent) continue;
    ownIndent = column;
    break;
  }
  if (ownIndent < 0) return properties;
  for (let m = from; m <= to; m += 1) {
    const line = lines[m];
    if (line.trim().length === 0) continue;
    if (indentOf(line) !== ownIndent) continue;
    if (isStatementLine(line) || isBlockLine(line)) continue;
    const property = readPropertyLine(line);
    if (property !== null) properties.set(property.key, property.value);
  }
  return properties;
}

/** Build the ancestor record for a container that is not itself an entry.
 *
 *  Only the container's own `key value` lines are collected: a nested statement
 *  belongs to that statement's entry, and copying it here would make the parent
 *  claim the child's `pos` — the exact confusion `ancestors` exists to prevent.
 *
 *  The record carries the same informative keys as an `adds` entry (`depth` and
 *  `ancestors` included) so a caller can walk a chain and read positions
 *  uniformly, without special-casing the last element. `depth` is the depth of
 *  the entries this container encloses, i.e. its own index in their chain. */
function containerEntry(text, kind, column, lines, from, to, depth, ancestors) {
  const rest = text.slice(kind.length).trim();
  const properties = new Map();
  let inline = null;
  const colon = topLevelColon(rest);
  if (colon >= 0) {
    inline = rest.slice(colon + 1).trim();
    if (inline.length === 0) inline = null;
  }
  if (inline !== null) {
    for (const [key, value] of inlineProperties(inline)) properties.set(key, value);
  }
  directProperties(lines, from, to, column, properties);
  const head = colon >= 0 ? rest.slice(0, colon).trim() : rest;
  return {
    kind,
    raw: head.length > 0 ? head : inline ?? "",
    properties,
    depth,
    ancestors,
  };
}

/**
 * Read the top-level `screen <name>:` bodies, keeping each property as the raw
 * text the game wrote.
 *
 * A commercial game routinely replaces the template's say screen outright and
 * writes the dialogue geometry inline (`text what: pos (335, 905)`, `size 30`,
 * `color '#624B34'`). Those values are painted by the engine and `style` blocks
 * for them are dead code, so without this reader every dialogue metric quietly
 * falls back to a guessed default.
 *
 * Nothing is evaluated — the caller decides what a value means — and nesting is
 * handled by indentation, because the container statements (`frame:`, `hbox:`)
 * are what a regex over lines cannot follow. Both spellings of a statement are
 * read: `text what:` with its properties on the lines below, and the one-line
 * `frame: pos (265, 798)` whose properties sit after the colon.
 *
 * A screen redefined for phones (`variant "small"` inside the body, in the
 * header, or the `@variant` decorator above it) is skipped, exactly as
 * `readStyleBlocks` skips variant styles: it is written last and would
 * otherwise replace the desktop geometry with the touch layout's.
 *
 * @param source raw `.rpy` text.
 * @returns `Map` of screen name to `{ properties, adds, hasVariant }`, where
 *   each `add` is `{ kind, raw, properties, depth, ancestors }` — `depth` and
 *   `ancestors` are always present, and `[].length === depth`. `hasVariant` is
 *   set only when the winning definition carried a variant name. A later
 *   definition for the same name replaces the earlier one, as Ren'Py does.
 */
export function readScreenBlocks(source) {
  const screens = new Map();
  const lines = stripComments(String(source ?? "")).split(/\r?\n/);
  // The header may carry its variant inline: `screen say(who, what) variant
  // "small":`, which is one of the spellings a game uses for its phone layout.
  const header = /^([ \t]*)screen[ \t]+([A-Za-z_]\w*)[ \t]*(?:\([^)]*\))?[ \t]*([^:]*):[ \t]*$/;
  const headerVariant = /variant[ \t]*\(?[ \t]*["']?([^"')]+)/;
  const variantDecorator = /^[ \t]*@(?:gui\.|renpy\.)?variant\b[ \t]*[({]?[ \t]*["']?([^"'),}]*)["']?[ \t]*[)}]?[ \t]*$/;

  // A decorator line owns the next non-blank line, which is its screen header.
  let decoratorVariant = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const decorated = variantDecorator.exec(line);
    if (decorated !== null) {
      decoratorVariant = decorated[1].trim().length > 0 ? decorated[1].trim() : null;
      continue;
    }
    const head = header.exec(line);
    if (head === null) {
      // The decorator applies to the next statement only; anything else clears it.
      decoratorVariant = null;
      continue;
    }
    const indent = indentOf(line);
    const end = blockEnd(lines, i + 1, indent);
    // The screen's own `key value` lines only: a nested `text what` block's
    // `pos` and `size` must stay with that text, or the screen reports the
    // dialogue geometry as if it were a screen-wide default.
    const properties = directProperties(lines, i + 1, end, indent);
    const adds = [];
    walkScreenBody(lines, i + 1, end, indent, adds, 0, []);

    let declared = decoratorVariant;
    if (declared === null) {
      const form = headerVariant.exec(head[3].trim());
      if (form !== null) declared = form[1].trim();
      else if (properties.has("variant")) declared = variantName(properties.get("variant"));
    }
    decoratorVariant = null;
    if (declared !== null && MOBILE_VARIANT.test(declared)) {
      // Skipped, not merged: the phone layout restates the same screen last and
      // its 470px textbox would otherwise become the desktop one.
      i = end;
      continue;
    }

    const info = { properties, adds };
    if (declared !== null) info.hasVariant = declared;
    // Last definition wins, which is how Ren'Py orders screens.
    screens.set(head[2], info);
    i = end;
  }
  return screens;
}

/**
 * Read `define x = Character(...)` (and `default`, and the `DynamicCharacter`
 * / `Character`-like variants) into a per-variable table.
 *
 * `readAssignments` only collects `gui.*` / `config.*` / `preferences.*` /
 * `store.*` names, so a character declaration never reached any consumer at
 * all — a game with six characters reported zero, and the name box could only
 * ever show the sprite tag. The display name, the name colour and the `image=`
 * tag cannot be recovered from anywhere else.
 *
 * Only the three fields the skin can use are resolved; every other keyword
 * argument is ignored rather than guessed at. Unreadable parts are `null`, and
 * a declaration this reader cannot follow is left out — never invented.
 *
 * @param source raw `.rpy` text, or an array of `{ text }` sources.
 * @returns `Map` of variable name to `{ name, color, image, kind }`.
 */
export function readCharacterDeclarations(source) {
  const characters = new Map();
  const sources = Array.isArray(source) ? source : [source];
  for (const entry of sources) {
    const text = stripComments(String(entry?.text ?? entry ?? ""));
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const head = /^[ \t]*(?:define|default)[ \t]+([A-Za-z_]\w*)[ \t]*=[ \t]*([A-Za-z_]\w*)[ \t]*\(/.exec(lines[i]);
      if (head === null) continue;
      // The declaration owns its following lines while its brackets are open,
      // which is how a game wraps a long keyword list (`callback=...` last, with
      // a trailing comma). Consuming them here also keeps a stale `define`
      // inside the wrapped argument list from being read as its own declaration.
      let expression = lines[i].slice(lines[i].indexOf("=") + 1).trim();
      let last = i;
      while (last + 1 < lines.length && !balanced(expression)) {
        last += 1;
        expression += ` ${lines[last].trim()}`;
      }
      i = last;
      const call = /^([A-Za-z_]\w*)[ \t]*\(([\s\S]*)\)$/.exec(expression.trim());
      if (call === null) continue;
      // Only the engine's own character constructors. Every one of them ends in
      // `Character` (`Character`, `DynamicCharacter`, `ADynamicCharacter`,
      // `NVLCharacter`), while an unrelated `default x = SomeValue(...)` inside a
      // screen body — `default page_name_value = FilePageNameInputValue(...)` sits
      // in every template's save/load screen — would otherwise become a cast
      // member with three nulls, inflating the cast count and offering the model
      // a speaker that does not exist.
      if (!/character$/i.test(call[1])) continue;
      const info = { name: null, color: null, image: null, kind: call[1].toLowerCase() };
      for (const part of splitTopLevel(call[2])) {
        // `color="#624B34"` and `image="qc"` are keyword arguments; the display
        // name is the first bare one, so a keyword must not be mistaken for it.
        const keyword = /^([A-Za-z_]\w*)[ \t]*=(?!=)[ \t]*([\s\S]*)$/.exec(part);
        if (keyword !== null) {
          if (keyword[1] !== "color" && keyword[1] !== "image") continue;
          // A named colour (`color=ACCENT`) is kept verbatim: only the caller
          // knows whether that name resolves, and dropping it would hide a real
          // declaration behind a `null`.
          const value = evalValue(keyword[2], new Map());
          info[keyword[1]] = typeof value === "string" ? value : keyword[2].trim();
          continue;
        }
        // `_()`-wrapped names go through `evalValue` so the translation marker
        // is unwrapped the same way it is for every other quoted value.
        if (info.name === null) {
          const value = evalValue(part, new Map());
          if (typeof value === "string") info.name = value;
        }
      }
      characters.set(head[1], info);
    }
  }
  return characters;
}

/** Whether brackets and quotes are balanced at the end of `expression`. */
function balanced(expression) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
  }
  return depth <= 0 && quote === null;
}

/**
 * The path a style's `background Image("...")` or `Frame("...")` names, or
 * `undefined` when the background is not one of those calls.
 *
 * @param raw raw property text from `readStyleBlocks`.
 */
export function styleBackgroundPath(raw) {
  if (typeof raw !== "string") return undefined;
  // A bare string (`background "gui/textbox.png"`) and any wrapper around one
  // (`Frame(...)`, `Image(...)`, `Transform(...)`) name their picture the same
  // way: the first quoted image path in the expression.
  const match = /["']([^"']+\.(?:png|webp|jpe?g|gif|avif))["']/i.exec(raw.trim());
  return match === null ? undefined : match[1];
}

/**
 * Where an `Image(...)` background sits inside its window: the `xalign` /
 * `yalign` keyword arguments, or 0.5 and 1.0 (the template's own) when
 * unstated. A `Frame` stretches to the window and has no alignment.
 *
 * @param raw raw property text from `readStyleBlocks`.
 */
export function styleBackgroundAlign(raw) {
  if (typeof raw !== "string" || !/^Image\(/.test(raw.trim())) return { x: 0.5, y: 1 };
  const read = (name, fallback) => {
    const match = new RegExp(`\\b${name}\\s*=\\s*(-?\\d*\\.?\\d+)`).exec(raw);
    return match === null ? fallback : Number(match[1]);
  };
  return { x: read("xalign", 0.5), y: read("yalign", 1) };
}

/**
 * Read the top-level `transform <name>:` table.
 *
 * Only indentation-scoped `transform` blocks are read, and only the ATL
 * properties the stage understands; chained ATL (`block:`, `choice:`,
 * `repeat`) is reported by presence so the stage can say it ignored it rather
 * than silently pretending the transform was simple.
 *
 * @param source raw `.rpy` text.
 * @returns `Map` of transform name to `{ props, atl }`.
 */
export function readTransforms(source) {
  const transforms = new Map();
  const text = stripComments(source);
  const lines = text.split(/\r?\n/);
  const header = /^transform[ \t]+([A-Za-z_]\w*)[ \t]*(?:\(([^)]*)\))?[ \t]*:[ \t]*$/;
  const property = /^[ \t]+([A-Za-z_]\w*)[ \t]+(.+?)[ \t]*$/;

  for (let i = 0; i < lines.length; i += 1) {
    const match = header.exec(lines[i]);
    if (match === null) continue;
    const props = Object.create(null);
    const atl = new Set();
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim().length === 0) continue;
      if (!/^[ \t]/.test(line)) break;
      const prop = property.exec(line);
      if (prop === null) continue;
      const name = prop[1];
      if (name === "block" || name === "choice" || name === "repeat" || name === "parallel") {
        atl.add(name);
        continue;
      }
      const value = evalValue(prop[2], new Map());
      if (value !== undefined) props[name] = value;
    }
    transforms.set(match[1], { props, atl: [...atl] });
  }
  return transforms;
}

/**
 * Read top-level `layeredimage <name>:` blocks.
 *
 * A layeredimage is a character drawn as a stack of per-group layers (body /
 * face / hand / glasses …). Each `group <g>:` holds `attribute <a>` lines;
 * one attribute per group is the default, and `default null` marks a default
 * that draws no layer at all. The engine builds each layer's filename as
 * `<name>_<group>_<attribute>`, so the parser records only names and leaves
 * path resolution to the manifest, which owns the asset index.
 *
 * Block-level ATL properties (`zoom 0.36`, `xcenter 0.5`, `yalign 1.0`) are
 * captured as numeric `atl` values — the block's own display defaults, which
 * the stage uses as the base transform for a bare `show <tag>`.
 *
 * @param source raw `.rpy` text.
 * @returns `Map` of tag to `{ groups, atl }`, where each group is
 *   `{ name, attributes: [{ name, default, defaultNull }] }`.
 */
export function readLayeredImages(source) {
  const layered = new Map();
  const text = stripComments(source);
  const lines = text.split(/\r?\n/);
  const header = /^layeredimage[ \t]+([A-Za-z_]\w*)[ \t]*:[ \t]*$/;
  const groupHeader = /^[ \t]+group[ \t]+([A-Za-z_]\w*)[ \t]*:[ \t]*$/;
  const attributeLine = /^[ \t]+attribute[ \t]+([A-Za-z_]\w*)([ \t].*)?$/;
  const atlProp = /^[ \t]+([A-Za-z_]\w*)[ \t]+(.+?)[ \t]*$/;

  for (let i = 0; i < lines.length; i += 1) {
    const match = header.exec(lines[i]);
    if (match === null) continue;
    const tag = match[1];
    const info = { groups: [], atl: {} };
    let currentGroup = null;
    const ensureGroup = () => {
      if (currentGroup === null) {
        // A `layeredimage` without an explicit `group:` still has the one
        // implicit default group; give it an empty name so filename joining
        // does not invent a separator.
        currentGroup = { name: "", attributes: [] };
        info.groups.push(currentGroup);
      }
      return currentGroup;
    };

    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim().length === 0) continue;
      if (!/^[ \t]/.test(line)) break;

      const groupMatch = groupHeader.exec(line);
      if (groupMatch !== null) {
        currentGroup = { name: groupMatch[1], attributes: [] };
        info.groups.push(currentGroup);
        continue;
      }
      const attributeMatch = attributeLine.exec(line);
      if (attributeMatch !== null) {
        const rest = attributeMatch[2] === undefined ? "" : attributeMatch[2];
        ensureGroup().attributes.push({
          name: attributeMatch[1],
          // `default` (with or without `null`) both mark the group default;
          // `defaultNull` says that default state draws no layer.
          default: /\bdefault\b/.test(rest),
          defaultNull: /\bdefault\s+null\b/.test(rest),
        });
        continue;
      }
      const prop = atlProp.exec(line);
      if (prop !== null) {
        const value = evalValue(prop[2], new Map());
        if (typeof value === "number") info.atl[prop[1]] = value;
      }
    }
    layered.set(tag, info);
  }
  return layered;
}

/**
 * List files under a directory, shallowest first, skipping the directories a
 * Ren'Py game never stores displayables in.
 * @param root directory to walk.
 * @param options.signal cooperative cancellation.
 * @param options.limit hard cap on visited files.
 * @param options.report optional object; `report.truncated` is set to `true`
 *   when a file was left unlisted because `limit` was reached. Without it a
 *   huge game would silently lose resources past the cap.
 * @returns absolute file paths.
 */
export function listFiles(root, { signal, limit = 20000, report } = {}) {
  const out = [];
  const skip = new Set(["cache", "saves", "tl", "__pycache__", ".git", "renpy"]);
  const walk = (dir) => {
    if (out.length >= limit || signal?.aborted === true) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (signal?.aborted === true) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (out.length >= limit) {
          if (report !== undefined) report.truncated = true;
          return;
        }
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Read a text file, returning `undefined` instead of throwing.
 * @param path file path.
 * @returns the file text, or `undefined` when unreadable.
 */
export function readTextIfPresent(path) {
  try {
    if (!statSync(path).isFile()) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Locate the script files the manifest cares about, preferring the main
 * `game/` level over translation copies.
 * @param gameDir the game directory.
 * @returns `{ gui, options, screens, transforms }` paths when present.
 */
export function findScripts(gameDir) {
  let names = [];
  try {
    names = readdirSync(gameDir);
  } catch {
    return {};
  }
  const pick = (name) => {
    const lower = names.find((candidate) => candidate.toLowerCase() === name);
    return lower === undefined ? undefined : join(gameDir, lower);
  };
  return {
    gui: pick("gui.rpy"),
    options: pick("options.rpy"),
    screens: pick("screens.rpy"),
  };
}

/**
 * Human-readable identity of a game directory for logs and manifests.
 * @param gameDir the game directory.
 * @param root the game root passed by the user.
 */
export function describePath(gameDir, root) {
  try {
    return relative(root, gameDir) === "" ? "." : relative(root, gameDir);
  } catch {
    return gameDir;
  }
}

// ── audio / splash extraction ───────────────────────────────────────────────
//
// Everything below exists because Ren'Py games address their music and their
// opening by *Python name*, not by path: `play music audio.gotosnowtown` and
// `config.main_menu_music = main_menu_music()`. Neither is a displayable, so
// the image pipeline never sees them. These readers recover the file paths
// statically; nothing here calls out to any service.

/**
 * Collect the *unevaluated* right-hand side of every `config.*` assignment.
 *
 * `readAssignments` resolves as it reads, which loses the distinction this
 * reader needs: `config.main_menu_music = main_menu_music()` comes back as an
 * opaque `{ call, args }` marker, while `= "audio/x.ogg"` comes back as the
 * bare path with its quotes already stripped — and a bare path is no longer a
 * string literal `evalValue` will recognise. Keeping the raw text lets
 * `resolveMenuMusic` see both forms as the game wrote them.
 *
 * @param sources script sources.
 * @returns `Map` of dotted name to the raw, trimmed right-hand side.
 */
export function readAssignmentExpressions(sources) {
  const expressions = new Map();
  for (const source of sources) {
    const text = stripComments(String(source?.text ?? ""));
    for (const match of text.matchAll(
      /^[ \t]*(?:define|default)?[ \t]*((?:gui|config|preferences|store)\.[A-Za-z_]\w*)[ \t]*=[ \t]*(.+?)[ \t]*$/gm,
    )) {
      const right = match[2].trim();
      if (right.endsWith("\\") || right.endsWith("(") || right.endsWith("[")) continue;
      expressions.set(match[1], right);
    }
  }
  return expressions;
}

/** Normalise a declared in-game path to the forward-slash form the index uses. */
function normaliseDeclaredPath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Append `value` to `list` once, preserving script order. */
function pushUnique(list, value) {
  const normalised = normaliseDeclaredPath(value);
  if (normalised.length === 0 || list.includes(normalised)) return;
  list.push(normalised);
}

/**
 * Collect the `audio.<name> = "<path>"` alias table a game builds for its
 * music.
 *
 * The declaration form is `define -500 audio.<name> = "audio/music/x.mp3"`;
 * the optional integer is an init priority and is not part of the name. This
 * is why `play music audio.foo` is opaque to `readAssignments` — the alias
 * target is a *store variable*, not a `gui.`/`config.` key.
 *
 * @param sources script sources (`{ path, text }`).
 * @returns `Map` of bare alias name (no `audio.` prefix) to game-relative path.
 */
export function readAudioAliases(sources) {
  const aliases = new Map();
  for (const source of sources) {
    // Most scripts never mention `audio.`; skipping them before the expensive
    // multi-line pattern (run once per script on a 4000-file game) is the bulk
    // of the cost of resolving the main menu track.
    const raw = String(source?.text ?? "");
    if (!raw.includes("audio.")) continue;
    const text = stripComments(raw);
    for (const match of text.matchAll(
      /^[ \t]*(?:define|default)?[ \t]*(?:-?\d+[ \t]+)?audio\.([A-Za-z_]\w*)[ \t]*=[ \t]*(.+?)[ \t]*$/gm,
    )) {
      const value = evalValue(match[2], new Map());
      if (typeof value === "string") aliases.set(match[1], normaliseDeclaredPath(value));
    }
  }
  return aliases;
}

/**
 * Read `def <name>():` bodies, keeping each `return` with the `if`/`else`
 * guard that reaches it.
 *
 * This reads guards, not Python: a branch whose condition cannot be compared
 * against a known `default` is offered as a candidate rather than guessed at,
 * so the caller can present every possibility instead of silently picking one.
 *
 * @param sources script sources.
 * @returns `Map` of function name to `{ name, returns: [{ expression, condition }] }`.
 */
export function readPythonFunctions(sources) {
  const functions = new Map();
  for (const source of sources) {
    const lines = stripComments(String(source?.text ?? "")).split(/\r?\n/);
    let current = null;
    for (const line of lines) {
      const definition = /^([ \t]*)def[ \t]+([A-Za-z_]\w*)[ \t]*\([^)]*\)[ \t]*:/.exec(line);
      if (definition !== null) {
        current = { name: definition[2], indent: definition[1].length, returns: [], guard: undefined };
        functions.set(current.name, current);
        continue;
      }
      if (current === null) continue;
      if (line.trim().length === 0) continue;
      const indent = /^[ \t]*/.exec(line)[0].length;
      // Dedent to or past the `def` ends the body; `init python:` above it
      // only ever has smaller indentation, so this cannot overrun downward.
      if (indent <= current.indent) {
        current = null;
        continue;
      }
      const conditional = /^[ \t]*(?:if|elif)[ \t]+(.+?)[ \t]*:[ \t]*$/.exec(line);
      if (conditional !== null) {
        current.guard = conditional[1].trim();
        continue;
      }
      if (/^[ \t]*else[ \t]*:[ \t]*$/.test(line)) {
        // A bare `else` is reached whenever the preceding guards all failed,
        // which for a single `if`/`else` means "always".
        current.guard = "True";
        continue;
      }
      const returned = /^[ \t]*return[ \t]+(.+?)[ \t]*$/.exec(line);
      if (returned !== null) {
        current.returns.push({ expression: returned[1].trim(), condition: current.guard });
        current.guard = undefined;
        continue;
      }
      // Any other statement ends the reach of the guard that preceded it, so a
      // later `return` is not attributed to a branch it never belonged to.
      current.guard = undefined;
    }
  }
  return functions;
}

/**
 * Read `default persistent.<name> = <literal>`.
 *
 * A branch guarded on save state can then be resolved against the value a
 * fresh save would start from, which is the honest default rather than a
 * coin flip.
 *
 * @param sources script sources.
 * @returns `Map` of `persistent.<name>` to the literal value.
 */
export function readPersistentDefaults(sources) {
  const defaults = new Map();
  const assigned = new Set();
  const fromDefault = new Set();
  for (const source of sources) {
    const text = stripComments(String(source?.text ?? ""));
    for (const match of text.matchAll(
      /^[ \t]*(default)?[ \t]*persistent\.([A-Za-z_]\w*)[ \t]*=[ \t]*(.+?)[ \t]*$/gm,
    )) {
      const key = `persistent.${match[2]}`;
      const isDefault = match[1] === "default";
      // `persistent.theme = '序章'` also appears as a conditional assignment
      // inside the story, so the `default` declaration wins whenever both
      // forms exist — it is the value a NEW save begins with.
      if (fromDefault.has(key)) continue;
      if (assigned.has(key) && !isDefault) continue;
      const value = evalValue(match[3], new Map());
      if (value === undefined) continue;
      if (isDefault) fromDefault.add(key);
      defaults.set(key, value);
      assigned.add(key);
    }
  }
  return defaults;
}

/**
 * Evaluate the tiny guard vocabulary a menu-music function uses, returning
 * `undefined` for anything outside it so the caller keeps every branch.
 *
 * @param condition the `if` text.
 * @param defaults `persistent.*` defaults.
 * @returns `true`/`false`, or `undefined` when the guard is not understood.
 */
function evaluateGuard(condition, defaults) {
  const text = String(condition ?? "").trim();
  if (text === "True") return true;
  if (text === "False" || text === "None") return false;
  const comparison = /^(persistent\.[A-Za-z_]\w*)[ \t]*(==|!=)[ \t]*(.+)$/.exec(text);
  if (comparison === null) return undefined;
  const actual = defaults.get(comparison[1]);
  if (actual === undefined) return undefined;
  const expected = evalValue(comparison[3], new Map());
  if (expected === undefined) return undefined;
  return comparison[2] === "==" ? actual === expected : actual !== expected;
}

/**
 * Resolve one audio expression to the path(s) it can name.
 *
 * Handles the three forms games actually use: a quoted path, an `audio.<name>`
 * alias, and a call to a zero-argument function whose body returns either.
 *
 * @param expression the declared right-hand side.
 * @param context `{ aliases, functions, defaults }`.
 * @param depth recursion guard for a function that calls another.
 * @returns `Array<{ path?, unresolved?, condition?, preferred? }>`.
 */
function resolveAudioExpression(expression, context, depth) {
  if (expression === undefined || expression === null || depth > 3) return [];
  const text = String(expression).trim();
  if (text.length === 0) return [];

  const call = /^([A-Za-z_]\w*)[ \t]*\([ \t]*\)$/.exec(text);
  if (call !== null) {
    const fn = context.functions.get(call[1]);
    if (fn !== undefined) {
      const out = [];
      for (const entry of fn.returns) {
        const reachable =
          entry.condition === undefined ? undefined : evaluateGuard(entry.condition, context.defaults);
        for (const nested of resolveAudioExpression(entry.expression, context, depth + 1)) {
          out.push({
            ...nested,
            condition: entry.condition,
            preferred: reachable === true || nested.preferred === true,
          });
        }
      }
      return out;
    }
  }

  const alias = /^audio\.([A-Za-z_]\w*)$/.exec(text);
  if (alias !== null) {
    const path = context.aliases.get(alias[1]);
    return path === undefined ? [{ unresolved: text }] : [{ path }];
  }

  const literal = evalValue(text, new Map());
  if (typeof literal === "string") return [{ path: normaliseDeclaredPath(literal) }];
  // A non-string is an unresolved function call (the `{ call, args }` marker
  // `evalValue` returns) or something this reader does not evaluate.
  return [{ unresolved: text }];
}

/**
 * The first argument of every music call inside `label main_menu` and
 * `screen main_menu`: `play music <x>`, `renpy.music.play(<x>)`, and the
 * `Play("music", <x>)` action a screen button or `on "show"` handler uses.
 *
 * Only the first token is kept, so trailing clauses (`fadein 1.0`, `loop=True`)
 * do not reach the resolver. Returned as written (quotes included), which is
 * the form `resolveAudioExpression` expects.
 *
 * @param sources script sources.
 * @returns array of raw expressions, in script order.
 */
function readMainMenuPlayCalls(sources) {
  const expressions = [];
  const playCall =
    /(?:play[ \t]+music|renpy\.music\.play\(|Play\([ \t]*["']music["'][ \t]*,)[ \t]*("[^"]+"|'[^']+'|audio\.[A-Za-z_]\w*)/;
  for (const source of sources) {
    const lines = stripComments(String(source?.text ?? "")).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const header = /^[ \t]*(?:label[ \t]+main_menu[ \t]*:|screen[ \t]+main_menu\b[^\n]*:)[ \t]*$/.test(lines[index]);
      if (!header) continue;
      for (const line of indentedBlock(lines, index)) {
        const match = playCall.exec(line.trim());
        if (match !== null) expressions.push(match[1]);
      }
    }
  }
  return expressions;
}

/**
 * Resolve `config.main_menu_music` to every file it can name.
 *
 * @param sources script sources.
 * @returns `{ declared, tracks, unresolved }`; `tracks` is ordered with the
 *   branch a fresh save would take first.
 */
export function resolveMenuMusic(sources) {
  const names = new Map();
  for (const source of sources) {
    for (const [key, value] of readAssignments(String(source?.text ?? ""))) names.set(key, value);
  }
  // The RAW text wins over the resolved value: `readAssignments` strips the
  // quotes off a literal path, and `evalValue` then refuses the bare path it
  // just produced.
  const raw = readAssignmentExpressions(sources).get("config.main_menu_music");
  const declaredConfig = raw !== undefined ? raw : names.get("config.main_menu_music");
  // Without a `config.main_menu_music`, the title screen's own `play music`
  // (in `label main_menu` or `screen main_menu`) is what the player hears.
  const playCalls = declaredConfig === undefined ? readMainMenuPlayCalls(sources) : [];
  const declared = declaredConfig ?? playCalls[0];
  const context = {
    aliases: readAudioAliases(sources),
    functions: readPythonFunctions(sources),
    defaults: readPersistentDefaults(sources),
  };
  const expressions = declaredConfig === undefined ? playCalls : [declaredConfig];
  const resolved = expressions.flatMap((expression) => resolveAudioExpression(expression, context, 0));
  const tracks = [];
  const unresolved = [];
  for (const entry of resolved) {
    // `<loop 5.3>music/x.ogg` is Ren'Py's audio-clip prefix (loop points, from,
    // to), not part of the file name; the file is what comes after it.
    if (typeof entry.path === "string") entry.path = entry.path.replace(/^<[^>]*>s*/, "");
    if (entry.path === undefined) {
      if (!unresolved.includes(entry.unresolved)) unresolved.push(entry.unresolved);
      continue;
    }
    const existing = tracks.find((track) => track.path === entry.path);
    if (existing !== undefined) {
      // A path reachable from two branches is preferred if either branch is.
      if (entry.preferred === true) existing.preferred = true;
      continue;
    }
    tracks.push({
      path: entry.path,
      preferred: entry.preferred === true,
      ...(entry.condition === undefined ? {} : { condition: entry.condition }),
    });
  }
  tracks.sort((a, b) => Number(b.preferred) - Number(a.preferred));
  // A game that writes one literal path has no branch to prefer, but the
  // caller's "which one do I play" question still has exactly one answer.
  if (tracks.length === 1) tracks[0].preferred = true;
  return { declared, tracks, unresolved };
}
/** `image <name> = "<path>"` declarations as `name -> path`. */
function readImageDeclarations(text) {
  const declarations = new Map();
  for (const match of text.matchAll(
    /^[ \t]*image[ \t]+([A-Za-z_][\w]*(?:[ \t]+[A-Za-z_]\w*)*)[ \t]*=[ \t]*["']([^"']+\.[A-Za-z0-9]{2,4})["']/gm,
  )) {
    declarations.set(match[1].trim(), normaliseDeclaredPath(match[2]));
  }
  return declarations;
}

/**
 * The statements a `label`/`screen` header owns, by indentation.
 * @param lines the whole file split into lines.
 * @param headerIndex index of the `<header>:` line.
 * @returns the indented child lines, verbatim.
 */
function indentedBlock(lines, headerIndex) {
  const indent = /^[ \t]*/.exec(lines[headerIndex])[0].length;
  const body = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    if (/^[ \t]*/.exec(line)[0].length <= indent) break;
    body.push(line);
  }
  return body;
}

/** Record one splash still, resolving an image name to its declared path. */
function pushSplashImage(value, context) {
  const text = String(value ?? "").trim();
  // `add "#fff"` is a colour fill, not art.
  if (text.length === 0 || text.startsWith("#")) return;
  if (/\.[A-Za-z0-9]{2,4}$/.test(text)) {
    pushUnique(context.out.images, text);
    return;
  }
  const declared = context.imageDeclarations.get(text);
  if (declared !== undefined) pushUnique(context.out.images, declared);
}

/**
 * Walk the splash body, following `call screen` one level deep.
 *
 * The visible art of an interactive splash lives inside the screen it calls —
 * GoToSnowTown's watermark is an `add` inside `screen antipiracy_splash` — so
 * stopping at the label would extract nothing at all for that shape of game.
 */
function collectSplash(body, context) {
  for (const raw of body) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const cutscene = /movie_cutscene[ \t]*\([ \t]*["']([^"']+)["']/.exec(line);
    if (cutscene !== null) {
      pushUnique(context.out.videos, cutscene[1]);
      continue;
    }
    const movie = /(?:play|show|scene)[ \t]+movie[ \t]+["']([^"']+)["']/.exec(line);
    if (movie !== null) {
      pushUnique(context.out.videos, movie[1]);
      continue;
    }
    const add = /^add[ \t]+["']([^"']+)["']/.exec(line);
    if (add !== null) {
      pushSplashImage(add[1], context);
      continue;
    }
    const button = /(?:idle|hover|ground|insensitive)[ \t]+["']([^"']+)["']/.exec(line);
    if (button !== null) {
      pushSplashImage(button[1], context);
      continue;
    }
    const play = /play[ \t]+(?:audio|music|sound)[ \t]+(.*)$/.exec(line);
    if (play !== null) {
      for (const match of play[1].matchAll(/["']([^"']+\.(?:ogg|opus|mp3|wav|m4a|flac|aac))["']/gi)) {
        pushUnique(context.out.audio, match[1]);
      }
      for (const match of play[1].matchAll(/\baudio\.([A-Za-z_]\w*)/g)) {
        const path = context.aliases.get(match[1]);
        if (path !== undefined) pushUnique(context.out.audio, path);
      }
      continue;
    }
    const call = /call[ \t]+screen[ \t]+([A-Za-z_]\w*)/.exec(line);
    if (call !== null && context.depth < 2) {
      pushUnique(context.out.screens, call[1]);
      const nested = context.screens.get(call[1]);
      if (nested !== undefined) collectSplash(nested, { ...context, depth: context.depth + 1 });
    }
    // An interactive splash advances on a timer, and that is the only signal a
    // still image can carry: unlike a cutscene it never fires `ended`, so
    // without this the caller has no way to know when to drop it.
    const timer = /^timer[ \t]+([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (timer !== null) {
      const seconds = Number.parseFloat(timer[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        context.out.timers.push(seconds);
      }
    }
    // A plain `show logo at truecenter` or `scene black` names an image that is
    // either declared with `image` or is a file the asset index resolves by
    // name; this reader only keeps the name and lets the caller resolve it.
    // Only the label's own statements count: screens pass art through `add`.
    const shown = /^(?:show|scene)[ \t]+([A-Za-z_]\w*(?:[ \t]+(?!(?:at|with|as|behind|onlayer|zorder|expression)\b)[A-Za-z_]\w*)*)(?=[ \t]+(?:at|with|as|behind|onlayer|zorder|expression)\b|[ \t]*$)/.exec(line);
    if (shown !== null && context.depth === 0) {
      const name = shown[1].trim().replace(/\s+/g, " ");
      const declared = context.imageDeclarations.get(name);
      if (declared !== undefined) pushUnique(context.out.images, declared);
      else context.out.shownNames.push(name);
    }
    // `pause N` in the label body runs in sequence, so the body's own duration
    // is the sum of its pauses. A bare `pause` waits for a click and adds nothing.
    const pause = /^pause[ \t]+([0-9]+(?:\.[0-9]+)?)[ \t]*$/.exec(line);
    if (pause !== null && context.depth === 0) {
      const seconds = Number.parseFloat(pause[1]);
      if (Number.isFinite(seconds) && seconds > 0) context.out.pauseSeconds += seconds;
    }
  }

}

/**
 * Read the `label splashscreen:` block and the screens it calls, so the skin
 * can replay the game's own opening.
 *
 * Only the label's own statements count as the splash; a `call screen` is
 * followed two levels because that is where interactive splashes keep their
 * art. Nothing here evaluates a condition: a random or save-gated image is
 * collected as a candidate, and the caller only needs "something to show".
 *
 * @param sources script sources.
 * @returns `{ found, videos, images, audio, screens }` of game-relative paths.
 */
export function readSplashscreen(sources) {
  const imageDeclarations = new Map();
  const screens = new Map();
  const labels = new Map();
  for (const source of sources) {
    const text = stripComments(String(source?.text ?? ""));
    const lines = text.split(/\r?\n/);
    for (const [name, path] of readImageDeclarations(text)) imageDeclarations.set(name, path);
    for (let index = 0; index < lines.length; index += 1) {
      const label = /^([ \t]*)label[ \t]+([A-Za-z_]\w*)[ \t]*:[ \t]*$/.exec(lines[index]);
      if (label !== null) {
        labels.set(label[2], indentedBlock(lines, index));
        continue;
      }
      const screen = /^([ \t]*)screen[ \t]+([A-Za-z_]\w*)[^\n]*:[ \t]*$/.exec(lines[index]);
      if (screen !== null) screens.set(screen[2], indentedBlock(lines, index));
    }
  }
  const body = labels.get("splashscreen");
  if (body === undefined) {
    return { found: false, videos: [], images: [], audio: [], screens: [], timers: [], shownNames: [], pauseSeconds: 0 };
  }
  const out = { found: true, videos: [], images: [], audio: [], screens: [], timers: [], shownNames: [], pauseSeconds: 0 };
  collectSplash(body, {
    screens,
    imageDeclarations,
    aliases: readAudioAliases(sources),
    depth: 0,
    out,
  });
  return out;
}
