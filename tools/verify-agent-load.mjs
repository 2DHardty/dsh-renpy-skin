// 实机验收脚本：P0.6「Agent 加载链路」的宿主端一半。
//
// 它只打插件自己的 HTTP 路由（这些路由不鉴权），所以不需要 CDP，也不需要
// Shell 的登录 token：目的就是证明**正在运行的宿主**已经加载了新构建的
// `lib/index.js`——旧宿主对 `POST /renpy-skin/agent/prepare` 回 405，新宿主
// 会真的扫一遍游戏并写两棵目录树。
//
// 用法（重启 DSH 之后）：
//   node tools/verify-agent-load.mjs
//   node tools/verify-agent-load.mjs --port 19387 --out .tmp/agent-load-verify.json
//
// 任何一项失败都以非零码退出，并把报告写成 JSON。
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};

const base = `http://127.0.0.1:${flag("port", "19387")}`;
const outFile = flag("out", "agent-load-verify.json");
const waitMs = Number(flag("wait", "120000"));

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

// 重启期间 19387 会短暂不可用，先等它回来再判定，避免把「正在重启」误报成失败。
async function waitForHost() {
  const deadline = Date.now() + waitMs;
  let last = "还没试过";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/renpy-skin/settings`);
      if (response.ok) return true;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  record("宿主应答 /renpy-skin/settings", false, last);
  return false;
}

function sizeOf(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

async function main() {
  if (!(await waitForHost())) return;

  const answer = await (await fetch(`${base}/renpy-skin/settings`)).json();
  record("宿主应答 /renpy-skin/settings", true, base);
  const gameDir = typeof answer?.settings?.gameDir === "string" ? answer.settings.gameDir : "";
  record("设置里已经选过一个游戏", gameDir !== "", gameDir);

  const response = await fetch(`${base}/renpy-skin/agent/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "verify-probe" }),
  });
  const prepared = await response.json().catch(() => undefined);
  record(
    "POST /renpy-skin/agent/prepare 由新构建提供（旧宿主只有 405）",
    response.status === 200 && prepared?.ok === true,
    `HTTP ${response.status} ${prepared?.error === undefined ? "" : String(prepared.error).slice(0, 200)}`,
  );
  if (prepared?.ok !== true) return;

  record("返回的 gameDir 是解析后的 game/ 目录", /[\\/]game$/.test(prepared.gameDir ?? ""), prepared.gameDir);
  record("返回了游戏名", typeof prepared.name === "string" && prepared.name !== "", prepared.name);

  const compact = prepared.paths?.compactTree ?? "";
  const full = prepared.paths?.fullTree ?? "";
  record("紧凑目录树已写入", existsSync(compact), `${compact} (${sizeOf(compact)} 字节)`);
  record("完整目录树已写入", existsSync(full), `${full} (${sizeOf(full)} 字节)`);

  const stats = prepared.stats ?? {};
  record(
    "紧凑树在预算内（≤400 行 / ≤12 KB）",
    (stats.compactLines ?? 0) <= 400 && (stats.compactBytes ?? 0) <= 12 * 1024,
    `${stats.compactLines} 行 / ${stats.compactBytes} 字节`,
  );
  record(
    "完整树不超过 20000 条",
    (stats.fullLines ?? 0) <= 20000,
    `${stats.fullLines} 行${stats.truncated === true ? "（已截断）" : ""}`,
  );
  record(
    "扫描确认这是一个 Ren'Py 游戏",
    (stats.scripts ?? 0) + (stats.archives ?? 0) > 0,
    `${stats.scripts ?? 0} 个脚本，${stats.archives ?? 0} 个归档`,
  );

  const report = {
    checkedAt: new Date().toISOString(),
    base,
    gameDir,
    prepared,
    checks,
    passed: checks.every((check) => check.ok),
  };
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n${report.passed ? "全部通过" : "有检查失败"} —— 报告写在 ${join(process.cwd(), outFile)}`);
  if (!report.passed) process.exitCode = 1;
}

await main();
