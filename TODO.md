# 待办事项

按最能解除阻塞的顺序排列。`[ ]` = 未开始，`[~]` = 进行中。

## P0 — 阻塞激活

- [x] **安装到当前激活的配置档 (profile) 中。** 完成于 2026-10-13 ——
      `dsh-renpy-skin: link:E:/ProjectFiles/dsh-renpy-skin` 已写入桌面端
      配置档的 `package.json`，列在 `dsh.profile.bundles` 里，并已符号链接
      到其 `node_modules`。这些路由 (route) 在运行中的宿主 (host) 上可以响应
      （`GET /renpy-skin/manifest` → 200）。见 [STATUS.md](STATUS.md)。

## P0.5 — 宿主重启（已完成）

- [x] **重启宿主以加载当前 `lib/`。** 2026-10-14 已完成：桌面宿主带着
      `--remote-debugging-port=9222` 重启（见
      [tools/launch-dsh-debug.cmd](tools/launch-dsh-debug.cmd)），
      `GET /renpy-skin/manifest` 随后返回带 `audio` 与 `splash` 的新形态。
      页眉图标、两个面板、播放列表、设置深链与开场图层都是在这一轮里
      第一次被实机看到的。
- [x] **CDP 端口已重新绑定。** 2026-10-14 19:06 的重启成功抢到 9222：
      `DevToolsActivePort` 改写为 19:06:29，`http://127.0.0.1:9222/json/list`
      列得出页面目标。P1.5 的三项修复因此得以用 CDP 复查。

## P0.6 — Agent 加载链路重构（2026-10-17 调查，2026-10-18 执行）

**背景（已核实）**：2026-10-16 的会话
`session-0a77af4b-8ba7-4a91-9545-1dfa7b1881e0` 使用 `standard` preset，
请求里 47 个工具，没有 `renpy_*`；31 个 step 全部只有 reasoning，最后
`max-tokens`。会话 cwd 也不是 VN 配置目录。结论：当前不是“提示词少写一句”，
而是工具注册、客户端服务、工作区/预设三条链路都可能断了。本节任务取代
「审计遗留」第 226-230、239-244 条的待验证描述；实现后一并勾掉。

- [x] **0. 先复现，不要先改。** 三项都在同一条链路上就地确认了：
      - `renpy_*` 确实一个都没注册——**我自己的这条会话里也一样**（用户当场指出
        工具表里没有它们），说明不是那个会话独有的问题；
      - `systemPrompt` 同理：`lib/index.js:590` 与 `:624` 用的是同一个
        `ctx.get` + 守卫模式，守卫静默跳过注册时没有任何日志；
      - 「切预设」这一步**不存在可行 API**：宿主端 `agentPresets` 只有
        `resolve(id)` 与 `mount(agentCtx, id)`，且只在**创建** Agent 时通过
        `CreateAgentOptions.meta.agentPreset` 生效；`agents.create(...)` 建出来的
        会话不进入 Shell 的会话列表，用户看不见。客户端 `remote.session` 只有
        `canOpenWorkspacePath` / `workspacePathApplications` / `openWorkspacePath`，
        没有任何 preset 方法。**因此放弃切预设**（用户拍板）：`renpy_*` 工具本来就是
        全局注册的，persona 由用户自己在 composer 里选。

- [x] **1. 宿主端改为等待 `tools` / `systemPrompt`。**
      `lib/index.js` 的 `ctx.get("systemPrompt")` 与 `ctx.get("tools")` 都改成
      `ctx.inject([...], (scoped) => ...)`，注册仍各自包在 `ctx.effect(...)` 里
      （用 **scoped** 的 effect，随服务一起销毁）。顶层 `inject = []` 不变：
      缺少服务的配置档仍要能加载 HTTP 路由。`webServer` 早在 2026-10-13 就是
      这个写法，注释里还写着「两者不同时刻解析，因此工作正常」——那句话是错的，
      三处有同一种失败模式。

- [x] **2. 客户端服务改为显式等待，禁止静默剪贴板兜底。**
      `apply` 里新增 `ctx.inject(["uiWorkspace","sessions"], ...)` 保存作用域服务，
      `workspaces` 用第二次 `ctx.inject` 补上。`loadWithAgent` 失败**一律 abort**
      并抛出具原因的错误；`onFailure` 参数与整块 `navigator.clipboard.writeText`
      兜底已删除。剪贴板只剩 `copyAgentPrompt()`，由失败后面板上的「复制提示词」
      按钮显式触发。

- [x] **3. 按钮流程改成“准备 → 开会话 → 投递”（切预设已放弃）。**
      新增 `POST /renpy-skin/agent/prepare`（入参 `{ session?, gameDir? }`）：
      校验存在 → 是目录 → 能扫出清单 → 读到游戏名 → **扫到 `.rpy`/`.rpyc`
      或 `.rpa`**（只看目录是否存在会被任意空文件夹骗过：扫描器对任何目录都成功，
      并把目录名当游戏名；脚本可能全在归档里，所以两者都为 0 才算不是）→ 持久化
      `gameDir` + 清会话状态 + 把会话钉到这个游戏 → 生成两棵树 → 返回
      `{ gameDir, root, profileDir, name, paths, stats }`。
      **顺序上的坑**：必须先持久化并 `forgetSessionState()`，**再**
      `sessionGames.set()`——前者会清空 `sessionGames`，先 pin 就会被丢掉。
      按钮拿到响应后：`workspaces.create({path: profileDir})` → `startSession` →
      等新会话 id → `session.prompt(...)`；任何一步失败都 abort 并显示原因。

- [x] **4. 注入真实路径并精简提示词。**
      `agentLoadPrompt(facts)` 接收 `prepare` 的返回，除语言之外再追加一段事实块
      （游戏名、游戏目录、配置目录、两棵树路径、各类文件计数、是否被截断）。
      已准备时开头明说「游戏已由宿主加载，没有路径要问」；**没准备时用另一套措辞**
      （先问目录、再用 `renpy_configure`），否则会把模型指向宿主从未加载过的清单。
      工具说明压到一两句，schema 交给工具自己。`renpy_configure` 只用于以后换游戏。

- [x] **5. 目录树两层：紧凑树进上下文，完整树落盘。**
      `lib/scantree.js`：`scan-tree.md` ≤400 行 / 约 12 KB（硬预算，按优先级分节，
      装不下时逐块截断并在文件里写明剪到哪一行、完整清单在哪个文件）；
      `scan-tree.full.txt` 完整遍历，上限 20000 条，超了写明 `[truncated]`；
      `.rpa` 只展开第一层并按顶层目录计数；跳过 `cache`、`saves`、`tl`、
      `__pycache__`、`.git`、`renpy`。扩展名集合直接从 `lib/renpy.js` 导入，
      不重复定义。真实游戏实测：2151 文件 → compact 184 行 / 5297 字节。

- [x] **6. 存储根适配 `DSH_HOME`。**
      新增 `lib/home.js`：`DSH_RENPY_SKIN_HOME` > `$DSH_HOME/renpy-skin` >
      `~/.dsh-renpy-skin`，空白视为未设置；`lib/index.js` 里三处重复的路径表达式
      合并成一处。旧位置在首次解析到新位置时**复制**一次（`config.json`、
      `library.json`、`game/`，只复制不删）。不按 `DSH_PROFILE` 隔离（游戏库全局共享）。

