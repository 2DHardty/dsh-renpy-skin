# VN 读取流程审计与加固（任务书）

本文是给执行者（低成本模型）的任务书。目标：让「读取 Ren'Py 游戏」这一流程尽可能支持大多数 VN，并较为准确地读出各模块真正需要的值。

先读 [AGENTS.md](../AGENTS.md)，它的硬性约束全部适用（零运行时依赖、`.rpyc` 反编译必须可选且失败不抛错、不 mock 文件系统、文档只用中文、代码注释用英文且只写原因）。

## 总体规则

- 被读取的游戏在本机，**只读它们，不要修改游戏目录**。可用的游戏由你自行收集，
  下面这些名字是作者测试时用过的样本，路径随机器而异：
  - 纯松散资源的样本：SharedHouse、Arches、Adastra、英王的宝冠、HAS Demo。
  - 归档型（只有 `.rpa`）：GoToSnowTown、Tavern_of_Spear。
  - 立绘复杂（`layeredimage`、大量属性）：Castle&Myosotis、RemembertheFlowers、DXB。
  - 非英文路径 / 路径较深：KnightsCollege、TSR、A.W.A.R.E、与那家伙合租房。
  - 只有新版 `.rpyc`：CSE（见子任务 B）。
  - 目录里可能还有嵌套的游戏目录，用 `resolveGameDir` 的行为为准，缺失的游戏直接跳过。
- 探测命令：`node test/manifest-probe.mjs "<游戏目录>"`（打印清单摘要）。完整测试：`node --test "test/*.test.mjs"`（不要传目录）。
- 每发现一个解析缺陷，必须新增一条回归测试，测试注释里写明「用户可见的症状」。测试用真实的临时游戏（`makeGame()`）或真实归档，不要 mock。
- 只改自己负责的文件/函数，改前重新读取文件（别的执行者可能在同时修改同一个文件的其他区域）。**不要改 `lib/client.js`**（界面部分由主会话负责）。**不要改任何 `.md` 文档，不要提交 git**；把需要写进文档的结论放在最终报告里，由主会话统一同步。
- 每个新增测试放进**各自的新测试文件**（见下），避免互相冲突。
- 完成后自检：`node --check` 改动过的文件，再跑完整测试，全部通过才算完成。
- 不要把大文件写进系统临时目录：临时文件用完即删。
- 最终报告（中文，不超过 300 字）：改了什么、对哪些游戏验证过、读到的值前后对比、没解决的问题。

## 子任务 A：对话框与文本框几何（`lib/renpy.js` + `lib/manifest.js` 的 dialogbox/layout 段）

测试文件：`test/audit-dialogbox.test.mjs`。

当前只从 `gui.rpy` 的 `gui.*` 赋值读取，但不少游戏在 `screen say` 里直接写死位置，或用自己的变量。要核对并补上：

1. 读 `screen say` 及其引用的 `window`/`namebox`/`text` 样式（`style window`、`style say_dialogue`、`style say_label`、`style namebox`），取：文本框 `xpos/ypos/xalign/yalign/xsize/ysize/background`，对话文字 `xpos/ypos/xsize/xalign/size/color/font`，姓名框位置与大小。`gui.*` 里没有的以它们为准，两处都有时以游戏实际使用的为准。
2. 贴图选择：`gui.textbox_background`、`style window` 的 `background`、约定路径 `gui/textbox.png` 之间的优先级要与引擎一致；`Frame(...)` 的边框值要读出来。
3. 文字颜色/字号/字体：`style say_dialogue` 覆盖 `gui.text_*` 的情况；`gui.text_font` 指向 `gui.*` 之外变量的情况。
4. 对 10 个以上不同的游戏跑探测，把每个游戏读到的 `dialogbox` 与 `layout` 做成表，标出「读到默认值」与「读到游戏真实值」的差异，找出读不到的原因。

验收：至少 3 个此前读到默认值的游戏现在读到真实值，并有回归测试。

## 子任务 B：脚本来源与 `.rpyc`（`lib/rpyc.js` + `lib/manifest.js` 的 `readScriptSources` 段）

测试文件：`test/audit-scripts.test.mjs`。

