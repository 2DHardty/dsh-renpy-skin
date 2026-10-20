# dsh-renpy-skin

> **WIP** —— 这个插件仍在开发中：设置键、清单结构与界面行为都可能变化，尚不适合直接用于日常使用。

一个 DSH 插件（plugin）包（bundle），用 Ren'Py 游戏自带的资源为 DSH Web GUI 换肤，
并让模型拥有一个可用原生 Ren'Py 语法调度的**立绘（sprite）舞台（stage）**。

两个相互独立的部分，各自单独使用都有价值：

| 半边 | 作用 |
| --- | --- |
| **换肤** | 读取你的游戏目录，并根据其中的 `gui.rpy` 值、背景图、对话框（dialogue box）与选项菜单（choice menu）样式重新装扮界面。底板不止一张的游戏可以在设置页的「Dialogue box art」里挑一张（只列这台游戏真正带的候选），选择按游戏保存在档案里，Agent 也能用 `renpy_save_vn` 换。`say` 屏自己的零件（名字框、白名单里的快捷菜单按钮）由模块层画在输入区上，可以用「Say-screen extras」关掉。 |
| **色板** | 从游戏读到的八个颜色（强调色、悬停色、空闲色、对话文字色、界面文字色、名字色、选项文字色、选项悬停色）在设置页的色板卡片里逐项带来源列出，每项都能改，改过的行可以一键恢复；**文本框（对话）文字与 DSH 界面文字是两个独立槽位**，改一个不会连带改掉另一个。保存后清单与主题 token 立即重算。游戏从不写 `gui.accent_color` 时，插件会从对话框底板图片里采样主色兜底（清单里记 `image-sample`）。 |
| **舞台导演** | 添加一段系统提示词小节和一个 `renpy_stage` 工具（Tool），让模型用 `show` / `hide` / `scene` / `with` 与 ATL 变换驱动一个绝对定位的立绘舞台。立绘画在会话主体内部：消息、输入框与会话列表都盖在它上面，立绘也不会越过左侧会话列。设置 →「界面」里可以隐藏会话列表或底部对话框，把窗口整个让给舞台。 |
| **VN 加载器** | `renpy_configure` 工具按路径加载/切换当前 VN，`renpy_read_manifest` 只读交回本次扫描真正读到的值，`renpy_save_vn` 只写需要修正的部分；写完后由完成弹窗询问「立即更换 / 先保存」。点「用 Agent 加载」时，宿主先把这个游戏扫成两份目录树（紧凑地图 + 完整清单）放进配置目录，再把带着真实路径的提示词投进一个新会话——顺序不能反，Agent 拿到的路径必须已经存在。整个换肤可按 JSON 导入/导出。 |
| **角色扮演预置** | 随包两个智能体预置：`Ren'Py skin director` 负责加载并定制皮肤；「在场」负责演进剧情——角色按真实时间生活，每轮回复都以 `renpy_stage` 演出，剧情涉及其他角色时把他一并带上台。它还有三样只属于它的东西：你在戏里的**名字**（可全局、可按会话覆盖）、追加给它的一段**额外要求**，以及按角色分开、跨会话保存的**记忆**——模型用 `renpy_memory` 追加，你在设置页或顶栏的记忆面板里直接编辑。`renpy_*` 工具是全局注册的，与选哪个预置无关。 |
| **开场与音乐** | 在 DSH 启动时重放游戏的 `label splashscreen:`，同步 `config.main_menu_music`，并把游戏的配乐——`game/audio/music/` 下每一首超过 10 s 的曲目——放到顶栏的一个播放列表按钮后面。播放器面板上**一个按钮**按「顺序播放 → 列表循环 → 单曲循环 → 随机播放」循环切换（状态存在 `playlistRepeat` 与 `playlistShuffle` 里，按钮上直接写着当前模式的名称）。这三项在你主动要求之前都处于关闭或静音状态。 |
| **可解释性** | 清单里的每个值都带来源（`sources`：屏幕体 / `style` 块 / `gui.*` 变量 / 约定路径 / 角色声明 / 覆盖层 / **默认值**），脚本发现与反编译的结果单独成段（`scripts`：找到了多少、反编译了多少、为什么没做到、Python 与 `unrpyc` 在哪）。读不到与真的等于默认值，从此在清单上是两件不同的事。 |

> **状态：已在配置档中安装并启用；Agent 加载链路已实机验收通过。**
> 269 项无头测试全绿（262 通过 / 7 条需要真实 `unrpyc` 的用例在无工具的机器上跳过）；
> Agent 加载链路（`ctx.inject` 等待服务、`POST /agent/prepare`、
> 两层目录树、失败即 abort）已在 2026-10-19 用一次性 `verify` 配置档（端口 19487）
> 实机跑通：点「用 Agent 加载」后新会话的请求里有 4 个 `renpy_*` 工具、系统提示词带
> `## Ren'Py stage director` 区段、`cwd` 正是配置目录，模型依次调用了
> `renpy_read_manifest` 与 `renpy_save_vn`。
> **桌面宿主（27194）已经在跑新构建**（`/manifest` 带 `scripts` / `sources` /
> `stats.unread`，`/agent/prepare` 不再回 405）。实机复查又抓到一个只影响「脚本全在
> 归档里」的游戏的 bug：`/agent/prepare` 回 400，根因是 `lib/scantree.js` 多套了一层
> 数组，已修并补了回归用例；**这条修复还需要再重启一次宿主才能实机复验**
> （`tools/launch-dsh-debug.cmd` 会 `taskkill /T /F` 整棵进程树，只能由人运行），
> 重启后先跑 `node tools/verify-agent-load.mjs --port <端口>` 与
> `node tools/check-doctor.mjs`。
> 见 [docs/STATUS.md](docs/STATUS.md)。

