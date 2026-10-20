# 状态

**最后更新：** 2026-10-20
**版本：** 0.1.0
**当前目标：** 清单可解释性与 profile 能力：把 `screen say` 屏幕体、`Character(...)`
声明、每个值的来源与脚本发现诊断读进清单；补齐 `characters` / `sprites` 覆盖段、
`dryRun`、`unknownKeys`、`unmatched` / `unresolved`，并在覆盖层之后重算派生字段；
音频播放器用一个模式按钮切换顺序 / 列表循环 / 单曲循环 / 随机播放。此后又加了
「在场」角色扮演预置（名字 / 额外要求 / 跨会话角色记忆）、对话框底板候选选择器，
以及把游戏 `say` 屏翻译成可渲染节点表的模块层（名字框与白名单快捷按钮）。
**当前范围约束：** 文本框背景图片只应用于 composer，不应用于会话消息或用户气泡；会话样式保持宿主原样。任何 composer 布局 CSS 必须限定在 composer 的稳定选择器范围内。
**当前结论：** 上述改动已全部落盘，代码语法检查通过，完整测试 269 项、0 失败
（262 通过 / 7 跳过，跳过的是本机没有 `unrpyc` 的 `.rpyc` 用例）。立绘舞台现在是
会话主体内部的背景层，消息、输入框与会话列表都画在它上面；设置页新增两个开关，
可以隐藏左侧会话列表与底部对话框。设置页新增
「环境配置」卡片与 `GET /renpy-skin/doctor`，工具路径可以直接在界面里指定；
清单新增 `palette`（八个颜色与各自的来源），设置页可以逐项改色或一键恢复游戏值，
其中文本框（对话）文字与 DSH 界面文字是两个独立槽位，游戏没有 `gui.accent_color`
时从对话框底板采样主色。本轮还修了两个让「renpy 命令没效果」的缺陷：桌面壳里
`currentSessionId()` 退回 `global` 导致舞台读错会话桶；`renpy_stage` 的回执与快照
带 `undefined` 键，被宿主按「无损 JSON」拒收。
P0.6 的八项任务与其实机验收仍是上一轮的结果，保留在下面作为证据。

**2026-10-19 21:49 的实机复查（桌面宿主 PID 33216，端口 27194，21:13:07 启动）：**
新构建确实已经进了运行中的宿主——`GET /renpy-skin/manifest` 带着 `scripts`（45 条
`sources`、`stats.unread`）与完整的 `rpycDiagnostics()` 安装说明；`POST
/renpy-skin/agent/prepare` 也不再是旧宿主的 405，而是走到了处理函数。但用
`node tools/verify-agent-load.mjs --port 27194` 打它时**回 400**，报文是
`The "string" argument must be of type string or an instance of Buffer or ArrayBuffer.
Received an instance of Array`。根因与修复见下面「第五个根因修复」一节；**这条修复
还需要再重启一次宿主才能实机复验**。

**任务 7 的实机验收已完成（2026-10-19 02:02–02:06），没有杀掉桌面宿主**：另起了一个
一次性配置档 `verify`（`--from-default-profile web`，再 `plugin add
link:E:/ProjectFiles/dsh-renpy-skin`），用 `dsh --profile verify --port 19487 --no-open`
跑同一份 `lib/`。`node tools/verify-agent-load.mjs --port 19487` = 10/10 通过；
浏览器里点「用 Agent 加载」后新会话的 `request/header` 是 **30 个工具、其中
`renpy_*` 四个**，`system/message` 带 `## Ren'Py stage director` 区段，
`cwd` 正是 `C:\Users\<user>\.dsh\renpy-skin\game\Remember the Flowers 0.17.9P`，
user message 与 `agentLoadPrompt(facts)` 逐字一致，Agent 依次调用
`renpy_read_manifest` → 读 `scan-tree.md` / `scan-tree.full.txt` →
`renpy_save_vn`，写出 `tree.md` / `summary.md` / `vn.json`，`turn/end` 为
`{"kind":"completed"}`。**这条链路的三处断点（工具注册、客户端服务、路径/工作区）
现在都有实机证据。**

**桌面宿主现在跑的已经是新构建**：进程 33216 启动于 2026-10-19 21:13:07，端口 27194。
判据不是时间戳，而是三个只有新代码才有的东西——`/renpy-skin/manifest` 的响应里有
`scripts` / `sources`（45 条）/ `stats.unread`，`scripts.tool` 是完整的
`rpycDiagnostics()` 输出（含 `install` 安装命令），而 `/agent/prepare` 不再回旧宿主
那个通用的 405。**唯一还没实机通过的是 `/agent/prepare` 本身**，见下一节；
修完之后仍需再重启一次（`tools/launch-dsh-debug.cmd` 会 `taskkill /IM "DeepSeek
Harness.exe" /T /F` 掉整棵进程树，包括发起它的那个会话，**只能由人手动运行**），
重启后跑 `node tools/verify-agent-load.mjs --port <新端口>` 复验。

客户端 `lib/client.js` 是按页面加载向宿主取的
（`window.__DSH_BOOT__.entries` 里的 `plugins/??dsh-renpy-skin/client.js&rev=…`），
而且客户端插件带热重载，所以客户端改动不需要重启。

## 一句话现状

两半都已实现。宿主端读取一个 Ren'Py 游戏目录（松散 `.rpy` 与 `.rpa` 归档里的
`.rpy`；只有 `.rpyc` 时，反编译是可选回退）生成资源（asset）清单（manifest），
并记录每个值的来源（`sources`）、脚本发现/反编译诊断（`scripts`）与游戏声明的
角色（`characters`）。它通过十四条 HTTP 路由（含导入/导出、可按 `under`/`match`
过滤的媒体列表与 `/agent/prepare`）对外暴露，并注册一个舞台导演（stage director）
的系统提示词区段以及 `renpy_stage` / `renpy_configure` / `renpy_read_manifest` /
`renpy_save_vn` 四个 Tool。客户端已编写完成，注册了立绘舞台、标题栏工具区、
设置面板，以及弹出层、开场覆盖层与 Agent 配置完成弹窗（`shell.overlay` 共四层），并带有主题色变量
（theme token）覆盖、对话框/选项菜单的 CSS 换肤、一个含导入/导出卡片的设置页，
以及一条头部条带，载有 Ren'Py 设置按钮、音乐播放列表（支持顺序/列表循环/单曲循环
与随机播放）和开场/菜单音乐播放器。所有纯逻辑都由 269 个无头测试覆盖，这些测试在
Node 22 和 Node 24 上均通过，且该流水线已成功对两个真实游戏运行过 —— 一个带
4932 张图片的松散资源游戏，以及一个仅有归档的游戏（单个 472 MB `archive.rpa`，
26 个 `layeredimage` 角色）。
第二条 bundle patch 行新增了一个 “Ren'Py skin director” 智能体预设。浏览器端不再是
空白：页眉条、两个面板、播放列表、开场图层与设置页都已在真实窗口里看到过（见下表）；
仍未证明的只是「未验证」一节列出的那几项。

