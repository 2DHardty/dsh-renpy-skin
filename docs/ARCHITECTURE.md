# 架构说明

## 整体形态

一个 DSH 插件包是**一个 npm 包，包含两半**：

- **宿主端**（host half）—— Node，运行在 DSH 进程中，可以注册工具（Tool）、提示词
  段落和 HTTP 路由；
- **客户端**（client half）—— 运行在浏览器中，可以注册 UI 插槽和主题色变量。

它们之间除了双方都使用的 HTTP 路由和清单之外不共享任何东西。本插件的整体设计源自
三条约束：零运行时依赖、无构建步骤、不修改 DSH 源码。

```
Ren'Py game directory
        │
        │  lib/renpy.js      read .rpy text: gui.* / config.*, style & screen bodies,
        │                    Character(...) declarations, transform / layeredimage
        │  lib/rpa3.js       read .rpa archives when scripts are packed
        │  lib/rpyc.js       decompile .rpyc bytecode via unrpyc when only .rpyc ships
        ▼
   lib/manifest.js          →  asset manifest + sources/scripts diagnostics
        │                       (one per gameDir, cached)
        │
        ├──────────────► lib/stage.js   parse + apply Ren'Py display statements
        │
        ├──────────────► lib/scantree.js  two listings: compact map + full file tree
        │                                    │
        ▼                                    ▼
  host half: lib/index.js  ──── HTTP /renpy-skin/* ────►  client half: lib/client.js
   • 13 routes                                           • shell.overlay (stage / say-screen modules)
   • systemPrompt section                                • background CSS on the conversation body
   • renpy_stage Tool                                    • settings.section
   • renpy_configure Tool                                • theme.overrideTokens
   • renpy_save_vn Tool                                  • skin CSS (dialogbox / choice)
   • renpy_read_manifest Tool                            • header utilities (settings / music / memory)
   • renpy_memory Tool                                   • dialogue-plate picker + memory panel
   • lib/audio.js durations                              • splash layer + playlist player
   • lib/home.js  data directory                         • profile watch + completion prompt
   • lib/memory.js  cross-session memories
```

## 宿主端

### `lib/index.js` —— 插件行

`export { apply, inject, name }`，其中 `inject = []`。这一行没有硬依赖，但三个服务
（`systemPrompt`、`tools`、`webServer`）各自用 `ctx.inject([...], (scoped) => ...)`
等待——**不是** `ctx.get`。各行使并发挂载，一次性读取可能在服务缺席时返回
`undefined`，注册就被静默跳过；对未注入的名字 `ctx.get` 还会直接抛错。用 `inject`
之后，始终不出现的服务只让它自己那一半不接线，其余照常工作。共五个关注点：

1. **状态** —— `manifestCache`（`gameDir → built manifest`）、`sessionGames`
   （按会话覆盖的 `gameDir`）、`sessionSafeAreas`、一个 `StageStore`，以及
   持久化的设置对象。
2. **提示词** —— 两个段落：`renpy-skin:stage-director`（排在 `PLAN_POLICY` 之后；
   除非 `promptInjection` 已开启**且**游戏目录已配置且可读，否则返回 `""`，因此未配置
   的插件对模型是不可见的，而不是嘈杂的）与 `renpy-skin:roleplay`（排在其后，只对
   `agentPreset === "renpy-scene"` 的会话生效，见下文「智能体预置」）。两者在同一个
   `ctx.inject(["systemPrompt"], ...)` 里注册，因为一个可选服务只应被等待一次。
3. **工具** —— `renpy_stage`（驱动立绘）、`renpy_configure`（加载/切换
   VN）、`renpy_read_manifest`（只读：把清单以 JSON 代码块交回；其中
   `game` / `dialogbox` / `layout` / `choice` / `theme` 与保存时的可覆盖段同名，
   回执另带 `sources`
   （每个值来自 `screen` / `style` / `gui-variable` / `conventional-path` /
   `character-declaration` / `profile` / `default` / `unread`）、`scripts`（脚本发现与
   反编译诊断）、`stats` 三个诊断段，
   以及 `characters` 角色声明表与 `spriteTags` 标签清单（都是只读诊断；保存时
   另有对象形状的 `characters` / `sprites` 覆盖段，见下））、`renpy_save_vn`
   （把 Agent 对这个游戏的
   结论写成 VN 配置文件）与 `renpy_memory`（按角色读写跨会话记忆，落在
   `game/<扫描名>/memory.json`，`lib/memory.js`）。前两者返回结构化的拒绝结果而不是抛出异常：
   `StageError.details` 会被展开进结果中，让模型看到*确实*存在什么。写文件必须由
   宿主来做——Agent 自己的文件工具被限制在它的工作区内，而配置文件要落在插件的
   数据目录里。
   覆盖层的合并规则都在 `lib/vn.js`：`profileOverlay` 丢掉 `OVERLAY_SECTIONS`
   名单之外的段，`applyProfile` 报出改掉的字段路径，`profileBelongsToGame` 保证
   同名但不同路径的游戏不会互相换肤（不符的 profile 记进 `profileRejected`，
   `GET /vn` 会把它读出来）。段名单是 `game` / `dialogbox` / `layout` / `choice` /
   `theme` / `transcript` / `characters` / `sprites`；`characters` 与 `sprites` 逐条
   逐字段合并（`applyCastPatches()` / `applySpritePatches()`）；`characters` 可以补上
   扫描时没有声明的变量，`sprites` 则按 `tag` 或 `name` 命中扫描记录，匹配不到只进
   `diagnostics.unmatched`、不新建记录（新记录需要 asset URL，只有扫描能铸）。
   `null` 与 `undefined` 都表示「保留扫描值」，`game` 段也是逐 key 合并（`screen`
   再浅合并一层），不再整段替换。`inspectProfileConfig()` 返回
   `{ accepted, ignored, malformed, unknownKeys }`（`accepted` 是至少有一个键会被
   读取的段名）；`renpy_save_vn` 的回执把 `applied`（清单里真正被覆盖的字段路径，
   已剔除拼错的键）、`ignored`（段名不在名单里）、`malformed`（段名对但值不能用）、
   `unknownKeys`（拼错、仍被写入但不计入 `applied`）、`unmatched`（匹配不到立绘
   记录）与 `unresolved`（保存前试探后仍解析不到的资产路径）分开报。`dryRun: true`
   不写文件、不清缓存：它在扫描清单的深拷贝上跑同一套 `applyProfile()`，所以
   `applied` 与真实保存一样是字段路径（已剔除 `unknownKeys`）；`unmatched` 来自
   该探针在合并 `characters`/`sprites` 时记下的匹配失败项，`unresolved` 照常逐项试探；返回
   `wouldWrite: { tree, summary, vn }` 与上述字段。
   profile 的目录键固定成**扫描名**：`manifestFor()` 在覆盖层之前取
   `scannedName = manifest.game?.name`，再由 `profileDirName(scannedName)` 得到目录。
   覆盖层可以改游戏名（`CSE-2.1.0-pc` → `CSE`），如果目录键跟着改过的名字走，
   保存 profile 后下一次构建会去找另一个目录，覆盖层等于自己撤销自己。
   `applyProfile()` 之后还有一次 `rederiveAssets()`：覆盖层只把字符串复制进清单，
   而资产 URL、贴图几何（`textboxImageBounds` / `textboxImageBox` /
   `nameboxBounds`）与 `fontUrl` 都是**派生值**，必须按当前 `assetToken` 重算。
   否则 profile 写 `gui/mine.png`，浏览器会拿到裸路径；改 `dialogbox.font` 后
   `fontUrl` 仍是旧的。重查 `manifest.fonts` 时优先用改过的 `fontPath`，否则按
   `dialogbox.font` 的路径或文件名匹配；找不到对应字体时清空 `fontUrl`（Ren'Py 自带的
   `DejaVuSans.ttf` 在引擎里、不在游戏里，指过去只会 404）；取不到图片字节时把
   几何清成 `undefined`，而不是留着上一次的值。
