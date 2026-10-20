/**
 * The per-VN profile the agent writes, and the overlay it applies.
 *
 * A scan of a shipped game is a guess: scripts are `.rpyc`-only, a font is
 * chosen by a `define` the reader cannot evaluate, a dialogue box is sized by a
 * `style` that lives in a file nobody can decompile. An agent reading the same
 * game can see all of that and write it down. So the agent's answer is kept as
 * a small JSON file per game and applied ON TOP of the scan — the scan stays
 * the source of the pictures, the archives and the script text, and the file
 * only overrides what it states. A missing, half-written or malformed file
 * therefore degrades to "the scan alone", never to an empty manifest.
 *
 * The directory is under the plugin's own data home rather than inside the
 * plugin's source tree: it is generated content, and a checkout that grew a
 * `game/` directory of machine-written profiles would show up in every diff.
 * Paths are passed in fully joined, so this module never has to know which of
 * the two roots is in use.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * Profile sections the overlay may replace.
 *
 * Only these are honoured. An agent that invents a section must not be able to
 * corrupt one the client reads structurally (a malformed `backgrounds` entry
 * would break the menu), so anything outside this list is dropped rather than
 * merged — and `inspectProfileConfig` reports the drop rather than staying
 * silent about it.
 *
 * `characters` and `sprites` are listed because the scan cannot always derive
 * them: a `Character(...)` declaration lives in a `.rpyc` that may not be
 * decompilable, and a sprite tag (`qc`) can point at a directory spelled
 * differently (`images/qicheng/`). An agent that worked those out needs
 * somewhere to put them. They are passed through as ordinary object sections —
 * this module does not know the manifest's final shape for them (the scan may
 * hold a list where the profile holds a map keyed by tag), so merging them into
 * the manifest is the caller's job.
 */
export const OVERLAY_SECTIONS = [
  "game",
  "dialogbox",
  "layout",
  "choice",
  "theme",
  "transcript",
  "characters",
  "sprites",
];

/**
 * A directory name that is safe on every filesystem and still recognisable.
 *
 * The name comes from the game, so it can contain `:`, `/`, `\` or a trailing
 * dot — separators, or illegal on Windows. A name that reduces to nothing falls
 * back to a literal rather than becoming an empty path segment, which would
 * write the profile into the parent directory.
 */
