# AGENTS.md — 本仓库工作约定

修改任何内容之前请先阅读本文。这里记录容易违反、且排查成本高的约束。

## 项目定位

本仓库是 `dsh-renpy-skin` DSH 插件包，包含两部分能力：

1. **换肤**：读取 Ren'Py 游戏目录，使用游戏资源和 `gui.rpy` 中的值，为 DSH 界面设置背景、对话框、`ask_user_question` 选项和主题色。
2. **舞台导演**：注入系统提示词和 `renpy_stage` 工具，使模型可以用原生 Ren'Py 的 `show`、`hide`、`scene`、`with` 和 ATL 语法控制绝对定位的立绘舞台。

原始规范（本仓库之外的一份设计文档）不在仓库内，如需追溯请向维护者索取。

## 硬性约束

- **只使用插件机制。** 只能使用已文档化的客户端、宿主端、`Config`、`Tool`、`Slot` 和 `Service` 扩展点。绝不修改 DSH 自身（安装目录下的 `resources/app.asar`）或配置档中的 `node_modules`。
- **运行时零 npm 依赖。** 宿主端必须能在任意配置档中解析，只能使用 Node 内置模块和相对导入。因此 `.rpa` 读取逻辑写在 `lib/rpa3.js` 中，不得引入 `@dynamicaaa/rpx` 等运行时依赖。
- **`.rpyc` 反编译必须可选。** `lib/rpyc.js` 调用外部 `unrpyc` 工具（Python ≥3.9）时，任何失败都必须降级为 `null` 或空映射，绝不能抛出，以免没有 Python 或 `unrpyc` 的机器无法发现其他资源。
- **没有构建步骤。** `lib/client.js` 是 lazy-CJS 工厂封装中的手写代码，只依赖平台种子键 `react`。不得引入打包器或要求配置档执行构建。
- **顶层 `inject = []`，但服务要用 `ctx.inject` 等。** 空数组表示「缺少服务的配置档仍能加载其他部分」，**不**表示可以在挂载时 `ctx.get(...)` 读一次。`systemPrompt`、`tools`、`webServer` 三者都必须是 `ctx.inject([...], (scoped) => ...)`，注册放进 `scoped.effect(...)`：各行并发挂载，一次性读取会在服务晚到时返回 `undefined`，守卫随后静默跳过注册。症状极难排查——请求里少了 4 个工具和整段系统提示词，日志里什么都没有（2026-10-16 真实发生过）。`ctx.get` 对未注入的名字还会直接抛错。始终不出现的服务只让它自己那一半不接线。
- **失败要说原因，不要静默兜底。** 加载链路的每一步失败都要 abort 并把宿主的原话显示出来。禁止「失败就复制到剪贴板并报成功」这类降级：它让界面在什么都没发生时也宣布成功。剪贴板只能是用户明确点击的备用动作。
- **先核实平台 API。** 在信任历史记忆或文档快照之前，使用 `cordis_inspect_list` / `cordis_inspect_query` 核实平台 API；`docs/CONTRACTS.md` 只是快照。
- **所有 Markdown 文档只使用中文。** 不生成或保留英文文档副本，包括临时目录中的翻译草稿；代码标识符、命令、路径和协议字段保留原文。代码注释使用英文，说明原因而不是重复代码。

## 常用命令

```sh
node --test "test/*.test.mjs"       # 完整测试套件
make test                            # 同上
make check                           # 语法检查并运行测试
make doctor GAME="D:\Games\MyNovel" # 体检：Python / unrpyc / 归档可读性 / 数据目录
make probe GAME="D:\Games\MyNovel"  # 针对真实游戏探测
node tools/verify-agent-load.mjs     # 实机验收（重启后跑）：确认运行中的宿主已服务新链路
```

`make doctor` 的退出码是有意义的：0 = 可以信任清单，1 = **清单不可信**
（游戏只有编译脚本、`unrpyc` 又不可用，此时所有 GUI 值都是硬编码默认值），2 = 路径本身坏了。
在审计任何真实游戏之前先跑一次，否则「读到了 0」和「压根没读到」在输出上无法区分。