## 受阻项：安装到活动配置档

**已于 2026-10-13 解决。** `dsh-renpy-skin@0.1.0` 已被加入配置档的
`minimumReleaseAgeExclude` 列表，该 bundle 在 `plugin_manager list_plugins`
（patchId `renpy-skin`）中已列出、启用且为 `active`，并且该插件的路由
现在能在运行中的宿主里响应。

## 已验证可用

以下均为直接实测，而非假设：

| 区域 | 证据 |
| --- | --- |
| 线上 HTTP 路由 | 在运行中的桌面宿主内（PID `DeepSeek Harness.exe`，端口 19387）：`GET /renpy-skin/settings` → 200，`GET /renpy-skin/stage` → 200，`GET /renpy-skin/manifest` → 200（203 KB），以及 `POST /renpy-skin/settings` → 200，写入 `config.json`（当时还在旧位置 `~/.dsh-renpy-skin`；2026-10-18 起存储根是 `$DSH_HOME/renpy-skin`） |
| 在真实游戏上构建清单 | Arches：1920×1080，`gameDir` 由 Ren'Py 根目录解析得到，**4034** 个可显示对象（displayable）被索引进 `spriteIndex`，106 个背景，8 个标签，69 个游戏变换（transform） |
| 展示上限 | `sprites` 返回 200 且 `stats.spriteListTruncated: true`（资源索引被 20000 条上限撞到时另有 `stats.assetsIndexTruncated`）；`spriteIndex` 保留全部 4034，因此校验仍会接受被裁剪的立绘 |
| 每个标签的总数在上限裁剪后仍保留 | `tags[].total` 读出 `art:392 bri:163 cam:1905 dev:1531 duk:39 lamp:1`，每个都有 24 个被裁剪的 `expressions` |
| 对话框提取 | `h=360 yalign=1 fill=#000000 text=#ffffff` 从 `gui.rpy` 读出 |
| `screen say` 屏幕体 | `readScreenBlocks()` 解析 `add` / `background` / `frame` / `window` / `text` 这几类行，支持关键字单独成行与 `frame: pos (265,798)` 单行内联；对话框颜色、字号、字体、贴图、文本与名字的坐标/宽度都能从屏幕体取值，`sources` 对应记 `screen`。这一轮就是为 CSE 2.1.0 这类在 `newScreens.rpy` 里重写整个 `screen say` 的游戏做的 |
| 选项菜单提取 | `w=1860 idle=#cccccc hover=#ffffff` |
| 图片名推导 | `art` 标签解析为 `angry l / annoyed l / confused l / excited l / glance l / glare l …` —— 仅按空白字符切分，因此带连字符的文件名得以保留 |
| 语句解析 | `scene bg X with fade`、`show TAG ATTR at center`、`show … at left, Transform(zoom=0.9)`、`show … at center zorder 5`、`hide TAG` 均可解析 |
| 自我纠错的拒绝信息 | 未知标签、未知变换和 `with wipeleft` 各自都会返回确实存在的名称集合 |
| `.rpa` 读取 | RPA-3.0 读取器已实现（pickle 操作码虚拟机、XOR 键控索引），并对 9 个真实归档验证通过，包括一个含 4089 个条目的 1724.7 MB `archive.rpa` |
| `.rpyc` 反编译 | `lib/rpyc.js` 封装 `unrpyc`；通过一次 `decompileRpycBatch()` 入口反编译了 56 个归档 `.rpyc` 文件（在 GoToSnowTown 上验证）。失败不再只进调试日志：`rpycDiagnostics()` 与 `manifest.scripts.reason` 会说明缺的是 Python 还是 `unrpyc` |
| 清单值来源 | `manifest.sources` 逐字段记最终值来源：`screen` / `style` / `gui-variable` / `conventional-path` / `character-declaration` / `profile` / `default`；整块读不到的角色表记 `unread`。覆盖层改过的字段把对应路径改记 `profile`，同时由 `profileApplied` 列出字段路径；`dialogbox.textboxImage` 另有 `gui-variable` / `style-window` / `screen` / `conventional-path` / `none` 这套历史取值（与 `dialogbox.textboxSource` 同值）。底板候选（`dialogbox.candidates[].source`）复用这批名字，另有一个只出现在候选列表里的 `sweep`（全库扫描兜底） |
| 脚本发现诊断 | `manifest.scripts = { found: { looseRpy, looseRpyc, archivedRpy, archivedRpyc, total }, decompiled, attempted, skippedByCap, unreadable, reason, tool }`；`tool` 是 `rpycDiagnostics()` 的完整探测结果（`{ python, unrpyc, reason, usable, install }`），**本轮反编译成功与否都会填**——`attempted`/`decompiled` 回答「这一次跑通了吗」，`tool` 回答「工具到底在不在这台机器上」，两者混成一个字段就分不清「游戏没有脚本」与「装了才读得到」；`reason` 为 `null` 表示至少有一份脚本解析成功；最多反编译 48 个脚本，超出的计入 `skippedByCap`、读不出的计入 `unreadable` |
| `Character(...)` 声明 | `readCharacterDeclarations()` 解析 `define qc = Character('启诚', color="#624B34", image="qc")` 与对应的 `default` 形式，含多行参数、关键字参数与 `DynamicCharacter` 等以 `Character` 结尾的构造函数；`manifest.characters` 按变量名索引，与立绘桶 `tags` 分开，`image=` 对不上立绘时标 `spriteTagUnresolved` |
| `layeredimage` 角色 | 26 个分层角色（enid/catherine/nox/…）解析为带逐属性表达式的多组立绘标签 |
| 主题色变量 | 由游戏强调色推导出 10 个别名 token，作为 light+dark 成对值 |
| 对话框换肤 | `buildSkinCss` 将 `dialogbox.fill`+`opacity` 或 `textboxImage` **只应用到 composer**；会话消息和用户气泡保持宿主原样；选项悬停映射到 `--dsw-alias-interactive-bg-hover` |
| 对话框底板选择器 | 清单收集**所有**可能的底板（`dialogbox.candidates`：显式 `gui` 变量 → `window` 样式 → `say` 屏的 `add`/`background` → 常规路径 → 按 `textbox\|say\|dialogue\|message` 扫全库兜底，排除手机/平板变体与 namebox，上限 12 张；`candidates[0]` 恒等于当前所用的 `textboxPath`，由 `rederiveAssets()` 在覆盖层换盘后重排保证）。设置页的 `PlatePicker` 在候选 ≥ 2 时出现，选中一张就 `POST /renpy-skin/dialogbox`（只接受候选里的路径，未知路径 400 并回带候选），宿主写进该游戏档案的 `dialogbox.textboxImage` 并重建清单，界面把响应的 `manifest` 写回 store；Agent 用同一条路（`renpy_save_vn`） |
| say 屏模块层 | 清单 `dialogbox.modules` 把游戏自己的 `say` 屏翻译成扁平节点表（`box` / `image` / `text` / `button` / `bar`，画布像素 `rect` + `z`）：底板之外的 `add`/`background` → 装饰图、`layout.name*` → 名字框、`quick_menu` 里动作在白名单（`settings` / `music` / `memory` / `hide` / `skip`）的按钮 → 可点按钮，映射不到的只进只读的 `quickMenu` 报告。客户端 `ModulesLayer`（`shell.overlay`，order −890）每 400 ms 量 composer 根元素，用与 `dialogboxRules()` 共享的 `composerGeometry()` 把画布坐标换成 `cqw`，只有白名单按钮恢复 `pointer-events`；`dialogboxModules` 是总开关。Agent 用 `renpy_save_vn` 的 `dialogbox.modules` 整体替换（上限 40，`[]` 清空） |
| 四路审计 | 子 agent 并行修复四类读取问题，完整测试 153 项通过；实测 GoToSnowTown / SharedHouse / TSR 清单正常，SharedHouse 首次构建约 4.4 秒（原 26 秒）。**宿主端改动需重启 DSH 才进入运行中的宿主，composer 新布局尚未在界面里看过** |
| composer 还原 VN 文本框 | 贴图按原始像素宽度相对画布缩放、底部居中；高度下限、文字颜色/字号/对齐取自 `gui.*`，均以 `cqw` 表达。GoToSnowTown 上实机量过：1313px 宽时卡片 190px 高、字号 27px、内边距 274/51px。姓名框未还原 |
| composer 扁平文本框 | 实机（CDP 9222）量过：根节点内边距 0、卡片 593px 满宽、无阴影与圆角；统计 dock 叠在按钮行中间，垂直中心与按钮对齐；输入框内边距上 20px / 左右各 123px（`gui.dialogue_*` 按 `cqw` 换算），占位符与之对齐；按钮行仍贴卡片底部；会话区未改动 |
| 界面字体 | 设置页按 VN 字体、默认/系统字体、自定义字体顺序选择；所选字体写入 `body` 上的 `--dsw-font-family`，整个界面（含会话）实时变化，字号不动。实机用 CDP 逐个切换 3 个 VN 字体，`CSS.getPlatformFontsForNode` 读到的渲染字体每次都随之变化；每个 VN 字体用按路径派生的唯一族名，避免复用同名 `@font-face` |
| 多 VN 读取流程 | 2026-10-15 对四个真实游戏跑完整清单：SharedHouse（1.7 GB `archive.rpa`，修复前被误判为非归档，只读到 8 个背景/2 个立绘，现在 296 背景、195 标签、177 变换、字体 19 个）、TSR（1104 背景/83 标签/140 首曲目）、GoToSnowTown（204 背景/30 标签/36 首曲目）；CSE 只有 `.rpyc`，当时被 unrpyc 2.0.2 拒绝（见下），也正是这一轮 `scripts` 诊断要说明的情况 |
| 背景切换器 | 设置页列出当前 VN 的背景与 CG，支持搜索和 3 列 × 3 行分页网格；选择结果写入 `backgroundImage`，自动模式恢复跟随游戏 |
| 打字机文本 | `textAnimation`/`textCps` 控制回复逐字显示；支持 `{w=0.5}`、`{p}`、`{cps=20}`、`{fast}`，代码块和其他花括号保持原样 |
| `renpy_configure` Tool | 通过绝对路径加载/切换活动 VN，将其持久化，清除缓存的清单/舞台，返回游戏名 + 名册统计 |
| `renpy_read_manifest` Tool | 无参只读，以 JSON 代码块返回扫描值：`game` / `dialogbox` / `layout` / `choice` / `theme`（保存时同名段可覆盖），以及诊断快照 `sources`（每值来源）、`scripts`（脚本发现与反编译）、`stats`（含 `assetDirs`：文件数前十的目录，摘要里没有路径清单时靠它决定 `/media?under=` 去哪找）、`characters`（`Character(...)` 声明，截 60；保存时的 `characters` 段另按变量名索引）、`spriteTags`（立绘桶，截 60 标签/每个 8 属性）、背景 40、变换 30，以及 `profile.applied` / `profile.rejected` / `profile.unmatched`。没有加载游戏时 `{ ok: false, error }` |
| `characters` / `sprites` 覆盖段 | 段名单从 6 个扩到 8 个，两段都逐条逐字段合并；`characters` 可补上扫描时没有声明的变量，`sprites` 按 `tag` 或 `name` 命中扫描记录，匹配不到只进 `profileUnmatched`（即回执里的 `unmatched`），不新建记录。`null` 与 `undefined` 都表示「保留扫描值」，`game` 段也改为逐 key 合并（`screen` 浅合并一层） |
| `renpy_memory` Tool | 跨会话**角色记忆**（`game/<扫描名>/memory.json`，`lib/memory.js`）：`list` 列出名册里每个角色存了多少字符、`read` 读某个（或不带 `character` 读全部有记忆的）角色的全文、`append` 追加、`replace` 覆盖；`character` 必须是清单声明过的 tag，空文本的 `append` 被拒绝、空文本的 `replace` 表示删除该角色的记忆。每个角色上限 8000 字符，超出保留最新内容并按行截断（`trimmed: true`）。设置页与顶栏记忆面板走同一条路由（`GET`/`POST /renpy-skin/memory`）写同一个文件 |
| `dryRun` | `renpy_save_vn({ dryRun: true })` 不写文件、不清缓存，返回 `wouldWrite: { tree, summary, vn }`、`applied`、`ignored`、`malformed`、`unknownKeys`、`unmatched`、`unresolved`；它在扫描清单的深拷贝上跑同一套 `applyProfile()`，所以 `applied` 与真实保存一样是字段路径（已剔除 `unknownKeys`），`unmatched` 来自该探针合并 `characters`/`sprites` 时记下的匹配失败项，`unresolved` 照常逐项试探 |
| 保存后对账 | `inspectProfileConfig()` 返回 `{ accepted, ignored, malformed, unknownKeys }`；回执与 `GET /vn` 都带 `applied`（已减去 `unknownKeys`）、`unmatched`、`unresolved`（保存前用 `readAssetBytes()` 试探过、仍读不到的资产路径） |
| 派生字段重算 | `rederiveAssets()` 在 `applyProfile()` 之后重铸资产 URL、重算 `textboxImageBounds` / `textboxImageBox` / `nameboxBounds`、按 `dialogbox.font` 或改过的 `dialogbox.fontPath` 在 `manifest.fonts` 里重查得到 `fontUrl`；找不到字体时清空 `fontUrl`，取不到图片字节时把几何清成 `undefined`。覆盖层换过底板时还要把选中项提到 `dialogbox.candidates[0]`（扫描按发现顺序排候选，而覆盖层在其后应用，不重排选盘器就会把旧底板显示成当前项；档案指到扫描没找到的路径时，就地为它合成一条 `source: "profile"` 的候选）。档案改过 `dialogbox.modules` 时还要为每个节点派生 `imageUrl`（`hover.image` 同理）：`image` 存路径、浏览器要 URL；游戏供不出的路径照发 URL，缺文件由 `renpy_save_vn` 的 `unresolved` 按 `dialogbox.modules[i].image` 报出 |
| 音频循环与随机 | `playlistRepeat`（`off` / `all` / `one`）与 `playlistShuffle` 两个设置，在播放器面板上合并成**一个模式按钮**（顺序播放 → 列表循环 → 单曲循环 → 随机播放，按钮上的 `data-mode` 是当前状态）；`ended`、`nextTrack()`、`previousTrack()` 都遵守；纯函数 `shuffleIndex(length, current)` 与 `playbackModeOf(settings)` 导出给无头测试 |
| Agent 配置完成弹窗 | 点过「用 Agent 加载」并成功投递后，客户端每 3 秒读一次 `GET /renpy-skin/vn`（上限 10 分钟），`profile.savedAt` 变化时在 `shell.overlay` 最上层（order -860，高于 popover -870 与 splash -880）弹模态：一句话（三种变体：改掉 N 个字段 / 没盖掉任何东西 / 属于别的游戏目录）+「立即更换」「先保存」两个按钮；Esc、点遮罩与「先保存」等价。无头用例验证了监视的「只响一次」与「不变不响」 |
| 设置页「Agent 写下的配置」卡片 | 只读展示 `GET /vn` 的 `dir`/`profile.savedAt`/`applied` 计数/`report.ignored`/`report.malformed`/`rejected`/`summary` 开头；`summary`/`tree` 各截到 4000 字符传输 |
| 导入 / 导出 | `GET /renpy-skin/export` 返回 `{exportedAt, plugin, version:1, settings}`；`POST /renpy-skin/import` 持久化粘贴的配置，并在 `gameDir` 变化时清除缓存 |
| 开场媒体选择器 | `GET /renpy-skin/media` 返回当前游戏自带的、游戏相对的 `{images, videos}`（走同一个资源索引，`.rpa` 内条目也在内）。`?under=`（目录前缀）与 `?match=`（子串）在服务端过滤，响应多一个 `filter: { under, match, matched, total }`（`matched` 是命中数，`total` 是过滤前总数）；不带参数时形状不变。设置页用它替换了原来要手打路径的输入框；列表按 `gameDir` 缓存，切换游戏与重读磁盘都会清空 |
| 跨游戏资源缓存键 | 逐个 `GET /renpy-skin/manifest?gameDir=…` 打三个真实游戏：主菜单背景都解析到 `gui/main_menu.png`，但 URL 分别是 `?v=1-mv86tjzx` / `?v=2-mv86v8t7` / `?v=3-mv86vagc` —— 三份互不相同，浏览器缓存再也回放不到上一个游戏的那份字节（修复前是同一个 URL） |
| 智能体预设 | `cordis.patch.yml` 插入一行 `preset-renpy-skin`（`@deepseek-ai/dsh-agent-preset`，order 50），其中含一个 `@deepseek-ai/dsh-persona`。persona 只写身份、四个工具各一句话与三条不矛盾的规则（不编造目录、遵守设置里的立绘上限、不做角色调研）：流程**单一承载**在「用 Agent 加载」的提示词里，两份副本曾经在「只给名字要不要自己搜盘」上互相打架，现在不再重复。第二个预置 `preset-renpy-scene`（展示名「在场」，order 60）面向角色扮演：它是本包唯一声明 `@deepseek-ai/dsh-time-context` 的地方（随发行版交付的 Web 组合不带这一行，`standard`/`cordis`/`ptc` 各自声明），`refreshIntervalMs: 0` 让每个合格 step 都拿到一条时间快照；persona 只写「用户是到场的人、此刻他在做什么、每轮至少一次 `renpy_stage`、其他角色完整上台、技术问题只说一句」，舞台语法与角色名册仍由全局注入的舞台说明承载；工具面只有 persona、时间上下文与压缩，不含 shell/文件/网页。第三个只属于「在场」的东西由宿主注入：`renpy-skin:roleplay` 提示词段（`roleplayBrief`）只对 `agentPreset === "renpy-scene"` 的会话生效（`session/event` 缓存会话头里的 `agentPreset`），内容是用户在戏里的名字（全局 `playerName`，或按会话覆盖的 `sessionNames`）、用户追加的 `roleplayPrompt`，以及每个角色「记得的事」（`game/<扫描名>/memory.json`，模型用 `renpy_memory` 写、用户在设置页或顶栏记忆面板里写，同一个文件）。设置页新增「Roleplay 「在场」」卡片：两个名字输入框 + 额外要求文本域 + 记忆编辑器（角色下拉 + 文本域 + 保存 / 记住这段） |
| 皮肤语言开关 | 一个 `lang` 设置项（`auto`/`zh`/`en`）驱动一行 `SegmentedControl`；`auto` 跟随宿主 `locale` 服务，另外两个强制使用皮肤自身的文案。区域命名空间注册已修复为 `register(ns, { zh, en })` |
| 环境配置 | 设置页新增「环境配置」卡片：逐项列出 Node（DSH 自带）、Python ≥3.9、`unrpyc` 与数据目录的状态、路径与命中来源，未找到时直接给下载地址（Python → `python.org/downloads`，`unrpyc` → 项目主页与 v2.0.4 源码包）。卡片还接受 `pythonPath` / `unrpycPath` / `toolsDir` 三条路径（trim + 400 字符，空值自动发现，优先级高于同名环境变量）。数据来自 `GET /renpy-skin/doctor`（`?refresh=1` 重新探测），与 `tools/check-doctor.mjs` 共用 `rpycDiagnostics()`；`missing`（该下载）与 `broken`（该改路径）分开报告 |
| 色板可读可改 | 清单的 `palette` 按固定顺序列出八个颜色（accent / hover / idle / text / uiText / name / choiceIdle / choiceHover）的值与来源；设置页「Palette read from the game」卡片给每项一个取色器、显示「读自哪里（`gui-variable` / `screen` / `style` / `image-sample` / `dialogue-text` / `settings` / 默认值）」，被覆盖的行可以一键恢复。`text`（文本框里的文字）与 `uiText`（DSH 界面文字）是两个独立槽位：钉住一个不会改掉另一个，未覆盖的 `uiText` 取不受 `text` 覆盖影响的游戏对话文字色，覆盖后两种主题都用它。改动写进 `paletteOverrides`（空对象 = 全部跟随游戏），保存后重建清单，`theme` 的 10 个 token 随之重新派生并立即生效。缺 `gui.accent_color` 时用 `pngDominantColor()` 从对话框底板采样主色，失败再试名字框，来源记 `image-sample`；只有 `hover` / `nameColor` 自己也没读到游戏值时才会跟着采样色走 |
| 界面收纳 | 立绘舞台不再放在整帧的 `shell.overlay`（那一层 `z-index:20`，天然盖住会话列表与消息）。`applyStageLayer()` 把 `[data-renpy-skin="stage"]` 插成 `[data-conversation-content]` 的第一个子节点，滚动区抬到 `z-index:1`、舞台留 `0`，所以立绘只出现在会话面板内部，永远在消息与 composer 之下，也不会越过左侧会话列。新增 `hideSidebar`（隐藏会话列表并重铺 grid 列，不碰宿主布局服务）与 `hideComposer`（隐藏 composer 与画在它上面的 `say` 屏零件），两者都可在设置 →「界面」里随时恢复 |
| 无头测试套件 | 269 项测试、0 失败（Node 22.15.0；262 通过 / 7 跳过，跳过项是本机没有 `unrpyc` 的 `.rpyc` 用例）。主用例现有 `skin` / `rpa` / `rpyc` / `audio` / `client` / `vn` / `renpy` / `scantree` / `home` / `memory` / `png` 十一份，外加四份审计用例。`rpycDiagnostics()` 另有永不跳过的断言，避免整份 `rpyc` 用例因跳过而「全绿」 |
| 角色名册门控 | `enabledCharacters`（设置 → 角色）会过滤 `directorBrief` 的名册，**并且**拒绝未被勾选的 `show`，提示 `未启用，请到设置勾选`；空列表 = 全部演员 |
| 页眉条渲染 | 在真实窗口截图里看到 `.Dc7zOa_headerUtilities` 中并排出现 Ren'Py 标记、音符图标与外壳自带的按钮（窗口标题本身也复现了该 DOM） |
| 页眉按钮在没有会话时仍在右上角 | `conversation.session.header.utilities` 靠左边那条 `flex: 1` 的面包屑把自己顶到右边，空白会话里宿主把标题簇整个藏掉，这一行（连同我们的按钮）就滑到页眉左侧；完全没有会话时（`sessionId === void 0`）宿主干脆不渲染这条 session 页眉，座位不存在。同一组按钮现在也在 `conversation.header.leading`（平台元数据写明「available without a Session」）注册一份，一条样式表保证两处只显示一份。实机用真样式表 + 状态模拟量测：空白会话与无会话两种状态下按钮都距右 48px、距顶 11px、不溢出；正常会话里主副本仍是 `position: static`（新规则不生效） |
| 滑块拖动实时预览、松手一次落盘 | CDP 驱动真滑块并给 `fetch` 打桩数 POST：亮度 45%→30% 拖动中背景 `<style>` 就从 `rgba(0,0,0,0.55)` 变到 `0.70` 且 **0 个 POST**，松手恰好 1 个 POST；音量 35%→55% 共享 `<audio>` 的 `.volume` 当场变 0.55（同样 0/1）；立绘上限 4→5 也是 0/1。拖出去再拖回起点的手势 0 个 POST，随后从宿主侧改写 `backgroundDim=0.62` 仍被 900ms 的 settings 回显拉回（控件显示 38），说明预览标记确实被清掉。三轮都把值改回原样，配置档没有被留下修改 |
| 两个面板可交互 | Ren'Py 面板显示游戏目录输入、全部开关组、菜单曲目下拉框；音乐面板渲染完整曲目列表，点击即开始播放 |
| 设置深链 | 面板中的「打开完整设置页」落在 Settings → Ren'Py skin，而不是第一个分区 |
| 开场图层 | 在 Remember the Flowers 上（`kind: "video"`、`images/video/splash.webm`）：`videoTime` 推进到 4.65 / `duration` 14.982、`readyState 4`、`error null`，跳过提示可见 |
| 已分析 VN 的库 | `library.json` 跨重启保留（现在落在 `$DSH_HOME/renpy-skin/`，旧位置缺的同名文件会在首次解析时被复制过去，已存在的不动）；下拉框列出上一轮加载过的游戏 |
| 「用 Agent 加载」按钮 | 若 `GET /vn` 已有 `profile.savedAt`，第一次点击只展开内联确认，再点一次才走下面的流程；`rejected` 的 profile 也会提示，因为它仍会被新配置覆盖。按钮流程已重写为「`POST /agent/prepare` 准备游戏 → 提示词带真实路径 → 建工作区 → 开新会话 → 投递」；任何一步失败都 abort 并在面板显示原因（`prepared` 布尔区分「准备失败」与「开会话失败」两句文案），剪贴板只在失败后作为可选按钮出现，绝不自动写。旧行为（投递失败自动复制）已删除。**2026-10-19 实机（19487 的 `verify` 配置档）点通全程**：面板显示「已发到新会话」，新会话 `cwd` = profile 目录，`request/header` 30 个工具含 4 个 `renpy_*`，模型调用了 `renpy_read_manifest` → 读两棵树 → `renpy_save_vn`，写出 `tree.md` / `summary.md` / `vn.json`，`turn/end` 为 `{"kind":"completed"}`。失败分支本身仍未实机走到。 |
| Agent 加载链路的三处静默失败 | `systemPrompt`、`tools`、`webServer` 三处全部改为 `ctx.inject([...], (scoped) => ...)`。此前三者都是一次性 `ctx.get`，在服务晚挂载时静默跳过注册——症状是「请求里有 47 个工具，没有一个 `renpy_*`；提示词区段也不在其中，日志里什么都没有」。`export const inject` 仍为 `[]`：始终不出现的服务只让它自己那一半不接线。 |
| 存储根 | `lib/home.js` 解析 `DSH_RENPY_SKIN_HOME` > `$DSH_HOME/renpy-skin` > `~/.dsh-renpy-skin`（空白视为未设置；`DSH_HOME` 是 DSH 官方的配置目录环境变量，不是用户主目录）。进程内首次解析到新位置时跑一次**逐项合并**：`config.json` / `library.json` / `game/` 里旧目录有、新目录缺的那项才复制，已存在的条目一律不动（它可能比旧副本新），从不删除、从不抛错。 |
| 两层目录树 | `lib/scantree.js` 写 `scan-tree.md`（紧凑地图，硬预算 400 行 / 12 KB，装不下时逐块截断并在文件里注明剪到哪一行以及完整清单在哪个文件）与 `scan-tree.full.txt`（完整遍历，上限 20000 条，`.rpa` 只按顶层目录计数）。真实游戏 Remember the Flowers 0.17.9P 实测：2151 文件，compact 184 行 5297 字节，full 2158 行 77031 字节，未截断。 |
| `POST /agent/prepare` | 校验顺序「存在 → 是目录 → 能扫出清单 → 读到游戏名 → 扫到 `.rpy`/`.rpyc` 或 `.rpa`」，然后持久化 + 清缓存 + pin 会话 + 写两棵树，返回 `{ gameDir, root, profileDir, name, paths, stats }`。真实游戏 2.5 秒返回；`C:/Users/<user>/Documents` 被正确拒绝为 `not a Ren'Py game`（只看目录是否存在会被任意空文件夹骗过：扫描器对任何目录都成功，并把目录名当游戏名）。 |