- [x] **7. 验收与测试。**
      - [x] `node --check lib/index.js`、`node --check lib/client.js` 通过；
      - [x] `node --test "test/*.test.mjs"` = 205 tests / 199 pass / 0 fail / 6 skipped；
      - [x] 新增回归：`apply` 按 `systemPrompt`/`tools`/`webServer` 顺序等待且三处
            各只注册一次；`lib/home.js` 的优先级与迁移；`scantree` 的预算截断与归档
            聚合；`/agent/prepare` 三条（写两棵树 / 加载被指定的游戏而不是已设的 /
            拒绝时不留下半成品）；提示词两种形态；`prepareGame` 两种请求体；
            abort 时剪贴板没有被写。
      - [x] **实机（CDP）已做**，2026-10-19 02:02–02:06。没有杀掉桌面宿主：
            另起了一个一次性配置档 `verify`（`--from-default-profile web` + `plugin add
            link:E:/ProjectFiles/dsh-renpy-skin`），`dsh --profile verify --port 19487
            --no-open` 跑同一份 `lib/`。`dsh web` 把带 token 的 URL 打印到 stdout
            （`Start-Process -RedirectStandardOutput` 即可读到），所以 SPA 也能开。
            `node tools/verify-agent-load.mjs --port 19487` = 10/10 PASS；
            浏览器里点「用 Agent 加载」后新会话：
            `cwd` = `C:\Users\<user>\.dsh\renpy-skin\game\Remember the Flowers 0.17.9P`，
            `request/header` = **30 tools，其中 `renpy_*` 4 个**，
            `system/message` 里带 `## Ren'Py stage director` 段（即 `systemPrompt`
            注册也被这次实机证实），user message 与 `agentLoadPrompt(facts)` 逐字一致，
            Agent 依次调用 `renpy_read_manifest` → 读两份清单 → `renpy_save_vn`，
            写出 `tree.md` / `summary.md` / `vn.json`，`turn/end` = `{kind:"completed"}`。
            **本次顺带确认的坑**：桌面宿主用的 `buddy` provider 只由 Electron 应用注册，
            配置档里没有；`dsh-our-free-model` 的免费车道从本机出口 IP 一律回
            `INVALID_CREDENTIAL`；第三方网关会**预扣**整个 `maxTokens` 额度，
            `defaultMaxTokens: 131072` 在余额不足时直接 403 —— 验收用 8192 即可。
            `tools/launch-dsh-debug.cmd` 的 `taskkill /IM "DeepSeek Harness.exe" /T /F`
            仍然只能由人手动运行（它会杀掉发起它的进程树）。

- [x] **8. 文档同步。**
      `docs/CONTRACTS.md`（三处 `ctx.inject`、客户端服务与 `/agent/prepare`、两层目录树、
      存储根优先级）、`docs/ARCHITECTURE.md`（准备/扫描流程与新的不变式）、
      `docs/STATUS.md`（第四个根因修复、已验证/未验证两节）、`CHANGELOG.md`、
      本文件已同步。全部中文。

## P0.7 — 全归档游戏的 `/agent/prepare` 崩溃（2026-10-19 修复，待重启复验）

- [x] **已定位并修复。** 2026-10-19 21:49 用真实渲染的 CSE 复现：开着 CSE 时
      `POST /renpy-skin/agent/prepare` 回 400，正文
      `TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Array`。
      根因是 `lib/scantree.js:380-386` 的 `scripts.length === 0 ? [...] : []`
      在归档分支又多套了一层数组，于是 `blocks[].lines` 里留下嵌套数组，
      `renderUnderBudget()` 用 `Buffer.byteLength(line, "utf8")` 量字节时抛错。
      这个分支只在「没有松散脚本、脚本全在 `.rpa` 里」的游戏上走到——正是 CSE 这类
      商业发行版，也是 `docs/questions/` 里那七篇记录的全部前提。
- [x] **回归测试已加。** `test/scantree.test.mjs` 的
      `a game whose scripts all live inside an archive still produces a map`
      用真实 RPA-3.0 归档（索引取自 `test/fixtures/rpa-indexes.json` 的 `simple`）
      搭一个只有 `scripts.rpa` 的游戏，断言 `stats.scripts === 0`、
      `stats.archiveEntries.scripts > 0`，且紧凑地图里出现
      `no loose scripts; N compiled scripts live inside the archives`。
      原有用例都带松散 `.rpy`，所以单测全绿而实机崩溃。
- [ ] **待用户重启宿主后复验。** 正在运行的宿主（2026-10-19 21:13 启动）内存里
      还是旧 `lib/scantree.js`，`node tools/verify-agent-load.mjs --port 27194`
      仍会在第 3 项回 400。重启后再跑一次，期望
      `POST /renpy-skin/agent/prepare` → 200 且 `dirs[0].tree` 里有
      `## scripts and config (0 loose)` 段。
      注意：`--port` 必须用当前 GUI 的端口，宿主每次重启都会换。

## 第八轮用户任务（名字/额外要求/记忆 + 文本框模块化 + 多对话框选择）

用户一次提出三件事（2026-10-19），已批准的范围与顺序如下。

- [x] **1. 全局名字、会话级名字覆盖、只给「在场」的额外要求，以及按角色分开的跨会话记忆。**
      设置新增 `playerName` / `sessionNames` / `roleplayPrompt`；宿主新增只对预置
      `renpy-scene` 生效的提示词段 `renpy-skin:roleplay`（`presetOfSession()` 优先读
      `assembly.scope.header.agentPreset`，回退到 `session/event` 缓存）；
      `lib/memory.js` 把记忆存成 `game/<扫描名>/memory.json`（纯 tag → 文本，
      单角色 8000 字符上限、注入只带最近 1200 字符 × 最多 12 个角色）；
      新增 `renpy_memory` 工具与 `GET/POST /renpy-skin/memory` 路由；
      设置页新增「Roleplay 「在场」」卡片，顶栏新增笔记本按钮与记忆面板。
      模型主动记与用户手动记写的是同一份文件。测试 253 项 / 246 通过 / 7 跳过。
- [x] **2. 文本框模块化。** 清单新增 `dialogbox.modules`：扫描器把游戏自己的
      `say` 屏翻译成扁平节点表（`box` / `image` / `text` / `button` / `bar`，画布像素
      `rect` + `z`），底板之外的 `add`/`background` → 装饰图、`layout.name*` → 名字框、
      `quick_menu` 里动作在白名单（`settings` / `music` / `memory` / `hide` / `skip`）
      的按钮 → 可点按钮，其余按钮只进只读的 `quickMenu` 报告。客户端 `ModulesLayer`
      （`shell.overlay`，order −890）每 400 ms 量 composer 根元素，用与
      `dialogboxRules()` 共用的 `composerGeometry()` 把画布坐标换成 `cqw`，只有白名单
      按钮恢复 `pointer-events`；`dialogboxModules` 是总开关。`renpy_save_vn` 接受
      `dialogbox.modules` 并整体替换扫描结果（逐节点校验，上限 40，`[]` 清空），
      `rederiveAssets()` 为 `image`/`hover.image` 派生 `imageUrl`。切游戏时清单重建，
      模块层随 store 一起换掉，不需要重载页面。
