# 更新日志

`dsh-renpy-skin` 的重要变更。本项目尚未正式发布：版本为
`0.1.0`。该插件已安装，并在实时的桌面配置档中处于活动状态。

## 未发布

### 舞台层级与界面收纳

- **立绘不再盖住界面。** 此前舞台注册在 `shell.overlay`，那是整帧的兄弟层、`z-index:20`，
  所以立绘会盖住消息文字、输入框，乃至左侧会话列表的边缘。现在 `applyStageLayer()`
  把 `[data-renpy-skin="stage"]` 插成 `[data-conversation-content]` 的第一个子节点，
  滚动区抬到 `z-index:1`、舞台留 `0`：立绘只存在于会话面板内部，消息与 composer
  永远画在它上面，会话列表根本不在同一个元素里，也就不会再被越过。宿主重建会话主体
  （切会话、导航）时由 store 订阅与 `MutationObserver` 重挂，不用定时器。
- **新增 `hideSidebar` 与 `hideComposer`。** 设置 →「界面」里可以隐藏左侧会话列表或
  底部对话框，把窗口整个让给舞台。前者只写 CSS：藏掉 `[data-slot="sidebar"]` 所在列，
  并把后两列重铺到 `grid-column: 1 / 3` 与 `3`（frame 的列宽是内联样式，不重铺会留下
  一条空轨道）；后者藏掉 `[data-composer-seat]` 与画在它上面的 `.rsk-modules`。
  两者都不调用宿主的布局服务，随时在原处关掉即可恢复。`dialogbox` 开关控制的是
  换肤，和这两个显示开关是两件事。

### 舞台与当前会话（两个让「命令没效果」的缺陷）

- **`renpy_stage` 的结果重新成为合法 JSON。** 宿主把每个工具结果按「无损 JSON」
  快照，任何**存在但值为 `undefined`** 的键都会被拒（`value is not lossless JSON`）。
  舞台快照在没有背景时一直带 `scene: undefined`，裸 `scene` 的回执也带
  `scene: undefined`，分层立绘（`layeredimage`）还没有单一的 `url`——于是执行一次
  不带图片的 `scene`、或 `show` 任何一个分层角色之后，**后续每次** `renpy_stage`
  都失败，模型只看到「返回了非法输出」而没有舞台变化，只有 `clear` 加
  `scene bg …` 才能恢复。现在这些键在无值时直接缺席；回归用例对回执与快照做
  `JSON.parse(JSON.stringify(…))` 往返比较。
- **桌面壳里能认出当前会话。** 桌面壳的地址是 `dsh-app://app/`，没有
  `?session=`；它把当前会话写在 `[data-conversation-session]` 与
  `localStorage["dsh.sessions.current"]`（JSON 信封）里。`currentSessionId()` 以前
  只读 URL 和旧的 `dsh.session`，于是退回 `"global"`：`renpy_stage` 按
  `exec.agent.id` 写舞台，浏览器却轮询 `global` 那一个桶，工具回执全是 ok，界面
  永远不动。现在按「URL → 渲染中的会话（DOM）→ `dsh.sessions.current` → 旧键 →
  `global`」依次读取。同一修复也让 `/manifest`、`/vn`、`/memory`、`/media`、
  `/export`、布局与对话框的会话参数回到真实会话。

### 色板：自动读取与逐项自定义

- **清单新增 `palette`。** 八个颜色槽位（`accent`、`hover`、`idle`、`text`、`uiText`、
  `name`、`choiceIdle`、`choiceHover`）以固定顺序给出 `{ key, value, source }`，
  于是界面能说清每个颜色的来路。来源词汇新增三个：`settings`（这个值来自设置页的
  覆盖）、`image-sample`（颜色从对话框底板或名字框图片里采样得来）与
  `dialogue-text`（界面文字色跟着对话文字色，见下一条）。
- **缺 `gui.accent_color` 时从底板采样主色。** 游戏从不声明强调色时，文本底板
  本身就画在游戏的调色板里，所以 `lib/png.js` 新增 `pngDominantColor()`（与
  `pngOpaqueBounds()` 共用块解析 `readChunks`）取它最常出现的颜色，来源记
  `image-sample`；底板采不到再试名字框。只有 `hover` / `nameColor` 自己也没有
  游戏值时才会跟着这个采样色走——否则那两行会显示没人选过的颜色。
- **设置页色板卡片从只读改为可编辑。** 每项一个取色器，显示当前色值与读自哪里；
  被覆盖的行出现「恢复游戏值」。按 `SliderRow` 的约定，拖动取色器只更新本页预览，
  原生 `change`（选色器关闭）时才提交一次；保存后重建清单，`theme` 的 10 个别名
  token 由覆盖后的 accent 重新派生，界面立刻跟上。
- **文本框文字与 DSH 界面文字拆成两个槽位。** `text` 是对话框（文本框）里的文字，
  新增的 `uiText` 是 DSH 界面自身的文字。此前 `--dsw-alias-label-primary` 直接取
  `dialogbox.textColor`，于是改文本框的文字色会连带改掉界面里的每一个标签。现在
  `uiText` 未覆盖时取**不受 `text` 覆盖影响**的游戏对话文字色（来源记
  `dialogue-text`），覆盖后两种主题都用用户选的颜色——浅色主题原本由强调色派生，
  因为没有哪个游戏颜色能同时表达「白底上可读」；那一行显示「跟随对话文字」而不是
  「恢复游戏值」，因为界面色并没有自己的游戏值。
- **新增设置 `paletteOverrides`。** 只接受八个槽位的名字（含 `uiText`），值必须是
  `#rgb` 或 `#rrggbb`（写入时小写化），非法值与未知键丢弃；每次写入用新对象整体
  替换，空对象表示全部跟随游戏。它排在扫描候选之前，所以 `manifest.sources` 会把
  命中记成 `settings`。

### 环境配置与工具位置

- **设置页新增「环境配置」卡片。** 它逐项列出插件需要的环境：Node（DSH 自带，
  无需安装）、Python ≥3.9（可选）、`unrpyc`（可选）、数据目录。每项显示宿主实际
  探测到的状态（已找到 / 未找到 / 不可用）、路径与命中来源；未找到时给出下载地址
  （Python → `python.org/downloads`，`unrpyc` → 项目主页与 v2.0.4 源码包），并说明
  `unrpyc` 不在 PyPI 上、也可以直接放进插件的 `vendor/unrpyc/`。**「未找到」与
  「填了路径但跑不起来」分开显示**：后者要修的是路径，不是再下载一份。
- **新增 `GET /renpy-skin/doctor`。** 返回卡片读取的全部事实：Node 与平台、插件根
  目录、数据目录（含旧目录是否仍存在）、Python 与 `unrpyc` 的路径/来源/试过的
  候选/放弃原因，以及 `requirements` 四行与下载地址。`?refresh=1` 表示重新探测
  （丢弃诊断缓存）。卡片不自己推导查找顺序——那会与 `lib/rpyc.js` 实际使用的规则
  漂移；它与 `tools/check-doctor.mjs` 读的是同一份诊断。
- **新增设置 `pythonPath` / `unrpycPath` / `toolsDir`。** 三条路径都会 trim、最多
  400 字符，空值表示自动发现；优先级是「设置页 > 环境变量 > 自动发现」。写入后
  立即清空诊断与清单缓存，所以新路径在下次加载游戏时就生效，不需要重启 DSH。
- **`unrpycPath` 可以直接填解压目录。** 安装说明交给用户的是
  `...\unrpyc-2.0.4` 这样的目录，所以是目录时会自动找其中的 `unrpyc.py`；之前把
  目录当作文件检查，界面会报「unrpyc 未找到」而工具其实就在下一层。目录里确实
  没有 `unrpyc.py` 时，诊断会明说「你填的是目录，里面没有 unrpyc.py」。

### say 屏模块化

- **清单新增 `dialogbox.modules` 与 `dialogbox.quickMenu`。** `lib/manifest.js`
  把游戏自己的 `say` 屏翻译成扁平节点表：底板之外的 `add`/`background` 成为
  `image` 节点，名字框按 `layout.name*` 得到 `image` 节点，`quick_menu` 里动作在
  白名单（`settings` / `music` / `memory` / `hide` / `skip`）的按钮成为 `button`。
  节点用画布像素的 `rect` + `z` 排序，`image` 存 `game/` 相对路径；扫描器新增
  `looseProperty()`，因为 `pos (100, 200)` 里的空格会让按 `key value` 配对的
  属性解析整体放弃，位置与尺寸都会丢。映射不到白名单的按钮不画（画了也点不动），
  只进只读的 `quickMenu` 报告。
- **客户端新增 `ModulesLayer`（`shell.overlay`，order −890）。** 它每 400 ms 量一次
  composer 根元素的 rect，用与 `dialogboxRules()` 共享的 `composerGeometry()` 把
  画布坐标换成 `cqw`（缩放时自动跟随，不需要重新渲染），只有白名单按钮恢复
  `pointer-events`。名字框因此第一次真正画了出来——此前 `namebox` 只参与布局几何。
- **新增设置 `dialogboxModules`（默认开启）。** 关闭后只画底板与文本，不画 say 屏的
  零件；设置页「Dialogue」段新增「Say-screen extras」开关。
- **`renpy_save_vn` 接受 `dialogbox.modules` 并整体替换扫描结果。** 节点逐条校验
  （`kind`、`rect`、`z`、`opacity`、颜色、长度），非法项按
  `dialogbox.modules[i]` 进 `malformed`，最多 40 个节点，`[]` 是合法的清空声明；
  `rederiveAssets()` 为 `image` 与 `hover.image` 派生 `imageUrl`，读不到的路径照发
  URL 并由 `unresolved` 报出。

### 对话框底板候选与选择器

