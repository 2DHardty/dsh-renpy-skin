/**
 * Ren'Py display-statement subset: tokenizer, parser, and stage state machine.
 *
 * The grammar accepted here follows the official `renpy/lexer.py` /
 * `renpy/parser.py` token rules for display statements — image names are
 * space-separated components with an optional trailing attribute group, `at`
 * takes a comma-separated transform list, and `behind`/`as`/`zorder` are the
 * same clause forms the engine writes:
 *
 *     show <image> [as <tag>] [at <transform>[, ...]] [behind <tag>[, ...]] [zorder <int>]
 *     hide <tag>
 *     scene [<image>]
 *     with <transition>
 *     <one of the above> with <transition>
 *
 * This is deliberately a *subset*: the model is prompted into this dialect, so
 * pulling in the full Ren'Py grammar would mean filtering productions we never
 * accept. Everything accepted is validated against the manifest, and a
 * rejection always names the alternatives that exist — that self-correction
 * loop is what keeps the model's second attempt valid.
 */

/** Built-in transforms, matching Ren'Py's documented position shortcuts. */
export const BUILTIN_TRANSFORMS = {
  left: { xpos: 0.0, xanchor: 0.0, ypos: 1.0, yanchor: 1.0 },
  center: { xpos: 0.5, xanchor: 0.5, ypos: 1.0, yanchor: 1.0 },
  truecenter: { xpos: 0.5, xanchor: 0.5, ypos: 0.5, yanchor: 0.5 },
  right: { xpos: 1.0, xanchor: 1.0, ypos: 1.0, yanchor: 1.0 },
  topleft: { xpos: 0.0, xanchor: 0.0, ypos: 0.0, yanchor: 0.0 },
  top: { xpos: 0.5, xanchor: 0.5, ypos: 0.0, yanchor: 0.0 },
  topright: { xpos: 1.0, xanchor: 1.0, ypos: 0.0, yanchor: 0.0 },
  bottomleft: { xpos: 0.0, xanchor: 0.0, ypos: 1.0, yanchor: 1.0 },
  bottom: { xpos: 0.5, xanchor: 0.5, ypos: 1.0, yanchor: 1.0 },
  bottomright: { xpos: 1.0, xanchor: 1.0, ypos: 1.0, yanchor: 1.0 },
  centerleft: { xpos: 0.0, xanchor: 0.0, ypos: 0.5, yanchor: 0.5 },
  centerright: { xpos: 1.0, xanchor: 1.0, ypos: 0.5, yanchor: 0.5 },
  offscreenleft: { xpos: -0.5, xanchor: 0.0, ypos: 1.0, yanchor: 1.0 },
  offscreenright: { xpos: 1.5, xanchor: 1.0, ypos: 1.0, yanchor: 1.0 },
};

/** ATL/transform properties the stage honours, with their value domains. */
const TRANSFORM_PROPERTIES = new Set([
  "xpos",
  "ypos",
  "xanchor",
  "yanchor",
  "xalign",
  "yalign",
  "xoffset",
  "yoffset",
  "zoom",
  "alpha",
  "rotate",
  "zorder",
]);

/** Transitions supported natively; anything else is reported as unsupported. */
export const SUPPORTED_TRANSITIONS = new Set(["dissolve", "fade", "none", "None"]);

/** Bare `{w}`/`{p}` pause default, matching the prompt's documented 0.5s. */
export const BARE_PAUSE_SECONDS = 0.5;

/**
 * A stage command that could not be validated. `details` carries the
 * alternatives the model needs for its self-correction attempt.
 */
export class StageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StageError";
    this.details = details;
  }
}

/**
 * Tokenize one display statement.
 *
 * Mirrors the lexer's word/float/punctuation split closely enough for the
 * display subset: identifiers (`[A-Za-z_][A-Za-z0-9_]*`), numbers, quoted
 * strings, and the operators `:` `,` `(` `)` `=` `+` `-` `*` `/` `.` `<` `>`.
 *
 * @param line one logical statement.
 * @returns the token list.
 */