4. **路由** —— [CONTRACTS.md](CONTRACTS.md) 中的十一个端点，包括用于整份皮肤配置的
   `GET /export` 和 `POST /import`、只读的 `GET /vn`、可按目录前缀与子串过滤归档
   资源的 `GET /media?under=&match=`，以及写两棵目录树的 `POST /agent/prepare`
   （`lib/scantree.js`）。
5. **智能体预置** —— `cordis.patch.yml` 还会插入 `preset-renpy-skin`
   （`@deepseek-ai/dsh-agent-preset`），它唯一的插件是一个
   `@deepseek-ai/dsh-persona`，只写身份、四个工具各一句话与三条规则（不编造
   目录、遵守设置里的立绘上限、不做角色调研）。「发现 → 加载 → 定制」的流程
   **单一承载**在按钮提示词里——两份副本曾经在「只给名字要不要自己扫盘」上
   互相打架。
   第二个预置 `preset-renpy-scene`（展示名「在场」，order 60）把同一套机制用在
   角色扮演上：persona 承担「用户是到场的人、角色由模型扮演、每轮回复至少一次
   `renpy_stage`、剧情涉及其他角色就完整上台」的演法，
   `@deepseek-ai/dsh-time-context`（`refreshIntervalMs: 0`，每个合格 step 一条
   时间快照）承担「现在几点、距上次多久」，舞台语法与角色名册仍由
   `directorBrief` 那段全局注入的舞台说明提供——三份信息刻意不重复。它的工具面
   收窄到 persona + 时间上下文 + 压缩：`renpy_*` 本来就是全局注册的，这场戏
   不需要 shell。
    **角色扮演的第四份信息由宿主注入**：`roleplayBrief`（`lib/index.js`）只对
    `agentPreset === "renpy-scene"` 的会话生效（会话头里的 `agentPreset` 由
   `session/event` 缓存，`sessionIdOf(assembly)` 取 id），内容是用户在戏里的名字
   （全局 `playerName` 或按会话覆盖的 `sessionNames`）、用户追加的
   `roleplayPrompt`，以及每个角色「记得的事」——来自
   `game/<扫描名>/memory.json`（`lib/memory.js`）：模型用 `renpy_memory` 追加，
   用户在设置页或顶栏记忆面板里编辑，两条路径写同一个文件。名字、额外要求与记忆
   都放在**角色扮演**这一段而不是全局舞台说明里：舞台说明是所有会话共用的，
   记忆只属于这场戏。
   注意：**宿主不会替用户切预设**。平台没有运行中改预设的 API（`agentPresets`
   只有 `resolve`/`mount`，且只在创建 Agent 时生效），所以按钮只做「准备→建工作区→
   开新会话→投递」，persona 由用户在 composer 里自己选。`renpy_*` 工具是全局注册的，
   与预设无关。

设置项由这些路由提供，存放在 `$DSH_HOME/renpy-skin/config.json`
（`lib/home.js` 解析，`DSH_RENPY_SKIN_HOME` > `DSH_HOME/renpy-skin` >
`~/.dsh-renpy-skin`；旧目录与数据目录之间是逐项合并，缺的才复制、已存在的条目
不动，只复制不删），而不是 `Config` schema（模式）—— 理由见 [STATUS.md](STATUS.md)。

### `lib/renpy.js` —— 读取 `.rpy`

有意只做*读取器*，而不是解释器：

- `stripComments` 能识别字符串，所以 `"a # b"` 不会被破坏。
- `evalValue` 只理解字面量 —— `_(...)`、带引号的字符串、数字、
  `True`/`False`/`None`、元组、`Borders(...)`。它无法求值的表达式返回
  `undefined`，调用方回退到游戏自身的默认值。它从不猜测。
