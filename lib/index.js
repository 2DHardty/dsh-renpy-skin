/**
 * dsh-renpy-skin — host half.
 *
 * A Cordis plugin row (see `cordis.patch.yml`) that turns one Ren'Py game
 * directory into (a) a skin for the DSH web GUI and (b) a validating sprite
 * stage the model can drive with native Ren'Py display syntax.
 *
 * Responsibilities:
 *   1. **Read the game** — `lib/manifest.js` builds an in-memory asset
 *      manifest from `gui.rpy` / `options.rpy` / `screens.rpy`, loose image
 *      directories and `.rpa` archives (`lib/rpa3.js`), exposed to the browser
 *      half as JSON plus opaque asset URLs.
 *   2. **Serve it** — same-origin HTTP routes over `ctx.webServer`
 *      (`GET /renpy-skin/manifest`, `GET /renpy-skin/asset`, `GET
 *      /renpy-skin/stage`, `GET|POST /renpy-skin/settings`). Image bytes are
 *      never inlined into prompts or config.
 *   3. **Drive the stage** — the `renpy_stage` Tool parses Ren'Py display
 *      statements (`lib/stage.js`), validates them against the manifest, and
 *      keeps per-session stage state the browser half renders.
 *   4. **Direct the model** — a `systemPrompt` section explains the stage
 *      dialect, the built-in transforms, the available roster, and the rules
 *      (at most three sprites, keep the reserved layout area clear, text tags
 *      only in the model's own dialogue).
 *
 * Every service is optional at load time. `webServer`, `systemPrompt` and
 * `tools` are all reached through `ctx.inject`, which waits for the service
 * instead of reading it once at mount time: rows mount concurrently, so a
 * `ctx.get` can return `undefined` and silently skip the registration — a
 * missing tool then never appears in any request, with no error anywhere.
 * A profile that never provides one of them simply keeps that half unwired.
 *
 * `show ... if <var> <op> <n>` and `show side <tag>` are **plugin extensions**
 * (see README); they are never presented to the model as engine-native.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { buildManifest, listGameMedia, readImageSize, resolveGameDir } from "./manifest.js";
import { migrateLegacyHome, resolveDataHome } from "./home.js";
import { scanGameTree } from "./scantree.js";
import { configureTools, configuredToolPaths, pluginRoot, rpycDiagnostics } from "./rpyc.js";
import {
  applyProfile,
  inspectProfileConfig,
  OVERLAY_SECTIONS,
  profileBelongsToGame,
  profileDirName,
  profileOverlay,
  readProfile,
} from "./vn.js";
import { openRpa } from "./rpa3.js";
import { pngOpaqueBounds } from "./png.js";
import {
  appendMemory,
  MEMORY_HEAD,
  memoryHeads,
  readMemories,
  replaceMemory,
} from "./memory.js";
import {
  StageError,
  StageStore,
  BUILTIN_TRANSFORMS,
  SUPPORTED_TRANSITIONS,
  applyStatements,
  logicalLines,
  parseStatement,
} from "./stage.js";

/** Stable Cordis plugin name. */
export const name = "renpy-skin";

/**
 * No hard dependency: a profile missing a service still loads the rest.
 *
 * `webServer`, `systemPrompt` and `tools` are optional *hard* dependencies —
 * each half asks for them with `ctx.inject`, so a late-mounting service is
 * waited for rather than dropped, and one that never arrives only leaves its
 * own half unwired.
 */
export const inject = [];

/** Route prefix owned by this plugin. */
const ROUTE_BASE = "/renpy-skin";

/** The palette slots the settings page may pin (mirrors `manifest.palette`). */
const PALETTE_SLOTS = ["accent", "hover", "idle", "text", "uiText", "name", "choiceIdle", "choiceHover"];

/** `#rgb` or `#rrggbb`. Anything else is not a colour the derivation can read. */
const PALETTE_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Default settings; the settings page writes the same shape back. */
const DEFAULT_SETTINGS = {
  gameDir: "",
  enabled: true,
  background: true,
  backgroundDim: 0.45,
  skin: true,
  dialogbox: true,
  questionChoice: true,
  stage: true,
  stagePlacement: "overlay",
  promptInjection: true,
  maxStageSprites: 3,
  autoAvoid: false,
  // Presentation-only switches for the shell's own chrome. They hide the
  // sidebar / composer so the game art and the transcript get the window; they
  // never touch the host's layout state, so switching them back is local.
  hideSidebar: false,
  hideComposer: false,
  textAnimation: true,
  textCps: 30,
  themeTokens: true,
  lang: "auto",
  layoutProfiles: {},
  // Tags the user ticked in Settings → Characters. An EMPTY array means "every
  // character", so a fresh install is not a stage with no cast; only ticking a
  // subset restricts the roster the model is offered.
  enabledCharacters: [],
  // ── opening / music (the header utilities strip) ────────────────────────
  /** Replay the game's `label splashscreen:` when DSH starts. Off by default:
   *  a splash is an interruption, and a user who wants one asks for it. */
  splashOnStart: false,
  /** Skip the splash on any click. */
  splashSkipOnClick: true,
  /** Replay the opening when the user switches to another analysed game.
   *  Separate from `splashOnStart` on purpose: starting DSH and switching a
   *  game are different moments, and one switch used to silently replay the
   *  startup splash even with that toggle off. */
  splashOnSwitch: false,
  /** A user-chosen media path/URL that replaces the extracted splash. */
  splashMedia: "",
  /** Follow the game's `config.main_menu_music`. */
  menuMusicOnStart: true,
  /** A user-chosen menu-music candidate path, overriding the default branch. */
  menuMusicTrack: "",
  /** Playlist volume, 0–1. Kept below 1 so it sits under voice and the shell. */
  playlistVolume: 0.6,
  /** Autoplay the header playlist on load. Off: browsers block it anyway. */
  playlistAutoplay: false,
  /** What happens when a playlist track ends: "off" stops at the last track,
   *  "all" wraps to the first, "one" replays the current track. */
  playlistRepeat: "off",
  /** Draw the next track at random instead of walking the list in order. */
  playlistShuffle: false,
  // ── composer backdrop ───────────────────────────────────────────────────
  /** What the shell paints behind the composer while a reply streams.
   *  "default" keeps the host's fade-out gradient, "transparent" drops it so
   *  the game art shows through, "solid" fills the band with no fade. */
  composerBackdrop: "default",
  /** Empty follows the skin font; otherwise this is a VN/system family or path. */
  composerFont: "",
  /** Draw the modules the scan read out of the game's say screen — the name
   *  plate, the quick-menu buttons the client can drive — over the composer. */
  dialogboxModules: true,
  // ── the background switcher ─────────────────────────────────────────────
  /** A game-relative path the user pinned in the background switcher, which
   *  outranks the stage's own `scene`. Empty = keep following the game. */
  backgroundImage: "",
  // ── roleplay (the 「在场」 preset) ────────────────────────────────────────
  /** The name the player answers to. Injected only into roleplay sessions, so
   *  a coding session never learns it; empty means the cast must not invent
   *  one. */
  playerName: "",
  /** Per-session overrides of `playerName`, keyed by session id: one
   *  conversation can be a different playthrough without renaming the user
   *  everywhere. An empty string clears the override for that session. */
  sessionNames: {},
  /** Extra instructions the user wrote for the roleplay preset alone. */
  roleplayPrompt: "",
  // ── external tools (optional) ───────────────────────────────────────────
  //
  // The `.rpyc` half (`lib/rpyc.js`) hands compiled Ren'Py scripts to an
  // external `unrpyc`, run under a Python 3.9+ interpreter. None of it is
  // required: a game that ships loose `.rpy` scripts loads without either. But
  // when a user does have the tools, these three keys let the settings page name
  // them instead of asking for `DSH_RENPY_PYTHON` / `DSH_RENPY_UNRPYC` and a
  // host restart. A value set here outranks the environment variable, and
  // `rpycDiagnostics()` reports which of the two won.
  /** Path (or PATH name) of the Python interpreter that runs unrpyc. */
  pythonPath: "",
  /** Path of `unrpyc.py` itself. */
  unrpycPath: "",
  /** A directory to look for `unrpyc*` checkouts in, in place of `~/Tools`. */
  toolsDir: "",
  // ── the palette ─────────────────────────────────────────────────────────
  //
  // Colours the settings page pinned, keyed by the slot the manifest reports in
  // `manifest.palette` (`accent`, `hover`, `idle`, `text`, `uiText`, `name`,
  // `choiceIdle`, `choiceHover`). `text` is the dialogue box's own text and
  // `uiText` the shell's, deliberately two slots: pinning one must not recolour
  // the other. An absent slot follows the game, so an empty object is
  // "read everything from the game"; the manifest re-derives its theme tokens
  // from whatever this object ends up holding.
  paletteOverrides: {},
};

/**
 * The analysed-VN library file.
 *
 * Kept OUTSIDE `config.json` because it is a growing index of games rather than
 * a preference, and losing it must not reset the user's settings.
 */
function libraryPath() {
  return join(dataHome(), "library.json");
}

/** Read the saved-VN index; a missing or corrupt file reads as empty. */
function readLibrary() {
  try {
    const raw = JSON.parse(readFileSync(libraryPath(), "utf8"));
    const entries = Array.isArray(raw) ? raw : raw?.entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.gameDir === "string" && entry.gameDir.length > 0);
  } catch {
    return [];
  }
}

/** Persist the saved-VN index, newest first, capped so it cannot grow forever. */
function writeLibrary(entries) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const key = entry.gameDir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  const capped = unique.slice(0, 50);
  try {
    mkdirSync(dirname(libraryPath()), { recursive: true });
    writeFileSync(libraryPath(), JSON.stringify(capped, null, 2), "utf8");
  } catch {
    // A read-only home must not break loading a game; the index is a
    // convenience, so a failed write only means the list is not remembered.
  }
  return capped;
}

/** Set once the legacy directory has been considered, so the copy runs once. */
let homeMigrated = false;

/**
 * The plugin's data directory, shared by every profile of this user.
 *
 * `$DSH_RENPY_SKIN_HOME` wins, then `$DSH_HOME/renpy-skin`, then the pre-DSH-era
 * `~/.dsh-renpy-skin`; see `resolveDataHome()` in `./home.js` for the rules and
 * `migrateLegacyHome()` for the one-time copy out of the old directory.
 */
function dataHome() {
  const resolved = resolveDataHome();
  if (!homeMigrated) {
    homeMigrated = true;
    try {
      migrateLegacyHome(resolved);
    } catch {
      // `migrateLegacyHome` already swallows its own failures; this guard keeps
      // a future change to it from taking the whole plugin down at load time.
    }
  }
  return resolved.path;
}

/**
 * The profile file for one VN: `<dataHome>/game/<VN name>/vn.json`.
 *
 * Keyed on the game's own name rather than on its directory, so the same novel
 * installed at two paths shares one profile and a moved folder keeps its
 * settings.
 */
function vnProfilePath(name) {
  return join(dataHome(), "game", profileDirName(name), "vn.json");
}

/** Settings file location, shared by every profile of this user. */
function settingsPath() {
  return join(dataHome(), "config.json");
}

/** Read persisted settings, merging over defaults. */
function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8"));
    if (raw !== null && typeof raw === "object") return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    // Missing or corrupt settings fall back to defaults rather than failing.
  }
  return { ...DEFAULT_SETTINGS };
}

/** Persist settings, coercing the fields the settings page can write. */
function writeSettings(patch) {
  const current = readSettings();
  const next = { ...current };
  const numeric = {
    backgroundDim: [0, 1],
    maxStageSprites: [1, 8],
    textCps: [0, 400],
    // Full-scale by default; 1 is deliberately NOT clamped away, because a
    // quiet source (an old game's 8-bit SFX) can need it.
    playlistVolume: [0, 1],
  };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    if (key in numeric) {
      const bound = numeric[key];
      const number = Number(value);
      if (Number.isFinite(number)) next[key] = Math.min(bound[1], Math.max(bound[0], number));
      continue;
    }
    if (key === "stagePlacement") {
      if (["overlay", "view", "dock"].includes(value)) next[key] = value;
      continue;
    }
    if (key === "composerBackdrop") {
      if (["default", "transparent", "solid"].includes(value)) next[key] = value;
      continue;
    }
    if (key === "composerFont") {
      next[key] = String(value ?? "").trim().slice(0, 400);
      continue;
    }
    if (key === "lang") {
      if (["auto", "zh", "en"].includes(value)) next.lang = value;
      continue;
    }
    if (key === "playlistRepeat") {
      // An unknown mode would leave the player with no `ended` behaviour it
      // recognises, so anything outside the three is dropped rather than stored.
      if (["off", "all", "one"].includes(value)) next.playlistRepeat = value;
      continue;
    }
    if (key === "layoutProfiles") {
      if (value !== null && typeof value === "object") next.layoutProfiles = value;
      continue;
    }
    if (key === "backgroundImage") {
      // Only ever used to look an entry up in the manifest's own gallery, so a
      // path that escapes the game finds nothing; the cap just keeps the file
      // tidy.
      next[key] = String(value ?? "").trim().slice(0, 400);
      continue;
    }
    if (key === "enabledCharacters") {
      // A tag list, deduplicated and order-stable; anything non-string is
      // dropped rather than trusted, because the model-facing roster filters
      // `show` against exactly this set.
      if (Array.isArray(value)) {
        next.enabledCharacters = [...new Set(value.filter((tag) => typeof tag === "string" && tag.length > 0))];
      }
      continue;
    }
    if (key === "playerName") {
      // Short on purpose: this is a name the cast addresses the user by, not a
      // description, and a runaway paste must not become a paragraph.
      next.playerName = String(value ?? "").trim().slice(0, 60);
      continue;
    }
    if (key === "roleplayPrompt") {
      next.roleplayPrompt = String(value ?? "").trim().slice(0, 4000);
      continue;
    }
    if (key === "sessionNames") {
      // A per-session name map. Only string values survive, an empty name is
      // kept on purpose (it means "no override for this session"), and the
      // caps keep a corrupt file from turning into an unbounded settings blob.
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const names = {};
        for (const [id, name] of Object.entries(value)) {
          if (typeof id !== "string" || id.length === 0 || id.length > 200) continue;
          names[id] = String(name ?? "").trim().slice(0, 60);
        }
        next.sessionNames = names;
      }
      continue;
    }
    if (key === "pythonPath" || key === "unrpycPath" || key === "toolsDir") {
      // A tool path. It is handed to `spawn` as one argument (never through a
      // shell), so the only rules that matter are "trimmed" and "short": a paste
      // that arrives with a trailing newline must not become a path that never
      // resolves, and the cap keeps a stray drag-and-drop blob out of the file.
      next[key] = String(value ?? "").trim().slice(0, 400);
      continue;
    }
    if (key === "paletteOverrides") {
      // One entry per palette slot. Only the slots the manifest knows survive,
      // and only as `#rgb`/`#rrggbb`: the client feeds them into a colour input
      // and the token derivation, so anything else is dropped here rather than
      // stored to break a later paint. An empty or malformed value means
      // "follow the game" and removes the override instead of blanking a slot.
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const palette = {};
        for (const slot of PALETTE_SLOTS) {
          const raw = value[slot];
          if (typeof raw !== "string") continue;
          const colour = raw.trim();
          if (!PALETTE_COLOR.test(colour)) continue;
          palette[slot] = colour.toLowerCase();
        }
        next.paletteOverrides = palette;
      }
      continue;
    }
    if (typeof DEFAULT_SETTINGS[key] === "boolean") {
      next[key] = value === true;
      continue;
    }
    if (typeof DEFAULT_SETTINGS[key] === "string") next[key] = String(value);
  }
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** MIME type for the displayable formats the manifest can yield. */
function mimeFor(path) {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".ogg":
      return "audio/ogg";
    case ".opus":
      return "audio/ogg";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".flac":
      return "audio/flac";
    case ".aac":
      return "audio/aac";
    // Video: a splash screen is played by a `<video>` element, which refuses a
    // resource served as `application/octet-stream`.
    case ".webm":
      return "video/webm";
    case ".mp4":
      return "video/mp4";
    case ".ogv":
      return "video/ogg";
    case ".mkv":
      return "video/x-matroska";
    case ".mov":
      return "video/quicktime";
    // Fonts: the skin loads a game face through `@font-face`, and a browser
    // refuses to decode a font served as `application/octet-stream` in strict
    // modes. The `font/*` types are what the format registry gives them.
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".ttc":
      return "font/collection";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

/**
 * Write a JSON response over the Node-style handler. `content-length` is set
 * from the UTF-8 byte length so non-ASCII payloads (Chinese game names) carry
 * the correct byte count, not the character count.
 */
function sendJson(res, body, status = 200) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", payload.length);
  res.end(payload);
}

