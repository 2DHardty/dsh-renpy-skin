# 接口契约

本插件所依赖的接口，以及它所暴露的接口。平台 API 是用 `cordis_inspect_list` / `cordis_inspect_query` 现场核验的，而不是凭记忆写下的——如果 DSH 自身的源码与本文件不一致，以源码为准，本文件即为过期。

---

## 1. 平台 API 消费（宿主端）

`inject` 保持为 `[]`——没有任何东西是硬依赖，缺少某个服务的配置档仍会加载其余全部内容。但 `systemPrompt`、`tools`、`webServer` 三者都是**可选的硬依赖**，各自由 `ctx.inject([...], (scoped) => ...)` 获取：在 `apply` 运行*之后*才到达的服务会被等待，而不是被一次性的 `ctx.get(...)` 永久错过。某个服务始终不出现时，只有它自己那一半不接线，其余照常工作。

三者必须是 `inject` 而不是 `ctx.get`，因为它们有同一种沉默失败模式：各行使并发挂载，挂载时读一次拿到 `undefined`，注册就被静默跳过——请求里于是少掉 4 个工具或整段系统提示词，而日志里没有任何错误。依赖某个名字却读不到时，`ctx.get` 本身也会抛错，这正是它必须被 `inject` 取代的原因。

### `tools.register(definition)`

```ts
interface ToolDefinition extends ToolSchema {
  output: ToolOutputDefinition;
  execute(args, exec): Promise<unknown>;
}
interface ToolSchema {
  deferLoading?: boolean;
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema
}
interface ToolOutputDefinition {
  schema: JsonSchemaNode;
  render(args, value): ContentBlock[];
  presentationMeta?(args, value): JsonValue;
}
```

返回一个销毁器（disposer）。`lib/index.js:719` 注册了 `renpy_stage`。

### `systemPrompt.section(section)`

```ts
interface PromptSection {
  name: string;
  order: number;
  text: string | ((ctx: AssembleContext) => string);
  interpolate?: boolean;
  complete?: boolean;
}
interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal }
```

`lib/index.js:682` 注册了 `renpy-skin:stage-director`。它的 `order` 是 `systemPrompt.getSectionOrder("PLAN_POLICY") + 100`，当 `getSectionOrder` 缺失时硬回退为 `500 + 100`。必须设置 `interpolate: false`——该简介文本在 Ren'Py 示例中包含 `{` 和 `}`。

供参考，DSH 定义的 section-order 取值：
`HARNESS_IDENTITY: -1000`、`DEPLOYMENT_PERSONA_PREFIX: 0`、`PLAN_POLICY: 500`、
`TEAM_POLICY: 600`、`PTC_ONLY: 800`、`FILE_REFERENCE: 900`、`TOOL_BASH: 1000`、
`TOOL_PWSH: 1010`、`TOOL_READ: 1100`、`TOOL_WRITE: 1200`、`TOOL_EDIT: 1300`、
`TOOL_GLOB: 1400`。

### `webServer.register(route)`

```ts
{ kind: "exact" | "prefix", path: string, handler: (request: IncomingMessage, res: ServerResponse) => void }
```

Node 风格，**不是** Web 的 `Request`/`Response` 对：处理器写入 `res`（`res.statusCode`、`res.setHeader`、`res.end`）并返回 `undefined`。返回一个用于注销该路由的销毁器。

**必须通过 `ctx.inject(["webServer"], (webCtx) => ...)` 获取该服务，绝不要在挂载时通过裸的 `ctx.get("webServer")` 获取。** 各行使并发挂载，所以插件的 `apply` 运行时 web 服务器可能仍然缺席；此时一次性读取返回 `undefined`，所有路由注册被静默跳过，于是 SPA 回退会为整个插件前缀应答 **404**（页面仍能渲染，但每次写入都失败）。`inject` 则会等待该服务，这就是为什么 `export const inject = []` 可以是空数组，而路由仍能可靠注册。

### 客户端

- `theme.overrideTokens(source: string, tokens: ThemeTokenOverrides): () => void`
  其中 `ThemeTokenOverrides = Record<string, ThemeTokenModes>`，
  `ThemeTokenModes = { light: string; dark: string }`。
  **两种模式都是必需的**——仅提供 light 的映射会被拒绝。
- `slots.register(options, component)` / `slots.inject(key, callback)`。
  `inject` 等待插槽声明；回调返回一个销毁器。
- `slots.entries(key)` → 原始注册条目，包含 `store` 句柄；
  `slots.resolveStore(handle, scopeBinding)` → 实时的 store 实例。
  两者都是**检视接口**，而非有文档的契约，并且
  `sidebar.settings` 可能尚未挂载——因此它们带有守卫，未命中时只是一个普通的 `undefined`。

  头部的 Ren'Py 图标用这对接口深链到 DSH 设置对话框，后者没有文档化的客户端 API：`entries("sidebar.settings")[0].store`
  → `resolveStore(...)` → `actions.openSection("renpy-skin")`。该 id 必须等于注册的 `settings.section` id，因为面板用 `rows.find((r) => r.id === activeId) ?? rows[0]` 解析当前分区。如果任一跳不可用，弹出层就退回到给出手动路径。**不要**改为注册到 `settings.launcher`：它是 `kind: "single"` 且已被占用，那样做会遮蔽已发布的 UI。

- 设置页的「用 Agent 加载」按钮用到的会话服务通过 `ctx.inject(["uiWorkspace", "sessions"], ...)` 获取，`workspaces` 另用一次 `ctx.inject` 补上——服务可能在 `apply` 之后才挂载，一次性 `ctx.get` 会错过它们（Cordis 上下文对未注入的名字是**抛错**，所以 `serviceOf` 仍保留作为兜底读取）。

- `POST /renpy-skin/agent/prepare` 先由宿主把游戏准备好并写出两棵树，按钮再开会话投递提示词。**顺序不能反**：提示词里写着真实路径，宿主没准备好时提示词会把 Agent 指向一个不存在的清单。任一步失败都 abort 并把原因显示给用户——**不再自动复制到剪贴板**，剪贴板只是失败后面板上的一个可选按钮（用户明确点击才写）。
  - `uiWorkspace` → `startSession(workspaceId?)`：打开「新建会话」流程并
    导航过去（无参数则继承当前工作区）。这是平台文档里列出的那一项。
  - `workspaces` → `workspaces.create({ path })`，新会话的工作区 id 取
    `view.id ?? view.workspaceId`（宿主用哪种拼写都认）。这一步失败**不**牵连会话：
    只记一条 `console.warn` 就继续，因为它只决定 Agent 的临时文件落在哪（现在那个目录
    由 `/agent/prepare` 建好）。
  - `sessions` → `sessions.binding(sessionId)`，会话对象是
    `binding.session`，投递文本用 `session.prompt([{ type: "text", text }], "queue")`，
    与 composer 自己提交时走的是同一个方法。`sessions.get(id)` **不存在**。
  - 新会话的 id 从 `[data-conversation-session]` 读。宿主在已经有一个空白会话时会
    复用它而不新建，所以 id 没变**不**等于失败：判别要看 composer 的阶段钩子
    （`:is([data-phase="active"], [data-content-phase="active"]) [data-composer-seat]`），
    空白会话停在 hero 阶段、不带 `active`。id 没变**且**会话已经开始，就意味着什么都没
    打开、眼前还是用户自己的对话，此时**拒绝投递**并报错——否则提示词会悄悄埋进
    用户正在聊的那条对话里，而界面还会报「已发送到新会话」。
  - 提示词里显式写明用户当前语言（`activeLocaleId()`），因为新会话不继承任何
    persona 或 locale。它同时带上一段事实块（游戏名、游戏目录、配置目录、两棵树的路径、
    各类文件计数），这样 Agent 不必再问路径。
  - **不切换预设。** 平台没有运行中改预设的 API：`agentPresets` 服务只有
    `resolve(id)` 与 `mount(agentCtx, id)`，且只在**创建** Agent 时通过
    `CreateAgentOptions.meta.agentPreset` 生效；经 `agents.create(...)` 建出来的会话
    不进入 Shell 的会话列表，用户看不见。`renpy_*` 工具本来就是全局注册的，所以按钮
    只负责「准备→建工作区→开新会话→投递」，persona 由用户在 composer 里自己选。

---