- `readAssignments` 逐行收集 `gui.*` / `config.*` 赋值。
- `readStyleBlocks` 解析 `style <name>:` 块。清单对**全部**脚本调用它与
  `readScreenBlocks`：真实游戏常在自己的 `newScreens.rpy` 里重写整个 `screen say`，
  按固定文件名挑脚本会一个值都读不到，而清单仍照样生成。
- `readScreenBlocks` 解析 `screen <name>:` 的屏幕体，返回每个屏幕自身的属性和其中
  `add` / `background` / `frame` / `window` / `text` 这几类行（每项带原始文本、属性、
  嵌套深度与祖先容器）。关键字可以单独成行，也可以单行内联
  （`frame: pos (265,798)`）；后者让真实 `say` 屏幕的几何能被读到。它只按缩进切块，
  不求值；命中手机变体（`variant "small"` 或 `@variant small` 等，按
  `small|touch|mobile|android|ios|tablet|phone` 判断）会被跳过，同名屏幕后定义
  覆盖先定义。
- `readCharacterDeclarations` 解析 `define qc = Character('启诚', color="#624B34",
  image="qc")`（以及 `default`）这类声明，支持多行参数与 `color` / `image` 关键字参数，也接受
  `DynamicCharacter` 等以 `Character` 结尾的构造函数。它只记录声明，不跟踪变量
  后续被重新赋值；`image=` 指向的 tag 在立绘索引里不存在时由清单标
  `spriteTagUnresolved`。
- `readTransforms` 遍历以缩进划分作用域的 `transform <name>:` 块，同时记录
  属性和 ATL 结构。
- `readLayeredImages` 遍历以缩进划分作用域的 `layeredimage <name>:` 块，
  记录每个 `group` 的属性以及哪些是 `default null`（无图层）。
- `listFiles` 会跳过 `cache`、`saves`、`tl`、`__pycache__`、`.git` 和 `renpy`。

### `lib/rpa3.js` —— 读取 `.rpa`

一个 RPA-3.0 归档由一行头部 `RPA-3.0 <hex index offset> <hex key>` 开头，
后面跟一个 `name → (offset, length, prefix)` 的 **pickle** 字典，其中
`real offset = offset ^ key`。所以这个文件里包含一个小型 pickle 操作码虚拟机。
它实现了 Ren'Py 归档器实际会生成的操作码（约 55 个），并且对
`REDUCE` / `INST` / `OBJ` / `GLOBAL` / `PERSID` **抛出 `RpaError`**，而不是
执行它们 —— 仅仅被读取的归档绝不应该能够运行代码。

手写而不是引入 `@dynamicaaa/rpx`，因为运行时依赖必须安装进配置档，而
这正是被阻断的事。

### `lib/rpyc.js` —— 反编译 `.rpyc`

一个只有字节码的游戏会在其归档中携带 `.rpyc`，而没有配套的 `.rpy`。本模块
调用社区工具 `unrpyc`（Python ≥3.9）把这些数据块还原成 `.rpy` 源码，供清单其余
部分照常解析。工具位置按顺序探测：设置页填的 `unrpycPath` → `DSH_RENPY_UNRPYC`
指定的文件 → 插件自带的 `vendor/unrpyc/unrpyc.py` → 工具目录（设置页填的
`toolsDir` → `DSH_RENPY_TOOLS` → `~/Tools`）下按版本号排序的最新的 `unrpyc*`
检出里的 `unrpyc.py` → 该目录下的 `unrpyc.py` → 当前工作目录下的
`unrpyc.py`（最后一项是裸文件名）。设置页与环境变量里的 `unrpycPath` 也可以填
**检出目录**：是目录时自动找其中的 `unrpyc.py`，因为安装说明交给用户的就是
`...\unrpyc-2.0.4` 这样的目录；目录里没有该文件时，诊断会明说「你填的是目录，
里面没有 unrpyc.py」，而不是把它当成一个不存在的文件列出来。Python 同样按设置页的 `pythonPath` →
`DSH_RENPY_PYTHON` → DSH 自带的运行时
（`$DSH_HOME/dsh-runtimes/*/dependencies/python/`）→ PATH 探测。设置页与环境变量
都属于**显式选择**：设了却跑不起来就报告失败，绝不悄悄回落到自动发现——否则
用户看到的是「我明明指定了工具，读出来的还是默认值」。它从不抛出异常：
解释器/工具缺失、数据块损坏或非零退出码都会降级为 `null`（或空的批量映射），
因此即使没有 Python，资源发现仍能工作；区别在于现在这件事**可见**——见下。

- `isRpyc(buffer)` —— v2 魔数是字面量 ASCII `RENPY RPC2`；旧版 v1 没有
  头部，以 zlib 帧（`0x78`）开头。
- `decompileRpyc(bufferOrPath)` —— 一个数据块，一次子进程调用。
- `rpycDiagnostics({ refresh? })` —— 不反编译，只回答「这台机器能不能反编译、
  为什么不能」。返回 `{ python: { path, source, checked, reason }, unrpyc: { path,
  source, tried, toolsDir, toolsDirSource, reason }, reason, usable, install }`；
  `source` 说明命中哪一级（`setting` / `environment` / `dsh-runtime` / `vendor` /
  `tools` / `home` / `path`），进程内缓存（`refresh: true` 重探）、永不抛，
  `install` 是一段可复制的下载与解压指令（`unrpyc` 不在 PyPI 上）。
- `configureTools({ python, unrpyc, toolsDir })` —— 宿主把设置页的三个工具路径
  推进来；只改传入的字段，并让诊断缓存失效。设置页的值压过环境变量，因为用户
  在界面上填的路径是他刚刚做出的选择。
- `decompileRpycBatch(entries)` —— 批量入口，返回 `{ files, diagnostics }`；每
  32 个文件跑一次 `unrpyc` 子进程、总预算 5 分钟，`diagnostics` 形如
  `{ reason, attempted, decompiled, failed }`，`reason` 为 `null` 表示全部成功，
  否则说明是哪一半缺失或哪几个文件失败。清单用的就是这个，因为一个游戏可能有
  几十个 `.rpyc`，而每个文件启动一次子进程太慢。