/**
 * Parse a single `Range: bytes=a-b` request header.
 *
 * Only the forms a media element actually sends are honoured: `bytes=a-`,
 * `bytes=a-b` and the suffix form `bytes=-n`. Anything else — a multipart
 * range, an unparsable spec — returns `undefined`, which the caller answers
 * with a 416 rather than by serving the wrong bytes.
 *
 * @param header the raw `range` header, if any.
 * @param size total resource length.
 * @returns `{ start, end }` inclusive, or `undefined`.
 */
function parseRange(header, size) {
  const value = String(header ?? "").trim();
  if (value.length === 0) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (match === null) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;
  let start;
  let end;
  if (rawStart === "") {
    // `bytes=-500` means "the LAST 500 bytes", not "bytes 0..500".
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === "" ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (start >= size) return undefined;
  end = Math.min(end, size - 1);
  if (end < start) return undefined;
  return { start, end };
}

/**
 * Buffer a JSON request body (bounded to 1 MiB) and parse it once. The live
 * `webServer` contract is Node `IncomingMessage`, not the Web `Request`, so
 * there is no `request.json()` — this replaces it.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        finish(new Error("request body exceeds 1 MiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim().length === 0) return finish(undefined, {});
      try {
        finish(undefined, JSON.parse(text));
      } catch (error) {
        finish(error);
      }
    });
    req.on("error", (error) => finish(error));
    req.on("aborted", () => finish(new Error("request aborted")));
  });
}

/**
 * Register the plugin.
 * @param ctx the host Cordis context.
 */
export function apply(ctx) {
  const stages = new StageStore();
  /** gameDir -> built manifest record — one build per directory. */
  const manifestCache = new Map();
  /**
   * gameDir -> `{ images, videos }` for the opening-media picker.
   *
   * A directory walk of its own, so it is only paid when the picker is opened,
   * and dropped with every other per-game cache — a re-read has to show the
   * files the new archive actually contains.
   */
  const mediaCache = new Map();
  /**
   * Monotonic counter behind `manifest.assetToken`.
   *
   * The timestamp alone would collide for two games built in the same
   * millisecond; the counter makes every build's token distinct even then.
   */
  let assetBuilds = 0;
  /** sessionId -> game directory chosen for that session. */
  const sessionGames = new Map();
  /** sessionId -> reserved safe-area rectangles from the layout editor. */
  const sessionSafeAreas = new Map();
  /**
   * sessionId -> the agent preset that session was created with.
   *
   * There is no API to read a preset back from a session: the preset registry
   * only resolves ids and mounts compositions. The session header carries
   * `agentPreset` though, and `session/event` hands the header to every
   * listener, so the map is filled from events and read by the prompt sections.
   * A session that was never seen keeps `undefined` — which reads as "not a
   * roleplay session", the safe default for a prompt that names the user.
   */
  const sessionPresets = new Map();
  ctx.on("session/event", (session, event) => {
    const id = typeof session?.id === "string" ? session.id : session?.header?.id;
    if (typeof id !== "string" || id.length === 0) return;
    const fromHeader = session?.header?.agentPreset;
    if (typeof fromHeader === "string" && fromHeader.length > 0) sessionPresets.set(id, fromHeader);
    const selected = event?.data?.agentPreset;
    if (event?.type === "agent-preset/selected" && typeof selected === "string") {
      sessionPresets.set(id, selected);
    }
  });
  let settings = readSettings();

  /**
   * Hand the tool paths from the settings to the `.rpyc` half.
   *
   * `lib/rpyc.js` keeps its own resolution state, so a path typed into the
   * settings page only takes effect once it is pushed over — and a manifest
   * built with the previous interpreter would keep reporting the old diagnosis,
   * which reads as "my change did nothing". Runs at mount and after every
   * settings write that can carry these three keys.
   */
  const applyToolPaths = () => {
    configureTools({
      python: settings.pythonPath,
      unrpyc: settings.unrpycPath,
      toolsDir: settings.toolsDir,
    });
    manifestCache.clear();
  };
  applyToolPaths();

  /** The analysed-VN index, kept in memory and mirrored to library.json. */
  let library = readLibrary();

  /**
   * Everything that is scoped to ONE game, dropped when the game changes.
   *
   * Switching VNs used to leave the previous game's stage, safe areas and
   * generated scene URLs alive: the overlay kept painting the old cast over the
   * new game's interface, and a `sessionId -> gameDir` override outlived its
   * game. The manifest cache is dropped last because `manifestFor` refills it.
   */
  const forgetSessionState = () => {
    stages.stages.clear();
    sessionGames.clear();
    sessionSafeAreas.clear();
    archiveCache.clear();
    manifestCache.clear();
    mediaCache.clear();
  };

  /**
   * The safe areas reserved for one session, rebuilt from the saved layout when
   * the session has none.
   *
   * The layout editor ships them with every save, but they only ever lived in
   * this Map: nothing rebuilt them from the persisted profile, so a DSH restart
   * (or a second window, or a new session) silently lost the user's reserved
   * area — the stage then reported a name box nobody had reserved, or failed to
   * avoid one the user had. The profile key is the manifest's game name, which
   * is what the editor writes.
   */
  const safeAreaFor = (sessionId, manifest) => {
    const stored = sessionSafeAreas.get(sessionId);
    if (Array.isArray(stored)) return stored;
    const profile = settings.layoutProfiles?.[manifest?.game?.name ?? "default"];
    if (profile === null || typeof profile !== "object") return [];
    return Object.entries(profile)
      .filter(([, entry]) => entry !== null && typeof entry === "object" && entry.visible !== false)
      .map(([id, entry]) => ({
        id,
        x: entry.x,
        y: entry.y,
        w: entry.w,
        h: entry.h,
        // Which rectangles must hold an X range free of sprites; mirrors the
        // editor's own rule so a rebuilt area behaves like a shipped one.
        coversX: id === "namebox" || id === "dialogue" || id === "sideImage",
      }));
  };

  /**
   * Record one analysed game in the library, newest first.
   *
   * `gameDir` is the path the USER gave, because that is what `settings.gameDir`
   * holds and what the picker compares against; `resolved` is the directory the
   * reader actually used. Both are kept and the entry is keyed on `resolved`, so
   * pointing the picker at either the game folder or its `game/` subdirectory
   * updates one entry instead of listing the same VN twice.
   */
  const rememberGame = (record, requested) => {
    const entry = {
      gameDir: typeof requested === "string" && requested.length > 0 ? requested : record.gameDir,
      resolved: record.gameDir,
      name: record.manifest?.game?.name ?? basename(record.gameRoot),
      version: record.manifest?.game?.version,
      screen: record.manifest?.game?.screen,
      stats: record.manifest?.stats,
      background: record.manifest?.backgrounds?.[0]?.url,
      openedAt: new Date().toISOString(),
    };
    library = [
      entry,
      ...library.filter((item) => (item.resolved ?? item.gameDir).toLowerCase() !== record.gameDir.toLowerCase()),
    ];
    library = writeLibrary(library);
    return entry;
  };

  /**
   * The directory a profile says it was written for, resolved for comparison.
   *
   * A profile with no `gameDir`, or one that is not a usable path, answers
   * `undefined` — which is read as "unknown, keep applying it". Old profiles
   * must not stop working because the field arrived later.
   */
  const savedGameDirOf = (profile) => {
    const saved = profile?.gameDir;
    if (typeof saved !== "string" || saved.trim().length === 0) return undefined;
    return resolveGameDir(saved.trim()).gameDir;
  };

  /**
   * Build or reuse the manifest for one directory.
   * @param gameDir configured path.
   * @returns the manifest record plus its resolved directories.
   */
  const manifestFor = (gameDir) => {
    if (typeof gameDir !== "string" || gameDir.trim().length === 0) {
      throw new Error(
        "no Ren'Py game directory is configured (set it in Settings → Ren'Py skin)",
      );
    }
    const resolved = resolveGameDir(gameDir.trim());
    const cached = manifestCache.get(resolved.gameDir);
    if (cached !== undefined) return cached;
    // A token that is unique to THIS build, folded into every generated asset
    // URL. Without it `gui/main_menu.png` resolved to the same
    // `/renpy-skin/asset?p=gui%2Fmain_menu.png` in every game, and because the
    // asset route caches for an hour the browser served the PREVIOUS game's
    // bytes after a switch — the background really was still the old game's.
    // Keying the URL on the build makes the cache entry game-scoped, and since
    // switching games empties `manifestCache` (and a re-read does too) the token
    // also busts the cache when the files on disk change.
    const assetToken = `${(++assetBuilds).toString(36)}-${Date.now().toString(36)}`;
    const built = buildManifest(gameDir.trim(), {
      palette: settings.paletteOverrides,
      assetUrl: (relativePath) =>
        `${ROUTE_BASE}/asset?v=${assetToken}&p=${encodeURIComponent(relativePath)}`,
    });
    const manifest = { ...built.manifest, assetToken };
    // The agent-written profile is applied to the SCAN, never instead of it:
    // it corrects fields the reader got wrong or could not read, and a missing
    // or malformed file simply leaves the scan alone.
    //
    // The folder is keyed on the SCANNED name, taken before the overlay runs.
    // Keying it on `manifest.game.name` looked equivalent and was not: a profile
    // that corrects the title (`CSE-2.1.0-pc` -> `CSE`) moved the directory the
    // next build looked in, so the profile stopped being found, the scan reverted,
    // and the corrected name reappeared — the profile un-applied itself.
    const scannedName = built.manifest.game?.name;
    const profileName = profileDirName(scannedName);
    const profile = readProfile(vnProfilePath(profileName));
    // The folder is keyed by the game's NAME, so two games that answer to the
    // same name share one profile, and the second one to be loaded would be
    // re-skinned with the first one's colours, font and box geometry. The save
    // tool records the directory it wrote for; when that names another one the
    // profile is a neighbour's, so it is reported instead of applied.
    if (profileBelongsToGame(savedGameDirOf(profile), resolved.gameDir)) {
      const profileDiagnostics = {};
      const changed = applyProfile(manifest, profileOverlay(profile), profileDiagnostics);
      if (changed.length > 0) {
        manifest.profileApplied = changed;
        // The provenance map answers "where did this value come from", and after
        // the merge the answer for these paths is the profile, not the scan.
        // Leaving `sources` untouched made a corrected value look like a
        // scanned one — the same conflation the map exists to end.
        if (manifest.sources !== null && typeof manifest.sources === "object") {
          for (const path of changed) manifest.sources[path] = "profile";
        }
      }
      // Five dialog-box fields are not values but DERIVATIONS of one: the URL a
      // path is served under, and the size and opaque box read out of its bytes.
      // The overlay copies the profile's string straight onto the manifest, so
      // without this pass a profile writing `gui/mine.png` handed the browser a
      // bare path where it needs this build's asset URL, and a profile changing
      // `dialogbox.font` kept the OLD `fontUrl` — the interface went on drawing
      // the previous font while the file said otherwise.
      rederiveAssets(manifest, changed, {
        assetUrl: (relativePath) =>
          `${ROUTE_BASE}/asset?v=${assetToken}&p=${encodeURIComponent(relativePath)}`,
        readBytes: (relativePath) => readAssetBytes(resolved.gameDir, relativePath),
      });
      // A patch keyed on a sprite tag the scan never found landed nowhere; the
      // agent's file says the sprite is fixed while the stage still cannot
      // resolve it, so the miss travels with the manifest instead of dying in
      // the merge.
      if (profileDiagnostics.unmatched !== undefined) manifest.profileUnmatched = profileDiagnostics.unmatched;
    } else {
      manifest.profileRejected = { savedGameDir: profile.gameDir };
    }
    const record = {
      manifest,
      builtAt: Date.now(),
      ...resolved,
      profileName,
      // The name the SCAN read, kept because the manifest's own `game.name` may
      // since have been corrected by the profile. The profile directory is keyed
      // on this one, so anything that wants to look there must not read the
      // overlaid value.
      scannedName,
    };
    manifestCache.set(resolved.gameDir, record);
    return record;
  };

  /** The directory in force for one session, falling back to the setting. */
  const gameDirForSession = (sessionId) => sessionGames.get(sessionId) ?? settings.gameDir ?? "";

  /**
   * Which agent preset one session was created with, or `""` when unknown.
   *
   * The assembly's own scope is asked first: when it carries the session header
   * the answer is exact for the step being assembled, and the event-fed map is
   * only the fallback for assemblies that do not expose it.
   */
  const presetOfSession = (sessionId, assembly) => {
    const fromScope = assembly?.scope?.header?.agentPreset;
    if (typeof fromScope === "string" && fromScope.length > 0) return fromScope;
    return sessionPresets.get(sessionId) ?? "";
  };

  /**
   * The name the user answers to in one session.
   *
   * A per-session override wins over the global name, and an empty override is
   * "not set" rather than "call them nothing": a session created before the
   * user picked a name must not keep an empty one forever.
   */
  const playerNameFor = (sessionId) => {
    const override = settings.sessionNames?.[sessionId];
    if (typeof override === "string" && override.trim().length > 0) return override.trim();
    return typeof settings.playerName === "string" ? settings.playerName : "";
  };

  // ── model-facing: the prompt sections ───────────────────────────────────
  //
  // `ctx.inject` (not `ctx.get`): rows mount concurrently, so the prompt
  // registry may not exist yet when this row applies. Reading it once would
  // leave the section unregistered for the whole process lifetime — the model
  // then never learns the stage dialect, silently, with nothing in any log.
  //
  // Both sections live in ONE injection on purpose. The stage brief is
  // registered for every session and explains the dialect; the roleplay brief
  // answers only for the sessions the roleplay preset was chosen for, because
  // it names the user and carries their private notes. A second
  // `ctx.inject(["systemPrompt"])` would say the same thing twice and make the
  // "which services does this row wait for" question harder to answer.
  ctx.inject(["systemPrompt"], (promptCtx) => {
    const systemPrompt = promptCtx.systemPrompt;
    if (systemPrompt === undefined || typeof systemPrompt?.section !== "function") return;
    const baseOrder =
      typeof systemPrompt.getSectionOrder === "function"
        ? systemPrompt.getSectionOrder("PLAN_POLICY")
        : 500;
    return promptCtx.effect(
      () => [
        systemPrompt.section({
          name: "renpy-skin:stage-director",
          order: baseOrder + 100,
          interpolate: false,
          text: (assembly) => {
            if (settings.promptInjection !== true) return "";
            const sessionId = sessionIdOf(assembly);
            const gameDir = gameDirForSession(sessionId);
            if (typeof gameDir !== "string" || gameDir.length === 0) return "";
            let record;
            try {
              record = manifestFor(gameDir);
            } catch {
              return "";
            }
            return directorBrief(record.manifest, {
              settings,
              safeArea: safeAreaFor(sessionId, record.manifest),
            });
          },
        }),
        systemPrompt.section({
          name: "renpy-skin:roleplay",
          order: baseOrder + 110,
          interpolate: false,
          text: (assembly) => {
            const sessionId = sessionIdOf(assembly);
            if (presetOfSession(sessionId, assembly) !== ROLEPLAY_PRESET) return "";
            const gameDir = gameDirForSession(sessionId);
            if (typeof gameDir !== "string" || gameDir.length === 0) return "";
            let record;
            try {
              record = manifestFor(gameDir);
            } catch {
              return "";
            }
            return roleplayBrief(record.manifest, {
              settings,
              memories: readMemories(dataHome(), record.profileName),
              playerName: playerNameFor(sessionId),
            });
          },
        }),
      ],
      "dsh-renpy-skin: prompt sections",
    );
  });

  // ── model-facing: the renpy_* tools ─────────────────────────────────────
  //
  // Same reason as the prompt above: the tool registry may mount after this
  // row, and a `ctx.get("tools")` that returns `undefined` used to drop every
  // `renpy_*` tool for the whole process. The observed symptom was a session
  // whose request carried 47 tools and not one of them was ours, with no error
  // anywhere — the model could not load or direct a game at all.
  ctx.inject(["tools"], (toolsCtx) => {
    const tools = toolsCtx.tools;
    if (tools === undefined || typeof tools?.register !== "function") return undefined;
    toolsCtx.effect(
      () =>
        tools.register({
          name: "renpy_stage",
          description:
            "Direct the Ren'Py sprite stage shown in this conversation's interface. Pass Ren'Py display " +
            "statements (show / hide / scene / with) as a script string. Unknown images, attributes or " +
            "transforms are rejected with the list of ones that exist, so you can correct and retry. Use " +
            "`scene bg <name> with fade` to change location and `show <tag> <expression> at left|center|right` " +
            "to place a character. Keep at most three sprites on stage and never cover the reserved layout area.",
          parameters: {
            type: "object",
            properties: {
              script: {
                type: "string",
                description:
                  "One or more Ren'Py display statements, one per line, e.g.\n" +
                  "scene bg classroom with fade\n" +
                  "show eileen happy at center\n" +
                  "show lucy sad at left",
              },
              transition: {
                type: "string",
                enum: [...SUPPORTED_TRANSITIONS].filter((entry) => entry !== "None"),
                description: "Transition applied to statements that do not name their own.",
              },
              clear: {
                type: "boolean",
                description: "Clear the whole stage first (background and sprites).",
              },
            },
            required: ["script"],
          },
          async execute(args, exec) {
            const input = args !== null && typeof args === "object" ? args : {};
            const sessionId = String(exec?.agent?.id ?? "global");
            if (input.clear === true) stages.reset(sessionId);
            let record;
            try {
              record = manifestFor(gameDirForSession(sessionId));
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                hint: "Set the Ren'Py game directory in Settings → Ren'Py skin first.",
              };
            }
            let statements;
            try {
              statements = parseScript(input.script, input.transition);
            } catch (error) {
              if (error instanceof StageError) return { ok: false, error: error.message, ...error.details };
              throw error;
            }
            let outcome;
            try {
              outcome = applyStatements(stages.get(sessionId), statements, record.manifest, {
                autoAvoid: settings.autoAvoid === true,
                safeArea: safeAreaFor(sessionId, record.manifest),
                enabledCharacters: settings.enabledCharacters,
              });
            } catch (error) {
              if (error instanceof StageError) return { ok: false, error: error.message, ...error.details };
              throw error;
            }
            const stage = stages.snapshot(sessionId);
            const limit = Number(settings.maxStageSprites) || 3;
            const warnings = [...outcome.warnings];
            if (stage.sprites.length > limit) {
              warnings.push(
                `the stage now holds ${stage.sprites.length} sprites but the user limited it to ${limit}; hide one`,
              );
            }
            stages.emit(sessionId);
            return { ok: true, applied: outcome.applied, warnings, stage };
          },
          /**
           * The model-facing result projection. A rejection is rendered as a
           * structured error carrying the alternatives, which is the whole
           * self-correction loop: the model reads the list and retries.
           */
          output: {
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                applied: { type: "array" },
                warnings: { type: "array" },
                stage: { type: "object" },
                error: { type: "string" },
                tags: { type: "array" },
                backgrounds: { type: "array" },
                builtinTransforms: { type: "array" },
                supportedTransitions: { type: "array" },
                gameTransforms: { type: "array" },
                hint: { type: "string" },
              },
              required: ["ok"],
              additionalProperties: true,
            },
            render(_args, value) {
              const result = value !== null && typeof value === "object" ? value : {};
              if (result.ok !== true) {
                return [{ type: "text", text: formatRejection(result) }];
              }
              return [{ type: "text", text: formatApplied(result) }];
            },
            presentationMeta(_args, value) {
              const result = value !== null && typeof value === "object" ? value : {};
              return {
                ok: result.ok === true,
                ...(result.ok === true
                  ? { applied: result.applied ?? [], warnings: result.warnings ?? [] }
                  : { error: result.error }),
              };
            },
          },
          presentCall(args) {
            const script = args !== null && typeof args === "object" ? args.script : undefined;
            return {
              card: "generic",
              title: "renpy_stage",
              kind: "other",
              content: [{ type: "text", text: String(script ?? "") }],
            };
          },
          presentResult(_args, result) {
            const blocks = result?.content ?? [];
            const text = blocks.find((block) => block.type === "text")?.text ?? "";
            return { card: "generic", title: "Ren'Py stage", content: blocks, ...(text === "" ? {} : { title: text.split("\n")[0] }) };
          },
          isConcurrencySafe() {
            // Stage state is ordered: two concurrent calls would interleave.
            return false;
          },
        }),
      "dsh-renpy-skin: renpy_stage tool",
    );

    // ── model-facing: the renpy_configure tool ─────────────────────────────
    //
    // `renpy_stage` drives sprites, but it never changes WHICH game is loaded.
    // This tool lets the agent load or switch a VN by absolute path, which is
    // the other half of "start a VN / continue an existing VN".
    toolsCtx.effect(
      () =>
        tools.register({
          name: "renpy_configure",
          description:
            "Load a Ren'Py visual novel into this conversation's skinned interface. Pass the absolute " +
            "path to the game's folder (the one containing `game/`) or directly to its `game/` directory. " +
            "The interface re-skins from that game's gui.rpy, backgrounds and sprites, and the stage roster " +
            "becomes available to `renpy_stage`. Use this to start a new VN or switch to a different one.",
          parameters: {
            type: "object",
            properties: {
              gameDir: {
                type: "string",
                description:
                  "Absolute path to the Ren'Py game folder or its `game/` subdirectory, e.g. D:\\Games\\MyNovel",
              },
            },
            required: ["gameDir"],
          },
          async execute(args, exec) {
            const input = args !== null && typeof args === "object" ? args : {};
            const gameDir = typeof input.gameDir === "string" ? input.gameDir.trim() : "";
            if (gameDir.length === 0) {
              return { ok: false, error: "gameDir is required" };
            }
            const sessionId = String(exec?.agent?.id ?? "global");
            settings = writeSettings({ gameDir });
            // The tool switch has to drop the same per-game state as the picker:
            // leaving the previous game's stage, safe areas or archive handles
            // alive made the old cast survive into the new VN.
            forgetSessionState();
            sessionGames.set(sessionId, gameDir);
            let record;
            try {
              record = manifestFor(gameDir);
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            // Recorded here too, so a game configured by the model shows up in
            // the header dropdown and survives a restart like a manual load.
            rememberGame(record, gameDir);
            const stats = record.manifest.stats ?? {};
            return {
              ok: true,
              game: record.manifest.game,
              stats: {
                backgrounds: stats.backgrounds,
                tags: stats.tags,
                transforms: stats.transforms,
                displayables: stats.displayables,
              },
              hint: "The interface is now skinned as this VN. Drive the stage with renpy_stage.",
            };
          },
          output: {
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                game: { type: "object" },
                stats: { type: "object" },
                error: { type: "string" },
                hint: { type: "string" },
              },
              required: ["ok"],
              additionalProperties: true,
            },
            render(_args, value) {
              const result = value !== null && typeof value === "object" ? value : {};
              if (result.ok !== true) {
                return [{ type: "text", text: `renpy_configure failed: ${result.error ?? "unknown error"}` }];
              }
              const game = result.game ?? {};
              const stats = result.stats ?? {};
              return [
                {
                  type: "text",
                  text:
                    `Loaded ${game.name ?? "the VN"}` +
                    (game.version === undefined ? "" : ` v${game.version}`) +
                    ` — ${stats.backgrounds ?? 0} backgrounds, ${stats.tags ?? 0} characters, ${stats.transforms ?? 0} transforms.` +
                    `\nThe interface is skinned. Drive sprites with renpy_stage.`,
                },
              ];
            },
            presentationMeta(_args, value) {
              const result = value !== null && typeof value === "object" ? value : {};
              return { ok: result.ok === true, ...(result.ok === true ? {} : { error: result.error }) };
            },
          },
          presentCall(args) {
            const gameDir = args !== null && typeof args === "object" ? args.gameDir : undefined;
            return { card: "generic", title: "renpy_configure", kind: "other", content: [{ type: "text", text: String(gameDir ?? "") }] };
          },
          presentResult(_args, result) {
            const blocks = result?.content ?? [];
            return { card: "generic", title: "Ren'Py VN", content: blocks };
          },
          isConcurrencySafe() {
            return false;
          },
        }),
      "dsh-renpy-skin: renpy_configure tool",
    );

    // ── model-facing: the renpy_read_manifest tool ─────────────────────────
    //
    // The read half of `renpy_save_vn`. That tool's whole premise is "the scan
    // is right except where it says nothing", which a model can only act on if
    // it can see what the scan actually read — otherwise it guesses, and a
    // guess written into the profile is worse than the plugin's own default.
    toolsCtx.effect(
      () =>
        tools.register({
          name: "renpy_read_manifest",
          description:
            "Read the values this plugin's own scan extracted from the loaded Ren'Py game: canvas size, " +
            "the dialogue box and its geometry, the choice buttons, the colours, the fonts, the character " +
            "roster, the transforms and the backgrounds. Read this BEFORE writing a profile with " +
            "`renpy_save_vn`: the scan is exact about everything it could read and falls back to defaults " +
            "for everything it could not (it reads compiled scripts and cannot evaluate expressions), so " +
            "the profile's `config` should carry corrections of these values rather than fresh guesses. " +
            "Every value comes with its provenance in `sources` (`default` means nothing was read and the " +
            "number is the plugin's own fallback), and `scripts` says whether the scripts could be " +
            "decompiled at all. `stats.assetDirs` lists the directories holding the most files; to list " +
            "files inside one of them, including inside `.rpa` archives, GET " +
            "`/renpy-skin/media?under=<dir>&match=<substring>` — the unfiltered route returns every path " +
            "and is usually too large to read. Read-only: it changes nothing.",
          parameters: { type: "object", properties: {} },
          async execute(_args, exec) {
            const sessionId = String(exec?.agent?.id ?? "global");
            const gameDir = gameDirForSession(sessionId);
            if (typeof gameDir !== "string" || gameDir.length === 0) {
              return { ok: false, error: "no game is loaded; call renpy_configure first" };
            }
            let record;
            try {
              record = manifestFor(gameDir);
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            return { ok: true, gameDir: record.gameDir, ...manifestDigest(record.manifest) };
          },
          output: {
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                gameDir: { type: "string" },
                game: { type: "object" },
                dialogbox: { type: "object" },
                layout: { type: "object" },
                choice: { type: "object" },
                theme: { type: "object" },
                stats: { type: "object" },
                characters: { type: "array", items: { type: "object" } },
                backgrounds: { type: "array", items: { type: "string" } },
                transforms: { type: "array", items: { type: "string" } },
                profile: { type: "object" },
                error: { type: "string" },
              },
              required: ["ok"],
              additionalProperties: true,
            },
            render(_args, value) {
              const result = value !== null && typeof value === "object" ? value : {};
              if (result.ok !== true) {
                return [
                  { type: "text", text: `renpy_read_manifest failed: ${result.error ?? "unknown error"}` },
                ];
              }
              // JSON rather than prose: every one of these values is meant to be
              // copied back into `renpy_save_vn`'s `config`, which takes exactly
              // this shape.
              const { ok: _ok, ...digest } = result;
              return [{ type: "text", text: `\`\`\`json\n${JSON.stringify(digest, null, 2)}\n\`\`\`` }];
            },
            presentationMeta(_args, value) {
              const result = value !== null && typeof value === "object" ? value : {};
              return { ok: result.ok === true, ...(result.ok === true ? {} : { error: result.error }) };
            },
          },
          presentCall() {
            return { card: "generic", title: "renpy_read_manifest", kind: "other" };
          },
          presentResult(_args, result) {
            const blocks = result?.content ?? [];
            return { card: "generic", title: "Ren'Py scan", content: blocks };
          },
          isConcurrencySafe() {
            return true;
          },
        }),
      "dsh-renpy-skin: renpy_read_manifest tool",
    );

    // ── model-facing: the renpy_save_vn tool ───────────────────────────────
    //
    // The end of an agent's own investigation of a game: it wrote down what the
    // reader could not work out (a directory tree, a corrected config, a
    // summary of what was found), and this writes that into the plugin's data
    // directory. The host writes rather than the agent because the agent's
    // tools are sandboxed to its workspace, and because a profile that lands in
    // the wrong place is worse than no profile at all.
    toolsCtx.effect(
      () =>
        tools.register({
          name: "renpy_save_vn",
          description:
            "Save what you learned about the loaded Ren'Py visual novel into the skin plugin's own " +
            "directory (`<data home>/game/<VN name>/`). It takes three pieces: `tree` (a directory tree " +
            "of the game's `game/` folder, one line of purpose per file and per folder), `config` (the " +
            "parts of the manifest the scan got wrong or could not read, applied ON TOP of the scan — " +
            "the reply names any section it did not honour), and `summary` (your compressed notes, kept " +
            "beside the profile as `summary.md`). Read the values the plugin already holds with " +
            "`renpy_read_manifest` first, and pass only what is wrong or missing. Writing the config " +
            "clears the cached manifest, so the next read of it comes from this profile.",
          parameters: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "The VN's display name, stored in the profile's `vn.json`. It does NOT choose the profile " +
                  "folder: that is fixed by the name the scan read, so a title correction cannot move the " +
                  "folder out from under the next read. Leave it out to keep the scanned name.",
              },
              tree: {
                type: "string",
                description:
                  "The `game/` directory tree as Markdown, each file and folder followed by what it is for.",
              },
              config: {
                type: "object",
                description:
                  "Profile values to apply over the scan. Recognised sections: game ({name, version, screen:{w,h}}), " +
                  "dialogbox, layout, choice, theme, characters, sprites. Anything outside that list is dropped — " +
                  "the reply names what was dropped — so a section you care about must be spelled exactly as listed. " +
                  "Asset fields (`dialogbox.textboxImage`, `dialogbox.nameboxImage`, `choice.idleBackground`, " +
                  "`choice.hoverBackground`, `dialogbox.font`) take a path relative to the game directory, NOT a " +
                  "URL: the host mints the served URL and recomputes the derived geometry after the overlay is " +
                  "merged, so a hand-written `/renpy-skin/asset?...` URL would be rebuilt from its `p` parameter.",
              },
              summary: {
                type: "string",
                description: "Your compressed session notes: what you found, what is still unknown.",
              },
              dryRun: {
                type: "boolean",
                description:
                  "Report what `config` would do without writing anything. The reply names the sections and " +
                  "fields that would be applied, ignored, malformed or unknown, which is how you check a profile " +
                  "before overwriting one that already works.",
              },
            },
          },
          async execute(args, exec) {
            const input = args !== null && typeof args === "object" ? args : {};
            const sessionId = String(exec?.agent?.id ?? "global");
            const gameDir = gameDirForSession(sessionId);
            if (typeof gameDir !== "string" || gameDir.length === 0) {
              return { ok: false, error: "no game is loaded; call renpy_configure first" };
            }
            let record;
            try {
              record = manifestFor(gameDir);
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            const name = typeof input.name === "string" && input.name.trim().length > 0
              ? input.name.trim()
              : record.manifest.game?.name ?? "";
            if (name.length === 0) {
              return { ok: false, error: "no name given and the scan did not read one; pass `name`" };
            }
            // The directory is keyed on the name the SCAN read, never on the
            // overlay's corrected name: the reader looks the profile up by the
            // scanned name, so a save under "CSE" for a game the scan calls
            // "CSE-2.1.0-pc" wrote a profile nothing would ever find.
            const dirName = record.profileName;
            const dir = join(dataHome(), "game", dirName);
            const written = [];
            const config = input.config !== null && typeof input.config === "object" ? input.config : {};
            // What the agent's `config` will actually do, computed from the same
            // rules the overlay applies: a section it spelled wrongly would
            // otherwise disappear without a word and be repeated next time.
            const report = inspectProfileConfig(config);
            const dryRun = input.dryRun === true;
            if (dryRun) {
              // Nothing is written and nothing is invalidated: the point is to
              // find out what WOULD be accepted before overwriting a profile
              // that already works. The merge runs against a copy of every
              // section the profile touches, so `applied` is the same list of
              // field paths a real save returns — a dry run answering in
              // section names would say `dialogbox` where the save says
              // `dialogbox.textColor`, and the one thing it is asked is what
              // will take effect. The copy also keeps the cached manifest from
              // gaining a dry run's values: the merge edits sections in place.
              const overlay = profileOverlay(config);
              const probe = {};
              for (const [section, values] of Object.entries(overlay ?? {})) {
                const current = record.manifest[section];
                probe[section] = current === undefined ? values : structuredClone(current);
              }
              const probeDiagnostics = {};
              const changed = applyProfile(probe, overlay, probeDiagnostics);
              const unresolved = unresolvedAssets(config, record.gameDir);
              return {
                ok: true,
                dryRun: true,
                dir,
                wouldWrite: {
                  tree: typeof input.tree === "string" && input.tree.trim().length > 0,
                  summary: typeof input.summary === "string" && input.summary.trim().length > 0,
                  vn: true,
                },
                applied: changed.filter((key) => !report.unknownKeys.includes(key)),
                ignored: report.ignored,
                malformed: report.malformed,
                unknownKeys: report.unknownKeys,
                ...(probeDiagnostics.unmatched === undefined
                  ? {}
                  : { unmatched: probeDiagnostics.unmatched }),
                ...(unresolved.length === 0 ? {} : { unresolved }),
              };
            }
            try {
              mkdirSync(dir, { recursive: true });
              if (typeof input.tree === "string" && input.tree.trim().length > 0) {
                writeFileSync(join(dir, "tree.md"), input.tree, "utf8");
                written.push("tree.md");
              }
              if (typeof input.summary === "string" && input.summary.trim().length > 0) {
                writeFileSync(join(dir, "summary.md"), input.summary, "utf8");
                written.push("summary.md");
              }
              const profile = {
                savedAt: new Date().toISOString(),
                // The RESOLVED directory, not the configured spelling: the same
                // game can be configured as its root or as its `game/`
                // subdirectory, and identity has to survive that.
                gameDir: record.gameDir,
                name,
                // Kept beside the overlay so the interface can say what the last
                // write did without the tool's reply being the only record of
                // it. Not an overlay section: the reader ignores unknown keys.
                report: {
                  ignored: report.ignored,
                  malformed: report.malformed,
                  unknownKeys: report.unknownKeys,
                },
                ...config,
              };
              writeFileSync(join(dir, "vn.json"), JSON.stringify(profile, null, 2), "utf8");
              written.push("vn.json");
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            // The profile is read at build time, so the cache has to go or the
            // interface would keep showing the scan's guesses.
            manifestCache.delete(record.gameDir);
            let applied = [];
            let unmatched = [];
            let rebuildError;
            // Checked before the rebuild, against the same game directory: the
            // paths do not depend on the profile being applied, and a missing
            // asset has to be reported even when the manifest cache would make
            // the rebuild a no-op.
            const unresolved = unresolvedAssets(config, record.gameDir);
            try {
              // The rebuild reads the same directory key this save wrote to, so
              // `applied` now describes THIS write. It used to be able to
              // describe a neighbour's profile, which made a successful-looking
              // save report fields it never set.
              const rebuilt = manifestFor(gameDir);
              // A key outside its section's known table does get written into
              // the manifest (the overlay keeps it, so a later revision of this
              // plugin can read it), but nothing reads it today: counting it as
              // applied would let a misspelling report a change that the
              // interface never shows. It is named in `unknownKeys` instead.
              applied = (rebuilt.manifest.profileApplied ?? []).filter(
                (key) => !report.unknownKeys.includes(key),
              );
              unmatched = rebuilt.manifest.profileUnmatched ?? [];
            } catch (error) {
              // A rebuild failure is the scan's problem, not the profile's: the
              // files are on disk either way. Reporting it beats an empty
              // `applied` that reads like "nothing matched".
              rebuildError = error instanceof Error ? error.message : String(error);
            }
            return {
              ok: true,
              dir,
              files: written,
              applied,
              // A `sprites.<tag>` patch only edits records the scan found. One
              // naming a tag it did not find is a profile written against a
              // different game, or against a tag spelled from memory — either
              // way the agent has to see it, or it will report a fix that never
              // landed.
              ...(unmatched.length === 0 ? {} : { unmatched }),
              // Saved through on purpose: a path that does not resolve today may
              // resolve once the user installs the missing archive, and losing
              // an otherwise good profile over it would be worse than naming it.
              ...(unresolved.length === 0 ? {} : { unresolved }),
              ignored: report.ignored,
              malformed: report.malformed,
              unknownKeys: report.unknownKeys,
              ...(rebuildError === undefined ? {} : { rebuildError }),
            };
          },
          output: {
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                dryRun: { type: "boolean" },
                dir: { type: "string" },
                files: { type: "array", items: { type: "string" } },
                wouldWrite: { type: "object" },
                applied: { type: "array", items: { type: "string" } },
                ignored: { type: "array", items: { type: "string" } },
                malformed: { type: "array", items: { type: "string" } },
                unknownKeys: { type: "array", items: { type: "string" } },
                unmatched: { type: "array", items: { type: "string" } },
                unresolved: { type: "array", items: { type: "string" } },
                rebuildError: { type: "string" },
                error: { type: "string" },
              },
              required: ["ok"],
              additionalProperties: true,
            },
            render(_args, value) {
              const result = value !== null && typeof value === "object" ? value : {};
              if (result.ok !== true) {
                return [{ type: "text", text: `renpy_save_vn failed: ${result.error ?? "unknown error"}` }];
              }
              const applied = Array.isArray(result.applied) ? result.applied : [];
              const ignored = Array.isArray(result.ignored) ? result.ignored : [];
              const malformed = Array.isArray(result.malformed) ? result.malformed : [];
              const unknownKeys = Array.isArray(result.unknownKeys) ? result.unknownKeys : [];
              // "Nothing changed" has four very different causes and the agent
              // must be able to tell them apart: the section name was not
              // recognised, its shape was wrong, the section is right but the
              // field name inside it is not, or it really did match.
              const notes = [];
              if (applied.length > 0) notes.push(`Applied over the scan: ${applied.join(", ")}.`);
              if (ignored.length > 0) {
                notes.push(
                  `Ignored ${ignored.join(", ")}: the overlay only honours ` +
                    `${OVERLAY_SECTIONS.join(", ")}.`,
                );
              }
              if (malformed.length > 0) {
                notes.push(
                  `Dropped ${malformed.join(", ")}: a section has to be an object of fields ` +
                    "(see the config description), and an empty one overrides nothing.",
                );
              }
              if (unknownKeys.length > 0) {
                // Written but not counted, because the client does not read
                // them: a typo looks exactly like a new field otherwise, and the
                // save keeps reporting success for something nothing consumes.
                notes.push(
                  `Check the spelling of ${unknownKeys.join(", ")}: the section exists but the field ` +
                    "is not one this plugin reads, so it is stored and not applied.",
                );
              }
              if (Array.isArray(result.unmatched) && result.unmatched.length > 0) {
                // The patch parsed, the section is right, the field names are
                // right — it simply named a sprite tag the scan never found, so
                // it edited no record. Saying so is the difference between "the
                // sprite is fixed" and "the file says the sprite is fixed".
                notes.push(
                  `Nothing to patch for ${result.unmatched.join(", ")}: the scan found no sprite under ` +
                    "that tag or name. Check the spelling, or read the manifest's spriteTags first.",
                );
              }
              if (Array.isArray(result.unresolved) && result.unresolved.length > 0) {
                // Deliberately not an error: the path may resolve once a missing
                // archive is installed, and refusing the write would lose an
                // otherwise good profile. It is not silence either — without the
                // note the agent reads "applied" and concludes the box changed.
                notes.push(
                  `${result.unresolved.join(", ")} resolve to no file or archive entry in this game, so ` +
                    "the interface keeps drawing what it drew before.",
                );
              }
              if (notes.length === 0) notes.push("It overrides nothing yet — the scan already matched it.");
              if (result.dryRun === true) {
                return [
                  {
                    type: "text",
                    text:
                      `Dry run — nothing was written. This config would go to ${result.dir ?? "?"}: ` +
                      notes.join(" "),
                  },
                ];
              }
              if (typeof result.rebuildError === "string") {
                notes.push(
                  `The files are on disk, but rebuilding the manifest failed: ${result.rebuildError}.`,
                );
              }
              return [
                {
                  type: "text",
                  text: `Saved the VN profile to ${result.dir ?? "?"} (${(result.files ?? []).join(", ")}). ` + notes.join(" "),
                },
              ];
            },
            presentationMeta(_args, value) {
              const result = value !== null && typeof value === "object" ? value : {};
              return { ok: result.ok === true, ...(result.ok === true ? {} : { error: result.error }) };
            },
          },
          isConcurrencySafe() {
            return false;
          },
        }),
      "dsh-renpy-skin: renpy_save_vn tool",
    );

    // ── model-facing: the renpy_memory tool ────────────────────────────────
    //
    // What the cast remembers between conversations. Stored beside the game's
    // profile (keyed by the SCANNED name, the same key the profile uses) rather
    // than in a file the model writes itself: the memory is keyed by the
    // manifest's character tags, and the model's own tools are sandboxed to its
    // workspace, so a path it could write is not a path this plugin would read.
    toolsCtx.effect(
      () =>
        tools.register({
          name: "renpy_memory",
          description:
            "Read or write the roleplay memory of the loaded visual novel: what each character remembers " +
            "from earlier conversations (promises, changes in a relationship, things that happened). One " +
            "memory per character tag, stored beside the game's profile and injected into the roleplay " +
            "prompt. `list` shows which characters have one, `read` returns the full text (the prompt only " +
            "carries the newest part), `append` adds one line, `replace` rewrites a character's memory " +
            "wholesale. Write only things that stay true and matter later, in the character's own voice.",
          parameters: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["list", "read", "append", "replace"],
                description: "`list` summaries, `read` full text, `append` one line, `replace` the whole memory.",
              },
              character: {
                type: "string",
                description:
                  "The character's sprite tag, exactly as the stage roster spells it (required for read, " +
                  "append and replace; omit on `read` to get every character that has a memory).",
              },
              text: {
                type: "string",
                description:
                  "The memory itself, as Markdown lines. Required for `append` and `replace`. Keep it short " +
                  "and factual; the newest 8000 characters are kept and older ones fall away.",
              },
            },
            required: ["action"],
          },
          async execute(args, exec) {
            const input = args !== null && typeof args === "object" ? args : {};
            const action = typeof input.action === "string" ? input.action : "";
            if (!["list", "read", "append", "replace"].includes(action)) {
              return { ok: false, error: `unknown action "${action}"; use list, read, append or replace` };
            }
            const sessionId = String(exec?.agent?.id ?? "global");
            const gameDir = gameDirForSession(sessionId);
            if (typeof gameDir !== "string" || gameDir.length === 0) {
              return { ok: false, error: "no game is loaded; call renpy_configure first" };
            }
            let record;
            try {
              record = manifestFor(gameDir);
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            const home = dataHome();
            const profileName = record.profileName;
            const tags = (record.manifest.tags ?? []).map((entry) => entry.tag);
            const nameOf = (tag) => {
              for (const info of Object.values(record.manifest.characters ?? {})) {
                if (info?.image === tag && typeof info?.name === "string" && info.name.length > 0) return info.name;
              }
              return undefined;
            };
            const character = typeof input.character === "string" ? input.character.trim() : "";
            const memories = readMemories(home, profileName);
            if (action === "list") {
              const known = tags.length > 0 ? tags : Object.keys(memories);
              return {
                ok: true,
                action,
                game: record.manifest.game?.name ?? record.scannedName,
                characters: known.map((tag) => ({
                  tag,
                  ...(nameOf(tag) === undefined ? {} : { name: nameOf(tag) }),
                  chars: (memories[tag] ?? "").length,
                })),
              };
            }
            if (action === "read") {
              const wanted = character.length > 0 ? [character] : tags.filter((tag) => memories[tag] !== undefined);
              return {
                ok: true,
                action,
                characters: wanted.map((tag) => ({
                  tag,
                  ...(nameOf(tag) === undefined ? {} : { name: nameOf(tag) }),
                  text: memories[tag] ?? "",
                })),
              };
            }
            // The tag has to be one the game actually declares, or the memory
            // would be filed under a name no future session could match — the
            // stage roster is the same list, so the correction is the same too.
            if (character.length === 0) {
              return { ok: false, error: "pass `character` (the sprite tag) for append and replace", tags };
            }
            if (!tags.includes(character)) {
              return { ok: false, error: `unknown character "${character}"`, tags };
            }
            const text = typeof input.text === "string" ? input.text : "";
            if (text.trim().length === 0) {
              return { ok: false, error: "pass `text` with the memory to store" };
            }
            const result =
              action === "append"
                ? appendMemory(home, profileName, character, text)
                : replaceMemory(home, profileName, character, text);
            if (result.ok !== true) return { ok: false, error: result.error };
            return {
              ok: true,
              action,
              character,
              chars: result.chars,
              ...(result.trimmed > 0
                ? { trimmed: result.trimmed, note: "older lines were dropped to stay within the memory limit" }
                : {}),
            };
          },
          output: {
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                action: { type: "string" },
                game: { type: "string" },
                character: { type: "string" },
                chars: { type: "number" },
                trimmed: { type: "number" },
                note: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                characters: { type: "array", items: { type: "object" } },
                error: { type: "string" },
              },
              required: ["ok"],
              additionalProperties: true,
            },
            render(_args, value) {
              const result = value !== null && typeof value === "object" ? value : {};
              if (result.ok !== true) {
                const tags = Array.isArray(result.tags) ? ` Known characters: ${result.tags.join(", ")}.` : "";
                return [{ type: "text", text: `renpy_memory failed: ${result.error ?? "unknown error"}.${tags}` }];
              }
              if (result.action === "list") {
                const list = (result.characters ?? []).filter((entry) => (entry?.chars ?? 0) > 0);
                if (list.length === 0) return [{ type: "text", text: "No character has a memory yet." }];
                return [
                  {
                    type: "text",
                    text: `Characters with a memory:\n${list
                      .map((entry) => `- ${entry.tag}${entry.name === undefined ? "" : ` (${entry.name})`}: ${entry.chars} characters`)
                      .join("\n")}`,
                  },
                ];
              }
              if (result.action === "read") {
                const entries = result.characters ?? [];
                if (entries.length === 0) return [{ type: "text", text: "That character has no memory yet." }];
                return [
                  {
                    type: "text",
                    text: entries
                      .map((entry) => `## ${entry.tag}${entry.name === undefined ? "" : ` (${entry.name})`}\n${entry.text.length === 0 ? "(nothing yet)" : entry.text}`)
                      .join("\n\n"),
                  },
                ];
              }
              return [
                {
                  type: "text",
                  text:
                    `Stored ${result.chars ?? 0} characters of memory for ${result.character ?? "?"}` +
                    (result.trimmed > 0 ? ` (dropped ${result.trimmed} older characters).` : "."),
                },
              ];
            },
            presentationMeta(_args, value) {
              const result = value !== null && typeof value === "object" ? value : {};
              return { ok: result.ok === true, ...(result.ok === true ? {} : { error: result.error }) };
            },
          },
          isConcurrencySafe() {
            return false;
          },
        }),
      "dsh-renpy-skin: renpy_memory tool",
    );
  });

  // ── browser-facing: HTTP routes ─────────────────────────────────────────
  //
  // Same `ctx.inject` wait as the two halves above, and the same failure mode:
  // a `ctx.get("webServer")` here can return `undefined` and silently skip
  // every registration below, leaving the SPA
  // fallback to answer 404 for the whole `/renpy-skin` prefix. The settings
  // page then renders but never reacts: the manifest read fails, so every
  // switch, slider and button renders its default and each write POSTs into a
  // 404, so no control ever changes state.
  //
  // This is not a hard dependency: a profile with no web server still gets the
  // prompt section, the tools and the `renpySkin` service.
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;
    if (webServer === undefined || typeof webServer.register !== "function") return;
    webCtx.effect(() => {
      const disposers = [];

      /** Parse `?key=value` query params from a Node request URL. */
      const query = (request) => {
        try {
          const index = (request.url ?? "").indexOf("?");
          if (index < 0) return new URLSearchParams();
          return new URLSearchParams(request.url.slice(index + 1));
        } catch {
          return new URLSearchParams();
        }
      };

      /** Reject a non-GET with 405 and no body. */
      const requireGet = (request, res) => {
        if ((request.method ?? "GET").toUpperCase() === "GET") return true;
        sendJson(res, { ok: false, error: "method not allowed" }, 405);
        return false;
      };

      /** Reject a non-POST with 405 and no body. */
      const requirePost = (request, res) => {
        if ((request.method ?? "GET").toUpperCase() === "POST") return true;
        sendJson(res, { ok: false, error: "method not allowed" }, 405);
        return false;
      };

      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/manifest`,
          handler: (request, res) => {
            if (!requireGet(request, res)) return;
            const params = query(request);
            const sessionId = params.get("session") ?? "global";
            const override = params.get("gameDir");
            if (override !== null && override.length > 0) {
              sessionGames.set(sessionId, override);
              settings = writeSettings({ gameDir: override });
            }
            const gameDir = gameDirForSession(sessionId);
            if (typeof gameDir !== "string" || gameDir.length === 0) {
              return sendJson(res, { ok: false, error: "no game directory configured", settings, library });
            }
            try {
              const record = manifestFor(gameDir);
              // Only a successful build is remembered: an index full of typos
              // the user mistyped once would be worse than no history.
              rememberGame(record, gameDir);
              return sendJson(res, {
                ok: true,
                manifest: record.manifest,
                root: record.root,
                settings,
                library,
                builtAt: record.builtAt,
              });
            } catch (error) {
              return sendJson(res, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                settings,
              });
            }
          },
        }),
      );

      // The opening-media picker's list, and the only route that can enumerate
      // assets that live inside a `.rpa`. Separate from `/manifest` because it
      // is needed by one control and would otherwise bloat every manifest with
      // a few thousand paths nobody reads.
      //
      // `?under=` and `?match=` filter server-side: the full list of a big game
      // is thousands of entries, and an agent looking for "any background under
      // images/bg/" should not have to receive all of them to find out.
      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/media`,
          handler: (request, res) => {
            if (!requireGet(request, res)) return;
            const params = query(request);
            const sessionId = params.get("session") ?? "global";
            let record;
            try {
              // The cheap half of `manifestFor`: its record is cached, and it
              // hands back the RESOLVED game directory, so the picker lists the
              // same files the manifest was built from.
              record = manifestFor(gameDirForSession(sessionId));
            } catch (error) {
              return sendJson(res, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                settings,
              });
            }
            const cached = mediaCache.get(record.gameDir);
            const media = cached ?? listGameMedia(record.gameDir);
            if (cached === undefined) mediaCache.set(record.gameDir, media);
            const under = params.get("under");
            const match = params.get("match");
            if (under === null && match === null) return sendJson(res, { ok: true, ...media });
            // Filtering is reported, not silent: `total` is the unfiltered count
            // and `matched` the filtered one, so a caller can tell "3 matches"
            // from "the game has 3 paths". One number cannot answer both, and
            // the wrong one reads as "this game has nothing under images/".
            const prefix = under === null ? "" : under.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
            const needle = match === null ? "" : match.toLowerCase();
            const keep = (path) => {
              const lower = path.replace(/\\/g, "/").toLowerCase();
              if (prefix.length > 0 && !lower.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) return false;
              return needle.length === 0 || lower.includes(needle);
            };
            const filtered = {};
            let matched = 0;
            let total = 0;
            for (const [kind, list] of Object.entries(media)) {
              if (!Array.isArray(list)) {
                filtered[kind] = list;
                continue;
              }
              const kept = list.filter((entry) => keep(typeof entry === "string" ? entry : entry?.path ?? ""));
              matched += kept.length;
              total += list.length;
              filtered[kind] = kept;
            }
            return sendJson(res, {
              ok: true,
              ...filtered,
              filter: { under, match, matched, total },
            });
          },
        }),
      );

      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/asset`,
          handler: (request, res) => {
            const params = query(request);
            const relativePath = params.get("p");
            const sessionId = params.get("session") ?? "global";
            if (relativePath === null || relativePath.length === 0) {
              res.statusCode = 400;
              res.setHeader("content-type", "text/plain; charset=utf-8");
              return res.end("missing p");
            }
            let record;
            try {
              record = manifestFor(gameDirForSession(sessionId));
            } catch (error) {
              res.statusCode = 404;
              res.setHeader("content-type", "text/plain; charset=utf-8");
              return res.end(error instanceof Error ? error.message : "no game");
            }
            const bytes = readAssetBytes(record.gameDir, relativePath);
            if (bytes === undefined) {
              res.statusCode = 404;
              res.setHeader("content-type", "text/plain; charset=utf-8");
              return res.end("not found");
            }
            const contentType = mimeFor(relativePath);
            // A splash video and the playlist are played by `<video>` /
            // `<audio>`, which issue a `Range` request as soon as the user
            // seeks. Without a 206 answer the element reports the media as
            // unseekable (and some browsers refuse to start it at all), so the
            // whole-buffer read is sliced here rather than served whole.
            const range = parseRange(request.headers?.range, bytes.length);
            if (range === undefined && /bytes=/i.test(String(request.headers?.range ?? ""))) {
              res.statusCode = 416;
              res.setHeader("content-range", `bytes */${bytes.length}`);
              return res.end();
            }
            const body = range === undefined ? bytes : bytes.subarray(range.start, range.end + 1);
            res.statusCode = range === undefined ? 200 : 206;
            res.setHeader("content-type", contentType);
            // Game assets are user files, not this plugin's own output: a `.png`
            // that is really HTML must not be sniffed into a document that runs
            // in the settings page's origin.
            res.setHeader("x-content-type-options", "nosniff");
            res.setHeader("accept-ranges", "bytes");
            // Safe to cache hard only because the URL carries `v=<assetToken>`:
            // the same relative path in another game (or after a re-read) is a
            // different URL, so an hour-long entry can never outlive its game.
            res.setHeader("cache-control", "private, max-age=3600");
            if (range !== undefined) {
              res.setHeader("content-range", `bytes ${range.start}-${range.end}/${bytes.length}`);
            }
            res.setHeader("content-length", body.length);
            return res.end(body);
          },
        }),
      );

      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/stage`,
          handler: (request, res) => {
            if (!requireGet(request, res)) return;
            const sessionId = query(request).get("session") ?? "global";
            return sendJson(res, { ok: true, stage: stages.snapshot(sessionId), settings });
          },
        }),
      );

      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/settings`,
          handler: (request, res) => {
            if ((request.method ?? "GET").toUpperCase() === "POST") {
              return readJsonBody(request)
                .then((patch) => {
                  const previousGameDir = settings.gameDir;
                  settings = writeSettings(patch ?? {});
                  applyToolPaths();
                  // Every per-game artefact goes at once: a stage keyed on the
                  // session, the safe areas the layout editor reserved, and a
                  // `session -> gameDir` pin that would otherwise keep serving
                  // the old game to that session after a switch.
                  if (settings.gameDir !== previousGameDir) forgetSessionState();
                  sendJson(res, { ok: true, settings, library });
                })
                .catch((error) =>
                  sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400),
                );
            }
            if (!requireGet(request, res)) return;
            // Which directory this plugin is actually writing to, and why. Two
            // homes exist on this machine (the pre-DSH `~/.dsh-renpy-skin` and
            // `$DSH_HOME/renpy-skin`) and the host's desktop process does not
            // always inherit `DSH_HOME`, so a profile written from the interface
            // and one written from a terminal session can land in different
            // places with no visible sign. Naming the resolved directory and the
            // rule that chose it is the only way to see that.
            return sendJson(res, { ok: true, settings, library, dataHome: resolveDataHome() });
          },
        }),
      );

      // ── the environment check ─────────────────────────────────────────────
      //
      // The settings page's "Environment" card lists what this plugin needs from
      // the machine and lets the user name the tools by hand, so this route is
      // what that card reads. It returns the same diagnosis
      // `tools/check-doctor.mjs` prints (data home, interpreter, unrpyc) plus the
      // download links: the page must not have to guess a version or re-derive
      // the lookup rules, and a second, divergent answer to "why is unrpyc not
      // usable" is the one thing that would make the card lie.
      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/doctor`,
          handler: (request, res) => {
            if (!requireGet(request, res)) return;
            // `?refresh=1` is the card's "check again" button. Without it the
            // cached diagnosis is served, exactly as the manifest's own tool
            // block does.
            const diagnosis = rpycDiagnostics({ refresh: query(request).get("refresh") === "1" });
            const configured = configuredToolPaths();
            const home = resolveDataHome();
            const legacyPresent =
              typeof home.legacy === "string" && home.legacy.length > 0 && existsSync(home.legacy);
            // "missing" and "broken" are different repairs: one means the tool is
            // not installed, the other that the path typed in is wrong. Collapsing
            // them would send the user to download what they already have.
            const statusOf = (chosen, resolved) =>
              resolved !== null ? "ok" : chosen !== "" ? "broken" : "missing";
            sendJson(res, {
              ok: true,
              node: { version: process.version, platform: process.platform, arch: process.arch },
              pluginRoot: pluginRoot(),
              dataHome: { ...home, legacyPresent },
              configured,
              python: diagnosis.python,
              unrpyc: diagnosis.unrpyc,
              usable: diagnosis.usable,
              reason: diagnosis.reason,
              install: diagnosis.install,
              // Ordered the way the card reads. Each row carries its own status,
              // reason and links, so a row for a tool added later needs no client
              // release beyond one more label.
              requirements: [
                {
                  id: "node",
                  required: true,
                  status: "ok",
                  detail: `${process.version} on ${process.platform} (${process.arch})`,
                  download: null,
                },
                {
                  id: "python",
                  required: false,
                  status: statusOf(configured.python, diagnosis.python.path),
                  detail: diagnosis.python.path ?? diagnosis.python.reason ?? "not found",
                  source: diagnosis.python.source,
                  checked: diagnosis.python.checked,
                  chosen: configured.python,
                  download: "https://www.python.org/downloads/",
                },
                {
                  id: "unrpyc",
                  required: false,
                  status: statusOf(configured.unrpyc, diagnosis.unrpyc.path),
                  detail: diagnosis.unrpyc.path ?? diagnosis.unrpyc.reason ?? "not found",
                  source: diagnosis.unrpyc.source,
                  tried: diagnosis.unrpyc.tried,
                  toolsDir: diagnosis.unrpyc.toolsDir,
                  chosen: configured.unrpyc,
                  download: "https://github.com/CensoredUsername/unrpyc",
                  // The release page ships no `unrpyc.py`, so the link a user can
                  // actually act on is the source archive.
                  archive: "https://codeload.github.com/CensoredUsername/unrpyc/zip/refs/tags/v2.0.4",
                },
                {
                  id: "dataHome",
                  required: false,
                  status: "ok",
                  detail: `${home.path} (source: ${home.source})`,
                  source: home.source,
                  legacy: home.legacy ?? null,
                  legacyPresent,
                  download: null,
                },
              ],
            });
          },
        }),
      );

      // ── roleplay memory ───────────────────────────────────────────────────
      //
      // GET  answers every character of the loaded game with its memory, for the
      //      settings page's editor.
      // POST writes one character's memory (`mode: "replace"` or `"append"`).
      //      The model has its own `renpy_memory` tool; this route exists so the
      //      user can write memory too, without going through a conversation —
      //      and so the editor can read back what the model wrote.
      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/memory`,
          handler: (request, res) => {
            const sessionId = query(request).get("session") ?? "global";
            const gameDir = gameDirForSession(sessionId);
            if (typeof gameDir !== "string" || gameDir.length === 0) {
              return sendJson(res, { ok: false, error: "no game directory configured" });
            }
            let record;
            try {
              record = manifestFor(gameDir);
            } catch (error) {
              return sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
            const home = dataHome();
            const profileName = record.profileName;
            const tags = (record.manifest.tags ?? []).map((entry) => entry.tag);
            const nameOf = (tag) => {
              for (const info of Object.values(record.manifest.characters ?? {})) {
                if (info?.image === tag && typeof info?.name === "string" && info.name.length > 0) return info.name;
              }
              return undefined;
            };
            const listing = () => {
              const memories = readMemories(home, profileName);
              return tags.map((tag) => ({
                tag,
                ...(nameOf(tag) === undefined ? {} : { name: nameOf(tag) }),
                chars: (memories[tag] ?? "").length,
                text: memories[tag] ?? "",
              }));
            };
            if ((request.method ?? "GET").toUpperCase() === "GET") {
              return sendJson(res, {
                ok: true,
                game: record.manifest.game?.name ?? record.scannedName,
                characters: listing(),
              });
            }
            return readJsonBody(request)
              .then((body) => {
                const tag = typeof body?.tag === "string" ? body.tag.trim() : "";
                const text = typeof body?.text === "string" ? body.text : "";
                if (tag.length === 0) return sendJson(res, { ok: false, error: "pass `tag`" }, 400);
                if (!tags.includes(tag)) {
                  return sendJson(res, { ok: false, error: `unknown character "${tag}"`, tags }, 400);
                }
                const result =
                  body?.mode === "append"
                    ? appendMemory(home, profileName, tag, text)
                    : replaceMemory(home, profileName, tag, text);
                if (result.ok !== true) return sendJson(res, { ok: false, error: result.error }, 400);
                return sendJson(res, {
                  ok: true,
                  tag,
                  chars: result.chars,
                  trimmed: result.trimmed,
                  characters: listing(),
                });
              })
              .catch((error) =>
                sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400),
              );
          },
        }),
      );

      // ── the dialogue plate picker ─────────────────────────────────────────
      //
      // POST { session?, path } picks one of the plates the scan found for this
      // game (`manifest.dialogbox.candidates`) and records the choice in the
      // game's profile as `dialogbox.textboxImage`. It writes the SAME file the
      // agent writes with `renpy_save_vn`, merged rather than replaced: the
      // profile may already carry colours, a font or a whole `layout` the agent
      // worked out, and a plate choice must not throw those away. The other
      // sections are copied through untouched, and only `dialogbox.textboxImage`
      // is set. The manifest is rebuilt before answering so the caller sees the
      // choice applied (URL, bounds and opaque box all re-derived).
      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/dialogbox`,
          handler: (request, res) => {
            if (!requirePost(request, res)) return;
            return readJsonBody(request)
              .then((body) => {
                const sessionId = typeof body?.session === "string" && body.session.length > 0 ? body.session : "global";
                const gameDir = gameDirForSession(sessionId);
                if (typeof gameDir !== "string" || gameDir.length === 0) {
                  return sendJson(res, { ok: false, error: "no game directory configured" }, 400);
                }
                let record;
                try {
                  record = manifestFor(gameDir);
                } catch (error) {
                  return sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
                }
                const wanted = typeof body?.path === "string" ? body.path.replace(/\\/g, "/").replace(/^\.\//, "") : "";
                if (wanted.length === 0) return sendJson(res, { ok: false, error: "pass `path`" }, 400);
                const candidates = Array.isArray(record.manifest.dialogbox?.candidates)
                  ? record.manifest.dialogbox.candidates
                  : [];
                const chosen = candidates.find(
                  (entry) => typeof entry?.path === "string" && entry.path.toLowerCase() === wanted.toLowerCase(),
                );
                if (chosen === undefined) {
                  // Only a plate this game ships can be chosen: accepting an
                  // arbitrary path would write a 404 into the profile and the
                  // dialogue box would silently fall back to the black plate.
                  return sendJson(
                    res,
                    {
                      ok: false,
                      error: `not a dialogue plate this game ships: ${wanted}`,
                      candidates: candidates.map((entry) => entry.path),
                    },
                    400,
                  );
                }
                const dir = join(dataHome(), "game", record.profileName);
                const existing = readProfile(join(dir, "vn.json"));
                const config = {};
                // A profile naming another directory is the neighbour's (two
                // games can share a name), so its sections are not carried over.
                if (existing !== undefined && profileBelongsToGame(savedGameDirOf(existing), record.gameDir)) {
                  for (const section of OVERLAY_SECTIONS) {
                    if (existing[section] !== undefined) config[section] = existing[section];
                  }
                }
                config.dialogbox = { ...(config.dialogbox ?? {}), textboxImage: chosen.path };
                try {
                  mkdirSync(dir, { recursive: true });
                  writeFileSync(
                    join(dir, "vn.json"),
                    JSON.stringify(
                      {
                        savedAt: new Date().toISOString(),
                        gameDir: record.gameDir,
                        name: typeof existing?.name === "string" && existing.name.length > 0 ? existing.name : record.scannedName,
                        report: existing?.report ?? {},
                        ...config,
                      },
                      null,
                      2,
                    ),
                    "utf8",
                  );
                } catch (error) {
                  return sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
                }
                manifestCache.delete(record.gameDir);
                let rebuilt;
                try {
                  rebuilt = manifestFor(gameDir);
                } catch (error) {
                  return sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
                }
                return sendJson(res, {
                  ok: true,
                  path: chosen.path,
                  applied: rebuilt.manifest.profileApplied ?? [],
                  manifest: rebuilt.manifest,
                  settings,
                  library,
                  builtAt: rebuilt.builtAt,
                });
              })
              .catch((error) =>
                sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400),
              );
          },
        }),
      );

      // ── the analysed-VN library ───────────────────────────────────────────
      //
      // GET  lists every game that has ever been analysed, newest first.
      // POST switches the active game: it persists `gameDir` (so a restart comes
      //      back to the same VN), drops every game-scoped cache, and answers
      //      with the fresh manifest so a caller needs one round-trip, not two.
      //      `gameDir: ""` re-reads the CURRENT game from disk — the "reload"
      //      action — instead of switching.
      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/library`,
          handler: (request, res) => {
            if ((request.method ?? "GET").toUpperCase() === "GET") {
              return sendJson(res, { ok: true, gameDir: settings.gameDir, library });
            }
            return readJsonBody(request)
              .then((body) => {
                const requested = typeof body?.gameDir === "string" ? body.gameDir.trim() : "";
                const switching = requested.length > 0 && requested.toLowerCase() !== (settings.gameDir ?? "").toLowerCase();
                if (switching) {
                  settings = writeSettings({ gameDir: requested });
                  forgetSessionState();
                } else {
                  // Same game: a reload still has to re-read the disk, because
                  // the whole point of the button is that the archive changed.
                  manifestCache.clear();
                  archiveCache.clear();
                  // The media list is what the opening picker shows, so a new
                  // file dropped into the game must appear after a reload.
                  mediaCache.clear();
                }
                const gameDir = settings.gameDir;
                if (typeof gameDir !== "string" || gameDir.length === 0) {
                  return sendJson(res, { ok: false, error: "no game directory configured", settings, library });
                }
                try {
                  const record = manifestFor(gameDir);
                  rememberGame(record, gameDir);
                  return sendJson(res, { ok: true, manifest: record.manifest, root: record.root, settings, library, builtAt: record.builtAt });
                } catch (error) {
                  return sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error), settings, library });
                }
              })
              .catch((error) =>
                sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400),
              );
          },
        }),
      );

      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/layout`,
          handler: (request, res) => {
            if ((request.method ?? "GET").toUpperCase() !== "POST") {
              return sendJson(res, { ok: false, error: "method not allowed" }, 405);
            }
            return readJsonBody(request)
              .then((body) => {
                const sessionId = typeof body?.session === "string" ? body.session : "global";
                sessionSafeAreas.set(sessionId, Array.isArray(body?.safeArea) ? body.safeArea : []);
                settings = writeSettings({
                  layoutProfiles: {
                    ...(settings.layoutProfiles ?? {}),
                    [typeof body?.vn === "string" ? body.vn : "default"]: body?.profile ?? {},
                  },
                });
                sendJson(res, { ok: true });
              })
              .catch((error) =>
                sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400),
              );
          },
        }),
      );

      // ── import / export the whole skin config ─────────────────────────────
      //
      // The export is the single source of truth for "what does my skin look
      // like": gameDir, every switch, and the layout profiles keyed by VN name.
      // Import accepts the same shape (or just the subset the user pastes), and
      // a gameDir in the imported object is applied and persisted immediately.
      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/export`,
          handler: (request, res) => {
            if (!requireGet(request, res)) return;
            const payload = {
              exportedAt: new Date().toISOString(),
              plugin: "dsh-renpy-skin",
              version: 1,
              settings,
            };
            const gameDir = gameDirForSession(query(request).get("session") ?? "global");
            if (typeof gameDir === "string" && gameDir.length > 0) payload.settings.gameDir = gameDir;
            sendJson(res, { ok: true, config: payload });
          },
        }),
      );

      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/import`,
          handler: (request, res) => {
            if ((request.method ?? "GET").toUpperCase() !== "POST") {
              return sendJson(res, { ok: false, error: "method not allowed" }, 405);
            }
            return readJsonBody(request)
              .then((body) => {
                const incoming = body?.config !== undefined ? body.config : body;
                const incomingSettings = incoming?.settings !== undefined ? incoming.settings : incoming;
                if (incomingSettings === null || typeof incomingSettings !== "object") {
                  return sendJson(res, { ok: false, error: "import payload must be an object" }, 400);
                }
                const previousGameDir = settings.gameDir;
                settings = writeSettings(incomingSettings);
                applyToolPaths();
                const nextGameDir = settings.gameDir;
                if (nextGameDir !== previousGameDir) {
                  manifestCache.clear();
                  stages.stages.clear();
                }
                sendJson(res, { ok: true, settings });
              })
              .catch((error) =>
                sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400),
              );
          },
        }),
      );

      // ── handing a loaded game to a fresh agent session ────────────────────
      //
      // "Load with Agent" used to paste a prompt that asked the model to find the
      // game, so the model's first movement was to ask the user for a path it
      // could not read. The prepare step does the work up front instead: it
      // builds the manifest (20–30 s on a large game), writes the two listings,
      // and answers with everything the prompt needs to name real paths. The
      // client then opens a session in the profile directory and sends the
      // prompt — no discovery, no guessing.
      //
      // It is a POST because it re-reads the disk and replaces the active game;
      // a GET would be cached and retried as if it were free.
      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/agent/prepare`,
          handler: (request, res) => {
            if ((request.method ?? "GET").toUpperCase() !== "POST") {
              return sendJson(res, { ok: false, error: "method not allowed" }, 405);
            }
            return readJsonBody(request)
              .then((body) => {
                const sessionId =
                  typeof body?.session === "string" && body.session.length > 0 ? body.session : "global";
                // `gameDir` is optional: omitting it prepares whatever the
                // session already has loaded, which is what the button does.
                const requested =
                  typeof body?.gameDir === "string" && body.gameDir.trim().length > 0
                    ? body.gameDir.trim()
                    : gameDirForSession(sessionId);
                if (typeof requested !== "string" || requested.length === 0) {
                  return sendJson(
                    res,
                    { ok: false, error: "no game is loaded; set one in Settings → Ren'Py skin first" },
                    400,
                  );
                }

                // Read first and commit afterwards. `manifestFor` and the scan
                // both accept any directory that exists — a random folder
                // still yields a manifest whose name falls back to the folder
                // name — so persisting on the way in would point the skin at a
                // non-game and strand the previous one.
                try {
                  if (!statSync(requested).isDirectory()) {
                    return sendJson(res, { ok: false, error: `not a directory: ${requested}` }, 400);
                  }
                } catch {
                  return sendJson(res, { ok: false, error: `the game directory does not exist: ${requested}` }, 400);
                }

                let record;
                try {
                  record = manifestFor(requested);
                } catch (error) {
                  return sendJson(
                    res,
                    { ok: false, error: error instanceof Error ? error.message : String(error) },
                    400,
                  );
                }

                const name = record.scannedName ?? "";
                if (name.length === 0) {
                  return sendJson(res, { ok: false, error: "the scan read no game name" }, 400);
                }

                let scanned;
                try {
                  scanned = scanGameTree(record.gameDir, { manifest: record.manifest });
                } catch (error) {
                  return sendJson(
                    res,
                    { ok: false, error: error instanceof Error ? error.message : String(error) },
                    400,
                  );
                }

                // A Ren'Py game has scripts, and they may live inside an
                // archive instead of the file system, so either one is enough.
                // Neither is a folder that merely happens to be pointed at.
                if (scanned.stats.scripts === 0 && scanned.stats.archives === 0) {
                  return sendJson(
                    res,
                    {
                      ok: false,
                      error: `not a Ren'Py game: no .rpy/.rpyc script and no .rpa archive under ${record.gameDir}`,
                    },
                    400,
                  );
                }

                // Persist the choice first, and only then pin the session: a
                // switch runs `forgetSessionState()`, which empties
                // `sessionGames` — setting the pin before that would drop it,
                // and the tool would fall back to whatever the setting held.
                const previousGameDir = settings.gameDir;
                settings = writeSettings({ gameDir: requested });
                if (settings.gameDir !== previousGameDir) forgetSessionState();
                // Pin the session to this game before building: the prompt is
                // sent to a NEW session whose id the host invents, and a pin is
                // what lets the tool default to the same game there.
                sessionGames.set(sessionId, requested);
                rememberGame(record, requested);

                // Both listings live beside the profile, so the agent can read
                // the full one back and the interface can show the compact one
                // without a second scan. Same directory key as the profile
                // itself — the scanned name, before any overlay renames the game.
                const profileDir = join(dataHome(), "game", record.profileName);
                try {
                  mkdirSync(profileDir, { recursive: true });
                  writeFileSync(join(profileDir, "scan-tree.md"), scanned.compact, "utf8");
                  writeFileSync(join(profileDir, "scan-tree.full.txt"), scanned.full, "utf8");
                } catch (error) {
                  return sendJson(
                    res,
                    { ok: false, error: `could not write the scan into ${profileDir}: ${error instanceof Error ? error.message : String(error)}` },
                    500,
                  );
                }

                return sendJson(res, {
                  ok: true,
                  gameDir: record.gameDir,
                  root: record.root,
                  profileDir,
                  name,
                  // The prompt is assembled by the client so it can speak the
                  // interface's language; these are the facts it needs.
                  paths: {
                    gameDir: record.gameDir,
                    profileDir,
                    compactTree: join(profileDir, "scan-tree.md"),
                    fullTree: join(profileDir, "scan-tree.full.txt"),
                  },
                  stats: {
                    ...scanned.stats,
                    // The manifest's own view of the game, which is what the
                    // skin will actually paint.
                    backgrounds: record.manifest.backgrounds?.length ?? 0,
                    // Two different lists: the cast the scripts declare
                    // (`Character(...)`) and the sprite buckets the art is filed
                    // under. Reporting one number for both hid the mismatch —
                    // CSE declares six speakers under folder names the tags do
                    // not use.
                    characters: Object.keys(record.manifest.characters ?? {}).length,
                    spriteTags: record.manifest.tags?.length ?? 0,
                    gameName: name,
                  },
                });
              })
              .catch((error) =>
                sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400),
              );
          },
        }),
      );

      // What the agent wrote about the loaded VN. Read-only: the writing half is
      // the `renpy_save_vn` tool, because an agent's own file tools are confined
      // to its workspace and the profile has to land in the plugin's data home.
      disposers.push(
        webServer.register({
          kind: "exact",
          path: `${ROUTE_BASE}/vn`,
          handler: (request, res) => {
            if (!requireGet(request, res)) return;
            const sessionId = query(request).get("session") ?? "global";
            const gameDir = gameDirForSession(sessionId);
            if (typeof gameDir !== "string" || gameDir.length === 0) {
              return sendJson(res, { ok: true, profile: null, dir: null });
            }
            let record;
            try {
              record = manifestFor(gameDir);
            } catch (error) {
              return sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
            }
            // The profile directory is keyed on the SCANNED name, which is what
            // `manifestFor` used to find the profile in the first place. Keying
            // it on the overlaid `game.name` looked at a directory the reader
            // never consults once a profile corrects the title.
            const name = record.scannedName ?? "";
            const dir = join(dataHome(), "game", record.profileName);
            return sendJson(res, {
              ok: true,
              dir,
              name,
              profile: readProfile(join(dir, "vn.json")) ?? null,
              // The agent's own notes, so the interface can show what the last
              // run concluded and not only that a file exists.
              summary: readNoteHead(join(dir, "summary.md")),
              tree: readNoteHead(join(dir, "tree.md")),
              // `readNoteHead` truncates to keep the settings page responsive;
              // saying so beats a note that silently stops mid-sentence.
              notes: {
                summary: noteSize(join(dir, "summary.md")),
                tree: noteSize(join(dir, "tree.md")),
              },
              applied: record.manifest.profileApplied ?? [],
              // `sprites.<tag>` patches whose tag no scanned sprite carries:
              // the section applied, so without this the settings page would
              // show a clean "applied" for a fix that reached nothing.
              unmatched: record.manifest.profileUnmatched ?? [],
              // Set when the profile on disk belongs to a DIFFERENT game that
              // happens to share this one's name: it is deliberately not
              // applied, and a reader has to be able to see why nothing changed.
              rejected: record.manifest.profileRejected ?? null,
            });
          },
        }),
      );

      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "dsh-renpy-skin: http routes");
  });

  // A service other plugins can consume to place a sprite without the model.
  ctx.effect(
    () =>
      ctx.provide("renpySkin", {
        settings: () => settings,
        manifest: (gameDir) => manifestFor(gameDir ?? settings.gameDir).manifest,
        stage: (sessionId) => stages.snapshot(sessionId ?? "global"),
        async setStage(sessionId, script) {
          const record = manifestFor(gameDirForSession(sessionId));
          const outcome = applyStatements(
            stages.get(sessionId),
            parseScript(script, undefined),
            record.manifest,
            { autoAvoid: settings.autoAvoid === true, safeArea: safeAreaFor(sessionId, record.manifest), enabledCharacters: settings.enabledCharacters },
          );
          stages.emit(sessionId);
          return outcome;
        },
        subscribe: (listener) => stages.subscribe(listener),
      }),
    "dsh-renpy-skin: service",
  );
}