- **清单新增 `dialogbox.candidates` 与 `dialogbox.textboxPath`。** 一张游戏里常常
  躺着好几张 `textbox.png`（新旧 GUI、不同分支的界面包），只挑一张会在另一个
  分支的游戏上显示错的框。候选按「显式 `gui` 变量 → `window` 样式 → `say` 屏的
  `add`/`background` → 常规路径 → 按 `textbox|say|dialogue|message` 扫全库兜底」
  收集，排除 `/phone/`、`/tablet/` 与 namebox，上限 12 张，每项带
  `{ path, source, url, bounds }`；`candidates[0]` 恒等于当前所用的
  `textboxPath`，由 `rederiveAssets()` 在覆盖层换盘后重排保证（档案指到扫描
  没找到的路径时就地合成一条 `source: "profile"` 的候选）。
- **新增 `POST /renpy-skin/dialogbox`：切换该游戏用哪张底板。** 只接受候选列表
  里的路径（未知路径 400 并回带候选），把它写进该游戏档案的
  `dialogbox.textboxImage`，清缓存重建清单后返回新清单。设置页的选盘器与
  `renpy_save_vn` 写同一份档案。
- **设置页新增「Dialogue box art」选择器（`PlatePicker`）。** 候选 ≥ 2 时在
  「Background picker」下方出现，缩略图网格 + 当前项 `In use`，选中即切换并把
  响应里的 `manifest` 写回 store（界面不重载）。一张底板不是选择，因此只有一张
  时不渲染。
- **`renpy_read_manifest` 摘要新增只读的顶层 `plates` 数组**（`{ path, source,
  selected? }`，在 `dialogbox` 与 `layout` 之间）：它不是可写的段，Agent 换盘
  要把路径写进 `dialogbox.textboxImage`。
### 角色名字、额外要求与跨会话记忆

- **设置新增 `playerName` / `sessionNames` / `roleplayPrompt`。** 全局名字是所有
  会话的默认称呼，`sessionNames` 按会话覆盖（设置页的「Name for this
  conversation」只写当前会话的键），额外要求只注入到「在场」预置的会话。
  清洗与钳制跟其它设置一样落在 `writeSettings`，未知键仍被丢弃。
- **新增提示词段 `renpy-skin:roleplay`（只对预置 `renpy-scene` 生效）。**
  `presetOfSession()` 优先读 prompt 组装上下文里的 `assembly.scope.header.agentPreset`，
  读不到时回退到 `session/event` 事件缓存的会话头；`roleplayBrief()` 注入用户的
  名字、额外要求与按角色分组的记忆，不重复舞台语法（那份在 `stage-director` 段里）。
- **新增 `lib/memory.js` 与 `renpy_memory` 工具：跨会话、按角色分开的记忆。**
  存在数据目录的 `game/<扫描名>/memory.json`（纯 `tag → 文本` 映射），
  单角色上限 8000 字符，超出时保留最新内容并在按行边界截断；注入只带每个角色
  最近 1200 字符（最多 12 个角色），完整内容让模型用 `renpy_memory read` 取。
  工具支持 `list` / `read` / `append` / `replace`，`replace` 传空文本即删除；
  角色名必须是清单里真实存在的 tag。文件损坏或写失败都降级为可解释的失败，
  不抛异常。
- **新增 `GET/POST /renpy-skin/memory` 路由与顶栏记忆面板。** 设置页新增
  「Roleplay 「在场」」卡片（全局名字、本会话名字、额外要求），记忆编辑器在设置页
  与顶栏笔记本按钮里共用：下拉选角色、编辑全文、`Save` 覆盖、`Remember this`
  追加。模型主动记与用户手动记写的是同一份文件。

### 角色扮演预置「在场」

- **`cordis.patch.yml` 新增第二个预置 `preset-renpy-scene`（展示名「在场」，
  order 60）。** persona 定义这场戏的演法：用户是到场的人，角色由模型扮演；
  每轮开头的时间快照就是世界里的「现在」，角色按钟点与间隔生活；每轮回复至少
  一次 `renpy_stage`；剧情涉及其他角色时把他完整带上台；技术问题只用一句普通话
  说明，然后回到戏里。
- **「读取当前时间」靠声明 `@deepseek-ai/dsh-time-context` 实现，
  `refreshIntervalMs: 0` 让每个合格 step 都注入一条时间快照。** 随发行版交付的
  Web 组合不带这一行（`standard` / `cordis` / `ptc` 各自声明），预置不能假设从
  别的预置继承任何一行。
- **工具面刻意收窄：persona + 时间上下文 + 压缩，不声明 shell、文件、网页等
  工具。** `renpy_*` 工具本来就是全局注册的；舞台语法、角色名册与立绘上限仍由本
  插件全局注入的舞台说明（`directorBrief`）承载，persona 不重复一份——两份副本
  漂移是这份文件上面已经记过一次的教训。

### 清单可解释性（把「读到了」与「没读到」分开）

- **`manifest.sources`：每个值都记下来源。** 取值词表是 `screen`（脚本里的
  `screen say` 屏幕体）、`style`、`gui-variable`、`conventional-path`、
  `character-declaration`、`profile`（被 `vn.json` 覆盖层改过）、`unread`，以及
  **`default`**——最后这个才是重点：以前「游戏真的这么写」和「什么都没读到、用了插件
  硬编码的默认值」在清单上完全一样，装了 `unrpyc` 之后错误值还会从「明显是 0」变成
  「看起来很像真的 402」。取值改用 `firstDefined(field, candidates, fallback)` 逐级尝试，
  每命中一级就记下来源，全落空时记 `default`。
- **`manifest.scripts`：脚本发现与反编译的诊断段。**
  `{ found: { looseRpy, looseRpyc, archivedRpy, archivedRpyc, total }, decompiled,
  attempted, skippedByCap, unreadable, reason, tool }`。`reason` 为 `null` 表示正常，
  否则是一句人话（`"no .rpy or .rpyc scripts were found loose or inside the archives"`）；
  `tool` 是 `rpycDiagnostics()` 的结果。以前反编译失败只进 `DSH_RENPY_RPYC_DEBUG`
  的 stderr，而 `MAX_DECOMPILED_SCRIPTS = 48` 截断掉的候选根本不记录。
- **`manifest.characters`：真正读游戏声明的角色。** 解析
  `define qc = Character('启诚', color="#624B34", image="qc", cb_name='qc')`，
  含多行参数、`DynamicCharacter(...)`、关键字参数；`image=` 指向的 tag 在立绘索引里
  不存在时标 `spriteTagUnresolved: true`。**它与 `tags` 是两件事**：`tags` 是扫描出来的
  立绘桶，`characters` 是游戏自己声明的角色，两者可能对不上（CSE 的 `image="qc"`
  对应目录其实是 `images/qicheng/`）。`renpy_read_manifest` 原先把 `tags` 冒名成
  `characters`，现在立绘桶叫 `spriteTags`。
- **`stats` 的改名与新增。** `indexTruncated` → `assetsIndexTruncated`（20000 条资源
  索引上限）、`truncated` → `spriteListTruncated`（`SPRITE_LIST_CAP = 200` 的展示上限）——
  原名同名不同义，两个「截断」在界面上是同一种坏味道；新增 `characters`（角色声明数）
  与 `unread`（读不到、整块是默认值的分区名，例如 `["scripts","characters","theme"]`），
  以及 `assetDirs`（索引里文件数最多的十个目录，`{ dir, count }`）。摘要里没有路径清单，
  以前 Agent 只能靠猜目录名去试 `/media?under=`；现在「图在哪、音频在哪」是清单自己说的。
- **`rpycDiagnostics({ refresh? })`：反编译链路终于有对外诊断。**
  返回 `{ python: { path, checked, reason }, unrpyc: { path, tried, toolsDir, reason },
  reason, usable, install }`，进程内缓存、永不抛；`install` 里是**可复制**的下载与解压
  指令（`unrpyc` 不在 PyPI 上，`pip install unrpyc` 会报 no matching distribution，
  v2.0.4 的 release 资产里也没有 `unrpyc.py`，必须下源码 zip）。`decompileRpycBatch()`
  返回 `{ files, diagnostics }`，原来的 `decompileRpycMany()` 变成薄包装以保持返回类型。
  发现链补了两处：插件自带的 `vendor/unrpyc/unrpyc.py`、DSH 自带的 Python
  （`$DSH_HOME/dsh-runtimes/*/dependencies/python/`）。顺带修掉一个静默 bug：
  `unrpycCandidates()` 里 `readdirSync(toolsDir)` 抛错时会把整个 toolsDir 分支吞掉，
  于是诊断只说「tried unrpyc.py」，用户看不出它根本没找过 `~/Tools`。
- **`tools/check-doctor.mjs`（`make doctor`）：让「这份清单可不可信」有个退出码。**
  打印 Python 与 `unrpyc` 的实际位置和放弃原因、逐个打开 `.rpa`（连同里面的脚本数）、
  指出两份数据目录并存，并在「游戏只有编译脚本、`unrpyc` 又不可用」时以 1 退出——
  那种情况下清单照样生成得很正常，但值全是默认值，审计结论不成立。实测 CSE 正是这一档：
  0 个松散脚本、`scripts.rpa` 里 29 个 `.rpyc`，没有 `unrpyc` 就一个值都读不到。
- **扫脚本的范围放宽，并新增两个解析器。** `style` 块与 `screen` 块的扫描范围从
  「只有 `gui.rpy`/`options.rpy`/`screens.rpy`」改成**全部脚本**：真实游戏会在自己的
  `newScreens.rpy` 里重写整个 `screen say`，只看那三个文件会一个值都读不到。新增
  `readScreenBlocks()`（按缩进切块，支持关键字单独成行与 `frame: pos (265,798)` 单行内联
  两种写法，复用 `MOBILE_VARIANT` 过滤手机变体）与 `readCharacterDeclarations()`，
  两个都是纯解析、不抛。对话框贴图新增第四条取值来源「屏幕体里的 `add`/`background`」，
  字体优先级变成 `screen say` 的 `font` → `style` → `gui.text_font` → 用声明再反查一次
  `manifest.fonts`。屏幕体给的是**屏幕绝对坐标**，换算成相对对话框顶部的偏移由插件做
  （`y − (screenHeight − textboxHeight) * textboxYalign`），不让 Agent 自己算。