- [x] **3. 多个对话框候选的选择器。** 一个 VN 有多张 textbox 时，清单给出
      `dialogbox.candidates`（显式 `gui` 变量 → `window` 样式 → `say` 屏的
      `add`/`background` → 常规路径 → 全库扫描兜底，排除手机/平板与 namebox，
      上限 12 张；`candidates[0]` 恒等于当前所用的 `textboxPath`，由
      `rederiveAssets()` 在覆盖层换盘后重排保证），设置页用缩略图选择器
      （`PlatePicker`，候选 ≥ 2 时才出现）选，选中即 `POST /renpy-skin/dialogbox`
      写进该游戏档案并重建清单；Agent 也能在清单摘要的 `plates` 里看到候选、
      把路径写进 `dialogbox.textboxImage` 再用 `renpy_save_vn` 切换。
      测试 253 项 / 246 通过 / 7 跳过。

## P1 — 浏览器端 (browser half) 实机验证

以下各项均已在真实 GUI 中确认（2026-10-14，记住是 CDP 驱动 + 截图双重确认）：

- [x] 背景图层 (layer) 在对话背后渲染游戏背景。
- [x] 舞台 (stage) 图层在 `renpy_stage` 报告的位置渲染立绘 (sprite)。
- [x] 900 ms 轮询确实能捕获宿主驱动的舞台变化。
- [x] `theme.overrideTokens` 能生效，并在禁用时干净地回退。
- [x] 设置页面能往返：修改 `gameDir`，确认其持久化且清单 (manifest) 重新加载。
- [x] 对话框 (dialogue box) / 选项菜单 (choice menu) 的 CSS 皮肤
      (`buildSkinCss`) 应用于用户气泡、输入框和问题卡片。
- [x] **页眉条**：Ren'Py 标记和音符出现在
      `.Dc7zOa_headerUtilities` 中，且面板 (panel) 的控件可点击。
- [x] **开场 (splash) 图层**：在 Remember the Flowers 上确认 —— `kind: "video"`，
      全帧绘制，`videoTime` 推进，跳过提示可见。GTST 的
      开场是三屏文本 + imagebutton，其中只有美术资源 (asset) 被提取 —— 请确认
      未被提取的屏幕是直接缺席，而不是显示空白帧。
- [x] **主菜单音乐**：GTST 将
      `config.main_menu_music` 解析为
      `audio.gotosnowtown`（主题 序章）/ `audio.ourfirststep`（硫石篇）。默认
      分支会播放，且下拉列表列出另一项。
- [x] **音频**：`<audio>` 拖动定位。`/renpy-skin/asset` 返回 `206`。
- [x] **播放列表 (playlist)**：曲目可点击播放，长列表独立滚动。
- [x] **设置深链 (deep-link)**：“打开完整设置页”落在 Settings → Ren'Py skin。

## P1.5 — 仅在实机上发现、已修复并复查（2026-10-14 19:06 重启后）

CDP 端口重新绑定后，下面三项都用实机 DOM 复查过：

- [x] **Ogg 时长显示 `--:--`。** 根因：DSH 的 `dsh-app://` 协议处理器会剥掉
      `content-length`，而 Ogg 头里没有时长，Chromium 只能用总字节数推算，
      于是 `duration` 变成 `Infinity`。修复 = `resolvedDuration()` 在
      `element.duration` 非有限时回退到清单里 `lib/audio.js` 量出的时长。
      **实机确认**：播放列表首曲显示 `1:06 / 2:37`，拖动条
      `max="157.6"`；点第一首后变成 `0:04 / 0:52`、`max="52.4"` 且
      `value=4` 随时间推进 —— 不再出现 `--:--`。
- [x] **主菜单曲目对不上播放列表。** 根因：游戏把自己的
      `config.main_menu_music` 写成小写（`audio/music/motion.ogg`），磁盘上是
      `Motion.ogg`，而查找是大小写敏感的。修复 = `byPath` 折叠大小写，并补了
      一条回归测试。**实机确认**：Remember the Flowers 的
      `menuMusic[0].inPlaylist` 现在为 `true`，标题取自真实文件。
- [ ] **`playlistVolume` 曾被读回 `0`。** 观察到一次，未复现也未解释；
      设置项写入时被钳制在 `[0, 1]`，因此 0 是合法值而非越界。

## P1.6 — 实机验证中仍未覆盖的部分

- [ ] **文件选择导入/导出**（`<input type="file">` + Blob 下载）只经过
      `node --check` 与套件；浏览器端从未点过一次。
- [x] **进度拖动条**：实机确认总时长有限、`value` 随时间推进、无回跳
      （2026-10-14 19:06 重启后）。
- [x] **曲目筛选**：实机输入 `snow` 后列表从 36 首收敛到 1 首
      （`go to snowtown · 2:37`）。
- [x] **曲目按子目录分组**：分组表头只在多于一个目录时渲染；GTST（36 首）与
      Arches（70 首）都只有 `audio/music` 一个目录所以不显示表头，
      Remember the Flowers（112 首）有 `audio/music` 101 首 +
      `audio/music/extra` 11 首两个分组。`scrollIntoView` 未在长列表上单独复查。
- [x] **跨游戏切换的完整复位**（任务 2 的端到端复查）：把 Arches 加进库表后，
      切换过去再切回 GTST。全部派生表面都跟着换：库表从
      「已分析 1 个」变「已分析 2 个」、下拉框选项增加、统计行从
      `出发！去落雪镇 · 36 首` 变 `Arches v1.0 · 70 首`、播放列表内容
      从 GTST 曲目整体换成 Arches 曲目（`amygdala / arches / bridges`，70 首），
      且旧曲目不再残留（`stillShowsGtstTrack: false`）。切回后
      `/renpy-skin/library` 的 `gameDir` 与界面一致。
- [x] **输入区背景三态**均已实机读回计算样式：`default` 保留宿主渐变
      （`linear-gradient(... 36px)`）、`solid` 写
      `background: var(--dsw-alias-bg-base) !important` 解析为
      `rgb(0, 21, 29)`、`transparent` 为全透明。

## 第三轮用户任务（开场卡死 + 切换开关 + 渐入 + 门控服务查询）

- [x] **1. 切换游戏时的开场开关。** 「已分析的 VN」下方新增
      `splashOnSwitch` 复选框（默认**关闭**）。此前切换游戏复用的是启动那个闩锁，
      所以启动开关关掉时切换仍会重播开场——现在两个时刻各有一个开关。
- [x] **2. 开场卡死。** 根因：提取到的开场是**整屏静帧**时，
      `<img>` 永远不触发 `ended`，而该 label 本来靠屏幕内的计时器推进
      （GTST 的 `first_splash` 是纯文本声明页 + 3 秒 `timer`），
      于是图层一直盖在会话上面。修复分两半：宿主端 `collectSplash` 提取该 label
      及其引用屏幕里的 `timer N`，`splashSecondsFor` 取最长并钳制 2–12 秒
      （一个都没有则回退 4 秒）放进 `splash.duration`；客户端到点自动关闭，
      用户仍可点击跳过（video 另有 180 秒兜底，防止文件损坏时永久黑屏）。
      docs/CONTRACTS.md 与 CHANGELOG.md 已记录。
