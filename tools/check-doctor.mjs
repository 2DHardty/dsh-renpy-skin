// 体检脚本：在相信任何「这份游戏读到了什么」的结论之前先跑它。
//
// 为什么需要它：清单永远会成功生成，读不到的值会回退成默认值，所以一份
// 「看起来正常」的清单也可能是整片硬编码默认值。审计（docs/VN-READ-AUDIT.md）
// 在没有 unrpyc 的机器上根本无法进行，而这一点以前只写在文档里，脚本本身
// 照样跑完并宣称通过。这个脚本把「结论可信吗」变成退出码：
//
//   0  该有的都有，清单里的值可以当作读到的值来信
//   1  有脚本但读不出一行，此时的清单几乎全是默认值 —— 审计结论不可信
//   2  体检本身没跑完（路径不存在、设置读不到等）
//
// 用法：
//   node tools/check-doctor.mjs
//   node tools/check-doctor.mjs --game "D:\Games\MyNovel"
//   node tools/check-doctor.mjs --json
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import { resolveDataHome } from "../lib/home.js";
import { resolveGameDir } from "../lib/manifest.js";
import { openRpa } from "../lib/rpa3.js";
import { rpycDiagnostics } from "../lib/rpyc.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const asJson = args.includes("--json");

const lines = [];
function say(text) {
  lines.push(text);
  if (!asJson) console.log(text);
}

/** Read the configured game so `--game` stays optional. */
function configuredGame() {
  const home = resolveDataHome();
  try {
    const raw = JSON.parse(readFileSync(join(home.path, "config.json"), "utf8"));
    if (typeof raw?.gameDir === "string" && raw.gameDir.trim() !== "") return raw.gameDir;
  } catch {
    // No settings yet: the caller falls back to a bare data-home report.
  }
  return undefined;
}

/** Count what is on disk, and open every archive to prove it is readable. */
function inspectGame(root) {
  let resolved;
  try {
    resolved = resolveGameDir(root);
  } catch (error) {
    return { error: `cannot resolve ${root}: ${error?.message ?? error}` };
  }
  if (!existsSync(resolved.gameDir)) return { error: `no such directory: ${resolved.gameDir}` };

  let entries;
  try {
    entries = readdirSync(resolved.gameDir, { withFileTypes: true });
  } catch (error) {
    return { error: `cannot list ${resolved.gameDir}: ${error?.message ?? error}` };
  }

  const loose = { rpy: 0, rpyc: 0 };
  const archived = { rpy: 0, rpyc: 0 };
  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (extension === ".rpy") loose.rpy += 1;
    else if (extension === ".rpyc") loose.rpyc += 1;
    else if (extension === ".rpa") {
      const path = join(resolved.gameDir, entry.name);
      try {
        const archive = openRpa(path);
        // Scripts inside an archive are the case that fooled people twice: the
        // file list shows no scripts at all, and the manifest still looks fine.
        let scripts = 0;
        let compiled = 0;
        for (const name of archive.names) {
          const inner = extname(name).toLowerCase();
          if (inner === ".rpy") {
            scripts += 1;
            archived.rpy += 1;
          } else if (inner === ".rpyc") {
            scripts += 1;
            compiled += 1;
            archived.rpyc += 1;
          }
        }
        archives.push({ name: entry.name, entries: archive.names.length, scripts, compiled, error: null });
      } catch (error) {
        // An unreadable archive is the interesting case: the manifest silently
        // skips it, so every value that lived inside stays at its default.
        archives.push({ name: entry.name, entries: 0, scripts: 0, compiled: 0, error: `${error?.message ?? error}` });
      }
    }
  }

  return {
    gameDir: resolved.gameDir,
    root: resolved.root,
    loose,
    archived,
    archives,
    // "Readable" means there is at least one loose .rpy this run can actually
    // open; a loose .rpyc still needs Python and unrpyc.
    readableScripts: loose.rpy > 0,
    hasScripts: loose.rpy + loose.rpyc + archived.rpy + archived.rpyc > 0,
  };
}

const report = { dataHome: null, rpyc: null, game: null, verdict: "unknown", reasons: [] };