## 2. 暴露的 HTTP 路由（前缀 `/renpy-skin`）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/renpy-skin/manifest?session=&gameDir=` | 资源清单（manifest）。`gameDir` 参数会**持久化**一个新的设置项（它不是只读覆盖）。 |
| `GET` | `/renpy-skin/media?session=&under=&match=` | `{ ok, images: string[], videos: string[] }`——当前游戏自带的、**游戏相对**的图片与视频路径，用于开场媒体选择器，**也是 Agent 发现归档内可显示对象的唯一手段**（清单摘要只有目录直方图 `stats.assetDirs`，没有路径列表；工具描述 `renpy_read_manifest` 里点名了这个路由）。它刻意不复用 `manifest.backgrounds`：splash 视频不是可显示对象，永远不会进入那份索引。`?under=<目录>`（前缀匹配）与 `?match=<子串>` 做**服务端**过滤，两者都不区分大小写、都可省略；无参数时行为完全不变。带参数时响应多一个 `filter: { under, match, matched, total }`：`matched` 是**过滤后**的命中数，`total` 是过滤**之前**的总数（全量清单仍可用不带参数的调用取到）。两个数字都要给——只报一个时，「这段目录里一共 3 个」和「3 个命中」读起来一模一样，用错就会得出「`images/` 下什么都没有」的结论。过滤是给归档里的资源用的：实测 CSE 的 `/media` 一次返回 748 个图片路径，而 Agent 原本没有任何列举手段，只能整份收下再自己筛。列表按解析出的 `gameDir` 缓存，`forgetSessionState()` 与「重读磁盘」都会清空它。 |
| `GET` | `/renpy-skin/asset?p=&v=&session=` | 提供一个可显示对象（displayable），**或清单索引到的任意音频/视频**。`cache-control: private, max-age=3600`。回退到从 `.rpa` 归档读取。遵循 `Range: bytes=a-b` → `206`，并带 `accept-ranges: bytes` 和 `content-range`；语法合法但无法满足的范围是 `416`，并带 `content-range: bytes */<size>`。`<video>`/`<audio>` 在跳转时会发出 `Range`，并拒绝播放未经此方式提供的媒体。响应带 `x-content-type-options: nosniff`：游戏资源是用户文件，一个真身是 HTML 的 `.png` 不能被 sniff 成同源文档。`mimeFor()` 认识 `.ttf`（`font/ttf`）、`.otf`（`font/otf`）、`.ttc`（`font/collection`）、`.woff`（`font/woff`）、`.woff2`（`font/woff2`）——以前字体落到 `application/octet-stream`，只有浏览器足够宽容时才碰巧能用。**`v` 是清单构建令牌**（见下），路由会忽略它——它的唯一作用是把浏览器缓存键限定到某一次构建。 |
| `GET` | `/renpy-skin/stage?session=` | 某个会话的当前舞台快照。 |
| `GET` | `/renpy-skin/memory?session=` | `{ ok, game, characters: [{ tag, name?, chars, text }] }`——该游戏每个角色 tag 的跨会话记忆（`game/<扫描名>/memory.json`，纯 `tag → 文本` 映射）。tag 列表来自清单（游戏声明过什么就有什么），`text` 是该角色的**全文**，没记过的角色 `chars: 0`。 |
| `POST` | `/renpy-skin/memory` | 请求体 `{ session?, tag, text, mode }`。`tag` 必须是清单里声明过的角色（否则 400 并回带 `tags`），`mode: "append"` 追加、其余值（含缺省）替换；**空文本即删除该角色的记忆**。返回 `{ ok, tag, chars, trimmed, characters }`（`characters` 是写入后的完整列表，设置页与记忆面板据此回显）。超过上限时 `trimmed: true`，只保留最新的内容。与 `renpy_memory` 工具写的是同一份文件。 |
| `POST` | `/renpy-skin/dialogbox` | 请求体 `{ session?, path }`。**切换该游戏用哪张对话框底板**：`path` 必须是本次清单 `dialogbox.candidates` 里的路径（否则 400 并回带候选列表）——写任意路径会得到一个 404 的底板地址，而档案上看起来一切正常。写入该游戏档案的 `dialogbox.textboxImage`（只搬 `OVERLAY_SECTIONS` 里属于本游戏的段，邻居档案不继承），然后清缓存重建清单。返回 `{ ok, path, applied, manifest, settings, library, builtAt }`。设置页的选盘器与 `renpy_save_vn` 写的是同一份档案。 |
| `GET` | `/renpy-skin/settings` | `{ ok, settings, library, dataHome }`。`dataHome` 是 `resolveDataHome()` 的结果 `{ path, source, legacy }`：这台机器上实测两份数据目录并存（桌面宿主进程没有继承 `DSH_HOME`），没有这个字段用户就无法判断界面读的是哪一份。 |
| `POST` | `/renpy-skin/settings` | 修补设置。更改 `gameDir` 会清空清单缓存**以及每个会话的舞台**；三个工具路径（`pythonPath`/`unrpycPath`/`toolsDir`）会同时推给 `configureTools()` 并清空诊断与清单缓存，所以新路径立即参与下一次加载。 |
| `GET` | `/renpy-skin/doctor?refresh=` | `{ ok, node: { version, platform, arch }, pluginRoot, dataHome: { path, source, legacy, legacyPresent }, configured, python, unrpyc, usable, reason, install, requirements }`——**插件需要的环境是否就绪，以及用户能为此做什么**。`python` 与 `unrpyc` 是 `rpycDiagnostics()` 的原样结构（含 `path`、`source`、`checked` / `tried`、`reason`），`configured` 是设置页当前保存的三个工具路径，`dataHome` 是 `resolveDataHome()` 再加 `legacyPresent`（旧目录是否仍然存在：两份目录并存时，用户改的可能是被忽略的那一份）。`requirements` 按卡片顺序给四行 `node` / `python` / `unrpyc` / `dataHome`，每行带 `id`、`required`、`status`（`ok` / `missing` / `broken`）、`detail`、`source`、`chosen`、`checked` 或 `tried`，以及 `download`：Python 指向 `python.org/downloads`，`unrpyc` 指向项目主页并另带 `archive` 指向 v2.0.4 源码包——release 资产里没有 `unrpyc.py`，源码包才是用户能操作的东西。**`missing` 与 `broken` 必须分开**：前者该下载，后者该改路径；混成一个「不可用」会把用户赶去重装他已经有的工具。浏览器既不能 stat 路径也不能跑解释器，所以查找顺序只由 `lib/rpyc.js` 给出；`?refresh=1` 丢弃诊断缓存重新探测（卡片上的「重新检测」）。 |
| `GET` | `/renpy-skin/library` | `{ ok, gameDir, library }`——每个曾被分析过的游戏：`{ gameDir, name, version?, stats, savedAt }`，最新的在前，最多 50 条。 |
| `POST` | `/renpy-skin/library` | 请求体 `{ gameDir }`。**切换游戏的唯一入口**：持久化 `gameDir`（若它确实不同）、丢弃该会话的固定指向与所有按游戏缓存的清单/归档句柄，然后重建清单并返回 `{ ok, manifest, root, settings, library, builtAt }`。同一路径再次提交即“重读磁盘”——它仍然清空缓存，因为按钮的意义就在于归档可能已经变了。（两种路径都会一并清空媒体列表缓存，否则开场选择器看不到新放进游戏的文件。）没有配置目录时返回 `{ ok: false, error: "no game directory configured" }`。 |
| `POST` | `/renpy-skin/layout` | `{ session, safeArea: Rect[] }`——舞台不得覆盖的保留矩形。 |
| `POST` | `/renpy-skin/agent/prepare` | 请求体 `{ session?, gameDir? }`。**「用 Agent 加载」的前置一步**：先校验目录、解析清单、扫描目录树，再把两棵树写进配置目录，最后才返回真实路径。缺 `gameDir` 时取该会话已加载的游戏。校验顺序是「存在 → 是目录 → 能扫出清单 → 读到游戏名 → **扫到 `.rpy`/`.rpyc` 脚本或 `.rpa` 归档**」：只看目录是否存在会被任意空文件夹骗过，因为扫描器对任何目录都会成功并把目录名当游戏名。脚本可能全在归档里，所以两者都为 0 才算不是 Ren'Py 游戏。返回 `{ ok, gameDir, root, profileDir, name, paths: { gameDir, profileDir, compactTree, fullTree }, stats }`；`gameDir` 是解析后的游戏目录（带 `game/`），不是用户填的那个。 |
| `GET` | `/renpy-skin/vn?session=` | `{ ok, dir, name, profile, summary, tree, notes, applied, unmatched, rejected }`——Agent 为当前 VN 写的配置文件（`game/<VN 名>/vn.json`）。**只读**：写入是 `renpy_save_vn` 工具的事，因为 Agent 自己的文件工具被限制在它的工作区内，而配置文件必须落在插件的数据目录里。没有加载游戏（`gameDir` 为空）时只返回 `{ ok: true, profile: null, dir: null }`，其余键都不出现。`name` 是**扫描名**（覆盖层之前的 `manifest.game.name`），`dir` 也按它派生，见下。`applied` 是 `config` 覆盖层相对本次扫描改掉的字段路径（已减去 `unknownKeys`）；`unmatched` 是 `sprites.<tag>` 这种匹配不到任何扫描记录的路径；`rejected` 是 `{ savedGameDir }`，表示盘上确实有这份 profile 但它记录的目录属于另一个游戏（同名不同路径），因此**没有**被应用——为 `null` 表示不存在这种冲突（见下）；`profile.report` 是 `{ ignored, malformed, unknownKeys }`。`summary` 与 `tree` 是 `summary.md`/`tree.md` 的**开头片段**（各截到 4000 字符，超出时末尾补 `\n…`），文件不存在或读不到时是 `null`：设置页拿它们直接显示，所以不能让一个任意大的笔记整份进浏览器。`notes: { summary, tree }` 每份是 `{ chars, truncated }`（整份字符数与是否超过 4000 字符的截断上限），`null` 表示没有这份笔记——有了它，调用方可以把「这只是开头」说出来，而不是让一份被截断的笔记看起来像全文。 |
| `GET` | `/renpy-skin/export?session=` | `{ ok, config: { exportedAt, plugin, version: 1, settings } }`。当设置了会话覆盖时，`settings.gameDir` 即为该覆盖值。 |
| `POST` | `/renpy-skin/import` | 请求体 `{ config }` 或一个裸的设置对象。通过 `writeSettings` 持久化；当 `gameDir` 变化时清空清单缓存 + 舞台。返回 `{ ok, settings }`。 |