- [x] **3. 回到主界面的渐入。** `.rsk-splash[data-fading="true"]` 淡出
      （420 ms），主界面同时用 `@keyframes rsk-main-fade` 从不透明度低值渐入，
      纯 CSS、不新增设置项。
- [x] **4. 门控服务查询。** 用户贴出的实机报错
      `cannot get property "locale" without inject` 是**真缺陷**：
      Cordis 上下文对自己未注入的属性名是**抛错**而非返回 `undefined`，
      所以 `ctx.get("locale")` 本身也可能抛。新增 `localeServiceOf(ctx)`
      双重 try/catch（先 `ctx.get`，再 `ctx.locale`），
      `attachLocale` 与 `service.register` 也各自包了 try/catch。
      **不能**把 `locale` 加进 `exports.inject`——那会把它变成必需服务，
      缺少它的配置档会整个拒绝加载皮肤。`test/client.test.mjs` 新增两个测试
      钉住这一契约（受门控查询必须被捕获，且不得被当成失败上报）。

## 第四轮用户任务（按钮归位 + 快捷设置瘦身 + 开场媒体选择器）

- [x] **1. 把「加载」和「重读这个游戏」放到一起。** 两者原本分处两张卡片，
      看着像两件事；现在完整设置页的目录行是 `[输入框] [加载] [重读这个游戏]`，
      重读按钮从「已分析的 VN」那一行移除。两个按钮共用一个忙碌态
      （`busy === "load" | "reread"`），不再同时显示两个「Loading…」。
- [x] **2. 快捷设置里去掉三项，只在设置页出现。** 「重读这个游戏」、整个
      「添加游戏目录」表单、以及语言行都从快捷设置弹层移除（`SkinSwitches`
      新增 `showLanguage` 门控）。弹层仍与设置页共用同一批组件，
      因此开关不会两边走样。
- [x] **3. 开场媒体改为点击选择文件。** 原来是一个要手打游戏相对路径的输入框；
      现在是「选择文件…」按钮 + 选择器：列出当前游戏自带的图片与视频
      （视频在前），带搜索框，选中后显示「已选择: <路径>」并可用「清除」复位。
      数据来自新增的 `GET /renpy-skin/media`（`listGameMedia`，走同一个资源索引，
      所以 `.rpa` 内的条目也在列表里）。列表按解析出的 `gameDir` 缓存，
      切换游戏与重读磁盘都会清空；回归测试在 `test/skin.test.mjs`
      （含「重读后必须能看到新放进游戏的文件」这一条，去掉 `mediaCache.clear()`
      即失败）。
- [x] **4. 音乐播放列表面板去掉「主菜单曲目」块。** 那块（曲目名 + 跟随开关 +
      试听按钮）与设置页的控件重复，弹层只该是播放器；开关与曲目选择仍在设置页。
      主菜单音乐默认开启，去掉试听按钮不影响自动播放。设置页曲目行在无候选曲目时
      的提示也一并纠正（原来说“解析到的曲目”，实际一个都没有）。
- [x] **5. 计数折行 + 音量显示百分比。** `.rsk-input` 的 `width: 100%` 使它的
      `flex-basis: auto` 吃掉整行，旁边的 `112 首` 被挤到折行；输入框改为
      `flex: 1 1 0%`，读数加 `.rsk-nowrap`（不收缩 / 不折行）。音量读数
      `0.55` → `55%`。
- [x] **6. 重载后两路音频叠加。** 单元素规则只在闭包内成立：重载后新闭包的
      `playerElement` 为空，上一份的元素还在播，第一次点击又起同一首 → 互相拍打。
      元素现在停在 `globalThis.__dshRenpySkinAudio`，模块求值时先拆掉上一份的，
      卸载时由 `ctx.effect` 清理函数释放。顺带修掉同类漏音：跳过开场后，**从文档中
      移除的 `<video>` 仍在播放**，片头曲会盖在主菜单音乐上——`dismiss()` 立即
      `pause()`，卸载 / 换源时再彻底拆掉。回归测试在 `test/client.test.mjs`
      （去掉模块求值处那一次 `retireStaleAudio()`，该测试即失败）。
- [x] **7.「背景压暗」改称「背景亮度」并按百分比显示。** 这个滑块以前显示压暗量
      （`0.50`）且向右拖是变**暗**，与「亮度」这个词相反；现在按亮度呈现，
      向右拖是变亮。控件走 0–100 的整数百分比（**不传 `step`**，range 输入默认步长
      就是 1，正好是 1% 粒度），写回的压暗量是 `(100 − v) / 100`，天然两位小数。
      存储键名与语义未动（CSS 渐变、0–1 钳制仍用压暗量），因为改键名会让调过滑块
      的人静默回到默认值。

## 第五轮用户任务（新会话页眉按钮 + 滑块去 step）

- [x] **1. 新会话状态下右上角的两个按钮不见了。** 两个座位，两处原因。
      空白会话（新对话）里宿主把标题簇藏起来，`conversation.session.header.utilities`
      那一行因此失去唯一把它顶向右边的 `flex: 1` 兄弟，连宿主的按钮一起滑到页眉
      最左端——宿主只为自己的角按钮补了 `margin-left: auto`。现在只要页眉里没有
      `conversation.session.header.actions` 座位（宿主渲染标题簇时才会渲染它），
      这两个按钮就按有标题簇时的同一组偏移钉回右上角（`top: 11px; right: 48px`；
      两种状态下这组偏移一致，所以有会话时不会位移）。完全没有会话时
      （`sessionId === void 0`）宿主根本不渲染会话页眉、拿一个空 titleRow 顶替，
      `headerBlank` + `headerSessionless` 把内边距与最小高度一并清零，整条页眉
      高度为 0——所以同一组按钮还注册进平台文档写明「无会话时也可用」的
      `conversation.header.leading`，并把页眉高度还回 44px；两份拷贝由 CSS 保证
      屏幕上只有一份（两个座位同在 `<header>` 内，`:has(.rsk-head-primary)` 即可
      判断）。实机核验走 DSH 自带 CDP 端口 9222：活动会话里 primary 在位、
      fallback `display: none`；空白会话与无会话两种状态用真样式表 + 实机 DOM
      克隆量过，都是距页眉右缘 48px、距上缘 11px，且不越界。
- [x] **2. 数值滑块不再声明 `step`。** range 输入不写 `step` 时隐式步长是 1，
      因此把量纲换成整数、把分辨率放进刻度：播放列表音量 0–100 整数百分比
      （写回 `Math.round(v) / 100`），播放进度条 0.1 秒刻度
      （`Math.round(duration * 10)`，比旧 `step: 0.5` 更细），文字速度上限提到 400
      （与 `lib/index.js` 的钳制一致）。「舞台最多显示立绘数」同样不写 `step`：
      它只能用整数，隐式步长 1 正是想要的粒度。布局编辑器里 `type="number"`
      的数值输入不是滑块，±0.01 按钮随它保留。

