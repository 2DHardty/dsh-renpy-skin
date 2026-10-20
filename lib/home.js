/**
 * Where this plugin keeps its data, and how an install moves there.
 *
 * The directory used to be `~/.dsh-renpy-skin`, which puts plugin state in the
 * user's home next to nothing else. DSH already defines a home for exactly this
 * kind of thing: `$DSH_HOME` (the launcher injects it, default `~/.dsh`) holds
 * `profiles/`, `sessions/` and every other plugin's state. So the order is:
 *
 *   1. `DSH_RENPY_SKIN_HOME` — spelled out for this plugin. The test suite
 *      points it at a temp directory, so it always wins.
 *   2. `$DSH_HOME/renpy-skin` — beside `profiles/` and `sessions/`.
 *   3. `~/.dsh-renpy-skin` — the old location, kept so an install with no
 *      `DSH_HOME` still finds its settings where it left them.
 *
 * `DSH_HOME` is blank-treated as unset: a shell that exports an empty string
 * must not resolve to a relative `renpy-skin` folder in the current directory.
 */
import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Directory name under `$DSH_HOME`, matching the plugin's own name. */
export const HARNESS_DIRECTORY = "renpy-skin";

/** The pre-`DSH_HOME` directory name, directly inside the user's home. */
export const LEGACY_DIRECTORY = ".dsh-renpy-skin";

/** What `migrateLegacyHome` copies, and all the plugin ever wrote there. */
const MIGRATED_ENTRIES = ["config.json", "library.json", "game"];

/** A directory from the environment, or "" when unset, blank or not a string. */
function envDirectory(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

/** Compare two directories the way the platform's file system does. */
function sameDirectory(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" || process.platform === "darwin"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Resolve the plugin's data directory and say which rule chose it.
 *
 * Split out from `dataHome()` so the precedence and the migration are provable
 * in tests: the environment and the user's home are arguments, not globals.
 *
 * @param env the environment to read (`process.env` in production).
 * @param home the user's home directory, used for the legacy fallback.
 * @returns `{ path, source, legacy }` — `source` is `"override"`, `"harness"`
 *   or `"legacy"`; `legacy` is the old directory worth migrating from, or ""
 *   when there is nothing to migrate.
 */
export function resolveDataHome(env = process.env, home = homedir()) {
  const override = envDirectory(env?.DSH_RENPY_SKIN_HOME);
  if (override !== "") return { path: override, source: "override", legacy: "" };

  const harness = envDirectory(env?.DSH_HOME);
  const legacy = join(home, LEGACY_DIRECTORY);
  if (harness !== "") return { path: join(harness, HARNESS_DIRECTORY), source: "harness", legacy };

  // No harness home at all: this installation predates `DSH_HOME` wiring, or it
  // runs a build that never set one. There is nowhere to migrate to.
  return { path: legacy, source: "legacy", legacy: "" };
}

/**
 * Copy anything the harness home is missing out of the old directory.
 *
 * This used to bail out the moment the new home had a `config.json`. That file
 * is written on the first settings save, so a user who opened the plugin once
 * (which writes it) and then returned to a machine where the rest of the old
 * directory was still the only copy kept every profile and the whole game
 * library invisible forever — with no message, because there was nothing to
 * report. The copy is now per ENTRY: anything already present in the harness
 * home is left untouched (it may be newer than the old copy), and anything
 * missing is brought over.
 *
 * Copy only, never delete: a half-finished copy must leave the old directory
 * intact so the user can still find their games, and cleaning up is their call.
 *
 * Never throws. A read-only home or a locked file only means the settings stay
 * where they were; loading a game must not fail over it.
 *
 * @param resolved a `resolveDataHome()` result.
 * @returns the entry names that were copied, empty when nothing was migrated.
 */
export function migrateLegacyHome(resolved) {
  const home = resolved?.path;
  const legacy = resolved?.legacy;
  if (typeof home !== "string" || home === "") return [];
  if (typeof legacy !== "string" || legacy === "") return [];
  if (sameDirectory(home, legacy)) return [];

  const copied = [];
  try {
    if (!existsSync(legacy)) return [];
    for (const entry of MIGRATED_ENTRIES) {
      const source = join(legacy, entry);
      if (!existsSync(source)) continue;
      // A destination that exists may be NEWER than the old copy: the whole
      // point of the move is that the user kept using the plugin afterwards.
      if (existsSync(join(home, entry))) continue;
      cpSync(source, join(home, entry), { recursive: true, errorOnExist: false, force: true });
      copied.push(entry);
    }
  } catch {
    // Best effort: whatever did copy is already there, and the next start
    // retries the rest because only the missing entries are selected.
    return copied;
  }
  return copied;
}