**profile 目录固定按扫描名派生。** `/vn` 的 `dir` 与 `/agent/prepare` 的 `profileDir` 都是 `game/<profileDirName(扫描名)>`，扫描名取自覆盖层**之前**的 `manifest.game.name`。这不是实现细节，而是一个真 bug 的修法：profile 可以把游戏名改掉（实测 `CSE-2.1.0-pc` → `CSE`），如果目录键跟着 `game.name` 走，保存 profile 之后的下一次构建就会去另一个目录找覆盖层，覆盖层等于自己撤销自己——同一台机器上实测踩到过。所以这两处的路径、`/vn` 的 `name` 以及 `renpy_save_vn` 的落盘目录，全部用扫描名。

`session` 缺失时默认值为 `"global"`。每个响应体都是
`{ ok: true, ... }` 或 `{ ok: false, error }`。

`safeArea` 条目中的 `Rect` 是
`{ id: string, x: number, y: number, w: number, h: number, coversX?: boolean }`，
全部为视口的分数。目前只有 `coversX: true` 的矩形参与碰撞检测（`lib/stage.js:889`）。

---

## 3. 设置项结构（schema）

持久化到 `$DSH_HOME/renpy-skin/config.json`（默认 `~/.dsh/renpy-skin/config.json`）。
`DSH_RENPY_SKIN_HOME` 可覆盖该文件夹，优先级最高；`DSH_HOME` 为空或只有空白时视为未设置。
解析规则在 `lib/home.js` 的 `resolveDataHome()` 里，返回 `{ path, source, legacy }`，
`source` 说明命中哪一级（`override` / `harness` / `legacy`）。

旧位置 `~/.dsh-renpy-skin` 与数据目录之间是**逐项合并**，不是整体搬迁：进程内首次解析
数据目录时跑一次（每次启动都会重试缺项，幂等），在 `config.json`、`library.json`、
`game/` 三项里，**旧目录有、新目录缺的那项才复制**，已存在的条目一律不动（它可能比
旧副本新），从不删除，也从不抛错。旧行为是「新目录已有 `config.json` 就整体不搬」，
而 `config.json` 只在第一次保存设置时才写出——于是「先存过一次设置、后来才发现还有
旧 library/game」的机器会永久看不到自己的库与存档，且没有任何提示。

`lib/index.js` 的 `DEFAULT_SETTINGS` 是全部键的来源。

| 键 | 类型 | 默认值 | 备注 |
| --- | --- | --- | --- |
| `gameDir` | string | `""` | Ren'Py 根目录或其 `game/` 目录。 |
| `enabled` | boolean | `true` | 总开关；为 false 时客户端忽略其余一切。 |
| `background` | boolean | `true` | 背景图层开/关。 |
| `backgroundDim` | number | `0.45` | 钳制 0–1。语义是**压暗量**（CSS 渐变直接用它）；设置页把它当**背景亮度**呈现：控件是 0–100 的整数百分比（不传 `step`，默认步长 1），写回 `(100 − v) / 100`，所以存下来的值最多两位小数。改这个键名会让调过滑块的人静默回到默认值，所以存储语义不动。 |
| `skin` | boolean | `true` | 对话框重新样式化。 |
| `dialogbox` | boolean | `true` | 对话框几何尺寸。 |
| `dialogboxModules` | boolean | `true` | 把游戏 `say` 屏自己的零件（名字框、快捷菜单按钮）画到 composer 上。关闭后只画底板与文本。 |
| `questionChoice` | boolean | `true` | 选项菜单样式。 |
| `stage` | boolean | `true` | 立绘舞台开/关。 |
| `stagePlacement` | `"overlay"` | `"overlay"` | 舞台图层所处的位置。 |
| `promptInjection` | boolean | `true` | 输出 stage-director 提示词分区。 |
| `maxStageSprites` | number | `3` | 钳制 1–8。超出会警告，绝不抛错。 |
| `autoAvoid` | boolean | `false` | 将立绘移出保留区域，而不是发出警告。 |
| `textAnimation` | boolean | `true` | 打字机效果：模型回复的正文按 `textCps` 逐字显示，并解析 `{w=0.5}` / `{p}` / `{cps=20}` / `{fast}` 四个节奏标签（其余花括号原样保留，代码块不参与）。 |
| `textCps` | number | `30` | 钳制 0–400。字符/秒；**0 = 立即全部显示**。实现里以 `max(cps, 总字数 / 8)` 计速，避免长回复把读者锁住超过约 8 秒（Ren'Py 的 cps 本来是给一行对话计的）。 |
| `backgroundImage` | string | `""` | 背景美术的手动覆盖：`game/` 下的相对路径（如 `bg room.png`）。为空表示「自动」（按游戏当前 `scene`/`show` 的贴图名解析，找不到再回落）。设置为不在图库里的路径也照用。 |
| `themeTokens` | boolean | `true` | 应用别名 token 覆盖。 |
| `paletteOverrides` | object | `{}` | 色板的手动覆盖：键限 `accent` / `hover` / `idle` / `text` / `uiText` / `name` / `choiceIdle` / `choiceHover`，值必须是 `#rgb` 或 `#rrggbb`（写入时小写化）。`text` 是对话框（文本框）里的文字、`uiText` 是 DSH 界面自身的文字，两者刻意分开：钉住一个不会连带改掉另一个（`text` 不再是 `--dsw-alias-label-primary` 的来源）。非法值与未知键**丢弃**，每次写入都用新对象**整体替换**（空对象 = 全部跟随游戏）。它排在清单扫描的候选之前（来源记 `settings`），`theme` 的 10 个 token 就是由覆盖后的 accent 重新派生的，所以保存后必须重建清单才能在界面上看到新主题。 |
| `hideSidebar` | boolean | `false` | 隐藏左侧会话列表，把宽度让给会话与舞台。只写一条 CSS（隐藏 `[data-slot="sidebar"]` 所在列并把后两列重铺到 `grid-column: 1 / 3` 与 `3`），**不调用宿主的布局服务**，所以宿主自己的折叠状态不受影响；关掉开关即可恢复。 |
| `hideComposer` | boolean | `false` | 隐藏底部对话框（composer 的 `[data-composer-seat]`），同时隐藏画在它上面的 `say` 屏零件（`.rsk-modules`）。用于观看模式；`dialogbox` 开关控制的是换肤，不是显示/隐藏。 |
| `lang` | `"auto"` | `"auto"` | 皮肤自身的标签：`auto` 跟随宿主区域设置，`zh`/`en` 强制指定。 |
| `layoutProfiles` | object | `{}` | 具名的 `safeArea` 集合。 |
| `enabledCharacters` | string[] | `[]` | 在 设置 → 角色 中勾选的标签。**为空表示每个角色**，因此全新安装绝不会出现无演员的舞台；非空列表是硬性名单——未勾选的 `show` 会以 `未启用，请到设置勾选` 被拒绝。会去重，非字符串会被丢弃。 |
| `splashOnStart` | boolean | `false` | DSH 启动时重放游戏的 `label splashscreen:`。**默认关闭**——开场（splash）是一种打断。 |
| `splashSkipOnClick` | boolean | `true` | 任意点击都会关闭开场。 |
| `splashOnSwitch` | boolean | `false` | 切换游戏重播新游戏的开场。与 `splashOnStart` **分开**：启动与切换是两个时刻，此前复用同一个闩锁，导致启动开关关闭时切换仍会重播。 |
| `splashMedia` | string | `""` | 替代提取出的开场的路径（或 `http(s)` URL）。为空表示“使用提取结果”。 |
| `menuMusicOnStart` | boolean | `true` | 加载时遵循游戏的 `config.main_menu_music`。 |
| `menuMusicTrack` | string | `""` | 覆盖播放哪个菜单音乐候选；为空则播放第一个解析出的候选。 |
| `playlistVolume` | number | `0.6` | 钳制 0–1。 |
| `playlistAutoplay` | boolean | `false` | 加载时自动播放头部播放列表。默认关闭，因为浏览器会阻止未经提示的音频。 |
| `playlistRepeat` | `"off" \| "all" \| "one"` | `"off"` | 播放到最后一首之后：`off` 停在最后一首，`all` 回到第一首，`one` 重播当前曲。非法值在 `writeSettings` 里被丢弃（不落盘），客户端也把不认识的值当作 `off`。它和 `playlistShuffle` 两个键共同构成播放器面板上**唯一那个模式按钮**的四个状态（见下）。 |
| `playlistShuffle` | boolean | `false` | 为真时「下一首/上一首」从其余曲目里等概率抽取（不重复当前曲），自动播完也走随机。它优先于 `playlistRepeat` 的边界——否则 `off` 会在按钮明明还能播的时候停掉音乐。 |
| `composerBackdrop` | `"default"` | `"default"` | 宿主贴底输入区（`.Dc7zOa_composerSeat`）的背景：`default` 保持宿主的渐变，`transparent` 完全透出游戏美术，`solid` 用 `--dsw-alias-bg-base` 盖住。只接受这三个值。 |
| `composerFont` | string | `""` | 整个界面使用的字体（写入 `--dsw-font-family`，随选随变，不改字号）。空值跟随游戏对话框字体；可选 VN 字体路径、预设系统字体，或自定义字体族名称。键名沿用 `composerFont` 以免静默重置已有设置。 |
| `playerName` | string | `""` | 用户在角色扮演（「在场」预置）里的名字，最长 60 字符。为空时角色扮演说明会明确告诉模型「没有名字，用『你』称呼，不要替他起名」。 |
| `sessionNames` | object | `{}` | `{ <sessionId>: 名字 }`——按会话覆盖 `playerName`。空字符串表示该会话没有覆盖（回落到全局名）。键长 1–200，值截到 60 字符；只接受普通对象。 |
| `roleplayPrompt` | string | `""` | 追加到「在场」角色扮演说明里的用户要求（语气、边界、要避免的事），最长 4000 字符。**只注入角色扮演预置的会话**，其余会话的提示词不受影响。 |
| `pythonPath` | string | `""` | 运行 `unrpyc` 的 Python 解释器：完整路径或 PATH 上的名字。空值自动发现。trim 后最多 400 字符。**优先级高于 `DSH_RENPY_PYTHON`**；填了却跑不起来时 `rpycDiagnostics()` 报告失败，不会回落到自动发现。 |
| `unrpycPath` | string | `""` | `unrpyc.py` 的路径，或解压出来的 `unrpyc-2.0.4` 目录——是目录时会自动找其中的 `unrpyc.py`（安装说明给的就是目录，直接粘贴目录是最常见的用法）。空值依次查找插件的 `vendor/unrpyc/`、工具目录与 PATH。trim 后最多 400 字符，优先级高于 `DSH_RENPY_UNRPYC`。 |
| `toolsDir` | string | `""` | 去哪里找 `unrpyc*` 检出目录，空值表示 `~/Tools`。trim 后最多 400 字符，优先级高于 `DSH_RENPY_TOOLS`。 |