/**
 * Render a rejected stage command for the model, naming what does exist so the
 * next attempt can succeed.
 * @param result the rejected tool value.
 * @returns the text shown to the model.
 */
function formatRejection(result) {
  const lines = [`renpy_stage rejected the script: ${result.error ?? "invalid command"}`];
  if (Array.isArray(result.hint ? [result.hint] : []) && result.hint !== undefined) {
    lines.push(`hint: ${result.hint}`);
  }
  if (Array.isArray(result.tags) && result.tags.length > 0) {
    lines.push("", "Characters you may use (tag: attributes):");
    for (const entry of result.tags.slice(0, 30)) {
      lines.push(`  ${entry.tag}: ${(entry.attributes ?? []).join(" / ")}`);
    }
  }
  if (Array.isArray(result.backgrounds) && result.backgrounds.length > 0) {
    lines.push("", `Backgrounds you may use: ${result.backgrounds.slice(0, 30).join(", ")}`);
  }
  if (Array.isArray(result.builtinTransforms) && result.builtinTransforms.length > 0) {
    lines.push(`Built-in transforms: ${result.builtinTransforms.join(", ")}`);
  }
  if (Array.isArray(result.gameTransforms) && result.gameTransforms.length > 0) {
    lines.push(`Transforms defined by this game: ${result.gameTransforms.slice(0, 30).join(", ")}`);
  }
  if (Array.isArray(result.supportedTransitions) && result.supportedTransitions.length > 0) {
    lines.push(`Supported transitions: ${result.supportedTransitions.join(", ")}`);
  }
  lines.push("", "Correct the script and call renpy_stage again.");
  return lines.join("\n");
}

