/**
 * `.rpyc` decompilation, delegated to the external `unrpyc` tool.
 *
 * Ren'Py compiles every script to a `.rpyc` next to its `.rpy` (and, for a
 * packaged release, ships only the `.rpyc` inside `archive.rpa`). The manifest
 * otherwise falls back to a default GUI because `gui.rpy`/`options.rpy` never
 * survive in bytecode-only games. This module turns a `.rpyc` byte blob back
 * into the `.rpy` source text the rest of the manifest already knows how to
 * parse, using the same Python tool the community uses.
 *
 * The whole contract is synchronous (one-shot manifest build) and must degrade
 * to `null` rather than ever throw, so a machine without Python or unrpyc
 * simply skips bytecode instead of breaking asset discovery.
 *
 * Degrading is not the same as staying silent: `rpycDiagnostics()` reports
 * where the tool was looked for and what would make it usable, because a
 * user whose decompilation silently did nothing cannot tell a game without
 * `gui.rpy` from a machine without unrpyc.
 *
 * Environment knobs (all optional):
 *   - `DSH_RENPY_PYTHON`  — force a specific Python interpreter (path or name).
 *   - `DSH_RENPY_UNRPYC`  — force a specific `unrpyc.py` path.
 *   - `DSH_RENPY_TOOLS`   — directory to scan for `unrpyc*` checkouts.
 *   - `DSH_RENPY_RPYC_DEBUG` — any truthy value logs failure reasons to stderr.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * unrpyc's real `.rpyc` v2 magic: the ASCII bytes `RENPY RPC2` (10 bytes).
 * Confirmed in `unrpyc.py` (`raw_contents.startswith(b"RENPY RPC2")`) and in
 * `deobfuscate.py` (`data[:10] != b'RENPY RPC2'`). Do not "fix" this to a
 * guessed number — it is the literal string, not a `0x...` word.
 */
const RPYC2_MAGIC = Buffer.from("RENPY RPC2", "latin1");

/**
 * Legacy `.rpyc` v1 (Ren'Py 6 era and earlier) has no header at all: the entire
 * file is one zlib-compressed pickle, so it begins with a zlib frame. unrpyc's
 * `read_ast_from_file` treats any file that does NOT start with `RENPY RPC2` as
 * v1, so mirror that here. This is deliberately permissive — a false positive
 * only costs one failed `decompileRpyc` (which returns `null`), never a crash.
 */
const LEGACY_ZLIB_FIRST_BYTE = 0x78;

/** unrpyc needs Python 3.9+; a broken/slow interpreter should not hang forever. */
const VERSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * Decompiling a single file is one worker, but `unrpyc` can still spin up its
 * multiprocessing pool before realising it has only one file, and very large
 * compiled scripts (hundreds of KB) take a while. Generous but bounded.
 */
const DECOMPILE_TIMEOUT_MS = 120_000;

/** unrpyc failure output can be a long traceback; keep it captured, not clipped. */
const STDERR_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Directory an unpacked unrpyc release is looked for in, relative to the user's
 * home.
 *
 * A fixed absolute path cannot be the default here: this plugin is published
 * and installed on other people's machines, so a drive letter that exists on
 * one of them turns "unrpyc is not installed" into a lookup that was never
 * going to succeed. `DSH_RENPY_TOOLS` overrides the directory, and
 * `DSH_RENPY_UNRPYC` overrides the file itself.
 */
const UNRPYC_HOME_DIR = "Tools";

/**
 * Files per unrpyc process. unrpyc isolates a bad file in its own worker, but a
 * single process over hundreds of files means one timeout loses all of them;
 * chunks bound both the damage and the wait.
 */
const BATCH_SIZE = 32;

/**
 * Wall-clock ceiling for one decompile batch call across all chunks. The
 * per-chunk timeout is clipped to what remains of this budget.
 */
const BATCH_BUDGET_MS = 300_000;

/** unrpyc log lines that say why a file failed; surfaced only in debug mode. */
const FAILURE_LINE = /Error while decompiling|failed to decompile|^\w+(Error|Exception): /;

/**
 * Candidate interpreter names tried on PATH, in order.
 *
 * `py` comes last on purpose: it is the Windows launcher, which reports a
 * version even when no interpreter is installed behind it, so it can only be
 * trusted after the direct names have failed.
 */
const PYTHON_CANDIDATES = ["python", "python3", "py"];

/**
 * Plugin root, i.e. the directory that holds `lib/` and `test/`.
 *
 * Derived from this module's own URL rather than from the working directory:
 * the host imports the plugin by absolute path from an arbitrary cwd, and the
 * vendored unrpyc checkout has to be found in the installed copy either way.
 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Tool locations chosen on the plugin's settings page, plus the source tags a
 * lookup reports.
 *
 * The settings page is the one place a user can point the plugin at the unrpyc
 * they just unpacked without needing to know that `DSH_RENPY_UNRPYC` exists, so
 * a value typed there has to outrank the environment variable — an environment
 * variable that silently won would make the field look broken. All three are
 * blank on a fresh install, which keeps discovery (and every existing behavior)
 * unchanged.
 */