`pythonPath` / `unrpycPath` / `toolsDir` 由 `lib/index.js` 在读取设置与每次写入后
推给 `lib/rpyc.js` 的 `configureTools()`。设置页的值压过环境变量，因为界面上刚填
的路径是用户刚刚做出的选择；诊断里的 `source` 会说明最终命中哪一级。

`writeSettings` 会**静默丢弃未知键**。添加一个设置项
需要同时修改 `DEFAULT_SETTINGS` 和本表。

**播放器面板只有一个模式按钮。** 它对用户呈现四个状态，每按一次前进一格，
状态与两个设置键的映射如下（`lib/client.js` 的 `PLAYBACK_PATCH`，无头用例
`one button reaches every playback mode and writes a state it can read back` 钉住这条）：

| 按钮显示 | `playlistRepeat` | `playlistShuffle` | 曲目结束后 |
| --- | --- | --- | --- |
| 顺序播放 | `"off"` | `false` | 停在最后一首 |
| 列表循环 | `"all"` | `false` | 回到第一首 |
| 单曲循环 | `"one"` | `false` | 重播当前曲（重设 `currentTime`，不重赋 `src`） |
| 随机播放 | `"off"` | `true` | 从其余曲目里等概率抽一首 |

随机状态会把 `playlistRepeat` 写回 `"off"`：留着 `"all"` 会得到一个按钮叫不出名字、
换台机器读回配置时又显示「列表循环」的组合。反向读取由 `playbackModeOf(settings)`
负责，`playlistShuffle === true` 优先于 `playlistRepeat`。

### VN 配置文件（`game/<VN 名>/`）

Agent 用 `renpy_save_vn` 工具把「这个游戏到底长什么样」写下来，插件下次自己加载。
位置在**数据目录**下，不是插件源码树：

```
$DSH_HOME/renpy-skin/game/<VN 名>/
  vn.json            # 覆盖层：{ savedAt, gameDir, name, report, ...覆盖层段（含 characters/sprites）}
                     # report = { ignored, malformed, unknownKeys }
  tree.md            # Agent 写的目录树笔记
  summary.md         # 当前会话的压缩摘要（决定、文件名、读到的值、还没解决的）
  scan-tree.md       # 宿主写：紧凑地图，≤400 行 / 约 12 KB
  scan-tree.full.txt # 宿主写：完整文件清单，≤20000 条
  memory.json        # 跨会话角色记忆：{ "<tag>": "文本" }，见下
```

`memory.json` 是**角色记忆**，不是游戏元数据：键是角色 tag，值是这段记忆的全文（纯文本，保留换行）。
它由两条路径写同一个文件——模型通过 `renpy_memory` 工具（`append`/`replace`），用户在设置页或顶栏
记忆面板里编辑（`POST /renpy-skin/memory`）。每个角色的文本上限 8000 字符，超出时**保留最新内容**并按
行边界截断（`trimmed: true`）。写空的角色条目等于删除它；整份为空时文件本身会被删掉。解析失败当作
「还没有记忆」，绝不因此让清单或工具失败。

`tree.md` 与 `scan-tree.md` 是两样东西：前者是 Agent 的笔记（它认为每个文件做什么用），
后者是宿主扫描出来的**事实**，Agent 拿它对照。后者由 `POST /agent/prepare` 写，
在 Agent 动手之前就已经存在。

两份笔记都按 **4000 字符**截断回读（`readNoteHead()`，`lib/index.js:2572`），`GET /vn`
的 `notes` 同时给出整份的字符数与 `truncated`：调用方据此可以把「这只是开头」说出来，
而不是让一份被截断的笔记看起来像全文。

`<VN 名>` 由 `profileDirName()`（`lib/vn.js:58`）从**扫描读到的**游戏名派生：把
`<>:"/\|?*` 与控制字符换成 `_`，去掉首尾的 `.` 与空白，截到 80 字符；如果清理后什么
都不剩就回退到 `vn`。因此 `VN` 名里带 `/` 或 `:` 也不会写到目录之外。
`DSH_RENPY_SKIN_HOME` / `DSH_HOME` 会整体挪走这个目录树。

目录键**固定用扫描名**（`record.profileName`），不用覆盖层里的 `game.name`；`/vn` 的
`dir` 与 `/agent/prepare` 的 `profileDir` 同此。原因见第 2 节 `/vn` 一行。

**它是覆盖层，不是替代品。** 清单永远来自扫描；`vn.json` 的 `config` 只把扫描
读错或读不出来的字段盖掉，并记录改掉的字段路径到 `manifest.profileApplied`。
文件缺失、不是对象、或是坏 JSON 都当作「没有覆盖层」——绝不因此让清单构建失败。
扫描已经读对的字段不会被改动，所以 `applied` 为空就是「这次没盖掉任何东西」。

各段的合并粒度不同：

| 段 | 合并方式 | 原因 |
| --- | --- | --- |
| `dialogbox`、`layout`、`choice`、`theme` | 逐 key 覆盖，未提及的键保留扫描值 | 覆盖层只修正读错的字段 |
| `game` | 逐 key 合并，`screen` 再浅合并一层（只写 `w` 就留着 `h`） | 只写 `{ name, version }` 会把 `game.screen` 抹掉，而客户端拿 `game.screen.w/h` 算对话框布局 |
| `transcript` | 整段替换 | 它不来自扫描，没有「保留扫描值」可言 |
| `characters` | 按变量名逐字段合并，变量不存在时创建 | `Character(...)` 声明可能躺在无法反编译的 `.rpyc` 里 |
| `sprites` | 按 `tag` 或 `name` 命中扫描已找到的记录，再逐字段改；匹配不到只进 `unmatched` | 新记录需要 asset URL 与尺寸，只有扫描能 mint |

**`null` 与 `undefined` 都表示「保留扫描值」。** 以前只有 `undefined` 被跳过，
`null` 会真的写进清单、把扫描值清空；而 `renpy_read_manifest` 回执里缺省的字段就是
`null`，Agent 把回执拷回去当输入时会把字段全清掉。

段名单是 `OVERLAY_SECTIONS = ["game", "dialogbox", "layout", "choice", "theme",
"transcript", "characters", "sprites"]`（`lib/vn.js:39`），其它键一律丢弃。`characters`
与 `sprites` 是后加的：`define qc = Character("启诚", image="qc")` 这类声明可能读不到，
而 `image="qc"` 指向的目录实际可能是 `images/qicheng/`——两种情况都要让 Agent 有机会修正。

回执把四件事分开报：`applied`（相对本次扫描**真正改掉的字段路径**，已减去
`unknownKeys`）、`ignored`（段名不在名单里）、`malformed`（段名对但值不是对象、
是数组、或是空对象，以及 `game` 段里坏掉的 `name`/`version`/`screen`）、
`unknownKeys`（段名对但**键名拼错**的扁平路径，例如 `layout.dialogueWidht`）。
`inspectProfileConfig()` 返回的正是 `{ accepted, ignored, malformed, unknownKeys }`。