## 未验证 —— 视为未被证明

- **计数折行、音量百分比、音频拆分的观感。** 已随 23:11:58 那次重启进入宿主，
  但没有截图存证，没人真的看过。（「背景亮度」不再属于这一条：本轮用 CDP 驱动真
  滑块量到背景 `<style>` 随拖动变化，见上表。）
- **CDP 端口已处于 Listen**（2026-10-14 复查：`127.0.0.1:9222` 属主是桌面应用
  `DeepSeek Harness.exe` PID 209868，监听 19387 的宿主进程是 PID 237268），原先
  那条「端口没能绑定」不再算受阻。下面三项修复只经过单元测试与直接调用
  `buildManifest` 验证，**仍然没有**在 DOM 里确认：
  - Ogg 曲目总时长显示 `--:--`（根因：`dsh-app://` 剥掉 `content-length`，
    Chromium 只能靠总字节数推算时长，于是 `duration` 变成 `Infinity`）。
  - 主菜单曲目与播放列表大小写对不上（游戏写 `motion.ogg`，磁盘是 `Motion.ogg`）。
  - `playlistVolume` 曾被读回 `0`（只观察到一次，未复现；0 本身是合法值）。
- ~~**「用 Agent 加载」的整条新链路尚未在真实宿主里点过。**~~ **2026-10-19 已实机打通**
  （见上文「当前结论」）：`ctx.inject(["uiWorkspace","sessions"], ...)` 在真实客户端
  上下文里确实回调了，`startSession` 之后的新会话 id 轮询赶得上，面板显示「已发到新会话」，
  新会话 `cwd` 就是 profile 目录，`request/header` 里 30 个工具含 4 个 `renpy_*`，
  模型依次调用了 `renpy_read_manifest` 与 `renpy_save_vn`，`turn/end` 为完成。
  实机用的是另起的一次性配置档 `verify`（端口 19487），**不是**桌面宿主。