let configuredTools = { python: "", unrpyc: "", toolsDir: "" };

/** Trim a setting to either a usable path or the empty "not configured" state. */
function toolPathSetting(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Take the tool locations from the settings page.
 *
 * `lib/index.js` calls this after reading settings and after every settings
 * write, so a path typed in the UI takes effect on the next manifest build
 * rather than on the next host restart. Fields left out of `patch` keep their
 * current value; a blank field means "fall back to the environment, then to
 * discovery".
 *
 * @param {{ python?: string, unrpyc?: string, toolsDir?: string }} [patch]
 * @returns {{ python: string, unrpyc: string, toolsDir: string }} the values now in force
 */
export function configureTools(patch = {}) {
  if (patch.python !== undefined) configuredTools.python = toolPathSetting(patch.python);
  if (patch.unrpyc !== undefined) configuredTools.unrpyc = toolPathSetting(patch.unrpyc);
  if (patch.toolsDir !== undefined) configuredTools.toolsDir = toolPathSetting(patch.toolsDir);
  // A cached diagnosis describes the configuration that produced it, and a
  // stale "not found" is exactly the answer this module exists to avoid.
  invalidateDiagnostics();
  return { ...configuredTools };
}

/** The tool locations currently in force (a copy, so callers cannot mutate them). */
export function configuredToolPaths() {
  return { ...configuredTools };
}

/**
 * The installed plugin directory, as an absolute path.
 *
 * The settings page names it so a user can drop `unrpyc.py` into
 * `<pluginRoot>/vendor/unrpyc/` without having to discover which folder the host
 * loaded this module from — the vendored copy is one of the lookups, and there
 * is no other place that fact becomes visible.
 */
export function pluginRoot() {
  return PLUGIN_ROOT;
}

function debug(...parts) {
  if (process.env.DSH_RENPY_RPYC_DEBUG) {
    process.stderr.write(`[rpyc] ${parts.join(" ")}\n`);
  }
}

/**
 * Whether `command` (a name or an absolute path) launches a Python that answers
 * `--version` with exit 0.
 *
 * A WindowsApps `python.exe` stub with no real install behind it exits non-zero,
 * so it is correctly treated as "not found" — but a store-installed CPython
 * resolves to that same path and does run, which is why the check is behavioural
 * rather than path-based.
 *
 * Both output streams are discarded: the answer is the exit status, and asking
 * for pipes here is what a sandboxed host refuses, which would make every
 * interpreter look absent.
 */
function isWorkingPython(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: VERSION_CHECK_TIMEOUT_MS,
  });
  if (result.error !== undefined) return false;
  return result.status === 0;
}

/**
 * Resolve a command name to its absolute path via `where.exe` (Windows) or
 * `which` (POSIX). Returns `null` when the resolver is unavailable; callers
 * fall back to the bare name, which `spawnSync` then resolves via PATH.
 */