- **`scan-tree` 与系统提示不再断言「这个游戏没有」。** 归档区块移到 scripts 之前
  （全编译进 `scripts.rpa` 的游戏若先打 scripts 会读成「这游戏没脚本」），首块新增
  `- archives: N (M entries — images X, audio Y, movies Z, scripts W)` 与
  `- unreadable archives:` 两行，`stats` 新增 `archiveEntries` 与 `unreadableArchives`；
  空脚本/空角色的文案改成「没读到，见 `scripts.reason`」。提示词里那句最误导的
  `Files: 0 images, 0 audio files, 0 scripts, 30 fonts.` 现在会补一行归档摘要，
  且在 `stats.scripts === 0 && stats.archives > 0` 时改写成
  `0 loose scripts (W inside archives)`。

### 新增

- **音频播放器支持顺序 / 列表循环 / 单曲循环与随机播放。** 新增两个设置：
  `playlistRepeat`（`"off" | "all" | "one"`，默认 `"off"`）与 `playlistShuffle`
  （boolean，默认 `false`）。播放器面板的 transport 行有一个模式按钮，按
  「顺序播放 → 列表循环 → 单曲循环 → 随机播放」循环切换，按钮上直接显示当前
  模式名（`data-mode` 也是它，`title`/`aria-label` 同文，中英文），随机状态把
  `playlistRepeat` 写回 `"off"`，避免出现按钮叫不出名字的组合；`ended` 处理、
  `nextTrack()`、`previousTrack()` 都遵守这两个设置，纯函数
  `shuffleIndex(length, current)` 从其余曲目里等概率抽取且不重复当前曲，
  `playbackModeOf(settings)` 负责把两个键读回同一个状态名。
  非法模式在 `writeSettings` 里被丢弃——播放器的 `ended` 只认识这三个值。
- **`renpy_save_vn` 支持 `dryRun: true`。** 不写任何文件、不清缓存，返回
  `{ ok, dryRun: true, dir, wouldWrite: { tree, summary, vn }, applied, ignored, malformed,
  unknownKeys, unmatched, unresolved }`；`applied` 来自对一份**深拷贝**清单跑同样的合并，
  所以它回答的是「如果写下去会发生什么」。
- **profile 支持 `characters` 与 `sprites` 段，且是逐字段合并。** 段名单从 6 个扩到 8 个；
  `sprites` 段按 `tag` 或 `name` 命中扫描已找到的记录就地改字段，匹配不到只进
  `unmatched`、**不新建记录**（新记录需要 asset URL，只有扫描能 mint）；
  `characters` 段按变量名逐字段合并。`game` 段改成逐 key 合并（`screen` 再浅合并一层），
  不再整段替换——只写 `{ game: { name, version } }` 会抹掉 `game.screen`，而客户端正是
  用它算对话框布局。
- **`unknownKeys`：拼错的键会被点名，而不是被当成新字段应用。**
  `inspectProfileConfig()` 返回 `{ accepted, ignored, malformed, unknownKeys }`，
  白名单是 dialogbox 18 键 / layout 16 键 / choice 8 键 / game 5 键（`theme`、`transcript`、
  `characters`、`sprites` 不设白名单，它们的键来自游戏本身）。未知键**仍然被写入**，
  但不计入 `applied`，回执里给一句 `Check the spelling of …`。
- **设置页把「没落地」的部分也说出来。** 配置卡片新增两行：`unknownKeys` 里的拼错键
  （「仍会写入，但不计为已应用」）与 `unmatched`（`sprites.<tag>` 没匹配到任何扫描记录）；
  笔记被截断时补一句「共 N 个字符，只显示开头」。此前卡片只说「改掉了 N 个字段」，
  一个拼错的键和一个没命中的立绘补丁都会读成成功。
- **保存前的资产校验：`unresolved`。** `dialogbox.textboxImage`、`nameboxImage`、
  `choice.idleBackground`/`hoverBackground`、`game.mainMenuMusic` 这些路径会用
  `readAssetBytes()` 真的试探一次，读不到就报出来——**但仍然允许保存**（路径可能要等
  用户装好归档后才可解析，为一个路径丢掉整份 profile 更糟）。
- **派生字段重算 pass。** `applyProfile()` 之后跑 `rederiveAssets()`：profile 改过的资产
  路径按当前 `assetToken` 重新 mint 成可加载 URL、重算 `textboxImageBounds`/
  `textboxImageBox`/`nameboxBounds`、按 `dialogbox.font` 重查 `manifest.fonts` 得到
  `fontUrl`。不补这一步时，profile 写 `gui/mine.png` 浏览器会拿到裸路径（客户端直接把它
  塞进 `url(...)`），改 `dialogbox.font` 时 `fontUrl` 还是旧的。找不到字体时清空
  `fontUrl`（Ren'Py 自带的 `DejaVuSans.ttf` 在引擎里、不在游戏里，指过去只会 404）。
- **`GET /renpy-skin/media?under=<目录>&match=<子串>`。** 归档里的资源原本没有任何办法
  列举；现在可以按目录前缀与子串在服务端过滤，响应多一个
  `filter: { under, match, matched, total }`（`matched` 是命中数、`total` 是过滤前总数：
  只报一个数字时分不清「一共 3 个文件」和「有 3 个匹配」）。无参数时行为不变。
- **字体 MIME 与 `nosniff`。** `mimeFor()` 补上 `.ttf`（`font/ttf`）、`.otf`、
  `.ttc`、`.woff`、`.woff2`——以前落到 `application/octet-stream`，实测 200 +
  octet-stream + 2.8 MB，浏览器宽容才刚好能用。`/asset` 现在带
  `x-content-type-options: nosniff`：游戏资产是用户文件，不能让浏览器嗅探成可执行文档。