**拼错的键照样写进清单，但不计入 `applied`**，同时在回执里点名。不直接拒绝的理由：
段内键有一部分来自游戏本身（`characters` 的变量名、`sprites` 的 tag），宿主无法穷举，
硬拒会把合法写法挡掉。

**`applied` 只证明「清单改了」，不证明「界面变了」。** 客户端目前真正读的字段是：`dialogbox`
的 `fill`、`height`、`opacity`、`textColor`、`textSize`、`fontUrl`、`textboxImage`、
`textboxImageAlign`、`textboxImageBounds`、`textboxImageBox`；`layout` 的 `textboxHeight`、
`textboxYalign`、`dialogueXpos`、`dialogueYpos`、`dialogueWidth`、`dialogueTextXalign`、
`nameXpos`、`nameYpos`、`nameboxWidth`、`nameboxHeight`；`game` 的 `name`、`version`、`screen`；
`audio` 的 `menuMusic`、`playlist`。`nameColor`、`nameSize`、`nameboxImage`、`nameboxBounds`、
`nameboxBorders`、`nameboxTile`、整个 `choice` 段（含 `borders`、`idleBackground`、
`hoverBackground`、`textIdleColor`、`textHoverColor`）与 `game.showName` 都会被写进清单并计入
`applied`，但当前没有渲染路径消费它们——它们是给后续渲染与 Agent 自己读的。要判断「屏幕上
会不会变」，看的是上面那份名单，不是 `applied` 的长度。

除 `applied` 之外还有两个「没落地」的名单：`unmatched`（`sprites.<tag>` 这种匹配不到
任何扫描记录的路径）与 `unresolved`（`dialogbox.textboxImage`/`nameboxImage`、
`choice.idleBackground`/`hoverBackground`、`game.mainMenuMusic` 这几项里「路径在游戏里
读不出任何文件」的字段）。`unresolved` **只报告、仍然保存**——路径可能要等用户装好
归档后才可解析，为一个路径丢掉整份 profile 更糟。

**写入前先读。** `renpy_read_manifest` 无参、只读，返回本次扫描**真正读到的值**
（画布、对话框与其几何、选项按钮、颜色、字体、角色声明、立绘桶、变换、背景，外加
`sources`、`scripts` 与 `profile.applied`/`profile.rejected`/`profile.unmatched`），
缺失的字段才会在清单里回退成默认值。`sources`/`scripts`/`spriteTags` 只描述扫描，
不是覆盖层段——把它们原样塞回 `config` 会被记进 `ignored`。因此 `config` 的定位是
**修正**这些值，而不是重新猜一遍：Agent 先读回执，再把读错或读不出的字段写进 `config`。`vn.json` 里的
`report: { ignored, malformed, unknownKeys }` 会连同 `savedAt`、`gameDir`、`name`
一起落盘（不是覆盖层段，读取器会忽略它），`GET /vn` 回读它，界面据此说明上次写入
到底做了什么。

**先验收再写盘。** `renpy_save_vn` 传 `dryRun: true` 时不写任何文件、也不清缓存，返回
`{ ok, dryRun: true, dir, wouldWrite: { tree, summary, vn }, applied, ignored,
malformed, unknownKeys, unmatched, unresolved }`。这里的 `applied` 与真正写入后同粒度：
都是**字段路径**（如 `dialogbox.textColor`），因为 dry run 回答的正是「哪些字段会生效」。
实现方式是对缓存清单的相关段做 `structuredClone`，在同一套 `applyProfile()` 上跑一遍，
所以既不会就地改掉缓存，也不会与真写路径分叉。
`unmatched` 同样来自这份深拷贝上的合并，所以它能提前回答「这个 tag 会不会命中任何扫描记录」。

**保存后立刻重建。** 返回的 `applied` 来自**刚写入的那个 profile 目录**的重建（以前
重建读的是另一个目录，`applied` 非空只能证明「某个 profile 被应用了」）；重建失败时
返回 `rebuildError`——文件已经落盘，回执据此说明「写进去了但没读出来」。

**profile 有归属。** `vn.json` 里记着写入时的 `gameDir`（`resolveGameDir` 解析后的
资源目录，通常是 `.../game` 子目录），读取时再解析一次后比较，所以同一个游戏无论
配置成根目录还是 `game/` 子目录都认作一个游戏。目录不符时跳过覆盖层，并写
`manifest.profileRejected = { savedGameDir }`（`GET /vn` 会在 `rejected` 里回读）：
profile 目录按游戏名命名，同名游戏会共用它，否则第二个被加载的 VN 会被另一个游戏
的配色、字体和对话框几何重新换肤。任一侧为空即视为「不知道」，照旧应用——不能因为
一个旧文件缺字段就让它失效。

工具参数：`{ name?, tree?, config?, summary?, dryRun? }`。`name` 缺省时取当前清单里的
游戏名（可以是覆盖层修正后的名字），但目录键始终用扫描名。Agent 的工作区就是这个目录
（「用 Agent 加载」会用 `workspaces.create({path})` 把它注册成工作区），所以它的树与
摘要落在配置文件旁边，而不是落在当前目录。`summary` 落在 `summary.md`（**不是**
`vn.json` 的 `transcript` 段——那个只有 Agent 自己写 `config.transcript` 才会出现）。
`dryRun` 的作用见上一段。

### 两层目录树（`lib/scantree.js`）

大游戏的完整清单会撑爆提示词，所以 `/agent/prepare` 写两份：

- `scan-tree.md`——**给模型看**的紧凑地图。硬预算 400 行 / 12 KB（`COMPACT_LINE_LIMIT`、
  `COMPACT_BYTE_LIMIT`）。分节按优先级排（游戏头 → `game/` 目录 → 脚本与配置 → 归档 →
  字体与对话框 → 图片按目录聚合 → 背景 → 角色 → 音频 → 视频），装不下时逐块截断，
  末尾加一行 `… (compact tree clipped at N lines / N KB; the complete listing is in
  scan-tree.full.txt)`——**被截断这件事必须写在文件里**，否则模型会把不完整的清单当成全部。
  每节本身也有条数上限（脚本 60 条、图片目录 60 个、取样 12 条），所以正常游戏很少触发总预算。
- `scan-tree.full.txt`——完整遍历，上限 20000 条（`FULL_ENTRY_LIMIT`），超了在文件里
  写明 `[truncated] the walk stopped at 20000 files; the game holds more`。`.rpa`
  归档**默认只展开第一层**，按顶层目录计数——展开到文件级会把几个 GB 的归档变成十万行。

跳过的目录：`cache`、`saves`、`tl`、`__pycache__`、`.git`、`renpy`。
`stats` 会回报 `truncated` 与 `limit`，客户端据此在提示词里补一句「清单被截断了」。

### 未来：schemastery `Config`

本插件刻意**不**声明 `Config`。当宿主依赖变得可安装时应采用的格式，
取自 `dsh-context/lib/index.js`：

```js
import Schema from "@deepseek-ai/schemastery";
const Config = Schema.object({
  gameDir: Schema.string().default(""),
  maxStageSprites: Schema.number().default(3),
});
export { Config, apply, inject, name };
```

注意，已安装但未被引用的 `Config` 会以
`status: "schema"` 出现在 `Config.listConfigs` 中。

---

## 4. `renpy_stage` 工具

| 参数 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `script` | string | yes | 一条或多条显示语句，每行一条。 |
| `transition` | `"dissolve" \| "fade" \| "none"` | no | 在语句未指定时应用。 |
| `clear` | boolean | no | 先重置整个舞台。 |

会话身份是 `String(exec.agent.id ?? "global")`。成功时的结果：

```ts
{ ok: true, applied: Array<{kind, tag?, image?, attributes?, transition?, scene?}>, warnings: string[], stage: Stage }
```

被拒绝时，`StageError` 的 `details` 会被展开进结果中**而不是抛出**，
因此模型以结构化数据收到可选项：

```ts
{ ok: false, error: string, ...details }   // e.g. { tags: [...], builtinTransforms: [...] }
```

