/**
 * Build the in-memory **asset manifest** for one Ren'Py game directory.
 *
 * The manifest is the single contract between the host half and the browser
 * half: what background to paint, what sprites exist with which attributes,
 * what the dialogue box / choice buttons look like, and which theme tokens the
 * skin should override. It is JSON-serialisable and intentionally small —
 * every image is referenced by an opaque asset `url`, never by bytes.
 *
 * Asset discovery reads two sources, matching how Ren'Py itself resolves an
 * image name:
 *
 *   1. **Loose files** under `game/images/` (and the classic `game/` root
 *      folders), named the Ren'Py way: `eileen happy.png` is image `eileen`
 *      with attribute `happy`.
 *   2. **`.rpa` archives**, read through the bundled RPA-3.0 reader.
 *
 * Filename-derived names are then overridden by any explicit
 * `image <name> = <file>` declaration in the game's `.rpy` scripts, because
 * the script is authoritative when it speaks.
 */
import { closeSync, openSync, readSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import {
  AUDIO_EXTENSIONS,
  BACKGROUND_PREFIXES,
  FONT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  findScripts,
  listFiles,
  readAssignments,
  readAudioAliases,
  readCharacterDeclarations,
  readLayeredImages,
  readSplashscreen,
  readStyleBlocks,
  readScreenBlocks,
  readTextIfPresent,
  readTransforms,
  resolveMenuMusic,
  resolveStyleNumber,
  stripComments,
  styleBackgroundAlign,
  styleBackgroundPath,
} from "./renpy.js";
import { isRpa, openRpa } from "./rpa3.js";
import { decompileRpycBatch, rpycDiagnostics } from "./rpyc.js";
import { pngDominantColor, pngOpaqueBounds } from "./png.js";
import { DURATION_EXTENSIONS, readAudioDuration } from "./audio.js";

/** Attributes that describe a file variant, not a character expression. */
const VARIANT_ATTRIBUTES = new Set([
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "small",
  "medium",
  "large",
  "big",
  "hd",
  "sd",
  "thumb",
  "icon",
  "preview",
  "mini",
  "tiny",
  "blink",
  "open",
  "closed",
  "half",
  "lips",
  "mouth",
  "eyes",
  "brow",
  "nvl",
  "b",
  "cry",
  "n",
]);

/** Cap on sprites listed individually before per-tag grouping kicks in. */
const SPRITE_LIST_CAP = 200;

/**
 * Cap on the gallery the background switcher shows. The list is searchable, so
 * a generous cap is fine, but it rides in the manifest JSON on every settings
 * response — a 4000-entry game would carry megabytes for a control most users
 * never open.
 */
const GALLERY_CAP = 600;

/** The say-window plate and name plate Ren'Py's own template draws. */
const CONVENTIONAL_TEXTBOX = ["gui/textbox.png", "gui/textbox.webp", "gui/textbox.jpg", "gui/textbox.jpeg"];
const CONVENTIONAL_NAMEBOX = ["gui/namebox.png", "gui/namebox.webp", "gui/namebox.jpg", "gui/namebox.jpeg"];

/**
 * Cap on the dialogue-plate candidates the manifest offers.
 *
 * The settings page draws one thumbnail per entry, so the list has to stay
 * small enough to read at a glance; a game that ships dozens of them gets the
 * ones it actually names first and the sweep fills the rest.
 */
const PLATE_CANDIDATE_CAP = 12;

/**
 * A file that reads like a dialogue plate but was never named anywhere.
 *
 * `textbox` covers the Ren'Py template and most reworked GUIs; `say` catches
 * plates living under a `say/` folder (CSE); `dialogue`/`message` are the two
 * other spellings seen in the wild. The sweep is a last resort — everything the
 * game names is added before it runs.
 */
const PLATE_CANDIDATE_PATTERN = /(textbox|say|dialogue|message)/i;

/**
 * Cap on the font list the composer font picker offers. A game with an
 * unholy number of faces is not worth carrying in every settings response.
 */
const FONT_LIST_CAP = 80;

/**
 * A filename a human wants to read under a thumbnail:
 * `images/backgrounds/beach2red_bg.png` -> `beach2red bg`.
 */
function galleryName(relativePath) {
  const stem = basename(relativePath).replace(/\.[^.]+$/, "");
  const spaced = stem.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced.length === 0 ? stem : spaced;
}

/**
 * Expressions listed per character tag. A Ren'Py game can declare hundreds of
 * attribute combinations per character (one popular game ships 1875 for a
 * single tag); the prompt only needs the base expressions, and the tag entry
 * still reports the real total.
 */
const EXPRESSION_CAP = 24;

/**
 * Read the pixel dimensions of a PNG/JPEG/WebP/GIF image from its header.
 * Only the leading bytes are consumed, so this is cheap on a big library.
 * @param bytes the file (or entry) head, at least 32 bytes where possible.
 * @param extension lower-case extension including the dot.
 * @returns `{ width, height }` or `undefined` when the format is not read.
 */
export function readImageSize(bytes, extension) {
  try {
    if (extension === ".png" && bytes.length >= 24 && bytes.toString("latin1", 1, 4) === "PNG") {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (extension === ".gif" && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (extension === ".webp" && bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF") {
      const kind = bytes.toString("latin1", 12, 16);
      if (kind === "VP8X") {
        const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width, height };
      }
      if (kind === "VP8 ") {
        return {
          width: bytes.readUInt16LE(26) & 0x3fff,
          height: bytes.readUInt16LE(28) & 0x3fff,
        };
      }
      if (kind === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if ((extension === ".jpg" || extension === ".jpeg") && bytes.length >= 4) {
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions.
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        const length = bytes.readUInt16BE(offset + 2);
        if (isSof) {
          return {
            width: bytes.readUInt16BE(offset + 7),
            height: bytes.readUInt16BE(offset + 5),
          };
        }
        if (length < 2) return undefined;
        offset += 2 + length;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * The `limit` directories holding the most files, as `{ dir, count }`.
 *
 * Used for a size-only summary of the asset index: the full path list is far
 * too large to hand to a model, but "there are 812 images and most of them are
 * under images/sprites" is what decides where to look next. Files directly in
 * the game directory are counted under `.`.
 *
 * @param paths game-relative `/`-separated paths.
 * @param limit how many directories to keep.
 * @returns `{ dir, count }[]`, largest first, ties broken by name.
 */
function topDirectories(paths, limit) {
  const counts = new Map();
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "." : path.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([dir, count]) => ({ dir, count }));
}

/**
 * Derive a Ren'Py image name from a file's basename, the way the engine's
 * automatic image definition does: the filename without extension, split on
 * whitespace, with the `images/` prefix dropped.
 *
 * @param relativePath path relative to the game directory, `/`-separated.
 * @returns `{ name, tag, attributes }` or `undefined` for non-displayables.
 */
export function imageNameFromPath(relativePath) {
  const withoutExt = relativePath.slice(0, relativePath.length - extname(relativePath).length);
  const parts = withoutExt.split("/").filter((part) => part.length > 0);
  while (parts.length > 0 && parts[0].toLowerCase() === "images") parts.shift();
  if (parts.length === 0) return undefined;
  const file = parts[parts.length - 1];
  // Only the file name forms the image name; directories are just organisation.
  // Ren'Py's automatic image name splits on whitespace, and that is all this
  // reads: splitting on `-`/`_` as well would corrupt real attribute names
  // (`art-angry-a-l.webp` would become `art angry a l`), so games that spell
  // components with dashes are covered by their explicit `image` statements
  // instead.
  const components = file
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (components.length === 0) return undefined;
  const [tag, ...rest] = components;
  return { name: components.join(" "), tag, attributes: rest };
}

/**
 * Extract explicit `image <name> = <expression>` declarations.
 *
 * Ren'Py image statements routinely wrap the displayable in
 * `im.MatrixColor(...)`, `Composite(...)`, `Flip(...)` and friends, and those
 * expressions usually span several lines, so declarations are scanned with a
 * real line walker that joins an indented continuation onto the statement
 * that opened it.
 *
 * The right-hand side is searched for the first quoted string that looks like
 * a displayable path; a declaration whose expression holds no literal path
 * (a `layeredimage`, or a name built from variables) is reported as
 * `dynamic: true` so the caller can drop it rather than invent a path.
 *
 * @param source raw `.rpy` text.
 * @returns `Map` of image name to `{ path, dynamic }`.
 */
export function readImageStatements(source) {
  const declared = new Map();
  const text = stripComments(source);
  const lines = text.split(/\r?\n/);
  let pending = null;

  const flush = () => {
    if (pending === null) return;
    const quoted = /["']([^"']+\.(?:png|jpe?g|webp|gif|avif|bmp|tga|svg))["']/i.exec(pending.expression);
    declared.set(pending.name, {
      path: quoted === null ? undefined : quoted[1].replace(/\\/g, "/"),
      dynamic: quoted === null,
    });
    pending = null;
  };

  for (const line of lines) {
    if (pending !== null) {
      // A statement continues while its expression has unbalanced brackets.
      pending.expression += ` ${line.trim()}`;
      if (balanced(pending.expression)) flush();
      continue;
    }
    const match = /^[ \t]*image[ \t]+(.+?)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (match === null) continue;
    const name = match[1].trim().replace(/\s+/g, " ");
    // `image <name> = ...` with `layer`/`attribute` keywords is a
    // layeredimage, not a plain image definition.
    if (name.length === 0 || name.includes('"') || /\b(attribute|layer)\b/.test(name)) continue;
    pending = { name, expression: match[2].trim() };
    if (balanced(pending.expression)) flush();
  }
  flush();
  return declared;
}

/** Whether an expression's brackets and quotes are balanced. */
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
 * Collect every script source the manifest should parse: loose `.rpy` files on
 * disk plus every `.rpy` inside the game's `.rpa` archives.
 *
 * Archive-only games (GoToSnowTown ships a single `archive.rpa` with everything
 * inside, including `scripts/gui.rpy`) were invisible to the first
 * implementation, which only walked the disk: they produced zero transforms,
 * zero `image` statements, and a default GUI fallback. The archive reader is
 * the same one the asset index uses, so script reads and image reads agree on
 * one view of the game.
 *
 * @param gameDir absolute path of the game directory.
 * @param assets the `{ archives }` index from `indexAssets`.
 * @returns `Array<{ path, text }>`.
 */
/**
 * Scripts that define GUI state, in decompilation priority order. Anything else
 * is story script: it is decompiled only if the cap below leaves room.
 */
const SCRIPT_RANK = new Map([
  ["gui", 0],
  ["options", 1],
  ["screens", 2],
  ["script", 3],
]);

/**
 * Cap on the `.rpyc` files decompiled per game. Bytecode-only games can ship
 * thousands, each costing a share of a Python run, while the skin only needs
 * the GUI-defining scripts. 48 comfortably covers gui/options/screens/script
 * plus the handful of other files that usually hold screens or images.
 */
const MAX_DECOMPILED_SCRIPTS = 48;

/**
 * Collect every script source the manifest should parse, in Ren'Py's load
 * precedence for one script path:
 *
 *   loose `.rpy`  >  loose `.rpyc`  >  archived `.rpy`  >  archived `.rpyc`
 *
 * Loose files override archives (as Ren'Py's loader does), and a `.rpy` beats
 * the `.rpyc` compiled from it. Paths are compared as game-relative,
 * forward-slashed, lowercased keys: `listFiles` returns absolute Windows paths
 * while archive entries are archive-relative, so comparing raw labels would
 * let an archived `gui.rpy` overwrite the loose one (`names.set` in buildManifest
 * is last-wins).
 *
 * `tl/` (translations) is ignored: it only carries dialogue translations, and
 * its `gui.rpy` copies would otherwise be read as the game's own GUI values.
 *
 * Archive-only games (GoToSnowTown ships a single `archive.rpa` with everything
 * inside, including `scripts/gui.rpy`) were invisible to the first
 * implementation, which only walked the disk.
 *
 * @param gameDir absolute path of the game directory.
 * @param assets the archive index from `indexAssets`.
 * @param diagnostics optional collector; when passed, the reader fills in the
 *   `scripts` block the manifest exposes. It is an out-parameter rather than a
 *   wider return type so the array return every caller already depends on stays
 *   the same shape.
 * @returns `Array<{ path, text }>`.
 */
export function readScriptSources(gameDir, assets, diagnostics = undefined) {
  const sources = [];
  const taken = new Set(); // keys of scripts already accepted
  const keyOfLoose = (file) =>
    relative(gameDir, file).replace(/\\/g, "/").toLowerCase();
  const keyOfArchive = (name) => name.replace(/\\/g, "/").toLowerCase();
  const isTranslation = (key) => /(^|\/)tl\//.test(key);
  const archives = Array.from(assets.openedArchives ?? assets.archives.values());

  // Everything a reader needs to tell "this game has no gui.rpy" apart from
  // "gui.rpy was never decompiled", which look identical in the values.
  const found = { looseRpy: 0, looseRpyc: 0, archivedRpy: 0, archivedRpyc: 0 };
  let unreadableCandidates = 0;

  // 1. Loose `.rpy`. The main game level comes first (findScripts prefers it).
  const addLoose = (file) => {
    const key = keyOfLoose(file);
    if (taken.has(key)) return;
    const text = readTextIfPresent(file);
    if (text === undefined) return;
    taken.add(key);
    found.looseRpy += 1;
    sources.push({ path: file, text });
  };
  const scripts = findScripts(gameDir);
  for (const path of [scripts.gui, scripts.options, scripts.screens]) {
    if (path !== undefined) addLoose(path);
  }
  const looseFiles = listFiles(gameDir, {});
  for (const file of looseFiles) {
    if (extname(file).toLowerCase() === ".rpy") addLoose(file);
  }

  // 2. Bytecode candidates, one per script key. Each carries a lazy `read` so
  //    that bytes are only pulled for the scripts we actually decompile.
  const claims = new Map(); // key -> { label, rpycName, read, loose }
  for (const file of looseFiles) {
    if (extname(file).toLowerCase() !== ".rpyc") continue;
    const rpyKey = keyOfLoose(file).replace(/\.rpyc$/, ".rpy");
    if (taken.has(rpyKey) || claims.has(rpyKey) || isTranslation(rpyKey)) continue;
    found.looseRpyc += 1;
    claims.set(rpyKey, {
      label: file.replace(/\.rpyc$/i, ".rpy"),
      rpycName: relative(gameDir, file).replace(/\\/g, "/"),
      read: () => readFileSync(file),
      loose: true,
    });
  }

  // Archive index: first archive wins for a duplicate name, as the loader does.
  const archiveRpy = new Map(); // key -> { label, read }
  const archiveRpyc = new Map(); // key -> { label, rpycName, read, loose }
  for (const archive of archives) {
    for (const name of archive.names) {
      const ext = extname(name).toLowerCase();
      if (ext !== ".rpy" && ext !== ".rpyc") continue;
      const rpyKey = keyOfArchive(name.replace(/\.rpyc$/i, ".rpy"));
      if (isTranslation(rpyKey)) continue;
      if (ext === ".rpy") {
        if (!archiveRpy.has(rpyKey)) {
          found.archivedRpy += 1;
          archiveRpy.set(rpyKey, {
            label: name,
            read: () => archive.read(name).toString("utf8"),
          });
        }
      } else if (!archiveRpyc.has(rpyKey)) {
        found.archivedRpyc += 1;
        archiveRpyc.set(rpyKey, {
          label: name.replace(/\.rpyc$/i, ".rpy"),
          rpycName: name,
          read: () => archive.read(name),
          loose: false,
        });
      }
    }
  }
  for (const [key, entry] of archiveRpyc) {
    // An archived `.rpy` beats the archived `.rpyc` compiled from it.
    if (!claims.has(key) && !archiveRpy.has(key)) claims.set(key, entry);
  }

  // 3. Decompile the highest-ranked candidates, in one bounded batch.
  const rank = (label) =>
    SCRIPT_RANK.get(basename(label).replace(/\.rpy$/i, "").toLowerCase()) ?? 4;
  const ranked = [...claims].sort(
    ([a, x], [b, y]) => rank(x.label) - rank(y.label) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const batch = [];
  const batchMeta = [];
  for (const [key, entry] of ranked.slice(0, MAX_DECOMPILED_SCRIPTS)) {
    let bytes;
    try {
      bytes = entry.read();
    } catch {
      unreadableCandidates += 1;
      continue; // unreadable: that script is simply absent
    }
    // The index prefix keeps staged names unique even if two paths collide.
    batch.push({ name: `${batch.length}/${entry.rpycName}`, bytes });
    batchMeta.push({ key, entry });
  }
  const skippedByCap = Math.max(0, ranked.length - batchMeta.length - unreadableCandidates);
  const decompiledResult = batch.length > 0
    ? decompileRpycBatch(batch)
    : { files: new Map(), diagnostics: { reason: null, attempted: 0, decompiled: 0, failed: 0 } };
  const decompiled = decompiledResult.files;
  const decompiledText = new Map(); // key -> { label, text, loose }
  batchMeta.forEach(({ key, entry }, index) => {
    const text = decompiled.get(batch[index].name);
    if (text !== undefined) {
      decompiledText.set(key, { label: entry.label, text, loose: entry.loose });
    }
  });

  // 4. Accept in precedence order. A failed decompile falls through to the
  //    archived `.rpy` of the same name, if there is one.
  for (const [key, decoded] of decompiledText) {
    if (!decoded.loose) continue;
    taken.add(key);
    sources.push({ path: decoded.label, text: decoded.text });
  }
  for (const [key, entry] of archiveRpy) {
    if (taken.has(key) || (claims.has(key) && decompiledText.has(key))) continue;
    try {
      const text = entry.read();
      taken.add(key);
      sources.push({ path: entry.label, text });
    } catch {
      // unreadable entry: skip, the same way a corrupt loose file is skipped
    }
  }
  for (const [key, decoded] of decompiledText) {
    if (decoded.loose || taken.has(key)) continue;
    taken.add(key);
    sources.push({ path: decoded.label, text: decoded.text });
  }

  if (diagnostics !== undefined) {
    // A manifest built from zero scripts still reports every value as if it were
    // read. Naming the reason here is what makes "the game has no gui.rpy" and
    // "unrpyc is not installed" distinguishable at the point of use.
    const totalFound =
      found.looseRpy + found.looseRpyc + found.archivedRpy + found.archivedRpyc;
    const reason = totalFound === 0
      ? "no .rpy or .rpyc scripts were found loose or inside the archives"
      : sources.length === 0
        ? decompiledResult.diagnostics?.reason ??
          "every script candidate failed to read or decompile"
        : null;
    diagnostics.scripts = {
      /** Script files the scan saw, split by where they live. */
      found: { ...found, total: totalFound },
      /** Scripts whose text the manifest actually parsed. */
      decompiled: sources.length,
      /** Candidates handed to the decompiler in this run. */
      attempted: decompiledResult.diagnostics?.attempted ?? 0,
      /** Candidates the per-game cap left unread; 0 means everything was tried. */
      skippedByCap,
      /** Candidates that could not even be read off disk or out of an archive. */
      unreadable: unreadableCandidates,
      /** Why no script text was parsed; null when at least one was. */
      reason,
      /**
       * Filled in by `buildManifest` with `rpycDiagnostics()`: which Python and
       * which unrpyc were found. The batch counters above already answer "did
       * this run work"; this answers "is the tool even here", which is the
       * difference between a game with no scripts and a machine without unrpyc.
       */
      tool: null,
    };
  }

  return sources;
}


/**
 * The painted region of a plate image, or `undefined` when it cannot be
 * measured (not a PNG, unreadable) and the caller should use the whole file.
 */
function paintedBox(assets, relativePath) {
  if (extname(relativePath).toLowerCase() !== ".png") return undefined;
  const bytes = assets.read(relativePath);
  return bytes === undefined ? undefined : pngOpaqueBounds(bytes);
}

/**
 * `rpycDiagnostics()` wrapped so a manifest build never fails on it.
 *
 * The diagnosis matters (it is what separates "this game has no gui.rpy" from
 * "unrpyc is not installed"), but it is still a diagnosis: losing it must not
 * cost the caller the manifest, which already carries every other field.
 */
function safeRpycDiagnostics() {
  try {
    return rpycDiagnostics();
  } catch (error) {
    return { reason: `the rpyc diagnosis itself failed: ${String(error?.message ?? error)}` };
  }
}

/** Uniform resource handle for one displayable, loose or archived. */
class AssetSource {  constructor({ url, archives }) {
    this.url = url;
    this.archives = archives;
  }

  /** @returns the entry bytes, or `undefined` when unreadable. */
  bytes(relativePath) {
    const archive = this.archives.get(relativePath);
    if (archive !== undefined) {
      try {
        return archive.read(relativePath);
      } catch {
        return undefined;
      }
    }
    try {
      return readFileSync(this.archives.looseRoot(relativePath));
    } catch {
      return undefined;
    }
  }
}

/**
 * Build the asset index for one game directory: every displayable path known
 * to the game, whether it lives loose on disk or inside an `.rpa`.
 *
 * @param gameDir absolute path of the game directory.
 * @param options.signal cooperative cancellation.
 * @param options.limit cap on indexed files; `truncated` reports when it bit.
 * @returns `{ paths, audio, videos, fonts, archives, openedArchives, read,
 *   readHead, resolve, truncated, looseRoot }`. `paths` and friends hold the
 *   spelling the owner uses; `resolve` finds an entry in any letter case.
 */
function indexAssets(gameDir, { signal, limit = 20000 } = {}) {
  // One walk serves both the archive pass and the loose pass. `truncated` tells
  // the caller the game held more files than `limit`, so a missing resource is
  // visible instead of silently absent.
  const report = { truncated: false };
  const files = listFiles(gameDir, { signal, limit, report });

  // Audio, video and fonts are indexed beside images: they are never
  // displayables the stage can show, but the playlist and the splash screen need
  // the same loose-or-archived resolution the images get.
  const mediaKind = (relativePath) => {
    const ext = extname(relativePath).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) return "audio";
    if (VIDEO_EXTENSIONS.has(ext)) return "video";
    if (FONT_EXTENSIONS.has(ext)) return "font";
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    return undefined;
  };

  /**
   * One entry per asset, keyed by its lower-cased relative path so a case
   * mismatch between the archive and the disk still finds the file. `name` keeps
   * the spelling the owner uses (the disk, or the archive index).
   */
  const entries = new Map();
  /** relative path (owner spelling) -> owning archive; loose files are absent. */
  const archives = new Map();

  const archiveFiles = files
    .filter((file) => extname(file).toLowerCase() === ".rpa")
    .map((file) => file.slice(gameDir.length + 1).replace(/\\/g, "/"))
    // Ren'Py's index_archives sorts archives in reverse by name, and the first
    // archive holding a name answers for it (renpy/loader.py).
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  // Every archive that opened, including ones that contribute no image. A
  // script-only archive (Castle&Myosotis ships `scripts.rpa` with no art) is
  // absent from `archives`, so readScriptSources must walk this list or the
  // game's `gui.rpy` values silently fall back to the defaults.
  const openedArchives = [];
  for (const relativeArchive of archiveFiles) {
    if (signal?.aborted === true) break;
    // A corrupt, truncated or unsupported archive is skipped, not fatal: the
    // game's other archives and loose files must still be indexed.
    const archivePath = join(gameDir, relativeArchive);
    if (!isRpa(archivePath)) continue;
    let archive;
    try {
      archive = openRpa(archivePath);
    } catch {
      continue;
    }
    openedArchives.push(archive);
    for (const name of archive.names) {
      const key = name.toLowerCase();
      if (entries.has(key) || mediaKind(name) === undefined) continue;
      entries.set(key, { name, kind: mediaKind(name), archive });
      archives.set(name, archive);
    }
  }

  // Loose files are tried before any archive (Ren'Py's load_from_filesystem runs
  // first), so a loose file replaces an archived entry of the same name.
  for (const file of files) {
    if (signal?.aborted === true) break;
    const relativePath = file.slice(gameDir.length + 1).replace(/\\/g, "/");
    const kind = mediaKind(relativePath);
    if (kind === undefined) continue;
    const key = relativePath.toLowerCase();
    const previous = entries.get(key);
    // Two loose spellings differing only by case cannot both exist on Windows;
    // on a case-sensitive disk the first listed one wins.
    if (previous !== undefined && previous.archive === undefined) continue;
    if (previous !== undefined) archives.delete(previous.name);
    entries.set(key, { name: relativePath, kind, archive: undefined });
  }

  const paths = [];
  const audio = [];
  const videos = [];
  const fonts = [];
  const all = [];
  for (const entry of entries.values()) {
    all.push(entry.name);
    if (entry.kind === "image") paths.push(entry.name);
    else if (entry.kind === "audio") audio.push(entry.name);
    else if (entry.kind === "video") videos.push(entry.name);
    else fonts.push(entry.name);
  }

  /**
   * Canonical entry for a path given in any letter case, or `undefined`. The
   * returned `name` is the spelling the disk or archive uses, so callers can
   * key on it.
   */
  const resolve = (relativePath) =>
    entries.get(String(relativePath).replace(/\\/g, "/").toLowerCase());

  const read = (relativePath) => {
    const entry = resolve(relativePath);
    const name = entry?.name ?? relativePath;
    if (entry?.archive !== undefined) {
      try {
        return entry.archive.read(name);
      } catch {
        return undefined;
      }
    }
    try {
      const absolute = join(gameDir, name);
      if (!statSync(absolute).isFile()) return undefined;
      return readFileSync(absolute);
    } catch {
      return undefined;
    }
  };

  /**
   * The first `length` bytes of an asset. Image dimensions live in the first
   * few KiB, so measuring a library must not pull every file through memory.
   */
  const readHead = (relativePath, length = 65536) => {
    const entry = resolve(relativePath);
    const name = entry?.name ?? relativePath;
    try {
      if (entry?.archive !== undefined) return entry.archive.slice(name, 0, length);
      const absolute = join(gameDir, name);
      const total = statSync(absolute).size;
      const buffer = Buffer.alloc(Math.min(length, total));
      const fd = openSync(absolute, "r");
      try {
        if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, 0);
      } finally {
        closeSync(fd);
      }
      return buffer;
    } catch {
      return undefined;
    }
  };

  return {
    paths,
    all,
    archives,
    openedArchives,
    read,
    readHead,
    resolve,
    audio,
    videos,
    fonts,
    /** True when `limit` cut the walk short, so some files were never seen. */
    truncated: report.truncated === true,
    /** Absolute path of a loose entry, so a header can be read without the whole file. */
    looseRoot: (relativePath) => join(gameDir, relativePath),
  };
}

/**
 * Every image and video the game ships, for the "opening media" picker.
 *
 * `manifest.backgrounds` is the wrong list for that control: a splash video is
 * not a displayable, so it never reaches the background index at all. Reusing
 * `indexAssets` also keeps the picker and `/asset?p=` from disagreeing about
 * what exists — the archive map that decides whether a path is servable is the
 * same one that decides whether it is listed.
 *
 * @param root the path the user configured (the game directory, or the Ren'Py
 *   root containing it).
 * @param options.signal cooperative cancellation.
 * @returns `{ images, videos }` — sorted, de-duplicated game-relative paths.
 */
export function listGameMedia(root, { signal } = {}) {
  const { gameDir } = resolveGameDir(root);
  const assets = indexAssets(gameDir, { signal });
  return {
    images: [...new Set(assets.paths)].sort(),
    videos: [...new Set(assets.videos)].sort(),
  };
}

/**
 * Read the first and last 64 KiB of one asset, however it is stored.
 *
 * A duration is derived from headers, so the whole file must not be buffered:
 * a 36-track game would otherwise pull hundreds of megabytes through memory to
 * measure it. `assets.read` already returns the whole entry for archives, so
 * the slice happens here rather than in the archive reader.
 *
 * @param assets the index from `indexAssets`.
 * @param relativePath asset path.
 * @param size total byte length, when the caller already knows it.
 * @returns `{ head, tail, size }` or `undefined`.
 */
function readAssetWindow(assets, relativePath, size) {
  const archive = assets.archives.get(relativePath);
  if (archive !== undefined) {
    const limit = 65536;
    try {
      const total = archive.sizeOf(relativePath);
      if (total === undefined) return undefined;
      return {
        head: archive.slice(relativePath, 0, limit),
        tail: archive.slice(relativePath, Math.max(0, total - limit), limit),
        size: total,
      };
    } catch {
      return undefined;
    }
  }
  const absolute = assets.looseRoot(relativePath);
  let total = size;
  if (total === undefined) {
    try {
      total = statSync(absolute).size;
    } catch {
      return undefined;
    }
  }
  const head = Buffer.alloc(Math.min(65536, total));
  const tail = Buffer.alloc(Math.min(65536, total));
  let fd;
  try {
    fd = openSync(absolute, "r");
    if (head.length > 0) readSync(fd, head, 0, head.length, 0);
    if (tail.length > 0) readSync(fd, tail, 0, tail.length, Math.max(0, total - tail.length));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A failed close on a file we only read is not worth reporting.
      }
    }
  }
  return { head, tail, size: total };
}

/** Shortest track the playlist keeps, in seconds. */
const MIN_TRACK_SECONDS = 10;

/**
 * Build the playlist from every audio file under `game/audio/music`, falling
 * back to `game/audio` and then to the whole game directory.
 *
 * Tracks at or below `MIN_TRACK_SECONDS` are dropped: a game's music folder
 * routinely also holds stingers, jingles and one-shot cues, and a playlist
 * that shuffles into a 2-second cue sounds broken rather than random. A track
 * whose duration cannot be read is KEPT — dropping it would silently hide real
 * music on a game whose container this build does not parse.
 *
 * @param assets the index from `indexAssets`.
 * @param options.signal cooperative cancellation.
 * @returns `Array<{ path, title, directory, duration?, url? }>` sorted by path.
 */
function buildPlaylist(assets, { signal } = {}) {
  const prefixes = ["audio/music/", "audio/sound/", "audio/"];
  const scored = [];
  for (const relativePath of assets.audio) {
    const lower = relativePath.toLowerCase();
    const rank = prefixes.findIndex((prefix) => lower.startsWith(prefix));
    // A game with no `audio/` at all still gets a playlist from its loose
    // audio rather than an empty list.
    scored.push({ relativePath, rank: rank < 0 ? prefixes.length : rank });
  }
  if (scored.length === 0) return [];
  const best = Math.min(...scored.map((entry) => entry.rank));
  const selected = scored.filter((entry) => entry.rank === best);

  const tracks = [];
  for (const { relativePath } of selected) {
    if (signal?.aborted === true) break;
    const extension = extname(relativePath).toLowerCase();
    const directory = relativePath.includes("/")
      ? relativePath.slice(0, relativePath.lastIndexOf("/"))
      : "";
    const file = basename(relativePath);
    const title = file.slice(0, file.length - extension.length);
    const record = { path: relativePath, title, directory };
    if (DURATION_EXTENSIONS.has(extension)) {
      const window = readAssetWindow(assets, relativePath);
      if (window !== undefined) {
        const duration = readAudioDuration(window.head, window.tail, window.size, extension);
        if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
          // The filter is the whole reason durations are read; a measured
          // non-positive value is a parse artefact, not a real length.
          if (duration <= MIN_TRACK_SECONDS) continue;
          record.duration = Math.round(duration * 10) / 10;
        }
      }
    }
    tracks.push(record);
  }
  tracks.sort((a, b) => a.path.localeCompare(b.path));
  return tracks;
}

/**
 * `true` when a game-relative path is one of the indexed assets.
 *
 * Video is checked alongside images because a splash screen is usually a
 * `.webm` in `game/video/` — an index that only knew about images silently
 * rejected the one file the extractor was looking for.
 *
 * @param assets the index from `indexAssets`.
 * @param relativePath candidate path.
 */
function isKnownPath(assets, relativePath) {
  const normalised = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const known = (path) =>
    assets.archives.has(path) || assets.paths.includes(path) || assets.videos.includes(path);
  if (known(normalised)) return true;
  const withoutImages = normalised.replace(/^images\//i, "");
  if (withoutImages !== normalised && known(withoutImages)) return true;
  const bare = basename(normalised);
  return assets.paths.some((path) => basename(path) === bare);
}

/**
 * Decide what the browser should play as this game's opening.
 *
 * Priority is the user's: a movie cutscene the `label splashscreen:` actually
 * plays, then the largest full-screen still it shows, then `presplash.png`,
 * then the main-menu background. Anything after the first step is a
 * best-effort stand-in, so the manifest says which one was taken.
 *
 * @param splash the `readSplashscreen` result.
 * @param assets the index from `indexAssets`.
 * @param options.screen declared canvas size, for the "full screen" test.
 * @param options.mainMenuBackground a background path the menu already uses.
 * @returns `{ kind, path, source, candidates }` or `undefined`.
 */
/**
 * How long a still opening may stay on screen before the skin drops it.
 *
 * A cutscene ends on its own, but an `<img>` never fires `ended`, so an image
 * splash with no bound is a splash that never goes away — which is exactly the
 * "stuck on the splash forever" report. Ren'Py's own interactive splashes
 * announce their own length with `timer <n>`; when the game says nothing the
 * fallback is a few seconds, because a still carries no information that a
 * longer look would reveal.
 */
const DEFAULT_SPLASH_SECONDS = 4;
const MIN_SPLASH_SECONDS = 2;
const MAX_SPLASH_SECONDS = 12;

/**
 * @param timers every `timer <n>` found in the splash label and its screens,
 *   plus the label's summed `pause` seconds.
 * @returns seconds to show a still, clamped so a game cannot pin the UI.
 */
function splashSecondsFor(timers) {
  const finite = (Array.isArray(timers) ? timers : []).filter(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (finite.length === 0) return DEFAULT_SPLASH_SECONDS;
  // The longest screen in the chain is the closest single number to "how long
  // does this label take"; summing would over-count a chain whose screens are
  // alternatives.
  const longest = Math.max(...finite);
  return Math.min(Math.max(longest, MIN_SPLASH_SECONDS), MAX_SPLASH_SECONDS);
}

/**
 * Pick the opening to replay; see the priority described above the constants.
 */
function resolveSplash(splash, assets, { screen, mainMenuBackground } = {}) {
  // A label's pauses run in sequence, so their sum is one candidate length;
  // `timer` values sit beside it because an interactive screen may be longer.
  const duration = splashSecondsFor([...(splash.timers ?? []), splash.pauseSeconds ?? 0]);
  const video = splash.videos.find((path) => isKnownPath(assets, path));
  if (video !== undefined) {
    return { kind: "video", path: video, source: "splashscreen", candidates: splash.videos };
  }
  // A full-screen still: the splash art is 1920x1080 in every game probed,
  // while logos are a few hundred pixels. Prefer an image whose own size
  // matches the canvas, and fall back to the first one when nothing is
  // measurable (a `.rpa` entry still yields bytes, so this rarely degrades).
  let best;
  for (const path of splash.images) {
    if (!isKnownPath(assets, path)) continue;
    const bytes = assets.readHead(path);
    const size = bytes === undefined ? undefined : readImageSize(bytes, extname(path).toLowerCase());
    const full = size !== undefined && screen !== undefined && size.width >= screen.w * 0.9 && size.height >= screen.h * 0.9;
    const score = full ? 2 : 1;
    if (best === undefined || score > best.score) best = { path, size, score };
  }
  if (best !== undefined) {
    return { kind: "image", path: best.path, source: "splashscreen", duration, candidates: splash.images };
  }
  for (const fallback of ["presplash.png", "images/presplash.png", "gui/presplash.png"]) {
    if (isKnownPath(assets, fallback)) {
      return { kind: "image", path: fallback, source: "presplash", duration, candidates: [] };
    }
  }
  if (mainMenuBackground !== undefined && isKnownPath(assets, mainMenuBackground)) {
    return { kind: "image", path: mainMenuBackground, source: "main-menu", duration, candidates: [] };
  }
  return undefined;
}


/**
 * Normalise an arbitrary hex/named colour to `#rrggbb` when possible.
 * @param value the declared colour (`'#c9c9c9'`, `"#fff"`, `None`).
 * @returns the normalised colour, or `undefined`.
 */
export function normaliseColor(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(text);
  if (hex === null) return undefined;
  const body = hex[1];
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`.toLowerCase();
  }
  if (body.length === 8) return `#${body.slice(0, 6)}`.toLowerCase();
  return `#${body.toLowerCase()}`;
}

/**
 * Convert `#rrggbb` to `[r, g, b]` byte components.
 * @param color normalised hex colour.
 * @returns the components, or `undefined`.
 */
export function colorToRgb(color) {
  const hex = normaliseColor(color);
  if (hex === undefined) return undefined;
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Lighten a colour toward white by an amount in `0..1`.
 * @param color normalised hex colour.
 * @param amount blend amount.
 * @returns the lightened colour.
 */
export function lighten(color, amount) {
  const rgb = colorToRgb(color);
  if (rgb === undefined) return undefined;
  const blend = (channel) => Math.round(channel + (255 - channel) * amount);
  return `#${rgb.map((channel) => blend(channel).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Relative luminance as defined by WCAG, used to pick a readable foreground.
 * @param color normalised hex colour.
 * @returns luminance in `0..1`, or `undefined`.
 */
export function luminance(color) {
  const rgb = colorToRgb(color);
  if (rgb === undefined) return undefined;
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/**
 * Pick `#ffffff`/`#111111` for a background so text stays readable.
 * @param background normalised hex colour.
 * @returns the foreground colour.
 */
export function readableForeground(background) {
  const lum = luminance(background);
  if (lum === undefined) return undefined;
  return lum > 0.45 ? "#111111" : "#ffffff";
}

/**
 * Build the asset manifest for one game directory.
 *
 * @param root the path the user configured (the game directory, or the
 *   Ren'Py root containing it).
 * @param options.signal cooperative cancellation.
 * @param options.assetUrl function mapping a relative displayable path to the
 *   URL the browser half should fetch.
 * @param options.palette colour overrides from the settings page, keyed by
 *   palette slot (`accent`, `hover`, …). Empty means the game decides.
 * @returns the manifest object, plus a derived `theme` token suggestion.
 */
export function buildManifest(root, { signal, assetUrl, palette } = {}) {
  const { gameDir, root: gameRoot } = resolveGameDir(root);
  // A slot list the settings page pinned; empty entries mean "follow the game"
  // rather than "no colour" (see the palette block further down).
  const paletteOverrides = palette !== null && typeof palette === "object" ? palette : {};
  // Asset index first: its archive map decides which scripts are readable.
  const assets = indexAssets(gameDir, { signal });

  // All script sources, loose and archived (see readScriptSources). The
  // diagnostics object collects why each one was or was not read, so the
  // manifest can say "no gui.rpy was found" instead of implying a default is the
  // game's own value.
  const diagnostics = {};
  const sources = readScriptSources(gameDir, assets, diagnostics);

  // GUI/style assignments from gui.rpy / options.rpy / screens.rpy. Loose
  // copies were already prioritised inside readScriptSources' `seen` set, and
  // equal names get the same value anyway, so order within `sources` suffices.
  // NOTE: `source.path` is either a Windows absolute path (loose) or an
  // archive-relative forward-slash path, so the separator class covers both.
  const names = new Map();
  for (const source of sources) {
    if (!/(^|[\\/])(gui|options|screens)\.rpy$/i.test(source.path)) continue;
    for (const [key, value] of readAssignments(source.text)) names.set(key, value);
  }

  // Style blocks from every script, not only the three conventional ones.
  //
  // A game often sizes its say window in `style window:` rather than through
  // gui.*, and the style is what is painted, so these override the gui.*
  // defaults below where both exist. Restricting the scan to gui/options/screens
  // missed a real case: CSE re-declares the whole dialogue box in
  // `newScreens.rpy`, so every geometry value fell back to a default while the
  // manifest looked perfectly normal.
  const styleBlocks = new Map();
  for (const source of sources) {
    for (const [name, props] of readStyleBlocks(source.text)) {
      const merged = styleBlocks.get(name) ?? new Map();
      for (const [prop, raw] of props) merged.set(prop, raw);
      styleBlocks.set(name, merged);
    }
  }
  const styleNumber = (style, prop) => resolveStyleNumber(styleBlocks.get(style)?.get(prop), names);
  /** A quoted string property (`font "x.ttf"`, `color "#fff"`), unquoted; anything else is undefined. */
  const styleQuoted = (style, prop) => {
    const raw = styleBlocks.get(style)?.get(prop)?.trim();
    const match = raw === undefined ? null : /^["']([^"']*)["']$/.exec(raw);
    return match === null ? undefined : match[1];
  };
  /** A displayable a style paints with (`background Image("gui/x.png")`), matched case-insensitively. */
  const styleImage = (style, prop) => {
    const path = styleBackgroundPath(styleBlocks.get(style)?.get(prop));
    if (path === undefined) return undefined;
    const wanted = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    return assets.paths.find((entry) => entry.toLowerCase() === wanted);
  };

  const screenWidth =
    typeof names.get("config.screen_width") === "number"
      ? names.get("config.screen_width")
      : 1920;
  const screenHeight =
    typeof names.get("config.screen_height") === "number"
      ? names.get("config.screen_height")
      : 1080;

  const getNumber = (key, fallback) =>
    typeof names.get(key) === "number" ? names.get(key) : fallback;
  const getColor = (key, fallback) => normaliseColor(names.get(key)) ?? fallback;
  const getString = (key, fallback) =>
    typeof names.get(key) === "string" ? names.get(key) : fallback;

  /** The same three readers, but `undefined` instead of a default, so a caller
   *  can tell "the game declared nothing" apart from "the game declared zero". */
  const numberOr = (key) => (typeof names.get(key) === "number" ? names.get(key) : undefined);
  const stringOr = (key) => (typeof names.get(key) === "string" ? names.get(key) : undefined);
  const colorOr = (key) => normaliseColor(names.get(key));

  /**
   * Where each resolved value came from, keyed by manifest path.
   *
   * A manifest of bare values cannot distinguish "the game says 33" from "nobody
   * said anything and 33 is Ren'Py's default", and every consumer downstream —
   * the settings page, the model reading the digest, a user comparing two games —
   * needs that difference. `"default"` is the load-bearing entry: it is the only
   * way to see that a field was never read.
   */
  const provenance = {};

  /**
   * Pick the first candidate that resolved, recording which layer won.
   *
   * @param field the manifest path the value lands on (`"dialogbox.font"`).
   * @param candidates `{ source, value }` entries in priority order.
   * @param fallback used when every candidate is undefined, recorded as `default`.
   */
  const firstDefined = (field, candidates, fallback) => {
    for (const candidate of candidates) {
      if (candidate.value === undefined || candidate.value === null) continue;
      provenance[field] = candidate.source;
      return candidate.value;
    }
    provenance[field] = "default";
    return fallback;
  };

  const transforms = new Map();
  const declaredImages = new Map();
  const layeredImages = new Map();
  for (const source of sources) {
    for (const [name, value] of readTransforms(source.text)) transforms.set(name, value);
    for (const [name, value] of readImageStatements(source.text)) declaredImages.set(name, value);
    for (const [name, value] of readLayeredImages(source.text)) layeredImages.set(name, value);
  }

  const known = new Set(assets.paths);
  /** Declared paths are written game-relative (`images/x.jpg`); the index may
   *  spell the same file with or without the leading `images/` segment. */
  const resolveKnownPath = (declaredPath) => {
    const normalised = declaredPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (known.has(normalised)) return normalised;
    const withoutImages = normalised.replace(/^images\//i, "");
    if (known.has(withoutImages)) return withoutImages;
    const bare = basename(normalised);
    return assets.paths.find((path) => basename(path) === bare);
  };
  const sizeCache = new Map();
  const sizeOf = (relativePath) => {
    if (sizeCache.has(relativePath)) return sizeCache.get(relativePath);
    const extension = extname(relativePath).toLowerCase();
    // Every PNG/GIF/WebP header and most JPEG frame headers sit in the first 4 KiB.
    // Reading 64 KiB for each of ~4000 displayables allocated and copied hundreds
    // of MB, which was most of the indexing time; the larger read is only made when
    // the small one is not enough (a JPEG behind a big EXIF block).
    const small = assets.readHead(relativePath, 4096);
    let size = small === undefined ? undefined : readImageSize(small, extension);
    if (size === undefined && small !== undefined && small.length === 4096) {
      const bytes = assets.readHead(relativePath);
      size = bytes === undefined ? undefined : readImageSize(bytes, extension);
    }
    sizeCache.set(relativePath, size);
    return size;
  };

  /**
   * How each control's geometry is written in the `screen` statements, if the
   * game restates them there.
   *
   * A `screen say:` is what the engine paints, and a commercial game routinely
   * replaces the template's say screen outright and writes the dialogue
   * geometry inline (`text what: pos (335, 905)`, `size 30`, `color '#624B34'`)
   * — the release build ships compiled scripts only, so those values exist
   * nowhere else and every style/`gui.*` value for them is dead code. This is
   * the last source tried, after style and gui.*, because it is the one being
   * painted.
   *
   * Only entries at `depth === 0` are read for absolute positions: a `pos` on a
   * `text` inside a `frame` is relative to that frame (CSE's name box is
   * `frame: pos (265, 798)` wrapping `text who`), and treating the two as the
   * same coordinate produces a plausible number in the wrong place.
   */
  const screenBlocks = new Map();
  for (const source of sources) {
    for (const [name, info] of readScreenBlocks(source.text)) {
      // The desktop definition wins: a `variant "small"` restatement is written
      // last and would otherwise replace the layout with the touch one.
      screenBlocks.set(name, info);
    }
  }
  /**
   * The first `add`/`background` entry under a screen that carries an image.
   *
   * Top-level entries are tried first and nested ones only as a fallback: a
   * `frame:` near the top of `screen say` can paint the NAME box plate, and it
   * sits above the `add` that paints the textbox, so a plain source-order scan
   * hands the name box to the dialogue box. Both are ordinary-looking image
   * paths, so the mistake only shows up as the wrong plate on screen.
   */
  const screenImage = (screen, kinds = ["add", "background"]) => {
    const entries = (screenBlocks.get(screen)?.adds ?? []).filter((entry) => kinds.includes(entry.kind));
    const ordered = [...entries.filter((entry) => entry.depth === 0), ...entries.filter((entry) => entry.depth !== 0)];
    for (const entry of ordered) {
      const path = styleBackgroundPath(entry.raw);
      if (path === undefined) continue;
      const wanted = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
      const found = assets.paths.find((candidate) => candidate.toLowerCase() === wanted);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  /** The properties of the first entry of a screen written in one of `kinds`. */
  const screenEntry = (screen, kinds) =>
    (screenBlocks.get(screen)?.adds ?? []).find(
      (entry) => kinds.includes(entry.kind) && entry.depth === 0,
    );

  /**
   * Every image name the game can display. Explicit `image` statements are
   * authoritative when they resolve to a real file; filename-derived names
   * fill in the rest.
   */
  const candidates = new Map();
  for (const relativePath of assets.paths) {
    const derived = imageNameFromPath(relativePath);
    if (derived === undefined) continue;
    const existing = candidates.get(derived.name);
    // Prefer the highest-resolution spelling of a duplicated name.
    if (existing !== undefined) {
      const previous = sizeOf(existing.relativePath);
      const candidate = sizeOf(relativePath);
      if (previous !== undefined && candidate !== undefined && candidate.width <= previous.width) continue;
    }
    candidates.set(derived.name, { ...derived, relativePath, source: "file" });
  }
  for (const [name, declaration] of declaredImages) {
    if (declaration.dynamic === true) continue;
    const resolved = resolveKnownPath(declaration.path);
    if (resolved === undefined) continue;
    const components = name.split(/\s+/);
    candidates.set(name, {
      name,
      tag: components[0],
      attributes: components.slice(1),
      relativePath: resolved,
      source: "statement",
    });
  }

  const backgrounds = [];
  const spriteCandidates = [];
  for (const candidate of candidates.values()) {
    const size = sizeOf(candidate.relativePath);
    const record = {
      name: candidate.name,
      tag: candidate.tag,
      attributes: candidate.attributes,
      url: assetUrl(candidate.relativePath),
      path: candidate.relativePath,
      source: candidate.source,
      ...(size === undefined ? {} : { width: size.width, height: size.height }),
    };
    // `images/bg/` and `images/backgrounds/` are scenery by directory, whatever
    // the filename holds: `images/backgrounds/crystal corridor.webp` splits on
    // the space into tag `crystal` with an attribute, and treating that as a
    // character put every scenery file with a space in its name on the stage.
    // `gui/` is UI chrome, so only its title/menu plate counts as a background;
    // the name-prefix test (`bg forest_day`) covers games that declare scenery
    // in image statements instead.
    const sceneryDirectory = /(^|\/)(backgrounds?|bg)\//i.test(candidate.relativePath);
    const guiArt = /^(gui|ui)\//i.test(candidate.relativePath);
    const guiPlate = guiArt && /main_?menu|game_?menu|title|splash/i.test(candidate.relativePath);
    const nameLooksLikeBackground = BACKGROUND_PREFIXES.has(candidate.tag.toLowerCase());
    if (nameLooksLikeBackground || sceneryDirectory || guiPlate) {
      backgrounds.push(record);
      continue;
    }
    // UI art (buttons, icons, the music-room `repeat 1` control) is never a
    // character. Layered characters are assembled further down and do not pass
    // through this loop. A size threshold was tried and rejected: the existing
    // fixtures use real 1x1 sprites that must still resolve.
    if (guiArt) continue;
    spriteCandidates.push(record);
  }
  backgrounds.sort((a, b) => a.name.localeCompare(b.name));

  // ── gallery: the background/CG switcher's list ──────────────────────────
  // `backgrounds` above is the wrong source for that control: it is capped,
  // sorted by name, and — because `gui/` art counts as a background by
  // convention — mostly UI chrome (buttons, scrollbars, the window icon) that
  // nobody wants behind the chat. The switcher walks the asset index by
  // DIRECTORY instead, which is how a VN itself separates scenery (`images/
  // backgrounds/`, `bg/`) from artwork (`images/cgs/`).
  const galleryKind = (relativePath) =>
    /(^|\/)cgs?\//i.test(relativePath)
      ? "cg"
      : /(^|\/)(backgrounds?|bg)\//i.test(relativePath)
        ? "background"
        : undefined;
  const gallery = [];
  for (const relativePath of assets.paths) {
    const kind = galleryKind(relativePath);
    if (kind === undefined) continue;
    // Ren'Py's gallery screens keep their own 1000px previews next to the art.
    if (/thumb/i.test(basename(relativePath))) continue;
    const size = sizeOf(relativePath);
    gallery.push({
      name: galleryName(relativePath),
      kind,
      path: relativePath,
      url: assetUrl(relativePath),
      ...(size === undefined ? {} : { width: size.width, height: size.height }),
    });
  }
  gallery.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "background" ? -1 : 1));

  // ── layered characters ──────────────────────────────────────────────────
  // A `layeredimage` has no single displayable: each group contributes one
  // layer file, named `<tag>_<group>_<attribute>` (Ren'Py's own convention).
  // Resolve each non-`default null` attribute against the asset index and keep
  // the group → attribute → url map so the stage can stack the chosen layers.
  const ATL_PROP_MAP = { xcenter: "xalign", ycenter: "yalign" };
  const BASE_PROPERTIES = new Set([
    "xpos", "ypos", "xanchor", "yanchor", "xalign", "yalign",
    "xoffset", "yoffset", "zoom", "alpha", "rotate", "zorder",
  ]);
  const findLayerPath = (fileName) => {
    const lower = fileName.toLowerCase();
    for (const path of assets.paths) {
      const base = basename(path);
      const stem = base.slice(0, base.length - extname(base).length);
      if (stem.toLowerCase() === lower) return path;
    }
    return undefined;
  };
  for (const [tag, info] of layeredImages) {
    const groups = [];
    const layers = {};
    const union = [];
    let resolved = false;
    for (const group of info.groups) {
      const attributes = [];
      for (const attribute of group.attributes) {
        const label = attribute.name;
        if (attribute.defaultNull) {
          attributes.push({ name: label, default: attribute.default, defaultNull: true });
          continue;
        }
        const fileName = group.name.length === 0 ? `${tag}_${label}` : `${tag}_${group.name}_${label}`;
        const path = findLayerPath(fileName);
        if (path === undefined) {
          attributes.push({ name: label, default: attribute.default, defaultNull: false });
          continue;
        }
        const url = assetUrl(path);
        (layers[group.name] ??= {})[label] = { url, path };
        attributes.push({ name: label, default: attribute.default, defaultNull: false, url, path });
        union.push(label);
        resolved = true;
      }
      groups.push({ name: group.name, attributes });
    }
    if (!resolved) continue; // no layer on disk → not addressable
    const base = {};
    for (const [key, value] of Object.entries(info.atl)) {
      const mapped = ATL_PROP_MAP[key] ?? key;
      if (BASE_PROPERTIES.has(mapped) && typeof value === "number") base[mapped] = value;
    }
    spriteCandidates.push({
      name: tag,
      tag,
      attributes: [...new Set(union)],
      layered: true,
      groups,
      layers,
      base,
      source: "layeredimage",
    });
  }

  /** Tag-level view: one representative URL per (tag, attribute) pair. */
  const expressionsByTag = new Map();
  for (const record of spriteCandidates) {
    if (record.attributes.length === 0) continue;
    const tag = record.tag;
    if (BACKGROUND_PREFIXES.has(tag.toLowerCase())) continue;
    const bucket = expressionsByTag.get(tag) ?? new Map();
    // A layered character is ONE sprite with many independent group
    // attributes; offer each attribute as its own expression so the model can
    // combine them (`show enid glasses thinking`), rather than one flat union
    // of every label jammed into a single line.
    const labels =
      record.layered === true ? record.attributes.map((label) => [label]) : [record.attributes];
    for (const [label] of labels) {
      const existing = bucket.get(label);
      // Two files can spell one expression; keep the wider one.
      if (
        existing === undefined ||
        (record.width ?? 0) > (existing.width ?? 0)
      ) {
        bucket.set(label, { label, name: record.name, url: record.url, width: record.width, height: record.height });
      }
    }
    expressionsByTag.set(tag, bucket);
  }

  const tags = [];
  for (const tag of [...expressionsByTag.keys()].sort()) {
    const expressions = [...expressionsByTag.get(tag).values()];
    // A character with hundreds of attribute combinations is unusable in a
    // prompt; keep the shortest labels, which are the base expressions.
    expressions.sort(
      (a, b) => a.label.split(" ").length - b.label.split(" ").length || a.label.localeCompare(b.label),
    );
    tags.push({ tag, total: expressions.length, expressions: expressions.slice(0, EXPRESSION_CAP) });
  }

  /**
   * The complete sprite index, keyed by full image name. The capped
   * `sprites`/`tags` fields above are for presentation (the model's roster and
   * the browser half's pickers); validation must resolve against this index so
   * a legitimate image the caps trimmed away is still shown.
   */
  const spriteIndex = {};
  for (const record of spriteCandidates) {
    if (record.attributes.length === 0) continue;
    spriteIndex[record.name] = {
      url: record.url,
      path: record.path,
      tag: record.tag,
      attributes: record.attributes,
      ...(record.width === undefined ? {} : { width: record.width, height: record.height }),
      ...(record.layered === true
        ? { layered: true, groups: record.groups, layers: record.layers, base: record.base }
        : {}),
    };
  }

  const sprites = spriteCandidates
    .filter((record) => record.attributes.length > 0)
    .slice(0, SPRITE_LIST_CAP)
    .map((record) => ({
      name: record.name,
      tag: record.tag,
      attributes: record.attributes,
      url: record.url,
      path: record.path,
      source: record.source,
      ...(record.width === undefined ? {} : { width: record.width, height: record.height }),
      ...(record.layered === true
        ? { layered: true, groups: record.groups, layers: record.layers, base: record.base }
        : {}),
    }));

  /**
   * A bare number written in a screen property (`size 30`), or undefined.
   * Nothing is evaluated: `gui.text_size` is not followed, because a screen
   * property that names a variable is rare and guessing it would be worse than
   * falling through to the value the same variable already gave us.
   */
  const screenScalar = (raw) => {
    if (typeof raw !== "string") return undefined;
    const text = raw.trim();
    return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : undefined;
  };
  /** A `(x, y)` pair written in a screen property (`pos (265, 798)`). */
  const screenPair = (raw) => {
    if (typeof raw !== "string") return undefined;
    const match = /^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/.exec(raw.trim());
    return match === null ? undefined : { x: Number(match[1]), y: Number(match[2]) };
  };
  /** The colour a screen property holds (`'#624B34'`), normalised. */
  const screenColor = (raw) =>
    typeof raw === "string" ? normaliseColor(raw.trim().replace(/^["']|["']$/g, "")) : undefined;
  /** The font file a screen property holds (`'fonts/x.otf'`), resolved. */
  const screenFont = (raw) => {
    if (typeof raw !== "string") return undefined;
    return resolveFontPath(raw.trim().replace(/^["']|["']$/g, ""), assets.fonts);
  };
  /**
   * The absolute position a screen entry states, split out of `pos`/`xpos`/
   * `ypos`. An axis left undefined stays undefined so a caller can merge it
   * with another source instead of having it silently become 0.
   */
  const screenPos = (entry) => {
    const properties = entry?.properties;
    if (properties === undefined) return undefined;
    const pair = screenPair(properties.get("pos"));
    if (pair !== undefined) return pair;
    const x = screenScalar(properties.get("xpos"));
    const y = screenScalar(properties.get("ypos"));
    return x === undefined && y === undefined ? undefined : { x, y };
  };

  // The say screen's own text statements. `text what` (the spoken line) sits at
  // the screen's top level, while `text who` (the speaker's name) is nested in
  // the name box's `frame:`, so position means two different things for them and
  // the two must not be read the same way.
  const sayTexts = (screenBlocks.get("say")?.adds ?? []).filter((entry) => entry.kind === "text");
  const sayWhatEntry =
    sayTexts.find((entry) => entry.depth === 0 && /^what\b/.test(entry.raw)) ??
    sayTexts.find((entry) => entry.depth === 0);
  const sayWhoEntry = sayTexts.find((entry) => /^who\b/.test(entry.raw));
  // The name box is the innermost container of `text who` that states a
  // position: a `frame` without one adds no offset, so the enclosing position
  // is still the absolute one.
  const sayNameBoxEntry =
    [...(sayWhoEntry?.ancestors ?? [])].reverse().find((outer) => screenPos(outer) !== undefined) ??
    (screenPos(sayWhoEntry) === undefined ? undefined : sayWhoEntry);

  const textboxHeight = firstDefined(
    "dialogbox.height",
    [
      { source: "style", value: styleNumber("window", "ysize") },
      { source: "gui-variable", value: numberOr("gui.textbox_height") },
    ],
    278,
  );
  const textboxYalign = firstDefined(
    "dialogbox.yalign",
    [{ source: "style", value: styleNumber("window", "yalign") }, { source: "gui-variable", value: numberOr("gui.textbox_yalign") }],
    1,
  );
  const textboxOpacity = firstDefined(
    "dialogbox.opacity",
    [{ source: "gui-variable", value: numberOr("gui.textbox_opacity") }],
    1,
  );
  /**
   * Converts a canvas-absolute y from a screen body into the offset the client
   * expects, measured from the TOP of the dialogue window.
   *
   * The client places the window first (`windowTop = (canvasH - windowH) *
   * textboxYalign`, lib/client.js) and then positions the text inside it, so a
   * screen's `pos (335, 905)` has to lose `windowTop` before it can be used.
   * CSE: 905 - 864 = 41. Doing this here rather than in the client keeps the
   * canvas height and the window geometry in one place; a consumer handed the
   * raw number would paint the line 864px too low.
   */
  const screenOffsetY = (y) =>
    typeof y !== "number" ? undefined : y - (screenHeight - textboxHeight) * textboxYalign;
  let accent = firstDefined(
    "theme.accent",
    [{ source: "settings", value: paletteOverrides.accent }, { source: "gui-variable", value: colorOr("gui.accent_color") }],
    "#4a9eff",
  );
  let hover = firstDefined(
    "theme.hover",
    [{ source: "settings", value: paletteOverrides.hover }, { source: "gui-variable", value: colorOr("gui.hover_color") }],
    accent,
  );
  const idle = firstDefined(
    "theme.idle",
    [{ source: "settings", value: paletteOverrides.idle }, { source: "gui-variable", value: colorOr("gui.idle_color") }],
    "#666666",
  );
  const sayTextColor = screenColor(sayWhatEntry?.properties.get("color"));
  const styleTextColor = normaliseColor(styleQuoted("say_dialogue", "color"));
  const guiTextColor = colorOr("gui.text_color");
  const textColor = firstDefined(
    "dialogbox.textColor",
    [
      { source: "settings", value: paletteOverrides.text },
      { source: "screen", value: sayTextColor },
      { source: "style", value: styleTextColor },
      { source: "gui-variable", value: guiTextColor },
    ],
    "#ffffff",
  );
  /**
   * The shell's own text colour, kept apart from the dialogue box's.
   *
   * The two default to the same colour — a VN whose dialogue is white wants
   * white text everywhere — but pinning one must not move the other: pinning
   * `dialogbox.textColor` used to repaint every label in the shell as well.
   * So the fallback here is the colour the GAME states, read without the
   * settings candidate, not the pinned one.
   */
  const gameTextColor = sayTextColor ?? styleTextColor ?? guiTextColor ?? "#ffffff";
  const uiText = firstDefined(
    "theme.uiText",
    [
      { source: "settings", value: paletteOverrides.uiText },
      { source: "dialogue-text", value: gameTextColor },
    ],
    gameTextColor,
  );
  const uiTextPinned = provenance["theme.uiText"] === "settings";
  let nameColor = firstDefined(
    "dialogbox.nameColor",
    [
      { source: "settings", value: paletteOverrides.name },
      { source: "screen", value: screenColor(sayWhoEntry?.properties.get("color")) },
      { source: "gui-variable", value: colorOr("gui.name_text_color") },
    ],
    accent,
  );
  const choiceIdle = firstDefined(
    "choice.textIdleColor",
    [{ source: "settings", value: paletteOverrides.choiceIdle }, { source: "gui-variable", value: colorOr("gui.choice_button_text_idle_color") }],
    idle,
  );
  const choiceHover = firstDefined(
    "choice.textHoverColor",
    [{ source: "settings", value: paletteOverrides.choiceHover }, { source: "gui-variable", value: colorOr("gui.choice_button_text_hover_color") }],
    "#ffffff",
  );
  const choiceBackground = resolveImagePath(names, declaredImages, assets, [
    "gui.choice_button_background",
    "gui.choice_button_idle_background",
    "gui.choice_idle_background",
  ]);
  const choiceHoverBackground = resolveImagePath(names, declaredImages, assets, [
    "gui.choice_button_hover_background",
    "gui.choice_hover_background",
  ]);
  // Priority: an explicit gui.* variable, then the path the style paints with
  // (`style window: background Image(...)`), then the say screen's own `add` /
  // `background` (CSE paints `newgui/say/textbox.png` there and nowhere else),
  // then the conventional file name.
  const textboxFromVariable = resolveImagePath(names, declaredImages, assets, ["gui.textbox_background", "gui.textbox_image"]);
  const textboxFromStyle = textboxFromVariable === undefined ? styleImage("window", "background") : undefined;
  const textboxFromScreen = textboxFromVariable === undefined && textboxFromStyle === undefined ? screenImage("say") : undefined;
  const textboxImage =
    textboxFromVariable ??
    textboxFromStyle ??
    textboxFromScreen ??
    resolveImagePath(names, declaredImages, assets, [], CONVENTIONAL_TEXTBOX);
  const textboxSource =
    textboxImage === undefined
      ? "none"
      : textboxFromVariable !== undefined
        ? "gui-variable"
        : textboxFromStyle !== undefined
          ? "style-window"
          : textboxFromScreen !== undefined
            ? "screen"
            : "conventional-path";
  provenance["dialogbox.textboxImage"] = textboxSource;
  // Every plausible plate, not just the winner. A game can ship several — the
  // template's `gui/textbox.png`, a reworked one under `newgui/`, a variant for
  // a specific route — and only one of them can be in `textboxImage`. The
  // settings page offers the rest as a picker, and the agent can switch with
  // `renpy_save_vn`; the winner is kept first so `candidates[0]` is what is on
  // screen now. Order matters and is the same priority the single lookup uses,
  // so the list explains why the winner won.
  const plateCandidates = [];
  const addPlate = (path, source) => {
    if (typeof path !== "string" || path.length === 0) return;
    const normalised = path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (plateCandidates.some((entry) => entry.path.toLowerCase() === normalised.toLowerCase())) return;
    plateCandidates.push({ path: normalised, source });
  };
  for (const key of ["gui.textbox_background", "gui.textbox_image"]) {
    addPlate(resolveImagePath(names, declaredImages, assets, [key]), "gui-variable");
  }
  addPlate(styleImage("window", "background"), "style-window");
  for (const entry of screenBlocks.get("say")?.adds ?? []) {
    if (entry.kind !== "add" && entry.kind !== "background") continue;
    const path = styleBackgroundPath(entry.raw);
    if (path === undefined) continue;
    const wanted = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    addPlate(
      assets.paths.find((candidate) => candidate.toLowerCase() === wanted),
      "screen",
    );
  }
  for (const wanted of CONVENTIONAL_TEXTBOX) {
    const lowered = wanted.toLowerCase();
    addPlate(
      assets.paths.find((path) => path.toLowerCase() === lowered),
      "conventional-path",
    );
  }
  // The sweep: art the game never names. `phone/` and `tablet/` variants are the
  // same plate at another size (Ren'Py's own GUI ships them) and would only pad
  // the picker with near-duplicates; the name box is a different control.
  for (const path of assets.paths) {
    if (plateCandidates.length >= PLATE_CANDIDATE_CAP) break;
    if (!PLATE_CANDIDATE_PATTERN.test(path)) continue;
    if (/\/phone\/|\/tablet\//i.test(path)) continue;
    if (/namebox|name_box/i.test(path)) continue;
    if (!/\.(png|webp|jpg|jpeg)$/i.test(path)) continue;
    addPlate(path, "sweep");
  }
  if (textboxImage !== undefined) {
    const winner = plateCandidates.findIndex((entry) => entry.path.toLowerCase() === textboxImage.toLowerCase());
    if (winner > 0) plateCandidates.unshift(plateCandidates.splice(winner, 1)[0]);
  }
  const nameboxImage =
    resolveImagePath(names, declaredImages, assets, ["gui.namebox_background", "gui.namebox_image"]) ??
    styleImage("namebox", "background") ??
    // The name box plate lives in the frame that wraps `text who`, and its
    // `background Frame(...)` is the only place it is named.
    (() => {
      const entry = sayNameBoxEntry;
      const path = entry === undefined ? undefined : styleBackgroundPath(entry.properties?.get("background"));
      if (path === undefined) return undefined;
      const wanted = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
      return assets.paths.find((candidate) => candidate.toLowerCase() === wanted);
    })() ??
    resolveImagePath(names, declaredImages, assets, [], CONVENTIONAL_NAMEBOX);
  const samplePlateColor = (relativePath) => {
    if (typeof relativePath !== "string" || relativePath === "") return undefined;
    const bytes = assets.readHead(relativePath);
    return bytes === undefined ? undefined : pngDominantColor(bytes);
  };
  /**
   * A missing accent is sampled from the plate rather than invented.
   *
   * `gui.accent_color` is optional, and the hardcoded fallback is a colour no
   * game chose. The textbox is painted in the game's own palette, so the colour
   * most of it is made of stands in. Only a `default` provenance is replaced:
   * a colour the game — or the settings page — actually stated is never
   * second-guessed.
   */
  if (provenance["theme.accent"] === "default") {
    const sampled = samplePlateColor(textboxImage) ?? samplePlateColor(nameboxImage);
    if (sampled !== undefined) {
      accent = sampled;
      provenance["theme.accent"] = "image-sample";
      // The two that merely default to the accent have to follow it, or the
      // hover/name rows would still show the colour nobody picked.
      if (provenance["theme.hover"] === "default") hover = sampled;
      if (provenance["dialogbox.nameColor"] === "default") nameColor = sampled;
    }
  }
  // The dialogue font is a real file inside the game (`gui.text_font` is written
  // as `font/Trebuchet_MS.ttf`), so it can be served like any other asset and
  // `font` set on the say_dialogue style is what the dialogue is actually drawn
  // with, so it leads over gui.*. The say screen can restate it inline, which
  // beats both.
  const styleFont = styleQuoted("say_dialogue", "font");
  // The dialogue font is a real file inside the game (`gui.text_font` is written
  // as `font/Trebuchet_MS.ttf`), so it can be served like any other asset and
  // loaded with `@font-face`. Priority: the say screen's inline `font` is what
  // that screen paints, then the say_dialogue style, then gui.*.
  const screenFontPath = screenFont(sayWhatEntry?.properties.get("font"));
  const fontDeclarations = [screenFontPath ?? styleFont, names.get("gui.text_font")]
    .flat()
    .filter((value) => typeof value === "string");
  // The declaration reported to the client, independent of whether a file was
  // found for it: `font` is what the game asked for, `font`+`fontUrl` is what
  // can be loaded.
  const fontDeclaration =
    (typeof sayWhatEntry?.properties.get("font") === "string"
      ? sayWhatEntry.properties.get("font").trim().replace(/^["']|["']$/g, "")
      : undefined) ??
    styleFont ??
    getString("gui.text_font", "DejaVuSans.ttf");
  const fontPath =
    fontDeclarations.map((value) => resolveFontPath(value, assets.fonts)).find((path) => path !== undefined) ??
    // One more try with the value actually reported. A game that names its face
    // in a form `fontDeclarations` did not cover (a plain `font` on the screen,
    // a list whose first entry is missing) otherwise shipped `font: "x.ttf"`
    // with `fontUrl: undefined` — a name the interface can never load, beside a
    // file that is present.
    (typeof fontDeclaration === "string" ? resolveFontPath(fontDeclaration, assets.fonts) : undefined);
  provenance["dialogbox.font"] =
    typeof sayWhatEntry?.properties.get("font") === "string"
      ? "screen"
      : styleFont !== undefined
        ? "style"
        : typeof names.get("gui.text_font") === "string"
          ? "gui-variable"
          : "default";
  const choiceWidth = firstDefined(
    "choice.width",
    [{ source: "gui-variable", value: numberOr("gui.choice_button_width") }],
    790,
  );
  const choiceHeight = names.get("gui.choice_button_height");
  const choiceBorders = names.get("gui.choice_button_borders");
  const nameboxBorders = names.get("gui.namebox_borders");

  /**
   * The cast the scripts declare, keyed by the variable they use.
   *
   * A `define qc = Character('启诚', color="#624B34", image="qc")` is the only
   * place the displayed name and its colour exist: the sprite scan sees a
   * folder called `qicheng/` and cannot connect the two. This is deliberately a
   * separate field from `tags` (the sprite buckets), because the two lists are
   * different sets with different keys — one is what the game calls a speaker,
   * the other is what the art is filed under.
   */
  const characterDeclarations = readCharacterDeclarations(sources);
  const characters = {};
  for (const [variable, info] of characterDeclarations) {
    characters[variable] = {
      name: info.name,
      color: info.color,
      image: info.image,
      // `image=` names the sprite tag the engine paints; when it does not match
      // any scanned tag the pairing is unresolved rather than wrong, and the
      // caller can say so instead of silently showing the variable name.
      spriteTagUnresolved: typeof info.image === "string" && !tags.some((entry) => entry.tag === info.image),
    };
  }
  // Which layer declared each character, in the same vocabulary as `sources`
  // above: an empty field means the script said nothing, not that it is absent.
  if (characterDeclarations.size > 0) {
    provenance.characters = "character-declaration";
  } else if (sources.length === 0) {
    provenance.characters = "unread";
  } else {
    provenance.characters = "default";
  }

  /**
   * Every font file the game ships, for the composer font picker.
   *
   * The dialogue font leads: a game typically ships decorative faces for titles
   * beside the one it actually reads dialogue in, and `gui.text_font` names the
   * face that has to stay legible at body size. `assets.fonts` is the same index
   * the asset route serves from, so everything offered here is loadable — a
   * hand-typed path that is not in this list is tried anyway, and falls back.
   */
  const fontCatalog = [];
  const seenFonts = new Set();
  for (const candidate of [fontPath, ...assets.fonts]) {
    if (typeof candidate !== "string" || seenFonts.has(candidate)) continue;
    seenFonts.add(candidate);
    fontCatalog.push({
      path: candidate,
      label: basename(candidate).replace(/\.[^.]+$/, ""),
      url: assetUrl(candidate),
    });
  }

  const accentForeground = readableForeground(accent) ?? "#ffffff";

  // ── audio, playlist, splash ─────────────────────────────────────────────
  //
  // None of this is a displayable, so it is read from the scripts directly:
  // the `audio.<name>` alias table, the `config.main_menu_music` expression
  // (which real games write as a function call), and the `label splashscreen:`
  // body plus the screens it calls.
  const menu = resolveMenuMusic(sources);
  const playlist = buildPlaylist(assets, { signal });
  // Keyed case-insensitively: a game declares `audio/music/motion.ogg` while the
  // file is `Motion.ogg`, and an exact-case lookup would report the game's own
  // title music as missing from its playlist. The declared spelling is kept on
  // the entry below because it is what playback must request.
  const byPath = new Map(playlist.map((track) => [track.path.toLowerCase(), track]));
  const menuTracks = menu.tracks.map((track) => {
    const known = byPath.get(track.path.toLowerCase());
    return {
      path: track.path,
      title: known?.title ?? basename(track.path).replace(/\.[^.]+$/, ""),
      ...(known?.duration === undefined ? {} : { duration: known.duration }),
      preferred: track.preferred === true,
      ...(track.condition === undefined ? {} : { condition: track.condition }),
      // The menu music is played even when the playlist filter dropped it:
      // `main_menu_music` is the game itself declaring what its title screen
      // plays, and a 9-second title jingle is still the title music.
      inPlaylist: known !== undefined,
    };
  });
  const splash = readSplashscreen(sources);
  // Several copies can match (`gui/gui/main_menu.png` ships next to
  // `gui/main_menu.png` in a game that was re-skinned on top of the default
  // GUI folder); the engine's own location is the shallowest one, and sorting
  // the list alphabetically would pick the nested duplicate.
  const mainMenuBackground = backgrounds
    .filter((entry) => /main_?menu|title/i.test(entry.path))
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length || left.path.length - right.path.length)[0]?.path;
  // Names the splash shows with `show <name>` / `scene <name>` that are not
  // `image` declarations are file-derived: resolve them against the same
  // candidate table the rest of the manifest uses, so `show logo` finds
  // `images/logo.png`. Unresolvable names (`scene black`) contribute nothing.
  const splashImages = [...splash.images];
  for (const name of splash.shownNames) {
    // `scene black` is the fade-in frame before the logo, not the opening's art;
    // treating it as the still made Adastra's splash a black rectangle.
    if (/^(black|white|gr[ae]y|red|green|blue|solid|fill)$/i.test(name)) continue;
    const candidate = candidates.get(name);
    if (candidate !== undefined && !splashImages.includes(candidate.relativePath)) {
      splashImages.push(candidate.relativePath);
    }
  }
  const splashSelection = resolveSplash({ ...splash, images: splashImages }, assets, {
    screen: { w: screenWidth, h: screenHeight },
    mainMenuBackground,
  });

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: { root, gameDir, gameRoot, relative: gameDir.slice(gameRoot.length + 1) || "." },
    game: {
      name: getString("config.name", basename(gameRoot)),
      version: getString("config.version", undefined),
      screen: { w: screenWidth, h: screenHeight },
      mainMenuMusic: getString("config.main_menu_music", undefined),
      showName: names.get("gui.show_name") !== false,
    },
    backgrounds: backgrounds.slice(0, SPRITE_LIST_CAP),
    gallery: gallery.slice(0, GALLERY_CAP),
    galleryTotal: gallery.length,
    fonts: fontCatalog.slice(0, FONT_LIST_CAP),
    fontTotal: fontCatalog.length,
    sprites: sprites.slice(0, SPRITE_LIST_CAP),
    spriteIndex,
    tags,
    characters,
    dialogbox: {
      height: textboxHeight,
      yalign: textboxYalign,
      opacity: textboxOpacity,
      fill: normaliseColor(names.get("gui.textbox_fill")) ?? "#000000",
      textColor,
      textSize: firstDefined(
        "dialogbox.textSize",
        [
          { source: "screen", value: screenScalar(sayWhatEntry?.properties.get("size")) },
          { source: "style", value: styleNumber("say_dialogue", "size") },
          { source: "gui-variable", value: numberOr("gui.text_size") },
        ],
        33,
      ),
      font: fontDeclaration,
      fontPath,
      fontUrl: fontPath === undefined ? undefined : assetUrl(fontPath),
      textboxImage: textboxImage === undefined ? undefined : assetUrl(textboxImage),
      textboxSource,
      textboxImageAlign:
        textboxImage === undefined ? undefined : styleBackgroundAlign(styleBlocks.get("window")?.get("background")),
      textboxImageBounds: textboxImage === undefined ? undefined : sizeOf(textboxImage),
      // Where the plate is actually painted inside that file (see lib/png.js).
      textboxImageBox: textboxImage === undefined ? undefined : paintedBox(assets, textboxImage),
      // The path behind `textboxImage`, kept because the picker has to compare
      // against candidates and because a profile override is written as a path.
      textboxPath: textboxImage,
      // The plates this game ships, best first. `url` is what the picker draws;
      // `path` is what `renpy_save_vn` writes back to choose one.
      candidates: plateCandidates.map((entry) => ({
        path: entry.path,
        source: entry.source,
        url: assetUrl(entry.path),
        bounds: sizeOf(entry.path),
      })),
      nameColor,
      nameSize: firstDefined(
        "dialogbox.nameSize",
        [
          { source: "screen", value: screenScalar(sayWhoEntry?.properties.get("size")) },
          { source: "gui-variable", value: numberOr("gui.name_text_size") },
        ],
        45,
      ),
      nameboxImage: nameboxImage === undefined ? undefined : assetUrl(nameboxImage),
      nameboxBounds: nameboxImage === undefined ? undefined : sizeOf(nameboxImage),
    },
    layout: {
      textboxHeight,
      textboxYalign,
      nameXpos: firstDefined(
        "layout.nameXpos",
        [
          { source: "screen", value: screenPos(sayNameBoxEntry)?.x },
          { source: "style", value: styleNumber("namebox", "xpos") },
          { source: "gui-variable", value: numberOr("gui.name_xpos") },
        ],
        0,
      ),
      // Relative to the TOP of the dialogue window, which is where the client
      // puts it (`boxTop + nameYpos / h`). A screen states it in canvas
      // coordinates, so the canvas offset of the window is subtracted here: the
      // arithmetic belongs to the reader, which knows the canvas size, not to
      // every consumer that would have to rediscover the rule.
      nameYpos: firstDefined(
        "layout.nameYpos",
        [
          { source: "screen", value: screenOffsetY(screenPos(sayNameBoxEntry)?.y) },
          { source: "style", value: styleNumber("namebox", "ypos") },
          { source: "gui-variable", value: numberOr("gui.name_ypos") },
        ],
        0,
      ),
      nameXalign: getNumber("gui.name_xalign", 0),
      nameboxWidth: firstDefined(
        "layout.nameboxWidth",
        [
          { source: "screen", value: screenScalar(sayNameBoxEntry?.properties?.get("xsize")) },
          { source: "style", value: styleNumber("namebox", "xsize") },
          { source: "gui-variable", value: numberOr("gui.namebox_width") },
        ],
        undefined,
      ),
      nameboxHeight: firstDefined(
        "layout.nameboxHeight",
        [
          { source: "screen", value: screenScalar(sayNameBoxEntry?.properties?.get("ysize")) },
          { source: "style", value: styleNumber("namebox", "ysize") },
          { source: "gui-variable", value: numberOr("gui.namebox_height") },
        ],
        undefined,
      ),
      nameboxBorders,
      nameboxTile: names.get("gui.namebox_tile") === true,
      dialogueXpos: firstDefined(
        "layout.dialogueXpos",
        [
          { source: "screen", value: screenPos(sayWhatEntry)?.x },
          { source: "style", value: styleNumber("say_dialogue", "xpos") },
          { source: "gui-variable", value: numberOr("gui.dialogue_xpos") },
        ],
        0,
      ),
      dialogueYpos: firstDefined(
        "layout.dialogueYpos",
        [
          { source: "screen", value: screenOffsetY(screenPos(sayWhatEntry)?.y) },
          { source: "style", value: styleNumber("say_dialogue", "ypos") },
          { source: "gui-variable", value: numberOr("gui.dialogue_ypos") },
        ],
        0,
      ),
      dialogueWidth: firstDefined(
        "layout.dialogueWidth",
        [
          { source: "screen", value: screenScalar(sayWhatEntry?.properties?.get("xmaximum")) },
          { source: "style", value: styleNumber("say_dialogue", "xsize") },
          { source: "gui-variable", value: numberOr("gui.dialogue_width") },
        ],
        screenWidth,
      ),
      dialogueTextXalign: getNumber("gui.dialogue_text_xalign", 0),
      choiceButtonWidth: choiceWidth,
      choiceButtonHeight: typeof choiceHeight === "number" ? choiceHeight : undefined,
      choiceButtonBorders: choiceBorders,
    },
    choice: {
      width: choiceWidth,
      height: typeof choiceHeight === "number" ? choiceHeight : undefined,
      borders: choiceBorders,
      textIdleColor: choiceIdle,
      textHoverColor: choiceHover,
      textSize: getNumber("gui.choice_button_text_size", getNumber("gui.text_size", 33)),
      idleBackground: choiceBackground === undefined ? undefined : assetUrl(choiceBackground),
      hoverBackground:
        choiceHoverBackground === undefined ? undefined : assetUrl(choiceHoverBackground),
    },
    transforms: Object.fromEntries(
      [...transforms].map(([name, value]) => [name, { props: value.props, atl: value.atl }]),
    ),
    audio: {
      /** Playable tracks, newest-shape first: `{ path, title, directory, duration? }`. */
      playlist: playlist.map((track) => ({
        path: track.path,
        title: track.title,
        directory: track.directory,
        ...(track.duration === undefined ? {} : { duration: track.duration }),
        url: assetUrl(track.path),
      })),
      /** The resolved `config.main_menu_music`, in preference order. */
      menuMusic: menuTracks.map((track) => ({ ...track, url: assetUrl(track.path) })),
      menuMusicDeclared: menu.declared === undefined ? undefined : String(menu.declared),
      menuMusicUnresolved: menu.unresolved,
      /** Raw `audio.<name> = path`, exposed so the playlist can label a track. */
      aliasCount: readAudioAliases(sources).size,
      extensions: [...DURATION_EXTENSIONS],
    },
    splash:
      splashSelection === undefined
        ? { found: splash.found }
        : {
            found: true,
            kind: splashSelection.kind,
            // A `kind: "video"` splash is withheld until the browser confirms
            // it can decode it: the manifest stays honest about what the game
            // declared, and the client falls back to a still rather than
            // showing a black rectangle.
            path: splashSelection.path,
            source: splashSelection.source,
            url: assetUrl(splashSelection.path),
            // Only a still needs this: a cutscene ends by itself. Emitted so the
            // client can drop a `kind: "image"` splash the game never dismisses.
            ...(splashSelection.duration === undefined ? {} : { duration: splashSelection.duration }),
            candidates: splashSelection.candidates,
            images: splash.images.map((path) => ({ path, url: assetUrl(path) })),
            audio: splash.audio.map((path) => ({ path, url: assetUrl(path) })),
            screens: splash.screens,
            timers: splash.timers,
          },
    stats: {
      backgrounds: backgrounds.length,
      sprites: sprites.length,
      tags: tags.length,
      // The cast the scripts declare. Separate from `tags` on purpose: a game can
      // name six speakers and file their art under different folder names, and
      // reporting one count for both hides exactly that mismatch.
      characters: characterDeclarations.size,
      displayables: assets.paths.length,
      // Where those displayables live, top ten directories only. The digest
      // carries no path list (40 background names is already a lot of tokens),
      // so without this the agent cannot tell whether the art is under `images/`,
      // `gui/` or a game-specific folder, and has to guess a `/media` query.
      assetDirs: topDirectories(assets.all, 10),
      transforms: transforms.size,
      audio: assets.audio.length,
      videos: assets.videos.length,
      playlist: playlist.length,
      // The two caps used to share one name (`truncated`), which made "the
      // resource walk hit its 20 000-entry limit" and "the sprite list was cut to
      // 200" look like the same condition. They answer different questions, so
      // they are named apart.
      assetsIndexTruncated: assets.truncated === true,
      spriteListTruncated: candidates.size > SPRITE_LIST_CAP,
      /**
       * The parts of the game the reader could not open at all.
       *
       * A value that is present is not the same as a value that was read: with
       * zero scripts every `gui.*` lookup misses and Ren'Py's defaults take
       * over, which reads as a complete manifest. Naming the sections here lets
       * the caller say "the cast is unknown" instead of "the game has no cast".
       */
      unread: sources.length === 0 ? ["scripts", "characters", "theme", "layout", "choice"] : [],
    },
  };

  /**
   * What the reader could not do, in the manifest itself.
   *
   * Without this, a manifest built from zero scripts is byte-for-byte as
   * confident as one built from a complete game: every field still holds a
   * number, because Ren'Py's defaults are numbers. `scripts.reason` is the one
   * place that says which case the caller is looking at.
   */
  manifest.scripts = diagnostics.scripts ?? {
    found: { looseRpy: 0, looseRpyc: 0, archivedRpy: 0, archivedRpyc: 0, total: 0 },
    decompiled: sources.length,
    attempted: 0,
    skippedByCap: 0,
    unreadable: 0,
    reason: sources.length > 0 ? null : "scripts could not be read",
    tool: null,
  };
  // The tool block is filled even when a script WAS read: a partial decompile
  // (40 of 48 scripts) is exactly when the diagnostics matter most.
  if (manifest.scripts.tool === null) {
    manifest.scripts.tool = safeRpycDiagnostics();
  }

  /**
   * Which layer each value came from. `"default"` is the interesting one: it
   * means nothing in the game declared that field, so the number beside it is
   * Ren'Py's own default rather than this game's choice.
   */
  manifest.sources = provenance;
  // `textboxSource` predates this block and the client reads it; keep the two
  // agreeing rather than leaving two vocabularies for one question.
  manifest.sources["dialogbox.textboxSource"] = textboxSource;

  /**
   * Every colour the settings page can edit, with where each one came from.
   *
   * The client renders one row per entry instead of reverse-engineering the
   * list out of the token map: the palette is what the game states, and the
   * tokens below are one derivation of it.
   */
  manifest.palette = [
    { key: "accent", value: accent, source: provenance["theme.accent"] },
    { key: "hover", value: hover, source: provenance["theme.hover"] },
    { key: "idle", value: idle, source: provenance["theme.idle"] },
    { key: "text", value: textColor, source: provenance["dialogbox.textColor"] },
    { key: "uiText", value: uiText, source: provenance["theme.uiText"] },
    { key: "name", value: nameColor, source: provenance["dialogbox.nameColor"] },
    { key: "choiceIdle", value: choiceIdle, source: provenance["choice.textIdleColor"] },
    { key: "choiceHover", value: choiceHover, source: provenance["choice.textHoverColor"] },
  ];

  /**
   * Suggested alias-token overrides, paired light + dark as the theme service
   * requires. Derived from the game's accent colour by contrast adjustment:
   * dark mode takes the accent itself, light mode a darkened variant that
   * still reads on a white surface.
   */
  manifest.theme = {
    "--dsw-alias-brand-primary": {
      light: darken(accent, 0.12),
      dark: accent,
    },
    "--dsw-alias-label-primary": {
      // A pinned shell colour is a single value, so it wins in both themes.
      // Left alone, the light surface takes an accent-derived dark text (no one
      // game colour can express "readable on white") and the dark surface takes
      // the game's dialogue colour.
      light: uiTextPinned ? uiText : readableForeground(lighten(accent, 0.86)) ?? "#111111",
      dark: uiText,
    },
    "--dsw-alias-bg-base": {
      light: lighten(accent, 0.93),
      dark: darken(accent, 0.86),
    },
    "--dsw-alias-bg-layer-1": {
      light: lighten(accent, 0.88),
      dark: darken(accent, 0.8),
    },
    "--dsw-alias-bg-layer-2": {
      light: lighten(accent, 0.83),
      dark: darken(accent, 0.74),
    },
    "--dsw-alias-bg-overlay": {
      light: "#ffffff",
      dark: darken(accent, 0.88),
    },
    "--dsw-alias-border-l1": {
      light: darken(accent, 0.5),
      dark: lighten(accent, 0.1),
    },
    "--dsw-alias-border-l2": {
      light: darken(accent, 0.35),
      dark: lighten(accent, 0.25),
    },
    "--dsw-alias-label-secondary": {
      light: darken(accent, 0.2),
      dark: lighten(accent, 0.35),
    },
    "--dsw-specific-sidebar-fill": {
      light: lighten(accent, 0.9),
      dark: darken(accent, 0.88),
    },
  };
  manifest.themeAccentForeground = accentForeground;

  /**
   * The say box's extra pieces, as a flat list the browser can draw.
   *
   * The scan already reads the plate and the text geometry; what it never read
   * is the rest of the screen: the images `screen say` paints around the box,
   * the name box plate, and the quick menu's buttons. A game whose dialogue box
   * has a decorative frame, a side ornament or a row of buttons therefore lost
   * them the moment the shell took over the composer, and only a human reading
   * the `.rpy` could put them back.
   *
   * Coordinates are CANVAS pixels, the space `layout` is already written in, so
   * the browser scales the whole set with the composer instead of re-laying it
   * out. `source` says where the rectangle came from: `screen` when the game
   * states it, `flow` when the button had none and the row was laid out from
   * the enclosing `xalign`/`yalign`.
   */
  const dialogue = dialogModules({
    manifest,
    screenBlocks,
    textboxImage,
    nameboxImage,
    windowTop: (screenHeight - textboxHeight) * textboxYalign,
    canvas: { w: screenWidth, h: screenHeight },
    screenPos,
    screenPair,
    screenScalar,
    resolvePath: (path) => {
      const wanted = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
      return assets.paths.find((candidate) => candidate.toLowerCase() === wanted);
    },
    sizeOf,
    assetUrl,
  });
  manifest.dialogbox.modules = dialogue.modules;
  // Buttons whose action this client cannot perform are reported rather than
  // drawn: a button that does nothing when clicked is worse than no button.
  manifest.dialogbox.quickMenu = dialogue.quickMenu;
  provenance["dialogbox.modules"] = dialogue.modules.length > 0 ? "screen" : "default";

  return { manifest, gameDir, gameRoot, names, accents: { accent, hover, idle } };
}

/**
 * The label a `textbutton`/`imagebutton` shows, read out of its displayable
 * text (`_("History") action ShowMenu('history')` -> `History`).
 *
 * Nothing is evaluated: a label built from a variable stays empty, and the
 * caller then reports the button instead of drawing an unnamed one.
 */
/**
 * A screen property the walker could not pair, read off the raw displayable
 * text instead.
 *
 * `add "gui/ornament.png" pos (100, 200) xsize 120` keeps its whole tail in
 * `raw`: the pair scanner stops at the space inside `(100, 200)` and gives up
 * on everything after it, so the position and the size of every decorated
 * `add` would be lost. The property is plainly there, so it is read here.
 */
function looseProperty(entry, key) {
  const direct = entry?.properties?.get(key);
  if (direct !== undefined) return direct;
  const raw = typeof entry?.raw === "string" ? entry.raw : "";
  const match = new RegExp(`\\b${key}\\s+(\\([^)]*\\)|"[^"]*"|'[^']*'|[^\\s]+)`).exec(raw);
  return match === null ? undefined : match[1];
}

function buttonLabel(raw) {
  if (typeof raw !== "string") return "";
  const match = /_\s*\(\s*(["'])(.*?)\1\s*\)/.exec(raw) ?? /(["'])(.*?)\1/.exec(raw);
  return match === null ? "" : match[2].trim().slice(0, 24);
}

/**
 * The action this client can perform for a quick-menu button, or `undefined`.
 *
 * The map is deliberately short: it names only what the shell has an equivalent
 * for, and the client's own action names are what a module carries. `History`,
 * `Rollback` and `Auto` have no counterpart, so their buttons are reported in
 * `dialogbox.quickMenu` and not rendered.
 */
function quickMenuAction(label, action) {
  const source = typeof action === "string" ? action : "";
  const menu = (/ShowMenu\(\s*["']([^"']+)["']/.exec(source) ?? [])[1]?.toLowerCase() ?? "";
  if (/QuickSave\(|QuickLoad\(/.test(source) || menu === "save" || menu === "load" || menu === "preferences") return "settings";
  if (/\bSkip\(/.test(source)) return "skip";
  if (/\bHide\(/.test(source)) return "hide";
  if (/Play\(\s*["']music["']/.test(source) || menu === "music") return "music";
  const text = typeof label === "string" ? label.toLowerCase() : "";
  if (["prefs", "preferences", "save", "q.save", "q.load", "load"].includes(text)) return "settings";
  if (text === "skip") return "skip";
  if (text === "hide") return "hide";
  if (text === "music" || text === "sound") return "music";
  return undefined;
}

/** How many modules one game may carry; a screen cannot flood the layer. */
const MODULE_CAP = 40;
/** How many quick-menu buttons are drawn; the rest are only reported. */
const QUICK_BUTTON_CAP = 8;

/**
 * Build `dialogbox.modules` and `dialogbox.quickMenu` from the screens the scan
 * already parsed. See the call site for what a module is.
 */
function dialogModules(options) {
  const {
    manifest, screenBlocks, textboxImage, nameboxImage, windowTop, canvas,
    screenPos, screenPair, screenScalar, resolvePath, sizeOf, assetUrl,
  } = options;
  const modules = [];
  const quickMenu = [];
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  const push = (module) => {
    if (modules.length >= MODULE_CAP) return false;
    modules.push(module);
    return true;
  };

  // 1. Images `screen say` adds around the box. Only top-level entries: a `pos`
  //    inside a frame is relative to that frame, and the two coordinate spaces
  //    look identical in the source.
  for (const entry of screenBlocks.get("say")?.adds ?? []) {
    if (entry.depth !== 0 || (entry.kind !== "add" && entry.kind !== "background")) continue;
    const path = styleBackgroundPath(entry.raw);
    if (path === undefined) continue;
    const found = resolvePath(path);
    if (found === undefined || same(found, textboxImage) || same(found, nameboxImage)) continue;
    const size = sizeOf(found);
    const width = screenScalar(looseProperty(entry, "xsize")) ?? size?.width;
    const height = screenScalar(looseProperty(entry, "ysize")) ?? size?.height;
    if (width === undefined || height === undefined) continue;
    const pos = screenPos(entry) ?? screenPair(looseProperty(entry, "pos"));
    const zorder = screenScalar(looseProperty(entry, "zorder"));
    push({
      kind: "image",
      image: found,
      imageUrl: assetUrl(found),
      rect: { x: pos?.x ?? 0, y: pos?.y ?? 0, w: width, h: height },
      ...(zorder === undefined ? {} : { z: zorder }),
      source: "screen",
    });
  }

  // 2. The name box plate. The client never drew it, so a game with a name box
  //    showed an empty strip above the dialogue text; the position comes from
  //    `layout`, whose y is already relative to the top of the window.
  if (nameboxImage !== undefined) {
    const size = sizeOf(nameboxImage);
    const width = manifest.layout.nameboxWidth ?? size?.width;
    const height = manifest.layout.nameboxHeight ?? size?.height;
    if (width !== undefined && height !== undefined) {
      push({
        kind: "image",
        image: nameboxImage,
        imageUrl: assetUrl(nameboxImage),
        rect: { x: manifest.layout.nameXpos ?? 0, y: windowTop + (manifest.layout.nameYpos ?? 0), w: width, h: height },
        z: 1,
        source: "screen",
      });
    }
  }

  // 3. The quick menu. Its buttons are laid out by an `hbox` with an anchor and
  //    no positions of their own, so the row is laid out here from that anchor
  //    and the button's own label; a game that positions its buttons wins.
  const buttons = (screenBlocks.get("quick_menu")?.adds ?? []).filter(
    (entry) => entry.kind === "textbutton" || entry.kind === "imagebutton",
  );
  const rows = [];
  for (const entry of buttons) {
    const label = buttonLabel(entry.raw);
    const action = quickMenuAction(label, looseProperty(entry, "action"));
    if (action === undefined) {
      if (label.length > 0) {
        quickMenu.push({ label, action: String(looseProperty(entry, "action") ?? "") });
      }
      continue;
    }
    if (rows.length >= QUICK_BUTTON_CAP) {
      quickMenu.push({ label, action, note: "not drawn: the row is full" });
      continue;
    }
    rows.push({ entry, label, action });
  }
  const size = typeof manifest.dialogbox.textSize === "number" ? manifest.dialogbox.textSize : 33;
  const pad = Math.round(size * 0.7);
  const gap = Math.round(size * 0.25);
  const rowHeight = Math.round(size * 1.5);
  const buttonPos = (entry) => screenPos(entry) ?? screenPair(looseProperty(entry, "pos"));
  const explicit = rows.every((row) => buttonPos(row.entry) !== undefined);
  const anchorOf = (entry) => {
    for (const outer of [...(entry.ancestors ?? [])].reverse()) {
      const x = screenScalar(looseProperty(outer, "xalign"));
      const y = screenScalar(looseProperty(outer, "yalign"));
      if (x !== undefined || y !== undefined) return { x: x ?? 0.5, y: y ?? 1 };
    }
    return { x: 0.5, y: 1 };
  };
  const widths = rows.map((row) => Math.round(row.label.length * size * 0.62) + pad * 2);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, rows.length - 1);
  const anchor = rows.length === 0 ? { x: 0.5, y: 1 } : anchorOf(rows[0].entry);
  const rowTop = Math.max(0, Math.min((canvas.h - rowHeight) * anchor.y, canvas.h - rowHeight));
  let cursor = (canvas.w - total) * anchor.x;
  for (const [index, row] of rows.entries()) {
    const pos = buttonPos(row.entry);
    const width = screenScalar(looseProperty(row.entry, "xsize")) ?? widths[index];
    const height = screenScalar(looseProperty(row.entry, "ysize")) ?? rowHeight;
    const rect = explicit && pos !== undefined
      ? { x: pos.x ?? 0, y: pos.y ?? 0, w: width, h: height }
      : { x: cursor, y: rowTop, w: width, h: height };
    cursor += width + gap;
    push({
      kind: "button",
      text: row.label,
      action: row.action,
      rect,
      size,
      z: 2,
      source: explicit ? "screen" : "flow",
    });
  }

  return { modules, quickMenu };
}

/** Darken a colour toward black by an amount in `0..1`. */
function darken(color, amount) {
  const rgb = colorToRgb(color);
  if (rgb === undefined) return color;
  const blend = (channel) => Math.round(channel * (1 - amount));
  return `#${rgb.map((channel) => blend(channel).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Resolve a `gui.*` name that holds a displayable path, tolerating the several
 * spellings different Ren'Py GUI versions use.
 * @param names resolved `gui.*` values.
 * @param declaredImages explicit `image` statements.
 * @param assets the asset index.
 * @param keys candidate variable names, most specific first.
 * @returns a relative displayable path known to exist, when found.
 */
function resolveImagePath(names, declaredImages, assets, keys, conventional = []) {
  for (const key of keys) {
    const value = names.get(key);
    if (typeof value !== "string") continue;
    const candidate = value.replace(/\\/g, "/");
    if (assets.paths.includes(candidate)) return candidate;
    const bare = basename(candidate);
    const found = assets.paths.find((path) => basename(path) === bare);
    if (found !== undefined) return found;
  }
  for (const key of keys) {
    const declaration = declaredImages.get(key);
    if (declaration === undefined || declaration.path === undefined) continue;
    const candidate = declaration.path.replace(/\\/g, "/");
    if (assets.paths.includes(candidate)) return candidate;
    const withoutImages = candidate.replace(/^images\//i, "");
    if (assets.paths.includes(withoutImages)) return withoutImages;
  }
  // Conventional paths, for art a game uses but never names in a variable.
  // Ren'Py's own template draws the say window with
  // `Frame("gui/textbox.png", ...)` written INSIDE `screens.rpy`, so the plate
  // is neither a `gui.*` assignment nor an `image` statement: the game shipped
  // `gui/textbox.png` and every lookup above still came back empty, which left
  // the dialogue plate on the opaque-black fallback. A game that renames the
  // file simply misses this net and keeps the fallback.
  for (const wanted of conventional) {
    // Exact path first, case-insensitively: a game can ship `gui/textbox.png`
    // AND `gui/phone/textbox.png`, and a basename-only match picks whichever
    // the index happened to list first — which handed the desktop shell the
    // phone plate.
    const lowered = wanted.toLowerCase();
    const exact = assets.paths.find((path) => path.toLowerCase() === lowered);
    if (exact !== undefined) return exact;
  }
  for (const wanted of conventional) {
    const bare = basename(wanted).toLowerCase();
    const found = assets.paths.find((path) => basename(path).toLowerCase() === bare);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Find the file a `gui.text_font` declaration names.
 *
 * Ren'Py writes the path game-relative (`font/Trebuchet_MS.ttf`), but a bare
 * filename and a differently-cased spelling are both legal in the script, so
 * the lookup ends in a case-insensitive basename match. A font Ren'Py bundles
 * itself (`DejaVuSans.ttf`) is simply not in the game, and reports `undefined`.
 */
function resolveFontPath(declaration, fontPaths) {
  const normalised = declaration.replace(/\\/g, "/").replace(/^\.\//, "");
  if (fontPaths.includes(normalised)) return normalised;
  const bare = basename(normalised).toLowerCase();
  return fontPaths.find((path) => basename(path).toLowerCase() === bare);
}

/**
 * Resolve what the user configured — a game directory, or a Ren'Py root whose
 * `game/` subdirectory holds the assets.
 * @param root the configured path.
 * @returns `{ gameDir, root }` with absolute paths.
 */
export function resolveGameDir(root) {
  const absolute = root.replace(/[\\/]+$/, "");
  if (basename(absolute).toLowerCase() === "game") {
    return { gameDir: absolute, root: absolute.slice(0, Math.max(0, absolute.length - 5)) || absolute };
  }
  const nested = join(absolute, "game");
  try {
    if (statSync(nested).isDirectory()) return { gameDir: nested, root: absolute };
  } catch {
    // Fall through: treat the path itself as the game directory.
  }
  return { gameDir: absolute, root: absolute };
}