export function profileDirName(name, fallback = "vn") {
  const cleaned = String(name ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
  return cleaned.length === 0 ? fallback : cleaned;
}

/** Read one profile file, or undefined when it is absent or unreadable. */
export function readProfile(dir) {
  if (typeof dir !== "string" || dir.length === 0) return undefined;
  try {
    if (!existsSync(dir)) return undefined;
    const raw = JSON.parse(readFileSync(dir, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return raw;
  } catch {
    // A half-written or malformed profile counts as none: the scan stands.
    return undefined;
  }
}

/**
 * Does a profile describe the game that is loaded now?
 *
 * The folder is named after the GAME's name, so two different games that call
 * themselves the same thing share one folder — and because the name is the only
 * key, the second game silently inherits the first one's overrides, which can
 * re-skin it with another VN's colours, font and box geometry. The save tool
 * records the directory the profile was written for, so a profile naming a
 * different one is the neighbour's.
 *
 * Either side being unknown answers `true`: a profile written before the field
 * existed must keep applying, so the guard only ever rejects a provable
 * mismatch. Both sides are expected already resolved to the same kind of path
 * (the caller passes what `resolveGameDir` returned).
 */
export function profileBelongsToGame(savedGameDir, loadedGameDir) {
  if (typeof savedGameDir !== "string" || savedGameDir.length === 0) return true;
  if (typeof loadedGameDir !== "string" || loadedGameDir.length === 0) return true;
  return samePath(savedGameDir, loadedGameDir);
}

/**
 * Path equality for two spellings of one directory.
 *
 * The two sides come from different places — a JSON file a model wrote versus a
 * resolved config value — so they differ in separators, a trailing separator or
 * case without meaning anything by it. Case is folded only where the filesystem
 * does.
 */
function samePath(left, right) {
  const normalize = (value) => {
    const slashed = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" || process.platform === "darwin" ? slashed.toLowerCase() : slashed;
  };
  return normalize(left) === normalize(right);
}

/**
 * The keys of each section that something downstream actually reads.
 *
 * These are copied from the manifest `lib/manifest.js` builds, because that is
 * the shape a section has once the scan has run: a key outside them is written
 * into the manifest by `applyProfile` and then read by nobody — no client rule,
 * no stage lookup — so it must be reported rather than counted as applied.
 *
 * A section with no entry here has no fixed shape: `theme`'s keys are CSS
 * variable names, `transcript` is the agent's own prose, and `characters` /
 * `sprites` are whatever the scan and the agent agreed on for that game.
 * Whitelisting those would reject the very corrections the sections exist for.
 */
const KNOWN_KEYS = {
  dialogbox: new Set([
    "height",
    "yalign",
    "opacity",
    "fill",
    "textColor",
    "textSize",
    "font",
    "fontPath",
    "fontUrl",
    "textboxImage",
    "textboxSource",
    "textboxImageAlign",
    "textboxImageBounds",
    "textboxImageBox",
    "nameColor",
    "nameSize",
    "nameboxImage",
    "nameboxBounds",
    // The say box's extra pieces (see `moduleNode`). `imageUrl` and `quickMenu`
    // are derived, so they are not writable and stay out of this table.
    "modules",
  ]),
  layout: new Set([
    "textboxHeight",
    "textboxYalign",
    "nameXpos",
    "nameYpos",
    "nameXalign",
    "nameboxWidth",
    "nameboxHeight",
    "nameboxBorders",
    "nameboxTile",
    "dialogueXpos",
    "dialogueYpos",
    "dialogueWidth",
    "dialogueTextXalign",
    "choiceButtonWidth",
    "choiceButtonHeight",
    "choiceButtonBorders",
  ]),
  choice: new Set([
    "width",
    "height",
    "borders",
    "textIdleColor",
    "textHoverColor",
    "textSize",
    "idleBackground",
    "hoverBackground",
  ]),
  game: new Set(["name", "version", "screen", "mainMenuMusic", "showName"]),
};

/**
 * The kinds a dialogue-box module may be, and the fields each one reads.
 *
 * A module is one absolutely positioned rectangle the browser draws over the
 * composer. The list is closed on purpose: every kind here is one the client
 * knows how to render, so a profile cannot invent a shape that the browser then
 * silently skips while the receipt says "applied".
 */
const MODULE_KINDS = new Set(["box", "image", "text", "button", "bar"]);
const MODULE_FITS = new Set(["stretch", "contain", "cover", "none"]);
const MODULE_ACTIONS = new Set(["settings", "music", "memory", "hide", "skip"]);
const MODULE_ALIGNS = new Set(["left", "center", "right"]);
const MODULE_VALIGNS = new Set(["top", "middle", "bottom"]);
/** How many modules one game may carry. */
const MODULE_CAP = 40;

/** A bounded string that cannot smuggle CSS syntax into an inline style. */
function moduleText(value, limit = 300) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > limit) return undefined;
  if (/[;{}]|url\(/i.test(text)) return undefined;
  return text;
}

/** A finite number inside `range`, or undefined. */
function moduleNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, number));
}

/**
 * One module, filtered to the fields the client reads.
 *
 * @returns the node, or undefined when it has no usable kind or rectangle —
 *   a module without a rectangle cannot be drawn anywhere, and guessing a
 *   position would put art in a place the game never had.
 */