### 另外四个工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `renpy_configure` | `{ gameDir: string }` | 按绝对路径加载或切换当前 VN（根目录或其 `game/` 子目录都行），持久化它，清空缓存的清单与舞台，返回 `game` 与 `stats`（`backgrounds`/`tags`/`transforms`/`displayables`）。它**不返回**清单内容——要读扫描值请用 `renpy_read_manifest`。 |
| `renpy_read_manifest` | 无 | 只读。返回本次扫描**真正读到的值**：`{ ok, gameDir, game, dialogbox, layout, choice, theme, stats, sources, scripts, characters, spriteTags, backgrounds, transforms, profile }`，输出是一段 JSON 代码块，便于直接拷回去修正。`dialogbox` 的 18 个字段、`layout` 的 16 个、`choice` 的 8 个**全部**带上（旧白名单漏掉了 `fontUrl`、`textboxImageBounds`、`textboxImageBox`、`nameboxImage`、`nameboxBounds`、`nameboxTile`、`choice.borders` 等**会生效**的字段，Agent 因此没法修正它们）。`textboxImageBox` 是插件用 `lib/png.js` 的 `pngOpaqueBounds()` 按 alpha 阈值算出来的，Agent 无法自己复现，所以必须出现在回执里。`characters` 是脚本里的角色声明（截到 60 个），`spriteTags` 是扫描出的立绘桶（截到 60 个 tag、每个 8 个属性），背景 40 个、变换 30 个。没有加载游戏时返回 `{ ok: false, error }`。 |
| `renpy_save_vn` | `{ name?, tree?, config?, summary?, dryRun? }` | 把 Agent 对这个游戏的结论写成 VN 配置文件（见第 3 节「VN 配置文件」）。返回 `{ ok, dir, files, applied, ignored, malformed, unknownKeys, unmatched?, unresolved?, rebuildError? }`；`applied` 是 `config` 相对本次扫描改掉的字段路径（已减去 `unknownKeys`），`ignored` 是段名不在名单里的键，`malformed` 是段名对但值不能用的键，`unknownKeys` 是段名对但键名拼错的路径，`unmatched` 是匹配不到立绘的 `sprites.<tag>`，`unresolved` 是路径在游戏里读不出文件的字段，`rebuildError` 表示文件已落盘但重建失败。`dryRun: true` 时不写任何文件、不清缓存，返回 `{ ok, dryRun: true, dir, wouldWrite: { tree, summary, vn }, applied, ignored, malformed, unknownKeys, unmatched, unresolved }`——这里的 `applied` 与真写后同粒度，都是**字段路径**（见第 3 节「VN 配置文件」）。没有加载游戏时返回 `{ ok: false, error }`，不写任何文件。 |
| `renpy_memory` | `{ action: "list" \| "read" \| "append" \| "replace", character?, text? }` | 跨会话**角色记忆**（`game/<扫描名>/memory.json`，见第 3 节）。`list` 列出名册里每个角色已存了多少字符；`read` 读某个角色（不给 `character` 就读全部有记忆的）的全文；`append` 追加、`replace` 覆盖。`character` 必须是清单声明过的 tag（否则回 `{ ok: false, error, tags }`），`text` 为空时 `append` 被拒绝、`replace` 表示删除该角色的记忆。返回 `{ ok, action, character?, chars, trimmed?, note?, characters? }`。它与设置页的记忆面板写同一份文件，是「在场」预置跨会话记得事情的唯一手段。 |

会落盘的三个工具分工如下：`renpy_save_vn` 写 VN 配置文件，`renpy_memory` 写角色记忆，
`renpy_configure` 把它解析出的 `gameDir` 通过 `writeSettings()` 存进设置（与设置页同一条路径）；
`renpy_read_manifest` 与 `renpy_stage` 完全不落盘。`dryRun` 让 `renpy_save_vn` 在写之前就能验收，所以覆盖一份
已经能用的 profile 之前不必先赌一把。

---

## 5. 舞台数据形态

一个快照（`StageStore.snapshot(sessionId)`，`lib/stage.js:543`）：

```ts
interface Stage {
  scene?: { image: string; url: string; path: string };
  transition: string;          // "none" when unset
  sprites: Sprite[];           // ordered by zorder semantics, not array order
  updatedAt: number;
}
interface Sprite {
  tag: string; image: string;
  url?: string;                // absent for a layeredimage: it draws `activeLayers`
  side: boolean; zorder: number;
  alpha: number; zoom: number; rotate: number;
  xpos: number; ypos: number; xanchor: number; yanchor: number;
  xoffset: number; yoffset: number;
  warnings: string[];
}
```

快照与工具回执必须是**无损 JSON**：宿主会拒收任何值为 `undefined` 的键，整份结果
作废（`value is not lossless JSON`）。所以没有背景时 `scene` 键缺席、不是
`scene: undefined`；分层立绘没有 `url` 键，改用 `activeLayers` 逐层绘制。

放置默认值（`lib/stage.js:873` 的 `placementFor()`）：`xpos 0.5`、`ypos 1`、
`xanchor 0.5`、`yanchor 1`，偏移 `0`。`xalign`/`yalign` 会展开为 `xpos`/`xanchor` 和
`ypos`/`yanchor`，与 Ren'Py 一致。

---

## 6. 清单形态

由 `buildManifest(gameDir, { assetUrl })` 生成，`lib/manifest.js:1074`。
`version` 为 `1`。

```jsonc
{
  "version": 1,
  "generatedAt": "ISO-8601",
  "assetToken": "<每次构建唯一>",
  "source": { "root", "gameDir", "gameRoot", "relative" },
  "game": { "name", "version", "screen": { "w", "h" }, "mainMenuMusic", "showName" },
  "backgrounds": [{ "name", "tag", "attributes", "url", "path" }],
  "sprites": [ /* same shape, capped at SPRITE_LIST_CAP = 200 */ ],  "spriteIndex": { "<image name>": { "url", "path", "tag", "attributes", "width", "height",
                                    /* layered sprites also carry: */
                                    "layered": true, "layers": {}, "groups": [], "base": {} } },
  "tags": [{ "tag", "total", "attributes", "expressions": [ /* capped at EXPRESSION_CAP = 24 */ ] }],
  "characters": { "<变量名>": { "name", "color", "image", "spriteTagUnresolved" } },
  "dialogbox": { "height", "yalign", "opacity", "fill", "textColor", "textSize", "font",
                 "fontPath", "fontUrl", "textboxImage", "textboxPath", "textboxSource",
                 "textboxImageAlign", "textboxImageBounds", "textboxImageBox",
                 "candidates": [{ "path", "source", "url", "bounds" }],
                 "nameColor", "nameSize", "nameboxImage", "nameboxBounds",
                 "modules": [{ "kind", "rect", "z"?, "visible"?, "image"?, "imageUrl"?,
                               "fit"?, "color"?, "textColor"?, "trackColor"?, "radius"?,
                               "border"?, "hover"?, "text"?, "size"?, "align"?,
                               "valign"?, "action"?, "value"?, "source"? }],
                 "quickMenu": [{ "label", "action", "note"? }] },
  "layout": { "textboxHeight", "textboxYalign", "nameXpos", "nameYpos", "nameXalign",
              "nameboxWidth", "nameboxHeight", "nameboxBorders", "nameboxTile",
              "dialogueXpos", "dialogueYpos", "dialogueWidth", "dialogueTextXalign",
              "choiceButtonWidth", "choiceButtonHeight", "choiceButtonBorders" },
  "choice": { "width", "height", "borders", "textIdleColor", "textHoverColor", "textSize",
              "idleBackground", "hoverBackground" },
  "transforms": { "<name>": { "props": {}, "atl": [] } },
  "audio": { "playlist": [{ "path", "url", "title", "directory", "duration"? }],
             "menuMusic": [{ "path", "url", "title", "preferred", "inPlaylist", "condition"? }],
             "menuMusicDeclared", "menuMusicUnresolved", "aliasCount", "extensions" },
  "splash": { "found", "kind": "video" | "image", "path", "source": "splashscreen" | "presplash",
              "url", "duration"?, "candidates", "images": [{ "path", "url" }],
              "audio": [{ "path", "url" }], "screens", "timers" },
  "stats": { "backgrounds", "sprites", "tags", "characters", "displayables",
             "assetDirs": [{ "dir", "count" }], "transforms", "audio", "videos", "playlist",
             "assetsIndexTruncated", "spriteListTruncated", "unread" },
  "scripts": { "found": { "looseRpy", "looseRpyc", "archivedRpy", "archivedRpyc", "total" },
               "decompiled", "attempted", "skippedByCap", "unreadable", "reason", "tool" },
  "sources": { "<点路径>": "screen" | "style" | "gui-variable" | "conventional-path" |
               "character-declaration" | "none" | "style-window" | "profile" | "default" | "unread" },
  "theme": { "<css var>": { "light", "dark" } },
  "themeAccentForeground": "#rrggbb"
}
```

`dialogbox.textboxImageBounds` 是图片的像素尺寸，`textboxImageBox` 是**非透明包围盒**
`{ x, y, width, height, imageWidth, imageHeight }`（由 `pngOpaqueBounds()` 按 alpha 阈值
算出，只对 `.png` 计算，读不出时缺省）；`textboxSource` 说明贴图是怎么找到的（见
「取值来源」）。

**`dialogbox.candidates` 是这台游戏可能用到的所有底板，`textboxPath` 是其中当前选中的那张。**
一张游戏里常常躺着好几张 `textbox.png`（新 GUI 与旧 GUI、不同分支的界面包），只挑一张
就会在另一个分支的游戏上显示错的框。收集顺序是「显式 `gui` 变量 → `window` 样式 →
`say` 屏的 `add`/`background` → 常规路径 → 按 `textbox|say|dialogue|message` 扫全库」，
最后一项是兜底（排除 `/phone/`、`/tablet/` 与 namebox，最多 12 张），每项带
`{ path, source, url, bounds }`。**`candidates[0]` 永远等于 `textboxPath`**：扫描按发现顺序
收集，而覆盖层在之后才应用，所以 `rederiveAssets()` 会在 profile 改过 `textboxImage` 时
把选中的那张提到首位（档案指到扫描没找到的路径时，就地为它合成一条 `source: "profile"`
的候选）。设置页的选盘器与 `POST /renpy-skin/dialogbox` 都靠这份列表；`renpy_read_manifest`
的摘要里对应的是一个**只读**的顶层 `plates` 数组（`{ path, source, selected? }`，在
`dialogbox` 与 `layout` 之间）——它不是可写的段，换盘要把路径写进 `dialogbox.textboxImage`。
候选的 `source` 用同一批溯源名，外加一个只出现在候选列表里的 `sweep`（全库扫描兜底）。