`tools/verify-agent-load.mjs` 打的是插件自己不鉴权的路由，所以不需要 CDP 或登录 token。
`tools/launch-dsh-debug.cmd` 开头的 `taskkill /IM "DeepSeek Harness.exe" /T /F` 会连同发起
它的进程树一起杀掉——**只能由人在终端里运行**，绝不能让 DSH 自己的会话去调用（那样会
把运行它的宿主和这个会话一起终止）。

不要运行 `node --test test/`。Node 22 和 Node 24 对目录参数都会失败，必须传入带引号的 glob。项目没有构建步骤，也没有 linter。

## 测试约定

`make test` 必须保持通过。测试位于 `test/` 下：`skin`、`rpa`、`rpyc`、`audio`、`client`、`vn`、`renpy`、`scantree`、`home`、`memory`、`png` 十一份主用例，外加 `audit-dialogbox` / `audit-assets` / `audit-media` / `audit-scripts` 四份审计用例，全部使用零依赖的 `node:test`。需要 `unrpyc` 的用例在没有工具的机器上跳过，而不是失败。

- 不要 mock 文件系统或外部工具。`makeGame()` 会在系统临时目录中创建真实的临时 Ren'Py 游戏；`.rpyc` 和 `.rpa` 测试使用真实编译器输出及真实归档。手写夹具容易重复作者对格式的误读。
- 读取器刻意不求值的表达式返回 `undefined` 是契约，相关限制测试应保留，不要为了让测试通过而添加求值器。
- **任何新的「跳过」都要配一条永不跳过的断言。** `test/rpyc.test.mjs` 里七个真实反编译用例在没有 `unrpyc` 的机器上全部跳过，于是整份文件能「全绿」而一行反编译逻辑都没跑过。`rpycDiagnostics()` 至少要有一条恒跑的用例，把「为什么不可用」钉下来。
- `test/client.test.mjs` 只打桩 `react` 和 `@deepseek-ai/dsh-client-ui-primitives`。新增第三方导入会使测试失败；该测试只能证明代码可解析、可注册并能在没有服务的上下文中存活，不能证明实际渲染效果。
- 发现解析器 bug 时添加回归测试，并在测试注释中写明用户可见的症状。
- 修改 `lib/index.js` 或 `lib/client.js` 后，先运行 `node --check`，再运行完整测试套件。
- 宿主会把模块保存在内存中。实时验证插件行为前必须重启 DSH，否则磁盘上的修改不会进入正在运行的宿主。

## 滑块与数值控件

滑块的显示值必须随拖动实时变化，持久化只能在手势结束时执行一次。判断效果是否需要预览的唯一标准，是拖动中反复执行它是否会卡顿。

- 不会卡顿的效果（背景亮度、播放列表音量、舞台立绘上限）使用 `previewSettings(patch)`：立即乐观更新 store，但不发送 POST。拖动期间 `pollStage` 必须在 `previewPatch !== undefined` 时跳过设置回显；`saveSettings` 要在 `finally` 中清理预览标记，避免 POST 失败后永久阻塞轮询。
- 会卡顿的效果（播放进度条）只在拖动中更新数字，松开时才提交效果和设置。`SliderRow` 不传 `onPreview` 即表示这种行为。
- 新数值控件遵循 `SliderRow` 契约：`onPreview` 负责拖动中的效果，`onChange` 负责手势结束时的一次提交。禁止在每个 `input` 事件中直接调用 `saveSettings`。
- 判断值是否变化时，必须和手势开始时的值比较，不能和当前 `value` 比较。预览会修改控件读取的 store，当前值已经是草稿；`SliderRow` 用 `baseRef` 在第一次 `input` 时保存基线。
- 手势结束时若没有变化或没有预览，必须调用 `endPreview()` 清除 `previewPatch`。组件在拖动中卸载时也必须清理，因为此时不会再收到 `pointerup`。
- range 尽量使用整数单位并省略 `step`：音量使用 0–100 的整数百分比，进度使用 0.1 秒刻度。只有整数步长无法表达目标粒度时才声明 `step`；布局编辑器的 `step: 0.01` 及其 ±0.01 按钮不受此条影响。