## 第六轮用户任务（滑块拖动实时预览，并写进约定）

- [x] **1. 滑块的值先变、松手才保存；不卡顿的效果要跟着实时变。** `SliderRow` 原本
      拖动中只改本地草稿，效果要等松手才出现（拖动亮度时画面不变暗、拖音量时听不出
      变化）。现在它多接一个可选的 `onPreview`：每一步 `input` 都调用它（不落盘），
      而落盘仍由 `onChange` 在 `pointerup` / `pointercancel` / `keyup` / `blur` 时
      做一次。背景亮度、播放列表音量（两处，统一走新抽出的 `applyVolume`）、舞台
      立绘上限都接了 `onPreview`；它们的效果都从 `state.settings` 读，所以
      `previewSettings(patch)` 乐观并进 store 就等于「当场生效」。播放进度条是
      会卡顿的那一档（每个 `input` 都 seek 会打断播放），保持拖动只动数字。
      预览期间 `previewPatch` 挡住 `pollStage` 的 settings 回显，否则宿主 900ms
      前的旧值会把控件拽回去；`saveSettings` 在 `finally` 里清标记，POST 失败也不会
      永久卡住轮询。这条约定已写进 `AGENTS.md` 的新章节「滑块与数值控件」。
      实机复验（CDP 9222 上驱动真滑块、并给 `fetch` 打桩数 POST）：背景亮度拖动
      45%→30% 时背景当场变暗、**0 个 POST**，松手恰好 1 个 POST；音量 35%→55% 时
      共享 `<audio>` 的 `volume` 当场变 0.55、0 个 POST，松手 1 个；立绘上限 4→5
      同样 0/1；拖出去再拖回起点的手势 0 个 POST，而随后从宿主侧改写
      `backgroundDim` 仍能被 900ms 轮询拉回来（说明 `endPreview()` 确实清了标记）。
      三轮都把值改回原样，配置档没被留下修改。第一版曾在「值变没变」的比较上
      走了捷径（拿当前 `value` 比，而预览已经把 `value` 写成了草稿），结果是拖动与
      松手都 0 个 POST、配置永不被写；基线改为手势起点的值后修好。
- [x] **2. `textAnimation` / `textCps` 已实现（见 CHANGELOG 与 STATUS 的「打字机文本」；以下为当时的发现记录）。**
      两个键都在 `lib/index.js` 的 `DEFAULT_SETTINGS` 里、都有钳制、都出现在设置页
      （`lib/client.js` 的「文字动画」开关与「文字速度（字符/秒）」滑块）、也写在
      `docs/CONTRACTS.md:126-127`，但**全仓库没有任何代码读它们**——客户端既没有
      逐字显示的实现（没有 `requestAnimationFrame`、没有按字符切分的渲染），也没有
      解析 `{w=}` / `{p}` / `{cps=}` / `{fast}` 这些注入提示词里承诺过的 Ren'Py 文本
      标签。也就是说「打字机动画」这条功能目前只有开关没有实现（见
      `lib/index.js:1376-1377` 的提示词承诺）。2026-10-14 问过用户，答复是「没事了」
      ——即这条不是他说的「继续没完成的」那件事，先按原样留着：**开关照旧无效，
      提示词照旧承诺解析不了的标签**，哪天要做再从这里接手。

## 审计遗留（VN 读取）

- [x] **「用 Agent 加载」已实现。** 新建会话 + 投递提示词（`uiWorkspace.startSession`
      加 `sessions.binding(id).session.prompt`），失败降级为复制到剪贴板。
      按钮与「重读这个游戏」并排在游戏信息行。见 docs/CONTRACTS.md。

- [x] **Agent 写 VN 配置文件（`renpy_save_vn` + `GET /renpy-skin/vn`）。**
      提示词要求 Agent 扫描 `game/` 目录树、写成配置文件，插件下次自己加载它。
      配置文件是**扫描结果的覆盖层**，落在数据目录的 `game/<VN 名>/`。工具与路由
      有回归测试（`test/skin.test.mjs`、`test/vn.test.mjs`）。见 docs/CONTRACTS.md。
- [ ] **「用 Agent 加载」建工作区的路径还没实机验证。** `workspaces.create({path})`
      的返回 id 字段（`view?.id ?? view?.workspaceId`）与「目录还没被建出来时它是否接受」
      只在无头测试里走过；需要在真实宿主里点一次按钮，确认新会话的工作区确实是
      `game/<VN 名>/` 而不是它之前的目录。宿主重启后才能验。失败已不再连坐整条流程
      （只记一条 `console.warn`，会话照开）。
- [x] **Agent 这条链路读不到插件的扫描结果。已修：新增只读工具
      `renpy_read_manifest`。** 无参，返回本次扫描真正读到的值——画布、对话框与
      其几何、选项按钮、颜色、字体、角色名册、变换、背景，外加
      `profile.applied`/`profile.rejected`——形状与 `renpy_save_vn` 的 `config`
      一致，以 JSON 代码块呈现，便于直接拷回去修正。`renpy_configure` 的描述也从
      「读不回」改成指向这个工具；`AGENT_LOAD_PROMPT` 与 persona 同步改成
      「先读 → 再改 → 再写」。（用户当时二选一：加工具，或把提示词改成「让插件读、
      Agent 只做判断」；选了加工具。）走查 `game/` 目录树的要求保持不变。
- [ ] **Agent 自己的文件工具能不能走查游戏目录未验证。** 提示词让它走一遍 `game/`，
      但它的文件工具按设计被限制在它自己的工作区内，而工作区在数据目录里、游戏目录在
      工作区外；归档版游戏更是没有 `.rpy` 可读。这是这条链路最可能整体失效的地方
      （当前实机证据只到 Agent 反问游戏路径为止）。**现在有兜底**：
      `renpy_read_manifest` 让 Agent 直接读到扫描值，config 的修正不再依赖它能否
      自己翻文件；目录树本身则仍取决于这一步能否走通。
- [x] **Agent 写下来的东西没人读。已修。** `GET /renpy-skin/vn` 新增 `summary` 与
      `tree`（各截到 4000 字符的头部，缺失为 `null`），设置页新增只读卡片
      「Agent 写下的配置」：`savedAt`、`applied` 计数、`rejected` 冲突提示、
      `report.ignored` / `report.malformed`、`summary` 开头与配置目录路径。
      `vn.json` 现在把写回执里的 `report: { ignored, malformed }` 一并存下来，
      所以上次写到哪里、被丢了什么，离开那次会话也查得到。
      （`vn.json` 的 `transcript` 段仍未消费——它本来就是留给 UI 的占位，暂不处理。）
- [x] **「写完立刻重新换肤」目前不成立 → 现在由完成弹窗接手。** 点过
      「用 Agent 加载」且投递成功后，客户端每 3 秒读一次 `GET /renpy-skin/vn`
      （上限 10 分钟），`profile.savedAt` 变化就在 `shell.overlay` 最上层
      （order -860）弹模态：一句话 +「立即更换」（重拉清单，宿主在写入时已重建过
      缓存，所以这一次是缓存读）与「先保存」（留到下次加载；Esc、点遮罩等价）。
      用户当时的选择是「弹窗询问」而不是静默换肤，且弹窗只放一句话，明细在设置页。