- **失败 abort 与「复制提示词」按钮仍未在实机里走到。** 本轮实机是成功路径；那条
  分支仍只有无头用例（`every failure aborts with its reason instead of copying the prompt`）
  覆盖，按钮本身从未被点过。
- **宿主端那半可以由 `tools/verify-agent-load.mjs` 一键断言**：它打的是不鉴权的插件路由，
  检查 `/agent/prepare` 真的被服务、两棵树真的写出来、预算与 Ren'Py 判定都成立。
  在 19487 的 `verify` 宿主上 10/10 通过。**桌面宿主（27194 / PID 33216）已经不再回
  405，而是走到了处理函数并回 400**——所以「路由在不在」这一问已经答完了；剩下的
  400 见「第五个根因修复」。注意 405 是旧宿主通用的「未匹配」响应，
  `POST /renpy-skin/definitely-not-a-route` 也是 405，所以不能单凭状态码判断路由是否存在。
- **浏览器端页面需要登录 token**：`GET /` 无鉴权回 401。本轮找到的取法是——
  `dsh web` 启动时把 `http://127.0.0.1:<port>/?token=…` 打印到 **stdout**（桌面应用把它
  吞进了自己的窗口，所以之前在 `~/.dsh` 下搜不到）；用 `Start-Process -RedirectStandardOutput`
  起一份副本就能读到。