## 环境要求

- DSH `>= 0.2.0-rc.2`
- Node `>= 22`（DSH 自带的运行时为 v24.21.0）
- 可选：Python ≥3.9 与 `unrpyc`——只有游戏只带编译脚本（`.rpyc`）时才需要，
  设置页的「环境配置」会显示当前状态并允许直接指定位置
- 一个 Ren'Py 游戏目录——可以是 Ren'Py 根目录（含 `game/`），也可以就是
  `game/` 目录本身

**没有运行时 npm 依赖**，也**没有构建步骤**。

## 安装

```sh
# 在配置档目录下执行，前提是 release-age 策略已经允许
pnpm add /path/to/dsh-renpy-skin
```

然后把插件指向一个游戏。可以使用 **设置 → Ren'Py skin**，也可以直接写配置文件：

```jsonc
// ~/.dsh/renpy-skin/config.json   (DSH_RENPY_SKIN_HOME overrides the folder)
{
  "gameDir": "D:\\Games\\MyNovel",
  "enabled": true
}
```

存储根按 `DSH_RENPY_SKIN_HOME` > `$DSH_HOME/renpy-skin` > `~/.dsh-renpy-skin`
的顺序解析（空白视为未设置）。旧位置会**逐项合并**进新位置
（`config.json`、`library.json`、`game/` 里缺哪项补哪项，已存在的条目不覆盖，
只复制不删），由 `lib/home.js` 完成；`GET /renpy-skin/settings` 的 `dataHome`
字段会告诉你实际读的是哪一份。

只有 `.rpa` 的游戏也能用：归档通过内置的 RPA-3.0 读取器读取，
所以把脚本打包并不会成为障碍。**只有字节码**的游戏（有 `.rpyc` 而
没有 `.rpy`）同样能处理——当 Python（≥3.9）与 `unrpyc` 可用时，
`lib/rpyc.js` 会通过社区工具 `unrpyc` 反编译它。

