/**
 * Two listings of one game, for the agent that has to load it.
 *
 * A Ren'Py game can hold 20 000 files. Pasting that into a prompt is worse than
 * useless — it costs the whole context window and still does not say where the
 * dialogue box lives. So the scan produces two files with different jobs:
 *
 *   - `scan-tree.md` — a compact map, capped at 400 lines / 12 KB. It names the
 *     scripts, the config, the fonts and the dialogue-box art, then aggregates
 *     images and audio by directory with counts. Enough to answer "does this
 *     game use a custom textbox" without opening a single file.
 *   - `scan-tree.full.txt` — every path, so a later question about one file can
 *     be answered by reading it back instead of re-walking the disk.
 *
 * Both skip the directories Ren'Py never stores displayables in, and a `.rpa` is
 * summarised by its top-level directories rather than expanded: an archive is
 * one line of the game, not thousands.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { resolveGameDir } from "./manifest.js";
import { AUDIO_EXTENSIONS, FONT_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, listFiles } from "./renpy.js";
import { isRpa, openRpa } from "./rpa3.js";

/** Line budget for the compact map; see the module comment. */
export const COMPACT_LINE_LIMIT = 400;

/** Byte budget for the compact map, so a single long path cannot blow it up. */
export const COMPACT_BYTE_LIMIT = 12 * 1024;

/** Entry budget for the full listing, matching the manifest's own walk cap. */
export const FULL_ENTRY_LIMIT = 20000;

/** Directories a Ren'Py game keeps no displayables in. */
const SKIPPED_DIRECTORIES = new Set(["cache", "saves", "tl", "__pycache__", ".git", "renpy"]);

/** Script and config files worth naming on their own line. */
const SCRIPT_EXTENSIONS = new Set([".rpy", ".rpyc", ".rpym"]);

/**
 * Which bucket a path belongs to, using the same vocabulary as `stats`.
 *
 * Shared by the loose-file walk and the archive summary so the two counts can be
 * added together: a game whose scripts are all compiled inside `scripts.rpa`
 * looks like a game with no scripts until the archive is counted too.
 */
function kindOf(path) {
  const extension = extname(path).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension)) return "scripts";
  if (IMAGE_EXTENSIONS.has(extension)) return "images";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "videos";
  if (FONT_EXTENSIONS.has(extension)) return "fonts";
  return "other";
}

/** How many individual paths a grouped section lists before it stops. */
const GROUP_SAMPLE = 12;

/** Render a byte count for a human reading the map. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The directory part of a game-relative path, or "." for a top-level file. */
function directoryOf(relativePath) {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "." : relativePath.slice(0, slash);
}

/** The first path segment, which is how a `.rpa` is summarised. */
function topLevelOf(relativePath) {
  const slash = relativePath.indexOf("/");
  return slash < 0 ? "." : relativePath.slice(0, slash);
}

/** Group relative paths by directory, most crowded first. */
function groupByDirectory(paths) {
  const groups = new Map();
  for (const path of paths) {
    const directory = directoryOf(path);
    groups.set(directory, (groups.get(directory) ?? 0) + 1);
  }
  return [...groups.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([directory, count]) => ({ directory, count }));
}