function moduleNode(value) {
  if (!isPlainObject(value)) return undefined;
  if (!MODULE_KINDS.has(value.kind)) return undefined;
  const rect = value.rect;
  if (!isPlainObject(rect)) return undefined;
  const x = moduleNumber(rect.x, -100000, 100000);
  const y = moduleNumber(rect.y, -100000, 100000);
  const w = moduleNumber(rect.w, 1, 100000);
  const h = moduleNumber(rect.h, 1, 100000);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  const node = { kind: value.kind, rect: { x, y, w, h } };
  const z = moduleNumber(value.z, -1000, 1000);
  if (z !== undefined) node.z = z;
  if (typeof value.visible === "boolean") node.visible = value.visible;
  const opacity = moduleNumber(value.opacity, 0, 1);
  if (opacity !== undefined) node.opacity = opacity;
  const image = moduleText(value.image);
  if (image !== undefined) node.image = image;
  if (MODULE_FITS.has(value.fit)) node.fit = value.fit;
  const color = moduleText(value.color, 64);
  if (color !== undefined) node.color = color;
  const textColor = moduleText(value.textColor, 64);
  if (textColor !== undefined) node.textColor = textColor;
  const trackColor = moduleText(value.trackColor, 64);
  if (trackColor !== undefined) node.trackColor = trackColor;
  const radius = moduleNumber(value.radius, 0, 10000);
  if (radius !== undefined) node.radius = radius;
  const size = moduleNumber(value.size, 1, 1000);
  if (size !== undefined) node.size = size;
  const text = moduleText(value.text);
  if (text !== undefined) node.text = text;
  if (MODULE_ALIGNS.has(value.align)) node.align = value.align;
  if (MODULE_VALIGNS.has(value.valign)) node.valign = value.valign;
  if (MODULE_ACTIONS.has(value.action)) node.action = value.action;
  const value01 = moduleNumber(value.value, 0, 1);
  if (value01 !== undefined) node.value = value01;
  if (isPlainObject(value.border)) {
    const border = {};
    const borderColor = moduleText(value.border.color, 64);
    if (borderColor !== undefined) border.color = borderColor;
    const width = moduleNumber(value.border.width, 0, 1000);
    if (width !== undefined) border.width = width;
    if (Object.keys(border).length > 0) node.border = border;
  }
  if (isPlainObject(value.hover)) {
    const hover = {};
    const hoverImage = moduleText(value.hover.image);
    if (hoverImage !== undefined) hover.image = hoverImage;
    const hoverColor = moduleText(value.hover.color, 64);
    if (hoverColor !== undefined) hover.color = hoverColor;
    if (Object.keys(hover).length > 0) node.hover = hover;
  }
  // `source` is the scan's own note about where the rectangle came from; a
  // profile may restate it, and it changes nothing the client draws.
  if (value.source === "screen" || value.source === "flow" || value.source === "profile") {
    node.source = value.source;
  }
  return node;
}

/**
 * A `dialogbox.modules` list, filtered to nodes the client can draw.
 *
 * @returns `{ nodes, dropped }` — the surviving nodes and the indices of the
 *   ones that were dropped, so the report can name `modules[3]` instead of
 *   claiming the whole section applied.
 */
function moduleList(value) {
  const nodes = [];
  const dropped = [];
  for (const [index, item] of value.entries()) {
    if (nodes.length >= MODULE_CAP) {
      dropped.push(index);
      continue;
    }
    const node = moduleNode(item);
    if (node === undefined) {
      dropped.push(index);
      continue;
    }
    nodes.push(node);
  }
  return { nodes, dropped };
}

/** Is this a JSON object, as opposed to an array, `null` or a scalar? */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The fields one `characters.<variable>` patch may correct.
 *
 * A cast entry is a small record the scan builds (`name`, `color`, `image`,
 * `spriteTagUnresolved`), so a patch that names a field outside it would change
 * nothing the dialogue box reads while looking like a successful override.
 */
const CHARACTER_FIELDS = new Set(["name", "color", "image", "spriteTagUnresolved"]);