- **`ctx.inject` 在真实 Cordis 里的回调时机**已由 19487 实测证实：三个 `ctx.inject`
  （`systemPrompt` / `tools` / `webServer`）在真实宿主里都回调了，工具与提示词区段都出现在请求里。
- **文件选择导入/导出**（`<input type="file">` + Blob 下载）从未在浏览器里点过。
- **进度拖动条**的 `pointerup` 与 `timeupdate`（~4 次/秒）之间的竞争未在真机上确认。
  （松手一次落盘的那条规则里，进度条是唯一不接 `onPreview` 的「会卡顿的效果」，
  它的拖动本身在本轮也没有被真机驱动过——只有亮度、音量、立绘上限三条被测了。）
- **拖动过程中把面板关掉**这条兜底（`SliderRow` 卸载时调用 `endPreview()`）只有代码
  审查，没有实机触发过；「拖回起点」那条同义分支倒是实测过（见上表）。
- **实时对话中的 `renpy_stage` Tool。** 其逻辑已通过
  无头测试；它在 DSH 内部的注册与渲染路径则未经验证。
- **本轮新增的弹窗、只读工具的回执呈现与设置页卡片都没有在真实窗口里看过。**
  `renpy_read_manifest`、`/vn` 的 `summary`/`tree` 头部、`profile.report`
  与「3 秒 × 10 分钟」的 profile 监视都有无头用例，但弹窗真正浮在会话上方时的观感、
  遮罩接管指针事件的效果（`.rsk-layer` 强制 `pointer-events: none`）、以及
  「立即更换」是否如预期只做一次清单缓存读，都需要**重启 DSH 后**点一次
  「用 Agent 加载」才能确认。**这个按钮目前在任何全归档游戏上都走不到弹窗**：
  第一步 `POST /agent/prepare` 就回 400（见「第五个根因修复」），所以这整组观感
  在重启并跑通 `verify-agent-load` 之前都不可能被看到。