- [x] **预设 persona 与按钮提示词是两份会漂移的真相。已修：流程单一承载。**
      `cordis.patch.yml` 的 persona 缩成身份 + 四个工具各一句 + 三条不矛盾的规则
      （不编造目录、遵守 skin 设置里的立绘上限、不做角色调研）；删掉了「只给名字就去
      常见位置搜」那一整套六步流程（它与 `AGENT_LOAD_PROMPT` 的「先问、不自己扫盘」
      正相反），也删掉了硬编码的「最多三个立绘」（改为引用设置）。
      persona 不再重复任何流程，按钮场景是否带上 preset 因此不再影响结果。
- [x] **`lib/vn.js` 里 `null` 的语义与注释不一致。已修。** 注释说 `null` 表示「保持扫描值」，
      实际 `profileOverlay` 会把 `null` 复制进 overlay、`applyProfile` 也照写，于是
      `null` 会真的把扫描值盖成空。现在 `null` 与 `undefined` 都跳过，与注释一致——
      这一条原本比注释更紧急：`renpy_read_manifest` 的输出正好是 `renpy_save_vn` 的
      输入形状，Agent 把回执拷回去会把缺省字段全清空。
- [x] **composer 模型选择器被收成图标已修复。** 根因：宿主的 `observeControlRow`
      用 `row.getBoundingClientRect().width` 判断放不放得下，而插件此前把按钮行也
      `display: contents` 融进卡片，宽度恒为 0，于是「放不下」永远成立。现在按钮行
      保留自己的盒子，卡片单独溶解；dock 改为绝对定位叠在按钮行中央，窄于 620px 时
      隐藏。已在活动会话里量过（行宽 1313px、`data-model-compact` 缺席）。
- [ ] **composer 新布局在窄窗口下的观感**只做过一次宽度测量；620px 断点两侧各看一次会更稳。

- [x] **新版 `.rpyc`（Ren'Py 8.5）读不到脚本。** 已把 unrpyc 更新到 2.0.4 以上，并按版本号取最新。
- [ ] `.rpi` 归档、RPA-3.2；小型装饰图混入立绘；`resolveKnownPath` 大小写；反编译超时后残留子进程；
      Castle&Myosotis 立绘为 0、Tavern_of_Spear 无主菜单音乐。

## P2 — 规范中尚未实现的功能

- [ ] **`.rpa` 写入器 / 重新打包。** 仅支持读取。
- [ ] **可拖拽立绘。** 位置仅由模型驱动；不支持手动拖拽。

## 第二轮用户任务（已分析 VN 的库 + 状态复位 + 退出静音 + 输入区背景）

- [x] **1. 把分析过的 VN 存成文件，并提供重读与下拉选择框。**
      `~/.dsh-renpy-skin/library.json` 保存 `gameDir`/`name`/`stats`/`savedAt`，
      最新的在前，上限 50 条。`GET /renpy-skin/library` 返回该表；
      `POST /renpy-skin/library` 是**唯一**的切换入口：它持久化 `gameDir`、
      清空该会话的固定指向、丢弃所有按游戏缓存的清单与归档句柄、重建清单，
      并一次性返回清单 + 库表。同一个入口传入空的 `gameDir` 即“重读这个游戏”
      （仍会清空清单与归档缓存，因为重读的意义就在于归档可能已经变了）。
      页眉 Ren'Py 面板与完整设置页共用一个 `GamePicker` 下拉框。
- [x] **2. 切换 VN 时复位所有状态。** 除选择框路径外，还补上了外部切换的
      监听：模型用 `renpy_configure` 工具换游戏、或另一个窗口改了同一份配置时，
      客户端过去只在 900 ms 轮询里看到 `settings.gameDir` 变化，**清单、调色板、
      角色表、背景、播放列表全部停留旧游戏**。`applyGameSwitch` 现在比对
      `activeGameDir`，一变就 `resetForNewGame()` + 重新拉清单。宿主侧
      `forgetSessionState()` 同时清掉会话固定指向、舞台、安全区和归档句柄；
      `renpy_configure` 现在也会 `rememberGame()`，因此模型加载的游戏同样
      出现在下拉框里并能跨重启保留。
- [x] **3. 退出 DSH 时立刻停止媒体。** 在 `pagehide` / `beforeunload` 上
      `stopMedia()`：`pause()` 之后还 `removeAttribute("src")` + `load()`，
      因为只 `pause()` 会留下解码器进程继续出声。
- [x] **4. 输入区背景开关。** 新设置项 `composerBackdrop`
      （`default` / `transparent` / `solid`），在 `buildSkinCss` 里对
      `.Dc7zOa_root[data-phase="active"] .Dc7zOa_composerSeat` 及其
      `_embeddedBody` 变体写 `!important` 覆盖 —— 与 `.rsk-layer` 同理，
      宿主自己的后代选择器优先级高于单个类名。

## 页眉工具 — 用户要求的四个功能

按用户给出的四条答复实现（开场 = 仅 `label splashscreen:` 的内容；
主菜单音乐 = 静态解析，默认分支在前，其余放入下拉列表；播放列表 = 递归扫描
`game/audio/music`，≤10 s 的丢弃；该图标打开插件**自己**的
面板，它深链到 DSH 设置，因为没有已文档化的客户端服务可以打开它）。

- [x] **Ren'Py 图标 → 插件面板。** 注册在
      `conversation.session.header.utilities`；面板包含快捷开关
      和一个按钮，该按钮在 DSH 设置中打开完整的 `settings.section` 页面
      （受保护的深链；回退为直接说明路径）。
- [x] **启动时开场**（`splashOnStart`，默认 **关闭**）。`readSplashscreen`
      提取 `label splashscreen:`；`renpy.movie_cutscene` 影片优先于
      最大的全屏静帧，后者又优先于 `presplash.png`。视频会一直保留到浏览器
      能够播放它为止，因此编码不良时会降级 (degrade) 为静帧而不是黑屏。
- [x] **主菜单音频**（`menuMusicOnStart`）。`resolveMenuMusic` 处理真实
      形态 —— `config.main_menu_music = main_menu_music()` 带一个
      `if persistent.theme == '…'` 主体 —— 外加 `audio.<name>` 别名表
      （`define -500 audio.x = "…"`，可有优先级标记）。
- [x] **页眉播放列表。** `buildPlaylist` 依次遍历 `audio/music/` →
      `audio/sound/` → `audio/` → 游戏目录，先匹配者胜出，并使用 `lib/audio.js`
      丢弃 ≤ 10 s 的曲目。
- [x] **共享播放器。** 一个 `<audio>` 元素同时支撑主菜单音乐和
      播放列表，因此两者永远不会重叠。音量跟随 `playlistVolume`。

此功能上仍未完成的部分：

- [ ] **设置深链依赖的是内部检视接口 (inspection-surface API)。** 面板
      通过 `slots.entries("sidebar.settings")[0].store`
      → `slots.resolveStore(...)` → `actions.openSection("renpy-skin")` 打开
      DSH 设置对话框。这两跳都不是已文档化的契约，因此它被保护起来，并回退为
      直接说明手动路径。如果 DSH 将来提供已文档化的设置服务，就把它换成
      真正的调用；`settings.launcher` 不是可选项（kind 为 `single`，且
      已被占用 —— 在那里注册会遮蔽已发布的 UI）。