/**
 * The fields one `sprites.<tag>` patch may correct.
 *
 * The scan's `sprites` is a LIST of presentation records that `lib/stage.js`
 * resolves `show` statements against; a patch therefore edits entries in place
 * and never replaces the list, or the stage would stop resolving every sprite
 * the profile did not mention. A tag the scan did not find cannot be added here:
 * a record needs an asset URL, and only the scan knows how to mint one.
 */
const SPRITE_FIELDS = new Set([
  "name",
  "tag",
  "attributes",
  "url",
  "path",
  "width",
  "height",
  "source",
]);

/**
 * Normalise one section exactly the way the overlay applies it.
 *
 * `profileOverlay` and `inspectProfileConfig` must agree — a report that
 * describes a different filter than the one that runs would be worse than no
 * report — so both call this and neither restates the rules.
 *
 * Unknown keys are KEPT in `values`: `applyProfile` writes them into the
 * manifest, and the report names them so the agent learns nothing reads them.
 * Silently dropping them here would make the tool lie in the other direction
 * ("applied" while nothing changed) or hide a typo behind a quiet success.
 *
 * The two game-keyed sections (`characters`, `sprites`) are the exception: their
 * top-level keys come from the game, so only the FIELDS inside a patch can be
 * checked, and an unknown field is dropped from `values` — the merge filters it
 * by the same table, so keeping it here would only make this report disagree
 * with what the merge does.
 *
 * @returns `undefined` when the section is not an object at all, otherwise
 *   `{ values, unknown, bad }` — the keys to apply, the keys outside the
 *   section's known table, and the known keys whose value has an unusable
 *   shape.
 */
function sectionValues(section, value) {
  if (!isPlainObject(value)) return undefined;
  const known = KNOWN_KEYS[section];
  const values = {};
  const unknown = [];
  const bad = [];
  for (const [key, item] of Object.entries(value)) {
    // Both empty values mean "keep what the scan found"; see `profileOverlay`.
    if (item === null || item === undefined) continue;
    if (known !== undefined && !known.has(key)) {
      unknown.push(key);
      values[key] = item;
      continue;
    }
    // `game.name` decides which profile directory is read back and `version` is
    // displayed as read; a blank one states nothing, so it is reported rather
    // than written. An empty `mainMenuMusic` or `showName` is a real answer.
    if (section === "game" && (key === "name" || key === "version")) {
      if (typeof item !== "string" || item.length === 0) {
        bad.push(key);
        continue;
      }
    }
    if (section === "game" && key === "screen") {
      // The client multiplies these into `cqw` units, so an axis has to be a
      // number or it is unusable. Only the axes the profile states are taken —
      // `applyProfile` merges them into the scanned canvas, so `{ h: 720 }`
      // keeps the scanned width instead of blanking it, which would collapse
      // every dialogue-box measurement to a default.
      if (!isPlainObject(item)) {
        bad.push(key);
        continue;
      }
      const axes = {};
      for (const axis of ["w", "h"]) {
        const number = item[axis];
        if (number === undefined || number === null) continue;
        if (!Number.isFinite(number)) {
          axes.invalid = true;
          break;
        }
        axes[axis] = Number(number);
      }
      if (axes.invalid === true) {
        bad.push(key);
        continue;
      }
      delete axes.invalid;
      if (Object.keys(axes).length > 0) values.screen = axes;
      continue;
    }
    if (section === "dialogbox" && key === "modules") {
      // The client draws this list directly, so every node is checked here and
      // the report names the ones it dropped: `applyProfile` merges an array
      // wholesale, and a node the client cannot draw would otherwise reach the
      // browser as a silently missing piece of the game's own dialogue box.
      if (!Array.isArray(item)) {
        bad.push(key);
        continue;
      }
      const { nodes, dropped } = moduleList(item);
      for (const index of dropped) bad.push(`modules[${index}]`);
      // `[]` is a real statement ("draw none of this"), which is how an agent
      // removes a module the scan found.
      if (nodes.length > 0 || item.length === 0) values.modules = nodes;
      continue;
    }
    if (section === "characters" || section === "sprites") {
      // These two sections are keyed by GAME data (a variable name, a sprite
      // tag), so the keys themselves cannot be checked — but the fields inside
      // each patch can, and a patch field nothing reads would be written and
      // then silently ignored by the merge. Report those with the key they sit
      // under, because "characters.qc.colour" is the edit the agent has to make.
      if (!isPlainObject(item)) {
        bad.push(key);
        continue;
      }
      const allowed = section === "characters" ? CHARACTER_FIELDS : SPRITE_FIELDS;
      const kept = {};
      for (const [field, fieldValue] of Object.entries(item)) {
        if (!allowed.has(field)) {
          unknown.push(`${key}.${field}`);
          continue;
        }
        kept[field] = fieldValue;
      }
      if (Object.keys(kept).length > 0) values[key] = kept;
      continue;
    }
    values[key] = item;
  }
  return { values, unknown, bad };
}