- **建工作区的失败分支仍未在实机里走到。** 成功路径已于 2026-10-19 点通（见上表），
  但 `workspaces.create({path})` 被宿主拒绝时只记一条警告、会话照开的降级只有无头
  用例覆盖（「a workspace the host refuses does not cost the session」）；「id 没变
  但那是用户自己的对话」被当作失败处理（旧行为是把提示词排进那条对话并报成功），
  这条同样只有无头用例。
- **非 `.rpa` 归档**，以及超出已实现操作码范围的 Ren'Py 7 时代
  pickle protocol-2 索引变体。
- **审计遗留（见 `docs/VN-READ-AUDIT.md` 各子任务报告）：** `.rpi` 与 RPA-3.2 未支持（本机 22 个归档全是 RPA-3.0）；小型装饰图仍会进入立绘索引；Castle&Myosotis 立绘为 0、Tavern_of_Spear 无主菜单音乐（后者归档只有 `.rpyc`）原因未查；`resolveKnownPath` 仍区分大小写；反编译超时后子 Python 进程可能残留；DXB、英王的宝冠、HAS Demo、KnightsCollege、A.W.A.R.E 不是 Ren'Py 游戏。
- **`.rpyc` 反编译仍是可选步骤**：unrpyc 需 v2.0.4（2.0.2 读不了 Ren'Py 8.5 的
  字节码），探测位置见
  `docs/ARCHITECTURE.md` 的 `lib/rpyc.js` 一节。本机没有 Python 3.9+ 或 `unrpyc`
  时仍然只能读松散 `.rpy`——这件事现在在 `scripts.reason`、成片的
  `sources: "default"` 与 `stats.unread` 里是可见的，但读不到还是读不到。
- **`screen` 体不是通用 Ren'Py 解释器**：只解析 `add` / `background` / `frame` /
  `window` / `text` 这几类行；条件与循环不求值（`if` 的两个分支都会按缩进继续
  遍历、不判断哪边会执行，`for` 的集合也不会展开），屏幕属性里的变量（包括
  `gui.*`）不求值，`use` 引入的屏幕不展开，`layeredimage` 之外的组合/条件逻辑也不展开。读不到的
  值按原设计回退到 `style` / `gui.*` / 默认值。
