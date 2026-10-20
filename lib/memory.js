/**
 * dsh-renpy-skin — roleplay memory.
 *
 * One JSON file per game, keyed by character tag: the things a roleplay session
 * decided are worth keeping between conversations (a promise, a change in how
 * two people treat each other, an event that happened at a particular time).
 *
 * Storage is deliberately NOT one Markdown file per character. Character tags
 * come from the game's own scripts and may contain anything a Ren'Py tag can
 * contain, so a file name would need a lossy sanitising step — and the mapping
 * from tag back to the file would then be guesswork. A single `memory.json`
 * keyed by the tag as written keeps the round trip exact and makes listing,
 * reading and rewriting one operation each.
 *
 * Nothing here ever throws: a missing, corrupt or read-only file must degrade
 * to "no memory yet", because memory is an addition to the roleplay preset and
 * must never be the reason a game cannot be loaded.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Longest memory kept per character. Older lines are dropped from the head. */
export const MEMORY_LIMIT = 8000;

/** How much of one character's memory the roleplay prompt carries. */
export const MEMORY_HEAD = 1200;

/** How many characters' memories the roleplay prompt carries at most. */
export const MEMORY_HEAD_COUNT = 12;

/** Where the memory file of one game lives. */
export function memoryPath(home, profileName) {
  return join(home, "game", profileName, "memory.json");
}

/**
 * Read every character's memory for one game.
 *
 * @param home the plugin's data directory.
 * @param profileName the profile folder (the SCANNED game name).
 * @returns a plain object of tag to text; anything unusable reads as `{}`.
 */
export function readMemories(home, profileName) {
  try {
    const raw = JSON.parse(readFileSync(memoryPath(home, profileName), "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    const memories = {};
    for (const [tag, text] of Object.entries(raw)) {
      if (typeof text === "string" && text.trim().length > 0) memories[tag] = text;
    }
    return memories;
  } catch {
    return {};
  }
}

/**
 * Write the whole memory file.
 *
 * @returns `true` when the file was written, `false` when the directory or file
 *   could not be written (a read-only home must not break anything).
 */
export function writeMemories(home, profileName, memories) {
  const path = memoryPath(home, profileName);
  const clean = {};
  for (const [tag, text] of Object.entries(memories ?? {})) {
    if (typeof text === "string" && text.trim().length > 0) clean[tag] = text;
  }
  try {
    if (Object.keys(clean).length === 0) {
      // An empty store is a deletion, not an empty file: a leftover `{}` reads
      // the same, but removing it keeps the data directory honest about what
      // the user has actually recorded.
      rmSync(path, { force: true });
      return true;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(clean, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the newest `limit` characters of one memory, cutting at a line boundary.
 *
 * The tail is kept rather than the head because memory is written in the order
 * things happened: what a character did last is what the next session needs,
 * and the older lines are the ones a summary would have replaced anyway.
 *
 * @returns `{ text, trimmed }` where `trimmed` counts the dropped characters.
 */
export function clampMemory(text, limit = MEMORY_LIMIT) {
  const value = String(text ?? "");
  if (value.length <= limit) return { text: value, trimmed: 0 };
  const slice = value.slice(value.length - limit);
  const newline = slice.indexOf("\n");
  const kept = newline >= 0 && newline < slice.length - 1 ? slice.slice(newline + 1) : slice;
  return { text: kept, trimmed: value.length - kept.length };
}

/**
 * Add one entry to a character's memory.
 *
 * @param entry the line to append; a blank entry is refused so an accidental
 *   empty call cannot silently no-op.
 * @returns `{ ok, chars, trimmed }` or `{ ok: false, error }`.
 */
export function appendMemory(home, profileName, tag, entry) {
  const line = String(entry ?? "").trim();
  if (line.length === 0) return { ok: false, error: "the memory entry is empty" };
  const memories = readMemories(home, profileName);
  const existing = memories[tag] ?? "";
  const joined = existing.length === 0 ? line : `${existing}\n${line}`;
  const clamped = clampMemory(joined);
  memories[tag] = clamped.text;
  if (!writeMemories(home, profileName, memories)) {
    return { ok: false, error: "the memory file could not be written" };
  }
  return { ok: true, chars: clamped.text.length, trimmed: clamped.trimmed };
}

/**
 * Replace one character's memory wholesale.
 *
 * @returns `{ ok, chars, trimmed }` or `{ ok: false, error }`.
 */
export function replaceMemory(home, profileName, tag, text) {
  const memories = readMemories(home, profileName);
  const clamped = clampMemory(String(text ?? "").trim());
  if (clamped.text.length === 0) delete memories[tag];
  else memories[tag] = clamped.text;
  if (!writeMemories(home, profileName, memories)) {
    return { ok: false, error: "the memory file could not be written" };
  }
  return { ok: true, chars: clamped.text.length, trimmed: clamped.trimmed };
}

/**
 * The memories worth putting in front of the model, bounded twice: per
 * character (the newest {@link MEMORY_HEAD} characters) and in total.
 *
 * @param memories the store, as read by {@link readMemories}.
 * @param order the tags the manifest knows, so the injection follows the game's
 *   own cast order instead of whatever order the file happens to have.
 * @returns `{ entries: [{tag, text, truncated}], omitted }`.
 */
export function memoryHeads(memories, order = []) {
  const tags = [];
  for (const tag of order) {
    if (typeof tag === "string" && memories[tag] !== undefined && !tags.includes(tag)) tags.push(tag);
  }
  for (const tag of Object.keys(memories)) {
    if (!tags.includes(tag)) tags.push(tag);
  }
  const entries = [];
  let omitted = 0;
  for (const tag of tags) {
    if (entries.length >= MEMORY_HEAD_COUNT) {
      omitted += 1;
      continue;
    }
    const full = memories[tag];
    const truncated = full.length > MEMORY_HEAD;
    entries.push({
      tag,
      text: truncated ? `…\n${full.slice(full.length - MEMORY_HEAD)}` : full,
      truncated,
    });
  }
  return { entries, omitted };
}