`unrpyc` **不在 PyPI**（`pip install unrpyc` 会失败），它只有一个 GitHub
源码包（[项目主页](https://github.com/CensoredUsername/unrpyc)）：

```powershell
# 解压到 %USERPROFILE%\Tools\unrpyc-2.0.4\，插件会自动找到它
curl.exe -L -o "$env:TEMP\unrpyc.zip" https://codeload.github.com/CensoredUsername/unrpyc/zip/refs/tags/v2.0.4
Expand-Archive "$env:TEMP\unrpyc.zip" "$env:USERPROFILE\Tools" -Force
```

**这两个工具都可以在设置里直接指定位置，不必设环境变量。** 设置 →
Ren'Py skin →「环境配置」逐项列出 Node、Python、`unrpyc` 与数据目录的当前
状态，给出下载地址，并接受 `python.exe` 与 `unrpyc.py` 的完整路径；`unrpyc`
那一栏也可以直接填解压出来的 `unrpyc-2.0.4` 目录（会在其中查找 `unrpyc.py`）。
填完点「重新检测」即可。同样的信息来自 `GET /renpy-skin/doctor`。

也可以把 `unrpyc.py` 放进插件自带的 `vendor/unrpyc/`，或在设置里把「工具目录」
指向检出目录。环境变量 `DSH_RENPY_UNRPYC`（具体文件）与 `DSH_RENPY_TOOLS`
（搜索目录）仍然可用，但设置页里的值优先于它们。Python 不必自己装：插件会
一并尝试 DSH 自带的运行时（`$DSH_HOME/dsh-runtimes/*/dependencies/python/`）。
没有 `unrpyc` 时不会报错，只是**读不到编译脚本里的值**——这件事现在在清单的
`scripts.reason` 与 `sources` 里是看得见的，`renpy_read_manifest` 也会给出
可复制的安装指令。详见 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

## 命令

```sh
node --test "test/*.test.mjs"      # 完整测试套件，无需 DSH 宿主
make test                          # 同上（本机尚未安装 GNU Make）
make check                         # 语法检查 + 测试
make probe GAME="D:\Games\MyNovel"  # 针对真实游戏运行
make doctor GAME="D:\Games\MyNovel" # 体检：Python / unrpyc / 归档 / 数据目录
node tools/verify-agent-load.mjs    # 实机验收：确认运行中的宿主已服务新链路
```

`tools/check-doctor.mjs`（`make doctor`）回答一个测试回答不了的问题：**这台机器上的
清单可不可信**。它打印 Python 与 `unrpyc` 的实际位置和放弃原因、逐个打开 `.rpa` 归档
（连同里面的脚本数）、指出两份数据目录并存的情况，并在「游戏只有编译脚本、`unrpyc`
又不可用」时以退出码 1 结束——那种情况下清单照样生成得很正常，但值全是默认值，
审计结论不成立。`--json` 输出机读报告。

`tools/verify-agent-load.mjs` 打的是插件自己不鉴权的 HTTP 路由，所以不需要 CDP 或登录
token：它会在重启 DSH 之后确认 `/renpy-skin/agent/prepare` 真的被服务、两棵目录树真的
写出来、预算与 Ren'Py 判定都成立，任一项失败就非零退出并写出 JSON 报告。
用 `--port` 指向别的宿主（例如一次性配置档起的临时实例）即可，不必动桌面应用。

`tools/launch-dsh-debug.cmd` 用来带 `--remote-debugging-port=9222` 重启桌面应用做 CDP
验证，但它开头的 `taskkill /IM "DeepSeek Harness.exe" /T /F` 会连同发起它的进程树一起
杀掉——**只能由人在终端里双击/运行**，不能让 DSH 自己的会话去调用。

**不需要重启桌面应用也能验收**：另起一个一次性配置档（`dsh --from-default-profile web
--profile verify`、`dsh plugin --profile verify add link:<本仓库>`，然后
`dsh --profile verify --port 19487 --no-open`）跑的是同一份 `lib/`。`dsh web` 会把
`http://127.0.0.1:19487/?token=…` 打印到 **stdout**，用
`Start-Process -RedirectStandardOutput` 起就能读到这个 token 并打开 SPA。

桌面应用自己也会在一个随机端口上提供网页 UI（本机这次是 38342），但裸地址返回
401：入口必须是启动时生成的 `?token=…`，而登录 cookie 绑定 host:port，重启后端口
一变旧书签就失效。桌面应用不打印这个地址，所以要从浏览器进入网页版，请用安装目录
下的 `resources/runtime/cli/bin/dsh.cmd web`（它会打印完整 URL）。另外，`dsh web`
读取你指定的配置档；`web` 配置档默认只含 `@deepseek-ai/dsh-base` 与
`@deepseek-ai/dsh-web-app`，**不含本插件**——想在网页版里用皮肤与 `renpy_*` 工具，
先把本仓库加进那个配置档：`dsh plugin --profile web add link:E:/ProjectFiles/dsh-renpy-skin`。

> 当前开发机上**没有安装** `make`。
> [Makefile](Makefile) 是权威的任务清单，但每个目标都只是一条
> `node` 命令——在 Make 可用之前直接运行即可。

请传入**带引号的 glob**，而不是 `test/`——目录参数在 Node
22 和 Node 24 上都会失败。

## 模型能做什么

`renpy_configure` 工具（Tool）按绝对路径加载或切换当前 VN。
`renpy_read_manifest` 工具（Tool）只读，把本次扫描*真正读到的值*——画布、对话框与
几何、选项按钮、颜色、字体、角色、变换、背景——以 JSON 代码块交回，形状与
`renpy_save_vn` 的 `config` 一致，因此 Agent 可以先读、再改。
`renpy_save_vn` 工具（Tool）把 Agent 对这个游戏读出来的结论——目录树、修正过的值、
会话摘要——写进插件自己的 VN 配置文件（数据目录下的 `game/<VN 名>/`），插件下次
自己加载它，不必再从编译过的脚本里猜；写完界面上会弹出「立即更换 / 先保存」。
`renpy_stage` 工具（Tool）接收一段 Ren'Py 脚本字符串：

```
scene bg classroom with fade
show eileen happy at center
show lucy sad at left zorder 2
hide eileen
```

接受的子集：

| 语句 | 语法 |
| --- | --- |
| 场景 | `scene <bg> [with <transition>]` |
| 显示 | `show <tag> <attributes...> [at <transform>] [as <tag>] [behind <tag>] [zorder <int>]` |
| 隐藏 | `hide <tag>` |
| 转场 | `with <transition>` |
| 守卫 | `... if <variable> <op> <value>` |

转场仅限于 `dissolve`、`fade` 和 `none`。`at` 可以接受
内置变换（`left`、`center`、`right`、`truecenter`，以及各个角与边）、
游戏自身定义的 `transform` 块，或内联的
`Transform(xpos=0.5, zoom=0.9, ...)`。

拒绝是能自我纠正的：未知的图像、属性或变换会抛出
一个 `StageError`，其中携带**确实**存在的名称列表；该列表
以结构化数据的形式返回给模型，让它无需猜测即可重试。

## 文档

| 文件 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 工作约定、约束与易踩的坑。请先读。 |
| [docs/STATUS.md](docs/STATUS.md) | 当前实际可用的功能，以及尚不可用的部分。 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块地图与数据流。 |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | 平台 API、HTTP 路由、设置项 schema、清单结构。 |
| [TODO.md](TODO.md) | 已知缺口，按优先级排列。 |
| [CHANGELOG.md](CHANGELOG.md) | 发布说明。 |

## 许可证

MIT。