- [ ] **开场画面只能部分复现。** GTST 的 `first_splash`
      （纯文本）和 `antipiracy_splash` 的 3 s 计时器没有可提取的图像。
      一个*只*含文本的 `label splashscreen:` 会产出 `found: true` 且没有
      媒体，客户端 (client) 什么都不显示 —— 需决定是否渲染这些文本。
- [ ] **`config.main_menu_music` 不是唯一的入口点。** 游戏也可以
      从 `label main_menu` 调用 `play music`，而这一点未被解析。
- [ ] **没有音效 (SFX)。** 只有音乐被索引用于播放；播放列表的兜底会
      扫描 `audio/sound`，但其中的短音效因时长被过滤掉。

## P3 — 健壮性

- [ ] **立绘发现没有尺寸或路径过滤，因此 UI 美术也被当作可展示角色提供。**
      在 Arches 上实测：`spriteIndex` 持有 **4034** 个条目，包括 `repeat 1` /
      `repeat all`（`gui/` 下 67×57 的音乐室图标），它们被作为舞台角色
      提供给模型。修复方法是排除 `images/sprites` 之外的路径，并忽略低于
      最小尺寸的候选。
- [ ] **带任何属性的背景会被归类为立绘。**
      `lib/manifest.js:533` 只在名称不含属性时才把 `backgrounds/<file>` 当作
      背景，因此 `images/backgrounds/mine_blur.jpg` 变成了标签 `mine_blur`
      （属性 `red`）。游戏给某个名称赋予属性时，它同样常常是地点；该规则
      不应只依赖这一点。
- [ ] **`if` 条件不起作用。** 它们会被解析并存储，但没有任何东西
      对它们求值（这是刻意的 —— 没有表达式求值器）。要么在工具层面把它们
      记录为仅供参考，要么实现一个极小的变量存储。
- [ ] **安全区碰撞忽略了纵向重叠。** `lib/stage.js:811` 只看
      `coversX: true` 的矩形，因此右下角的预留区域会对
      左上角的立绘发出警告。应使用矩形的 `y`/`h`。
- [ ] **Ren'Py 7 时代的 pickle 变体。** RPA 读取器覆盖了目前
      观察到的操作码；使用 `REDUCE`/`GLOBAL` 的归档 (archive) 会按设计
      抛错，需要真正的（沙箱化）实现。
- [ ] **大型游戏的性能。** Arches 在几秒内构建完成，含 4932 条 image
      语句和 63 个背景；尚未对更大的游戏做过性能剖析，且
      `listFiles` 上限为 20000 个条目。

## P4 — 打磨

- [ ] **`Config` 模式 (schema)。** 一旦宿主依赖可安装，就声明一个
      schemastery 的 `Config`，让设置项出现在原生设置界面中。形态
      记录在 [CONTRACTS.md](CONTRACTS.md)。
- [ ] **提示词段落大小。** 导演简报会列出角色和背景；对于有数百个
      标签的游戏，需要对它做上限控制或摘要。
- [ ] **转场覆盖范围。** 仅支持 `dissolve`、`fade`、`none`。真实游戏使用的
      ATL `with`（例如 `wipeleft`、`pixellate`、`Dissolve(0.5)`）会被拒绝。

## UI/UX 审查后续（子 agent 只读审查 → 用户选定范围）

- [x] **两套设置界面合并为一份描述表。** 弹出层与完整设置页此前各自手写
      一份开关列表：提示只加在一边、`Sprite stage` 只在弹出层被归到
      “对话”下。现在是 `SkinSwitches` + `PlaybackSettings` 两个共享组件，
      完整页是超集，弹出层是子集。
- [x] **Load 按钮的反馈。** 原先三行同步调用，React 根本画不出 busy 态，
      且 `set()` 返回 void；现在走一次 `/library` 往返并 `await`。
- [x] **SliderRow 在指针离开控件后永久卡死。** 原先只在元素自身的
      `onPointerUp` 复位 `dragging`，拖到外面松手就既不提交、也永远不再回显
      持久化值（静默丢数据）。现在在 window 上以捕获阶段监听
      `pointerup` / `pointercancel`。
- [x] **无障碍**：`SliderRow` 的 `<label htmlFor>` + `id` +
      `aria-label`/`aria-valuetext`；`PanelShell` 加 `role="dialog"`、
      `aria-label`、`tabIndex:-1`、挂载时聚焦、卸载时归还焦点。
- [x] **中英混排 / 反引号**：立绘表情摘要与统计行走 `t()`；错误原文降级为
      `title` 悬浮提示；用户可见文案里的反引号（没有 Markdown 渲染器）已去掉。
- [x] **浅色主题前景色**：不再写不存在的 `--dsw-theme-brand-foreground`，
      改为按强调色亮度算出的 `--dsw-alias-label-primary-foreground`，
      全局写入 `:root`（这是客户端插件能触达宿主自身按钮的唯一途径）。
- [x] **死 CSS 与死词条**：删掉 `.rsk-btn-primary`、`.rsk-choice`、
      `.rsk-choice-item`、`.rsk-media-list`、`.rsk-media-chip`。
- [x] **`prefers-reduced-motion`**：音符脉冲与立绘过渡在减弱动效时关闭。
- [x] **布局编辑器**：内部 id（`sideImage`/`hud`）改为显示名；重置按钮需要
      二次点击确认；`Copy JSON` 从静默改为提示。
- [x] **导入导出改用文件选择**（用户选定）：Blob 下载 + `<input type="file">`，
      粘贴框降级为「高级」折叠区。
- [x] **进度拖动条**（用户选定）：拖动期间用本地草稿顶住 ~4 次/秒的
      `timeupdate`，松手才提交。
- [x] **曲目按子目录分组**（用户选定）：按 `track.directory` 分组，但下标
      仍是**扁平**的播放列表下标 —— 否则多分组时会播错曲目。
- [ ] **未选中的可选项**：完整 Tab 焦点陷阱（用户未选，当前只做初始聚焦 +
      焦点归还）。

## 第七轮用户任务（docs/questions 的通用建议 + 音频顺序/循环）

来自 [docs/questions/](docs/questions/) 的七份实测清单（取样游戏 CSE 2.1.0，Ren'Py 8.5，
脚本全在 `scripts.rpa`）。**只做了对所有 VN 都成立的那部分**；依赖特定游戏、
或需要产品决策的条目见下一节。

- [x] **1. 清单可解释性：把「读到了」与「没读到」分开。**
      `manifest.sources`（每个值的来源，`default` 表示「什么都没读到」）、
      `manifest.scripts`（`found`/`decompiled`/`attempted`/`skippedByCap`/
      `unreadable`/`reason`/`tool`）、`manifest.characters`（真正解析
      `Character(...)`，与立绘桶 `tags` 分开，`renpy_read_manifest` 里的立绘桶改叫
      `spriteTags`）、`stats` 的 `indexTruncated`/`truncated` 改名成
      `assetsIndexTruncated`/`spriteListTruncated` 并新增 `characters`/`unread`。
      这五个字段是本轮所有其它改动的观测基础：没有它们，改坏了和没改一样看不出来。