- `decompileRpycMany(entries)` —— 历史入口，等价于
  `decompileRpycBatch(entries).files`，保持返回 `Map` 的旧类型。
- 环境变量开关（设置页的 `pythonPath` / `unrpycPath` / `toolsDir` 优先于它们）：
  `DSH_RENPY_PYTHON`、`DSH_RENPY_UNRPYC`、`DSH_RENPY_TOOLS`、`DSH_RENPY_RPYC_DEBUG`。

### `lib/audio.js` —— 媒体时长

`readAudioDuration(head, tail, size, extension)` 以及
`DURATION_EXTENSIONS`（`.wav`、`.mp3`、`.ogg`、`.opus`、`.flac`）。它的存在
是为了让播放列表能丢掉时长不足 10 秒的短音效，而且它有意**不是**一个元数据库：
调用方传入文件最前和最后的 64 KiB，这些容器需要的也仅此而已。

**它从不抛出异常** —— 每个分支都在一个返回 `undefined` 的 `try/catch` 内，
因为「时长未知」必须意味着「保留该曲目」，而绝不是「让清单失败」。手写而不是
从 npm 引入：一个只读时长的读取器只有几百行，而且这个宿主端按契约必须无依赖。

- WAV —— `fmt ` 字节率和 `data` 块大小；流式的 `0xFFFFFFFF`
  大小回退为 `(size - dataOffset) / byteRate`。
- MP3 —— 跳过 ID3v2（同步安全的大小和可选尾部），找到帧同步，然后优先采用
  精确的 Xing/Info 帧计数，其次是 VBRI，最后才用 CBR 估算。**CBR 估算是唯一
  薄弱的分支**：一个真正 VBR 且没有标签的 MP3 可能偏差几十个百分点（实测：
  报出 5.54 s，而 ffprobe 为 3.25 s）。它仍然落在 10 s 过滤器的正确一侧，而
  这就是全部契约 —— 绝不要把这类数字展示给用户。
- Ogg/Opus —— 两者都是 Ogg 页；时长由**最后一个**页的 granule 携带
  （Opus 用 `/48000`，Vorbis 用 `/sampleRate`，从标识包读取，并有文档化的
  44100 回退值）。
- FLAC —— STREAMINFO 的总采样数除以采样率。

对于小文件，`head` 和 `tail` 可以是同一个缓冲区；短于 16 字节的 `head`
返回 `undefined`，而不是读取越界。

### `lib/memory.js` —— 跨会话角色记忆

`game/<扫描名>/memory.json` 的读写：一个纯 `{ "<tag>": "文本" }` 映射，没有版本号、
没有元数据——它只属于「在场」预置，谁读它谁就同时是作者。导出
`readMemories` / `writeMemories` / `appendMemory` / `replaceMemory` /
`memoryHeads` / `clampMemory` 与四个常量（`MEMORY_LIMIT` 8000、
`MEMORY_HEAD` 1200、`MEMORY_HEAD_COUNT` 12、`memoryPath`）。

- 每个角色的文本上限 `MEMORY_LIMIT` 字符，超出时 `clampMemory` **保留最新内容**并按
  行边界截断，返回 `{ text, trimmed }`。记忆是随时间生长的东西，丢开头比丢结尾安全。
- `memoryHeads(memories, order)` 是注入用的视图：按清单顺序（而不是文件里的键顺序）
  最多取 `MEMORY_HEAD_COUNT` 个角色，每个截到 `MEMORY_HEAD` 字符并在前面加一行 `…`，
  另返回被省略的角色数。`roleplayBrief` 用它把「记得的事」放进系统提示词——一次
  注入必须有上限，否则一场长戏的记忆会把每一轮的上下文吃掉。
- 文件坏掉（不是 JSON、不是对象、值不是字符串）一律当作「还没有记忆」，写不进去
  返回 `false` 而不是抛错：记忆是锦上添花，绝不能让清单、工具或提示词组装失败。
  写空的角色条目等于删除它，整份为空时文件本身被删掉。

### `lib/manifest.js` —— 资源清单

最大的模块，也是每个目录只运行一次的模块。一次构建分成四步：

1. **索引** —— 对游戏目录执行 `listFiles`；`readImageSize` 读取真实的
   PNG/GIF/WebP/JPEG 头部以获取尺寸，因此立绘可以被正确缩放。
2. **读脚本** —— `readScriptSources` 按松散 `.rpy` → 松散 `.rpyc` → 归档内 `.rpy`
   → 归档内 `.rpyc` 的优先级为每个脚本选一份；只有选到 `.rpyc` 时才把它交给
   `lib/rpyc.js`。它同时产出 `manifest.scripts`（发现了多少、真正解析到多少、为什么
   没读到、`tool` 是什么）。
3. **声明** —— `readImageStatements` 遍历 `image` 语句。它对括号和引号做配平，
   因此多行的 `im.MatrixColor(` 声明也能解析；没有字面量路径的声明会被标记为
   `dynamic: true`，改为按名称对照索引解析。`readStyleBlocks`、
   `readScreenBlocks` 与 `readCharacterDeclarations` 从**全部**脚本里读 `style`
   块、`screen` 体与角色声明；`gui.*` 变量仍只从 `gui.rpy` / `options.rpy` /
   `screens.rpy` 的 `readAssignments` 读。
4. **组装** —— `gui.*` 的值、屏幕体与 `style` 块变成 `dialogbox` / `layout` /
   `choice`；强调色变成 `theme` 主题色变量映射；立绘变成 `tags`；角色声明另成
   `characters`。每个值由 `firstDefined(field, candidates, fallback)` 尝试并记下
   来源（`manifest.sources`），全落空时记 `default`。

清单里另有三段溯源与诊断信息，回答「这个值是读到的还是猜的」：