- **`GET /settings` 返回 `dataHome`。** `resolveDataHome()` 的结果
  `{ path, source, legacy }`。本机实测两份数据目录并存
  （`C:\Users\<user>\.dsh-renpy-skin\` 与 `C:\Users\<user>\.dsh\renpy-skin\`，因为桌面宿主
  进程没继承 `DSH_HOME`），没有这个字段用户无法判断自己改的是哪一份。

### 修复

- **设置页里的次要按钮没有描边。** 宿主 `Button` 默认是 `ghost` 变体
  （`border: none; background: transparent`），插件里所有没写 `variant` 的
  `P.Button` 都显示成纯文本：重置布局、复制 JSON、从文件导入、粘贴导入、启用全部、
  媒体 URL 的「使用」、「用 Agent 加载」、「重新加载」、「复制提示词」、「稍后」。
  现在统一标上 `rsk-action` 并以 `outline` 渲染，边框与 `.rsk-btn` 一致；主按钮
  （保存布局、导出、加载、应用）保持实心外观。
- **「用 Agent 加载」在已有配置时会先确认。** `GET /vn` 的 `profile.savedAt`
  是「这个游戏已经有一份 Agent 配置」的证据；第一次点击只展开内联提示，再点一次
  才新建会话。提示带上原配置的写入时间，并说明现有配置可能被覆盖。`rejected`
  的配置也算——它仍然是这个游戏名下会被新配置覆盖的文件。按钮文案从
  「重读这个游戏」改为「重新加载」，因为这个动作只重新扫描磁盘，不碰 profile。
- **重置布局会说明会丢掉什么。** 第一次点击展开内联提示：有保存布局时说明重置
  只改当前编辑、要再点「保存布局」才会替换；没有保存布局时说明会丢弃未保存的
  位置。拖动、保存或复制都会取消待确认状态。
- **保存 profile 之后覆盖层会「自己撤销」。** 读 profile 用的目录键是
  `profileDirName(manifest.game?.name)`，而 `manifest.game.name` 正是覆盖层可以改掉的
  字段：扫描名 `CSE-2.1.0-pc` 被覆盖成 `CSE` 之后，下一次构建会去找
  `game/CSE/vn.json`（不存在），于是所有修正静默失效。现在目录键固定成**扫描名**
  （`record.scannedName` / `record.profileName` 在 overlay 之前定下），写入、读取、
  `/vn`、`/agent/prepare` 全部走同一个值。本轮实际踩到，靠两边各写一份 `vn.json` 绕过。
- **`null` 曾把扫描值清空，而回执里缺省的字段正是 `null`。**
  `profileOverlay()` 只跳过 `undefined`，于是 `null` 会真的写进清单；
  而 `renpy_read_manifest` 的输出恰好是 `renpy_save_vn` 的输入形状，Agent 把回执拷回去
  就会把字段全清掉。现在 `null` 与 `undefined` 都表示「保留扫描值」，与 TODO.md 里
  原先的注释一致。
- **旧数据目录的搬迁会永久停摆。** `migrateLegacyHome()` 以前在新目录已有
  `config.json` 时整体 `return []`，而 `config.json` 只在第一次保存设置时写出——
  于是「先存过一次设置、后来才回到还有旧 library/game 的机器」的用户永久看不到自己的库
  与存档，且毫无提示。现在改成**逐项合并**：缺哪项补哪项，已存在的条目一律不覆盖
  （它可能比旧副本新），仍然 copy-only、never delete、never throws。
- **`renpy_save_vn` 报的 `applied` 不能证明任何事。** 保存后重建读的是**另一个**目录，
  所以 `applied` 非空只能证明「某个 profile 被应用了」。现在重建直接用刚写入的目录，
  失败时带 `rebuildError`；`applied` 还会减去 `unknownKeys`（被写进去的拼错键不算
  「盖掉了什么」）。
- **`renpy_read_manifest` 漏掉一半会生效的字段。** 旧白名单里没有 `fontUrl`、
  `textboxImageBounds`、`textboxImageBox`、`nameboxImage`、`nameboxBounds`、
  `layout.nameboxTile`、`layout.choiceButtonBorders`、`choice.borders`、
  `choice.idleBackground`、`choice.hoverBackground`，Agent 因此没法修正它们；而
  `textboxImageBox` 是插件用 `lib/png.js` 的 `pngOpaqueBounds()` 按 alpha 阈值算出来的，
  Agent 根本不可能自己复现（同一张图自己算是 `(2,1,1917,276)`，插件给的是
  `{x:50,y:1,width:1821,height:276}`）。现在 dialogbox 18 键、layout 16 键、choice 8 键。
- **「用 Agent 加载」在脚本全在归档里的游戏上必然失败。** `lib/scantree.js` 的
  「没有松散脚本」分支把句子又包了一层数组，`renderUnderBudget()` 用
  `Buffer.byteLength()` 量这个嵌套数组时抛 `ERR_INVALID_ARG_TYPE`，`POST
  /renpy-skin/agent/prepare` 于是回 400：`The "string" argument must be of type string
  or an instance of Buffer or ArrayBuffer. Received an instance of Array`。只有「一份
  松散脚本都没有、脚本全在 `.rpa` 里」的游戏会走到这一支——也就是 CSE 2.1.0 这类商业
  发行版；有松散脚本的游戏从不经过它，所以测试一直全绿。两个分支现在各自直接返回
  字符串，回归用例 `test/scantree.test.mjs`「a game whose scripts all live inside an
  archive still produces a map」用一个真实 RPA-3.0 归档复现。

### 变更

- **`renpy_*` 工具与 stage-director 提示词曾经整块消失，而日志里什么都没有。**
  `systemPrompt`、`tools` 与 `webServer` 一样，都是在 `apply` 里一次性 `ctx.get(...)`
  读取的；各行并发挂载，服务晚到时读到 `undefined`，守卫就静默跳过注册。表现是
  请求的 47 个工具里没有一个 `renpy_*`、系统提示词里没有那一段，模型于是只能瞎猜
  （2026-10-16 的一次真实会话因此 31 步全在 reasoning，最后撞上 `max-tokens`）。
  三处现在都用 `ctx.inject([...], (scoped) => ...)` 等待服务，注册包在 `scoped.effect`
  里；`export const inject` 仍为 `[]`，始终不出现的服务只让它自己那一半不接线。

- **「用 Agent 加载」不再先投递后准备，失败也不再假装成功。**
  （1）新增 `POST /renpy-skin/agent/prepare`：校验目录与游戏（存在 → 是目录 → 能扫出
  清单 → 读到游戏名 → 有 `.rpy`/`.rpyc` 或 `.rpa`）、持久化选择、清缓存、把会话钉到
  这个游戏、写出两棵目录树，最后返回**真实路径**。只看目录是否存在会被任意空文件夹
  骗过，因为扫描器对任何目录都成功并把目录名当游戏名。
  （2）提示词 `agentLoadPrompt(facts)` 因此带上游戏名、游戏目录、配置目录、两棵树路径
  与各类文件计数，并明确告诉模型「游戏已由宿主加载，不要再问路径」；**没有**准备过的
  情况仍用另一套措辞（先问目录、再用 `renpy_configure`），因为那时宿主确实还没加载。
  （3）按钮流程改为「准备 → 建工作区 → 开会话 → 投递」，任何一步失败都 abort 并在面板
  显示宿主的原话，用 `prepared` 布尔区分「准备失败」与「开会话失败」两句文案。
  （4）**删掉自动复制到剪贴板的兜底**：它让「已发送到新会话」在什么都没发生时也照说。
  剪贴板现在只是失败后面板上的一个按钮（`copyAgentPrompt`），用户点了才写。
  （5）不切预设：平台没有运行中改预设的 API（`agentPresets` 只有 `resolve`/`mount`，
  且只在创建 Agent 时通过 `meta.agentPreset` 生效；`agents.create` 建出来的会话不进
  Shell 列表）。`renpy_*` 工具本来就是全局注册的，persona 由用户自己在 composer 里选。
- **存储根迁到 `$DSH_HOME/renpy-skin`。** `lib/home.js` 的优先级是
  `DSH_RENPY_SKIN_HOME` > `$DSH_HOME/renpy-skin` > `~/.dsh-renpy-skin`（空白视为未设置），
  并且首次解析到新位置、新位置没有 `config.json` 时把旧目录的 `config.json` /
  `library.json` / `game/` **复制**一次（只复制不删）。用 `DSH_HOME` 是因为它已经是 DSH
  官方的配置目录，与 `profiles/`、`sessions/` 平级；`lib/index.js` 里三处重复的路径
  表达式也顺手合并成一处。
- **两层目录树取代「让 Agent 自己走一遍 game/」。** 新增 `lib/scantree.js`：
  `scan-tree.md` 是给模型看的紧凑地图（硬预算 400 行 / 12 KB，按优先级分节，装不下时
  逐块截断并在文件里写明剪到哪一行、完整清单在哪个文件）；`scan-tree.full.txt` 是完整
  遍历（上限 20000 条，`.rpa` 只按顶层目录计数，否则几个 GB 的归档会变成十万行）。
  Remember the Flowers 0.17.9P 实测 2151 文件 → compact 184 行 / 5297 字节，
  full 2158 行 / 77031 字节。
- **新增 `tools/verify-agent-load.mjs`，让任务 7 的实机验收可以一键跑。** 它只打插件
  自己不鉴权的 HTTP 路由，因此不需要 CDP 或登录 token；重启 DSH 之后运行它，就能确认
  运行中的宿主真的在服务 `POST /renpy-skin/agent/prepare`、两棵树真的写出来、预算与
  Ren'Py 判定都成立。旧构建对这条路径回 405，但 405 是它通用的「未匹配」响应
  （`POST /renpy-skin/definitely-not-a-route` 也是 405），所以判定依据是响应体而不是状态码。
- **Agent 加载链路已在真实宿主里验收通过（2026-10-19）。** 没有杀掉桌面应用：另起一次性
  配置档 `verify`（`--from-default-profile web` + `plugin add link:<本仓库>`）在 19487
  跑同一份 `lib/`。`verify-agent-load.mjs` 10/10 通过；在浏览器里点「用 Agent 加载」后
  新会话的 `request/header` 是 30 个工具、含 4 个 `renpy_*`，`system/message` 带
  `## Ren'Py stage director` 区段（证明 `tools` 与 `systemPrompt` 两处 `ctx.inject`
  在真实 Cordis 里都回调了），`cwd` 正是配置目录，提示词与 `agentLoadPrompt(facts)`
  逐字一致，模型依次调用 `renpy_read_manifest` → 读两棵树 → `renpy_save_vn`，
  写出 `tree.md` / `summary.md` / `vn.json`，`turn/end` 为 `{"kind":"completed"}`。
  顺带记下三个坑：桌面宿主的 `buddy` provider 只由 Electron 注册、免费车道从本机出口
  一律 `INVALID_CREDENTIAL`、第三方网关会**预扣**整个 `maxTokens` 额度（余额不足时
  `defaultMaxTokens: 131072` 直接 403，验收用 8192）。`dsh web` 会把带 token 的 URL
  打到 stdout，这是唯一能自动拿到 SPA 登录 token 的途径。

- **Agent 写完配置后有了完成信号：弹窗问「立即更换 / 先保存」，另外补上一个只读工具
  与一处可查的记录。**
  （1）弹窗：点过「用 Agent 加载」且提示词投递成功后，客户端每 3 秒读一次
  `GET /renpy-skin/vn`（上限 10 分钟），`profile.savedAt` 变化就在新注册的
  `shell.overlay` 层（order -860，高于 popover 与 splash）弹模态——一句话
  （改掉 N 个字段 / 没盖掉任何东西 / 属于别的游戏目录）+「立即更换」「先保存」；
  Esc、点遮罩与「先保存」等价，「立即更换」只重拉一次清单（宿主在写入时已重建缓存）。
  （2）只读工具：`renpy_read_manifest` 返回本次扫描真正读到的值（画布、对话框与几何、
  选项按钮、颜色、字体、角色、变换、背景），形状与 `renpy_save_vn` 的 `config` 一致，
  以 JSON 代码块给出；`AGENT_LOAD_PROMPT` 与 persona 因此改成「先读 → 再改 → 再写」。
  （3）记录：`vn.json` 新增 `report: { ignored, malformed }` 元数据，`GET /vn` 回读
  `profile` 时带上，并新增 `summary`/`tree` 头部（各 4000 字符，缺失为 `null`）；
  设置页新增只读卡片显示 `savedAt`、`applied` 计数、被忽略/丢弃的段、归属冲突与
  `summary` 开头。
  （4）投递失败的那句 notice 现在用 `title` 显示真实原因；连剪贴板也失败时提示词
  整段写进 `console.warn`，不再无路可走。
  （5）`cordis.patch.yml` 的 persona 缩成身份 + 工具清单 + 三条规则，删掉与提示词
  矛盾的「只给名字就搜常见位置」与硬编码的三个立绘上限；套件 180 → 186 项。

- **Agent 加载链路的三处硬伤修掉了：不再假成功、覆盖层认路、被丢弃的段会被点名。**
  （1）会话定位：轮询跑完时 `[data-conversation-session]` 若没变，就看 composer 的阶段钩子——
  会话已经开始说明宿主什么都没打开，此时**不再**把提示词排进用户正在看的那条对话，而是
  当失败处理、降级为复制到剪贴板（旧行为会静默投入并报「Sent to a new session.」）；
  只有确认是宿主复用的那个空白会话才继续投递。
  （2）`workspaces.create` 失败不再连坐整条流程：它只记一条警告，会话照开，Agent 的临时
  文件落回当前工作区，而不是把整件事降级成剪贴板。
  （3）`vn.json` 现在记**解析后**的资源目录，读取时再解析一次后比较，同名但不同路径的
  profile 会被跳过并写 `manifest.profileRejected`（`GET /renpy-skin/vn` 的 `rejected`），
  不再拿另一个游戏的配色、字体、对话框几何来换肤；任一侧为空即视为未知、照旧应用，
  旧文件不会因为缺字段失效。
  （4）`renpy_save_vn` 的回执把 `applied`/`ignored`/`malformed` 分开报，段名不在名单里
  或值不是对象会当场点名，而不是继续用「扫描本来就一致」安慰人；工具描述里
  「summary 会成为 transcript」「界面立刻重新换肤」两句不实的话也改了。