- [x] **2. `rpycDiagnostics()` + `decompileRpycBatch()`。**
      反编译链路第一次有对外诊断：Python 与 `unrpyc` 的实际路径、放弃原因、
      一份**可复制**的安装指令（`unrpyc` 不在 PyPI 上，v2.0.4 的 release 里也没有
      `unrpyc.py`，必须下源码 zip）。发现链补了 `vendor/unrpyc/unrpyc.py` 与 DSH 自带的
      Python 运行时；顺带修掉 `readdirSync` 抛错时静默吞掉整个 `~/Tools` 分支的 bug。
- [x] **3. `tools/check-doctor.mjs`（`make doctor`）。**
      让「这份清单可不可信」有个退出码：游戏只有编译脚本、`unrpyc` 又不可用时以 1 退出，
      并说明此时清单里的 GUI 值全是硬编码默认值。实测 CSE 正是这一档
      （0 个松散脚本、`scripts.rpa` 里 29 个 `.rpyc`）；Remember the Flowers 判 ok。
- [x] **4. 扫描范围放宽 + `readScreenBlocks()` / `readCharacterDeclarations()`。**
      `style` 与 `screen` 块的扫描范围从「只有 `gui.rpy`/`options.rpy`/`screens.rpy`」
      改成**全部脚本**；真实游戏常在自己的 `newScreens.rpy` 里重写整个 `screen say`。
      对话框贴图新增第四条来源（屏幕体里的 `add`/`background`），字体变成四级优先链，
      屏幕体的绝对坐标由插件换算成相对偏移。
- [x] **5. profile 层五项修正。** `characters`/`sprites` 成为可覆盖段且逐字段合并；
      `game` 段逐 key 合并；`null` 不再清空扫描值；`unknownKeys` 点名拼错的键；
      `dryRun` 能在不写盘的前提下回答「写下去会发生什么」。
- [x] **6. 目录键漂移修复。** 读 profile 的目录名固定成**扫描名**。此前用的是
      `manifest.game.name`，而这正是覆盖层能改的字段：扫描名 `CSE-2.1.0-pc`
      被改成 `CSE` 之后下一次构建会去找 `game/CSE/vn.json`，覆盖层就静默撤销了。
- [x] **7. 派生字段重算 pass。** `applyProfile()` 之后重跑 URL/尺寸/不透明框/字体，
      否则 profile 改过的资产路径会以裸路径进到 `url(...)`，改字体则 `fontUrl` 仍是旧的。
- [x] **8. 资产与媒体路由三件事。** `/asset` 补字体 MIME 与 `nosniff`；
      `/media` 支持 `?under=`/`?match=` 服务端过滤；`renpy_save_vn` 保存前用
      `readAssetBytes()` 试读资产路径并报告 `unresolved`（仍然允许保存）。
- [x] **9. 归档可见性。** `scan-tree` 的归档块移到 scripts 之前，首块补
      `archives:` 与 `unreadable archives:` 两行，空脚本/空角色不再断言「这个游戏没有」；
      提示词里补归档摘要，`0 scripts` 在归档非空时改写为 `0 loose scripts (N inside archives)`。
- [x] **10. 数据目录迁移改成逐项合并。** 以前新目录一有 `config.json` 就整体放弃搬迁，
      于是「先存过一次设置、后来才回到还有旧库的机器」的用户永久看不到自己的库与存档；
      `/settings` 现在也返回 `dataHome`，两份目录并存时能看出改的是哪一份。
- [x] **11. 音频播放器加顺序/循环/随机。** 新增 `playlistRepeat`（`off`/`all`/`one`）
      与 `playlistShuffle`；transport 行先做成两个按钮，后来按用户要求合并成**一个模式
      按钮**（顺序播放 → 列表循环 → 单曲循环 → 随机播放），`ended` 与
      `nextTrack`/`previousTrack` 都遵守这两个设置。

## docs/questions 里本轮未做的条目（需要产品或数据决策）

- [ ] **开场只含文本时渲染那些文本。** 现在 `label splashscreen:` 若没有可提取的媒体，
      `found: true` 但没有画面。要不要复现 Ren'Py 的文本排版是个产品问题。
- [ ] **`config.main_menu_music` 之外的音乐入口。** 游戏也可以在 `label main_menu`
      里 `play music`，这条路径未解析。
- [ ] **音效（SFX）。** 目前只索引音乐；`audio/sound` 里的短音效被时长过滤掉。
- [ ] **立绘候选的路径与尺寸过滤。** Arches 实测 `spriteIndex` 4034 条，含 `gui/` 下
      67×57 的音乐室图标（`repeat 1` / `repeat all`）。排除规则会直接影响哪些角色可见，
      需要先看几个真实游戏再定阈值。
- [ ] **带属性的背景被归类为立绘。** `images/backgrounds/mine_blur.jpg` 成了标签
      `mine_blur`（属性 `red`）。游戏给某个名字加属性时它往往仍是地点，但只靠这一条
      改会误伤真正的立绘属性。
- [ ] **`if` 条件不求值。** 解析并保存了，但没有任何东西对它求值（刻意如此：
      没有表达式求值器）。要么在工具层面标成「仅供参考」，要么实现一个极小的变量存储。
- [ ] **安全区碰撞忽略纵向重叠。** `lib/stage.js` 只看 `coversX`，右下角的预留区域会对
      左上角的立绘发警告。
- [ ] **Ren'Py 7 时代的 pickle 变体。** 使用 `REDUCE`/`GLOBAL` 的归档按设计抛错。
- [ ] **`applied` 是否拆成 `applied` / `stored` 两栏。** 目前仍在同一栏里报字段路径，
      同时在 `docs/CONTRACTS.md` 列出客户端真正消费的字段；要不要在回执里把「写了但界面
      不读」的那批单独列一栏，取决于 Agent 会不会因此误判「屏幕上已经变了」。
- [ ] **档案与草稿分层。** Agent 的工作区目前就是 profile 目录本身，`_probe/` 之类草稿
      会和 `vn.json`/`tree.md` 混在一起。挪进 `work/` 子目录更干净，但会改变 Agent 已经
      习惯的路径，需要先决定兼容策略。
- [ ] **显式安装 `unrpyc` 的动作。** 现在只在 `rpycDiagnostics().install`、设置页的
      「环境配置」卡片与 README 里给出命令；设置页已经可以直接指定工具位置，但仍然
      不替用户下载并解压。要不要让插件自己下载并解压（新工具或 `renpy_configure`
      的参数）是一个产品决定：宿主端要发网络请求、要选版本、失败时还要能解释，
      和「失败要说原因」这条约束叠在一起需要设计。

## 目前刻意不纳入范围

按用户指示放弃；记录下来以免它们被当作新想法重新提出。来自原始规范的
附录 A：

- 角色调查 / 关系学习
- 音频表演、语音学习、STT/TTS
- 主菜单主视觉图、存档/读档界面、画廊
- 章节跳转、脚本导出、快速菜单
- OC 上传