- `sources` —— 每个字段最终值的来源：`screen`（屏幕体）、`style`、`gui-variable`、
  `conventional-path`（约定路径）、`character-declaration`、`default`（什么都没
  命中）、`profile`（被 vn.json 覆盖层改过）。整块读不到的角色表记 `unread`；
  `dialogbox.textboxImage` 另有 `gui-variable` / `style-window` / `screen` /
  `conventional-path` / `none` 这套历史取值。`applyProfile()` 返回的每个字段路径
  都会把 `sources[path]` 改写成 `profile`，同时记进 `profileApplied`——清单因此
  不会把覆盖层修正过的值误报成扫描读到的。**底板候选**（`dialogbox.candidates`）
  用同一批名字再加一个 `sweep`（按 `textbox|say|dialogue|message` 扫全库的兜底），
  收集顺序即优先级；`candidates[0]` 由 `rederiveAssets()` 强制对齐 `textboxPath`，
  否则覆盖层换过盘之后，选盘器会把旧的扫描结果当成当前项。
- `palette` —— 八个颜色槽位（`accent`、`hover`、`idle`、`text`、`uiText`、`name`、
  `choiceIdle`、`choiceHover`）按固定顺序列成 `{ key, value, source }`，设置页据此
  逐项渲染取色器。`text` 是文本框（对话框）里的文字、`uiText` 是 DSH 界面自身的
  文字，两者的默认值相同但来源不同：`text` 走 `screen` / `style` / `gui.*` 候选，
  `uiText` 未覆盖时就是**没有被 `text` 覆盖影响**的那个游戏对话文字色（来源记
  `dialogue-text`），否则钉住其中一个会连带改掉另一个。
  游戏没声明 `gui.accent_color`（`sources["theme.accent"] === "default"`）时，用
  `pngDominantColor()`（`lib/png.js`，与 `pngOpaqueBounds` 共用块解析 `readChunks`）
  从对话框底板图片采样主色，失败再试名字框；命中时来源记 `image-sample`，且只有
  `hover` / `nameColor` 自己也是 `default` 时才跟着变，否则会把没人选过的颜色盖掉。
  设置页的 `paletteOverrides` 排在所有候选之前，来源记 `settings`；`theme` 的十个
  token 全部由覆盖后的 accent 重新派生，`--dsw-alias-label-primary` 另取 `uiText`。
- `scripts` —— `{ found: { looseRpy, looseRpyc, archivedRpy, archivedRpyc, total },
  decompiled, attempted, skippedByCap, unreadable, reason, tool }`；`decompiled`
  是真正解析到文本的份数，`attempted` 是交给反编译器的候选数；`reason` 为
  `null` 表示至少有一份脚本解析成功，一份都没有时才是一句人话（例如没有任何
  脚本被发现）；`tool` 是 `rpycDiagnostics()` 的完整探测结果
  （`{ python, unrpyc, reason, usable, install }`），在 `buildManifest()` 里无条件
  补上。它和前面的计数回答的不是同一个问题：`attempted`/`decompiled` 是「这一次
  跑通了吗」，`tool` 是「工具到底在不在这台机器上」。合成一个字段就分不清「游戏
  没有脚本」与「装了 `unrpyc` 才读得到」。批量反编译自己的 `reason` 与计数已经
  并入 `attempted`/`decompiled`/`reason`，不再单独出现在 `tool` 里。
  最多反编译 48 个脚本，超出的计入 `skippedByCap`。
- `characters` —— `Character(...)` 声明表，按变量名索引，每项带 `name`、
  `color`、`image`；`image=` 指向的 tag 不在立绘索引里时带
  `spriteTagUnresolved: true`。它与 `tags` 是两回事：`tags` 是扫描出的立绘桶，
  `characters` 是游戏自己声明的角色。

有几处关键细节：

- **图像名称只按空白字符切分。** `art-angry-a-l.webp` 必须变成属性
  `angry l`，而不是三个属性。
- **`spriteIndex` 从不设上限**，而 `sprites`（200）和每个标签的
  `expressions`（24）会设上限，纯粹是为了传输体积。校验读取的是
  `spriteIndex`，所以被裁剪过的立绘仍然可用。两个「截断」现在各有名字：
  `stats.assetsIndexTruncated` 表示 20000 条资源索引上限被撞到，
  `stats.spriteListTruncated` 表示展示用的 200 条立绘被裁剪；`stats` 还新增
  `characters`（声明数）、`assetDirs`（文件数前十的目录，`{ dir, count }`，摘要里
  没有路径清单时靠它决定 `/media?under=` 去哪找）与 `unread`（整块读不到的分区名）。
- **`layeredimage` 标签是带 `layers` 映射的单个立绘。** 一个 `layeredimage`
  角色（例如带有 `body`/`face`/`hand`/`glasses` 分组的 `enid`）会变成单个
  立绘，其 `attributes` 是每个分组所有非 `default null` 属性的扁平并集，外加
  一个 `layers`（group → attribute → url）映射和一个 `base` 变换。客户端把这
  些选中的图层叠放在同一个框内。

### `lib/scantree.js` —— 两棵目录树

`scanGameTree()` 生成 `scan-tree.md`（紧凑地图，硬预算 400 行 / 12 KB）与
`scan-tree.full.txt`（完整遍历，上限 20000 条）。紧凑地图的顺序是目录 → 归档 →
脚本与配置：**归档区块在脚本区块之前**，因为一个把全部脚本编译进 `scripts.rpa`
的游戏若先打脚本，会被读成「这游戏没有脚本」。首块因此有
`- archives: N (M entries — images …, audio …, movies …, scripts …)` 与
`- unreadable archives: …` 两行，`- files:` 行也补了脚本数；`stats` 里对应
`archiveEntries` 与 `unreadableArchives`。空脚本不再断言「游戏没有」，而是说明
松散脚本为零、归档里有多少；空角色表则把 `scripts.reason` 直接带出来。

### `lib/stage.js` —— 舞台

`tokenize` → `parseStatement` → `applyStatements`，外加 `StageStore`。