function resolveExecutable(command) {
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(resolver, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ?? null;
}

/**
 * Whether `path` is an existing regular file. Used instead of `statSync` in a
 * try/catch at each call site so a candidate that cannot be read stays a plain
 * `false` instead of an exception nobody expects.
 */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether `path` is an existing directory, with the same never-throw rule. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The `python.exe` (or `python3`) shipped inside a DSH runtime, one path per
 * runtime directory under `$DSH_HOME/dsh-runtimes`.
 *
 * Without a system Python this is the interpreter a DSH user already has, so it
 * is a real candidate rather than a courtesy. It is not guessed when
 * `DSH_HOME` is unset: inventing `~/.dsh` would make the diagnosis claim to
 * have looked somewhere it never did.
 */
function dshHomePythonCandidates() {
  const home = process.env.DSH_HOME;
  if (typeof home !== "string" || home.trim().length === 0) return [];
  const runtimesDir = join(home.trim(), "dsh-runtimes");
  let names;
  try {
    names = readdirSync(runtimesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const exe = process.platform === "win32" ? "python.exe" : "python3";
  return names.map((name) => join(runtimesDir, name, "dependencies", "python", exe));
}

/**
 * Every interpreter location to try, in priority order, each tagged with where
 * it came from: the settings page first, then `DSH_RENPY_PYTHON`, then the
 * heuristics. The DSH runtime comes before PATH so a host that ships its own
 * Python does not depend on the machine's PATH being arranged for it.
 *
 * The source tag is what makes a diagnosis actionable — "no Python anywhere"
 * and "the path you typed does not run" need different fixes.
 */
function pythonEntries() {
  const entries = [];
  if (configuredTools.python !== "") {
    entries.push({ path: configuredTools.python, source: "setting" });
  }
  const override = toolPathSetting(process.env.DSH_RENPY_PYTHON);
  if (override !== "") entries.push({ path: override, source: "environment" });
  for (const candidate of dshHomePythonCandidates()) {
    entries.push({ path: candidate, source: "dsh-runtime" });
  }
  for (const name of PYTHON_CANDIDATES) entries.push({ path: name, source: "path" });
  return entries;
}

/** The interpreter paths a lookup will try, in order (names, for the report). */
function pythonCandidates() {
  return pythonEntries().map((entry) => entry.path);
}

/**
 * Locate a working Python interpreter, or `null`.
 *
 * A location the user chose — on the settings page or through the environment —
 * wins outright; when it is set but does not run, this returns `null` rather
 * than silently falling back to a system interpreter, because an explicit
 * choice that is broken should surface instead of being papered over. Otherwise
 * the candidates are tried in order.
 *
 * @returns an absolute path when resolvable, else a bare command name, else
 *   `null`.
 */
export function findPython() {
  const entries = pythonEntries();
  const explicit = entries.find(
    (entry) => entry.source === "setting" || entry.source === "environment",
  );
  if (explicit !== undefined) {
    if (!isWorkingPython(explicit.path)) {
      debug(`${explicit.source} python ${JSON.stringify(explicit.path)} does not run`);
      return null;
    }
    return isAbsolute(explicit.path)
      ? explicit.path
      : (resolveExecutable(explicit.path) ?? explicit.path);
  }
  for (const entry of entries) {
    if (isWorkingPython(entry.path)) {
      // An absolute candidate is already a location; resolving it would only
      // add a dependency on `where.exe`/`which` being allowed to run.
      return isAbsolute(entry.path)
        ? entry.path
        : (resolveExecutable(entry.path) ?? entry.path);
    }
  }
  return null;
}

/**
 * Locate `unrpyc.py`, or `null`.
 *
 * The result is made absolute so a later spawn does not depend on the working
 * directory. Only existence is checked: `unrpyc.py` imports its sibling
 * `decompiler/` package and `deobfuscate.py`, but running it via
 * `python <absolute-path>` puts its own directory on `sys.path`, so those
 * siblings resolve regardless of the caller's cwd.
 *
 * @returns absolute path to `unrpyc.py`, or `null`.
 */
export function findUnrpyc() {
  const entries = unrpycEntries();
  for (const entry of entries) {
    const absolute = resolve(entry.path);
    if (isFile(absolute)) return absolute;
  }
  // Reuse the list just walked instead of rebuilding it: the candidates depend on
  // the filesystem, and asking twice makes the logged list disagree with the
  // list that was actually tried.
  debug(`unrpyc.py not found; tried ${entries.map((entry) => entry.path).join(", ")}`);
  return null;
}

/**
 * Where the plugin keeps its own copy of unrpyc, for users who would rather drop
 * one file into the plugin than configure an environment variable.
 */
function vendoredUnrpycPath() {
  return join(PLUGIN_ROOT, "vendor", "unrpyc", "unrpyc.py");
}

/**
 * One `unrpyc.py` candidate, accepting the checkout folder as well as the file.
 *
 * The install instructions hand the user a folder (`...\unrpyc-2.0.4`), so
 * pasting that folder into the "unrpyc" field is the expected move rather than
 * a typo. A folder is expanded to the `unrpyc.py` inside it; `folder` is kept so
 * a miss can say "the folder you named has no unrpyc.py in it" instead of
 * listing a path the user never typed.
 */
function unrpycEntry(path, source) {
  const absolute = resolve(path);
  if (isDirectory(absolute)) {
    return { path: join(absolute, "unrpyc.py"), source, folder: absolute };
  }
  return { path, source };
}

/**
 * Ordered places to look for `unrpyc.py`, each tagged with its origin: the
 * settings page, the env override, the plugin's own vendor directory, the known
 * install (any other `unrpyc*` checkout beside it, newest name first, so a newer
 * unpacked release is picked up without configuration), then PATH.
 *
 * Every candidate is computed even when a directory cannot be read. An earlier
 * version let a `readdirSync` failure swallow the whole `~/Tools` branch, which
 * made the debug line read "tried unrpyc.py" on machines where the one useful
 * fact — that `~/Tools` was looked at and does not exist — had just been
 * discovered and thrown away.
 */
function unrpycEntries() {
  const entries = [];
  if (configuredTools.unrpyc !== "") {
    entries.push(unrpycEntry(configuredTools.unrpyc, "setting"));
  }
  const override = toolPathSetting(process.env.DSH_RENPY_UNRPYC);
  if (override !== "") entries.push(unrpycEntry(override, "environment"));
  entries.push({ path: vendoredUnrpycPath(), source: "vendor" });
  const toolsDir = unrpycToolsDir();
  if (toolsDir !== undefined) {
    let siblingNames = [];
    try {
      siblingNames = readdirSync(toolsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^unrpyc/i.test(entry.name))
        .map((entry) => entry.name)
        // Numeric-aware, so `unrpyc-2.0.10` outranks `unrpyc-2.0.4`. The newest
        // wins because Ren'Py bytecode moves on: 2.0.2 cannot read 8.5 files.
        .sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
    } catch {
      // The directory is absent, which is the normal case: nobody who never
      // decompiles a script has a reason to have one. The two paths below still
      // describe where a checkout is supposed to go.
    }
    for (const name of siblingNames) {
      entries.push({ path: join(toolsDir, name, "unrpyc.py"), source: "tools" });
    }
    // A checkout unpacked flat, or renamed to something that does not start
    // with `unrpyc`, still works if it sits directly in that directory.
    entries.push({ path: join(toolsDir, "unrpyc.py"), source: "tools" });
  }
  // Last: a copy dropped next to whatever the process's working directory is,
  // or a launcher on PATH that resolves the bare name.
  entries.push({ path: "unrpyc.py", source: "path" });
  return entries;
}

/** The unrpyc paths a lookup will try, in order (names, for the report). */
function unrpycCandidates() {
  return unrpycEntries().map((entry) => entry.path);
}

/**
 * The directory to scan for an unrpyc checkout, with where that directory came
 * from, or `undefined` when there is no home directory to anchor one to.
 *
 * Resolution order: the settings page, `DSH_RENPY_TOOLS`, then `~/Tools`. A
 * blank/whitespace-only value counts as "not configured", so clearing the field
 * restores the default instead of looking for a directory named "".
 */
function toolsDirEntry() {
  if (configuredTools.toolsDir !== "") {
    return { path: configuredTools.toolsDir, source: "setting" };
  }
  const override = toolPathSetting(process.env.DSH_RENPY_TOOLS);
  if (override !== "") return { path: override, source: "environment" };
  try {
    const home = homedir();
    if (typeof home === "string" && home.length > 0) {
      return { path: join(home, UNRPYC_HOME_DIR), source: "home" };
    }
  } catch {
    // No home directory: the caller reports that instead of guessing one.
  }
  return undefined;
}

/**
 * Where to look for an unrpyc checkout, or undefined when there is no home
 * directory to anchor it to.
 *
 * Exported so the test suite can find unrpyc's own test fixtures without
 * repeating this machine's drive letter: the fixtures live in the checkout the
 * same lookup already resolved.
 */
export function unrpycToolsDir() {
  return toolsDirEntry()?.path;
}

/**
 * The copy-pasteable instructions for making decompilation work, or `null` when
 * it already does.
 *
 * unrpyc is not on PyPI — `pip install unrpyc` fails with "no matching
 * distribution", and the v2.0.4 GitHub release ships only the in-engine
 * self-extractors, not `unrpyc.py`. Telling a user to `pip install` it would
 * therefore send them down a road that does not exist, so the exact working
 * source (a source zip from codeload) is spelled out instead.
 */
function installInstructions() {
  return [
    "本机无法反编译 .rpyc，脚本里的字体、主题色、选项宽度、立绘 tag 都会回落到默认值。",
    "unrpyc 不在 PyPI 上（`pip install unrpyc` 会报 no matching distribution），",
    "v2.0.4 的 release 资产里也没有 unrpyc.py，必须下载源码 zip。需要 Python 3.9 或更高版本。",
    "",
    "PowerShell:",
    "  $dst = \"$env:USERPROFILE\\Tools\\unrpyc-2.0.4\"",
    "  New-Item -ItemType Directory -Force $dst | Out-Null",
    "  curl.exe -L -o \"$env:TEMP\\unrpyc.zip\" https://codeload.github.com/CensoredUsername/unrpyc/zip/refs/tags/v2.0.4",
    "  Expand-Archive -Force \"$env:TEMP\\unrpyc.zip\" $env:TEMP",
    "  Copy-Item \"$env:TEMP\\unrpyc-2.0.4\\*\" $dst -Recurse -Force",
    "",
    "或者只指定工具位置（不下载）：设置 DSH_RENPY_UNRPYC=<unrpyc.py 的完整路径>，",
    `或把 unrpyc.py 放到 ${join(PLUGIN_ROOT, "vendor", "unrpyc", "unrpyc.py")}`,
  ].join("\n");
}

/** One line naming where unrpyc was looked for and why the lookup failed. */
function describeUnrpycMiss(tried, toolsDir, notes = []) {
  let toolsNote;
  if (toolsDir === undefined) {
    toolsNote = "no home directory to anchor a Tools folder to";
  } else if (isFile(toolsDir)) {
    toolsNote = `${toolsDir} is a file, not a directory`;
  } else {
    let exists = false;
    try {
      exists = statSync(toolsDir).isDirectory();
    } catch {
      exists = false;
    }
    toolsNote = exists
      ? `${toolsDir} has no unrpyc checkout in it`
      : `${toolsDir} does not exist`;
  }
  const extra = notes.length > 0 ? ` — ${notes.join("; ")}` : "";
  return `unrpyc not found: looked in ${tried.join(", ")} (${toolsNote})${extra}`;
}

/**
 * Everything known about the decompilation chain, in a shape a caller can print
 * or return to a model.
 *
 * Never throws: this is the diagnosis for a feature whose whole contract is
 * "degrade instead of failing", and a diagnosis that can throw would take down
 * the manifest it is meant to explain. Results are cached for the process
 * because probing spawns Python and reads directories, and a manifest build asks
 * more than once; pass `{ refresh: true }` to re-probe after changing the
 * environment (tests rely on this).
 *
 * @param {{ refresh?: boolean }} [options]
 * @returns {{
 *   python: { path: string | null, source: string | null, checked: string[], reason: string | null },
 *   unrpyc: {
 *     path: string | null, source: string | null, tried: string[], toolsDir: string,
 *     toolsDirSource: string | null, reason: string | null,
 *   },
 *   reason: string | null,
 *   usable: boolean,
 *   install: string | null,
 * }}
 */
export function rpycDiagnostics(options = {}) {
  if (options.refresh === true) diagnosticsCache = null;
  if (diagnosticsCache !== null) return diagnosticsCache;
  try {
    diagnosticsCache = computeDiagnostics();
  } catch (error) {
    // Only reachable if a Node builtin itself throws (a nonexistent home
    // directory, an unreadable tmpdir); still report rather than propagate.
    diagnosticsCache = {
      python: {
        path: null,
        source: null,
        checked: pythonCandidates(),
        reason: `the python probe itself failed: ${String(error?.message ?? error)}`,
      },
      unrpyc: {
        path: null,
        source: null,
        tried: unrpycCandidates(),
        toolsDir: unrpycToolsDir() ?? "",
        toolsDirSource: null,
        reason: `the unrpyc probe itself failed: ${String(error?.message ?? error)}`,
      },
      reason: `the rpyc diagnosis itself failed: ${String(error?.message ?? error)}`,
      usable: false,
      install: installInstructions(),
    };
  }
  return diagnosticsCache;
}

/** In-process memo for `rpycDiagnostics()`; `null` means "probe again". */
let diagnosticsCache = null;

/** Drop the memo so the next `rpycDiagnostics()` call probes again. */
function invalidateDiagnostics() {
  diagnosticsCache = null;
}

function computeDiagnostics() {
  const entries = pythonEntries();
  const checked = entries.map((entry) => entry.path);
  // A location the user chose — settings page or environment variable — is
  // reported as wrong instead of being retried as a heuristic: the user set it,
  // so the user needs to know it does not work. The source tag says which of
  // the two places to go and fix.
  const explicitPython = entries.find(
    (entry) => entry.source === "setting" || entry.source === "environment",
  );
  let pythonPath = null;
  let pythonSource = null;
  let pythonReason = null;
  if (explicitPython !== undefined) {
    if (isWorkingPython(explicitPython.path)) {
      pythonPath = isAbsolute(explicitPython.path)
        ? explicitPython.path
        : (resolveExecutable(explicitPython.path) ?? explicitPython.path);
      pythonSource = explicitPython.source;
    } else {
      pythonReason = explicitPython.source === "setting"
        ? `the Python from the settings page (${explicitPython.path}) does not run (no fallback while it is set)`
        : `DSH_RENPY_PYTHON=${explicitPython.path} does not run (no fallback while it is set)`;
    }
  } else {
    for (const entry of entries) {
      if (isWorkingPython(entry.path)) {
        pythonPath = isAbsolute(entry.path)
          ? entry.path
          : (resolveExecutable(entry.path) ?? entry.path);
        pythonSource = entry.source;
        break;
      }
    }
    if (pythonPath === null) {
      pythonReason = `no working Python >= 3.9 among ${checked.join(", ")}`;
    }
  }

  const toolsEntry = toolsDirEntry();
  const toolsDir = toolsEntry?.path;
  const unrpycEntriesList = unrpycEntries();
  const tried = unrpycEntriesList.map((entry) => entry.path);
  let unrpycPath = null;
  let unrpycSource = null;
  let unrpycReason = null;
  for (const entry of unrpycEntriesList) {
    const absolute = resolve(entry.path);
    if (isFile(absolute)) {
      unrpycPath = absolute;
      unrpycSource = entry.source;
      break;
    }
  }
  if (unrpycPath === null) {
    // A folder the user pasted into the path field is tolerated above, but the
    // miss still has to explain why a path they can see in Explorer did not
    // match: the folder itself is not the tool.
    const folderNotes = unrpycEntriesList
      .filter((entry) => typeof entry.folder === "string")
      .map((entry) => `the unrpyc path is a folder (${entry.folder}); it has no unrpyc.py inside it`);
    unrpycReason = describeUnrpycMiss(tried, toolsDir, folderNotes);
  }

  let reason = null;
  if (pythonPath === null && unrpycPath === null) {
    reason = `${pythonReason ?? "no Python interpreter found"}; ${unrpycReason ?? "unrpyc not found"}`;
  } else if (pythonPath === null) {
    reason = pythonReason ?? "no Python interpreter found";
  } else if (unrpycPath === null) {
    reason = unrpycReason ?? "unrpyc not found";
  }

  return {
    python: { path: pythonPath, source: pythonSource, checked, reason: pythonReason },
    unrpyc: {
      path: unrpycPath,
      source: unrpycSource,
      tried,
      toolsDir: toolsDir ?? "",
      toolsDirSource: toolsEntry?.source ?? null,
      reason: unrpycReason,
    },
    reason,
    usable: pythonPath !== null && unrpycPath !== null,
    install: reason === null ? null : installInstructions(),
  };
}

/**
 * Whether a byte buffer is a Ren'Py compiled script (`.rpyc`).
 *
 * Accepts a `Buffer`, `Uint8Array`, or `ArrayBuffer`; anything else (including
 * a path string) is `false`. Matches both the v2 `RENPY RPC2` header and the
 * legacy v1 zlib-blob form (see the constants above).
 */
export function isRpyc(buffer) {
  let bytes = buffer;
  if (Buffer.isBuffer(bytes)) {
    // already a buffer
  } else if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) {
    bytes = Buffer.from(bytes);
  } else {
    return false;
  }
  if (bytes.length < RPYC2_MAGIC.length) return false;
  if (bytes.subarray(0, RPYC2_MAGIC.length).equals(RPYC2_MAGIC)) return true;
  return bytes[0] === LEGACY_ZLIB_FIRST_BYTE;
}

/** Normalise the `bufferOrPath` argument into a `Buffer`, or `null`. */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") {
    try {
      return readFileSync(value);
    } catch {
      return null;
    }
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return null;
}

/**
 * Decompile `.rpyc` bytes (or a `.rpyc` file path) into `.rpy` source text.
 *
 * unrpyc is a *file-to-file* tool: it reads the input `.rpyc` and writes a
 * sibling `.rpy` with the same basename, it never streams to stdout. So the
 * bytes are always staged into a private temp directory (`.rpyc` in, `.rpy`
 * out) even when the caller passed a path — that keeps a game's real directory
 * free of generated `.rpy` files and gives one uniform code path.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|string} bufferOrPath
 * @param {{ python?: string|null, unrpyc?: string|null, timeoutMs?: number }} [options]
 *   inject the interpreter / tool paths (or `null` to force a miss) and timeout.
 * @returns the `.rpy` source text, or `null` when Python/unrpyc are missing,
 *   the input is empty, or decompilation fails.
 */
export function decompileRpyc(bufferOrPath, options = {}) {
  try {
    return decompileRpycInner(bufferOrPath, options);
  } catch (error) {
    debug(`unexpected error: ${error?.message ?? error}`);
    return null;
  }
}

/**
 * Where the interpreter and tool come from for one call.
 *
 * `null`/`""` in `options` means "pretend this is missing", which is how the
 * callers (and the tests) exercise the degraded path without touching PATH.
 * An explicit `undefined` means "probe", so the two cases stay distinguishable.
 */
function resolveTooling(options) {
  const python = options?.python !== undefined ? options.python : findPython();
  const unrpyc = options?.unrpyc !== undefined ? options.unrpyc : findUnrpyc();
  return {
    python: typeof python === "string" && python.length > 0 ? python : null,
    unrpyc: typeof unrpyc === "string" && unrpyc.length > 0 ? unrpyc : null,
  };
}

/**
 * Whether the caller explicitly forced a tool to "missing" for this call, as
 * opposed to the machine not having it. The two need different reasons: one is
 * a machine to fix, the other is a caller that has to pass a path.
 */
function wasSuppressed(options, key) {
  return options?.[key] === null || options?.[key] === "";
}

function decompileRpycInner(bufferOrPath, options) {
  const bytes = toBuffer(bufferOrPath);
  if (bytes === null || bytes.length === 0) {
    debug("empty or unreadable input");
    return null;
  }

  const { python, unrpyc } = resolveTooling(options);
  if (!python || !unrpyc) {
    debug(
      `skipping: ${!python ? "python interpreter not found" : "unrpyc.py not found"}`,
    );
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), "dsh-rpyc-"));
  try {
    const inputPath = join(dir, "input.rpyc");
    const outputPath = join(dir, "input.rpy");
    writeFileSync(inputPath, bytes);

    const result = spawnSync(python, [unrpyc, "-c", inputPath], {
      encoding: "utf8",
      // stdout is a progress summary we do not need; stderr carries the reason
      // for any failure, which the debug log surfaces.
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: STDERR_MAX_BUFFER,
      timeout: options.timeoutMs ?? DECOMPILE_TIMEOUT_MS,
      windowsHide: true,
    });

    if (result.error !== undefined) {
      // e.g. ENOENT (interpreter vanished) or ETIMEDOUT.
      debug(`unrpyc spawn failed: ${result.error.message}`);
      return null;
    }
    if (result.status !== 0) {
      const tail = String(result.stderr ?? "").trim();
      debug(`unrpyc exited ${result.status}${tail ? `: ${tail}` : ""}`);
      return null;
    }

    let text;
    try {
      text = readFileSync(outputPath, "utf8");
    } catch {
      debug("unrpyc exited 0 but produced no output file");
      return null;
    }
    if (text.trim().length === 0) return null;
    return text;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a leftover temp dir is harmless; never let cleanup fail the caller
    }
  }
}