/**
 * The overlay a profile contributes, or `undefined` when it contributes nothing.
 *
 * `null` and `undefined` both mean "keep the value the scan found". The profile
 * exists to state which values the agent deliberately overrode, so a field it
 * left empty is not a statement about that field — and because
 * `renpy_read_manifest` hands back the same shape it takes, an agent pasting
 * that digest into `renpy_save_vn` would otherwise carry every `null` the scan
 * could not fill (a missing `game.version`, say) straight into the manifest and
 * erase the values the scan did find. Treating `null` as "clear this" would
 * make the one safe round-trip the tool advertises lose data.
 *
 * Clearing is therefore stated with a value, not with absence: `""` for a
 * string, `[]` for a list. Those are read as real values (except for the two
 * `game` fields noted below), which keeps "I meant empty" distinguishable from
 * "I did not say".
 *
 * @param profile parsed `vn.json`, or undefined.
 * @returns sections to merge over the manifest, already filtered to the ones
 *   this plugin will honour.
 */
export function profileOverlay(profile) {
  if (profile === undefined || profile === null || typeof profile !== "object") return undefined;
  const overlay = {};
  for (const section of OVERLAY_SECTIONS) {
    const value = profile[section];
    if (section === "transcript") {
      // The agent's own notes: kept whole, read by nobody but the UI. Replacing
      // rather than merging is the right rule for a free-text section — the
      // second write is the whole new note, not a patch on the first one.
      if (isPlainObject(value)) overlay.transcript = value;
      continue;
    }
    const normalised = sectionValues(section, value);
    if (normalised === undefined) continue;
    if (Object.keys(normalised.values).length > 0) overlay[section] = normalised.values;
  }
  return Object.keys(overlay).length === 0 ? undefined : overlay;
}

/**
 * What a given `config` argument will actually do to the scan.
 *
 * `profileOverlay` drops whatever it does not recognise, which is deliberate —
 * a model must not be able to break a section the client reads structurally —
 * but the drop is silent, so an agent that wrote `sprites` instead of `game`,
 * `dialogueWidht` instead of `dialogueWidth`, or `{ w: "1920" }` instead of a
 * number, reports success while the interface does not change, and repeats the
 * mistake in its next profile. That is not a crash, it is a false "applied".
 *
 * This states the same rule as feedback instead of as a filter. It takes the
 * `renpy_save_vn` argument rather than a stored file: a stored profile also
 * carries `savedAt` / `gameDir` / `name`, which are metadata a caller would
 * otherwise be told are unknown sections.
 *
 * @returns `{ accepted, ignored, malformed, unknownKeys }` — the sections that
 *   contribute at least one key something reads, the sections outside
 *   `OVERLAY_SECTIONS`, the recognised places whose value has an unusable
 *   shape (a section that merges nothing at all, or `game.screen` when only
 *   one axis is wrong), and the `section.key` paths that will be written but
 *   are not part of any section's known shape — a typo, or a field this
 *   version does not read.
 */