- `BUILTIN_TRANSFORMS` 对应 Ren'Py 的位置预设。
- `resolveTransform` 优先使用内置变换，其次是游戏自定义变换，然后把内联的
  `Transform(...)` 属性合并到结果之上。
- `StageStore` 以会话 id 为键。舞台绝不会在对话之间泄漏。
- 快照必须是**无损 JSON**：宿主会拒收任何值为 `undefined` 的键，整份工具结果作废。
  所以没有背景时 `scene` 键缺席，分层立绘（`layeredimage`）没有单一 `url` 键、
  改由 `activeLayers` 逐层绘制。
- `applyStatements` 是自我纠错契约被强制执行的地方：每一次拒绝都是一个
  携带 `details` 的 `StageError`，其中列出确实存在的名称。
- 安全区冲突**默认只警告**，只有在 `autoAvoid` 开启时才移动立绘。显式给出的
  `xoffset`/`yoffset` 视为有意覆盖，绝不会被报告。

## 客户端

`lib/client.js` 是在 lazy-CJS 工厂封装
（`window.__ModuleLoader__.load({ id, factory })`）中手写的，只依赖平台种子键
`react`。它*不*由打包器构建 —— 这正是没有工具链的配置档也能加载它的原因。

它注册了：

| 插槽 | id | order | 组件 |
| --- | --- | --- | --- |
| `shell.overlay` | `renpy-skin:modules` | −890 | `ModulesLayer` |
| `shell.overlay` | `renpy-skin:popover` | −880 | `PopoverLayer` |
| `shell.overlay` | `renpy-skin:splash` | −870 | `SplashLayer` |
| `shell.overlay` | `renpy-skin:profile-prompt` | −860 | `ProfilePromptLayer` |
| `settings.section` | `renpy-skin` | 120 | `SettingsPage` |
| `conversation.session.header.utilities` | `renpy-skin` | 60 | `HeaderUtilities`（seat: primary） |
| `conversation.header.leading` | `renpy-skin:fallback` | 60 | `HeaderFallback`（seat: fallback） |

**立绘舞台不是插槽。** 它由 `applyStageLayer()` 直接追加到
`[data-conversation-content]` 的第一个子节点：`shell.overlay` 是整帧的绝对定位
兄弟层（`z-index: 20`），注册在那里的立绘会盖住侧边栏与消息文本。放进对话主体后，
样式表把滚动区（消息 + 输入框）抬到 `z-index: 1`，舞台留在 `z-index: 0`，立绘
因此只是会话列里的背景美术——既不会盖住输入框，也不可能越过列边界盖住会话列表。
宿主会在切会话时重建这个主体，所以该效果同时听 store 与 `MutationObserver`，
只在宿主元素（或自己）断开时重新挂载。

**当前会话 id 不能只看 URL。** 桌面壳的地址是 `dsh-app://app/`，没有 `?session=`；
它把当前会话写在渲染中的 `[data-conversation-session]` 与
`localStorage["dsh.sessions.current"]`（JSON 信封）里。`currentSessionId()` 依次读
URL（`?session=` / `#/session/<id>`）、渲染中的会话、`dsh.sessions.current`、旧的
`dsh.session`，最后才回落 `global`。少读后两种时，工具按 `exec.agent.id` 写一个
舞台桶、浏览器轮询 `global` 另一个桶——命令回执照样 ok，界面永远不动；`/manifest`、
`/vn`、`/memory`、`/media`、`/export` 与布局/对话框的会话参数同样会错位。

`shell.overlay` 里最上面的一层是完成弹窗 `ProfilePromptLayer`（order −860）：
点过「用 Agent 加载」且提示词投递成功后，`startProfileWatch()` 每 3 秒读一次
`GET /vn`（上限 10 分钟），`profile.savedAt` 变化就弹出这句话的模态——「立即更换」
重拉一次清单，「先保存」、Esc 与点遮罩都只是关掉。它是唯一带遮罩的图层，所以样式表
里有一条 `.rsk-prompt { pointer-events: auto !important; }`，理由与下面覆盖层的
`pointer-events` 规则相同。

**「用 Agent 加载」的顺序是加载链路的全部要害**：`POST /agent/prepare`（宿主准备游戏、
写两棵树、返回真实路径）→ `agentLoadPrompt(facts)`（把路径与计数写进提示词）→
`loadWithAgent`（建工作区 → `startSession` → 等新会话 id → `session.prompt`）。
**任何一步失败都 abort**，面板显示具体原因；剪贴板只是失败之后用户可点的备用动作，
绝不自动执行——自动复制会让「已发送」的谎话说得毫无阻碍。宿主没准备好时不能先投递：
提示词里写着 `scan-tree.md` 的真实路径，反过来的顺序会让 Agent 去读一个不存在的文件。

标题栏条目把三个图标按钮 —— Ren'Py 标志（打开插件**自己的**面板）、音符
（播放列表浮层）与笔记本（角色记忆）—— 加入 shell 的 `.Dc7zOa_headerUtilities` 条带。同一个簇注册了**两次**，因为
`conversation.session.header.utilities` 属于会话页眉，而没有会话时宿主根本不渲染
那半个页眉（`sessionId === void 0` 时用一个空 titleRow 顶替）；空白会话（新对话）
里宿主又会藏掉标题簇，那一行因此失去靠右的推力（宿主只为自己的角按钮补了
`margin-left: auto`）。两个座位都在同一个 `<header>` 元素内，所以样式表能看见
哪一份渲染了，并保证屏幕上永远只有一份：primary 缺席时显示 leading 那份，页眉
因为没有标题簇而留不住它时把 primary 钉回右上角（`top: 11px; right: 48px`，
有标题簇时它由那一行摆在同一组偏移上）。该面板是插件
自己的，而不是 DSH 的设置对话框：那个对话框没有**文档化的**客户端 API。设置 shell
的 store（状态仓库）位于 `client-ui-settings-general` 的
`slots.inject("sidebar.settings", ...)` 内部的一个私有闭包中，因此
`open()` 只能从 `settings.launcher` 的占用者到达 —— 那是一个 `kind:
single` 插槽，账号插件已经占用了它。在那里注册会替换已发布的 UI。浮层改为做
有保护的深链接：`slots.entries("sidebar.settings")[0].store` →
`slots.resolveStore(...)` → `actions.openSection("renpy-skin")`。这两者都是
检视面（inspection-surface）API 而不是契约，并且该条目只有在 `ui-settings` 挂载
后才存在，所以点击会回退为直接告知手动路径。面板本身复用了插件自己的 `rsk-`
组件，这也意味着它由游戏调色板来设置主题。