/**
 * Decompile many `.rpyc` byte blobs in ONE `unrpyc` invocation, with the reason
 * for any shortfall.
 *
 * `decompileRpyc` spawns a Python process per file (~900 ms each), which is far
 * too slow for a manifest build over dozens of files. unrpyc accepts multiple
 * input files per call, so this stages every blob under one temp tree, runs
 * `python unrpyc.py -c <files...>` once, and reads back each `.rpy` that was
 * produced. A single missing interpreter/tool therefore skips the WHOLE batch
 * instead of paying the spawn cost N times only to get N nulls — and says so
 * through `diagnostics.reason`, which is the only way a caller can tell "this
 * game has no scripts" from "this machine cannot decompile".
 *
 * @param {Array<{ name: string, bytes: Buffer|Uint8Array|ArrayBuffer }>} entries
 *   each entry is an archive-relative name plus its bytes. Names are only used
 *   to build the temp tree; the caller maps results back by its own key.
 * @param {{ python?: string|null, unrpyc?: string|null, timeoutMs?: number }} [options]
 * @returns {{ files: Map<string, string>, diagnostics: {
 *   reason: string | null, attempted: number, decompiled: number, failed: number } }}
 *   `files` holds every entry that produced non-empty output; the counts
 *   describe all `attempted` entries, so `decompiled + failed === attempted`.
 */