- **播放列表仍只在浏览器里播放**：循环/随机只控制 `<audio>` 的换曲行为，不写回
  游戏，也不支持无缝循环（`repeat one` 是把 `currentTime` 归零重播同一元素）。
- **SharedHouse 首次构建清单约 4.4 秒**（1.7 GB 归档，4089 个条目，195 个标签；修复前约 26 秒）。结果会按游戏缓存，只在首次/重读时付出；是否阻塞宿主事件循环尚未核实。
- **打字机在真实流式回复中的观感**尚未完成最终实机核验；逻辑、标签解析和设置读取已经落地，仍需在宿主中确认流式 DOM 更新、暂停和中断行为。

## 最近的根因修复（2026-10-13）

GUI 内出现的第一批信号是 `GET /renpy-skin/settings` → 404 与 `POST` → 405，
这证明没有任何路由被注册。原因是 **`webServer.register` 契约写错**：
插件传入的是 Web 风格的 `{ method, path, handler: (req) => new Response(...) }`
形状，而线上 DSH 契约是 Node 风格的
`{ kind: "exact", path, handler: (req, res) => {} }`。`lib/index.js` 已按该契约重写
（外加带 1 MiB 上限的 `sendJson` / `readJsonBody` 辅助函数）。
`node --check` 与 105 项测试套件均通过；运行中的宿主需要重启
才能加载这个已修复的模块。

## 第二个根因修复（2026-10-13）：挂载期服务竞态

在契约重写之后 404 依然存在，因为这些路由是通过
**挂载时一次性的 `ctx.get("webServer")`** 触达的。各行是并发挂载的，
因此当 `apply` 运行时 web server 可能仍不存在；守卫
随后静默跳过了*每一次*注册，SPA 回退便对整个 `/renpy-skin` 前缀
返回 404（而 `systemPrompt` 与 `tools` 当时看起来可用，因为它们在这次挂载里恰好赶上了
——**这个「恰好」是错的**，2026-10-18 的 P0.6 调查发现同样的竞态会让 4 个工具与整段
提示词一起消失，见下）。已通过
`ctx.inject(["webServer"], (webCtx) => ...)` 修复，它会挂起直到
该服务存在。`inject` 仍保持 `[]`：没有 web server 的配置档依然能获得
提示词区段、那些 Tool 以及 `renpySkin` 服务。

## 第四个根因修复（2026-10-18）：`systemPrompt` / `tools` 的同一种竞态

上一节把 `systemPrompt` 与 `tools` 判成「不同时刻解析，因此工作正常」，这个结论是错的。
2026-10-16 的一次真实会话（`session-0a77af4b-…`，standard 预设）暴露了症状：`request/header.tools`
里 **47 个工具，没有一个 `renpy_*`**；31 个 step 全是 reasoning，最后撞上 `max-tokens`；
`systemPrompt` 里也没有 stage-director 区段。日志里没有任何错误。

根因与 webServer 那次完全相同：两者都是挂载时一次性的 `ctx.get`。三处现在全部改为
`ctx.inject([...], (scoped) => ...)`，注册仍各自包在 `ctx.effect(...)` 里（用 scoped 的
effect，这样随服务一起销毁）。`export const inject` 依然为 `[]`——始终不出现的服务
只让它自己那一半不接线，其余照常工作。

**该修复已实机确认（2026-10-19 02:02，19487 的 `verify` 配置档）**：新会话的
`request/header` 是 30 个工具、其中 `renpy_configure` / `renpy_read_manifest` /
`renpy_save_vn` / `renpy_stage` 四个都在，`system/message` 里也有
`## Ren'Py stage director` 区段——即 `tools` 与 `systemPrompt` 两处 `ctx.inject`
在真实宿主里都回调了。当时桌面宿主（19387，PID 39652）还是修复前的模块；**2026-10-19
21:13:07 启动的桌面宿主（PID 33216，端口 27194）已在跑含该修复的构建**，证据见开头
「21:49 的实机复查」。

**样式表**也有同形状的 bug：它是通过
`globalThis.styles` 安装的，而后者只对 `cordis-client-runner` 通道存在。
Module Loader 包（`window.__ModuleLoader__.load`）永远拿不到它，因此
整个 `.rsk-*` 样式表被静默丢弃。`applyStylesheet` 现在回退为
直接创建 `<style>` 标签，这是 Module Loader 通道所认可的模式。

## 第三批根因修复（2026-10-14）

- **`ctx.locale` 是受门控的属性。** `applyLocale` 曾写
  `ctx.locale ?? ctx.get("locale")`，而 `??` 左侧会先求值 —— 属性访问在 `inject`
  里没有 `locale` 时直接抛 `cannot get property "locale" without inject`，控制台里
  就是那条 `locale registration failed`。现在先走无门控的 `ctx.get("locale")`，
  两侧都包在 try/catch 里。`locale` **不能**加进 `exports.inject`：那会把它变成
  必需服务，没有该服务的配置档会拒绝加载整个皮肤，正好违背「缺服务只降级」的约定。
- **换游戏后背景仍是上一个游戏的。** 三个真实游戏的主菜单背景都解析到同一个相对
  路径 `gui/main_menu.png`，于是 `assetUrl` 生成同一个 URL，而 `/asset` 带
  `cache-control: private, max-age=3600` —— 浏览器直接回放了自己缓存里那份**旧
  游戏**的字节。清单是对的，像素是错的；同一条路径下受影响的还有立绘、对话框贴图、
  选项背景与开场图。现在 `manifestFor` 每次构建都铸一个 `assetToken` 并写进每个
  资源 URL（`?v=…&p=…`），客户端自己拼 URL 的地方也带上它。该路由忽略 `v`：
  硬缓存只有在 URL 带 token 时才是安全的。
- **重载后两路音频叠加。** 单元素规则只在闭包内成立：重载后新闭包的
  `playerElement` 为空，上一份元素还在播，第一次点击又起同一首，两路互相拍打。
  元素现在停在 `globalThis.__dshRenpySkinAudio`，模块求值处先拆掉上一份，卸载时由
  `ctx.effect` 的清理函数释放。同类漏音还有「从文档中移除的 `<video>` 仍在播放」：
  跳过开场后片头曲会盖在主菜单音乐上，`dismiss()` 现在立即 `pause()`。
- **静态开场图永不结束。** `<img>` 不触发 `ended`，一张静态开场图会把界面永远留在
  splash 上。宿主端从 `timer N` 提取并钳制到 2–12 s（取最长者，缺省 4 s），
  客户端按 `splash.duration` 设截止时间，视频另有 180 s 兜底。

## 第五个根因修复（2026-10-19）：全归档游戏的 `/agent/prepare` 回 400

**症状。** 桌面宿主（27194 / PID 33216）已经加载了新构建，但
`node tools/verify-agent-load.mjs --port 27194` 的第三项失败：

```
FAIL  POST /renpy-skin/agent/prepare 由新构建提供（旧宿主只有 405） — HTTP 400
The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Array
```