- **「用 Agent 加载」第一次有了行为测试。** `test/client.test.mjs` 现在可以注入 DOM、
  剪贴板、计时器和三个假服务（`uiWorkspace`/`sessions`/`workspaces`），六条用例覆盖：
  新会话投递、复用空白会话、会话已开始则拒绝投递、工作区 id 取宿主的返回字段、
  工作区失败不牵连会话、剪贴板降级与彻底失败。套件 155 → 180 项，
  `test/skin.test.mjs` 与 `test/vn.test.mjs` 也补了归属校验与段回报的用例。

- **「用 Agent 加载」按钮真的能用了，并挪到游戏信息那一行。** 以前它是个占位按钮（点了只说「尚未实现」）。现在点击会新建一个会话、把一段写好的提示词投进去，Agent 拿到游戏名或路径后用 `renpy_configure` 加载并汇报。按钮与「重读这个游戏」并排放在游戏信息右侧，原来那张只有占位按钮的「加载新游戏」卡片去掉。提示词里写明当前界面语言（中文界面就要求用中文提问和汇报），因为新会话不继承任何 persona 或 locale。任何一步失败都降级为「把提示词复制到剪贴板」，界面上给出对应提示。实机验证：新会话被创建、提示词到达、Agent 用中文反问游戏路径。

- **Agent 现在会把这个游戏的读法写成配置文件，插件下次自己加载。** 提示词要求 Agent 走一遍游戏的 `game/` 目录，写下每个文件与文件夹的作用、以及哪个模块读它；用新增的 `renpy_save_vn` 工具把目录树、读到的值和一段压缩过的会话摘要写进数据目录下的 `game/<VN 名>/`（`vn.json` + `tree.md` + `summary.md`）。`vn.json` 的 `config` 是**覆盖层**：清单仍然来自扫描，它只盖掉扫描读错或读不出来的字段，改动了哪些路径由新的 `GET /renpy-skin/vn` 报回来（`profileApplied`）。写入必须是工具而不是 Agent 自己的文件工具——后者的写入被限制在它自己的工作区内，而配置文件要落在插件的数据目录里，所以「用 Agent 加载」会先把那个目录注册成工作区再开会话。

- **Ren'Py 8.5 的 `.rpyc` 现在读得出来：unrpyc 需用 v2.0.3 以上。** 旧版 2.0.2 对 8.5 字节码报 `expected 5, got 7` 且退出码仍是 0，于是脚本被静默读成空。`findUnrpyc` 现在会探测多个位置并按版本号（数字序）取最新的 `unrpyc*` 检出，`DSH_RENPY_UNRPYC` 仍可强制指定工具、`DSH_RENPY_TOOLS` 可指定检出所在目录（默认 `~/Tools`）。验证：两个此前读不到脚本的游戏从 0 变换/0 标签变为 153 变换 / 6 标签，字体、姓名框、对话框位置都读到真实值。另修了 `<loop 5.3>music/x.ogg` 这种 Ren'Py 音频片段前缀被当成文件名的问题（某个游戏的标题音乐 URL 因此失效）。

- **读不到对话框贴图的根因：手机 `variant` 样式块覆盖了桌面样式。** 模板在 `screens.rpy` 后部用 `style window:` + `variant "small"` 重述手机版（`background "gui/phone/textbox.png"`），后出现的块盖掉了桌面的 `Image("gui/textbox.png", ...)`，样式查找落空。以前所有游戏都只是碰巧叫 `gui/textbox.png` 才显示出来，换了文件名的游戏会丢贴图。现在忽略 small/touch/mobile/android/ios/tablet/phone 变体块；`background` 接受裸字符串和 `Frame/Image/Transform` 包装；读出 `Image(xalign, yalign)`，按窗口的 `textbox_yalign` 定位并裁掉画布以下的部分（RtF 的 `yalign=0.9`）。manifest 新增 `dialogbox.textboxSource`（`gui-variable`/`style-window`/`conventional-path`/`none`）与 `textboxImageAlign`，便于排查。
- **VN 读取流程加固（四路审计，详见 `docs/VN-READ-AUDIT.md`）。**
  - 对话框几何：读 `style window/namebox/say_dialogue`（高度、位置、宽度、字号、颜色、字体、贴图），
    `gui.*` 显式值仍优先；`@gui.variant` 的手机分支不再泄漏到桌面值（SharedHouse 的 400px 框）。
    Castle&Myosotis 高 278→300、字体改读 `B.ttf`；Arches 文字位置 135→402、宽 1650→1116。
  - 脚本来源：松散 `.rpy` > 松散 `.rpyc` > 归档 `.rpy` > 归档 `.rpyc`，忽略 `tl/`；
    修复去重失效导致归档旧副本覆盖松散 `gui.rpy`；只含脚本的 `scripts.rpa` 现在也会被读取；
    反编译分块（每块 32 个、总 300 秒上限），只反编译排序后的前 48 个，失败不影响其余资源。
  - 资源索引：一次遍历、归档按引擎规则先到先得、松散文件覆盖归档、路径大小写不敏感但返回规范拼写；
    截断写入 `stats.indexTruncated`；新增 RPA-2.0。SharedHouse 首次构建 26 秒 → 约 4.4 秒。
  - 媒体分类：`gui/`、`ui/` 下的图标不再进入立绘索引；`bg/`、`backgrounds/` 下带空格或属性的文件归为背景；
    开场识别 `show/scene` 与 `pause`；无 `config.main_menu_music` 时回退到 `label/screen main_menu` 里的 `play music`。
- **输入区在新会话里保持 DSH 原样，发出第一条消息后才换成 VN 对话框。** 所有 composer 规则都限定在宿主的
  `active` 阶段（新会话是 `hero` 阶段）。
- **模型选择器不再缩成一个光秃秃的图标。** 宿主的 `observeControlRow` 用
  `row.getBoundingClientRect().width` 判断按钮行放不放得下，放不下就把模型芯片收成图标
  （`data-model-compact`）。此前插件把按钮行也 `display: contents` 融进卡片，那一行的宽度因此为 0，
  「放不下」永远成立——无论窗口多宽，凡是活动会话都只剩一个图标。现在按钮行保留自己的盒子，
  卡片单独溶解；实测宽度 1313px 时行内三个控件齐全。
- **统计 dock 改成叠在按钮行中央。** dock 与卡片是兄弟节点，没法用 `order` 插进按钮行的两个
  子节点之间，所以改为相对根节点绝对定位居中，工具 · dock · 模型仍是一行左中右。窄于 620px 时
  隐藏 dock：那时它与两侧控件必然重叠。根节点用 `column` + `space-between` 把输入区顶到上、
  按钮行压到下，输入区改为 `flex: 1 1 auto` 吃掉中间的高度，文字与按钮之间不再留一条空白。
- **输入区只显示贴图真正画出来的那一块。** 新增 `lib/png.js` 读取透明通道得到非透明包围盒
  （GoToSnowTown 的 `textbox.png` 是 1920×1080，纸片只有 1411×292）；文字内边距、高度、字号都相对这块纸片换算。
- **输入区按 VN 的文本框还原大小、文字与位置。** 全部以游戏画布宽度为基准换成
  `cqw`，所以输入区多宽就按多大的比例还原，不随窗口乱跳：贴图按它自己的像素宽度
  相对画布缩放并底部居中（等同 `Image(yalign=1.0)`，不再被拉伸成 100% × 100%）；
  卡片高度下限取 `gui.textbox_height`（夹在 88–240px，只是下限，输入多了照常增高）；
  文字使用 `gui.text_color`、按 `gui.text_size` 缩放字号（夹在 14–28px）、
  `gui.dialogue_text_xalign` 决定对齐，占位符用同色 55% 透明度。输入区之外
  （会话消息、用户气泡）不动。姓名框没有对应位置，未还原。
- **输入区改成与 VN 对话框一致的扁平文本框。** 仍然只作用于 composer，会话消息与
  用户气泡不动，选择器全部走 composer 自带的 `data-*` 钩子（宿主的哈希类名每次
  构建都会变）。具体：根节点去掉内边距；卡片宽度 100% 并用 `max-width: none` 盖掉宿主的 `--dsh-composer-card-max-width` 上限，去掉 `box-shadow` 与
  `border-radius`；输入框与占位符的内边距取自 `gui.dialogue_xpos` /
  `gui.dialogue_ypos` / `gui.dialogue_width`，按画布宽度换成 `cqw`，随输入区宽度等比缩放。
  游戏没声明这些值时不写内边距规则。

### 修复

- **超过约 512 MB 的 `.rpa` 被当成「不是归档」，整个游戏的资源消失。** `isRpa` 为了看开头
  五个字符把整个文件当字符串读进来，超过 V8 字符串上限就抛错、被吞掉后返回
  false。SharedHouse 的 1.7 GB `archive.rpa` 因此只剩 8 个背景、2 个立绘，实际是
  227 张背景、265 张 CG、1798 张立绘（修复后 296 背景/195 标签）。现在只读开头 5 字节；
  `openRpa` 也不再把整个归档读进内存——只读头部与索引尾部，条目按需读取，并新增
  `sizeOf` / `slice` 供读取图片尺寸与音频头时只取开头，不必把每张图整个读一遍。
  回归测试在 `test/rpa.test.mjs`（需要约 600 MB 空洞文件，磁盘空间不足时跳过）。
- **标题画面兜底挑到嵌套的重复文件。** 同时有 `gui/gui/main_menu.png` 与
  `gui/main_menu.png` 时按字母序拿到了前者；现在取层级最浅的那一份。
- **换字体不会立刻生效，且只影响输入框。** 字体现在写进 `--dsw-font-family`，
  整个界面一起变；每个 VN 字体按路径派生唯一的 `@font-face` 族名，不再把同一个名字
  反复指向不同文件。设置项键名仍是 `composerFont`，标签改为「界面字体」。
- **VN 的文字大小不再改动会话字号。** 去掉了按 `gui.text_size` 缩放
  `--dsh-content-font-size` 的那段，会话字号保持宿主原样。