export function decompileRpycBatch(entries, options = {}) {
  try {
    return decompileRpycBatchInner(entries, options);
  } catch (error) {
    debug(`unexpected batch error: ${error?.message ?? error}`);
    return {
      files: new Map(),
      diagnostics: {
        reason: `the decompile batch itself failed: ${String(error?.message ?? error)}`,
        attempted: 0,
        decompiled: 0,
        failed: 0,
      },
    };
  }
}

function decompileRpycBatchInner(entries, options) {
  const list = Array.isArray(entries) ? entries : [];
  const usable = [];
  for (const entry of list) {
    const bytes = toBuffer(entry?.bytes);
    if (bytes === null || bytes.length === 0) continue;
    usable.push({ name: entry.name, bytes });
  }
  if (usable.length === 0) {
    // Nothing was handed over, which is not a failure: a game that ships every
    // script as readable `.rpy` legitimately has nothing to decompile.
    return { files: new Map(), diagnostics: emptyBatchDiagnostics(null, 0) };
  }

  const { python, unrpyc } = resolveTooling(options);
  if (!python || !unrpyc) {
    // Name the half that is actually missing first: an injected `python: null`
    // must not be reported as an unrpyc problem, or the caller chases a tool
    // that is already installed. The probe then supplies the directories that
    // were searched, which is what makes the message actionable.
    const probed = rpycDiagnostics();
    const reason = !python
      ? wasSuppressed(options, "python")
        ? "no Python interpreter was supplied for this batch (options.python is null)"
        : probed.python.reason ?? "no working Python interpreter was found"
      : wasSuppressed(options, "unrpyc")
        ? "no unrpyc.py was supplied for this batch (options.unrpyc is null)"
        : probed.unrpyc.reason ?? "unrpyc not found";
    debug(`batch skipping: ${reason}`);
    return { files: new Map(), diagnostics: emptyBatchDiagnostics(reason, usable.length) };
  }

  const out = new Map();
  const deadline = Date.now() + BATCH_BUDGET_MS;
  const perChunkTimeout = options?.timeoutMs ?? DECOMPILE_TIMEOUT_MS;
  let spawnError = null;
  let truncated = 0;
  for (let start = 0; start < usable.length; start += BATCH_SIZE) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      truncated = usable.length - start;
      debug(`batch budget spent; ${truncated} file(s) not decompiled`);
      break;
    }
    const chunk = usable.slice(start, start + BATCH_SIZE);
    const results = runBatchChunk(
      chunk,
      python,
      unrpyc,
      Math.min(perChunkTimeout, remaining),
    );
    for (const [name, text] of results.files) out.set(name, text);
    // Keep the first spawn failure: on a host that denies child processes every
    // chunk fails identically, and the first message is the real one.
    spawnError ??= results.error;
  }

  const attempted = usable.length;
  const decompiled = out.size;
  const failed = attempted - decompiled;
  return {
    files: out,
    diagnostics: {
      // A partial batch is worth reporting too: "40 of 48" is exactly the case
      // where a stale unrpyc silently mangles the newest bytecode. A spawn
      // failure is reported in its own words because it is not the scripts'
      // fault and the scripts will never decompile until it is fixed.
      reason: spawnError ?? (truncated > 0
        ? `the decompile budget ran out before ${truncated} of ${attempted} script(s)`
        : failed === 0
          ? null
          : decompiled === 0
            ? `unrpyc failed to decompile all ${attempted} script(s)`
            : `unrpyc failed to decompile ${failed} of ${attempted} script(s)`),
      attempted,
      decompiled,
      failed,
    },
  };
}