1. CSE 只带新版 `.rpyc`，旧版 unrpyc（2.0.2）对它报 `too many values to unpack (expected 5, got 7)`。调查：是否有更新版 unrpyc 可用（只检查本机是否已有，不要联网下载大文件）、是否可以让 `findUnrpyc` 自动探测多个位置、失败时返回的降级结果是否带有可诊断信息（调试日志，不抛错）。如果没有可用工具，把结论和需要用户做的事写进报告，不要硬凑。
2. 加载顺序要与引擎一致：松散 `.rpy` 优先于归档里的同名文件；`.rpy` 与 `.rpyc` 并存时只用 `.rpy`；`tl/` 翻译目录里的脚本不能覆盖主脚本的 `gui`/`define` 值。
3. 分批反编译的健壮性：一个坏文件不能让整批结果丢失；超时要有上限；大量 `.rpyc`（上千个）时只反编译会被用到的几个（`gui|options|screens|script` 一类），其余按需。
4. 找出至少一个「脚本被读成空」的真实游戏，说明原因。

验收：反编译失败不抛错且不拖垮其他资源；有测试覆盖加载顺序与坏文件。

## 子任务 C：资源索引、归档与性能（`lib/rpa3.js` + `lib/manifest.js` 的 `indexAssets` 段）

测试文件：`test/audit-assets.test.mjs`。

1. SharedHouse 首次构建清单约 26 秒（4089 个条目、1.7 GB 归档）。用 `node --cpu-prof` 剖析（参数里的目录用 `cygpath -m` 转成 `C:/...` 形式），找出前三大耗时，优化到合理水平。已知一个线索：`readAudioAliases`/`resolveMenuMusic` 对每个脚本都跑一个很贵的正则；另外头部读取已经改成只读开头，别回退。
2. 核对 `.rpa` 变体：RPA-2.0、RPA-3.2、带前缀条目、索引非 zlib、`.rpi`、同名多归档的优先级。读不了的归档要「跳过并继续」，不能让整个游戏消失。
3. `listFiles` 的 20000 条上限：对超大游戏要有可见的 `truncated` 标志，不能静默漏资源。
4. 大小写：Windows 磁盘与归档里同一路径大小写不一致时，查找要不区分大小写，但返回规范的原始拼写。
5. 对 5 个以上游戏记录前后耗时与资源计数。

验收：SharedHouse 首次构建明显变快（目标 < 12 秒，给出实测），所有测试通过。

## 子任务 D：音频、开场、背景、立绘（`lib/renpy.js` 的 `resolveMenuMusic`/`readSplashscreen` + `lib/manifest.js` 的背景/立绘/音频段）

测试文件：`test/audit-media.test.mjs`。

1. 主菜单音乐：核对 `config.main_menu_music` 的各种写法（直接字符串、`audio.xxx` 别名、函数调用、`renpy.music.play` 写在 `label main_menu`、`screen main_menu` 里的 `on "show" action Play("music", ...)`）。
2. 开场：`label splashscreen` 的 `show`/`scene`/`with`/`pause`/`renpy.movie_cutscene`、屏幕里的 `add`/`timer`；纯文本开场的处理；时长估算要合理。
3. 背景与 CG 分类：避免把 UI 图标当背景（见 TODO.md P3）、避免把带属性的背景（`images/backgrounds/mine_blur.jpg`）归成立绘；`gallery`/`bg`/`cg`/`images/ui` 的分类对 5 个以上游戏逐个人工抽查。
4. 立绘：`layeredimage`、`image` 语句里的 `Composite`/`LiveComposite`、带 `ATL` 的 `image`、同一标签的多种尺寸；大游戏的 `spriteIndex` 不应混入 UI 图。
5. 对每个游戏输出「背景/CG/立绘/曲目/开场」数量与前 5 项样例，标出明显错误并修复。

验收：至少修复 2 个真实分类/解析错误并有回归测试。

## 汇总（由主会话完成）

四个执行者结束后，主会话负责：合并冲突、跑完整测试、把结论同步进 `docs/STATUS.md`、`CHANGELOG.md`、`TODO.md`、`docs/CONTRACTS.md`，并提交。