- **滑块拖动时只有数字在动，效果要等松手。** 现在不卡顿的效果在拖动中就跟着变：
  背景亮度当场重画、播放列表音量当场变响、舞台立绘上限当场增删立绘。做法是
  `previewSettings(patch)` —— 把这份设置乐观并进 store（每个读 `state.settings` 的
  效果立刻反应），但**不发 POST**；落盘仍然只在手势结束时发生一次。拖动期间
  `pollStage` 会跳过 settings 回显（`previewPatch !== undefined`），否则宿主那份
  900ms 前的旧值会把控件拽回原位；`saveSettings` 在 `finally` 里清掉这个标记，
  所以 POST 失败也不会把轮询永久卡住。会卡顿的效果——播放进度条，每个 `input` 都
  seek 会打断正在播的音频——不接 `onPreview`，效果与存储一起在松手时落地。
  这条约定已写进 `AGENTS.md` 的「滑块与数值控件」一节，新增数值控件时照它办。
  *（实机复验时抓到第一版的破绽：预览写的就是控件自己读的 store，于是松手时
  `value` 已经等于草稿，判断「变没变」的那一句把每次拖动都判成没变——拖动 0 个
  POST、松手也 0 个，效果只留在本地，宿主那份配置从没被写。基线改成「手势第一次
  `input` 时记下的值」后修好；没有变化的手势同时要显式 `endPreview()`，否则
  不会有 POST 来清掉预览标记。）*
- **新会话里右上角的两个按钮滑到了页眉左边。** 会话页眉右侧那一行
  （`conversation.session.header.utilities`）之所以靠右，靠的是它左边那个
  `flex: 1` 的面包屑簇把它顶过去；空白会话里宿主把整簇标题藏起来，这一行就失去了
  唯一的推力，连同宿主自己的按钮一起滑到页眉最左端——宿主只为自己的角按钮补了
  `margin-left: auto`，插件这两个没有。现在只要页眉里没有标题簇（以
  `conversation.session.header.actions` 座位在不在来判断：宿主渲染标题簇时才会
  渲染它），这两个按钮就贴到它们有标题簇时所处的同一组偏移上（`top: 11px;
  right: 48px`）。两种状态下这组偏移完全一致，所以有会话时不会有任何位移；实机
  DOM 里量过，空白会话与活动会话都落在距页眉右缘 48px、距上缘 11px。
- **完全没有会话时，页眉整条塌成 0 高。** `sessionId` 不存在时宿主根本不渲染
  会话页眉，而是拿一个空 titleRow 顶替，`headerBlank` + `headerSessionless` 把
  内边距与最小高度一并清零，于是整个页眉高度为 0，插件的注册无处显示（此时宿主
  自己的按钮同样不在，因为它们也在那半个页眉里）。同一组按钮现在还会注册进
  `conversation.header.leading`——平台文档写明这个座位「无会话时也可用」——并把
  页眉的高度还回来（44px：11px 上边距加上 28px 按钮）。两份拷贝永远只有一份在
  屏幕上，由样式表决定：两个座位都在同一个 `<header>` 元素内，
  `header:not(:has(.rsk-head-primary))` 就是「primary 不在」。
- **数值滑块不再声明 `step`。** range 输入不写 `step` 时隐式步长是 1，所以做法是
  把量纲换成整数、把分辨率放进刻度里：播放列表音量走 0–100 的整数百分比（写回
  `Math.round(v) / 100`，顺带消掉了旧 `percentLabel` 的取整），播放进度条走 0.1 秒
  的刻度（`Math.round(duration * 10)`，比旧的 `step: 0.5` 更细），文字速度滑到 400
  （与钳制上限一致）。「舞台最多显示立绘数」也不写 `step`：它本来就只能用整数，
  隐式步长 1 正好是想要的粒度。布局编辑器里那个 `type="number"` 的数值输入不是
  滑块，±0.01 的按钮也随它保留。
- **重载之后两路音频叠在一起。** 客户端一半全程只有一个 `<audio>` 元素，但
  「同一时刻只有一个音源」这条规则只在**一个闭包内**成立：重载客户端（宿主重启
  而页面没有刷新时同样是重载）会重新求值工厂，新闭包里的 `playerElement` 是空的，
  而上一份的元素还在播——随后第一次点击又让新实例从 0 开始同一首主菜单曲目，两路
  互相拍打，听起来又吵又糊。现在元素会停在 `globalThis.__dshRenpySkinAudio` 上：
  模块求值时先拆掉上一份的（`pause()` → 移除 `src` → `load()`，只 `pause()` 会
  留着缓冲，下次一恢复就又有声音），插件卸载时通过 `ctx.effect` 的清理函数释放
  自己的元素。
- **跳过开场之后片头的声音还在响。** 点击跳过时图层在 420 ms 后卸载，而**从文档中
  移除的 `<video>` 并不会停止播放**——片头曲继续响，而触发跳过的同一次点击又会
  开始播放主菜单音乐。现在 `dismiss()` 立即 `pause()`（保留最后一帧给淡出），
  卸载或换源时再由 effect 的清理函数把元素彻底拆掉。
- **播放列表的计数会折成两行。** 「筛选曲目」右侧的 `112 首` 被挤成了
  `112` / `首`：`.rsk-input` 是 `width: 100%`，作为 flex 项目时它的
  `flex-basis: auto` 会解析成整行宽度，于是旁边的读数只能分到几个像素。
  输入框改用 `flex: 1 1 0%`（并允许收缩到内容宽度以下），读数加
  `.rsk-nowrap`——`flex: 0 0 auto` 加 `white-space: nowrap`，既不收缩也不折行。
  音量读数同时从 `0.55` 改成 `55%`（两个音量滑块共用新的 `percentLabel`）。
- **「背景压暗」改为「背景亮度」。** 这个滑块以前直接显示压暗量（`0.50`），
  向右拖是变**暗**——与「亮度」这个词正好相反。现在它按亮度呈现，向右拖是变亮：
  控件走 0–100 的整数百分比（**不声明 `step`**，range 输入默认步长就是 1，
  正好是想要的 1% 粒度），写入的压暗量是 `(100 − v) / 100`，因此天然只有两位小数，
  也不必再靠取整去躲二进制浮点毛刺（`1 − 0.7` 是 `0.30000000000000004`，
  而 `30 / 100` 就是字面量 `0.3` 的那个 double）。存储的键名与语义都没动
  （CSS 渐变和 0–1 钳制仍然用压暗量）：改键名会让已经调过这个滑块的人静默回到默认值。
- **切换游戏后背景还是上一个游戏的。** 每个游戏的 `gui/main_menu.png`
  都解析成同一个 URL `/renpy-skin/asset?p=gui%2Fmain_menu.png`，
  而该路由带 `cache-control: private, max-age=3600`，于是浏览器
  直接回放了自己缓存里那份**旧游戏**的字节——清单是对的，
  屏幕上的图是错的。（同一条路径下受影响的还有立绘、对话框贴图、
  选项背景、开场图：凡是通过 `assetUrl` 生成的 URL 都一样。）
  现在每一次构建都会生成一个唯一令牌 `assetToken`，并拼进该次构建的
  每一个资源 URL（`?v=<token>&p=…`），把浏览器缓存键限定到某一次构建。
  清空 `manifestCache`（切换游戏、重读磁盘）会重新生成令牌，所以
  归档内容变化也会顺带失效缓存。客户端自己拼 URL 的那一处
  （`splashMedia` 覆盖）改为从清单读取同一个令牌。
- **背景覆盖了整个外壳。** 它被注册进 `shell.overlay`，
  而宿主会将其渲染为各列在 `z-index: 20` 处的绝对定位同级元素——
  因此该图像及其遮罩既绘制在侧边栏*之上*，也绘制在
  消息文本之上。现在它绘制在会话主体
  （`[data-conversation-content]`）上，位于消息之后并避开其他所有
  列，同时遮罩被并入同一个 `background-image` 渐变。
- **背景图像错误。** 回退值是 `manifest.backgrounds[0]`，但
  该列表按字母顺序排序，所以它只是按名称排第一的图像——
  并非游戏的主菜单美术资源。`pickBackground` 现在将 `main_menu` 排在首位，
  其次是其他 `gui/` 美术资源，然后是 `bg/`/`backgrounds/` 目录。
- **舞台图层吞掉了所有点击。** `.rsk-layer` 声明了
  `pointer-events: none`，但宿主会把 `pointer-events: auto` 强制施加到其覆盖层的
  每个直接子元素上（`.BynINW_overlayLayer > *`），而那条子选择器
  规则的优先级高于普通的类选择器。现在该声明
  带上了 `!important`。
- **一个 `<style>` 标签大约每秒被重建一次。** `pollStage` 按引用
  比较刚解析出的设置对象，因此比较结果永远为真，
  每个订阅者都会在每 900 ms 的一次轮询中重做其工作。`sameJson` 取代了
  它，并且 `applySkinCss`、`applyTheme` 以及新的背景写入器都各自
  沿用其现有标签，除非生成的文本确实发生了变化。
- **滑块卡顿。** `SliderRow` 在拖拽期间报告了每一个 `input` 事件，
  而每次报告都以一次 POST 加一次完整的清单重建告终。现在被拖拽的值
  保存在本地，并在手势结束时一次性提交。
- **一次设置写入白白重建了清单。** 开关现在跳过
  `refreshManifest`；只有 `gameDir` 补丁才会触发它。
- **样式表从未安装。** 它是通过 `globalThis.styles` 获取的，
  而只有 `cordis-client-runner` 那条通道才提供它。模块加载器（Module Loader）包
  （`window.__ModuleLoader__.load`）永远看不到它，因此整个 `.rsk-*` 样式表
  被静默丢弃。`applyStylesheet` 现在回退为直接创建该标签。

### 新增