export function inspectProfileConfig(config) {
  const accepted = [];
  const ignored = [];
  const malformed = [];
  const unknownKeys = [];
  if (!isPlainObject(config)) {
    return { accepted, ignored, malformed, unknownKeys };
  }
  for (const [section, value] of Object.entries(config)) {
    if (!OVERLAY_SECTIONS.includes(section)) {
      ignored.push(section);
      continue;
    }
    const normalised = sectionValues(section, value);
    if (normalised === undefined) {
      malformed.push(section);
      continue;
    }
    for (const key of normalised.unknown) unknownKeys.push(`${section}.${key}`);
    for (const key of normalised.bad) malformed.push(`${section}.${key}`);
    // Only a key the scan or the client actually reads makes a section
    // "applied"; a section holding nothing but typos changed nothing, however
    // faithfully those typos were copied into the manifest.
    const applied = Object.keys(normalised.values).filter((key) => !normalised.unknown.includes(key));
    if (applied.length > 0) {
      accepted.push(section);
      continue;
    }
    // A section made entirely of unknown keys is already named precisely by
    // `unknownKeys`, down to the key. Repeating it as a malformed section would
    // point the agent at `layout` when the thing it has to fix is
    // `layout.dialogueWidht`, which is the one edit that makes it work.
    //
    // A section whose keys all held `null` is a different case: nothing was
    // misspelled, the agent simply restated the digest unchanged. It is
    // reported as malformed — it contributed nothing — but not as an unknown
    // key, because the spelling was fine.
    if (normalised.unknown.length === 0 && normalised.bad.length === 0) {
      malformed.push(section);
    }
  }
  return { accepted, ignored, malformed, unknownKeys };
}

/**
 * Merge an overlay into a manifest, in place, and report what moved.
 *
 * Sections merge one level deep: `dialogbox.textColor` from the profile wins
 * while `dialogbox.fill` from the scan survives, and the same is true of `game`
 * — replacing that section wholesale used to drop the scanned `game.screen`,
 * which is the canvas size every `cqw` measurement in the dialogue box is
 * relative to, so a profile correcting the title silently collapsed the whole
 * UI to defaults.
 *
 * `game.screen` is the one nested object the client reads field by field, so it
 * gets a shallow merge of its own: stating only `{ h: 720 }` keeps the scanned
 * width rather than deleting it.
 *
 * Keys outside a section's known table are written too — the profile asked for
 * them, and dropping them here would make the stored file and the manifest
 * disagree — but they are left out of the returned paths. That list is shown as
 * "what took effect", and a key nothing reads never takes effect: listing it
 * would be the same false success this module exists to prevent, in the other
 * direction. `inspectProfileConfig` names those keys at save time, which is
 * where the agent can still act on them.
 *
 * @returns the list of `section` / `section.key` (and `section.key.sub`) paths
 *   whose value something downstream actually reads.
 */