/**
 * Render a successfully applied script, including the resulting stage so the
 * model can reason about what is on screen without guessing.
 * @param result the successful tool value.
 * @returns the text shown to the model.
 */
function formatApplied(result) {
  const lines = [];
  const applied = Array.isArray(result.applied) ? result.applied : [];
  for (const entry of applied) {
    if (entry.kind === "scene") lines.push(`scene: ${entry.scene ?? "(cleared)"}`);
    else if (entry.kind === "show") lines.push(`show: ${entry.image} as ${entry.tag}`);
    else if (entry.kind === "hide") lines.push(`hide: ${entry.tag}`);
    else if (entry.kind === "with") lines.push(`with: ${entry.transition}`);
    else lines.push(`${entry.kind}: ${JSON.stringify(entry)}`);
  }
  if (lines.length === 0) lines.push("no stage change was required (the stage already matched)");
  const stage = result.stage ?? {};
  lines.push(
    "",
    `stage now: background ${stage.scene?.image ?? "none"}; sprites ${(stage.sprites ?? [])
      .map((sprite) => `${sprite.tag}=${sprite.image}${sprite.side === true ? " (side)" : ""}`)
      .join(", ") || "none"}`,
  );
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}

/**
 * Parse a whole stage script into commands.
 * @param script newline-separated display statements.
 * @param defaultTransition transition applied to statements that omit one.
 * @returns the parsed commands.
 */