- **测试套件增长到 169 个测试。** 在 `test/audio.test.mjs`、`test/client.test.mjs`、
  `test/skin.test.mjs`、`test/rpa.test.mjs`、`test/rpyc.test.mjs` 之外又加了
  `test/vn.test.mjs`（VN 配置文件：目录名合法性、坏文件降级、覆盖层白名单与一层合并）
  和四份审计用例（`test/audit-dialogbox|assets|media|scripts.test.mjs`）。
  需要 unrpyc 的 5 个用例在工具缺失时跳过，其余照常运行。
  `audio.test.mjs` 构造真实的 WAV/MP3/Ogg/FLAC 字节缓冲区，并对照 `ffprobe`
  在 824 个真实文件上做了交叉校验；`client.test.mjs` 是第一个真正执行
  `lib/client.js` 的测试——它用一个 `require` 求值该 bundle，该 `require` 对除
  `react` 和 UI 原语之外的任何说明符都会抛出异常，从而证明客户端半边能解析、
  能注册全部插槽，并在某个服务缺失时降级而不是抛出异常。它无法证明渲染。
  其中两个测试专门钉住受门控的服务查询：Cordis 上下文会**抛出**
  `cannot get property "…" without inject`，而不是返回 `undefined`，因此
  `applyLocale` 的查找必须捕获它，而不是把 `locale` 加进 `exports.inject`——
  那会把它变成必需服务。

- **开场不再能卡住界面。** 当提取到的开场是一张整屏图、而该 label 其实靠
  屏幕内的 `timer` 推进时（`first_splash` 这类纯文本声明页），此前没有任何
  东西会结束它——`<img>` 永远不会触发 `ended`——图层就一直盖在会话上面。
  现在 `lib/renpy.js` 的 `collectSplash` 把该 label 及其引用屏幕里的每个
  `timer N` 收进 `timers`，`lib/manifest.js` 的 `splashSecondsFor` 取其中最长的
  一个（钳制在 2–12 秒，一个都没有就用 4 秒兜底）作为 `splash.duration`，
  客户端到点自动关闭。取最长而不是求和，是因为那一串屏幕是**互斥的备选**，
  累加会严重高估。这是兜底而不是播放时长，用户仍可点击跳过；视频另有 180 秒
  的上限，防止文件损坏时永远黑屏。
- **加载新游戏的控件归位，快捷设置瘦身。** 此前「重读这个游戏」在「已分析的
  VN」那一行、而「加载」在下一张卡片里，两个动作看着像两件事；现在目录行变成
  `[输入框] [加载] [重读这个游戏]`，重读按钮从 VN 行移除。快捷设置弹层里
  重复了一整套「添加游戏目录」表单，还带着「重读」按钮和语言行——弹层本该是
  快捷开关，现在这三样只在完整设置页出现（快捷设置仍共用同一个 `SkinSwitches`，
  只是以 `showLanguage: false` 渲染）。
- **开场媒体改为从游戏里选文件。** 以前是一个要求用户手打游戏相对路径的输入框
  （占位符 `video/echosplash.webm`）——打错了既没有反馈，也无从发现游戏里到底有
  什么。现在是一个「选择文件…」按钮，点开列出**当前游戏自带的**图片与视频
  （视频在前，取自新的 `GET /renpy-skin/media`，它走的是同一个资源索引，因此
  `.rpa` 里的条目也在列表里），带搜索框；选中后在按钮下方显示
  「已选择: <路径>」，并有一个「清除」。列表刻意不复用 `manifest.backgrounds`：
  splash 视频不是可显示对象，永远不会进入那份索引。列表按解析出的 `gameDir`
  缓存，切换游戏与「重读这个游戏」都会清空它。
- **音乐播放列表面板不再兼任设置页。** 面板顶部原本有一块「主菜单曲目」
  （曲目名 + 跟随开关 + 试听按钮），与设置页里的同名控件重复——弹层应该是
  播放器，不是第二套设置。这块整体移除，开关与曲目选择留在设置页。
  主菜单音乐本来就默认开启（`menuMusicOnStart` 默认 `true`），所以拿掉试听
  按钮并不影响“直接开播”。顺带修了一句错提示：设置页的曲目行在没有候选曲目
  时仍写着“解析到的曲目”，现在改说「这个游戏没有声明主菜单音乐」。
- **回到主界面时的渐入。** 关闭开场图层时不再硬切：`.rsk-splash` 先淡出、
  主界面再从不透明度的低值渐入（纯 CSS，不新增设置项）。
- **切换游戏时的开场开关**（`splashOnSwitch`，默认关闭）。切换 VN 本来就是一次
  整屏状态复位，但重新播一遍开场属于主观偏好，因此单独给一个复选框，
  默认关闭；`splashOnStart` 只管 DSH 启动那一次。
- **已分析 VN 的库**（早期在 `~/.dsh-renpy-skin/library.json`，2026-10-18 起是
  `$DSH_HOME/renpy-skin/library.json`）。每个被分析过的
  游戏都会连同名称、版本、统计与时间戳被记住，最新的在前，上限 50 条。
  `GET /renpy-skin/library` 返回该表，`POST /renpy-skin/library` 成为
  **切换游戏的唯一入口**：它在一个往返里持久化路径、丢弃每个会话的固定
  指向与所有按游戏缓存的清单/归档句柄，并返回新清单与刷新后的索引——
  因此弹出层的忙碌态真的画得出来（此前三行同步调用意味着它永远画不出来），
  且旧游戏的立绘在新清单到达的瞬间就消失。页眉面板与完整设置页共用一个
  「已分析的 VN」下拉框；强制重扫磁盘的「重读这个游戏」按钮在完整设置页的
  「加载」旁边（见上文）。
  `renpy_configure` 工具现在也会登记，因此模型加载的游戏同样出现在下拉框里。
- **切换到外部加载的游戏时会复位全部状态。** 客户端此前只在选择框路径
  处理切换：模型用 `renpy_configure` 换游戏、或另一个窗口改了同一份配置时，
  客户端只在 900 ms 轮询里看到 `settings.gameDir` 变化，于是清单、调色板、
  角色表、背景与播放列表全部停在旧游戏上。`applyGameSwitch` 比对
  `activeGameDir`，一变就丢弃这些状态并重新拉清单。
- **退出时静音。** 卸载事件里除了 `pause()` 还会
  `removeAttribute("src")` 并 `load()`：只 `pause()` 会留下解码器进程，
  用户报告过窗口关闭后仍能听到音乐，直到所有 DSH 进程退出。
  绑定了 `pagehide` / `beforeunload` / `unload` 三个事件而不是赌其中一个，
  因为宿主的 `close` 处理器其实只是隐藏窗口（`hideMainWindow`），
  退出前还会再隐藏一次，究竟哪个卸载事件会送达属于宿主实现细节。
  刻意**不**绑 `visibilitychange`：最小化和切换工作区同样会隐藏窗口，
  两者都不该中断音乐。
- **输入区背景开关**（`composerBackdrop`：`default` / `transparent` / `solid`）。
  宿主的贴底输入区自带一层渐变，会在游戏美术铺满对话区后盖住图像底部，
  因此现在可切换。覆盖必须带 `!important`——理由与 `.rsk-layer` 相同，
  宿主自己的后代选择器优先级高于单个类名。
- **页头工具**（`conversation.session.header.utilities`）：外壳右上角区域中的
  两个图标按钮。Ren'Py 标记会打开插件
  **自己的**浮动面板（快捷开关加上一个通往完整设置页面的链接）；
  音符图标会打开播放列表弹出框。该面板之所以是独立界面，是因为
  DSH 设置对话框**没有已文档化的客户端 API**——它的 store 是
  `client-ui-settings-general` 内部的私有闭包，只能从
  `settings.launcher` 的占据者访问，而那是账号插件
  已经占用的一个 `kind: single` 插槽（在那里注册会替换
  随包发布的 UI）。因此面板中的一个按钮会经由
  `slots.entries("sidebar.settings")[0].store` → `slots.resolveStore(...)` →
  `actions.openSection("renpy-skin")` 深链到该对话框，当任一环节不可用时
  回退为给出手动路径。参见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。
- **启动时的开场**（`splashOnStart`，默认**关闭**）。`label splashscreen:`
  会被提取并全屏重放：该 label 播放的影片
  （`renpy.movie_cutscene(...)`）优先于它所展示的最大的全屏静帧，
  而后者又优先于 `presplash.png`。`splashMedia` 可以用
  任意路径或 URL 覆盖提取结果，点击会关闭该图层（`splashSkipOnClick`）。视频会被暂缓播放，
  直到浏览器报告其可播放，因此不受支持的
  编解码器会降级为静帧，而不是黑屏帧。
- **主菜单音乐**（`menuMusicOnStart`）。`config.main_menu_music` 会被
  静态解析，包括真实游戏使用的形态——
  `config.main_menu_music = main_menu_music()` 置于
  `if persistent.theme == '…'` 的函数体之上——以及 `audio.<name>` 别名表
  （`define -500 audio.x = "audio/music/x.mp3"`，优先级词法单元可选）。默认分支
  会被播放；其他分支会被列出，以便 `menuMusicTrack` 挑选其中之一。
- **页头音乐播放列表。** `game/audio/music/` 下的每个音频文件，
  依次向外查找到 `audio/sound/`、然后 `audio/`、然后是游戏目录，
  首个匹配者胜出。时长 `<= 10 s` 的文件作为音效（stinger）被丢弃，
  时长由一个新的零依赖 `lib/audio.js`（`wav` / `mp3` / `ogg` / `opus` / `flac`）从
  首尾各 64 KiB 读取——并且**时长未知的曲目始终保留**。
  同一个 `<audio>` 元素同时支撑播放列表和菜单音乐，因此二者
  永远不会重叠。
- **音频和视频现在会被索引**（`AUDIO_EXTENSIONS` / `VIDEO_EXTENSIONS`），
  包括 `.rpa` 归档内部的条目——此前只发现图像，
  因此除非精确知道路径，否则任何音频都无法访问。
- **`GET /renpy-skin/asset` 上的 `Range` 支持。** 返回带有
  `accept-ranges: bytes` 和 `content-range` 的 `206`；语法有效但
  无法满足的范围返回 `416`。`<video>` / `<audio>` 在跳转时会发出 `Range`，
  并拒绝播放未带该头的媒体，而同一条路由现在还会提供
  `video/webm`、`video/mp4`、`video/ogg` 等格式。