export function tokenize(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "#") break;
    if (ch === '"' || ch === "'") {
      let text = "";
      i += 1;
      while (i < line.length && line[i] !== ch) {
        if (line[i] === "\\" && i + 1 < line.length) {
          text += line[i + 1];
          i += 2;
          continue;
        }
        text += line[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: "string", value: text });
      continue;
    }
    const number = /^[-+]?(?:\d+\.\d*|\.\d+|\d+)/.exec(line.slice(i));
    if (number !== null && !/[A-Za-z_]/.test(ch)) {
      tokens.push({ kind: "number", value: Number.parseFloat(number[0]) });
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(line.slice(i));
    if (word !== null) {
      tokens.push({ kind: "word", value: word[0] });
      i += word[0].length;
      continue;
    }
    if (ch === "*" && line[i + 1] === "*") {
      tokens.push({ kind: "op", value: "**" });
      i += 2;
      continue;
    }
    // Two-character comparison operators must be one token: splitting `==`
    // into two `=` left every `if` condition unparseable.
    const pair = line.slice(i, i + 2);
    if (["==", "!=", ">=", "<="].includes(pair)) {
      tokens.push({ kind: "op", value: pair });
      i += 2;
      continue;
    }
    tokens.push({ kind: "op", value: ch });
    i += 1;
  }
  return tokens;
}