开场图层（视频或静态图，通过点击或它自身播放结束来关闭）与音频播放器（菜单
音乐镜像加上播放列表）都由设置项决定是否启用，在对应功能被打开之前保持惰性
（也不消耗任何东西）。`lib/client.js` 把每个注册面分开：`applyBackground` 装
对话背景与立绘舞台这两个 DOM 层，`applyHeader` 注册标题栏两处副本、弹出层、
开场图层与完成弹窗；每一处都包在自己的 `try/catch` 里，失败只在控制台记一行，
而不是留下一片空白 shell。

播放列表本身由三部分构成：`lib/client.js` 里的播放器 store（`source` / `index` /
`playing` / `time` / `duration` / `volume`）、`PlaylistPanel`，以及两个纯函数
`shuffleIndex(length, current)` 与 `playbackModeOf(settings)`（都导出给无头测试）。
transport 行有上一首、播放/暂停、下一首与**一个模式按钮**；这个按钮把
「顺序播放 → 列表循环 → 单曲循环 → 随机播放」压成一条循环，状态仍存在
`playlistRepeat` 与 `playlistShuffle` 两个设置里（`PLAYBACK_PATCH` 负责写入、
`playbackModeOf()` 负责读回），`ended` 处理、`nextTrack()` 与 `previousTrack()`
都遵守它。它仍然只播浏览器里的清单 URL，不写回游戏，也不做无缝循环。

标题栏组件与各个浮层位于同一个**覆盖层**图层中，因此它们继承了上面的
`pointer-events` 规则：浮层在自己的根节点上重新启用
`pointer-events: auto`，因为 `.rsk-layer` 把它禁用了。

**背景与舞台有意*不是*插槽。** `shell.overlay` 被渲染为各列的一个绝对定位兄弟
节点，位于 `z-index: 20`（`.BynINW_overlayLayer`），因此任何注册到那里的东西
都会画在侧边栏之上、也画在消息文本之上。`applyConversationBackground` 通过
`[data-conversation-content]` 画在对话主体上，`applyStageLayer` 则把立绘追加为
同一个主体的第一个子节点；这是已发布的对话 UI 设置的一个未哈希属性，因此图与
立绘都位于消息*后面*，并且不影响其他任何列。宿主还会对覆盖层图层的每一个直接
子节点（`.BynINW_overlayLayer > *`）强制施加 `pointer-events: auto`，这就是
`.rsk-layer` 带 `!important` 的原因 —— 覆盖层里的整帧图层会吞掉 shell 中的
每一次点击。

**隐藏 shell 家具是两个纯 CSS 开关。** `hideSidebar` 隐藏 `[data-slot="sidebar"]`
所在的布局列，并把随后的两列重新铺到同一组网格轨道上（frame 的
`grid-template-columns` 是内联样式，只隐藏列会在左侧留下 280px 的空轨道）；
`hideComposer` 隐藏 `[data-composer-seat]` 与 `ModulesLayer` 画在输入框上的
附加组件。两者都只写 `writeSettings`，不调用宿主的布局服务——关闭时不需要
记住原来的宽度，重新打开也不会覆盖用户自己拖过的侧栏宽度。

它以 `credentials: "same-origin"` 每 **900 ms**（`POLL_MS`）轮询
`GET /renpy-skin/stage`，以获取模型从宿主端驱动的舞台，并通过
`theme.overrideTokens` 应用主题色变量。轮询和主题色变量/textbook 的 `<style>`
写入器都按值比较，只有当底层数据确实变化时才重做工作：响应体在每次 tick 都是
新解析出的 JSON，所以引用比较会毫无意义地大约每秒触发一次。

**设置写入走「拖动即时预览、松手一次落盘」。** `SliderRow` 把拖动中的值存在本地草稿里，
只在手势结束时调 `onChange`（一次 POST）；不卡顿的效果额外接 `onPreview`，由
`previewSettings(patch)` 乐观并进 store，于是 `applyConversationBackground`、
`applyStageLayer`、音频音量这些读 `state.settings` 的消费者在拖动中就跟着变。预览期间
`previewPatch` 让 `pollStage` 跳过 settings 回显（宿主手里还是旧值，回显会把控件拽
回原位），`saveSettings` 在 `finally` 里清掉它 —— 即使 POST 失败，轮询也不会被永久
卡住。会卡顿的效果（播放进度条：每个 `input` 都 seek 会打断正在播的音频）不接
`onPreview`，效果与存储一起在松手时落地。这条约定写在 `AGENTS.md` 的
「滑块与数值控件」一节，新增数值控件时照它办。判断「值变没变」用的是手势第一
次 `input` 时记下的值（`baseRef`），不是当前 `value`：预览已经把 store 写成了
草稿，拿后者比较会把每次拖动都判成没变、一个 POST 都不发；确认没变化的手势还要
显式 `endPreview()`，因为不会有 POST 来清掉预览标记。

对话框和选项菜单的换肤是 **CSS 自定义属性覆盖**，而不是与之竞争的插槽组件：
`tool.call.toolview` 的 `ask_user_question` 键和 `conversation.chat.node` 已经
归已发布的 UI 所有，所以 `buildSkinCss` 把游戏的 say 框
（`dialogbox.fill` + `opacity`，或 `textboxImage`）映射到
`--dsw-specific-bubble`（用户气泡）和 `--dsw-specific-input-major`
（输入框 + 问题卡片），并把选项悬停态映射到
`--dsw-alias-interactive-bg-hover`。`<style>` 标签通过
`document.createElement` 注入，与已发布的壁纸引擎模式保持一致。