export function applyProfile(manifest, overlay, diagnostics = undefined) {
  const changed = [];
  if (overlay === undefined || manifest === null || typeof manifest !== "object") return changed;
  const unmatched = [];
  for (const [section, values] of Object.entries(overlay)) {
    const current = manifest[section];
    if (section === "transcript") {
      if (sameJson(current, values)) continue;
      manifest[section] = values;
      changed.push(section);
      continue;
    }
    if (section === "characters") {
      applyCastPatches(manifest, values, changed);
      continue;
    }
    if (section === "sprites") {
      applySpritePatches(manifest, values, changed, unmatched);
      continue;
    }
    // A section has no table when its shape belongs to the game or the agent
    // (`theme`); every key it holds counts as read.
    const known = KNOWN_KEYS[section];
    if (!isPlainObject(current)) {
      // An array is not a merge target: assigning keys onto one would leave
      // them invisible after the manifest is serialised, which is precisely the
      // silent "the override was applied" this module exists to prevent.
      if (sameJson(current, values)) continue;
      manifest[section] = values;
      const applied = Object.keys(values).filter((key) => known === undefined || known.has(key));
      if (applied.length > 0) changed.push(section);
      continue;
    }
    for (const [key, value] of Object.entries(values)) {
      if (section === "game" && key === "screen" && isPlainObject(current[key])) {
        for (const [axis, number] of Object.entries(value)) {
          if (sameJson(current[key][axis], number)) continue;
          current[key][axis] = number;
          changed.push(`${section}.${key}.${axis}`);
        }
        continue;
      }
      if (sameJson(current[key], value)) continue;
      current[key] = value;
      if (known === undefined || known.has(key)) changed.push(`${section}.${key}`);
    }
  }
  if (diagnostics !== undefined && unmatched.length > 0) diagnostics.unmatched = unmatched;
  return changed;
}

/**
 * Merge `characters.<variable>` patches into the scanned cast.
 *
 * The cast is a map keyed by the Ren'Py variable, and each entry is a record the
 * scan assembled from a `Character(...)` declaration. Editing field by field is
 * what lets a profile correct the display name the scan mis-read without
 * deleting the `image` tag it read correctly — which one-level assignment (the
 * rule for flat sections) would do. A variable the scan never found is added,
 * because a game whose scripts could not be decompiled has an empty cast and the
 * profile is then the only source for it.
 */
function applyCastPatches(manifest, values, changed) {
  if (!isPlainObject(values)) return;
  const cast = isPlainObject(manifest.characters) ? manifest.characters : (manifest.characters = {});
  for (const [variable, patch] of Object.entries(values)) {
    if (!isPlainObject(patch)) continue;
    const entry = isPlainObject(cast[variable]) ? cast[variable] : (cast[variable] = {});
    for (const [field, value] of Object.entries(patch)) {
      if (!CHARACTER_FIELDS.has(field)) continue;
      if (sameJson(entry[field], value)) continue;
      entry[field] = value;
      changed.push(`characters.${variable}.${field}`);
    }
  }
}

/**
 * Patch the scanned sprite list in place, one record at a time.
 *
 * `manifest.sprites` is a list the stage resolves `show` statements against, so
 * a profile keyed by tag edits the records it names and leaves the rest of the
 * list untouched. Replacing the list — the generic rule for sections — would
 * wipe every sprite the agent did not mention, and `resolveSprite` would start
 * rejecting valid `show` commands in a way that looks like a broken game.
 *
 * A tag no record carries cannot be created: a record needs an asset URL, and
 * only the scan knows how to mint one from the profile's relative path. Those
 * keys are reported back instead of being quietly dropped, because the agent
 * has to know its patch landed nowhere.
 */
function applySpritePatches(manifest, values, changed, unmatched) {
  if (!isPlainObject(values)) return;
  if (!Array.isArray(manifest.sprites)) return;
  for (const [key, patch] of Object.entries(values)) {
    if (!isPlainObject(patch)) continue;
    // A tag names a character and a name names one expression of it, so a
    // patch may address either; the tag form intentionally hits every
    // expression, which is how "this character's sprites are misnamed" is
    // stated once.
    const targets = manifest.sprites.filter((sprite) => sprite?.tag === key || sprite?.name === key);
    if (targets.length === 0) {
      unmatched.push(`sprites.${key}`);
      continue;
    }
    for (const sprite of targets) {
      for (const [field, value] of Object.entries(patch)) {
        if (!SPRITE_FIELDS.has(field)) continue;
        if (sameJson(sprite[field], value)) continue;
        sprite[field] = value;
        changed.push(`sprites.${key}.${field}`);
      }
    }
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