## 已知陷阱

- **`rpycDiagnostics()` 的兜底会把编程错误伪装成诊断结论。** `computeDiagnostics()` 里的
  任何抛错都会被接住并写成 `the rpyc diagnosis itself failed: <message>`，而 `tried`、
  `toolsDir` 等字段仍来自候选列表，看起来一切正常。改写那段查找逻辑之后先读 `reason`
  再相信 `path`：实测一次漏写 `let unrpycReason`，让「明明找到了 unrpyc」报成
  `path: null`，直到断言才暴露。
- **工具结果必须是「无损 JSON」：值为 `undefined` 的键会被宿主拒绝。**
  `dsh-tools` 的 `snapshotJsonValue()` 对 `undefined`、`NaN`、`Infinity`、`-0` 和
  非普通对象一律判失败，报 `tool "<name>" returned invalid output: value is not
  lossless JSON`，而且**整个结果被丢弃**——`renpy_stage` 因此出现过「回执 ok、舞台
  却不动」的另一半症状。空背景要**省略** `scene` 键而不是写 `scene: undefined`，
  分层立绘要省略 `url` 而不是写 `url: undefined`。新增任何工具返回值后，至少用
  `JSON.parse(JSON.stringify(value))` 与原值深比较一次。
- 文件名只能按空白字符切分为图像组件。不能按 `-` 或 `_` 切分，否则会破坏真实属性名，例如 `art-angry-a-l.webp` 的标签实际是 `art angry l`。
- 图像段必须在第一个子句关键字 `at`、`as`、`behind`、`with` 或 `zorder` 处停止，否则 `behind bob zorder 5` 会把 `zorder` 当作标签并吞掉 `5`。
- tokenizer 必须把 `==`、`!=`、`>=`、`<=` 作为单个 token 输出；拆成两个 `=` 后，任何 `if` 条件都无法解析。
- `renpy_stage` 必须通过 `exec.agent.id` 按会话隔离，不能使用全局舞台状态。
- `theme.overrideTokens` 的每个 token 都必须同时提供 `{ light, dark }`；只有 light 的映射会被拒绝。
- 设置写入时必须钳制：`backgroundDim` 为 0–1，`maxStageSprites` 为 1–8，`textCps` 为 0–400；配置持久化到 `$DSH_HOME/renpy-skin/config.json`（`lib/home.js` 解析：`DSH_RENPY_SKIN_HOME` > `$DSH_HOME/renpy-skin` > `~/.dsh-renpy-skin`，空白视为未设置，旧位置首次解析时复制一次）。未知键会被丢弃，因此新增设置必须同时更新 `DEFAULT_SETTINGS` 和 `docs/CONTRACTS.md`。每个游戏自己的文件放在数据目录的 `game/<扫描名>/` 下（`vn.json`、`tree.md`、`summary.md`、`memory.json`），目录名一律用**扫描名**而不是 `manifest.game.name`。
- 一个 `layeredimage` 角色是带 `layers` 映射的一个立绘，不是每个属性一个立绘。其 `attributes` 必须是各分组所有非 `default null` 属性的扁平并集，否则 `resolveSprite` 会拒绝合法命令，例如 `show enid glasses thinking`。
- **profile 的目录键必须用扫描名，不能用 `manifest.game.name`。** 后者正是覆盖层可以改的字段：扫描名 `CSE-2.1.0-pc` 被改成 `CSE` 之后，下一次构建会去找 `game/CSE/vn.json`（不存在），于是覆盖层「自己撤销了」，而回执上一切正常。`manifestFor()` 在 `applyProfile` 之前就把 `scannedName` / `profileName` 定进 record，写入、读取、`/vn`、`/agent/prepare` 全部只用这两个值。
- **清单里每个取值都要经过 `firstDefined(field, candidates, fallback)`。** 它按优先级尝试并把命中来源写进 `manifest.sources`，全落空写 `"default"`。没有这一步，「游戏真的写法是 0」和「什么都没读到、用了硬编码默认值」在输出上完全一样，而装了 `unrpyc` 之后错误值还会从「明显是 0」变成「看起来很像真的 402」。新增任何取值都要走它，否则 `sources` 会静默漏掉那一项。
- **`profileOverlay()` 里 `null` 与 `undefined` 都表示「保留扫描值」。** 只跳过 `undefined` 会让 `null` 真的写进清单把扫描值清空，而 `renpy_read_manifest` 的输出正好是 `renpy_save_vn` 的输入形状，Agent 把回执拷回去就会清空缺省字段。
- **`game` 段逐 key 合并，`characters`/`sprites` 段逐字段合并，都不是整段替换。** 整段替换会抹掉 `game.screen`（客户端用它算对话框布局）、把 `characters.qc` 的 `image` 丢掉、或把 `sprites` 数组换成对象（随后 `lib/stage.js` 的 `manifest.sprites.find(...)` 会抛）。`sprites` 段匹配不到记录时只进 `unmatched`，**不新建记录**——新记录需要 asset URL，只有扫描能 mint。
- **`applyProfile()` 之后必须跑 `rederiveAssets()`。** 资产 URL、图片尺寸、不透明框、`fontUrl` 都是派生值，覆盖层只复制字符串。不跑这一步时 profile 写 `gui/mine.png` 会让浏览器拿到裸路径（客户端直接把它塞进 `url(...)`），改 `dialogbox.font` 时 `fontUrl` 还是旧的。
- **`lib/scantree.js` 的 `blocks[].lines` 必须是字符串数组，不能有嵌套数组。** `renderUnderBudget()` 用 `Buffer.byteLength(line, "utf8")` 量字节，遇到数组会抛 `ERR_INVALID_ARG_TYPE`，整次扫描失败、`POST /agent/prepare` 回 400。这个坑只在「没有松散脚本、脚本全在 `.rpa` 里」的游戏上暴露（分支写法 `? [[str]] : []` 多套了一层），有松散脚本的游戏根本不经过那一支，所以单测容易全绿。
- 新增「跳过」时必须同时提供永不跳过的诊断断言，见「测试约定」。
- 禁止使用 PowerShell `Get-Content` / `Set-Content` 编辑文本文件。本机控制台代码页为 GBK（cp936），往返会破坏 UTF-8 中的 em dash、箭头、`≥` 或 en dash。使用 `edit` / `write` 工具写入 UTF-8，随后执行有效性检查。