**底板不止一张的游戏要能换。** 清单给出 `dialogbox.candidates` 之后，设置页的
`PlatePicker`（`BackgroundPicker` 下方）把候选画成缩略图网格，选中一张就
`POST /renpy-skin/dialogbox`，宿主把它写进该游戏的档案并重建清单，响应里的
`manifest` 直接写回 store —— 与 `switchGame` 一样，界面不重新加载页面。
选盘器只在候选 ≥ 2 时出现：一张底板不是选择，而是一张占位卡片。
Agent 走同一条路（把路径写进 `dialogbox.textboxImage`，再用 `renpy_save_vn`
落盘），两条路径写同一份档案，所以谁后写谁生效。

**say 屏自己的零件由 `ModulesLayer` 画，不走 CSS。** 清单里的 `dialogbox.modules`
是从 `say` 与 `quick_menu` 屏翻译出来的扁平节点表（名字框、装饰图、白名单动作的按钮）。
CSS 只能画图，画不出可点的按钮，所以这一层是 `shell.overlay` 上的真组件（order −890，
在立绘舞台之上）：它每 400 ms 量一次 composer 根元素的 `getBoundingClientRect()`，把自己
用 `position: fixed` 精确铺在那个盒子上，并声明 `container-type: inline-size`；节点坐标是
画布像素，渲染时减去 `boxLeft` / `boxTop` 再乘 `100 / box.width` 换成 `cqw` —— 与
`dialogboxRules()` 共用 `composerGeometry()`，所以视口缩放时两套几何不会走散，且不需要
重新渲染。只有动作在白名单里的按钮恢复 `pointer-events`，其余整层仍然穿透；设置里的
`dialogboxModules` 是这一层的总开关。切换游戏时清单重建、节点表跟着换，模块层随 store
自动重画。

## 一次 `renpy_stage` 调用的数据流

```
model calls renpy_stage { script }
   → index.js: manifestFor(gameDir)          (cached; build on first use)
   → stage.js:  parseScript → parseStatement per line
   → stage.js:  applyStatements(stage, statements, manifest, { autoAvoid, safeArea, enabledCharacters })
        ├─ rejects → StageError.details returned to the model immediately
        └─ applies → sprite records with resolved xpos/ypos/anchor/zorder
   → stages.emit(sessionId)
   → client polls GET /stage within 900 ms and re-renders the overlay
```

`enabledCharacters` 是用户意图对模型设闸的唯一地方：**空**列表表示「所有角色」
（因此全新安装绝不会是一个没有角色的舞台），而非空列表会同时收窄
`directorBrief` 的名单和这里的 `show` 校验，所以简报和工具绝不可能在「谁存在」
这件事上产生分歧。

## 实机验收工具

`tools/` 下有三个脚本。前两个只服务于「改动是否真的进入了正在运行的宿主」这个
问题；`check-doctor.mjs` 回答另一个问题：这份清单可不可信。

| 脚本 | 用途 |
| --- | --- |
| `launch-dsh-debug.cmd` | 带 `--remote-debugging-port=9222` 重启桌面应用，供 CDP 驱动页面。开头是 `taskkill /IM "DeepSeek Harness.exe" /T /F`，会连同发起它的进程树一起杀掉，所以**只能由人运行**，不能让 DSH 自己的会话调用。 |
| `verify-agent-load.mjs` | 打插件自己不鉴权的 HTTP 路由，断言运行中的宿主已在服务 `POST /renpy-skin/agent/prepare` 并写出两棵目录树；不需要 CDP，也不需要登录 token。判定依据是响应体而不是状态码：旧宿主对任何未匹配路径都回 405，`POST /renpy-skin/definitely-not-a-route` 同样是 405。 |
| `check-doctor.mjs` | 体检：打印 Python 与 `unrpyc` 的实际位置和放弃原因、逐个打开 `.rpa`（连同归档内脚本数）、指出两份数据目录并存。退出码 0 = 清单可信，1 = 游戏只有编译脚本而 `unrpyc` 不可用，或某个归档打不开（此时清单不可信），2 = 体检本身没跑完。审计真实游戏前先跑它。 |

SPA 根页要求登录 token（`GET /` 无鉴权回 401），而带 token 的 URL 只打印在桌面应用
自己的窗口里、不落到命令行、环境变量或 `~/.dsh` 下的任何文件，所以「点一次按钮」这类
验收只能由人工完成；能自动化的部分就压在这些脚本里。

## 值得保持的不变式

1. **零运行时依赖，无构建步骤。** 上文每一处简化都是为了保护这一点。
2. **要告诉模型什么存在。** 绝不要把描述性的拒绝替换成笼统的拒绝。
3. **会话隔离。** 舞台状态按 `exec.agent.id` 区分。
4. **被裁剪的呈现数据绝不用于校验。**
5. **`inject = []`，但服务用 `ctx.inject` 等。** 可选服务只会让插件降级；它们绝不能
   破坏激活——可这不等于可以在挂载时 `ctx.get` 一次。晚挂载的服务会被永久错过，
   表现为「请求里少了 4 个工具」，而日志里什么都没有。
6. **失败要说原因，不要兜底。** 加载链路任何一步失败都 abort 并显示宿主的原话；
   静默降级（复制到剪贴板、回退到旧游戏）会让用户以为成功了。
7. **`lib/audio.js` 的时长是一个过滤器，绝不是显示值。** 它那条无标签 VBR
   MP3 分支只是估算；任何用户可见的东西都必须改为来自浏览器自身的元数据。
8. **媒体路径是「被提供」的，而不是「被知道」的。** 客户端从不猜测音频或视频
   文件在哪里 —— 一切可播放内容都以带 `/renpy-skin/asset` URL 的清单条目形式
   到达，因此只有 `.rpa` 的游戏也能一致地工作。