/** Size of one file, or 0 when it cannot be measured. */
function sizeOf(path) {
  try {
    const info = statSync(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Assemble blocks of lines under a line and byte budget.
 *
 * The blocks arrive in priority order, so the caller only has to put the
 * information an agent needs first. When the next block does not fit, as much of
 * it as possible is kept and a note points at the full listing — a truncated map
 * that says it was truncated is honest; one that silently ends is not.
 *
 * @param blocks `{ lines }` entries, highest priority first.
 * @param lineLimit cap on rendered lines.
 * @param byteLimit cap on UTF-8 bytes.
 * @param fullName the file to point at when clipping.
 * @returns the rendered text, always ending in a newline.
 */
export function renderUnderBudget(blocks, lineLimit, byteLimit, fullName) {
  const note = `… (compact tree clipped at ${lineLimit} lines / ${Math.round(byteLimit / 1024)} KB; the complete listing is in ${fullName})`;
  // Reserve the note up front: appending it after the budget is spent would
  // push the file past the limit it advertises.
  const reserve = Buffer.byteLength(note, "utf8") + 1;
  const out = [];
  let bytes = 0;

  const fits = (candidate, candidateBytes) =>
    candidate.length <= lineLimit && candidateBytes + reserve <= byteLimit;

  for (const block of blocks) {
    const candidate = [...out, ...block.lines];
    const candidateBytes = bytes + block.lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);
    if (fits(candidate, candidateBytes)) {
      out.push(...block.lines);
      bytes = candidateBytes;
      continue;
    }
    // Keep what fits of this block, then stop: the blocks after it are less
    // important, and a half-listed lower-priority section helps nobody.
    for (const line of block.lines) {
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      const probe = [...out, line];
      if (!fits(probe, bytes + lineBytes)) break;
      out.push(line);
      bytes += lineBytes;
    }
    out.push(note);
    return `${out.join("\n")}\n`;
  }
  return `${out.join("\n")}\n`;
}

/**
 * Summarise one `.rpa` archive by its top-level directories.
 *
 * Expanding an archive into the tree would make `images.rpa` alone thousands of
 * lines, and the agent only needs to know which directories exist — a path
 * inside the archive is still addressable, because the asset route resolves it.
 *
 * @param relativePath the archive as a game-relative path.
 * @param absolutePath where the archive sits on disk.
 * @returns `{ relativePath, entries, groups, error? }`.
 */
function summariseArchive(relativePath, absolutePath) {
  try {
    const archive = openRpa(absolutePath);
    const groups = new Map();
    const kinds = { images: 0, audio: 0, videos: 0, fonts: 0, scripts: 0, other: 0 };
    for (const name of archive.names) {
      const top = topLevelOf(name);
      groups.set(top, (groups.get(top) ?? 0) + 1);
      kinds[kindOf(name)] += 1;
    }
    return {
      relativePath,
      entries: archive.names.length,
      kinds,
      groups: [...groups.entries()]
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .map(([directory, count]) => ({ directory, count })),
    };
  } catch (error) {
    // A corrupt or unsupported archive is reported, not fatal: the rest of the
    // game is still worth scanning.
    return {
      relativePath,
      entries: 0,
      kinds: { images: 0, audio: 0, videos: 0, fonts: 0, scripts: 0, other: 0 },
      groups: [],
      error: String(error?.message ?? error),
    };
  }
}

/**
 * Scan one game into a compact map and a complete listing.
 *
 * @param root the path the user configured — the game directory, or the Ren'Py
 *   root containing it.
 * @param options.signal cooperative cancellation.
 * @param options.manifest an already-built manifest, used only to label the
 *   fonts, the dialogue box and the cast. Omitted, those sections fall back to
 *   the paths the walk found.
 * @param options.now the timestamp to stamp; injected so a test can be exact.
 * @returns `{ root, gameDir, name, compact, full, stats }`.
 */
export function scanGameTree(root, { signal, manifest, now = new Date() } = {}) {
  const resolved = resolveGameDir(root);
  const gameDir = resolved.gameDir;

  const report = { truncated: false };
  const files = listFiles(gameDir, { signal, limit: FULL_ENTRY_LIMIT, report });
  const relative = files.map((file) => file.slice(gameDir.length + 1).replace(/\\/g, "/"));

  const images = [];
  const audio = [];
  const videos = [];
  const fonts = [];
  const scripts = [];
  const archives = [];
  const others = [];

  for (const path of relative) {
    const extension = extname(path).toLowerCase();
    if (extension === ".rpa") archives.push(path);
    else if (IMAGE_EXTENSIONS.has(extension)) images.push(path);
    else if (AUDIO_EXTENSIONS.has(extension)) audio.push(path);
    else if (VIDEO_EXTENSIONS.has(extension)) videos.push(path);
    else if (FONT_EXTENSIONS.has(extension)) fonts.push(path);
    else if (SCRIPT_EXTENSIONS.has(extension)) scripts.push(path);
    else others.push(path);
  }

  const archiveSummaries = archives
    .sort((a, b) => a.localeCompare(b))
    .map((path) => summariseArchive(path, join(gameDir, path)));

  const name = manifest?.game?.name ?? basename(resolved.root);

  // Entries inside archives, tallied by kind. Kept separate from the loose-file
  // counts because "0 scripts" and "0 loose scripts, 29 compiled inside an
  // archive" lead an agent to opposite conclusions about the same game.
  const archiveEntries = { images: 0, audio: 0, videos: 0, fonts: 0, scripts: 0, other: 0, total: 0 };
  const unreadableArchives = [];
  for (const archive of archiveSummaries) {
    if (archive.error !== undefined) {
      unreadableArchives.push({ path: archive.relativePath, error: archive.error });
      continue;
    }
    for (const kind of Object.keys(archiveEntries)) {
      if (kind === "total") continue;
      archiveEntries[kind] += archive.kinds?.[kind] ?? 0;
    }
    archiveEntries.total += archive.entries;
  }

  const stats = {
    /** Files the walk saw. */
    files: relative.length,
    images: images.length,
    audio: audio.length,
    videos: videos.length,
    fonts: fonts.length,
    scripts: scripts.length,
    archives: archives.length,
    /** Entries inside those archives, so the totals above can be read as loose-only. */
    archiveEntries,
    /** Archives that could not be opened; their contents are simply not counted. */
    unreadableArchives,
    /** True when `FULL_ENTRY_LIMIT` cut the walk short. */
    truncated: report.truncated === true,
    limit: FULL_ENTRY_LIMIT,
  };

  // ── the compact map ──────────────────────────────────────────────────────
  // Priority order, top to bottom: where the game is, what drives it, what it
  // looks like, then where the volume sits.
  const blocks = [];

  blocks.push({
    lines: [
      `# ${name}`,
      ``,
      `- root: ${resolved.root}`,
      `- game/: ${gameDir}`,
      `- scanned: ${now.toISOString()}`,
      `- files: ${stats.files}${stats.truncated ? ` (walk stopped at ${FULL_ENTRY_LIMIT}; more exist)` : ""}` +
        ` — images ${images.length}, audio ${audio.length}, videos ${videos.length}, fonts ${fonts.length},` +
        ` scripts ${scripts.length}`,
      ...(archives.length > 0
        ? [
            `- archives: ${archives.length} (${archiveEntries.total} entries — images ${archiveEntries.images},` +
              ` audio ${archiveEntries.audio}, movies ${archiveEntries.videos}, scripts ${archiveEntries.scripts})`,
          ]
        : []),
      ...(unreadableArchives.length > 0
        ? [`- unreadable archives: ${unreadableArchives.map((entry) => entry.path).join(", ")} (their contents are not counted)`]
        : []),
      ``,
    ],
  });

  // The top level of `game/` itself: the shape a reader needs before any path.
  // Counts come from the walk (so they are what the scan actually saw) and the
  // names come from the directory (so an empty folder still appears). Only
  // directories are listed: a game has hundreds of top-level files, and naming
  // them here would spend the whole budget on the least interesting entry.
  const topLevel = new Map();
  let rootFiles = 0;
  for (const path of relative) {
    const slash = path.indexOf("/");
    if (slash < 0) {
      rootFiles += 1;
      continue;
    }
    const top = path.slice(0, slash);
    topLevel.set(top, (topLevel.get(top) ?? 0) + 1);
  }
  try {
    for (const entry of readdirSync(gameDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (!topLevel.has(entry.name)) topLevel.set(entry.name, 0);
    }
  } catch {
    // The walk above already produced a usable top level; this only adds empty
    // directories, so a listing failure is not worth reporting.
  }
  const topLines = [...topLevel.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 40)
    .map(([entry, count]) => `  - ${entry}/: ${count === 0 ? "empty" : `${count} file${count === 1 ? "" : "s"}`}`);
  if (rootFiles > 0) topLines.push(`  - (game/ itself): ${rootFiles} file${rootFiles === 1 ? "" : "s"}`);
  blocks.push({ lines: [`## game/ directories`, ...(topLines.length > 0 ? topLines : ["  - (empty)"]), ``] });

  // Archives come before scripts on purpose: when a game ships every script
  // compiled inside `scripts.rpa`, a scripts section printed first reads as "this
  // game has no scripts" and the agent stops looking. The archive counts directly
  // above the script count are what stop that misreading.
  const archiveLines = [];
  for (const archive of archiveSummaries) {
    if (archive.error !== undefined) {
      archiveLines.push(`  - ${archive.relativePath} — unreadable: ${archive.error}`);
      continue;
    }
    const groups = archive.groups
      .slice(0, 12)
      .map((group) => `${group.directory === "." ? "(top level)" : `${group.directory}/`} ${group.count}`)
      .join(", ");
    const kinds = Object.entries(archive.kinds ?? {})
      .filter(([kind, count]) => kind !== "other" && count > 0)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(", ");
    archiveLines.push(
      `  - ${archive.relativePath} — ${archive.entries} entries` +
        (kinds.length > 0 ? ` (${kinds})` : "") +
        (groups.length > 0 ? ` — ${groups}` : ""),
    );
  }
  blocks.push({
    lines: [
      `## archives (${archives.length})`,
      ...(archiveLines.length > 0 ? archiveLines : ["  - (none; every asset is a loose file)"]),
      ``,
    ],
  });

  // Scripts and config: the files that decide how the game looks.
  const archivedScripts = archiveEntries.scripts;
  const scriptLines = scripts
    .slice()
    .sort((a, b) => {
      const depth = a.split("/").length - b.split("/").length;
      return depth !== 0 ? depth : a.localeCompare(b);
    })
    .slice(0, 60)
    .map((path) => `  - ${path} (${formatBytes(sizeOf(join(gameDir, path)))})`);
  // One string per branch: an extra array here lands a nested array in `lines`,
  // and `Buffer.byteLength()` then throws while measuring the block — which is
  // exactly the archive-only case (every script inside `scripts.rpa`), so the
  // whole scan fails for the games this wording exists for.
  const scriptsEmpty = scripts.length === 0
    ? [archivedScripts > 0
        ? `  - (no loose scripts; ${archivedScripts} compiled scripts live inside the archives above)`
        // Saying "this game has no scripts" would be an assertion the walk cannot
        // support — compiled scripts could be unreadable rather than absent.
        : "  - (no loose scripts found; the archives above hold none either — the game may store them elsewhere)"]
    : [];
  blocks.push({
    lines: [`## scripts and config (${scripts.length} loose)`, ...(scriptLines.length > 0 ? scriptLines : scriptsEmpty), ``],
  });

  // Fonts and the dialogue box: what the skin reads to reproduce the game's look.
  const fontList = (manifest?.fonts ?? []).length > 0
    ? manifest.fonts.slice(0, 12).map((font) => `  - ${font.path ?? font}`)
    : fonts.slice(0, 12).map((path) => `  - ${path}`);
  const dialogbox = manifest?.dialogbox;
  const dialogLines = [];
  if (dialogbox !== undefined) {
    if (typeof dialogbox.textboxImage === "string") dialogLines.push(`  - textbox image: ${dialogbox.textboxImage}`);
    if (typeof dialogbox.textColor === "string") dialogLines.push(`  - text colour: ${dialogbox.textColor}`);
    if (typeof dialogbox.font === "string") dialogLines.push(`  - font: ${dialogbox.font}`);
    if (Number.isFinite(dialogbox.height)) dialogLines.push(`  - height: ${dialogbox.height}`);
  }
  blocks.push({
    lines: [
      `## fonts (${fonts.length})`,
      ...(fontList.length > 0 ? fontList : ["  - (none found; the game uses the engine default)"]),
      ``,
      `## dialogue box`,
      ...(dialogLines.length > 0
        ? dialogLines
        : ["  - (not resolved by the manifest; read gui.rpy for gui.textbox_height and gui.text_color)"]),
      ``,
    ],
  });

  // Images by directory: an agent needs to know that `images/bg/` holds 40
  // backgrounds without being handed all 40 names.
  const imageGroups = groupByDirectory(images);
  blocks.push({
    lines: [
      `## images (${images.length}) by directory`,
      ...(imageGroups.length > 0
        ? imageGroups.slice(0, 60).map((group) => `  - ${group.directory}/ — ${group.count}`)
        : ["  - (none)"]),
      ...(imageGroups.length > 60 ? [`  - … ${imageGroups.length - 60} more directories`] : []),
      ``,
    ],
  });

  // Backgrounds and characters, taken from the manifest when there is one: the
  // manifest has already resolved names, so the sample is useful rather than
  // just the first twelve alphabetically.
  const backgroundNames = (manifest?.backgrounds ?? []).map((entry) => entry.name);
  const backgroundLines = backgroundNames.length > 0
    ? backgroundNames.slice(0, GROUP_SAMPLE).map((entry) => `  - ${entry}`)
    : images.filter((path) => /(^|\/)(bg|background|backgrounds)\b/i.test(path)).slice(0, GROUP_SAMPLE).map((path) => `  - ${path}`);
  blocks.push({
    lines: [
      `## backgrounds (${backgroundNames.length > 0 ? backgroundNames.length : "from filenames; not resolved by a manifest"})`,
      ...(backgroundLines.length > 0 ? backgroundLines : ["  - (none declared; check images/)"]),
      ...(backgroundNames.length > GROUP_SAMPLE ? [`  - … ${backgroundNames.length - GROUP_SAMPLE} more`] : []),
      ``,
    ],
  });

  const tags = manifest?.tags ?? [];
  const tagLines = tags.slice(0, 20).map((tag) => {
    const expressions = (tag.expressions ?? []).map((expression) => expression.label).slice(0, 6);
    return `  - ${tag.tag}: ${expressions.length > 0 ? expressions.join(", ") : "(no attributes)"}`;
  });
  // "declares no characters" would be a claim about the game; an empty list only
  // says the scan found none, and a game whose sprites are named something the
  // reader does not recognise lands here too.
  const noCharacters = manifest?.scripts?.reason !== undefined
    ? [`  - (none recognised; ${manifest.scripts.reason})`]
    : ["  - (none recognised — the scan found no character sprites it could name)"];
  blocks.push({
    lines: [
      `## characters (${tags.length} sprite tags)`,
      ...(tagLines.length > 0 ? tagLines : noCharacters),
      ...(tags.length > 20 ? [`  - … ${tags.length - 20} more`] : []),
      ``,
    ],
  });

  const audioGroups = groupByDirectory(audio);
  blocks.push({
    lines: [
      `## audio (${audio.length}) by directory`,
      ...(audioGroups.length > 0
        ? audioGroups.slice(0, 40).map((group) => `  - ${group.directory}/ — ${group.count}`)
        : ["  - (none)"]),
      ``,
    ],
  });

  if (videos.length > 0) {
    blocks.push({
      lines: [
        `## videos (${videos.length})`,
        ...videos.slice(0, GROUP_SAMPLE).map((path) => `  - ${path}`),
        ``,
      ],
    });
  }

  const compact = renderUnderBudget(blocks, COMPACT_LINE_LIMIT, COMPACT_BYTE_LIMIT, "scan-tree.full.txt");

  // ── the full listing ─────────────────────────────────────────────────────
  const fullLines = [
    `# full tree — ${name}`,
    `# root: ${resolved.root}`,
    `# game/: ${gameDir}`,
    `# scanned: ${now.toISOString()}`,
    `# ${stats.files} files${stats.truncated ? `, truncated at ${FULL_ENTRY_LIMIT}` : ""}`,
    "",
  ];
  for (const path of relative.slice().sort((a, b) => a.localeCompare(b))) fullLines.push(path);
  for (const archive of archiveSummaries) {
    if (archive.error !== undefined) {
      fullLines.push(`[rpa] ${archive.relativePath} — unreadable: ${archive.error}`);
      continue;
    }
    const groups = archive.groups
      .map((group) => `${group.directory === "." ? "(top level)" : `${group.directory}/`} ${group.count}`)
      .join(", ");
    fullLines.push(`[rpa] ${archive.relativePath} — ${archive.entries} entries${groups.length > 0 ? `: ${groups}` : ""}`);
  }
  if (stats.truncated) {
    fullLines.push(`[truncated] the walk stopped at ${FULL_ENTRY_LIMIT} files; the game holds more`);
  }
  const full = `${fullLines.join("\n")}\n`;

  stats.compactLines = compact.split("\n").length - 1;
  stats.compactBytes = Buffer.byteLength(compact, "utf8");
  stats.fullLines = fullLines.length;
  stats.fullBytes = Buffer.byteLength(full, "utf8");

  return { root: resolved.root, gameDir, name, compact, full, stats };
}