这条路正是「用 Agent 加载」的第一步，所以在这个游戏上按钮**必然**在建会话之前就失败。

**根因。** `lib/scantree.js` 的「没有松散脚本」分支把句子又包了一层数组：

```js
? [archivedScripts > 0
    ? [`  - (no loose scripts; ${archivedScripts} …)`]   // ← 多套了一层
    : ["  - …"]]
: []
```

展开后 `blocks[].lines` 里出现了一个嵌套数组，`renderUnderBudget()` 用
`Buffer.byteLength(line, "utf8")` 量它的字节数时抛 `ERR_INVALID_ARG_TYPE`。**只有
「一份松散脚本都没有、脚本全在归档里」的游戏会走到这一支**——也就是 CSE 2.1.0 这种
商业发行版，以及这个分支的措辞本来要救的那类游戏。有松散脚本的游戏从不经过它，所以
单元测试一直全绿。

**修复。** 两个分支各自直接返回字符串（`lib/scantree.js:376-386`），并在注释里写明
「多一层数组会让 `Buffer.byteLength()` 直接抛，而这个分支只在全归档游戏上走到」。
新增回归用例 `test/scantree.test.mjs` 的「a game whose scripts all live inside an
archive still produces a map」：用真实 RPA-3.0 归档（索引取自
`test/fixtures/rpa-indexes.json` 的 `simple`）搭一个没有松散脚本的游戏，断言
`stats.scripts === 0`、`stats.archiveEntries.scripts > 0`、紧凑地图里出现
「no loose scripts; N compiled scripts live inside the archives」。

**修复后的直接验证（不经宿主）。** 对 CSE 的真实 `game/` 调 `scanGameTree()`：不再
抛错，`stats` 为 `{ files: 35, fonts: 30, scripts: 0, archives: 4,
archiveEntries: { images: 748, audio: 214, videos: 14, scripts: 29, total: 1005 },
compactLines: 50, compactBytes: 1723 }`，紧凑地图里那两行是
`- archives: 4 (1005 entries — images 748, audio 214, movies 14, scripts 29)` 与
`- (no loose scripts; 29 compiled scripts live inside the archives above)`。
完整测试 240 项、0 失败。**宿主内存里仍是旧模块，所以 `verify-agent-load` 要等下一次
由人重启之后才会转绿。**

## 已做的决策，及原因

- **零 npm 依赖。** 运行时依赖必须安装进
  配置档，而这恰恰是受阻的事情。Node 内置模块加相对导入
  让宿主端可以从任何位置加载。
- **设置存放在 `$DSH_HOME/renpy-skin/config.json`**（`DSH_RENPY_SKIN_HOME` 可覆盖），
  而非通过 `Config` schema。该配置档禁用了 `ui-settings`，且宿主依赖无法安装，
  因此持久化走插件自己的路由。schemastery 的 `Config` 形状记录在
  [CONTRACTS.md](CONTRACTS.md)，以备将来可行时使用。
  旧位置 `~/.dsh-renpy-skin` 会在进程内首次解析时**逐项合并**（缺的才复制、
  已存在的条目不动），所以这个搬家不会丢设置；
  用 `DSH_HOME` 而不是自己发明一个变量，是因为它已经是官方的配置目录（与
  `profiles/`、`sessions/` 平级），`dsh-better-sidebar` 与 `dsh-our-free-model`
  也按同一语义读它。
- **手写 `lib/client.js`。** 打包器会引入一个配置档
  无法运行的构建步骤；lazy-CJS 工厂封装则不需要。
- **角色调查 / 学习模式目前被砍掉**，遵照用户的
  指示；范围只包含功能性内容。
- **profile 目录键固定用扫描名。** `manifestFor()` 在覆盖层之前把
  `scannedName` / `profileName` 定进 record。覆盖层能改 `game.name`（实测
  `CSE-2.1.0-pc` → `CSE`），若目录键跟着改过的名字走，保存后下一次构建会去
  另一个目录找 `vn.json`，覆盖层等于自己撤销自己。
- **`sources` 记录最终值的来源，`default` 与 `profile` 都是一等公民。**
  `default` 明确表示「什么都没读到、用了插件默认值」；覆盖层改过的字段把
  `sources[path]` 改写成 `profile`，同时记进 `profileApplied`。合并后还留着
  扫描来源，会让一个被修正过的值看起来像扫描读到的——这正是 `sources` 要
  消除的混淆。
- **`null` 与 `undefined` 都表示保留扫描值。** `renpy_read_manifest` 返回的五个
  覆盖段与 `renpy_save_vn` 的输入同名；若只跳过 `undefined`，Agent 把回执拷回去时
  `null` 就会被当成要写入的值。
- **反编译失败仍然降级，但不再静默。** 能力边界没变（没有 Python / `unrpyc`
  就读不到编译脚本），新增的是 `rpycDiagnostics()`、`scripts.reason` 与
  `sources` 里的 `default` / `unread`：现在能诊断「读不到」，而不是把它当成
  「游戏本来就这样」。
- **`inject = []`，但三个可选服务用 `ctx.inject` 等待。** 缺失一个服务只会让
  插件降级，而不会令其激活失败；但**不能**在挂载时 `ctx.get` 一次——晚挂载的服务
  会被永久错过，表现为「请求里少了 4 个工具」而日志里没有错误。`ctx.get` 对未注入
  的名字还会直接抛错，这也要靠 `inject` 规避。
- **不切预设。** 平台没有运行中改预设的 API：`agentPresets` 只有 `resolve`/`mount`，
  且只在创建 Agent 时通过 `meta.agentPreset` 生效；经 `agents.create(...)` 建出来的
  会话不进入 Shell 的会话列表，用户看不见。`renpy_*` 工具是全局注册的，所以按钮只做
  「准备→建工作区→开新会话→投递」，persona 由用户自己在 composer 里选。
- **失败要说原因，不兜底。** 加载链路任何一步失败都 abort 并把宿主原话显示出来。
  自动复制到剪贴板会让「已发送到新会话」这句话在什么都没发生时也照说。
- **设置项只改呈现层，不改键名。** 「背景亮度」是把 `backgroundDim`
  （压暗量）按 `1 − v/100` 呈现，存储的键名与语义都没动。改键名会让所有调过这个
  滑块的人静默回到默认值，而收益只是让名字好看一点。

## 如何重新验证

```sh
node --test "test/*.test.mjs"
node tools/check-doctor.mjs
node test/manifest-probe.mjs "<一个 Ren'Py 游戏目录>"
node test/manifest-probe.mjs "<一个只有 .rpa 的游戏目录>"
```

`check-doctor` 回答「这份清单可不可信」：打印 Python 与 `unrpyc` 的实际位置和
放弃原因、逐个打开 `.rpa`（连同里面的脚本数）、指出两份数据目录并存；当游戏
只有编译脚本而 `unrpyc` 又不可用时以 1 退出。探针会打印提取出的清单摘要、
发现的标签与变换，以及九条舞台语句（预期五条通过，四条被拒绝并给出替代项）。