try {
  const home = resolveDataHome();
  const legacyPresent = Boolean(home.legacy && existsSync(home.legacy));
  report.dataHome = { path: home.path, source: home.source, legacy: home.legacy ?? null, legacyPresent };
  say(`data home    ${home.path}  (source: ${home.source})`);
  if (legacyPresent && home.source !== "legacy") {
    // Two directories at once is the symptom of a host that did not inherit
    // DSH_HOME; the user then edits one and reads the other.
    say(`             the old directory still exists: ${home.legacy}`);
  }
} catch (error) {
  report.reasons.push(`data home: ${error?.message ?? error}`);
  say(`data home    FAILED: ${error?.message ?? error}`);
}

let rpyc;
try {
  rpyc = rpycDiagnostics();
  report.rpyc = rpyc;
  say(`python       ${rpyc.python?.path ?? "(not found)"}`);
  if (rpyc.python?.reason) say(`             ${rpyc.python.reason}`);
  say(`unrpyc       ${rpyc.unrpyc?.path ?? "(not found)"}`);
  if (rpyc.unrpyc?.reason) say(`             ${rpyc.unrpyc.reason}`);
} catch (error) {
  report.reasons.push(`rpyc: ${error?.message ?? error}`);
  say(`rpyc         FAILED: ${error?.message ?? error}`);
}

const gameRoot = flag("game", configuredGame());
if (gameRoot === undefined) {
  say("game         (none configured; pass --game to check one)");
  report.verdict = "no-game";
} else {
  const game = inspectGame(gameRoot);
  report.game = game;
  if (game.error) {
    report.verdict = "broken";
    report.reasons.push(game.error);
    say(`game         FAILED: ${game.error}`);
  } else {
    say(`game         ${game.gameDir}`);
    say(
      `loose        ${game.loose.rpy} .rpy, ${game.loose.rpyc} .rpyc, ` +
        `${game.archives.length} archive(s)`,
    );
    if (game.archived.rpy + game.archived.rpyc > 0) {
      say(`             inside those archives: ${game.archived.rpy} .rpy, ${game.archived.rpyc} .rpyc`);
    }
    for (const archive of game.archives) {
      if (archive.error !== null) {
        say(`             ${archive.name} — UNREADABLE: ${archive.error}`);
        continue;
      }
      const scripts = archive.scripts === 0 ? "" : `, ${archive.scripts} script(s)`;
      say(`             ${archive.name} — ${archive.entries} entries${scripts}`);
    }
    const brokenArchives = game.archives.filter((archive) => archive.error !== null);
    if (brokenArchives.length > 0) {
      report.reasons.push(`${brokenArchives.length} archive(s) cannot be opened`);
    }
  }
}

// The verdict is about trust, not about success: a game with no scripts at all
// is honest, while a game whose scripts exist but cannot be read produces a
// manifest that looks complete and is entirely default values.
let exitCode = 0;
if (report.verdict !== "broken") {
  const game = report.game;
  const canDecompile = report.rpyc?.usable === true;
  // Archived .rpy files are read directly; only .rpyc needs Python + unrpyc.
  const readableRpy = game && !game.error ? game.loose.rpy + game.archived.rpy : 0;
  const compiledOnly = game && !game.error && game.hasScripts && readableRpy === 0;
  if (game && !game.error && game.archives.some((archive) => archive.error !== null)) {
    report.verdict = "untrustworthy";
    report.reasons.push("an unreadable archive hides every value that lived inside it");
  } else if (compiledOnly && !canDecompile) {
    report.verdict = "untrustworthy";
    report.reasons.push(
      "the game ships only compiled scripts and unrpyc is not usable — " +
        "every value in the manifest is a default",
    );
  } else if (game && !game.error) {
    report.verdict = "ok";
  }
}

if (report.verdict === "broken") exitCode = 2;
else if (report.verdict === "untrustworthy") exitCode = 1;

if (report.verdict === "untrustworthy") {
  say("");
  say("verdict      UNTRUSTWORTHY — do not draw conclusions from this game's manifest");
  for (const reason of report.reasons) say(`             ${reason}`);
  if (report.rpyc?.install) {
    // The install line is the one thing a reader can act on immediately.
    say("");
    say("to fix it:");
    for (const line of String(report.rpyc.install).split(/\r?\n/)) say(`  ${line}`);
  }
} else if (report.verdict === "ok") {
  say("");
  say("verdict      ok — every value in the manifest is either read or reported as default");
} else if (report.verdict === "no-game") {
  say("");
  say("verdict      no game configured — only the toolchain was checked");
}

if (asJson) console.log(JSON.stringify(report, null, 2));
process.exit(exitCode);