- **角色多选**（设置 → 角色），由一个新增的
  `enabledCharacters` 设置项支撑。这是用户意图对模型起决定作用的唯一之处：
  空列表意味着“所有角色”，因此全新安装永远不会出现
  没有演员阵容的舞台，而非空列表会收窄 `directorBrief` 的角色名单，*并且*使
  `applyStatements` 拒绝未勾选的 `show`，并给出 `未启用，请到设置勾选`。

### 文档

- **全部文档转为简体中文。** `README.md`、`AGENTS.md`、`TODO.md`、
  `CHANGELOG.md` 与 `docs/` 下的三份文档现已为中文；代码、标识符、
  设置键、路由、命令与数字保持原样，只翻译说明性文字。英文原文保留在
  `.tmp/en/` 作为回退基线（该目录已被 `.gitignore` 排除），因为在本次提交之前
  本仓库没有任何提交，没有其他可回退的副本。
- **语言约束随之调整。** `AGENTS.md` 的硬性约束由「英文」改为
  **代码用英文、文档用中文**：代码注释仍解释「为什么」而不是「做什么」。
- **为发布清掉了本机专有的路径。** 这个包要装到别人机器上，写死盘符会把
  「没装 unrpyc」变成一次注定失败的查找，也会泄露作者的目录结构。
  `lib/rpyc.js` 的默认工具目录由固定的 `D:\Tools\unrpyc-2.0.2` 改为
  `DSH_RENPY_TOOLS` → `~/Tools`；`test/audit-scripts.test.mjs` 不再自带盘符，
  改为从 `findUnrpyc()` 解析出的位置取 unrpyc 自己的测试夹具，另一个需要真实
  游戏字节码的用例改为非要 `DSH_RENPY_CSE_RPYC` 不可（否则跳过）；
  `README.md`、`AGENTS.md`、`docs/STATUS.md`、`docs/ARCHITECTURE.md`、
  `docs/VN-READ-AUDIT.md` 与 `CHANGELOG.md` 里的示例路径一并改为通用写法。

## [0.1.0] — 2026-10-13

### 新增

- **宿主端**（`lib/index.js`）：带有 `inject = []` 且对每项服务都使用受防护的
  `ctx.get(...)` 访问的插件行。
  - `renpy_stage` 工具——用 Ren'Py 显示语句驱动舞台。
  - 系统提示词区段 `renpy-skin:stage-director`，排在
    `PLAN_POLICY` 之后，除非配置了游戏目录且其可读，否则保持静默。
  - `/renpy-skin` 下的六条 HTTP 路由：`manifest`、`asset`、`stage`、
    `settings`（GET + POST）、`layout`。
- **客户端半边**（`lib/client.js`）：手写的 lazy-CJS 工厂，无构建步骤。
  位于 `shell.overlay` 上的背景图层与舞台图层、一个 `settings.section`
  页面，以及由强调色派生的主题色变量（theme token）覆盖（10 个别名变量，亮色 + 暗色）。
  每 900 ms 轮询一次宿主舞台。
- **清单构建器**（`lib/manifest.js`）：读取 `gui.rpy` / `options.rpy`，
  以真实的图像头尺寸索引可显示对象，派生图像名称，
  解析背景和立绘标签，提取对话框 / 选项的几何
  与颜色，并从游戏强调色派生主题色变量。
- **Ren'Py 读取器**（`lib/renpy.js`）：注释剥离、字面值
  求值、`gui.*` / `config.*` 赋值收集、`transform` 块
  读取、`layeredimage` 块读取，以及一个跳过引擎
  目录的文件列出器。
- **RPA-3.0 读取器**（`lib/rpa3.js`）：pickle 操作码虚拟机、XOR 密钥索引，
  拒绝执行 `REDUCE` / `INST` / `OBJ` / `GLOBAL` / `PERSID`。
- **`.rpyc` 反编译器**（`lib/rpyc.js`）：封装社区 `unrpyc` 工具；
  `decompileRpyc` 用于单个数据块，`decompileRpycMany` 用于批量运行，二者都
  降级为 `null` / 空映射而不是抛出异常。
- **`layeredimage` 支持**：分层角色变成一个立绘，
  带一个 `layers` 映射和一个 `base` 变换；客户端堆叠所选的那些图层。
- **对话框 / 选项皮肤**（`lib/client.js`）：CSS 自定义属性
  覆盖，把游戏的 say 框映射到用户消息气泡 / 输入框 / 问题
  卡片，并把选项悬停映射到游戏强调色。
- **基于 DSH 原语的设置 GUI + 国际化**（`lib/client.js`）：设置页面
  现在通过 `@deepseek-ai/dsh-client-ui-primitives`
  （`Switch`、`Input`、`Button`）渲染开关和按钮，并且每个标签都经由手工编写的
  `zh` / `en` 词典翻译。当宿主 `locale` 服务存在时，插件
  注册一个 `renpySkin` 命名空间并跟随当前语言；否则
  回退到 `navigator.language`，默认英语。
- **舞台解析器与状态机**（`lib/stage.js`）：`show` / `hide` / `scene` /
  `with` 解析，支持 `at`、`as`、`behind`、`zorder` 和 `if` 子句；内置
  与游戏自定义的变换；按会话的 `StageStore`；安全区碰撞
  警告与可选的自动避让；能自我纠正的 `StageError`。
- **`renpy_configure` 工具**（`lib/index.js`）：按绝对路径加载或切换当前 VN，
  持久化它，清除缓存的清单/舞台，并返回
  游戏名称和角色阵容统计。这是皮肤导演预设中“加载一个 VN”的那一半
  （另一半 `renpy_stage` 已经存在）。
- **导入 / 导出**（`lib/index.js` + `lib/client.js`）：`GET /renpy-skin/export`
  返回 `{exportedAt, plugin, version:1, settings}`；`POST /renpy-skin/import`
  接受 `{config}` 或一个裸设置对象，持久化它，并在 `gameDir` 变化时
  清除缓存的清单/舞台。设置页面上的一张卡片导出到
  剪贴板，并导入粘贴的 JSON。
- **“Ren'Py 皮肤导演”智能体预设**（`cordis.patch.yml`）：第二个 bundle
  补丁行 `preset-renpy-skin`（`@deepseek-ai/dsh-agent-preset`，order 50），其
  唯一插件是一个 `@deepseek-ai/dsh-persona`，指示智能体确定
  VN（文件夹 / 名称 / 自动发现），用 `renpy_configure` 加载它，并
  用 `renpy_stage` + 设置页面进行定制。
- **皮肤语言切换**（`lib/index.js` + `lib/client.js`）：一个 `lang` 设置
  （`auto` / `zh` / `en`），在设置页面上有一行 `SegmentedControl`，这样
  皮肤自身的标签就可以被强制为中文或英文，而不受
  宿主区域设置影响。`auto` 仍然跟随宿主 `locale` 服务 /
  `navigator.language`。还修复了 locale 命名空间的注册，使其使用随包发布的 2 参数
  `register(ns, { zh, en })` 形式。
- **无头测试套件**：`test/skin.test.mjs`、
  `test/rpa.test.mjs` 和 `test/rpyc.test.mjs` 中基于 `node:test` 的 58 个测试，无依赖、无 DSH 宿主。
  构造一个真实的一次性 Ren'Py 游戏，并反编译真实的 `.rpyc` 测试夹具，而不是
  打桩。在 Node 22.15.0 和 24.21.0 上通过。
- **探针脚本**（`test/manifest-probe.mjs`）：对一个
  真实游戏运行完整管线，并演练九条舞台语句。
- 文档：`AGENTS.md`、`README.md`、`docs/STATUS.md`、
  `docs/CONTRACTS.md`、`docs/ARCHITECTURE.md`、`TODO.md`、`Makefile`。

### 修复

在编写测试套件时发现——每一个都是静默的错误解析，而不是崩溃：

- **`==`、`!=`、`>=`、`<=` 被词法分析为两个独立的运算符**，
  这使得*每一个* `if` 条件都无法解析。比较运算符现在成为单个词法单元。
- **`behind <tag>` 吞掉了后续子句。** `show eileen behind bob
  zorder 5` 把 `zorder` 读作第二个 behind 标签，随后又消费了 `5`。词语串
  现在会在子句关键字处停止。
- **`zorder` 之后的那个整数可能被读作一个属性**，当 `zorder`
  跟在一条已经关闭了图像串的子句之后时。
- **`evalValue` 把拼接接受为字符串字面量**，返回被篡改的
  内部文本（`"a" + "b"` → `a" + "b`）而不是 `undefined`。带引号的值
  现在被锚定到整个输入。
- **前导逗号没有被剥离**，当一个值作为未解析的
  参数列表传入时，因此这类值无法求值。

### 验证

针对一个 1920×1080 的松散资源游戏（4932 条图像语句）和一个仅有归档的游戏
（26 个 `layeredimage` 角色）：

- 对话框 `h=360 yalign=1 fill=#000000 text=#ffffff`（Arches）
- 选项 `w=1860 idle=#cccccc hover=#ffffff`（Arches）
- 8 个立绘标签，属性集如 `angry l / annoyed l / confused l /
  excited l / glance l / glare l …`（Arches）；30 个标签，含分层角色
  `enid` / `catherine` / `nox`（GoToSnowTown）
- 69 个游戏自定义变换（Arches）；102 个（GoToSnowTown）
- `decompileRpycMany` 在约 3.1 s 内反编译 56 个归档 `.rpyc` 文件
- 五条舞台语句被应用，四条畸形语句被拒绝并给出替代方案

### 已知限制

参见 [docs/STATUS.md](docs/STATUS.md) 和 [TODO.md](TODO.md)。

> **注意（2026-10-13）：** 发布年龄阻断问题已通过把
> `dsh-renpy-skin@0.1.0` 加入 `minimumReleaseAgeExclude` 而得到解决，
> 并且该插件现已在实时配置档中列出/启用/处于活动状态——在
> 浏览器半边渲染之前，剩下的步骤是重启 DSH 宿主（参见 `docs/STATUS.md`）。