**`dialogbox.modules` 是 say 屏的声明式零件表。** 它是一个扁平数组（不是树），每个节点用
**画布像素**的 `rect: { x, y, w, h }` 定位，`z` 决定叠放顺序，`visible: false` 可以留着不画；
`kind` 只能是 `box` / `image` / `text` / `button` / `bar`。扫描器从 `say` 屏顶层找出底板之外的
`add` / `background`（→ `image`）、名字框（→ `image`，rect 由 `layout.name*` 与窗口顶换算），
再从 `quick_menu` 的 `textbutton` / `imagebutton` 里挑出**动作在白名单内**的按钮（→ `button`）：
`settings`（Prefs / Save / Load / QuickSave / QuickLoad）、`music`、`memory`、`hide`、`skip`。
映射不到白名单的按钮不会画出来（画出来也点不动），而是进只读的 `dialogbox.quickMenu`
（`{ label, action }`），让模型知道游戏原本有这个按钮；摘要里还有一个同名的只读顶层数组，
放在 `plates` 旁边。

`image` 存的是 `game/` 相对路径，浏览器要的是 `imageUrl`——它由 `rederiveAssets()` 在档案改过
`dialogbox.modules` 时派生（`hover.image` 同理），所以 `renpy_read_manifest` 的摘要里**没有**
`imageUrl`（派生值不是可写形状）。`sources["dialogbox.modules"]` 取 `screen`（扫描结果）、
`profile`（档案覆盖）或 `default`。Agent 通过 `renpy_save_vn` 的 `dialogbox.modules` **整体替换**
这张表：最多 40 个节点，超出部分与非法节点按 `dialogbox.modules[i]` 进 `malformed`；
`[]` 是合法的「清空」声明。设置里的 `dialogboxModules` 关闭后只画底板与文本，不画这些零件。

**`spriteIndex` 是完整的；`sprites` 和 `tags[].expressions` 的上限仅出于展示目的。**
校验始终走 `spriteIndex`，因此从 `sprites` 中被裁掉的立绘仍然可以显示。

**`assetToken` 由宿主端加上，不是 `buildManifest` 的产物**（`manifestFor`，
`lib/index.js:601`）。它是一次构建的唯一令牌，被拼进该次构建生成的**每一个**
资源 URL（`/renpy-skin/asset?v=<token>&p=<相对路径>`）；`/asset` 路由忽略 `v`，
它纯粹是浏览器缓存键的一部分。没有它时，每个游戏的 `gui/main_menu.png` 都会
解析成同一个 URL，而该路由缓存一小时，于是切换游戏后浏览器回放的是**上一个
游戏**的字节——背景确实还是旧游戏的。清空 `manifestCache`（切换游戏、重读磁盘）
会重新生成令牌，因此归档变化也会顺带失效缓存。客户端自己拼 URL 的地方
（`splashMedia` 覆盖，`lib/client.js`）必须带上同一个令牌。

一个 `layeredimage` 角色是**一个**立绘，其 `attributes` 是每组非
`default null` 属性的扁平并集，另有一个 `layers` 映射
（`group → attribute → { url, path }`）、一个有序的 `groups` 列表，以及一个 `base`
变换（该块的 ATL 默认值）。分层标签的 `tags[].expressions` 是每个属性一个
条目，以便模型能组合出 `show enid glasses thinking`。

**`stats` 与两个「截断」。** `assetsIndexTruncated` 表示资源索引撞到了 20000 条上限
（`lib/manifest.js:590` 的 `indexAssets`）；`spriteListTruncated` 表示立绘候选超过了
`SPRITE_LIST_CAP = 200` 的展示上限（`lib/manifest.js:96`）。两者一个是索引上限、一个是
展示上限，实际含义完全不同，所以名字必须分开——旧名都叫 `truncated`。`characters` 是
角色声明数，`unread` 是「读不到、因此整块是默认值」的分区名数组（例如
`["scripts","characters","theme","layout","choice"]`），只有脚本一条都没读到时才非空。
`assetDirs` 是索引里文件数最多的前十个目录（`{ dir, count }`，直接放在游戏
目录下的文件记为 `.`）：摘要里没有路径清单，没有它 Agent 就只能靠猜在
`/media?under=` 里试目录名。它统计的是索引到的**全部**文件（图片、音频、视频、字体），
所以「音频在哪」和「立绘在哪」是同一个回答。

### 取值来源（`sources`）

`sources` 是「这个值从哪来」的溯源表，键是点路径（`dialogbox.textColor`、
`layout.dialogueWidth`、`theme.accent`、`dialogbox.font`、`dialogbox.textboxImage`、
`characters`、`dialogbox.textboxSource` 等），值是下面之一。不是清单里每个字段都有
条目：只有走 `firstDefined()` 的那批（颜色、字号、几何）加上字体、贴图与 `characters`
会被记录，其余字段没有溯源：

| 值 | 含义 |
| --- | --- |
| `"screen"` | 脚本里的 `screen say` 屏幕体（含内联属性） |
| `"style"` | `style` 块（`say_dialogue`、`window` 等） |
| `"gui-variable"` | `gui.*` 赋值 |
| `"conventional-path"` | 命中约定路径，如 `gui/textbox.png` |
| `"style-window"` | 贴图来自 `style window background`（只用于 `dialogbox.textboxImage` / `textboxSource`） |
| `"character-declaration"` | 来自 `Character(...)` 声明 |
| `"none"` | 贴图什么也没找到（只用于 `textboxImage` / `textboxSource`） |
| `"profile"` | 这个值来自 VN 配置文件的覆盖层，不是本次扫描 |
| `"settings"` | 这个值来自设置页的覆盖（目前只有色板 `paletteOverrides`），不是本次扫描 |
| `"image-sample"` | 颜色从对话框底板（失败时名字框）图片采样而来，因为游戏没有声明 `gui.accent_color` |
| `"dialogue-text"` | 界面文字色跟随对话文字色（只用于色板的 `uiText` 槽位：它没有自己的游戏来源，默认值就是对话框文字颜色） |
| `"default"` | **什么也没读到，用的是插件硬编码默认值** |
| `"unread"` | 脚本压根没读到 |

`"default"` 是关键词：以前这种情况和「游戏真的这么写」在清单上完全无法区分——一个
`"default"` 的 `dialogbox.textColor` 看起来和游戏自己写的值一模一样，Agent 没有理由去
修正它。实现是 `lib/manifest.js:1167` 的 `firstDefined(field, candidates, fallback)`：按优先级
取第一个非 `null`/`undefined` 的候选，把命中的 `source` 写进表里，全落空才记 `"default"`。

`"profile"` 是覆盖层改过的字段的来源：合并后这些路径的值已经不是扫描读到的那个了，
留成 `"style"` 或 `"default"` 会让 Agent 以为自己在看磁盘上的真相。它只出现在被
`profileApplied` 点名的路径上，其余路径仍是扫描来源。

### 取值优先级

对话框的取值是有顺序的，profile 覆盖层就是靠它决定「盖掉什么」：

- 文本/名字颜色、字号、几何：脚本里的 `screen say`（含内联属性）> `style say_dialogue` /
  `style window` > `gui.*` 变量 > 硬编码默认值。个别字段的层数更少：`dialogbox.nameColor`
  与 `nameSize` 没有 style 层（只有 `screen` 与 `gui-variable`），`dialogbox.height` 与
  `yalign` 没有 screen 层（只有 `style window` 的 `ysize`/`yalign` 与 `gui-variable`）。
- 字体：`screen say` 里的 `text what ... font` > `style say_dialogue font` >
  `gui.text_font` > `resolveFontPath()`（按声明再匹配一次 `manifest.fonts` 的 path 或
  basename）。
- 对话框贴图：`gui.textbox_image` 等变量 > `style window background` > `screen say` 里的
  `add`/`background` > 约定路径（`gui/textbox.png` 等）。
- 色板（`manifest.palette` 的八个槽位）：设置页的 `paletteOverrides`（`sources` 记
  `settings`）> `screen` / `style` / `gui.*` 候选 > 底板（失败再名字框）采样，仅当
  `sources["theme.accent"] === "default"` 时发生，记 `image-sample`；`hover` 与
  `nameColor` 各自也是 `default` 时才跟随采样色 > 硬编码默认值。`uiText` 是个例外：
  它没有自己的游戏来源，未覆盖时就是**不被 `text` 覆盖影响**的对话文字色（记
  `dialogue-text`），所以钉住 `text` 只改文本框、钉住 `uiText` 只改界面。`theme`
  的 token 由 accent 重新派生，所以在设置页改色后必须重建清单，界面才会跟着换。

CSE 就是「脚本重写了整个 `screen say`」的例子：它把所有值放在 `newScreens.rpy` 的屏幕体
里，只看 `gui/options/screens.rpy` 三个文件会一个都读不到。所以 `style` 块与 `screen`
块的扫描范围是**全部脚本**，不是那三个文件（`gui.*` 赋值仍然只从 `gui|options|screens`
三个文件读）。