function parseScript(script, defaultTransition) {
  const lines = logicalLines(String(script ?? ""));
  if (lines.length === 0) {
    throw new StageError("the script is empty; pass at least one display statement");
  }
  const statements = lines.map((line) => parseStatement(line));
  if (typeof defaultTransition === "string" && defaultTransition.length > 0) {
    for (const statement of statements) {
      if (statement.kind === "show" || statement.kind === "scene") {
        statement.transition ??= defaultTransition;
      }
    }
  }
  return statements;
}

/** Archive handles cached per absolute path, so repeated assets skip the index. */
const archiveCache = new Map();

/**
 * Read one displayable's bytes, resolving it against the loose game directory
 * and then the game's `.rpa` archives. The resolved loose path is contained
 * inside `gameDir`.
 *
 * @param gameDir the game directory.
 * @param relativePath displayable path from the manifest.
 * @returns the bytes, or `undefined`.
 */
/**
 * Profile fields that name an asset, and can therefore point at a file that is
 * not there.
 *
 * A profile is written by a model that has read asset paths out of a tree
 * listing or a manifest, so a typo is a real possibility — and the failure it
 * produces is silent in the worst way: the dialogue box simply keeps drawing its
 * previous image, with nothing anywhere saying the path was wrong. Checking the
 * paths costs one file probe each and turns that into a named field.
 */