/**
 * The documented batch-diagnostic shape with zero counts. Keeping one builder
 * for it means the shape cannot drift between the "nothing to do" and "nothing
 * could be done" paths that most callers will see.
 */
function emptyBatchDiagnostics(reason, attempted) {
  return { reason, attempted, decompiled: 0, failed: reason === null ? 0 : attempted };
}

/**
 * Decompile many `.rpyc` byte blobs, returning only the source text.
 *
 * Kept as the historical entry point (and the one `lib/manifest.js` used to
 * call): callers that only want the text should not have to unwrap a result
 * object, and `decompileRpycBatch` is the same work with the diagnosis kept.
 *
 * @param {Array<{ name: string, bytes: Buffer|Uint8Array|ArrayBuffer }>} entries
 * @param {{ python?: string|null, unrpyc?: string|null, timeoutMs?: number }} [options]
 * @returns {Map<string, string>} name → decompiled `.rpy` source, for every
 *   entry that produced non-empty output; entries that fail are simply absent.
 */
export function decompileRpycMany(entries, options = {}) {
  return decompileRpycBatch(entries, options).files;
}

/**
 * One unrpyc process over one chunk. Never throws, and it reads back whatever
 * `.rpy` files were written even when the process failed or was killed:
 * unrpyc writes each output as it goes, so a timeout keeps the earlier files.
 *
 * Returns the spawn failure alongside the files. A process that could not start
 * at all (a host that denies child pipes, a vanished interpreter) and a process
 * that ran and rejected the bytecode both leave an empty map, but they are
 * different faults with different fixes — one is the environment, the other is
 * the tool version — so the caller has to be able to tell them apart.
 *
 * @returns {{ files: Map<string, string>, error: string | null }}
 */