/** Split a statement into logical lines, honouring line continuations. */
export function logicalLines(script) {
  const joined = script.replace(/\\\r?\n/g, " ");
  return joined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Separator tokens that end a plain word run. */
const CLAUSE_KEYWORDS = new Set(["at", "as", "behind", "with", "zorder"]);

/**
 * Consume tokens while they belong to an identifier sequence.
 *
 * A clause keyword ends the run, so `behind bob zorder 5` yields `["bob"]` and
 * lets `zorder` be read as its own clause. Without this the keyword and its
 * argument were swallowed into the previous clause's tag list.
 */
function readWords(tokens, start) {
  const words = [];
  let i = start;
  while (i < tokens.length && tokens[i].kind === "word" && !CLAUSE_KEYWORDS.has(tokens[i].value)) {
    words.push(tokens[i].value);
    i += 1;
  }
  return { words, next: i };
}

/**
 * Parse a display statement.
 *
 * @param line one statement.
 * @returns the parsed command (`{ kind: 'show' | 'hide' | 'scene' | 'with' }`).
 * @throws {StageError} when the statement is not in the accepted subset.
 */
export function parseStatement(line) {
  const tokens = tokenize(line);
  if (tokens.length === 0) throw new StageError("empty statement");
  const head = tokens[0];
  if (head.kind !== "word") {
    throw new StageError(`statement must start with show/hide/scene/with, got ${JSON.stringify(head.value)}`);
  }
  const keyword = head.value;

  if (keyword === "with") {
    const transition = readTransition(tokens, 1);
    ensureEnd(tokens, transition.next);
    return { kind: "with", transition: transition.value };
  }

  if (keyword === "scene") {
    const clauses = readClauses(tokens, 1);
    const image = clauses.image.length > 0 ? clauses.image.join(" ") : undefined;
    return {
      kind: "scene",
      image,
      at: clauses.at,
      transition: clauses.transition,
      condition: clauses.condition,
    };
  }

  if (keyword === "hide") {
    const clauses = readClauses(tokens, 1);
    if (clauses.image.length === 0) throw new StageError("hide needs a tag, e.g. `hide eileen`");
    return {
      kind: "hide",
      tag: clauses.image[0],
      as: clauses.as,
      at: clauses.at,
      transition: clauses.transition,
      condition: clauses.condition,
    };
  }

  if (keyword === "show") {
    const clauses = readClauses(tokens, 1);
    if (clauses.image.length === 0) throw new StageError("show needs an image, e.g. `show eileen happy`");
    const image = [...clauses.image];
    let side = false;
    if (image[0] === "side") {
      side = true;
      image.shift();
    }
    if (image.length === 0) throw new StageError("`show side` needs a tag, e.g. `show side eileen`");
    return {
      kind: "show",
      image,
      side,
      as: clauses.as,
      at: clauses.at,
      behind: clauses.behind,
      zorder: clauses.zorder,
      transition: clauses.transition,
      condition: clauses.condition,
    };
  }

  throw new StageError(
    `unsupported statement ${JSON.stringify(keyword)}: this stage accepts show, hide, scene, and with`,
  );
}

/** Read `<transition>` after a `with`. */
function readTransition(tokens, start) {
  const token = tokens[start];
  if (token === undefined || token.kind !== "word") {
    throw new StageError("`with` needs a transition, e.g. `with dissolve`");
  }
  if (!SUPPORTED_TRANSITIONS.has(token.value)) {
    throw new StageError(`unsupported transition ${JSON.stringify(token.value)}`, {
      supportedTransitions: [...SUPPORTED_TRANSITIONS].filter((name) => name !== "None"),
    });
  }
  return { value: token.value === "None" ? "none" : token.value.toLowerCase(), next: start + 1 };
}

/** Read the optional clause tail shared by `show`/`scene`. */
function readClauses(tokens, start) {
  const clauses = {
    image: [],
    at: [],
    behind: [],
    as: undefined,
    zorder: undefined,
    transition: undefined,
    condition: undefined,
  };
  let i = start;
  /**
   * The image run ends at the first clause keyword *after at least one
   * component*. `at` is the boundary the model is prompted to use, so a
   * displayable literally named `at` is not addressable here; every other
   * keyword stays usable as an attribute component when it appears first
   * (`show with happy`). Once a clause has been read the run is closed for
   * good, so the integer after `zorder` can never be mistaken for an
   * attribute.
   */
  let consumed = 0;
  let imageOpen = true;
  let clauseSeen = false;
  while (i < tokens.length) {
    const token = tokens[i];
    if (
      token.kind === "word" &&
      token.value === "if" &&
      (imageOpen ? consumed > 0 : true)
    ) {
      imageOpen = false;
      clauseSeen = true;
      const condition = readCondition(tokens, i + 1);
      clauses.condition = condition.value;
      i = condition.next;
      continue;
    }
    if (token.kind === "word" && CLAUSE_KEYWORDS.has(token.value) && (imageOpen ? consumed > 0 : true)) {
      imageOpen = false;
      clauseSeen = true;
      const keyword = token.value;
      i += 1;
      if (keyword === "at") {
        const parsed = readAtList(tokens, i);
        clauses.at.push(...parsed.list);
        i = parsed.next;
        continue;
      }
      if (keyword === "behind") {
        const words = readWords(tokens, i);
        if (words.words.length === 0) throw new StageError("`behind` needs at least one tag");
        clauses.behind.push(...words.words);
        i = words.next;
        continue;
      }
      if (keyword === "as") {
        const words = readWords(tokens, i);
        if (words.words.length === 0) throw new StageError("`as` needs a tag");
        clauses.as = words.words[0];
        i = words.next;
        continue;
      }
      if (keyword === "zorder") {
        const value = tokens[i];
        if (value === undefined || value.kind !== "number" || !Number.isInteger(value.value)) {
          throw new StageError("`zorder` needs an integer");
        }
        clauses.zorder = Math.trunc(value.value);
        i += 1;
        continue;
      }
      if (keyword === "with") {
        const transition = readTransition(tokens, i);
        clauses.transition = transition.value;
        i = transition.next;
        continue;
      }
      continue;
    }
    if (!clauseSeen && (token.kind === "word" || token.kind === "number" || token.kind === "string")) {
      // Attribute components may be numeric (`show bg 10`, `show eileen 1`),
      // but only before the first clause — after `zorder` an integer is never
      // an attribute.
      clauses.image.push(token.kind === "word" ? token.value : String(token.value));
      consumed += 1;
      i += 1;
      continue;
    }
    throw new StageError(
      `unexpected token ${JSON.stringify(token.value)} in ${JSON.stringify(tokens.map((t) => t.value).join(" "))}`,
    );
  }
  return clauses;
}

/** Read a comma-separated `at` transform list. */
function readAtList(tokens, start) {
  const list = [];
  let i = start;
  for (;;) {
    const parsed = readTransformExpression(tokens, i);
    if (parsed.value !== undefined) list.push(parsed.value);
    i = parsed.next;
    const separator = tokens[i];
    if (separator !== undefined && separator.kind === "op" && separator.value === ",") {
      i += 1;
      continue;
    }
    break;
  }
  if (list.length === 0) throw new StageError("`at` needs at least one transform, e.g. `at left`");
  return { list, next: i };
}

/**
 * Read one transform reference or `Transform(...)` call.
 * @returns `{ value, next }`, where `value` is `{ name }` or `{ props }`.
 */
function readTransformExpression(tokens, start) {
  const token = tokens[start];
  if (token === undefined || token.kind !== "word") return { value: undefined, next: start };
  if (token.value === "Transform" && tokens[start + 1]?.value === "(") {
    const parsed = readPropertyCall(tokens, start + 1);
    return { value: { props: parsed.props, from: "Transform(...)" }, next: parsed.next };
  }
  // A transform name is one dotted word chain, and it stops at the next clause
  // keyword: `at center zorder 5` names `center`, not `center zorder`.
  const words = [];
  let i = start;
  while (i < tokens.length && tokens[i].kind === "word" && !CLAUSE_KEYWORDS.has(tokens[i].value)) {
    words.push(tokens[i].value);
    i += 1;
  }
  return { value: { name: words.join(" "), props: {} }, next: i };
}

/** Read a `( k=v, ... )` property list. */
function readPropertyCall(tokens, start) {
  if (tokens[start]?.value !== "(") throw new StageError("expected `(`");
  const props = {};
  let i = start + 1;
  while (i < tokens.length && !(tokens[i].kind === "op" && tokens[i].value === ")")) {
    const key = tokens[i];
    if (key.kind !== "word") throw new StageError(`expected a property name, got ${JSON.stringify(key.value)}`);
    const equals = tokens[i + 1];
    if (equals === undefined || equals.value !== "=") {
      throw new StageError(`expected \`=\` after property ${JSON.stringify(key.value)}`);
    }
    const value = readPropertyValue(tokens, i + 2);
    props[key.value] = value.value;
    i = value.next;
    if (tokens[i]?.value === ",") i += 1;
  }
  if (tokens[i]?.value !== ")") throw new StageError("unterminated property list");
  return { props, next: i + 1 };
}

/** Read one numeric/word/time property value. */
function readPropertyValue(tokens, start) {
  const token = tokens[start];
  if (token === undefined) throw new StageError("expected a property value");
  if (token.kind === "number") {
    // Time-prefixed ATL (`linear 1.0 zoom 1.2`) reads as number then property.
    return { value: token.value, next: start + 1 };
  }
  if (token.kind === "word") {
    if (token.value === "True") return { value: true, next: start + 1 };
    if (token.value === "False") return { value: false, next: start + 1 };
    if (token.value === "None") return { value: null, next: start + 1 };
    return { value: token.value, next: start + 1 };
  }
  if (token.kind === "op" && (token.value === "-" || token.value === "+")) {
    const next = tokens[start + 1];
    if (next?.kind === "number") {
      return { value: token.value === "-" ? -next.value : next.value, next: start + 2 };
    }
  }
  throw new StageError(`unsupported property value ${JSON.stringify(token.value)}`);
}

/** Read `if <var> <op> <literal>`; this clause is a plugin extension. */
function readCondition(tokens, start) {
  const name = tokens[start];
  if (name === undefined || name.kind !== "word") {
    throw new StageError("`if` needs a variable name");
  }
  const operator = tokens[start + 1];
  if (operator === undefined || !["==", "!=", ">", "<", ">=", "<="].includes(operator.value)) {
    throw new StageError(
      "`if` needs a comparison operator (==, !=, >, <, >=, <=) — the stage does not evaluate full expressions",
    );
  }
  const literal = tokens[start + 2];
  if (literal === undefined) throw new StageError("`if` needs a comparison value");
  return {
    value: { variable: name.value, operator: operator.value, value: literal.value },
    next: start + 3,
  };
}

/** Reject trailing tokens so a typo cannot silently pass. */
function ensureEnd(tokens, index) {
  if (index < tokens.length) {
    throw new StageError(`unexpected trailing input ${JSON.stringify(tokens[index].value)}`);
  }
}

/**
 * Resolve a transform reference against built-ins, game-defined transforms,
 * and inline properties, producing the final positioning values.
 *
 * @param reference `{ name }` or `{ props }`.
 * @param gameTransforms the manifest's `transforms` table.
 * @returns the resolved property bag.
 * @throws {StageError} for an unknown transform name.
 */
export function resolveTransform(reference, gameTransforms = {}) {
  if (reference === undefined) return {};
  const collected = [];
  const apply = (props) => {
    for (const [key, value] of Object.entries(props)) {
      if (!TRANSFORM_PROPERTIES.has(key)) continue;
      if (typeof value !== "number") continue;
      collected.push([key, value]);
    }
  };

  if (reference.name !== undefined && reference.name.length > 0) {
    const name = reference.name;
    if (BUILTIN_TRANSFORMS[name] !== undefined) {
      apply(BUILTIN_TRANSFORMS[name]);
    } else if (gameTransforms[name] !== undefined) {
      apply(gameTransforms[name].props ?? {});
    } else {
      throw new StageError(`unknown transform ${JSON.stringify(name)}`, {
        builtinTransforms: Object.keys(BUILTIN_TRANSFORMS),
        gameTransforms: Object.keys(gameTransforms).slice(0, 60),
      });
    }
  }
  if (reference.props !== undefined) apply(reference.props);

  const resolved = {};
  for (const [key, value] of collected) resolved[key] = value;
  // xalign/yalign are conveniences that expand to pos+anchor, as in Ren'Py.
  if (resolved.xalign !== undefined) {
    resolved.xpos = resolved.xalign;
    resolved.xanchor = resolved.xalign;
  }
  if (resolved.yalign !== undefined) {
    resolved.ypos = resolved.yalign;
    resolved.yanchor = resolved.yalign;
  }
  return resolved;
}

/**
 * The per-session stage state machine.
 *
 * Stage state is keyed by session id, so two conversations cannot fight over
 * one composition. `show` is idempotent: repeating the same tag with the same
 * image and transform updates nothing, while a new attribute set swaps the
 * expression in place.
 */
export class StageStore {
  constructor() {
    /** sessionId -> { scene, sprites, transition, updatedAt } */
    this.stages = new Map();
    this.listeners = new Set();
  }

  /** Current state for a session, materialising the empty stage on demand. */
  get(sessionId) {
    let stage = this.stages.get(sessionId);
    if (stage === undefined) {
      stage = { scene: undefined, sprites: [], transition: "none", updatedAt: Date.now() };
      this.stages.set(sessionId, stage);
    }
    return stage;
  }

  /** Read-only snapshot for transport to the browser half. */
  snapshot(sessionId) {
    const stage = this.get(sessionId);
    return {
      // `scene` is undefined until a background is shown. The host snapshots
      // every tool result as lossless JSON and rejects a present-but-undefined
      // property, so an empty background must be an absent key, not a key
      // holding undefined: otherwise every `renpy_stage` call after a bare
      // `scene` fails with "value is not lossless JSON".
      ...(stage.scene === undefined ? {} : { scene: stage.scene }),
      transition: stage.transition,
      sprites: stage.sprites.map((sprite) => ({ ...sprite })),
      updatedAt: stage.updatedAt,
    };
  }

  /** Subscribe to stage changes. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notify listeners; a listener failure never breaks a stage command. */
  emit(sessionId) {
    const snapshot = this.snapshot(sessionId);
    for (const listener of this.listeners) {
      try {
        listener(sessionId, snapshot);
      } catch {
        // A transport listener must not fail the tool call that produced it.
      }
    }
  }

  /** Drop one session's stage (used when a game directory changes). */
  reset(sessionId) {
    this.stages.delete(sessionId);
  }
}

/**
 * One resolved sprite placement, ready for absolute CSS positioning.
 * @typedef {object} StageSprite
 * @property {string} tag
 * @property {string} image
 * @property {string} url
 * @property {number} zorder
 * @property {number} alpha
 * @property {number} zoom
 * @property {number} rotate
 * @property {number} xpos
 * @property {number} ypos
 * @property {number} xanchor
 * @property {number} yanchor
 * @property {number} xoffset
 * @property {number} yoffset
 * @property {boolean} side
 */

/**
 * Choose which layered-image layers an `show <tag> <attrs...>` statement draws.
 *
 * Ren'Py layered characters compose one layer PER GROUP: the requested
 * attributes are matched against each group's attribute list, and a group with
 * no requested attribute falls back to that group's `default` attribute (or no
 * layer when the default is `null`). The result maps group name → the concrete
 * `{url, path}` layer to draw, preserving group order.
 *
 * @param {object} match the resolved layered sprite record.
 * @param {string[]} requested the attribute components after the tag.
 * @returns {Array<{group: string, attribute: string, url: string}>} the stacked layers.
 */
function selectLayers(match, requested) {
  const wanted = new Set(requested);
  const out = [];
  for (const group of match.groups ?? []) {
    let chosen = group.attributes.find((attribute) => wanted.has(attribute.name));
    if (chosen === undefined || chosen.defaultNull === true || chosen.url === undefined) {
      // No requested attribute (or it draws no layer): use the group default.
      chosen = group.attributes.find((attribute) => attribute.default === true);
    }
    if (chosen !== undefined && chosen.url !== undefined) {
      out.push({ group: group.name, attribute: chosen.name, url: chosen.url });
    }
  }
  return out;
}

/**
 * Apply parsed statements to a stage, validating every image against the
 * manifest.
 *
 * @param stage mutable stage state.
 * @param statements parsed commands in order.
 * @param manifest the current asset manifest.
 * @param options.autoAvoid when true, shift `center`/`left`/`right` sprites
 *   out of the reserved safe area instead of only warning.
 * @param options.safeArea reserved rectangles in design coordinates.
 * @returns `{ applied, ignored, warnings, requires }`.
 */
export function applyStatements(stage, statements, manifest, options = {}) {
  const applied = [];
  const warnings = [];
  const requires = new Set();

  for (const statement of statements) {
    switch (statement.kind) {
      case "with": {
        stage.transition = statement.transition;
        applied.push({ kind: "with", transition: statement.transition });
        break;
      }
      case "scene": {
        if (statement.transition !== undefined) stage.transition = statement.transition;
        let scene;
        if (statement.image !== undefined) {
          const background = findBackground(manifest, statement.image);
          if (background === undefined) {
            throw new StageError(`no background matches ${JSON.stringify(statement.image)}`, {
              backgrounds: manifest.backgrounds.slice(0, 40).map((entry) => entry.name),
              backgroundCount: manifest.backgrounds.length,
            });
          }
          scene = { image: background.name, url: background.url, path: background.path };
          requires.add("background");
        }
        stage.scene = scene;
        stage.sprites = [];
        // Same lossless-JSON rule as `snapshot()`: a bare `scene` clears the
        // background, and an `undefined` scene name here would invalidate the
        // whole tool result on the very call that clears it.
        applied.push({ kind: "scene", ...(scene === undefined ? {} : { scene: scene.image }) });
        break;
      }
      case "show": {
        if (statement.transition !== undefined) stage.transition = statement.transition;
        // `show side <tag> ...` is parsed as `side: true` with the `side`
        // component stripped from the image name; the manifest indexes side
        // images under their FULL name (`side head_meteor angry`), so the
        // prefix must be restored before resolution. `as` still names the tag.
        const imageName = (statement.side ? "side " : "") + statement.image.join(" ");
        const match = resolveSprite(manifest, imageName);
        if (match === undefined) {
          throw new StageError(`unknown image ${JSON.stringify(imageName)}`, {
            ...manifestAlternatives(manifest),
          });
        }
        // The user's character ticks, from Settings → Characters. An empty list
        // means "every character", so a fresh install is never a stage with no
        // cast; a non-empty list is a hard roster and an un-ticked character is
        // rejected here rather than silently missing from the prompt.
        const enabled = options.enabledCharacters;
        if (Array.isArray(enabled) && enabled.length > 0 && !enabled.includes(match.tag)) {
          throw new StageError(
            `character ${JSON.stringify(match.tag)} is not enabled (未启用，请到设置勾选)`,
            { tag: match.tag, enabledCharacters: [...enabled], ...manifestAlternatives(manifest) },
          );
        }
        // Block-level ATL on a layeredimage (`zoom 0.36`, `xcenter 0.5`,
        // `yalign 1.0`) is the character's default placement; explicit `at`
        // transforms override it per-statement.
        const transformProps = {};
        for (const [key, value] of Object.entries(match.base ?? {})) {
          if (typeof value === "number") transformProps[key] = value;
        }
        if (typeof transformProps.xalign === "number") {
          transformProps.xpos = transformProps.xalign;
          transformProps.xanchor = transformProps.xalign;
        }
        if (typeof transformProps.yalign === "number") {
          transformProps.ypos = transformProps.yalign;
          transformProps.yanchor = transformProps.yalign;
        }
        for (const reference of statement.at) Object.assign(transformProps, resolveTransform(reference, manifest.transforms));
        const tag = statement.as ?? match.tag;
        const placement = placementFor(transformProps, options);
        const previous = stage.sprites.find((sprite) => sprite.tag === tag);
        // A layered character has no single `url`; the browser stacks the
        // chosen group layers instead. The sprite carries the layer map and the
        // active attribute set so the client can pick which layers to draw.
        const requestedAttributes = statement.image.slice(1);
        const activeLayers =
          match.layered === true ? selectLayers(match, requestedAttributes) : undefined;
        const sprite = {
          tag,
          image: match.name,
          // A layeredimage has no single file, so the match has no `url`; the
          // browser stacks `activeLayers` instead. Omitting the key keeps the
          // tool result lossless JSON (see `snapshot()`), while a non-layered
          // sprite still carries the one image it draws.
          ...(match.url === undefined ? {} : { url: match.url }),
          side: statement.side === true,
          zorder:
            statement.zorder ??
            (previous === undefined ? defaultZorder(stage.sprites) : previous.zorder),
          alpha: typeof transformProps.alpha === "number" ? clamp(transformProps.alpha, 0, 1) : (previous?.alpha ?? 1),
          zoom: typeof transformProps.zoom === "number" ? transformProps.zoom : (previous?.zoom ?? 1),
          rotate: typeof transformProps.rotate === "number" ? transformProps.rotate : (previous?.rotate ?? 0),
          ...placement,
          ...(match.layered === true
            ? {
                layered: true,
                layers: match.layers,
                groups: match.groups,
                base: match.base,
                attributes: match.attributes,
                activeLayers,
              }
            : {}),
        };
        if (statement.behind !== undefined && statement.behind.length > 0) {
          const target = stage.sprites.find((entry) => entry.tag === statement.behind[0]);
          if (target === undefined) {
            warnings.push(
              `\`behind ${statement.behind[0]}\` had no effect: ${statement.behind[0]} is not on stage`,
            );
          } else {
            sprite.zorder = target.zorder - 1;
          }
        }
        if (previous === undefined) stage.sprites.push(sprite);
        else stage.sprites[stage.sprites.indexOf(previous)] = sprite;
        for (const warning of placement.warnings ?? []) warnings.push(warning);
        applied.push({ kind: "show", tag, image: match.name, attributes: match.attributes });
        requires.add("sprite");
        break;
      }
      case "hide": {
        if (statement.transition !== undefined) stage.transition = statement.transition;
        const index = stage.sprites.findIndex((sprite) => sprite.tag === statement.tag);
        if (index < 0) {
          warnings.push(`\`hide ${statement.tag}\` had no effect: that tag is not on stage`);
        } else {
          stage.sprites.splice(index, 1);
          applied.push({ kind: "hide", tag: statement.tag });
        }
        break;
      }
      default:
        throw new StageError(`internal: unhandled statement ${JSON.stringify(statement.kind)}`);
    }
  }

  stage.updatedAt = Date.now();
  return { applied, warnings, requires: [...requires] };
}

/** Next z-order above everything currently placed. */
function defaultZorder(sprites) {
  return sprites.reduce((highest, sprite) => Math.max(highest, sprite.zorder ?? 0), 0) + 1;
}

/** Clamp a numeric property. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Find a sprite by image name, tolerating an omitted attribute group: `show
 * eileen` resolves to `eileen happy` when that is the only `eileen` image.
 *
 * @param manifest the asset manifest.
 * @param name the requested image name.
 * @returns the matched sprite record, or `undefined`.
 */
export function resolveSprite(manifest, name) {
  const exact = manifest.sprites.find((sprite) => sprite.name === name);
  if (exact !== undefined) return exact;
  // The capped `sprites` list is presentation only; the complete index is what
  // validation resolves against, so an image the caps trimmed still works.
  const indexed = manifest.spriteIndex?.[name];
  if (indexed !== undefined) {
    return {
      name,
      tag: indexed.tag,
      attributes: indexed.attributes,
      url: indexed.url,
      path: indexed.path,
      width: indexed.width,
      height: indexed.height,
      ...(indexed.layered === true
        ? { layered: true, groups: indexed.groups, layers: indexed.layers, base: indexed.base }
        : {}),
    };
  }
  const components = name.split(/\s+/);
  const tag = components[0];
  const attributes = components.slice(1);
  if (attributes.length === 0) {
    const candidates = manifest.sprites.filter((sprite) => sprite.tag === tag);
    if (candidates.length === 0) return undefined;
    // Prefer the plainest expression so a bare tag stays stable across calls.
    return candidates.slice().sort((a, b) => a.attributes.length - b.attributes.length)[0];
  }
  const withAttributes = manifest.sprites.find(
    (sprite) =>
      sprite.tag === tag &&
      attributes.every((attribute) => sprite.attributes.includes(attribute)),
  );
  return withAttributes;
}

/**
 * Find a background by id, tolerating a `bg ` prefix and the `bg`/`background`
 * spellings.
 * @param manifest the asset manifest.
 * @param name the requested background name.
 * @returns the matched background record, or `undefined`.
 */
export function findBackground(manifest, name) {
  const normalised = name.replace(/^(bg|background)[\s_]+/i, "");
  const candidates = [name, normalised, `bg ${normalised}`, `background ${normalised}`];
  for (const candidate of candidates) {
    const exact = manifest.backgrounds.find(
      (entry) => entry.name.toLowerCase() === candidate.toLowerCase(),
    );
    if (exact !== undefined) return exact;
  }
  return manifest.backgrounds.find(
    (entry) => entry.name.toLowerCase().includes(normalised.toLowerCase()) && normalised.length > 0,
  );
}

/** The self-correction payload: what the model may use instead. */
export function manifestAlternatives(manifest) {
  return {
    tags: manifest.tags.slice(0, 40).map((entry) => ({
      tag: entry.tag,
      attributes: entry.expressions.map((expression) => expression.label),
    })),
    tagCount: manifest.tags.length,
  };
}

/**
 * Turn a resolved transform property bag into concrete placement fields,
 * applying the safe-area rule that keeps sprites off the user's dialogue
 * layout.
 *
 * @param props resolved transform properties.
 * @param options.autoAvoid and safeArea.
 * @returns the placement fields, plus any warning produced.
 */
function placementFor(props, options) {
  const placement = {
    xpos: typeof props.xpos === "number" ? props.xpos : 0.5,
    ypos: typeof props.ypos === "number" ? props.ypos : 1,
    xanchor: typeof props.xanchor === "number" ? props.xanchor : 0.5,
    yanchor: typeof props.yanchor === "number" ? props.yanchor : 1,
    xoffset: typeof props.xoffset === "number" ? props.xoffset : 0,
    yoffset: typeof props.yoffset === "number" ? props.yoffset : 0,
    warnings: [],
  };
  const safe = options.safeArea;
  if (safe === undefined || safe.length === 0) return placement;
  if (props.xoffset !== undefined || props.yoffset !== undefined) {
    // An explicit offset is the model deliberately overriding placement.
    return placement;
  }
  const collision = safe.find((rect) => rect.coversX === true);
  if (collision === undefined) return placement;
  if (!options.autoAvoid) {
    placement.warnings.push(
      `this placement sits inside the reserved area "${collision.id}" that the user laid out in the layout editor; move it to left/right or raise ypos`,
    );
    return placement;
  }
  const target = placement.xpos < 0.5 ? collision.x - 0.02 : collision.x + collision.w + 0.02;
  const shifted = clamp(target, 0.02, 0.98);
  placement.xpos = shifted;
  placement.warnings.push(
    `auto-avoid shifted this sprite from xpos ${collision.x.toFixed(2)} to ${shifted.toFixed(2)} to clear the reserved area "${collision.id}"`,
  );
  return placement;
}