屏幕体里给的坐标是**屏幕绝对坐标**，而清单里的 `layout.dialogueYpos`/`nameYpos` 是相对
对话框顶部的偏移：插件负责换算 `y − (screenHeight − textboxHeight) * textboxYalign`，
不要让 Agent 自己算。

### 脚本发现与反编译（`scripts`）

`scripts` 记录脚本发现与反编译的诊断，形状：

```ts
{
  found: { looseRpy, looseRpyc, archivedRpy, archivedRpyc, total },
  decompiled, attempted, skippedByCap, unreadable,
  reason: string | null,
  tool: {
    python: { path, checked, reason },
    unrpyc: { path, tried, toolsDir, reason },
    reason, usable, install
  }
}
```

`reason` 为 `null` 表示正常；否则是一句人话，例如
`"no .rpy or .rpyc scripts were found loose or inside the archives"`，或者「每个候选都
读不出来/反编译失败」。`found` 分开计松散目录与归档里的 `.rpy`/`.rpyc`——后者在归档里，
看不见。`skippedByCap` 是被 `MAX_DECOMPILED_SCRIPTS` 截掉的候选数，`unreadable` 是读都
读不到的候选数。

`tool` 是 `rpycDiagnostics()`（`lib/rpyc.js:416`）的结果：`python.path` 与 `checked`
说明试过哪些解释器，`unrpyc.path`/`tried`/`toolsDir` 说明找过哪些位置，`install` 里有
可复制的下载/解压指令（unrpyc 不在 PyPI 上，需要 Python ≥3.9；也可以用
`DSH_RENPY_UNRPYC` / `DSH_RENPY_TOOLS` / `vendor/unrpyc/unrpyc.py`）。任何失败都降级为
`null` 或空映射，绝不抛出——没有 Python 或 unrpyc 的机器仍然要能发现其他资源。
清单里的 `tool` 不会缺，也不取决于本轮有没有反编译成功：`readScriptSources()` 先写
`null`，`buildManifest()` 随后无条件用 `safeRpycDiagnostics()`（`lib/manifest.js:2110`）
补上，连诊断自身的失败也变成 `{ reason }`。这是刻意的——`attempted`/`decompiled` 回答
「这一次跑通了吗」，`tool` 回答「工具到底在不在这台机器上」；把两者合成一个字段，就
分不清「游戏没有脚本」与「装了 `unrpyc` 才读得到」。批量反编译自己的 `reason`/计数
不会再单独出现在 `tool` 里，它们已经并入上面的 `attempted`/`decompiled`/`reason`。

**要点：装了 unrpyc 和没装，清单里的值会不一样，而 `scripts` 是唯一能看出来区别的地方。**
`decompiled` 是清单真正解析到文本的脚本数（含松散的 `.rpy`），`found.total` 是看到的
候选数；前者小于后者说明有候选没读到或没能反编译，那些脚本里的值只能是默认值，即
`sources` 里的那些 `"default"`。

### 角色声明（`characters`）

`characters` 来自脚本的 `define qc = Character('启诚', color="#624B34", image="qc")` 这类
声明（`readCharacterDeclarations()`，`lib/renpy.js:786`），形状
`{ "<变量名>": { "name", "color", "image", "spriteTagUnresolved" } }`。`image=` 指向的 tag
在立绘索引里不存在时 `spriteTagUnresolved: true`。

**注意与 `tags` 区分**：`tags` 是扫描出来的立绘桶（`{tag,total,attributes,expressions}`），
`characters` 是游戏自己声明的角色；两者可能对不上（CSE 的 `image="qc"` 对应目录其实是
`images/qicheng/`，于是 `spriteTagUnresolved: true`）。无前缀的 `define`/`default` 也会被读，
`Character(...)` 的 `color=`/`image=` 关键字参数都会收，第一个裸参数是显示名。
只认名字以 `Character` 结尾的构造器（`Character`、`DynamicCharacter`、`NVLCharacter`
等），否则每个模板的存读档界面里那句
`default page_name_value = FilePageNameInputValue(...)` 都会被当成一个角色。

### 主题 token（`theme`）

`theme` 会发出 **10** 个别名 token，以 light+dark 成对形式，全部派生自色板的 accent
（可能来自游戏的 `gui.accent_color`、设置页的 `paletteOverrides`，或从对话框底板采样的
`image-sample`）：
`--dsw-alias-brand-primary`、`--dsw-alias-label-primary`、
`--dsw-alias-label-secondary`、`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、
`--dsw-alias-bg-layer-2`、`--dsw-alias-bg-overlay`、`--dsw-alias-border-l1`、
`--dsw-alias-border-l2`、`--dsw-specific-sidebar-fill`。

清单里另有一份 `palette`，把八个槽位（`accent`、`hover`、`idle`、`text`、`uiText`、
`name`、`choiceIdle`、`choiceHover`）连同各自的来源列出来，设置页据此逐项显示与覆盖。
`--dsw-alias-label-primary`（界面文字）取 `uiText`：未覆盖时暗色主题用游戏的对话文字
色、浅色主题仍由 accent 派生（没有一个游戏颜色能同时表达「白底上可读」），被覆盖时
两种主题都用用户选的颜色。改色后必须重建清单：token 是由 accent 重新派生的，旧清单
描述的是被换掉的那个色板。

### 音频、播放列表与开场

音频和视频**与图像分开**索引（`lib/renpy.js` 的
`AUDIO_EXTENSIONS` / `VIDEO_EXTENSIONS`，由 `lib/manifest.js:600` 的 `mediaKind()`
分类）。
两者都不是可显示对象，但都必须能在 `.rpa` 归档内被发现，
因此它们复用与背景相同的遍历——这就是索引由格式驱动而非由图像驱动的原因。

`audio.playlist` 是 `game/audio/music/` 下的所有音频文件，回退顺序为
`game/audio/sound/`，然后 `game/audio/`，然后整个游戏目录——第一个能匹配到
任何内容的前缀胜出，因此音乐放在常规文件夹之外的游戏仍能获得播放列表。
时长 **≤ 10 s** 的曲目会被丢弃：音乐文件夹通常也存放提示音和一次性音效。时长
来自 `lib/audio.js` 的 `readAudioDuration(head, tail, size, ext)`，
它读取文件的头尾各 64 KiB；无法读取或未知的时长会被**保留**，绝不丢弃。
该读取器是过滤器，不是展示值——其无 tag 的 VBR MP3 分支只是估算，绝不能
呈现给用户。

`audio.menuMusic` 解析 `config.main_menu_music`，真实游戏把它写成
**函数调用**（`init python: def main_menu_music(): if persistent.theme ==
'…': return audio.ourfirststep` …… 然后 `config.main_menu_music =
main_menu_music()`）。解析顺序：用户的 `menuMusicTrack`，然后是函数的
默认分支，然后是所有其他分支。`audio.<name>` 别名表
（`define -500 audio.x = "audio/music/x.mp3"`，`define` 与名称之间可选一个优先级 token）
会被读入同一张表。被播放列表过滤器丢弃的曲目仍会作为菜单音乐提供（`inPlaylist: false`）——
那是游戏在声明其标题画面播放什么。

`splash` 仅从 `label splashscreen:` 中提取：它播放的影片
（`renpy.movie_cutscene(...)`）优先于它展示的最大全屏静帧，
后者又优先于 `presplash.png`。`kind: "video"` 会被解析出来，但**由客户端扣住
直到浏览器能播放它**，因此无法播放的编解码器会降级为静帧列表，
而不是黑屏。

**静帧必须有 `duration`。** `<img>` 永远不会触发 `ended`，所以没有
时限的静帧就是永远不消失的开场——即“卡在 splash 不回到主界面”
的症状。`splash.timers` 收集标签及其 `call screen` 链上的每一个
`timer <n>`，`splash.duration` 取其中最长的一个并钳制在 2–12 秒；
游戏若从未声明，回退为 4 秒。这些值随清单一起传出，
客户端据此丢弃一个游戏自己不会关闭的静帧。

### 可接受的 Ren'Py 语法子集

| 语句 | 语法 |
| --- | --- |
| `scene` | `scene <bg> [with <t>] [if <v> <op> <val>]` |
| `show` | `show <image...> [at <t>, <t>] [as <tag>] [behind <tag>] [zorder <int>] [with <t>] [if ...]` |
| `hide` | `hide <tag> [with <t>]` |
| `with` | `with <t>` |

- 转场：仅 `dissolve`、`fade`、`none`。
- `at`：内置变换（`left`、`center`、`truecenter`、`right`、`topleft`、
  `top`、`topright`、`bottomleft`、`bottom`、`bottomright`、`centerleft`、
  `centerright`、`offscreenleft`、`offscreenright`），游戏的 `transform` 块，或
  内联的 `Transform(key=value, ...)`。
- `if` 需要一个**比较运算符**——`if persistent.seen == True`。裸的真值
  测试会被拒绝，因为舞台不评估表达式。
- 图像名**仅按空白字符**切分。短横线和下划线是
  文件名的一部分，绝不是属性分隔符。

舞台不接受的语句会被拒绝，并附带可接受的集合——
正是这一契约让模型能在一轮内自我纠正。