function runBatchChunk(chunk, python, unrpyc, timeoutMs) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-rpyc-batch-"));
  try {
    const staged = [];
    for (const entry of chunk) {
      // Names are archive-relative and forward-slashed. Drop every `.`/`..`
      // segment so a hostile name cannot escape the temp tree, and keep the
      // directory layout so unrpyc writes `<name>.rpy` beside `<name>.rpyc`.
      const safeName = entry.name
        .split(/[\\/]+/)
        .filter((part) => part !== "" && part !== "." && part !== "..")
        .join("/");
      const inputPath = join(dir, safeName);
      mkdirSync(dirname(inputPath), { recursive: true });
      writeFileSync(inputPath, entry.bytes);
      staged.push({
        name: entry.name,
        input: inputPath,
        output: inputPath.replace(/\.rpyc$/i, ".rpy"),
      });
    }

    const result = spawnSync(python, [unrpyc, "-c", ...staged.map((s) => s.input)], {
      encoding: "utf8",
      // unrpyc logs progress and tracebacks to stdout, not stderr.
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: STDERR_MAX_BUFFER,
      timeout: timeoutMs,
      windowsHide: true,
    });

    let spawnError = null;
    if (result.error !== undefined) {
      spawnError = `could not run ${python}: ${result.error.message}`;
      debug(`batch spawn failed: ${result.error.message}`);
    } else if (result.status !== 0) {
      // unrpyc exits 0 even when individual files fail, so a non-zero status
      // means the batch itself went wrong — surface the tail, not just the code.
      const tail = String(result.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" ");
      spawnError = `unrpyc exited ${result.status}${tail ? `: ${tail}` : ""}`;
      debug(`batch exited ${result.status}`);
    }
    // unrpyc exits 0 even when a file fails ("1 file failed to decompile"), so
    // the output file is the only reliable success signal. Log the reasons.
    const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    for (const line of log.split(/\r?\n/).filter((l) => FAILURE_LINE.test(l)).slice(0, 10)) {
      debug(`unrpyc: ${line.trim()}`);
    }

    const out = new Map();
    for (const { name, output } of staged) {
      let text;
      try {
        text = readFileSync(output, "utf8");
      } catch {
        continue; // unrpyc skipped or failed this one; leave it absent
      }
      if (text.trim().length !== 0) out.set(name, text);
    }
    return { files: out, error: spawnError };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // leftover temp dir is harmless
    }
  }
}