const ASSET_FIELDS = [
  ["dialogbox", "textboxImage"],
  ["dialogbox", "nameboxImage"],
  ["choice", "idleBackground"],
  ["choice", "hoverBackground"],
  ["game", "mainMenuMusic"],
];

/**
 * The game-relative path an asset value names, or `undefined` when it names
 * nothing this game can serve.
 *
 * A profile may carry either spelling: the bare path an author writes, or a URL
 * copied back out of a manifest digest. The URL is decoded and re-minted rather
 * than trusted, because it was minted against an older build's cache token.
 */
function assetPathOf(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (/^[a-z]+:\/\//i.test(value)) return undefined;
  const parameter = /[?&]p=([^&]*)/.exec(value);
  if (parameter !== null) {
    try {
      return decodeURIComponent(parameter[1]).replace(/\\/g, "/");
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("/")) return undefined;
  return value.replace(/\\/g, "/");
}

/**
 * Recompute the fields the scan derives from an asset path.
 *
 * `renpy_save_vn` writes what the author asked for; this turns those strings
 * back into the values the browser half consumes. Only fields the profile
 * actually changed are touched, so a profile that names no assets keeps the
 * scan's own URLs and measurements exactly.
 *
 * @param manifest the overlaid manifest, mutated in place.
 * @param changed the `profileApplied` list, as `section.key` paths.
 * @param options `assetUrl` mints a serving URL, `readBytes` reads a game file.
 */
function rederiveAssets(manifest, changed, { assetUrl, readBytes }) {
  if (!Array.isArray(changed) || changed.length === 0) return;
  const touched = new Set(changed);

  /**
   * Re-mint one image field and the geometry read out of its bytes. A path the
   * game cannot supply clears the geometry instead of keeping the PREVIOUS
   * image's numbers: stale measurements draw a broken box at the old size,
   * while no geometry at all falls back to the canvas, which is visibly wrong
   * but honest. `renpy_save_vn` already reports that path as unresolved.
   */
  const image = (section, key, boundsKey, boxKey, pathKey) => {
    if (!touched.has(`${section}.${key}`)) return;
    const block = manifest[section];
    if (block === null || typeof block !== "object") return;
    const path = assetPathOf(block[key]);
    if (path === undefined) return;
    block[key] = assetUrl(path);
    // The path a profile wrote is kept beside the URL it is served under: the
    // plate picker compares against `candidates[].path`, and a second override
    // has to start from the path, not from a URL minted for an older build.
    if (pathKey !== undefined) block[pathKey] = path;
    const bytes = readBytes(path);
    const extension = extname(path).toLowerCase();
    if (boundsKey !== undefined) {
      block[boundsKey] = bytes === undefined ? undefined : readImageSize(bytes, extension);
    }
    if (boxKey !== undefined) {
      block[boxKey] = bytes === undefined || extension !== ".png" ? undefined : pngOpaqueBounds(bytes);
    }
  };

  image("dialogbox", "textboxImage", "textboxImageBounds", "textboxImageBox", "textboxPath");
  // The candidate list is ordered by the SCAN, but the profile is applied after
  // it: switching plates left the previous one leading the list, so the picker
  // drew the wrong plate as "current" and `candidates[0]` disagreed with the
  // box actually on screen. The chosen plate leads, and one the scan never
  // offered (a path a profile named by hand) joins the list rather than
  // disappearing from the picker.
  if (touched.has("dialogbox.textboxImage") && Array.isArray(manifest.dialogbox?.candidates)) {
    const list = manifest.dialogbox.candidates;
    const chosen = manifest.dialogbox.textboxPath;
    if (typeof chosen === "string" && chosen.length > 0) {
      const index = list.findIndex((entry) => typeof entry?.path === "string" && entry.path.toLowerCase() === chosen.toLowerCase());
      if (index > 0) {
        list.unshift(list.splice(index, 1)[0]);
      } else if (index === -1) {
        const bytes = readBytes(chosen);
        list.unshift({
          path: chosen,
          source: "profile",
          url: assetUrl(chosen),
          bounds: bytes === undefined ? undefined : readImageSize(bytes, extname(chosen).toLowerCase()),
        });
      }
    }
  }
  image("dialogbox", "nameboxImage", "nameboxBounds", undefined);
  // Module art is written as game-relative paths — that is what the digest
  // shows and what a profile stores — while the browser half draws `imageUrl`.
  // Every node is re-minted here, including the ones the scan produced, because
  // once a profile touches `dialogbox.modules` the whole list is the profile's.
  // A node naming no usable path clears its URL rather than keeping the previous
  // build's token; a path the game does not ship still gets one, and
  // `renpy_save_vn` reports that path as unresolved.
  if (touched.has("dialogbox.modules") && Array.isArray(manifest.dialogbox?.modules)) {
    const serve = (node, key) => {
      if (node === null || typeof node !== "object") return;
      const path = assetPathOf(node[key]);
      if (path === undefined) {
        node[`${key}Url`] = undefined;
        return;
      }
      node[key] = path;
      node[`${key}Url`] = assetUrl(path);
    };
    for (const module of manifest.dialogbox.modules) {
      serve(module, "image");
      serve(module?.hover, "image");
    }
  }
  image("choice", "idleBackground", undefined, undefined);
  image("choice", "hoverBackground", undefined, undefined);

  if (!touched.has("dialogbox.font") && !touched.has("dialogbox.fontPath")) return;
  const dialogbox = manifest.dialogbox;
  if (dialogbox === null || typeof dialogbox !== "object") return;
  const hint = touched.has("dialogbox.fontPath") ? assetPathOf(dialogbox.fontPath) : undefined;
  const declaration = typeof dialogbox.font === "string" ? dialogbox.font : undefined;
  // The declaration is a path in the game's own spelling; the font catalog has
  // already resolved every one it found, including bare filenames and the
  // differently-cased spellings Ren'Py tolerates.
  const known = Array.isArray(manifest.fonts) ? manifest.fonts : [];
  const normalised = hint ?? (declaration === undefined ? undefined : declaration.replace(/\\/g, "/"));
  const bare = normalised === undefined ? undefined : basename(normalised).toLowerCase();
  const entry =
    normalised === undefined
      ? undefined
      : known.find(
          (candidate) =>
            candidate.path === normalised ||
            (bare !== undefined && basename(candidate.path).toLowerCase() === bare),
        );
  const path = entry === undefined ? hint : entry.path;
  if (path === undefined) {
    // Ren'Py bundles a few fonts (`DejaVuSans.ttf`) that live in the engine, not
    // in the game. Nothing can serve those bytes, so the interface falls back to
    // its own font instead of pointing `@font-face` at a 404.
    dialogbox.fontUrl = undefined;
    return;
  }
  dialogbox.fontPath = path;
  dialogbox.fontUrl = assetUrl(path);
}

/**
 * The asset paths in a `config` argument that no file or archive can supply.
 *
 * @param config the `renpy_save_vn` config object.
 * @param gameDir the resolved game directory to probe.
 * @returns `section.key` paths, in the order they were declared.
 */
function unresolvedAssets(config, gameDir) {
  const missing = [];
  for (const [section, key] of ASSET_FIELDS) {
    const value = config?.[section]?.[key];
    if (typeof value !== "string" || value.length === 0) continue;
    // A URL is minted by the scan and already carries this plugin's prefix; it
    // is a value read back from a manifest, not a path to probe.
    if (/^[a-z]+:\/\//i.test(value) || value.startsWith(`${ROUTE_BASE}/`)) continue;
    if (readAssetBytes(gameDir, value) === undefined) missing.push(`${section}.${key}`);
  }
  // Module art is named per node, so the report names the node the way the
  // digest does (`dialogbox.modules[2].image`) — a bare key would not say which
  // of forty rows is broken.
  const modules = config?.dialogbox?.modules;
  if (Array.isArray(modules)) {
    modules.forEach((module, index) => {
      const fields = [["image", module?.image], ["hover.image", module?.hover?.image]];
      for (const [field, value] of fields) {
        if (typeof value !== "string" || value.length === 0) continue;
        if (/^[a-z]+:\/\//i.test(value) || value.startsWith(`${ROUTE_BASE}/`)) continue;
        if (readAssetBytes(gameDir, value) === undefined) missing.push(`dialogbox.modules[${index}].${field}`);
      }
    });
  }
  return missing;
}

function readAssetBytes(gameDir, relativePath) {
  const normalised = relativePath.replace(/\\/g, "/");
  if (normalised.includes("..") || normalised.startsWith("/")) return undefined;
  const absolute = join(gameDir, normalised);
  if (existsSync(absolute)) {
    try {
      return readFileSync(absolute);
    } catch {
      return undefined;
    }
  }
  for (const archivePath of listArchives(gameDir)) {
    try {
      let archive = archiveCache.get(archivePath);
      if (archive === undefined) {
        archive = openRpa(archivePath);
        archiveCache.set(archivePath, archive);
      }
      if (archive.has(normalised)) return archive.read(normalised);
    } catch {
      // A broken archive must not shadow a later one.
    }
  }
  return undefined;
}

/** List the `.rpa` archives directly inside a game directory. */
function listArchives(gameDir) {
  try {
    return readdirSync(gameDir)
      .filter((entry) => entry.toLowerCase().endsWith(".rpa"))
      .map((entry) => join(gameDir, entry));
  } catch {
    return [];
  }
}

/**
 * Extract a session id from an assembly context, tolerating the shapes the
 * prompt pipeline can hand a section callback.
 * @param assembly the assembly context.
 * @returns a stable session key.
 */
function sessionIdOf(assembly) {
  const scope = assembly?.scope;
  if (scope === undefined || scope === null) return "global";
  if (typeof scope.id === "string") return scope.id;
  if (typeof scope.sessionId === "string") return scope.sessionId;
  const header = scope.header;
  if (header !== undefined && header !== null && typeof header.id === "string") return header.id;
  return "global";
}

/**
 * The stage-director brief injected into the system prompt. It is regenerated
 * on every model step, so the roster always matches the current manifest.
 *
 * @param manifest the asset manifest.
 * @param options.settings and safeArea.
 * @returns the prompt section text.
 */
export function directorBrief(manifest, { settings: current, safeArea } = {}) {
  // The user's character ticks. An empty list means "every character", so an
  // untouched settings page offers the whole cast; a non-empty list narrows
  // both the roster below and the `show` validation in applyStatements, so the
  // brief and the tool can never disagree about who exists.
  const enabled = Array.isArray(current?.enabledCharacters) ? current.enabledCharacters : [];
  const roster =
    enabled.length === 0
      ? manifest.tags
      : manifest.tags.filter((entry) => enabled.includes(entry.tag));
  // `Character(...)` declarations, keyed by the variable the game uses. Two
  // different things come out of them: the display name behind a sprite tag
  // (`qc` is shown as 启诚) and the cast the sprite scan cannot see at all, when
  // `image="qc"` does not match the folder the art lives in.
  const declared = manifest.characters ?? {};
  const declaredFor = (tag) => {
    const direct = declared[tag];
    if (direct !== undefined) return direct;
    // The sprite tag and the character variable are usually the same word, but
    // a `Character(image="...")` can name a tag that is not its own variable.
    return Object.values(declared).find((info) => info?.image === tag);
  };
  const tagLines = roster
    .slice(0, 60)
    .map((entry) => {
      const attributes = entry.expressions
        .map((expression) => expression.label)
        .slice(0, 8)
        .join(" / ");
      const info = declaredFor(entry.tag);
      const shown =
        typeof info?.name === "string" && info.name.length > 0 && info.name !== entry.tag
          ? ` (named ${info.name} in the dialogue box)`
          : "";
      return `  - ${entry.tag}${shown}: ${attributes}`;
    })
    .join("\n");
  // Declared but with no sprite the scan could name. Reported so a game whose
  // `image=` points elsewhere does not read as "this game has no characters".
  const declaredOnly = Object.entries(declared)
    .filter(([variable, info]) => {
      if (roster.some((entry) => entry.tag === variable)) return false;
      const image = typeof info?.image === "string" && info.image.length > 0 ? info.image : undefined;
      return image === undefined || !roster.some((entry) => entry.tag === image);
    })
    .slice(0, 20)
    .map(([variable, info]) => {
      const name = typeof info?.name === "string" && info.name.length > 0 ? info.name : variable;
      const tag = typeof info?.image === "string" && info.image.length > 0 ? ` — sprites are shown as \`${info.image}\`` : "";
      return `  - ${name}${tag}`;
    })
    .join("\n");
  const backgroundLines = manifest.backgrounds
    .slice(0, 40)
    .map((entry) => `  - ${entry.name}`)
    .join("\n");
  const transformLines = Object.keys(BUILTIN_TRANSFORMS).join(", ");
  const gameTransforms = Object.keys(manifest.transforms ?? {}).slice(0, 30);
  const safeLines = (safeArea ?? [])
    .map(
      (rect) =>
        `  - ${rect.id}: x=${Number(rect.x).toFixed(3)} y=${Number(rect.y).toFixed(3)} w=${Number(rect.w).toFixed(3)} h=${Number(rect.h).toFixed(3)}`,
    )
    .join("\n");

  return [
    `## Ren'Py stage director`,
    ``,
    `This conversation's interface is skinned as the Ren'Py visual novel **${manifest.game.name}**` +
      (manifest.game.version === undefined ? "" : ` (v${manifest.game.version})`) +
      `. The stage canvas is ${manifest.game.screen.w}x${manifest.game.screen.h} design units and is scaled to fit; all positions below are fractions of that canvas.`,
    ``,
    `Call the \`renpy_stage\` tool with a script of Ren'Py display statements (one per line). Do not describe the stage in prose instead of calling it.`,
    ``,
    `### Accepted syntax`,
    "```",
    `scene <background> [with <transition>]`,
    `show <tag> [<attribute> ...] [as <tag>] [at <transform>[, ...]] [behind <tag>] [zorder <int>]`,
    `hide <tag>`,
    `with <transition>`,
    "```",
    `- \`scene\` clears the stage and optionally sets a background; \`show\` is idempotent per tag (re-showing a tag swaps its expression); \`hide\` removes one tag.`,
    `- Transitions: ${[...SUPPORTED_TRANSITIONS].filter((entry) => entry !== "None").join(", ")}. Anything else is rejected.`,
    `- Built-in transforms: ${transformLines}.`,
    gameTransforms.length > 0
      ? `- Transforms defined by this game: ${gameTransforms.join(", ")}.`
      : "",
    `- Inline transforms: \`at Transform(xpos=0.35, ypos=1.0, xanchor=0.5, yanchor=1.0, zoom=0.9, alpha=0.6)\`.`,
    `- Properties: xpos, ypos, xanchor, yanchor, xalign, yalign, xoffset, yoffset, zoom, alpha, rotate, zorder.`,
    `- \`show side <tag>\` attaches the speaker's half-body image beside the dialogue box; it is a plugin extension, not engine syntax.`,
    ``,
    `### Available characters`,
    manifest.tags.length === 0
      ? declaredOnly.length > 0
        ? `  - (no character sprites could be matched to a tag, but the scripts declare these:)\n${declaredOnly}`
        : // With no scripts read, "no characters" is a claim about the reader, not
          // about the game: every `Character(...)` and every sprite statement
          // lives in those scripts. Saying why beats a sentence the game may
          // silently contradict.
          typeof manifest.scripts?.reason === "string"
          ? `  - (no character sprites could be identified: ${manifest.scripts.reason})`
          : "  - (this game declares no character sprites)"
      : roster.length === 0
        ? "  - (none of the game's characters are enabled; the user must tick them in Settings → Ren'Py skin → Characters)"
        : tagLines,
    declaredOnly.length > 0 && roster.length > 0
      ? `- Declared in the scripts but with no matching sprite in the scan:\n${declaredOnly}`
      : "",
    ``,
    `### Available backgrounds`,
    backgroundLines.length === 0 ? "  - (this game declares no backgrounds)" : backgroundLines,
    ``,
    `### Directing rules`,
    `- At most ${Number(current?.maxStageSprites) || 3} sprites on stage at once; hide before you add.`,
    `- Put the current speaker at \`center\`, or \`left\`/\`right\` when two characters talk; keep non-speakers at \`alpha\` 0.6.`,
    `- Change emotion with a new attribute on the same tag (\`show eileen sad\`), never by hiding and re-showing.`,
    `- Change location with \`scene <bg> with fade\`, not with a second background.`,
    `- Emit stage commands in blocks at scene or beat changes — not one call per sentence.`,
    safeLines.length > 0
      ? `- **Reserved layout area** the user placed: sprites must not cover it.\n${safeLines}`
      : `- The user may reserve screen space for the name box and side image; never place a sprite across the bottom dialogue band.`,
    ``,
    `### Your own dialogue`,
    `Only **your** lines get a name box and typewriter animation; the user's messages render instantly as plain text and their \`{...}\` text is escaped.`,
    `You may therefore pace your own dialogue with Ren'Py text tags: \`{w=0.5}\` or \`{p}\` to pause, \`{cps=20}\` to slow down, \`{fast}\` to show the rest at once, \`{color=...}\` / \`{size=...}\` to emphasise.`,
    `Use at most two or three tags per message, and never as a per-character effect. Note that \`{w}\` and \`{p}\` here are **timed pauses**, not "wait for a click" as in the engine.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The agent-preset id of the shipped roleplay preset (`preset-renpy-scene`). */
export const ROLEPLAY_PRESET = "renpy-scene";

/**
 * The roleplay brief: the part of the context that is about THIS conversation
 * being a scene rather than a coding session.
 *
 * Injected only into sessions created with the roleplay preset, because it
 * names the user and carries their private notes — a coding session has no
 * business seeing either. The stage dialect itself is NOT repeated here: that
 * lives in the stage-director section, which is registered for every session,
 * and a second copy would be the one that goes stale.
 *
 * Written in Chinese because the preset's persona is Chinese: the model is
 * speaking the user's language for the whole scene, and mixing a Chinese
 * persona with an English brief makes the register wobble.
 *
 * @param manifest the built manifest (used for the cast order and names).
 * @param options.settings the current settings.
 * @param options.memories the memory store, as `readMemories` returns it.
 * @param options.playerName the name already resolved for this session.
 * @returns the section text; empty when there is nothing worth saying.
 */
export function roleplayBrief(manifest, { settings: current, memories, playerName } = {}) {
  const name = typeof playerName === "string" ? playerName.trim() : "";
  const extra = typeof current?.roleplayPrompt === "string" ? current.roleplayPrompt.trim() : "";
  const heads = memoryHeads(memories ?? {}, (manifest?.tags ?? []).map((entry) => entry.tag));
  const displayName = new Map();
  for (const entry of manifest?.tags ?? []) displayName.set(entry.tag, entry.tag);
  for (const info of Object.values(manifest?.characters ?? {})) {
    if (typeof info?.image === "string" && info.image.length > 0 && typeof info?.name === "string") {
      displayName.set(info.image, info.name);
    }
  }
  const memoryLines = heads.entries.map((entry) => {
    const who = displayName.get(entry.tag) ?? entry.tag;
    const label = who === entry.tag ? entry.tag : `${entry.tag}（${who}）`;
    return `- **${label}**：\n${entry.text
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")}${entry.truncated ? "\n  …（只显示了最近的部分，完整内容用 `renpy_memory` 读）" : ""}`;
  });
  return [
    `## 角色扮演：你在这场戏里的人`,
    ``,
    name.length > 0
      ? `用户是到场的人，名字是「${name}」；戏里的角色这样称呼他。`
      : `用户是到场的人，但还没有设定名字：不要替他编一个，需要称呼时用「你」。`,
    extra.length > 0 ? `\n用户为本场演出附加的要求（优先遵守）：\n${extra}` : "",
    ``,
    `### 你记得的事（跨会话）`,
    memoryLines.length === 0
      ? `（还没有记下任何事。）`
      : `这些是之前的场次里记下的、值得延续的事实，当作已经发生过的事，而不是猜测：\n${memoryLines.join("\n")}`,
    heads.omitted > 0 ? `（还有 ${heads.omitted} 个角色有记忆，未全部列出；用 \`renpy_memory\` 读。）` : "",
    ``,
    `想到值得以后还记得的事（约定、关系变化、重要事件），用 \`renpy_memory\` 追加到对应角色名下；记不清细节时用它读完整记忆。记忆按角色分开存放，只写这个角色视角里成立的东西。`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The values the scan itself read, in the shape `renpy_save_vn`'s `config`
 * accepts.
 *
 * Bounded on purpose, the same way `directorBrief` caps its lists: the caller
 * is a model that will correct these values and copy them back, so it needs the
 * numbers, not thousands of asset URLs. Anything absent here is either
 * irrelevant to the profile (sprite paths, media URLs, raw `stats`) or is read
 * only: `sources`, `scripts` and `spriteTags` describe the scan, they are not
 * overlay sections, and the overlay's reply names them as ignored if they are
 * sent back.
 *
 * The list used to be a partial one, and the fields it left out were the ones
 * that actually move the interface: the textbox image's opaque bounds are
 * computed here from the PNG's alpha channel, so a model could never reproduce
 * them by hand, and a profile written from the old digest silently dropped the
 * whole box back onto the conventional defaults.
 *
 * @param manifest the built manifest.
 * @returns a plain object whose keys mirror the profile's sections.
 */
export function manifestDigest(manifest) {
  const game = manifest.game ?? {};
  const dialogbox = manifest.dialogbox ?? {};
  const layout = manifest.layout ?? {};
  const choice = manifest.choice ?? {};
  const pick = (source, keys) => {
    const out = {};
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null) out[key] = value;
    }
    return out;
  };
  return {
    game: {
      name: game.name ?? "",
      version: game.version ?? null,
      screen: { w: game.screen?.w ?? null, h: game.screen?.h ?? null },
    },
    dialogbox: pick(dialogbox, [
      "height",
      "yalign",
      "opacity",
      "fill",
      "textColor",
      "textSize",
      "font",
      "fontPath",
      "fontUrl",
      "nameColor",
      "nameSize",
      "nameboxImage",
      "nameboxBounds",
      "textboxImage",
      "textboxSource",
      "textboxImageAlign",
      "textboxImageBounds",
      "textboxImageBox",
      // The say box's extra pieces. `imageUrl` is left out: it is derived from
      // `image` on every build, and the digest is what gets written back.
      "modules",
    ]),
    // The dialogue plates this game ships, best first. A top-level list rather
    // than a `dialogbox` key because it is READ-ONLY: the plate is chosen by
    // writing one of these paths into `dialogbox.textboxImage`, and a profile
    // that carried the list itself would have nothing to read it.
    plates: (dialogbox.candidates ?? []).map((entry) => ({
      path: entry.path,
      source: entry.source,
      ...(entry.path === dialogbox.textboxPath ? { selected: true } : {}),
    })),
    // Quick-menu buttons the scan found but this client cannot drive (`History`,
    // `Rollback`, `Auto`). Read-only for the same reason as `plates`: the model
    // needs to know they exist without believing they are drawn.
    quickMenu: dialogbox.quickMenu ?? [],
    layout: pick(layout, [
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
    choice: pick(choice, [
      "width",
      "height",
      "borders",
      "textIdleColor",
      "textHoverColor",
      "textSize",
      "idleBackground",
      "hoverBackground",
    ]),
    // Derived by the skin from the game's accent colour, not read from it: the
    // model may replace any of these tokens, and each one needs light AND dark.
    theme: manifest.theme ?? {},
    // Where each of the values above came from. This is the difference between
    // "the game says 278" and "nothing said anything, so 278 is our default" —
    // indistinguishable in the numbers alone, and the second one is the usual
    // reason a skin looks wrong.
    sources: manifest.sources ?? {},
    // Whether the scripts were readable at all, and if not, why. Without it a
    // manifest full of defaults looks exactly like a game that has no styling.
    scripts: manifest.scripts ?? null,
    stats: manifest.stats ?? {},
    // The cast the scripts declare (`Character(...)`), which is not the same
    // list as `spriteTags`: a game can declare a speaker whose art is filed
    // under an unrelated directory. Keyed by the variable the game uses.
    characters: Object.entries(manifest.characters ?? {})
      .slice(0, 60)
      .map(([variable, info]) => ({
        variable,
        name: info?.name ?? null,
        color: info?.color ?? null,
        image: info?.image ?? null,
        ...(info?.spriteTagUnresolved === true ? { spriteTagUnresolved: true } : {}),
      })),
    spriteTags: (manifest.tags ?? []).slice(0, 60).map((entry) => ({
      tag: entry.tag,
      attributes: entry.expressions.map((expression) => expression.label).slice(0, 8),
      total: entry.total ?? entry.expressions.length,
    })),
    backgrounds: (manifest.backgrounds ?? []).slice(0, 40).map((entry) => entry.name),
    transforms: Object.keys(manifest.transforms ?? {}).slice(0, 30),
    profile: {
      applied: manifest.profileApplied ?? [],
      rejected: manifest.profileRejected ?? null,
      // A `sprites.<tag>` patch that matched no record: the section applied, so
      // without this the digest reads as "fixed" while the stage never saw it.
      unmatched: manifest.profileUnmatched ?? [],
    },
  };
}

/**
 * The head of one of the profile's own notes (`summary.md`, `tree.md`), for the
 * interface to show. Bounded because this is meant to be a glance rather than
 * the file itself; a missing or unreadable note is `null`, exactly the way a
 * missing `vn.json` is.
 *
 * @param path the note's absolute path.
 * @param limit how many characters to keep.
 * @returns the text, or `null` when there is none to read.
 */
function readNoteHead(path, limit = 4000) {
  try {
    const text = readFileSync(path, "utf8");
    return text.length <= limit ? text : `${text.slice(0, limit)}\n…`;
  } catch {
    return null;
  }
}

/**
 * The full length of a note, so the interface can say it truncated rather than
 * show a head that appears to end mid-sentence.
 *
 * @param path the note's absolute path.
 * @returns `{chars, truncated}` or `null` when there is no note.
 */
function noteSize(path) {
  try {
    const chars = readFileSync(path, "utf8").length;
    return { chars, truncated: chars > 4000 };
  } catch {
    return null;
  }
}