## 环境说明

- 测试需要 Node 22 或 24，两者均已在本仓库验证通过。
- `pnpm` 可能被配置档的 `minimumReleaseAge` 策略挡住，无法直接从本地路径安装本包；开发时通常用 `link:` 把本仓库挂进配置档。无论哪种方式，**正在运行的宿主只使用启动时载入的 `lib/`**，所以在界面里验证宿主端改动前必须重启 DSH。
- 本仓库不属于 DSH 工作区树；把本仓库放在 DSH 安装目录之外更省事。

## 文档导航

| 文件 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 工作约定、约束与易踩的坑。请先读。 |
| [docs/STATUS.md](docs/STATUS.md) | 当前实际可用的功能，以及尚不可用的部分。 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块地图与数据流。 |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | 平台 API、HTTP 路由、设置项结构、清单结构。 |
| [TODO.md](TODO.md) | 已知缺口，按优先级排列。 |
| [CHANGELOG.md](CHANGELOG.md) | 发布说明。 |

## 文档同步

涉及行为、配置、平台契约或测试流程的修改，应同步检查 `README.md`、`docs/ARCHITECTURE.md`、`docs/CONTRACTS.md`、`docs/STATUS.md`、`CHANGELOG.md`、`TODO.md` 和本文件。文档必须继续使用中文，并与当前代码保持一致。
