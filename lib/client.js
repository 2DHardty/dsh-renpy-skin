/**
 * dsh-renpy-skin — client (browser) half.
 *
 * Hand-written in the DSH client-module "lazy CJS factory" envelope
 * (`window.__ModuleLoader__.load({ id, factory })`). The host serves this file
 * verbatim from `/plugins/<id>/client.js`; the module system memoizes the
 * factory's exports and resolves `require('react')` from the frozen platform
 * seed table (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
 * `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
 * `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
 * `@deepseek-ai/dsh-client-ui-dockkit`). Nothing else is required, so the
 * bundle is self-contained and needs no build step.
 *
 * What it contributes:
 *   - CSS on `[data-conversation-content]`: the game background, painted
 *     behind the messages only, so the sidebar and the text stay untouched.
 *   - `shell.overlay`: the absolute-positioned sprite stage above the
 *     conversation.
 *   - `theme.overrideTokens`: the game's accent-derived alias tokens, always
 *     as light + dark pairs.
 *   - `settings.section`: the "Ren'Py skin" page — every switch, the slider,
 *     the game directory, and the layout editor.
 *
 * Every layer is driven from one polling subscription to the host half's
 * `/renpy-skin/stage` route, so the settings page and the conversation always
 * read the same state.
 */
window.__ModuleLoader__.load({
  id: "dsh-renpy-skin",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useEffect, useRef, useState } = React;
    // DSH's own UI primitives (Button / Switch / Input / SegmentedControl / Tag
    // / Pill / ...). This seed word is in the frozen platform module table, so
    // the hand-written bundle needs no bundler to reach it.
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    const ROUTE = "/renpy-skin";
    const POLL_MS = 900;

    /**
     * The text 「用 Agent 加载」 sends into the new Session.
     *
     * Written around one fact: the host has ALREADY loaded the game by the time
     * this is sent — `/agent/prepare` resolved the directory, scanned it, wrote
     * the two listings and pinned the session. An earlier wording told the agent
     * to ask for the folder and scan the disk, which cannot work: the agent runs
     * in the session's workspace, and a question costs a whole round trip before
     * it discovers it has no way to look. So the first sentence states what is
     * already true and the next one names the tool call that reads it back.
     *
     * The steps are shared with the unprepared wording below, because a game
     * that IS loaded needs exactly the same work done to it.
     *
     * Kept short on purpose. It is prepended to a fresh conversation, and every
     * extra sentence competes with the user's own first message.
     */
    const AGENT_LOAD_STEPS = [
      "Start by calling renpy_read_manifest: it returns what the scanner read (canvas size, dialogue box and its geometry, colours, font, characters, backgrounds).",
      "Then read the two listings in the workspace: scan-tree.md is the compact map of the game; scan-tree.full.txt lists every file when you need an exact path.",
      "Then write the profile with renpy_save_vn: pass the directory tree as tree, and as config only the values the scan got wrong or could not read — compare against the manifest rather than guessing from the compiled scripts. Pass a compressed summary of what you found as summary.",
      "Then tell me the game name, how many backgrounds and characters were read, and which modules could not be read.",
    ];

    /**
     * The opening sentence for a game the host has already prepared.
     *
     * The `renpy_configure` note belongs here and not in the shared steps: it
     * exists to stop the agent from re-loading a game that is already loaded,
     * which is meaningless advice when nothing is.
     */
    const AGENT_LOAD_PREPARED = [
      "The Ren'Py skin has already loaded this game for me — there is nothing to look up and no path to ask me for.",
      ...AGENT_LOAD_STEPS,
      "renpy_configure is only for switching to a different game later; do not call it for this one.",
    ].join(" ");

    /**
     * The opening sentence when nothing was prepared.
     *
     * The button prepares the game before it opens the session, so this is the
     * wording for a prompt sent by other means — a hand-copied one, or a caller
     * of `agentLoadPrompt()` with no facts. It must not claim a game is loaded:
     * that would send the agent to `renpy_read_manifest` for a game the host was
     * never told about.
     */
    const AGENT_LOAD_UNPREPARED = [
      "Please point the Ren'Py skin at a game.",
      "Ask me for its folder first; do not scan the disk for it.",
      "Then load it with renpy_configure.",
      ...AGENT_LOAD_STEPS,
    ].join(" ");

    const SYSTEM_FONT_OPTIONS = [
      "Segoe UI",
      "Microsoft YaHei",
      "SimSun",
      "SimHei",
      "KaiTi",
      "Arial",
      "Times New Roman",
      "Consolas",
    ];

    // ── session identity ───────────────────────────────────────────────────

    /**
     * The current session id.
     *
     * The web shell addresses a conversation with `?session=<id>` (or
     * `#/session/<id>`). The desktop shell has neither: it runs at
     * `dsh-app://app/` and keeps the current conversation on
     * `[data-conversation-session]` (body, while a conversation is active) and
     * in `localStorage["dsh.sessions.current"]`, a JSON envelope.
     *
     * Missing both used to fall back to `"global"`. `renpy_stage` keys its
     * stage by `exec.agent.id`, so the tool wrote one bucket and the browser
     * polled another: every command reported success and nothing appeared.
     */
    function currentSessionId() {
      try {
        const url = new URL(window.location.href);
        const fromQuery = url.searchParams.get("session") ?? url.searchParams.get("sessionId");
        if (fromQuery !== null && fromQuery.length > 0) return fromQuery;
        const hash = url.hash.replace(/^#\/?/, "");
        const parts = hash.split("/").filter((part) => part.length > 0);
        const index = parts.findIndex((part) => part === "session" || part === "sessions");
        if (index >= 0 && parts[index + 1] !== undefined) return parts[index + 1];
        // The rendered conversation is the one the user is looking at. Prefer
        // the active one when a background view is still mounted.
        const rendered = document.querySelector(
          '[data-content-phase="active"][data-conversation-session], [data-conversation-session]',
        );
        const fromDom = rendered?.getAttribute("data-conversation-session") ?? "";
        if (fromDom.length > 0) return fromDom;
        const stored = window.localStorage?.getItem("dsh.sessions.current");
        if (typeof stored === "string" && stored.length > 0) {
          try {
            const parsed = JSON.parse(stored);
            const fromStore = parsed?.sessionId ?? parsed?.id;
            if (typeof fromStore === "string" && fromStore.length > 0) return fromStore;
          } catch {
            // A malformed envelope is not a session id; try the older key.
          }
        }
        const local = window.localStorage?.getItem("dsh.session");
        if (typeof local === "string" && local.length > 0) return local;
      } catch {
        // A restricted context cannot read the URL or the DOM; fall through.
      }
      return "global";
    }

    // ── tiny external store ────────────────────────────────────────────────

    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        set(patch) {
          const next = typeof patch === "function" ? patch(state) : { ...state, ...patch };
          if (next === state) return;
          state = next;
          for (const listener of [...listeners]) {
            try {
              listener(state);
            } catch {
              // One broken subscriber must not stop the others.
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    /** React binding for the store. */
    function useStore(store) {
      const [value, setValue] = useState(store.get());
      useEffect(() => store.subscribe(setValue), [store]);
      return value;
    }

    const store = createStore({
      status: "idle",
      error: undefined,
      manifest: undefined,
      settings: undefined,
      /** The VN profile the agent wrote for this game, as `GET /vn` reports it. */
      vn: undefined,
      stage: { scene: undefined, sprites: [], transition: "none" },
      revision: 0,
      lang: "en",
      /** Every game that has ever been analysed, newest first. */
      library: [],
    });

    // ── live settings preview ──────────────────────────────────────────────

    /**
     * Settings a slider is previewing right now, if any.
     *
     * They are written into the store so every effect reacts DURING the drag —
     * the background repaints, the volume changes, the stage drops a sprite —
     * with no round-trip. `pollStage` reads this: the host's copy is
     * still the old one mid-gesture, and letting the 900 ms echo land would
     * yank the control back to it.
     */
    let previewPatch = undefined;

    /**
     * Apply a setting to the UI NOW without saving it.
     *
     * The POST happens once, when the gesture ends (`SliderRow` commits there),
     * because an `input`-per-step `saveSettings` fired dozens of round-trips per
     * drag and visibly stuttered.
     */
    function previewSettings(patch) {
      previewPatch = { ...(previewPatch ?? {}), ...patch };
      store.set({ settings: { ...(store.get().settings ?? {}), ...patch } });
    }

    /**
     * Drop the preview without saving anything — for a gesture that ends with
     * no change to persist, so no POST will come along to clear the marker.
     * Leaving it set would freeze `pollStage`'s settings echo for good.
     */
    function endPreview() {
      previewPatch = undefined;
    }

    /**
     * Push a 0-1 volume at the player store and the one `<audio>` element that
     * carries it. Shared by the drag preview and the release commit so the two
     * cannot drift apart.
     */
    function applyVolume(next) {
      playerStore.set({ volume: next });
      const element = audio();
      if (element !== undefined) element.volume = next;
    }

    // ── i18n ───────────────────────────────────────────────────────────────
    //
    // Translations live in two hand-authored dictionaries (zh / en). English is
    // the fallback, so an untranslated key simply shows its own English text.
    // When the host's `locale` service is present we register both namespaces
    // and follow its active language; otherwise we read `navigator.language`.
    // `t(key, params)` also resolves `{name}` placeholders.

    const LOCALE_NS = "renpySkin";
    const zh = {
      "Ren'Py skin": "Ren'Py 皮肤",
      "Point this at a Ren'Py game's folder (the one containing game/) or directly at its game/ directory. Loose files and .rpa archives are both read.":
        "指向一个 Ren'Py 游戏的文件夹（包含 game/ 的那个），或直接指向它的 game/ 目录。散落文件和 .rpa 归档都会被读取。",
      Load: "加载",
      "Loading…": "加载中…",
      "Could not read the game directory.": "无法读取该游戏目录。",
      Switches: "开关",
      "Ren'Py skin enabled": "启用 Ren'Py 皮肤",
      "Master switch for every layer below.": "下面所有图层的总开关。",
      Background: "背景",
      "Background brightness": "背景亮度",
      "Theme tokens": "主题色板",
      "Override the DSH alias tokens with the game's accent palette.": "用游戏的强调色覆盖 DSH 的 --dsw-alias-* 色变量。",
      "Interface font": "界面字体",
      "Applies to the whole interface at once. VN fonts first, then default and system fonts.": "立即作用于整个界面（字号不变）。优先列出 VN 字体，然后是默认字体和系统字体。",
      "VN fonts": "VN 字体",
      "Default and system fonts": "默认与系统字体",
      "Default (skin font)": "默认（皮肤字体）",
      "Custom font location": "自定义字体位置",
      "Skin the composer and the user's own messages as the game's say box.": "把输入框和用户自己的消息换成游戏对话框样式。",
      "Question cards": "选项卡片",
      "Render ask_user_question options as the game's choice menu.": "把 ask_user_question 选项渲染成游戏的选择菜单。",
      "Say-screen extras": "对话框附加组件",
      "Draw the name plate and quick-menu buttons the game's own say screen defines.": "把游戏 say 屏里的名字框与快捷菜单按钮画到输入框上。",
      "Sprite stage": "立绘舞台",
      "Max sprites on stage": "舞台最多显示立绘数",
      "Auto-avoid the reserved area": "自动避开保留区域",
      "Shift sprites out of the name box / side image instead of only warning.": "把立绘移出姓名框 / 侧立绘区域，而不是只发出警告。",
      Interface: "界面",
      "Hide the session list": "隐藏会话列表",
      "Give the stage the full width. Turn it back on here when you need the list.": "把宽度让给舞台。需要会话列表时在这里重新打开。",
      "Hide the dialogue box": "隐藏对话框",
      "Hide the composer so the transcript and the stage have the window to themselves. Turn it back on here.":
        "隐藏输入框，让对话记录和舞台独占窗口。需要时在这里重新打开。",
      "Prompt injection": "提示词注入",
      "Inject the stage-director brief into the system prompt.": "把舞台导演简报注入系统提示词。",
      "Text animation": "文字动画",
      "Typewriter animation for the model's own dialogue.": "为模型自己的台词启用打字机动画。",
      "Text speed (chars/sec, 0 = instant)": "文字速度（字符/秒，0 = 立即全部显示）",
      "Palette read from the game": "从游戏读取的色板",
      "Left swatch = dark theme, right swatch = light theme.": "左侧色块 = 深色主题，右侧色块 = 浅色主题。",
      accent: "强调色",
      text: "文字",
      base: "底色",
      Characters: "角色",
      "Tick the characters this conversation may show. Leave every box unticked to allow the whole cast.":
        "勾选这段会话里可以出场的角色。全部不勾选 = 允许全部角色。",
      "All characters are enabled.": "已启用全部角色。",
      "{count} of {total} characters enabled.": "已启用 {count}/{total} 个角色。",
      "Enable all": "全部启用",
      "This game declares no character sprites.": "这个游戏没有声明任何角色立绘。",
      "{backgrounds} backgrounds · {tags} characters · {expressions} expressions · {transforms} transforms · {displayables} displayables":
        "{backgrounds} 个背景 · {tags} 个角色 · {expressions} 个表情 · {transforms} 个变换 · {displayables} 个可显示对象",
      "Layout editor": "布局编辑器",
      "Drag a component to move it, or edit the numbers. Values are fractions of the {wh} design canvas, so they survive a window resize. Negative values are allowed (Ren'Py itself places the name box above the text box).":
        "拖动组件移动它，或直接编辑数值。数值是 {wh} 设计画布的分数，因此窗口缩放时不会漂移。允许负值（Ren'Py 本身就把姓名框放在文本框上方）。",
      Width: "宽度",
      Height: "高度",
      Visible: "可见",
      "Save layout": "保存布局",
      "Reset to this game's original layout": "重置为这个游戏的原始布局",
      "Copy JSON": "复制 JSON",
      "Import / export": "导入 / 导出",
      "Export the current skin as JSON so you can reload it later or move it to another machine.":
        "把当前皮肤导出为 JSON，方便之后重新加载或迁移到另一台机器。",
      Export: "导出",
      "Import a previously exported config (paste the JSON). A gameDir inside it is applied immediately.":
        "导入之前导出的配置（粘贴 JSON）。其中包含的 gameDir 会立即生效。",
      Import: "导入",
      Copied: "已复制",
      "Export failed": "导出失败",
      "Import failed": "导入失败",
      "Done": "完成",
      Language: "语言",
      Auto: "自动",
      "Force the skin's own labels to Chinese or English, or follow the host locale.":
        "把皮肤自身的文案强制为中文或英文，或跟随宿主（DSH）的语言设置。",
      Appearance: "外观",
      Stage: "舞台",
      Text: "文字",
      "Quick settings": "快捷设置",
      "Ren'Py settings": "Ren'Py 设置",
      "Music playlist": "音乐播放列表",
      "Opening": "开场动画",
      "Play the game's opening on DSH startup": "DSH 启动时播放游戏开场动画",
      "Extracted from label splashscreen:. Off by default.": "从 label splashscreen: 提取。默认关闭。",
      "Click anywhere to skip": "点击任意处跳过",
      "Skip on click": "点击跳过",
      "Follow the game's main menu music": "跟随游戏主菜单音乐",
      "Play config.main_menu_music when DSH starts, and when the page is first clicked.": "DSH 启动时（以及页面首次点击时）播放 config.main_menu_music。",
      "Main menu track": "主菜单曲目",
      "This game declares no main menu music.": "这个游戏没有声明主菜单音乐。",
      "The game's menu-music expression has more than one branch; this picks which one plays.": "游戏的菜单音乐表达式有多个分支，这里选择播放哪一个。",
      "Filter tracks": "筛选曲目",
      "Splash media": "开场媒体",
      "No playable tracks": "没有可播放的曲目",
      "Nothing playing": "未在播放",
      "Go to settings": "去设置",
      "No splash screen was found in this game.": "这个游戏里没有找到开场动画。",
      "Play": "播放",
      "Pause": "暂停",
      "Previous": "上一首",
      "Next": "下一首",
      "Autoplay the playlist on load": "加载后自动播放播放列表",
      "Browsers block audio until the page is clicked, so this waits for your first click.": "浏览器在页面被首次点击前会拦截音频，所以这项会等你点一下再开始。",
      "Playlist volume": "播放列表音量",
      "Play in order": "顺序播放",
      "Repeat all": "列表循环",
      "Repeat one": "单曲循环",
      "Shuffle": "随机播放",
      "{count} tracks": "{count} 首",
      Other: "其他",
      Close: "关闭",
      Automatic: "自动选择",
      "No game loaded yet.": "尚未加载游戏。",
      "The track config.main_menu_music resolves to.": "config.main_menu_music 解析到的曲目。",
      "Replace the extracted opening with any image or video file the game ships, or a direct URL.":
        "用游戏里的任意图片 / 视频文件替换提取到的开场，也可以直接填 URL。",
      "Full settings live in Settings → Ren'Py skin.": "完整设置在 设置 → Ren'Py 皮肤 中。",
      "Open the full settings page": "打开完整设置页",
      "Import from a file": "从文件导入",
      "Advanced: paste JSON": "高级：粘贴 JSON",
      "Hide the paste box": "收起粘贴框",
      "Exported renpy-skin-config.json": "已导出 renpy-skin-config.json",
      "Paste a previously exported config. A gameDir inside it is applied immediately.":
        "粘贴之前导出的配置。其中包含的 gameDir 会立即生效。",
      "Name box": "姓名框",
      "Dialogue": "对话",
      "Text box": "文本框",
      "Side image": "侧立绘",
      "HUD": "界面",
      "Reset — press Save layout to keep it.": "已重置 — 按「保存布局」后生效。",
      "Click again to confirm": "再点一次确认",
      "This game already has a saved layout. Clicking again restores the scanned positions; the saved layout is replaced only when you press Save layout.":
        "这个游戏已经保存过布局。再点一次会恢复扫描时的原始位置；已保存的布局要再点「保存布局」才会被替换。",
      "Clicking again discards the unsaved positions and restores the scanned layout.":
        "再点一次会丢弃当前未保存的位置，恢复扫描时的原始布局。",
      "Seek": "播放进度",
      "Import file read failed": "读取导入文件失败",
      "This track cannot be played here.": "这个浏览器无法播放该曲目。",
      // ── analysed VNs (the game-directory picker) ──────────────────────────
      "Known VNs": "已分析的 VN",
      "Re-read this game": "重新加载",
      "Current game": "当前游戏",
      "{count} analysed": "已分析 {count} 个",
      "No game has been analysed yet. Load one below.": "还没有分析过任何游戏。在下面加载一个。",
      "Re-reading…": "重新加载中…",
      "Add a game directory": "添加游戏目录",
      // ── composer backdrop ─────────────────────────────────────────────────
      "Composer backdrop": "输入区背景",
      "The band the shell paints behind the composer while a reply streams.":
        "回复生成时，外壳在输入框后面铺的那条底色带。",
      "Default (shell gradient)": "默认（外壳渐变）",
      "Transparent — let the game art show": "透明——露出游戏画面",
      "Solid — no fade": "实色——不做渐变",
      // ── per-track grouping and seeking ────────────────────────────────────
      "{shown} of {total} expressions: {list}": "{total} 个表情中的 {shown} 个：{list}",
      "No track matches the filter.": "没有符合筛选条件的曲目。",
      // ── switching games ───────────────────────────────────────────────────
      "Replay the opening when switching": "切换游戏时重播开场",
      "Show the new game's extracted opening after a switch. Startup is governed by the toggle above.":
        "切换后播放新游戏提取出的开场。启动时是否播放由上面的开关控制。",
      "Load with Agents": "用 Agent 加载",
      "Opening…": "正在打开…",
      "Click again to load": "再点一次加载",
      "An Agent profile already exists for this game (written {when}). Click again to open a new session and ask the Agent to regenerate its profile; the existing profile may be overwritten.":
        "这个游戏已经有一份 Agent 配置（写于 {when}）。再点一次会新建会话并让 Agent 重新生成配置，现有配置可能被覆盖。",
      "Open a new session with this game already loaded, and ask the agent to write its profile.":
        "新建一个会话（游戏已由宿主加载），让 Agent 写完它的配置。",
      "Sent to a new session.": "已发到新会话，游戏已由宿主加载，去那里等 Agent 汇报即可。",
      "Could not prepare the game: {reason}": "没能准备好游戏：{reason}",
      "Could not open a session: {reason}": "没能新建会话：{reason}",
      "Copy the prompt": "复制提示词",
      "Copied the prompt.": "已复制提示词，可以粘贴到任意会话。",
      "Could not copy the prompt.": "没能复制提示词。",
      "The agent finished the profile for {name}: {count} fields corrected.":
        "Agent 写完了 {name} 的配置：修正了 {count} 个字段。",
      "The agent finished the profile for {name}, but corrected nothing the scan got wrong.":
        "Agent 写完了 {name} 的配置，但没有修正任何扫描值。",
      "The agent finished the profile for {name}, but it belongs to a different game folder, so nothing was applied.":
        "Agent 写完了 {name} 的配置，但它属于另一个游戏目录，未应用。",
      "Apply it now?": "要立即更换外观吗？",
      "Apply now": "立即更换",
      "Later": "先保存",
      "The profile the agent wrote": "Agent 写下的配置",
      "Written {when}.": "写入时间 {when}。",
      "{count} fields applied over the scan.": "相对扫描改掉了 {count} 个字段。",
      "Nothing was applied over the scan.": "没有盖掉任何扫描值。",
      "Ignored: {list}": "被忽略：{list}",
      "Dropped: {list}": "被丢弃：{list}",
      "Unknown fields: {list} (written, but not counted as applied)":
        "拼错的字段：{list}（仍会写入，但不计为已应用）",
      "Reached nothing in the scan: {list}": "没有匹配到任何扫描记录：{list}",
      "The note is {chars} characters long; only its beginning is shown.":
        "笔记共 {chars} 个字符，这里只显示开头。",
      "This profile was written for a different game folder ({dir}); it is not applied.":
        "这份配置是为另一个游戏目录（{dir}）写的，未应用。",
      "Summary:": "摘要：",
      "Profile folder: {dir}": "配置目录：{dir}",
      [AGENT_LOAD_PREPARED]: "Ren'Py 皮肤已经替我加载好这个游戏了——没有需要你去查的东西，也没有路径要问我。先调用 renpy_read_manifest：它返回扫描器读到的值（画布尺寸、对话框及其几何、颜色、字体、角色、背景）。然后读工作区里的两份清单：scan-tree.md 是游戏的紧凑地图；需要精确路径时，scan-tree.full.txt 列出了每个文件。接着用 renpy_save_vn 写出配置：目录树作为 tree 传入，config 里只写扫描读错或读不出来的值——对照清单，不要去猜编译出来的脚本；再把你的压缩摘要作为 summary 传入。最后告诉我游戏名、读到了多少个背景和角色，以及哪些模块没读到。renpy_configure 只用于以后切换到别的游戏，这次不要调用它。",
      [AGENT_LOAD_UNPREPARED]: "请帮我把 Ren'Py 皮肤指向一个游戏。先问我它的目录；不要自己扫盘。然后用 renpy_configure 加载它。接着调用 renpy_read_manifest：它返回扫描器读到的值（画布尺寸、对话框及其几何、颜色、字体、角色、背景）。之后读工作区里的两份清单：scan-tree.md 是游戏的紧凑地图；需要精确路径时，scan-tree.full.txt 列出了每个文件。再用 renpy_save_vn 写出配置：目录树作为 tree 传入，config 里只写扫描读错或读不出来的值——对照清单，不要去猜编译出来的脚本；再把你的压缩摘要作为 summary 传入。最后告诉我游戏名、读到了多少个背景和角色，以及哪些模块没读到。",
      // ── the opening-media picker ──────────────────────────────────────────
      "Choose a file…": "选择文件…",
      "Selected: {path}": "已选择: {path}",
      "Clear": "清除",
      "Choose the opening media": "选择开场媒体",
      "Use": "使用",
      "Or pick one of the files this game ships.": "或从该游戏自带的文件里选一个。",
      "Search the game's images and videos": "搜索游戏内的图片和视频",
      "Reading the game's media…": "正在读取游戏内的媒体…",
      "Nothing matches.": "没有匹配项。",
      "{shown} of {total} shown — narrow the search to see the rest.":
        "已显示 {shown} / {total} —— 缩小搜索范围可看到其余项。",
      // ── the background switcher ───────────────────────────────────────────
      "Every background and CG this game ships ({count}). Click one to pin it behind the conversation; Automatic follows the game again.":
        "这个游戏自带的所有背景与 CG（共 {count} 张）。点一张即可把它固定为对话区背景；选「自动选择」则重新跟随游戏。",
      "Search by name or path…": "按名字或路径搜索…",
      "All ({count})": "全部（{count}）",
      "Backgrounds ({count})": "背景（{count}）",
      "CGs ({count})": "CG（{count}）",
      "No image matches this search.": "没有符合搜索条件的图片。",
      "Page {page} / {pages} · {count} shown": "第 {page} / {pages} 页 · 匹配 {count} 张",
      "Pinned: {name}": "已固定：{name}",
      // ── roleplay (the 「在场」 preset) ──────────────────────────────────────
      "Roleplay 「在场」": "角色扮演「在场」",
      "These reach a conversation running the 「在场」 agent preset; pick it in the composer when you start one.":
        "这些设置只作用于使用「在场」智能体预置的会话；新建会话时在输入框里选择该预置。",
      "Your name in the scene": "你在戏中的名字",
      "How the characters address you.": "戏里的角色这样称呼你。",
      unnamed: "未命名",
      "Name for this conversation": "本次会话的名字",
      "Overrides the name above in this session only. Clear it to fall back.": "只在本次会话里覆盖上面的名字；清空则回落到全局名字。",
      "Extra directions": "额外要求",
      "Added to the 「在场」 prompt for every session: tone, boundaries, what to avoid.":
        "追加进「在场」的提示词，对每个会话生效：语气、边界、要避免的内容。",
      "Character memory": "角色记忆",
      Memory: "记忆",
      "One file per character, kept across conversations. The 「在场」 preset reads it every turn; the model appends through `renpy_memory`.":
        "每个角色一份，跨会话保留。「在场」预置每一轮都会读到；模型通过 `renpy_memory` 追加。",
      "Load a game to keep memories of its characters.": "先加载游戏，才能记住它的角色。",
      "What should {tag} remember?": "{tag} 应该记住什么？",
      "the character": "这个角色",
      Save: "保存",
      "Remember this": "记住这段",
      "Appended to {tag}.": "已追加到 {tag}。",
      "Saved {tag}.": "已保存 {tag}。",
      "Could not save: {reason}": "保存失败：{reason}",
      "Saved. The oldest lines were dropped to stay within the limit.": "已保存。为保持在长度上限内，最早的内容已被丢弃。",
      // ── the dialogue plate picker ─────────────────────────────────────────
      "Dialogue box art": "对话框样式",
      "Dialogue box": "对话框",
      "{count} characters stored.": "已存 {count} 个字符。",
      "This game ships {count} say-box plates. The choice is saved for this game only.":
        "这个游戏自带 {count} 张对话框底板。选择只保存在这个游戏里。",
      "Used by the composer and the user's own messages.": "输入框和用户自己的消息都会用这张底板。",
      "Choose…": "选择…",
      "Choose the dialogue box": "选择对话框底板",
      "In use": "使用中",
      "Unknown plate": "未知底板",
      "The agent can switch this too, with renpy_save_vn.": "Agent 也可以用 renpy_save_vn 切换。",
      "cannot switch the dialogue box": "无法切换对话框底板",
      // ── the environment card ──────────────────────────────────────────────
      Environment: "环境配置",
      "Compiled .rpyc scripts can only be read with Python 3.9 or newer and unrpyc. Both are optional: without them a game still loads and loose .rpy source is read, but every value that lives in a compiled script falls back to its default.":
        "只有编译成 .rpyc 的脚本需要 Python 3.9 以上和 unrpyc 才能读取；两者都是可选的。没有它们游戏照样加载、源码仍在的 .rpy 也照读，只是凡是只存在于编译脚本里的取值都会回落到默认值。",
      "Could not read the environment: {reason}": "读不到环境状况：{reason}",
      "Node.js (part of DSH)": "Node.js（DSH 自带）",
      "Python 3.9 or newer (optional)": "Python 3.9 或更高（可选）",
      "unrpyc (optional)": "unrpyc（可选）",
      "Data folder": "数据目录",
      Found: "已找到",
      "Not found": "未找到",
      "Does not work": "不可用",
      "Found through {source}.": "来源：{source}。",
      "the path set here": "本页填写的路径",
      "an environment variable": "环境变量",
      "a Python shipped with DSH": "DSH 自带的 Python",
      "the home Tools folder": "家目录下的 Tools 文件夹",
      "the plugin's own vendor folder": "插件自带的 vendor 目录",
      "the Tools folder": "工具目录",
      "Download Python": "下载 Python",
      "Download unrpyc (source archive, v2.0.4)": "下载 unrpyc 源码包（v2.0.4）",
      "Project page": "项目主页",
      "unrpyc is not on PyPI: `pip install unrpyc` fails with no matching distribution. Unzip the archive and point the path below at unrpyc.py or at the folder that contains it, or copy unrpyc.py into {root}/vendor/unrpyc/.":
        "unrpyc 不在 PyPI 上：`pip install unrpyc` 会报没有匹配的发行版。请把源码包解压后，在下面填写 unrpyc.py 的路径或它所在的目录，或把 unrpyc.py 复制到 {root}/vendor/unrpyc/。",
      "The old data folder still exists: {dir}. Two folders at once means one of them is ignored.":
        "旧的数据目录仍然存在：{dir}。两份目录同时存在时，其中一份会被忽略。",
      "How to install unrpyc": "如何安装 unrpyc",
      "Tool locations": "工具位置",
      "Path of python.exe, or a name on PATH. Empty finds one automatically.":
        "python.exe 的路径，或 PATH 上的名字。留空则自动查找。",
      "Path of unrpyc.py, or the folder it was unpacked into. Empty searches the tools folder, the plugin's vendor folder and PATH.":
        "unrpyc.py 的路径，或解压出来的 unrpyc 目录（会在其中查找 unrpyc.py）。留空则依次在工具目录、插件的 vendor 目录和 PATH 里查找。",
      "Tools folder": "工具目录",
      "Where to look for unrpyc checkouts. Empty means {dir}.": "去哪里查找 unrpyc 检出目录。留空表示 {dir}。",
      "Checking…": "检测中…",
      "Check again": "重新检测",
      "Compiled scripts can be read.": "可以读取编译脚本。",
      // ── the palette card ──────────────────────────────────────────────────
      "Each colour is read from the game unless you pick one here; a pick applies as soon as the picker closes.":
        "每个颜色都默认读自游戏，只有你在这里选了才用你选的；选色器一关就生效。",
      "Read from {source}.": "来源：{source}。",
      "a gui variable": "游戏的 gui 变量",
      "the say screen": "say 屏",
      "a style block": "样式定义",
      "the text box image": "对话框底板图片",
      "the dialogue text colour": "对话文字颜色",
      "this page": "本页设置",
      "Ren'Py's default": "Ren'Py 默认值",
      "Use the game's colour": "恢复游戏配色",
      "Follow the dialogue text": "跟随对话文字",
      "Dialogue text": "对话文字",
      "Interface text": "界面文字",
      "The text inside the dialogue box.": "文本框（对话框）里的文字。",
      "The shell's own text. Left alone the dark theme follows the dialogue colour and the light theme derives from the accent; a pinned colour applies to both themes.":
        "DSH 界面自身的文字。留空时暗色主题跟随对话文字颜色、浅色主题由强调色派生；一旦指定，两种主题都用你选的颜色。",
      Accent: "强调色",
      Hover: "悬停色",
      Idle: "空闲色",
      Name: "名字色",
      "Choice text": "选项文字色",
      "Choice hover": "选项悬停色",
    };

    let localeService;
    function attachLocale(service) {
      localeService = service;
      if (service !== undefined && typeof service.subscribe === "function") {
        service.subscribe(syncLang);
        syncLang();
      }
    }
    function activeLocaleId() {
      const forced = store.get().settings?.lang;
      if (forced === "zh" || forced === "en") return forced;
      const active = localeService?.getSnapshot?.().active;
      if (typeof active === "string" && active.length > 0) return active;
      if (typeof navigator !== "undefined" && typeof navigator.language === "string") return navigator.language;
      return "en";
    }
    function syncLang() {
      store.set({ lang: activeLocaleId() });
    }
    /** Translate `key`, substituting `{name}` placeholders from `params`. */
    function t(key, params) {
      // Read the active locale fresh on every call: the forced `lang` setting
      // lives in `store.settings`, which the language control updates in-place,
      // so a cached `store.lang` would go stale the moment the user toggles it.
      const isZh = String(activeLocaleId()).toLowerCase().startsWith("zh");
      let text = isZh ? (zh[key] ?? key) : key;
      if (params !== undefined) {
        for (const [name, value] of Object.entries(params)) {
          text = text.split(`{${name}}`).join(String(value));
        }
      }
      return text;
    }

    // ── host transport ─────────────────────────────────────────────────────

    async function fetchJson(path, init) {
      const response = await fetch(path, { credentials: "same-origin", ...init });
      if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
      return response.json();
    }

    let pollTimer;

    /**
     * Pull the manifest once; the manifest itself is cached host-side.
     *
     * The status goes through `"loading"` so the surfaces can show that a scan
     * is running: a large `.rpa` takes seconds, and without it a user who sees
     * nothing change just clicks Load again (each click starting another scan).
     * A failure CLEARS the manifest, because leaving the previous game's name,
     * palette and cast on screen next to a new error reads as "it worked".
     */
    async function refreshManifest() {
      store.set({ status: "loading", error: undefined });
      try {
        const data = await fetchJson(`${ROUTE}/manifest?session=${encodeURIComponent(currentSessionId())}`);
        if (data.ok !== true) {
          store.set({
            status: "error",
            error: data.error ?? "cannot read the game directory",
            manifest: undefined,
            vn: undefined,
          });
          return;
        }
        store.set({
          status: "ready",
          error: undefined,
          manifest: data.manifest,
          settings: data.settings,
          library: Array.isArray(data.library) ? data.library : store.get().library,
        });
        // The profile belongs to the game that is now loaded, so it is read in
        // the same breath — the settings page shows it read-only, and the
        // 「用 Agent 加载」 watch needs the stamp it was armed with.
        void refreshVnProfile();
      } catch (error) {
        store.set({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          manifest: undefined,
          vn: undefined,
        });
      }
    }

    /**
     * Pull the profile the agent wrote for this game (`GET /renpy-skin/vn`).
     *
     * It is the second thing the host knows about a game (the manifest being the
     * first) and it is shown read-only rather than driving anything by itself.
     * Never throws: a profile that cannot be read must not cost the skin.
     */
    async function refreshVnProfile() {
      try {
        const data = await fetchJson(`${ROUTE}/vn?session=${encodeURIComponent(currentSessionId())}`);
        if (data.ok !== true) return undefined;
        store.set({ vn: data });
        return data;
      } catch {
        return undefined;
      }
    }

    // ── waiting for the agent's profile ────────────────────────────────────

    /**
     * The watch the 「用 Agent 加载」 button arms.
     *
     * The agent works in another Session and the host has no event for "a
     * profile was written", so the only way to know is to look: `GET /vn` every
     * three seconds, for at most ten minutes. A changed `savedAt` is the signal
     * — the same profile read twice must not re-open the prompt, and nothing
     * else about the answer is used to decide.
     */
    const PROFILE_WATCH_MS = 3000;
    const PROFILE_WATCH_TRIES = 200;
    let profileWatchTimer;
    let profileWatchTries = 0;

    function stopProfileWatch() {
      if (profileWatchTimer !== undefined) {
        window.clearTimeout(profileWatchTimer);
        profileWatchTimer = undefined;
      }
      profileWatchTries = 0;
    }

    /** `baseline` is the `profile.savedAt` the click already saw (possibly ""). */
    function startProfileWatch(baseline) {
      stopProfileWatch();
      const before = typeof baseline === "string" ? baseline : "";
      const tick = async () => {
        profileWatchTimer = undefined;
        if (profileWatchTries >= PROFILE_WATCH_TRIES) return;
        profileWatchTries += 1;
        const data = await refreshVnProfile();
        const savedAt = data?.profile?.savedAt ?? "";
        if (typeof savedAt === "string" && savedAt.length > 0 && savedAt !== before) {
          const rejected = data?.rejected ?? null;
          uiStore.set({
            profilePrompt: {
              name: data?.profile?.name ?? store.get().manifest?.game?.name ?? "",
              applied: Array.isArray(data?.applied) ? data.applied.length : 0,
              rejected,
            },
          });
          return;
        }
        profileWatchTimer = window.setTimeout(tick, PROFILE_WATCH_MS);
      };
      profileWatchTimer = window.setTimeout(tick, PROFILE_WATCH_MS);
    }

    /**
     * Deep-equality for the settings objects that arrive as freshly-parsed JSON
     * on every poll. A reference compare (`!==`) is ALWAYS true there, so the
     * store notified every 900 ms and every subscriber rebuilt its work — the
     * per-second `<style>` churn this replaces.
     */
    function sameJson(a, b) {
      if (a === b) return true;
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        return false;
      }
    }

    /** Poll the stage so the overlay follows the model's commands live. */
    async function pollStage() {
      try {
        const data = await fetchJson(`${ROUTE}/stage?session=${encodeURIComponent(currentSessionId())}`);
        const previous = store.get();
        const nextStage = data.stage ?? { sprites: [] };
        const changed =
          nextStage.updatedAt !== previous.stage.updatedAt ||
          (nextStage.scene?.image ?? "") !== (previous.stage.scene?.image ?? "");
        if (changed) {
          store.set({ stage: nextStage, revision: previous.revision + 1 });
        }
        // A gesture in flight owns these keys locally: the host's copy is the
        // pre-drag one, so echoing it would drag the control back mid-drag.
        if (previewPatch === undefined && data.settings !== undefined && !sameJson(data.settings, previous.settings)) {
          store.set({ settings: data.settings });
        }
      } catch {
        // A dropped poll is not an error worth surfacing; the next one retries.
      }
    }

    async function saveSettings(patch) {
      try {
        const data = await fetchJson(`${ROUTE}/settings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        store.set({ settings: data.settings });
        return data.settings;
      } finally {
        // The host's answer is the authority again — it holds what was just
        // previewed — so the poll may echo again. Clearing in `finally` also
        // covers a failed POST: a preview that never landed must not block the
        // poll forever behind a value the host does not have.
        previewPatch = undefined;
      }
    }

    /** Fetch the exported config object (single source of truth for a skin). */
    async function exportConfig() {
      const data = await fetchJson(`${ROUTE}/export?session=${encodeURIComponent(currentSessionId())}`);
      return data.config;
    }

    /** Push an imported config object to the host; returns the applied settings. */
    async function importConfig(config) {
      const data = await fetchJson(`${ROUTE}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config }),
      });
      store.set({ settings: data.settings });
      return data.settings;
    }

    /**
     * Switch the active game, or reload the current one, in ONE round-trip.
     *
     * The host answers with the fresh manifest, so there is no window where the
     * store still holds the previous game's cast or palette. Every client-side
     * thing that was derived from the old game is dropped here as well — the
     * stage, the player, the open panel and the splash latch — because the host
     * cannot reach any of them and a stale sprite over the new game is exactly
     * the "some state is still from the previous VN" bug.
     *
     * `gameDir` of `""` means "re-read this game from disk".
     */
    async function switchGame(gameDir) {
      const data = await fetchJson(`${ROUTE}/library`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameDir: typeof gameDir === "string" ? gameDir : "" }),
      });
      if (data.ok !== true) {
        store.set({ status: "error", error: data.error ?? "cannot read the game directory", manifest: undefined });
        return false;
      }
      // Claim the new directory before publishing it: the store write below
      // notifies the external-switch watcher, and without this it would treat
      // our own switch as somebody else's and refetch the manifest twice.
      activeGameDir = typeof data.settings?.gameDir === "string" ? data.settings.gameDir : gameDir;
      // Replay the opening only when the user opted in; the settings that come
      // back are the authority, not the ones we held before the switch.
      resetForNewGame(data.settings?.splashOnSwitch === true);
      store.set({
        status: "ready",
        error: undefined,
        manifest: data.manifest,
        settings: data.settings,
        library: Array.isArray(data.library) ? data.library : [],
        stage: { scene: undefined, sprites: [], transition: "none" },
      });
      return true;
    }

    // ── header utilities: panel state + the shared audio player ────────────
    //
    // Everything in this section exists because the shell's header strip
    // (`conversation.session.header.utilities`) is the only place the user
    // asked for these controls, and it hands an occupant NO props: each button
    // must reach the plugin's own state through these module-level stores.

    /**
     * Which header popover is open.
     *
     * Deliberately NOT part of the main store: that one is written by the
     * 900 ms stage poll, and a poll must never close a panel the user has just
     * opened.
     */
    const uiStore = createStore({ panel: undefined, profilePrompt: undefined });

    /**
     * The runtime context, captured because the header slot hands an occupant no
     * props and no other route back to `ctx`.
     */
    let runtimeCtx;

    /**
     * The shell's settings-dialog store, or `undefined` when it cannot be
     * reached.
     *
     * No documented client API opens the Settings dialog: `ui-settings` keeps
     * its store private to the `sidebar.settings` slot entry. The shipped
     * package leaves the handle on that entry and `slots.resolveStore` is a
     * public method, so those two hops reach it — but both are inspection
     * surfaces rather than contract, hence the guards and the `undefined`
     * return. The ledger is empty until `ui-settings` mounts, so "not yet" is an
     * ordinary answer here, not an error.
     */
    function hostSettingsStore() {
      const ctx = runtimeCtx;
      if (ctx === undefined) return undefined;
      const slots = serviceOf(ctx, "slots");
      if (slots === undefined || typeof slots.entries !== "function" || typeof slots.resolveStore !== "function") {
        return undefined;
      }
      const entry = slots.entries("sidebar.settings")[0];
      if (entry === undefined || entry.store === undefined) return undefined;
      return slots.resolveStore(entry.store, undefined);
    }

    /** Open the DSH settings dialog on one section; false if it could not. */
    function openHostSettings(sectionId) {
      try {
        const shell = hostSettingsStore();
        if (shell?.actions?.openSection === undefined) return false;
        shell.actions.openSection(sectionId);
        return true;
      } catch (error) {
        console.error("[dsh-renpy-skin] could not open the settings dialog", error);
        return false;
      }
    }

    /**
     * Ask the host to prepare a game for a new Session.
     *
     * This is the step the flow used to be missing. The prompt told the agent to
     * load a game nobody had loaded: no `renpy_*` registration had happened, no
     * workspace held the folder, and the tool the prompt named was not in the
     * request at all. The host now loads the game, writes both listings and
     * answers with the real paths, and only then does the session open.
     *
     * A refusal is a 400 whose BODY carries the reason (`not a Ren'Py game …`),
     * so the reason is read from the JSON rather than from the status line.
     */
    async function prepareGame(session, gameDir) {
      const body = { session };
      if (typeof gameDir === "string" && gameDir.trim() !== "") body.gameDir = gameDir.trim();
      const response = await fetch(`${ROUTE}/agent/prepare`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(`${ROUTE}/agent/prepare -> HTTP ${response.status}`);
      }
      if (data?.ok !== true) throw new Error(data?.error ?? `${ROUTE}/agent/prepare -> HTTP ${response.status}`);
      return data;
    }

    /**
     * Chinese labels for the archive-entry breakdown in the agent prompt.
     *
     * Kept out of the `zh` dictionary: those keys are UI strings addressed by
     * `t()`, while these are format labels inside a sentence `zh` already chose
     * the wording of, so a lookup by English key would never find them.
     */
    const ARCHIVE_ENTRY_ZH = { audio: "音频", images: "图片", movies: "影片", scripts: "脚本" };

    /**
     * The text 「用 Agent 加载」 sends into the new Session.
     *
     * The user's own language is stated in the prompt rather than left to the
     * agent's default: the new Session inherits nothing from the one the button
     * was pressed in — no persona, no locale — so a Chinese user would otherwise
     * get asked in English. The instruction names the language instead of
     * demanding one, because a session whose own prompt already fixes a language
     * should win.
     *
     * `facts` is what `/agent/prepare` answered. Its paths are spelled out
     * because the agent cannot discover them: without them the only way to find
     * the game is to ask, which is exactly the dead end this replaces.
     */
    function agentLoadPrompt(facts) {
      const zh = String(activeLocaleId()).toLowerCase().startsWith("zh");
      // Only a prepared game may be described as loaded. Claiming otherwise
      // would send the agent to a manifest for a game the host never saw.
      const lines = [t(facts === undefined ? AGENT_LOAD_UNPREPARED : AGENT_LOAD_PREPARED)];
      if (facts !== undefined) {
        const stats = facts.stats ?? {};
        const archives = stats.archives;
        // A game can ship every script inside an archive: CSE has zero loose
        // `.rpy` files and 29 scripts in its `.rpa`, so a bare "0 scripts" told
        // the agent the game had none. Only the zero case is rewritten; a
        // non-zero count needs no explanation.
        const scriptsInside = typeof archives === "number" && archives > 0 && stats.scripts === 0 && typeof stats.archiveEntries?.scripts === "number"
          ? stats.archiveEntries.scripts
          : undefined;
        const counts = [
          stats.images === undefined ? "" : `${stats.images} images`,
          stats.audio === undefined ? "" : `${stats.audio} audio files`,
          stats.scripts === undefined
            ? ""
            : scriptsInside === undefined
              ? `${stats.scripts} scripts`
              : zh
                ? `0 个松散脚本（归档内 ${scriptsInside} 个）`
                : `0 loose scripts (${scriptsInside} inside archives)`,
          stats.fonts === undefined ? "" : `${stats.fonts} fonts`,
        ].filter((part) => part.length > 0);
        // Absent in a host that predates the field: printing `undefined` entry
        // counts would read as a real finding, so the whole line is dropped.
        const entries = stats.archiveEntries;
        const breakdown =
          typeof archives !== "number" || entries === undefined || typeof entries !== "object"
            ? ""
            : ["audio", "images", "movies", "scripts"]
                .filter((key) => typeof entries[key] === "number")
                .map((key) => `${zh ? ARCHIVE_ENTRY_ZH[key] : key} ${entries[key]}`)
                .join(", ");
        const archivesLine =
          typeof archives !== "number"
            ? ""
            : breakdown.length === 0
              ? zh
                ? `归档：${archives} 个。`
                : `Archives: ${archives}.`
              : zh
                ? `归档：${archives} 个（${breakdown} 条目）。`
                : `Archives: ${archives} (${breakdown} entries).`;
        // Two lists that are easy to confuse: the cast the scripts name
        // (`Character(...)`) and the art the scan could file into sprite
        // buckets. A game can declare six speakers whose folders do not match
        // their tags, so the line reports them apart when both are present.
        const cast =
          typeof stats.characters === "number"
            ? zh
              ? `已声明角色：${stats.characters} 个`
              : `Characters declared: ${stats.characters}`
            : "";
        const tagsLine =
          typeof stats.spriteTags === "number"
            ? zh
              ? `立绘标签：${stats.spriteTags} 个`
              : `Sprite tags: ${stats.spriteTags}`
            : "";
        const castLine = [cast, tagsLine].filter((part) => part.length > 0).join(zh ? "，" : ", ");
        lines.push(
          [
            `Game: ${facts.name ?? ""}`.trim(),
            `game directory: ${facts.paths?.gameDir ?? facts.gameDir ?? ""}`,
            `profile directory (your workspace): ${facts.paths?.profileDir ?? facts.profileDir ?? ""}`,
            `compact map: ${facts.paths?.compactTree ?? ""}`,
            `full listing: ${facts.paths?.fullTree ?? ""}`,
            counts.length === 0 ? "" : `Files: ${counts.join(", ")}.`,
            archivesLine,
            stats.backgrounds === undefined ? "" : `Backgrounds: ${stats.backgrounds}.`,
            castLine.length === 0 ? "" : `${castLine}.`,
            stats.truncated === true
              ? `The listing was truncated at ${stats.limit} files; the game holds more.`
              : "",
          ]
            .filter((part) => part.length > 0)
            .join("\n"),
        );
      }
      lines.push(zh ? "用中文向我提问和汇报。" : "Ask me and report back in English.");
      return lines.join("\n\n");
    }

    /**
     * Read an optional platform service, or undefined when it is absent.
     *
     * A Cordis context THROWS for a name it was not injected with rather than
     * answering undefined, so every lookup has to be guarded; widening `inject`
     * instead would turn the service into a hard requirement.
     */
    function serviceOf(ctx, name) {
      try {
        return ctx?.get?.(name);
      } catch {
        return undefined;
      }
    }

    /**
     * The session services, captured when the shell provides them.
     *
     * `ctx.get` is not a way to reach these: a Cordis context rejects a name it
     * was not injected with, so reading `uiWorkspace` at click time throws for
     * the whole lifetime of the plugin and the button could only ever fail.
     * `ctx.inject` is the documented wait — it fires once the service exists,
     * however late that is — and the scoped context it hands over resolves the
     * names without that guard, so `apply` stores them here.
     */
    let agentServices;

    /**
     * The Workspace CRUD service, captured independently of `agentServices`.
     *
     * It is a separate `ctx.inject`, and the two are not ordered: whichever
     * service mounts first fires first. Storing it inside `agentServices` would
     * lose it whenever it arrived first, because there would be no object to
     * assign to yet — and a later mount of the pair would then overwrite the
     * object without it.
     */
    let workspaceService;

    /**
     * The client context, kept for the few actions that need a platform service.
     */
    let platformCtx;

    /**
     * Resolve the session services, or say which one the shell does not have.
     *
     * There is no polling loop: `ctx.inject` already waited at mount, and a shell
     * that never provides a service is not going to provide it 300ms later — it
     * just means this profile cannot run the flow, which is worth saying plainly
     * instead of stalling the click. The `serviceOf` fallback covers the mirror
     * case: a context that resolves the name directly without the inject gate.
     */
    function sessionServices(ctx) {
      const held = agentServices;
      const workspace = held?.uiWorkspace ?? serviceOf(ctx, "uiWorkspace");
      const sessions = held?.sessions ?? serviceOf(ctx, "sessions");
      // `workspaces` is genuinely optional: without it the session still opens,
      // just in whatever folder is current instead of the profile folder.
      const workspaces = workspaceService ?? held?.workspaces ?? serviceOf(ctx, "workspaces");
      if (typeof workspace?.startSession !== "function") throw new Error("the shell provides no workspace service");
      if (typeof sessions?.binding !== "function") throw new Error("the shell provides no session service");
      return { workspace, sessions, workspaces };
    }

    /** The Session the conversation pane is showing, read from the shell's own DOM hook. */
    function shownSessionId() {
      return document.querySelector("[data-conversation-session]")?.getAttribute("data-conversation-session") ?? undefined;
    }

    /**
     * Whether the conversation on screen has already begun.
     *
     * The shell tags the phase on an ancestor of the composer — the same hook
     * the dialogbox CSS keys off — and a blank Session (the "hero" phase) has
     * neither spelling. That is what separates a blank Session the shell reused
     * from the conversation the user was already reading.
     */
    function conversationHasBegun() {
      try {
        return (
          document.querySelector(
            '[data-phase="active"] [data-composer-seat], [data-content-phase="active"] [data-composer-seat]',
          ) !== null
        );
      } catch {
        // No DOM hook to read: assume nothing was opened, which is the old
        // behaviour rather than a new refusal.
        return false;
      }
    }

    /**
     * Ask the agent to load a game: open a New Session and send it the prompt.
     *
     * `uiWorkspace.startSession()` is the documented New Session flow and
     * `Session.prompt(content, "queue")` is how the composer itself submits. The
     * new Session is found by watching the shell's `data-conversation-session`
     * hook change: the shell reuses an already-blank Session instead of minting
     * one, in which case the id stays and the pane is still in its `hero` phase.
     * An unchanged id on a conversation that has already begun means the flow
     * opened nothing at all — queueing there would bury the prompt in the user's
     * own chat — so that is a failure too.
     *
     * Every failure ABORTS with a reason. An earlier version copied the prompt to
     * the clipboard instead and reported "copied", which hid the real problem:
     * the prompt asks the agent to read a game the host never loaded, so pasting
     * it lands in front of a model that has no tool, no workspace and no path —
     * a dead end the user has to diagnose themselves. The clipboard is now only
     * the button's own separate action.
     *
     * @param ctx the client context (a parameter so the flow can be exercised
     *   without a live shell).
     * @param text the prompt to queue.
     * @param workspacePath the folder the new session should work in, if known.
     * @returns `"sent"`.
     * @throws with a user-readable reason on every failure path.
     */
    async function loadWithAgent(ctx, text, workspacePath) {
      const { workspace, sessions, workspaces } = sessionServices(ctx);
      // The new session works in the VN's own profile folder, so the agent
      // writes its tree and its summary next to the profile they describe
      // rather than into whatever folder is current. The folder itself is
      // created by the save tool, so this only registers the path — and a
      // refusal here must not cost the user the whole flow: the session still
      // opens and the profile tool still writes to the right place.
      let workspaceId;
      if (typeof workspacePath === "string" && workspacePath.length > 0 && workspaces !== undefined) {
        try {
          const view = await workspaces.create({ path: workspacePath });
          workspaceId = view?.id ?? view?.workspaceId;
        } catch (error) {
          console.warn(
            "[renpy-skin] workspace registration failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const before = shownSessionId();
      workspace.startSession(workspaceId);
      // The shell reuses an already-blank Session instead of minting one, so a
      // missing new id is not failure by itself: what decides is whether the
      // pane is still showing the conversation the user was reading.
      let target;
      for (let attempt = 0; attempt < 60 && target === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const now = shownSessionId();
        if (now !== undefined && now !== before) target = now;
      }
      if (target === undefined) {
        if (conversationHasBegun()) throw new Error("the shell kept the current conversation");
        target = shownSessionId() ?? before;
      }
      if (typeof target !== "string") throw new Error("no session to prompt");
      // The binding appears a moment after the id does, and the id alone is not
      // enough: this is the object the composer itself drives.
      let session;
      for (let attempt = 0; attempt < 40 && session === undefined; attempt += 1) {
        const binding = sessions.binding(target);
        if (binding !== undefined) session = binding.session;
        else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (session === undefined) throw new Error(`session "${target}" resolved no binding`);
      const result = await session.prompt([{ type: "text", text }], "queue");
      if (result?.ok === false) throw new Error(result.error?.message ?? "the host refused the prompt");
      return "sent";
    }

    /**
     * Put the prompt on the clipboard — the button's own fallback, never automatic.
     *
     * This exists so a user whose shell will not open a session still has a way
     * to get the prompt out. It is a separate action because only the user can
     * decide whether pasting it is worth doing without a prepared game.
     */
    async function copyAgentPrompt(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        console.warn("[renpy-skin] could not copy the prompt:", error instanceof Error ? error.message : String(error));
        return false;
      }
    }

    /**
     * The single `<audio>` element every sound goes through.
     *
     * One element is what keeps the menu music and the playlist from ever
     * overlapping: starting either one stops the other, which is the behaviour
     * a user expects from "the game's music" rather than two sources fighting.
     */
    let playerElement;

    /**
     * Where that one element is parked so the NEXT load of this module can find it.
     *
     * The "one element" rule above only holds inside one closure. Reloading the
     * client half — which includes a host restart that the page survives —
     * evaluates this factory again, so `playerElement` starts out `undefined`
     * while the previous build's element is still playing. Nothing in the new
     * closure can reach it, and the first click then starts the same menu track
     * a second time: the reported "the last audio instance isn't destroyed and
     * the next one starts on top, so it sounds noisy".
     */
    const AUDIO_GLOBAL = "__dshRenpySkinAudio";

    /** Stop a media element this closure no longer owns. */
    function silence(element) {
      if (element === undefined || element === null) return;
      try {
        element.pause();
        // Clearing the source is what actually ends the stream; `pause()` alone
        // leaves it buffered and audible the moment anything resumes it.
        element.removeAttribute("src");
        element.load();
      } catch {
        // A detached or already-collected element must never break a reload.
      }
    }

    /** Stop whatever a previous load of this module left playing. */
    function retireStaleAudio() {
      const stale = globalThis[AUDIO_GLOBAL];
      if (stale === undefined) return;
      globalThis[AUDIO_GLOBAL] = undefined;
      silence(stale);
    }

    // At module evaluation, not at first playback: a reload that never gets to
    // start a track would otherwise leave the old one audible forever.
    retireStaleAudio();

    const playerStore = createStore({
      source: "none", // "none" | "menu" | "playlist"
      index: -1,
      playing: false,
      time: 0,
      duration: 0,
      volume: 0.6,
      error: undefined,
    });

    /**
     * The best known length for the loaded track.
     *
     * A finite `element.duration` is authoritative when a format carries one
     * (or when the response keeps its `content-length`), but for the Ogg files
     * a Ren'Py game ships it is `Infinity`, so the manifest's measured value is
     * the fallback rather than showing `--:--` for every track.
     */
    function resolvedDuration(element, track) {
      if (element !== undefined && Number.isFinite(element.duration) && element.duration > 0) {
        return element.duration;
      }
      return typeof track?.duration === "number" && Number.isFinite(track.duration) ? track.duration : 0;
    }

    /** The lazily-created shared audio element, or `undefined` with no DOM. */
    function audio() {
      if (playerElement !== undefined) return playerElement;
      if (typeof Audio === "undefined") return undefined;
      const element = new Audio();
      playerElement = element;
      // The previous load parked its element on the global; it has to go before
      // this one makes a sound, or both play at once.
      retireStaleAudio();
      globalThis[AUDIO_GLOBAL] = element;
      element.preload = "auto";
      element.volume = playerStore.get().volume;
      element.addEventListener("play", () => playerStore.set({ playing: true }));
      element.addEventListener("pause", () => playerStore.set({ playing: false }));
      element.addEventListener("ended", () => {
        // Main-menu music loops in Ren'Py; a playlist track advances instead.
        if (playerStore.get().source === "menu") {
          element.currentTime = 0;
          void element.play().catch(() => undefined);
          return;
        }
        const mode = playbackModeOf(store.get().settings ?? {});
        // Repeat-one re-cues the SAME element instead of re-assigning `src`:
        // re-assigning would restart the network fetch (and the decoder) on
        // every loop for a file already in memory.
        if (mode === "one") {
          element.currentTime = 0;
          void element.play().catch(() => undefined);
          return;
        }
        nextTrack({ automatic: true });
      });
      element.addEventListener("timeupdate", () =>
        playerStore.set({ time: element.currentTime, duration: resolvedDuration(element, activeTrack()) }),
      );
      element.addEventListener("loadedmetadata", () =>
        playerStore.set({
          duration: resolvedDuration(element, activeTrack()),
          error: undefined,
        }),
      );
      element.addEventListener("error", () => {
        // A codec the browser has no decoder for is the common case here (Ren'Py
        // games ship Ogg Vorbis and Opus, which Safari cannot play at all), so
        // the message names the track rather than blaming the plugin.
        playerStore.set({ playing: false, error: t("This track cannot be played here.") });
      });
      return element;
    }

    /** The playlist entry the player is currently on, if any. */
    function activeTrack() {
      const state = playerStore.get();
      if (state.source === "menu") return menuTrack();
      const tracks = playlistTracks();
      return state.index >= 0 && state.index < tracks.length ? tracks[state.index] : undefined;
    }

    /** Every playlist track in the current manifest, or an empty list. */
    function playlistTracks() {
      return store.get().manifest?.audio?.playlist ?? [];
    }

    /**
     * The state the single transport button displays and cycles through.
     *
     * Read from the settings store rather than mirrored into the player store:
     * the same values are edited from the panel and echoed by the host's poll,
     * so a copy would go stale the first time the poll won. Shuffle is reported
     * as its own state rather than as a flag on top of the repeat choice: the
     * button has to say, in one label, what the player will do when the current
     * track ends, and "shuffle + repeat" is not a thing a user can picture.
     */
    function playbackModeOf(settings) {
      if (settings?.playlistShuffle === true) return "shuffle";
      const repeat = settings?.playlistRepeat;
      if (repeat === "one") return "one";
      if (repeat === "all") return "all";
      return "order";
    }

    /** One press of the mode button: order -> all -> one -> shuffle -> order. */
    const PLAYBACK_NEXT = { order: "all", all: "one", one: "shuffle", shuffle: "order" };

    /**
     * What each state writes back.
     *
     * Shuffle clears the repeat choice on purpose. If it left `all` behind, the
     * two stored values would describe a state the button cannot name, and a
     * config read back on another machine would show "Repeat all" while drawing
     * random tracks.
     */
    const PLAYBACK_PATCH = {
      order: { playlistRepeat: "off", playlistShuffle: false },
      all: { playlistRepeat: "all", playlistShuffle: false },
      one: { playlistRepeat: "one", playlistShuffle: false },
      shuffle: { playlistRepeat: "off", playlistShuffle: true },
    };

    const PLAYBACK_LABEL = {
      order: "Play in order",
      all: "Repeat all",
      one: "Repeat one",
      shuffle: "Shuffle",
    };

    /**
     * A random track index that is not the current one.
     *
     * No playback history is kept on purpose. A "recently played" list would
     * have to survive a panel close, a game switch and a manifest reload to be
     * worth anything, and every Next press would then depend on state the user
     * cannot see. Drawing a fresh index is short, predictable and testable.
     */
    function shuffleIndex(length, current) {
      if (length <= 1) return 0;
      if (current < 0) return Math.floor(Math.random() * length);
      // Draw from the `length - 1` candidates other than `current`, so the
      // spread stays uniform without a retry loop that spins on a short list.
      const pick = Math.floor(Math.random() * (length - 1));
      return pick >= current ? pick + 1 : pick;
    }

    /** Start one track, replacing whatever was playing. */
    function startTrack(track, source, index) {
      const element = audio();
      if (element === undefined || track === undefined) return false;
      // Seed the total from the manifest so the counter is right on the first
      // frame; `loadedmetadata` only confirms it.
      playerStore.set({ source, index: index ?? -1, time: 0, duration: resolvedDuration(undefined, track), error: undefined });
      // `loop` is the menu's contract; a playlist ends each track to advance.
      element.loop = source === "menu";
      element.src = track.url ?? track.path;
      element.volume = playerStore.get().volume;
      const started = element.play();
      if (started !== undefined && typeof started.then === "function") {
        started.catch(() => {
          // Autoplay policy: the browser only lets us start audio after a user
          // gesture. Leave the track loaded so the first click resumes it
          // instead of silently doing nothing.
          playerStore.set({ playing: false });
        });
      }
      return true;
    }

    /** The track the game's own menu music resolves to, honouring the override. */
    function menuTrack() {
      const manifest = store.get().manifest;
      const settings = store.get().settings ?? {};
      const candidates = manifest?.audio?.menuMusic ?? [];
      const chosen = settings.menuMusicTrack;
      if (typeof chosen === "string" && chosen.length > 0) {
        const match = candidates.find((track) => track.path === chosen);
        if (match !== undefined) return match;
      }
      return candidates.find((track) => track.preferred === true) ?? candidates[0];
    }

    function togglePlay() {
      const element = audio();
      if (element === undefined) return;
      const state = playerStore.get();
      if (state.source === "playlist" && state.index >= 0) {
        if (state.playing) element.pause();
        else void element.play().catch(() => undefined);
        return;
      }
      const tracks = playlistTracks();
      if (tracks.length === 0) return;
      const resume = state.source === "playlist" && state.index >= 0 && element.src.length > 0;
      if (resume) {
        void element.play().catch(() => undefined);
        return;
      }
      startTrack(tracks[0], "playlist", 0);
    }

    /**
     * Advance one track.
     *
     * `options.automatic` marks the call from the `ended` listener: only then may
     * the end of a non-looping list stop playback. A manual Next on the last
     * track is a no-op instead, because the user can see the list has no more
     * tracks and stopping would look like the button broke the player.
     * A React click event also arrives here as `options`; it has no `automatic`
     * property, so the manual branch is the default.
     */
    function nextTrack(options) {
      const tracks = playlistTracks();
      if (tracks.length === 0) return;
      const current = playerStore.get().index;
      const mode = playbackModeOf(store.get().settings ?? {});
      let index;
      if (mode === "shuffle") {
        // Shuffle deliberately ignores the end-of-list boundary: a random draw
        // always finds another track, so honouring "order" here would stop the
        // music while the button is visibly still able to play something.
        index = shuffleIndex(tracks.length, current);
      } else if (current < 0) {
        index = 0;
      } else if (current + 1 < tracks.length) {
        index = current + 1;
      } else if (mode === "all") {
        index = 0;
      } else {
        // `ended` fires after the element already stopped; only the stored flag
        // is stale. The track stays loaded at its final position, so Play still
        // restarts it.
        if (options?.automatic === true) playerStore.set({ playing: false });
        return;
      }
      startTrack(tracks[index], "playlist", index);
    }

    function previousTrack() {
      const tracks = playlistTracks();
      if (tracks.length === 0) return;
      const current = playerStore.get().index;
      const mode = playbackModeOf(store.get().settings ?? {});
      let index;
      if (mode === "shuffle") {
        index = shuffleIndex(tracks.length, current);
      } else if (current < 0) {
        index = 0;
      } else if (current > 0) {
        index = current - 1;
      } else if (mode === "all") {
        index = tracks.length - 1;
      } else {
        return;
      }
      startTrack(tracks[index], "playlist", index);
    }

    /**
     * Stop everything that belongs to the game that is being left behind.
     *
     * Called on a VN switch and on unload. Two separate reasons:
     *   - Switching leaves the previous game's audio playing over the new game,
     *     and a playlist index that points into the OLD track list (which is why
     *     the panel could claim "no playable tracks" while still listing them).
     *   - Quitting DSH must silence the audio immediately. The renderer is torn
     *     down asynchronously and the media element has its own process, so
     *     without an explicit pause the song kept playing after the window was
     *     gone — the user reported hearing it until every DSH process exited.
     *     Pausing AND dropping `src` matters: `pause()` alone leaves the decoder
     *     alive, and only clearing the source releases it.
     */
    function stopMedia() {
      const element = playerElement;
      if (element !== undefined) {
        try {
          element.pause();
          element.removeAttribute("src");
          element.load();
        } catch {
          // A partially-torn-down element must not break the caller.
        }
      }
      playerStore.set({ source: "none", index: -1, playing: false, time: 0, duration: 0, error: undefined });
    }

    /** Drop every client-side trace of the game that was just replaced. */
    function resetForNewGame(replaySplash) {
      stopMedia();
      // The panel is not game state, but it holds the previous game's manifest,
      // so it closes. `splashAttempted` is deliberately NOT cleared: it marks
      // "the startup opening has had its chance in this page load", and clearing
      // it here is what made a game switch silently replay the startup splash
      // even with that toggle off. A switch decides for itself, below.
      splashWanted = replaySplash === true;
      uiStore.set({ panel: undefined, profilePrompt: undefined });
      // The profile belongs to the game that was just replaced. `refreshManifest`
      // (called by every switch path) reads the new game's one.
      store.set({ vn: undefined });
    }

    /** `mm:ss`, the only place a track length is ever formatted. */
    function clockTime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
      const whole = Math.floor(seconds);
      return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
    }

    // ── styles ─────────────────────────────────────────────────────────────

    const CSS = `
/* The host forces pointer-events:auto onto EVERY direct child of its overlay
   layer (.BynINW_overlayLayer > *) to implement its own opt-in, and that
   child-combinator rule beats a plain class selector. Without !important a
   full-frame stage swallows every click in the shell. */
.rsk-layer { position: absolute; inset: 0; pointer-events: none !important; }
/* The stage is a child of the conversation body, not of the shell overlay: the
   transcript and the composer occupy the same box and must paint ABOVE the
   sprites. Lifting the scroll body is what keeps the art scenery-shaped. */
.rsk-stage { z-index: 0; overflow: hidden; }
.rsk-stage-inner { position: absolute; inset: 0; }
[data-conversation-content] > [data-conversation-scroll] { position: relative; z-index: 1; }
.rsk-sprite { position: absolute; transform-origin: center bottom; will-change: transform, opacity; }
.rsk-sprite img { display: block; width: 100%; height: 100%; object-fit: contain; }
.rsk-sprite-layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
/* The say screen's own furniture, measured onto the composer. The layer itself
   stays a non-target like the stage — only its buttons take the pointer, which
   is what keeps the input underneath usable. */
.rsk-modules { z-index: 2; overflow: visible; }
.rsk-modules [data-renpy-module="button"]:not(:disabled) { transition: filter 120ms ease; }
.rsk-modules [data-renpy-module="button"]:not(:disabled):hover { filter: brightness(1.12); }
.rsk-modules [data-renpy-module="button"]:disabled { opacity: 0.7; }
.rsk-sprite-side { outline: 0; }
.rsk-page { display: flex; flex-direction: column; gap: 16px; }
.rsk-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 16px 18px; background: var(--dsw-alias-bg-layer-2); }
.rsk-card h4 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
.rsk-card > .rsk-card-sub { margin: 0 0 12px; }
/* Visual grouping: hairline-divided sections with a quiet label, instead of
   boxing every group into its own bordered card (which reads as cramped). */
.rsk-section { display: flex; flex-direction: column; }
.rsk-section + .rsk-section { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 12px; margin-top: 12px; }
.rsk-section-head { display: flex; align-items: center; margin-bottom: 4px; }
.rsk-section-label { font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
/* Uniform setting row: label(+hint) left, control right; roomy touch height. */
.rsk-ctl { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 40px; padding: 6px 0; }
.rsk-ctl--wrap { flex-wrap: wrap; row-gap: 8px; }
.rsk-ctl-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.rsk-ctl-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
.rsk-ctl-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.rsk-ctl-side { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.rsk-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 7px 0; font-size: 13px; }
.rsk-row label { color: var(--dsw-alias-label-primary); }
.rsk-row-label { flex: 1 1 auto; min-width: 0; }
.rsk-row-control { flex-shrink: 0; display: flex; align-items: center; }
.rsk-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; margin-top: 2px; }
/* A two-step confirmation is a prompt, not an error: the left rule and the
   panel fill keep it from reading as one more line of hint text. */
.rsk-confirm { margin-top: 6px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-left: 3px solid var(--dsw-alias-brand-primary); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.55; }
.rsk-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; }
/* A download link in the environment card. The shell paints bare anchors with
   the body colour, so a link read as one more line of hint text. */
.rsk-link { color: var(--dsw-alias-brand-primary); font-size: 12px; text-decoration: none; }
.rsk-link:hover { text-decoration: underline; }
.rsk-grow { flex: 1; }
/* A stacked row for controls too tall for the one-line rsk-ctl layout. */
.rsk-field { display: flex; flex-direction: column; gap: 5px; padding: 6px 0; }
.rsk-field textarea.rsk-input { min-height: 54px; resize: vertical; font-family: inherit; line-height: 1.5; }
.rsk-field-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* Dialogue plate picker: the say-box art a game ships, one thumbnail per file. */
.rsk-plates { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 10px; }
.rsk-plate { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.rsk-plate:hover { border-color: var(--dsw-alias-brand-primary); }
.rsk-plate[data-active="true"] { border-color: var(--dsw-alias-brand-primary); }
.rsk-plate img { display: block; width: 100%; height: 64px; object-fit: contain; border-radius: 4px; background: var(--dsw-alias-bg-layer-1); }
.rsk-plate-path { font-size: 11px; line-height: 1.4; word-break: break-all; color: var(--dsw-alias-label-secondary); }
.rsk-plate-current { font-size: 11px; color: var(--dsw-alias-brand-primary); }
.rsk-plate-head { display: flex; align-items: center; gap: 12px; }
.rsk-plate-head img { width: 132px; height: 56px; object-fit: contain; border-radius: 4px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); flex: 0 0 auto; }
.rsk-btn { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; }
.rsk-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.rsk-btn:disabled { opacity: .45; cursor: default; }
.rsk-btn[data-active="true"] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }
.rsk-btn svg { display: block; }
/* The host's Button defaults to its borderless ghost variant, so secondary
   actions in the settings page read as plain text. Every one of them carries
   the rsk-action class: the same edge and layer-1 fill as rsk-btn. The surface
   prefix outranks the host's own ghost rule without !important. Primary
   buttons keep their filled look and are deliberately not tagged. */
.rsk-page .rsk-action,
.rsk-panel .rsk-action,
.rsk-prompt .rsk-action { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.rsk-page .rsk-action:hover:not(:disabled),
.rsk-panel .rsk-action:hover:not(:disabled),
.rsk-prompt .rsk-action:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.rsk-mode-btn { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.rsk-grid { position: relative; width: 100%; aspect-ratio: 16 / 9; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); overflow: hidden; touch-action: none; }
.rsk-grid-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.55; cursor: grab; }
.rsk-box { position: absolute; box-sizing: border-box; border: 1px dashed var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); font-size: 9px; color: var(--dsw-alias-label-primary); padding: 1px 3px; cursor: move; }
.rsk-box.selected { border-style: solid; box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); }
.rsk-legend { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.rsk-swatches { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.rsk-swatch { width: 18px; height: 18px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l1); }
/* A palette picker: the native colour input, sized to sit in a control row. */
.rsk-color { width: 34px; height: 24px; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: none; cursor: pointer; }
.rsk-stat { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); font-size: 12px; }
/* A readout that sits beside a flexible control must neither shrink nor wrap:
   .rsk-input is width: 100%, so as a flex item its basis claims the whole
   row and the sibling gets squeezed until "112 首" breaks across two lines. */
.rsk-nowrap { flex: 0 0 auto; white-space: nowrap; }

/* ── background switcher ───────────────────────────────────────────────
   A 3x3 page of thumbnails: three columns because the settings page is the
   only surface it appears on. Every thumbnail keeps a 16:9 box so the tiles
   line up whatever the source art's ratio is (this game's CGs are 2880x1620
   and some of its CG layers are portrait 483x920). */
.rsk-gallery-bar { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.rsk-gallery-bar .rsk-input { width: auto; }
.rsk-gallery { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
.rsk-gallery-item { display: flex; flex-direction: column; gap: 4px; padding: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; text-align: left; }
.rsk-gallery-item:hover { border-color: var(--dsw-alias-brand-primary); }
.rsk-gallery-item--on { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); }
.rsk-gallery-thumb { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 5px; background: var(--dsw-alias-bg-base); }
.rsk-gallery-name { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rsk-gallery-nav { display: flex; gap: 8px; align-items: center; justify-content: center; margin-top: 8px; }

/* ── header utilities ──────────────────────────────────────────────────
   The strip is the shell's own .Dc7zOa_headerUtilities, which sits on a
   translucent bar and owns its own hover styling; the plugin only contributes
   two icon buttons, sized to match the neighbouring 28px affordances. */
.rsk-head-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.rsk-head-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.rsk-head-btn[data-active="true"] { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }
.rsk-head-btn svg { display: block; }
/* The header cluster's two seats, and the fix for the buttons leaving the
   top-right in a new chat. conversation.session.header.utilities is the seat
   beside the shell's own controls. It fails us in two ways:
   1. A blank Session — a chat with nothing in it yet. The shell hides the title
      cluster, and with it goes the flex:1 sibling that pushed the utilities row
      to the right edge; the platform re-anchors only its own corner button
      there (.headerBlank .headerCorner { margin-left: auto }), so the whole row,
      ours included, slides to the start of the header. Pin the cluster to the
      offsets the row holds it at with the cluster present — they are the same
      in both states, so this cannot move the buttons while a Session exists.
      Only the cluster moves; the row's other occupants keep the layout the
      platform gives them. The shell renders the actions seat exactly when it
      renders the title cluster, so its absence is how a stylesheet sees the
      blank state.
   2. No Session at all. The shell then renders no Session header whatsoever and
      swaps it for an empty title row, collapsing the header to nothing.
      conversation.header.leading is the seat the platform documents as
      "available without a Session", so the cluster is registered there too and
      the header is given back the height the buttons need. Exactly one copy is
      ever on screen, decided by the stylesheet: both seats live inside the same
      header element, so it can see which copy rendered. */
.rsk-head-fallback { display: none !important; position: absolute; top: 11px; right: 48px; }
/* !important is required in BOTH fallback rules: the cluster carries its own
   inline display: inline-flex, which a plain class rule cannot override. */
header[data-window-drag]:not(:has([data-slot="conversation.session.header.actions"])) { position: relative; }
header[data-window-drag]:not(:has([data-slot="conversation.session.header.actions"])) .rsk-head-primary { position: absolute; top: 11px; right: 48px; }
header[data-window-drag]:not(:has(.rsk-head-primary)) .rsk-head-fallback { display: inline-flex !important; }
header[data-window-drag]:has(.rsk-head-fallback):not(:has(.rsk-head-primary)) { min-height: 44px; }
/* A playing note pulses so the header shows playback without a tooltip. */
@keyframes rsk-note-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.rsk-head-btn[data-playing="true"] svg { animation: rsk-note-pulse 1.4s ease-in-out infinite; }

/* A popover lives in the overlay layer, which forces pointer-events:auto
   onto every direct child; .rsk-layer re-disables it, so the panel itself
   must re-enable it or the whole surface is inert. */
.rsk-pop-layer { z-index: 60; }
/* The opening-media picker opens from deep inside the settings page, where no
   ancestor is positioned — an absolute layer there would anchor to the document
   rather than the viewport. Fixed plus a dim backdrop also makes it read as a
   dialog, and the backdrop is the click-outside-to-close target. */
.rsk-modal { position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.45); }
/* The completion prompt lands on whatever the user is looking at, and its
   layer (.rsk-layer) is pointer-events:none, so the mask has to take the
   pointer back or neither the buttons nor click-outside would work. */
.rsk-prompt { pointer-events: auto !important; }
.rsk-prompt-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.rsk-modal .rsk-panel { top: 50%; right: auto; left: 50%; transform: translate(-50%, -50%); width: min(600px, calc(100vw - 32px)); max-height: min(80vh, 720px); }
.rsk-panel { position: absolute; top: 56px; right: 16px; width: min(520px, calc(100vw - 32px)); max-height: min(76vh, 760px); overflow: auto; box-sizing: border-box; padding: 14px 16px 18px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32); pointer-events: auto !important; }
.rsk-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.rsk-panel-title { font-size: 14px; font-weight: 600; }
.rsk-panel-close { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
.rsk-panel-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.rsk-divider { border-top: 1px solid var(--dsw-alias-border-l2); margin: 14px 0 10px; }
.rsk-panel-link { display: block; width: 100%; margin: 0 0 6px; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.rsk-panel-link:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l1); }
.rsk-player { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.rsk-player-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.rsk-seek { display: flex; align-items: center; margin-top: 6px; }
.rsk-seek input { width: 100%; }
.rsk-track-group { display: flex; flex-direction: column; gap: 1px; }
.rsk-track-group + .rsk-track-group { margin-top: 6px; }
.rsk-track-group-head { position: sticky; top: 0; padding: 4px 8px 3px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; }
.rsk-tracklist { display: flex; flex-direction: column; gap: 1px; max-height: 340px; overflow: auto; margin-top: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 4px; background: var(--dsw-alias-bg-base); }
.rsk-track { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; text-align: left; cursor: pointer; }
.rsk-track:hover { background: var(--dsw-alias-interactive-bg-hover); }
.rsk-track[data-current="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.rsk-track-index { flex: 0 0 22px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.rsk-track-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rsk-track-time { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

/* ── splash: the game's own opening, replayed full frame ─────────────── */
.rsk-splash { position: absolute; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: #000; overflow: hidden; pointer-events: auto !important; cursor: pointer; }
.rsk-splash img, .rsk-splash video { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; display: block; }
.rsk-splash-hint { position: absolute; right: 22px; bottom: 18px; font-size: 12px; color: rgba(255, 255, 255, 0.72); text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8); pointer-events: none; }
.rsk-splash-fallback { color: rgba(255, 255, 255, 0.72); font-size: 13px; padding: 24px; text-align: center; }
/* The overlay dissolves rather than vanishing, so the shell underneath is
   revealed instead of appearing to blink. Kept in step with SPLASH_FADE_MS. */
.rsk-splash[data-fading="true"] { opacity: 0; transition: opacity 420ms ease-out; pointer-events: none; }
/* The shell itself fades up underneath. Applied to <html> because the shell
   belongs to DSH and a plugin must not animate its own wrapper — the layout
   there is the shell's. Only ever present while a dismiss is in flight. */
html.rsk-main-reveal #root { animation: rsk-main-fade 420ms ease-out both; }
@keyframes rsk-main-fade { from { opacity: 0.25; } to { opacity: 1; } }

/* Decoration only, so a user who asked the OS for less motion gets the static
   states: the header's playing-note pulse and the stage's sprite crossfade.
   Neither carries information the animation is the only source of. */
@media (prefers-reduced-motion: reduce) {
  .rsk-head-btn[data-playing="true"] svg { animation: none; }
  .rsk-sprite { transition: none !important; }
  .rsk-splash[data-fading="true"] { transition: none; }
  html.rsk-main-reveal #root { animation: none; }
}
`;

    // ── background: painted inside the conversation column ─────────────────

    /**
     * The game's default background, shown until the model sets a scene.
     *
     * `manifest.backgrounds` is sorted by NAME, so its first entry is merely the
     * alphabetically-first image — not the game's main-menu art, which is what a
     * visual novel shows before anything else. Rank the candidates instead: the
     * main-menu image first, then the other `gui/` art, then anything under a
     * `bg/`/`backgrounds/` directory.
     */
    function pickBackground(manifest) {
      const list = manifest?.backgrounds ?? [];
      if (list.length === 0) return undefined;
      const rank = (entry) => {
        const path = String(entry.path ?? "").toLowerCase();
        const name = String(entry.name ?? "").toLowerCase();
        if (name.includes("main_menu") || path.includes("main_menu")) return 0;
        if (/^gui\//.test(path)) return 1;
        if (/(^|\/)(backgrounds?|bg)\//.test(path)) return 2;
        return 3;
      };
      let best = list[0];
      let bestRank = rank(best);
      for (const entry of list.slice(1)) {
        const next = rank(entry);
        if (next < bestRank) {
          best = entry;
          bestRank = next;
        }
      }
      return best;
    }

    /**
     * The image the user pinned in the background switcher.
     *
     * Matched on the manifest PATH rather than on a URL, so switching VNs cannot
     * silently pin an unrelated image whose name happens to collide, and a
     * pinned CG stays a wallpaper even though `pickBackground` only knows about
     * backgrounds.
     */
    function chosenBackground(state) {
      const wanted = (state.settings ?? {}).backgroundImage;
      if (typeof wanted !== "string" || wanted.length === 0) return undefined;
      return (state.manifest?.gallery ?? []).find((entry) => entry.path === wanted);
    }

    /**
     * Resolve the background the shell should show right now.
     * @returns `{ url, dim }`, or `undefined` when the layer is off or imageless.
     */
    function currentBackground(state) {
      const settings = state.settings ?? {};
      if (settings.enabled === false || settings.background === false) return undefined;
      // A pinned image outranks the stage: the model may `scene` whatever the
      // story needs, and the switcher is the user saying "I want THIS one" —
      // the most recent explicit human choice wins.
      const url = chosenBackground(state)?.url ?? state.stage.scene?.url ?? pickBackground(state.manifest)?.url;
      if (url === undefined) return undefined;
      const dim = typeof settings.backgroundDim === "number" ? settings.backgroundDim : 0.45;
      return { url, dim };
    }

    /**
     * Paint the background BEHIND the conversation content.
     *
     * This cannot use `shell.overlay`: the host renders that layer as an
     * absolutely-positioned sibling of the columns at `z-index: 20`, so anything
     * registered there paints over the sidebar AND over the message text — the
     * exact bug this replaces. Painting on the conversation body
     * (`[data-conversation-content]`, an un-hashed attribute the shipped UI
     * sets) puts the image behind the messages and leaves every other column
     * alone, because their own fills stay on top of nothing.
     */
    function applyConversationBackground(ctx) {
      if (typeof document === "undefined") return;
      ctx.effect(() => {
        let tag;
        let written;
        const sync = () => {
          const background = currentBackground(store.get());
          const next =
            background === undefined
              ? ""
              : `[data-conversation-content] { background-image: linear-gradient(rgba(0,0,0,${background.dim}), rgba(0,0,0,${background.dim})), url("${background.url}"); background-size: cover; background-position: center; background-repeat: no-repeat; }`;
          // Only touch the DOM when the CSS actually changed: `backgroundDim` is
          // a slider whose drag fires the store on every step.
          if (next === written) return;
          written = next;
          if (next === "") {
            if (tag !== undefined) {
              tag.remove();
              tag = undefined;
            }
            return;
          }
          if (tag === undefined) {
            tag = document.createElement("style");
            tag.dataset.plugin = "dsh-renpy-skin";
            tag.dataset.pluginCss = "dsh-renpy-skin/background";
            document.head.appendChild(tag);
          }
          tag.textContent = next;
        };
        const unsubscribe = store.subscribe(sync);
        sync();
        return () => {
          unsubscribe();
          if (tag !== undefined) tag.remove();
        };
      }, "dsh-renpy-skin: conversation background");
    }

    // ── overlay: sprite stage ──────────────────────────────────────────────

    /**
     * Render one sprite with the exact Ren'Py placement semantics: `xpos` /
     * `ypos` position the anchor point, `xanchor` / `yanchor` say which point
     * of the image that is, and the whole canvas is expressed in design units
     * so it scales with the window.
     */
    function spriteStyle(sprite, design) {
      const left = ((sprite.xpos ?? 0.5) + (sprite.xoffset ?? 0) / design.w) * 100;
      const top = ((sprite.ypos ?? 1) + (sprite.yoffset ?? 0) / design.h) * 100;
      return {
        left: `${left}%`,
        top: `${top}%`,
        // The image box is sized as a fraction of the design canvas, so zoom is
        // expressed by scaling a design-sized box rather than a pixel width.
        width: `${(sprite.zoom ?? 1) * 100}%`,
        height: `${(sprite.zoom ?? 1) * 100}%`,
        transform: `translate(${-(sprite.xanchor ?? 0.5) * 100}%, ${-(sprite.yanchor ?? 1) * 100}%) rotate(${sprite.rotate ?? 0}deg)`,
        opacity: sprite.alpha ?? 1,
        zIndex: sprite.zorder ?? 1,
        transition: "opacity 320ms ease, transform 320ms ease",
      };
    }

    /**
     * The sprite stage, drawn INSIDE the conversation column.
     *
     * `shell.overlay` is a full-frame sibling of the columns at `z-index: 20`,
     * so a stage registered there paints over the sidebar and over the
     * transcript — the sprites stop being scenery and become a modal poster.
     * The conversation body is the one box that sits below the composer and
     * outside the sidebar, so the stage is appended to it as its first child
     * and the scroll body (messages + composer) is lifted above it in CSS.
     *
     * The body belongs to React and is rebuilt when the session changes, so
     * this is an imperative effect: it appends exactly one node of its own,
     * touches no sibling, and re-attaches when its host disappears.
     */
    function applyStageLayer(ctx) {
      // A partial DOM (the headless client test) has no querySelector; the stage
      // is the one layer that needs to find its host element.
      if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
      ctx.effect(() => {
        const layer = document.createElement("div");
        layer.className = "rsk-layer rsk-stage";
        layer.dataset.renpySkin = "stage";
        const inner = document.createElement("div");
        inner.className = "rsk-stage-inner";
        layer.appendChild(inner);

        /** Keyed by `sprite.tag`, so a poll that changes one sprite does not rebuild the rest. */
        const nodes = new Map();
        let host;

        const findBody = () =>
          document.querySelector('[data-conversation-content][data-content-phase="active"]') ??
          document.querySelector("[data-conversation-content]");

        const attach = () => {
          const body = findBody();
          if (body === null) {
            if (layer.isConnected) layer.remove();
            host = undefined;
            return;
          }
          if (host !== body || !layer.isConnected) {
            layer.remove();
            body.insertBefore(layer, body.firstChild);
            host = body;
          }
        };

        const addImage = (sprite, layerEntry) => {
          const image = document.createElement("img");
          image.draggable = false;
          if (layerEntry === undefined) {
            image.src = sprite.url ?? "";
            image.alt = sprite.image ?? "";
          } else {
            image.className = "rsk-sprite-layer";
            image.src = layerEntry.url ?? "";
            image.alt = `${sprite.image ?? ""} ${layerEntry.attribute ?? ""}`.trim();
          }
          return image;
        };

        const sync = () => {
          attach();
          const state = store.get();
          const settings = state.settings ?? {};
          const placement = settings.stagePlacement ?? "overlay";
          const on = settings.enabled !== false && settings.stage !== false && placement === "overlay";
          if (!on) {
            layer.style.display = "none";
            inner.replaceChildren();
            nodes.clear();
            return;
          }
          layer.style.display = "";
          const design = state.manifest?.game?.screen ?? { w: 1920, h: 1080 };
          const max = typeof settings.maxStageSprites === "number" ? settings.maxStageSprites : 3;
          const visible = (state.stage.sprites ?? []).slice(0, Math.max(1, max));
          const wanted = new Set();
          for (const sprite of visible) {
            wanted.add(sprite.tag);
            let entry = nodes.get(sprite.tag);
            if (entry === undefined) {
              const node = document.createElement("div");
              node.dataset.renpySprite = sprite.tag;
              inner.appendChild(node);
              entry = { node, signature: undefined };
              nodes.set(sprite.tag, entry);
            }
            const node = entry.node;
            node.className = sprite.side === true ? "rsk-sprite rsk-sprite-side" : "rsk-sprite";
            node.dataset.renpyImage = sprite.image ?? "";
            const style = spriteStyle(sprite, design);
            for (const key of Object.keys(style)) node.style[key] = style[key];
            // Layered sprites have no single file, so the set of layers is the
            // content key; a plain sprite is keyed by its URL.
            const signature =
              sprite.layered === true ? JSON.stringify(sprite.activeLayers ?? []) : String(sprite.url ?? "");
            if (signature !== entry.signature) {
              entry.signature = signature;
              const images =
                sprite.layered === true
                  ? (sprite.activeLayers ?? []).map((layerEntry) => addImage(sprite, layerEntry))
                  : [addImage(sprite, undefined)];
              node.replaceChildren(...images);
            }
          }
          for (const [tag, entry] of nodes) {
            if (wanted.has(tag)) continue;
            entry.node.remove();
            nodes.delete(tag);
          }
        };

        // The shell swaps the conversation body when a session or a panel
        // changes; there is no event for that. Watching the document for child
        // changes would be too hot to re-query the body on every token, so the
        // callback only reacts when OUR host (or the layer inside it) has gone
        // away — two `isConnected` reads, no selectors. The store subscription
        // then handles the ordinary state changes.
        const observer =
          typeof MutationObserver === "function" && document.documentElement !== undefined
            ? new MutationObserver(() => {
                if (host === undefined || !host.isConnected || !layer.isConnected) attach();
              })
            : undefined;
        if (observer !== undefined) observer.observe(document.documentElement, { childList: true, subtree: true });
        const unsubscribe = store.subscribe(sync);
        sync();
        return () => {
          if (observer !== undefined) observer.disconnect();
          unsubscribe();
          layer.remove();
        };
      }, "dsh-renpy-skin: stage layer");
    }

    /**
     * The extra pieces of the game's say screen, drawn over the composer.
     *
     * The plate itself is painted by CSS on the composer, and CSS cannot add
     * children to a host element. So this is a second `shell.overlay` layer,
     * measured onto the composer's box: the box moves when the window resizes,
     * when the transcript pane opens and while the answer grows, and a layer
     * pinned once would drift off the plate. Positions are canvas pixels turned
     * into the same `cqw` unit the plate rules use, so the pieces keep the
     * game's proportions and survive a resize without re-rendering.
     *
     * Only the actions the client can actually perform become live buttons; a
     * node with an action outside the whitelist is drawn disabled rather than
     * pretending to work.
     */
    const MODULE_FIT = { stretch: "fill", contain: "contain", cover: "cover", none: "none" };
    const MODULE_ACTIONS = new Set(["settings", "music", "memory", "hide", "skip"]);

    function ModulesLayer() {
      const state = useStore(store);
      const settings = state.settings ?? {};
      const manifest = state.manifest;
      const modules = Array.isArray(manifest?.dialogbox?.modules) ? manifest.dialogbox.modules : [];
      const usable =
        settings.enabled !== false &&
        settings.dialogbox !== false &&
        settings.dialogboxModules !== false &&
        settings.hideComposer !== true &&
        modules.length > 0 &&
        manifest?.dialogbox !== undefined;
      const geometry = usable
        ? composerGeometry(manifest.dialogbox, manifest.layout, manifest.game?.screen?.w, manifest.game?.screen?.h)
        : undefined;
      const selector = geometry?.cq === undefined ? undefined : geometry.root;
      const [frame, setFrame] = useState(undefined);
      const [hovered, setHovered] = useState(undefined);

      useEffect(() => {
        if (selector === undefined) {
          setFrame(undefined);
          return undefined;
        }
        let alive = true;
        let last = "";
        const measure = () => {
          const node = document.querySelector(selector);
          const rect = node === null ? undefined : node.getBoundingClientRect();
          const key = rect === undefined ? "" : `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
          if (key === last) return;
          last = key;
          if (alive) setFrame(rect === undefined ? undefined : { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
        };
        measure();
        // The box also moves without a window event: opening the transcript pane
        // or a growing answer re-lays the composer out. A slow poll is enough —
        // it reads a rect and only touches state when a rounded value changed.
        const timer = setInterval(measure, 400);
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener("resize", measure);
          window.removeEventListener("scroll", measure, true);
        };
      }, [selector]);

      if (selector === undefined || frame === undefined) return null;
      const { cq, boxLeft, boxTop } = geometry;
      const ordered = modules
        .filter((module) => module !== null && typeof module === "object" && module.visible !== false && module.rect !== undefined)
        .sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
      if (ordered.length === 0) return null;

      const perform = (name) => {
        if (name === "settings" || name === "music" || name === "memory") uiStore.set({ panel: name });
        // `hide` and `skip` are the client's own stand-ins: Ren'Py's Hide hides
        // the say box until the next line and Skip fast-forwards it, and neither
        // has an equivalent here. They toggle the nearest switch instead, and
        // say so by staying switches — pressing again brings the box back.
        else if (name === "hide") void saveSettings({ dialogbox: settings.dialogbox === false });
        else if (name === "skip") void saveSettings({ textAnimation: settings.textAnimation === false });
      };

      const rectStyle = (module) => ({
        position: "absolute",
        left: cq(module.rect.x - boxLeft),
        top: cq(module.rect.y - boxTop),
        width: cq(module.rect.w),
        height: cq(module.rect.h),
        zIndex: typeof module.z === "number" ? module.z : 0,
        pointerEvents: "none",
        ...(typeof module.opacity === "number" ? { opacity: module.opacity } : {}),
      });

      const renderModule = (module, key) => {
        const base = rectStyle(module);
        const radius = typeof module.radius === "number" ? cq(module.radius) : undefined;
        const border = module.border === undefined
          ? {}
          : { borderStyle: "solid", borderWidth: cq(module.border.width ?? 1), borderColor: module.border.color ?? "transparent" };
        const size = cq(typeof module.size === "number" ? module.size : 33);

        if (module.kind === "image") {
          if (typeof module.imageUrl !== "string" || module.imageUrl.length === 0) return null;
          return h(
            "div",
            { key, "data-renpy-module": "image", style: { ...base, ...border } },
            h("img", {
              src: module.imageUrl,
              alt: "",
              draggable: false,
              style: { width: "100%", height: "100%", objectFit: MODULE_FIT[module.fit] ?? "fill", borderRadius: radius, display: "block" },
            }),
          );
        }
        if (module.kind === "box") {
          return h("div", {
            key,
            "data-renpy-module": "box",
            style: { ...base, ...border, backgroundColor: module.color ?? "transparent", borderRadius: radius },
          });
        }
        if (module.kind === "bar") {
          const value = typeof module.value === "number" ? Math.max(0, Math.min(1, module.value)) : 0;
          return h(
            "div",
            { key, "data-renpy-module": "bar", style: { ...base, ...border, backgroundColor: module.trackColor ?? "transparent", borderRadius: radius, overflow: "hidden" } },
            h("div", { style: { width: `${value * 100}%`, height: "100%", backgroundColor: module.color ?? "#ffffff" } }),
          );
        }
        if (module.kind === "text") {
          return h("div", {
            key,
            "data-renpy-module": "text",
            style: {
              ...base,
              color: module.textColor ?? module.color,
              fontSize: size,
              lineHeight: 1.3,
              display: "flex",
              alignItems: module.valign === "top" ? "flex-start" : module.valign === "bottom" ? "flex-end" : "center",
              justifyContent: module.align === "right" ? "flex-end" : module.align === "center" ? "center" : "flex-start",
              textAlign: module.align ?? "left",
              whiteSpace: "pre-wrap",
              overflow: "hidden",
            },
          }, module.text ?? "");
        }
        const known = typeof module.action === "string" && MODULE_ACTIONS.has(module.action);
        const hover = module.hover ?? {};
        const active = hovered === key;
        const art = active && typeof hover.imageUrl === "string" && hover.imageUrl.length > 0 ? hover.imageUrl : module.imageUrl;
        return h(
          "button",
          {
            key,
            type: "button",
            disabled: !known,
            "data-renpy-module": "button",
            "data-renpy-action": module.action,
            onClick: known ? () => perform(module.action) : undefined,
            onMouseEnter: () => setHovered(key),
            onMouseLeave: () => setHovered(undefined),
            onFocus: () => setHovered(key),
            onBlur: () => setHovered(undefined),
            style: {
              ...base,
              ...border,
              borderRadius: radius,
              pointerEvents: known ? "auto" : "none",
              cursor: known ? "pointer" : "default",
              backgroundColor: active && typeof hover.color === "string" ? hover.color : module.color ?? "transparent",
              color: module.textColor ?? "#ffffff",
              fontFamily: "inherit",
              fontSize: size,
              padding: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              whiteSpace: "nowrap",
            },
          },
          typeof art === "string" && art.length > 0
            ? h("img", { src: art, alt: "", draggable: false, style: { width: "100%", height: "100%", objectFit: "fill", borderRadius: radius, display: "block" } })
            : module.text ?? "",
        );
      };

      return h(
        "div",
        {
          className: "rsk-layer rsk-modules",
          "data-renpy-skin": "modules",
          style: {
            position: "fixed",
            inset: "auto",
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
            overflow: "visible",
            containerType: "inline-size",
          },
        },
        ordered.map((module, index) => renderModule(module, `${index}:${module.kind}:${module.rect.x}:${module.rect.y}`)),
      );
    }

    // ── settings page ──────────────────────────────────────────────────────
    /** A labelled switch row built on DSH's `Switch` primitive. */
    function SwitchRow({ label, hint, checked, onChange }) {
      return h(
        "div",
        { className: "rsk-ctl" },
        h(
          "div",
          { className: "rsk-ctl-text" },
          h("div", { className: "rsk-ctl-label" }, label),
          hint === undefined ? null : h("div", { className: "rsk-ctl-hint" }, hint),
        ),
        h(P.Switch, { checked: checked === true, onChange, label }),
      );
    }

    /**
     * A free-text setting row whose draft is local and commits on blur/Enter.
     *
     * `onCommit` is a settings POST, so committing on every keystroke would send
     * one write per letter and let the echo fight the caret. The draft follows
     * the stored value when something else changes it (a poll, the popover, a
     * second surface) but never while the field has focus.
     */
    function TextRow({ label, hint, value, placeholder, onCommit, multiline = false, rows = 4, maxLength }) {
      const stored = typeof value === "string" ? value : "";
      const [draft, setDraft] = useState(stored);
      const typing = useRef(false);
      useEffect(() => {
        if (typing.current !== true) setDraft(stored);
      }, [stored]);
      const commit = () => {
        typing.current = false;
        const next = draft.trim();
        if (next !== stored) onCommit(next);
        else setDraft(stored);
      };
      const shared = {
        className: "rsk-input",
        value: draft,
        placeholder,
        onChange: (event) => {
          typing.current = true;
          setDraft(event.target.value);
        },
      };
      const control = multiline
        ? h("textarea", { ...shared, rows, onBlur: commit })
        : h("input", {
            ...shared,
            type: "text",
            maxLength,
            onBlur: commit,
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            },
          });
      return h(
        "div",
        { className: multiline ? "rsk-field" : "rsk-ctl" },
        h(
          "div",
          { className: "rsk-ctl-text" },
          h("div", { className: "rsk-ctl-label" }, label),
          hint === undefined ? null : h("div", { className: "rsk-ctl-hint" }, hint),
        ),
        control,
      );
    }

    /** Source of the range inputs' `id`/`htmlFor` pair. */
    let rangeSeq = 0;

    /**
     * A labelled range row that reports its value.
     *
     * The value changes on every `input`, so the number under the thumb is
     * never behind the gesture; the SAVED value is committed once the gesture
     * ends. `onChange` ends in a POST, and calling it from every `input` event
     * made a single drag fire dozens of round-trips and visibly stutter.
     *
     * A row may also pass `onPreview`, which is the same split applied to the
     * setting's EFFECT: it runs on every step (cheap ones only — a background
     * repaint, a volume assignment, a number an effect already reads) so the
     * result is visible while dragging. It must not save. Leave it out for an
     * effect that cannot keep up with a drag — the seek bar would re-cue the
     * audio dozens of times a second — and the effect then lands with the save,
     * on release, exactly as before.
     *
     * A preview writes the same store this row reads, so by the time the
     * gesture ends `value` is the DRAFT and comparing against it would call
     * every gesture unchanged and skip its save. The comparison is therefore
     * against the value the gesture started from, captured on its first step.
     */
    function SliderRow({ label, value, min, max, step, onChange, format, onPreview }) {
      const [draft, setDraft] = useState(value);
      const dragging = useRef(false);
      const inputRef = useRef(undefined);
      // The persisted value this gesture started from (see the note above);
      // `undefined` when nothing has been previewed yet.
      const baseRef = useRef(undefined);
      // `commit` has to survive into the window listener below without being
      // rebuilt, so the live callback pair lives in a ref.
      const latest = useRef({ value, onChange, onPreview });
      latest.current = { value, onChange, onPreview };
      // Not `useId`: the module must keep working on whatever React the host
      // seeds, and a module counter has no version floor.
      const idRef = useRef(undefined);
      if (idRef.current === undefined) idRef.current = `rsk-range-${(rangeSeq += 1)}`;

      // Follow the persisted value unless the user is mid-gesture, otherwise a
      // poll that echoes an older value would fight the drag.
      useEffect(() => {
        if (dragging.current !== true) setDraft(value);
      }, [value]);

      const commit = (next) => {
        const base = baseRef.current;
        baseRef.current = undefined;
        // A gesture that ends where it started has nothing to persist. It also
        // has no POST coming to clear the preview, and a preview left set makes
        // `pollStage` skip the settings echo for good — so drop it here.
        if (base === undefined || next === base) {
          endPreview();
          return;
        }
        latest.current.onChange(next);
      };

      // The gesture can end OUTSIDE the input: the pointer is released over the
      // panel, or the drag is cancelled (Escape). `pointerup` then never fires
      // on the element, and the row used to stay latched in `dragging` forever
      // — the effect above stopped echoing the persisted value AND the edit was
      // never saved, so the row displayed a value the host did not have. A
      // capture-phase window listener, which sees every release, is the fix.
      useEffect(() => {
        const finish = () => {
          if (dragging.current !== true) return;
          dragging.current = false;
          const element = inputRef.current;
          if (element !== undefined) commit(Number(element.value));
        };
        window.addEventListener("pointerup", finish, true);
        window.addEventListener("pointercancel", finish, true);
        return () => {
          window.removeEventListener("pointerup", finish, true);
          window.removeEventListener("pointercancel", finish, true);
          // A drag whose row unmounts (the panel closed under the pointer) never
          // reaches `finish`, so its preview would outlive the gesture and gag
          // the settings echo. The edit is discarded — which is what closing the
          // panel mid-drag means.
          if (dragging.current === true) {
            dragging.current = false;
            endPreview();
          }
        };
      }, []);

      const shown = format === undefined ? String(draft) : format(draft);
      return h(
        "div",
        { className: "rsk-ctl" },
        h("label", { className: "rsk-ctl-label", htmlFor: idRef.current }, label),
        h(
          "div",
          { className: "rsk-ctl-side", style: { flex: "0 0 52%" } },
          h("input", {
            id: idRef.current,
            ref: inputRef,
            type: "range",
            style: { flex: 1 },
            min,
            max,
            step,
            value: draft,
            // A range input with no accessible name is announced as a bare
            // number, so the visible label is exposed here too.
            "aria-label": label,
            "aria-valuetext": shown,
            onChange: (e) => {
              const next = Number(e.target.value);
              // First step of a gesture: whatever the row shows now is still
              // the persisted value, which is what `commit` must compare to.
              if (baseRef.current === undefined) baseRef.current = latest.current.value;
              setDraft(next);
              // The effect, live; the save still waits for the release.
              const preview = latest.current.onPreview;
              if (preview !== undefined) preview(next);
            },
            onPointerDown: () => {
              dragging.current = true;
            },
            onKeyUp: (e) => commit(Number(e.currentTarget.value)),
            onBlur: (e) => commit(Number(e.currentTarget.value)),
          }),
          h("span", { className: "rsk-stat rsk-nowrap" }, shown),
        ),
      );
    }

    /**
     * The skin's own language switch. `auto` follows the host locale (and its
     * browser fallback); `zh`/`en` force the labels independent of the host, so
     * the settings page never silently sits in the "wrong" language.
     */
    function LanguageRow({ value, onChange }) {
      const current = value ?? "auto";
      const options = [
        { value: "auto", label: t("Auto") },
        { value: "zh", label: "中文" },
        { value: "en", label: "English" },
      ];
      return h(
        "div",
        { className: "rsk-ctl" },
        h(
          "div",
          { className: "rsk-ctl-text" },
          h("div", { className: "rsk-ctl-label" }, t("Language")),
          h("div", { className: "rsk-ctl-hint" }, t("Force the skin's own labels to Chinese or English, or follow the host locale.")),
        ),
        h(P.SegmentedControl, {
          value: current,
          options,
          onChange,
          label: t("Language"),
        }),
      );
    }

    /** A titled, hairline-divided section (wallpaper-engine's grouping pattern). */
    function Section({ title, children }) {
      return h(
        "div",
        { className: "rsk-section" },
        h("div", { className: "rsk-section-head" }, h("span", { className: "rsk-section-label" }, title)),
        children,
      );
    }

    /**
     * The layout editor: drag the components the manifest describes (and the
     * canonical name box / dialogue / side image rows) over a scaled preview of
     * the game's design canvas. Coordinates are stored as fractions of that
     * canvas — never pixels — so a resized window cannot drift the layout.
     */
    /**
     * Display names for the layout components.
     *
     * The ids are internal (`sideImage`, `hud`) and were previously rendered
     * verbatim into a Chinese UI, so the user had to read identifiers to know
     * what they were moving. The map is exhaustive over `defaultLayout`'s keys,
     * which is also what the editor enumerates.
     */
    const LAYOUT_LABELS = {
      textbox: "Text box",
      namebox: "Name box",
      dialogue: "Dialogue",
      sideImage: "Side image",
      hud: "HUD",
    };

    const layoutLabel = (id) => t(LAYOUT_LABELS[id] ?? id);

    function LayoutEditor({ manifest, settings }) {
      const profileKey = manifest?.game?.name ?? "default";
      const initial =
        settings?.layoutProfiles?.[profileKey] ??
        defaultLayout(manifest);
      const [layout, setLayout] = useState(initial);
      const [selected, setSelected] = useState("namebox");
      const drag = useRef(null);
      const gridRef = useRef(null);
      // The reset button is destructive and undoable only by hand, so it needs
      // a second click rather than an accidental one.
      const [confirmReset, setConfirmReset] = useState(false);
      const [notice, setNotice] = useState(undefined);

      useEffect(() => {
        setLayout(settings?.layoutProfiles?.[profileKey] ?? defaultLayout(manifest));
      }, [profileKey, manifest]);

      // Any edit after the first reset click means the user moved on; a stale
      // "click again" state would turn a later click into an unexpected reset.
      useEffect(() => {
        setConfirmReset(false);
      }, [layout]);

      const design = manifest?.game?.screen ?? { w: 1920, h: 1080 };
      const components = Object.keys(layout);
      const hasSavedLayout = settings?.layoutProfiles?.[profileKey] !== undefined;

      /** Design-space delta from a pointer event. */
      const deltaFromPointer = (event, origin) => {
        const rect = gridRef.current?.getBoundingClientRect();
        if (rect === undefined || rect === null) return { dx: 0, dy: 0 };
        return {
          dx: (event.clientX - origin.x) / rect.width,
          dy: (event.clientY - origin.y) / rect.height,
        };
      };

      const onPointerDown = (id, event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const entry = layout[id];
        drag.current = { id, startX: event.clientX, startY: event.clientY, x: entry.x, y: entry.y };
        setSelected(id);
        event.preventDefault();
      };

      const onPointerMove = (event) => {
        const active = drag.current;
        if (active === null) return;
        const { dx, dy } = deltaFromPointer(event, { x: active.startX, y: active.startY });
        setLayout((current) => ({
          ...current,
          [active.id]: {
            ...current[active.id],
            // Negative and out-of-box positions are legal: Ren'Py's own GUI
            // puts the name box above the text box with `name_ypos = -22`.
            x: round3(active.x + dx),
            y: round3(active.y + dy),
          },
        }));
      };

      const onPointerUp = () => {
        drag.current = null;
      };

      const editField = (id, key, value) => {
        const number = Number(value);
        if (!Number.isFinite(number)) return;
        setLayout((current) => ({ ...current, [id]: { ...current[id], [key]: number } }));
      };

      const persist = async () => {
        setConfirmReset(false);
        await saveSettings({
          layoutProfiles: { ...(settings?.layoutProfiles ?? {}), [profileKey]: layout },
        });
        const safeArea = Object.entries(layout)
          .filter(([, entry]) => entry.visible !== false)
          .map(([id, entry]) => ({
            id,
            x: entry.x,
            y: entry.y,
            w: entry.w,
            h: entry.h,
            coversX: id === "namebox" || id === "dialogue" || id === "sideImage",
          }));
        await fetchJson(`${ROUTE}/layout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: currentSessionId(), vn: profileKey, profile: layout, safeArea }),
        });
        await refreshManifest();
      };

      const step = (id, key, amount) => {
        setLayout((current) => ({ ...current, [id]: { ...current[id], [key]: round3(current[id][key] + amount) } }));
      };

      const focused = layout[selected];

      return h(
        "div",
        { className: "rsk-card" },
        h("h4", null, t("Layout editor")),
        h(
          "div",
          { className: "rsk-hint" },
          t("Drag a component to move it, or edit the numbers. Values are fractions of the {wh} design canvas, so they survive a window resize. Negative values are allowed (Ren'Py itself places the name box above the text box).", { wh: `${design.w}x${design.h}` }),
        ),
        h(
          "div",
          {
            className: "rsk-grid",
            ref: gridRef,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
          },
          manifest?.backgrounds?.[0]?.url === undefined
            ? null
            : h("img", { className: "rsk-grid-bg", src: manifest.backgrounds[0].url, alt: "", draggable: false }),
          components.map((id) => {
            const entry = layout[id];
            return h(
              "div",
              {
                key: id,
                className: selected === id ? "rsk-box selected" : "rsk-box",
                style: {
                  left: `${entry.x * 100}%`,
                  top: `${entry.y * 100}%`,
                  width: `${entry.w * 100}%`,
                  height: `${entry.h * 100}%`,
                  display: entry.visible === false ? "none" : undefined,
                },
                onPointerDown: (event) => onPointerDown(id, event),
                title: layoutLabel(id),
              },
              layoutLabel(id),
            );
          }),
        ),
        h(
          "div",
          { className: "rsk-legend" },
          components.map((id) =>
            h(
              "button",
              {
                key: id,
                className: "rsk-btn",
                style: { opacity: layout[id].visible === false ? 0.5 : 1 },
                onClick: () => setSelected(id),
              },
              layoutLabel(id),
            ),
          ),
        ),
        focused === undefined
          ? null
          : h(
              "div",
              null,
              (
                [
                  ["x", "X"],
                  ["y", "Y"],
                  ["w", t("Width")],
                  ["h", t("Height")],
                ]
              ).map(([key, label]) =>
                h(
                  "div",
                  { className: "rsk-row", key },
                  h("label", null, `${layoutLabel(selected)} · ${label}`),
                  h(
                    "div",
                    { style: { display: "flex", gap: 6, alignItems: "center" } },
                    h("button", { className: "rsk-btn", onClick: () => step(selected, key, -0.01) }, "−"),
                    h("input", {
                      className: "rsk-input",
                      style: { width: 80 },
                      type: "number",
                      step: 0.01,
                      value: focused[key],
                      onChange: (event) => editField(selected, key, event.target.value),
                    }),
                    h("button", { className: "rsk-btn", onClick: () => step(selected, key, 0.01) }, "+"),
                  ),
                ),
              ),
              h(
                "div",
                { className: "rsk-row" },
                h("label", null, t("Visible")),
                h("input", {
                  type: "checkbox",
                  checked: focused.visible !== false,
                  onChange: (event) =>
                    setLayout((current) => ({
                      ...current,
                      [selected]: { ...current[selected], visible: event.target.checked },
                    })),
                }),
              ),
            ),
        h(
          "div",
          { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center" } },
          h(P.Button, { variant: "primary", size: "sm", onClick: persist }, t("Save layout")),
          h(
            P.Button,
            {
              variant: "outline",
              className: "rsk-action",
              size: "sm",
              // Two-step because the reset throws away hand-placed coordinates
              // and nothing here can undo it once the layout is saved.
              onClick: () => {
                if (confirmReset !== true) {
                  setConfirmReset(true);
                  setNotice(undefined);
                  return;
                }
                setConfirmReset(false);
                setLayout(defaultLayout(manifest));
                setNotice(t("Reset — press Save layout to keep it."));
              },
            },
            confirmReset === true ? t("Click again to confirm") : t("Reset to this game's original layout"),
          ),
          h(
            P.Button,
            {
              variant: "outline",
              className: "rsk-action",
              size: "sm",
              onClick: () => {
                setConfirmReset(false);
                void navigator.clipboard?.writeText(JSON.stringify(layout, null, 2));
                // Silence made the button feel broken, so it reports itself the
                // same way the import/export card does.
                setNotice(t("Copied"));
              },
            },
            t("Copy JSON"),
          ),
        ),
        confirmReset
          ? h(
              "div",
              { className: "rsk-confirm" },
              hasSavedLayout
                ? t(
                    "This game already has a saved layout. Clicking again restores the scanned positions; the saved layout is replaced only when you press Save layout.",
                  )
                : t("Clicking again discards the unsaved positions and restores the scanned layout."),
            )
          : null,
        notice === undefined
          ? null
          : h("div", { className: "rsk-hint", style: { marginTop: 6 } }, notice),
      );
    }

    /** Round to three decimals so stored coordinates stay readable. */
    function round3(value) {
      return Math.round(value * 1000) / 1000;
    }
    /**
     * The starting layout, read from the game's own GUI variables (which is
     * why it is regenerated from the manifest rather than hard-coded). Values
     * are fractions of the design canvas.
     */
    function defaultLayout(manifest) {
      const layout = manifest?.layout ?? {};
      const design = manifest?.game?.screen ?? { w: 1920, h: 1080 };
      const boxHeight = (layout.textboxHeight ?? 278) / design.h;
      const boxTop = layout.textboxYalign === 0 ? 0 : layout.textboxYalign === 0.5 ? (1 - boxHeight) / 2 : 1 - boxHeight;
      return {
        textbox: { x: 0, y: round3(boxTop), w: 1, h: round3(boxHeight), visible: true },
        namebox: {
          x: round3((layout.nameXpos ?? 0) / design.w),
          y: round3(boxTop + (layout.nameYpos ?? 15) / design.h),
          w: round3((layout.nameboxWidth ?? 400) / design.w),
          h: round3((layout.nameboxHeight ?? 70) / design.h),
          visible: true,
        },
        dialogue: {
          x: round3((layout.dialogueXpos ?? 0) / design.w),
          y: round3(boxTop + (layout.dialogueYpos ?? 75) / design.h),
          w: round3((layout.dialogueWidth ?? design.w) / design.w),
          h: round3(0.18),
          visible: true,
        },
        sideImage: { x: 0.02, y: round3(boxTop - 0.32), w: 0.16, h: 0.32, visible: true },
        hud: { x: 0.86, y: round3(boxTop + 0.02), w: 0.12, h: 0.06, visible: false },
      };
    }

    /** Import / export the whole skin config as one JSON object. */
    function ImportExport() {
      const [text, setText] = useState("");
      const [notice, setNotice] = useState(undefined);
      const [busy, setBusy] = useState(false);
      // The paste box is the fallback, not the primary path: a config is a file,
      // and it used to be reachable only by copying JSON through the clipboard.
      const [advanced, setAdvanced] = useState(false);
      const fileRef = useRef(null);

      const applyConfig = async (config) => {
        await importConfig(config);
        await refreshManifest();
        setNotice(t("Done"));
      };

      /**
       * Download the exported config as a real file.
       *
       * A blob URL plus a synthetic click needs no dependency and no host
       * route, and it is the only way a browser page can save a file.
       */
      const doExport = async () => {
        setBusy(true);
        setNotice(undefined);
        try {
          const config = await exportConfig();
          const json = JSON.stringify(config, null, 2);
          setText(json);
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = "renpy-skin-config.json";
          document.body.appendChild(link);
          link.click();
          link.remove();
          // Revoked on the next tick: revoking synchronously can cancel the
          // download in some browsers before it has read the blob.
          window.setTimeout(() => URL.revokeObjectURL(url), 0);
          setNotice(t("Exported renpy-skin-config.json"));
        } catch (error) {
          setNotice(`${t("Export failed")}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBusy(false);
        }
      };

      const readFile = async (file) => {
        if (file === undefined) return;
        setBusy(true);
        setNotice(undefined);
        try {
          const content = await file.text();
          setText(content);
          await applyConfig(JSON.parse(content));
        } catch (error) {
          setNotice(`${t("Import file read failed")}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBusy(false);
          // Cleared so re-picking the SAME file fires `change` again.
          if (fileRef.current !== null) fileRef.current.value = "";
        }
      };

      const doImport = async () => {
        setBusy(true);
        setNotice(undefined);
        try {
          await applyConfig(JSON.parse(text));
        } catch (error) {
          setNotice(`${t("Import failed")}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBusy(false);
        }
      };

      return h(
        "div",
        { className: "rsk-card" },
        h("h4", null, t("Import / export")),
        h("div", { className: "rsk-hint" }, t("Export the current skin as JSON so you can reload it later or move it to another machine.")),
        h(
          "div",
          { style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" } },
          h(P.Button, { variant: "primary", size: "sm", disabled: busy, onClick: doExport }, t("Export")),
          h(
            P.Button,
            { variant: "outline", className: "rsk-action", size: "sm", disabled: busy, onClick: () => fileRef.current?.click() },
            t("Import from a file"),
          ),
          h("input", {
            ref: fileRef,
            type: "file",
            accept: "application/json,.json",
            style: { display: "none" },
            onChange: (event) => void readFile(event.target.files?.[0]),
          }),
        ),
        h(
          "button",
          {
            type: "button",
            className: "rsk-panel-link",
            style: { marginTop: 10 },
            onClick: () => setAdvanced((current) => !current),
          },
          advanced ? t("Hide the paste box") : t("Advanced: paste JSON"),
        ),
        advanced === false
          ? null
          : h(
              "div",
              null,
              h(
                "div",
                { className: "rsk-hint", style: { marginTop: 6 } },
                t("Paste a previously exported config. A gameDir inside it is applied immediately."),
              ),
              h("textarea", {
                className: "rsk-input",
                style: { width: "100%", minHeight: 120, fontFamily: "monospace", fontSize: 12, marginTop: 8 },
                placeholder: "{ ... }",
                value: text,
                onChange: (event) => setText(event.target.value),
                spellCheck: false,
              }),
              h(
                "div",
                { style: { display: "flex", gap: 8, marginTop: 8 } },
                h(P.Button, { variant: "outline", className: "rsk-action", size: "sm", disabled: busy, onClick: doImport }, t("Import")),
              ),
            ),
        notice === undefined ? null : h("div", { className: "rsk-hint", style: { marginTop: 8, color: "var(--dsw-alias-label-primary)" } }, notice),
      );
    }

    /**
     * The cast the user wants available in this conversation.
     *
     * Unticking everything would leave a stage with no cast, so an EMPTY
     * selection is defined as "every character" (and is what a fresh install
     * has): the list only ever narrows the roster the model is offered and the
     * `show` calls it may make.
     */
    function CharacterPicker({ manifest, settings, onChange }) {
      const enabled = Array.isArray(settings.enabledCharacters) ? settings.enabledCharacters : [];
      const allOn = enabled.length === 0;
      const isOn = (tag) => allOn || enabled.includes(tag);
      const toggle = (tag) => {
        const next = allOn
          ? manifest.tags.map((entry) => entry.tag).filter((entry) => entry !== tag)
          : enabled.includes(tag)
            ? enabled.filter((entry) => entry !== tag)
            : [...enabled, tag];
        onChange({ enabledCharacters: next });
      };
      if (manifest.tags.length === 0) {
        return h(
          "div",
          { className: "rsk-card" },
          h("h4", null, t("Characters")),
          h("div", { className: "rsk-hint" }, t("This game declares no character sprites.")),
        );
      }
      return h(
        "div",
        { className: "rsk-card" },
        h("h4", null, t("Characters")),
        h(
          "div",
          { className: "rsk-card-sub rsk-hint" },
          t("Tick the characters this conversation may show. Leave every box unticked to allow the whole cast."),
        ),
        h(
          "div",
          { className: "rsk-row", style: { borderBottom: "1px solid var(--dsw-alias-border-l1)", paddingBottom: 10 } },
          h("label", { className: "rsk-row-label" }, allOn ? t("All characters are enabled.") : t("{count} of {total} characters enabled.", { count: enabled.filter((tag) => manifest.tags.some((entry) => entry.tag === tag)).length, total: manifest.tags.length })),
          h(
            "div",
            { className: "rsk-row-control" },
            h(P.Button, { variant: "outline", className: "rsk-action", size: "sm", disabled: allOn, onClick: () => onChange({ enabledCharacters: [] }) }, t("Enable all")),
          ),
        ),
        manifest.tags.map((tag) =>
          h(
            "div",
            { key: tag.tag, className: "rsk-row" },
            h(
              "div",
              { className: "rsk-row-label" },
              h("div", { className: "rsk-ctl-label" }, tag.tag),
              h(
                "div",
                { className: "rsk-stat", title: tag.expressions.map((e) => e.label).join(" / ") },
                t("{shown} of {total} expressions: {list}", {
                  shown: tag.expressions.length,
                  total: tag.total ?? tag.expressions.length,
                  list: tag.expressions.slice(0, 6).map((e) => e.label).join(" / "),
                }),
              ),
            ),
            h(
              "div",
              { className: "rsk-row-control" },
              // `Checkbox` renders its own `<label>` wrapper, so the tag name is
              // passed as its label rather than nested in a second one.
              h(P.Checkbox, { checked: isOn(tag.tag), onChange: () => toggle(tag.tag), label: tag.tag }),
            ),
          ),
        ),
      );
    }

    /**
     * The memory editor, shared by the settings page and the header panel.
     *
     * It writes through the same `/memory` route the model's `renpy_memory`
     * tool uses, so a note typed here and a note the model records land in one
     * file. The character list comes from the manifest: a tag the game does not
     * declare has nothing to attach a memory to.
     */
    function MemoryEditor({ manifest, compact = false }) {
      const [characters, setCharacters] = useState(undefined);
      const [tag, setTag] = useState("");
      const [draft, setDraft] = useState("");
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(undefined);
      const tags = manifest?.tags ?? [];
      const session = currentSessionId();
      const textOf = (list, name) => list.find((entry) => entry.tag === name)?.text ?? "";

      /**
       * Adopt a fresh list and pick the character to show.
       *
       * The draft is set here rather than derived from `characters`, because a
       * refetch (a manifest rebuild, another surface's write) must not wipe what
       * the user is typing.
       */
      const applyList = (list, keep) => {
        const next =
          keep !== undefined && list.some((entry) => entry.tag === keep)
            ? keep
            : (list.find((entry) => entry.chars > 0)?.tag ?? list[0]?.tag ?? "");
        setCharacters(list);
        setTag(next);
        setDraft(textOf(list, next));
      };

      useEffect(() => {
        let alive = true;
        void fetchJson(`${ROUTE}/memory?session=${encodeURIComponent(session)}`)
          .then((data) => {
            if (alive) applyList(Array.isArray(data.characters) ? data.characters : []);
          })
          .catch(() => {
            if (alive) applyList([]);
          });
        return () => {
          alive = false;
        };
        // `manifest` is a dependency so a game switch re-reads the right file.
      }, [session, manifest]);

      const select = (next) => {
        setTag(next);
        setDraft(textOf(characters ?? [], next));
        setNotice(undefined);
      };

      const write = (mode) => {
        if (tag === "") return;
        setBusy(true);
        setNotice(undefined);
        void fetchJson(`${ROUTE}/memory`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session, tag, text: draft, mode }),
        })
          .then((data) => {
            if (data.ok !== true) throw new Error(data.error ?? "the host refused the write");
            const list = Array.isArray(data.characters) ? data.characters : [];
            applyList(list, tag);
            setNotice(
              data.trimmed === true
                ? t("Saved. The oldest lines were dropped to stay within the limit.")
                : t(mode === "append" ? "Appended to {tag}." : "Saved {tag}.", { tag }),
            );
          })
          .catch((error) => {
            setNotice(t("Could not save: {reason}", { reason: error instanceof Error ? error.message : String(error) }));
          })
          .then(() => setBusy(false));
      };

      if (tags.length === 0) {
        return h("div", { className: "rsk-hint" }, t("Load a game to keep memories of its characters."));
      }
      const selected = characters?.find((entry) => entry.tag === tag);
      return h(
        "div",
        { className: "rsk-field" },
        h(
          "div",
          { className: "rsk-ctl-text" },
          h("div", { className: "rsk-ctl-label" }, t("Memory")),
          h(
            "div",
            { className: "rsk-ctl-hint" },
            t("One file per character, kept across conversations. The 「在场」 preset reads it every turn; the model appends through `renpy_memory`."),
          ),
        ),
        h(
          "select",
          { className: "rsk-input", value: tag, onChange: (event) => select(event.target.value) },
          tags.map((entry) => {
            const count = characters?.find((item) => item.tag === entry.tag)?.chars ?? 0;
            return h("option", { key: entry.tag, value: entry.tag }, count > 0 ? `${entry.tag} · ${count}` : entry.tag);
          }),
        ),
        h("textarea", {
          className: "rsk-input",
          rows: compact ? 5 : 8,
          value: draft,
          placeholder: t("What should {tag} remember?", { tag: tag === "" ? t("the character") : tag }),
          onChange: (event) => setDraft(event.target.value),
        }),
        h(
          "div",
          { className: "rsk-field-actions" },
          h(
            P.Button,
            { variant: "outline", className: "rsk-action", size: "sm", disabled: busy || tag === "", onClick: () => write("replace") },
            t("Save"),
          ),
          h(
            P.Button,
            { variant: "outline", className: "rsk-action", size: "sm", disabled: busy || tag === "" || draft.trim() === "", onClick: () => write("append") },
            t("Remember this"),
          ),
          selected !== undefined && selected.chars > 0
            ? h("span", { className: "rsk-stat" }, t("{count} characters stored.", { count: selected.chars }))
            : null,
        ),
        notice === undefined ? null : h("div", { className: "rsk-hint" }, notice),
      );
    }

    /**
     * The 「在场」 roleplay surface: who the user is, what the scene should
     * additionally honour, and the memories carried between conversations.
     *
     * The name and the extra directions only reach a session running the 「在场」
     * preset — the host injects them through that preset's prompt section — so
     * the hint says which preset to pick instead of letting a user set a name
     * nothing reads.
     */
    function RoleplaySection({ manifest, settings, set }) {
      const session = currentSessionId();
      const names = settings.sessionNames !== null && typeof settings.sessionNames === "object" ? settings.sessionNames : {};
      const override = typeof names[session] === "string" ? names[session] : "";
      return h(
        "div",
        { className: "rsk-card" },
        h("h4", null, t("Roleplay 「在场」")),
        h(
          "div",
          { className: "rsk-card-sub rsk-hint" },
          t("These reach a conversation running the 「在场」 agent preset; pick it in the composer when you start one."),
        ),
        h(TextRow, {
          label: t("Your name in the scene"),
          hint: t("How the characters address you."),
          value: settings.playerName ?? "",
          placeholder: t("unnamed"),
          maxLength: 60,
          onCommit: (value) => set({ playerName: value }),
        }),
        h(TextRow, {
          label: t("Name for this conversation"),
          hint: t("Overrides the name above in this session only. Clear it to fall back."),
          value: override,
          placeholder: settings.playerName === "" ? t("unnamed") : settings.playerName,
          maxLength: 60,
          onCommit: (value) => set({ sessionNames: { ...names, [session]: value } }),
        }),
        h(TextRow, {
          label: t("Extra directions"),
          hint: t("Added to the 「在场」 prompt for every session: tone, boundaries, what to avoid."),
          value: settings.roleplayPrompt ?? "",
          multiline: true,
          onCommit: (value) => set({ roleplayPrompt: value }),
        }),
        h(MemoryEditor, { manifest, compact: true }),
      );
    }

    /**
     * Which of the game's dialogue plates the composer paints.
     *
     * A game ships the template's `gui/textbox.png` and often a second one — a
     * reworked `newgui/say/` set, a route-specific box. The scan collects them
     * (`dialogbox.candidates`) and this is where a person picks one; the choice
     * goes into the GAME's profile through `POST /dialogbox`, the same file the
     * agent writes with `renpy_save_vn`, so the two halves cannot disagree and a
     * game switch brings its own plate back.
     *
     * The picker is shown only when there is something to pick: one plate is
     * not a choice, and a card that lists a single option reads as a bug.
     */
    function PlatePicker({ manifest }) {
      const [picking, setPicking] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(undefined);
      const dialogbox = manifest?.dialogbox ?? {};
      const candidates = Array.isArray(dialogbox.candidates) ? dialogbox.candidates : [];
      const current = typeof dialogbox.textboxPath === "string" ? dialogbox.textboxPath : "";
      if (candidates.length < 2) return null;
      const chosen = candidates.find((entry) => entry.path === current);

      const pick = async (path) => {
        setBusy(true);
        setError(undefined);
        try {
          const reply = await fetchJson(`${ROUTE}/dialogbox`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: currentSessionId(), path }),
          });
          if (reply.ok !== true) {
            setError(reply.error ?? "cannot switch the dialogue box");
            return;
          }
          // The host rebuilt the manifest around the new plate, so the whole
          // store is replaced rather than patched: the URL, the geometry and the
          // candidate order all moved together.
          store.set({
            manifest: reply.manifest,
            settings: reply.settings ?? store.get().settings,
            library: Array.isArray(reply.library) ? reply.library : store.get().library,
          });
          setPicking(false);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      return h(
        "div",
        { className: "rsk-card" },
        h("h4", null, t("Dialogue box art")),
        h(
          "div",
          { className: "rsk-card-sub rsk-hint" },
          t("This game ships {count} say-box plates. The choice is saved for this game only.", { count: candidates.length }),
        ),
        h(
          "div",
          { className: "rsk-plate-head" },
          chosen === undefined ? null : h("img", { src: chosen.url, alt: "", draggable: false }),
          h(
            "div",
            { className: "rsk-ctl-text" },
            h("div", { className: "rsk-ctl-label" }, current === "" ? t("Unknown plate") : current),
            h("div", { className: "rsk-ctl-hint" }, t("Used by the composer and the user's own messages.")),
          ),
          h(
            P.Button,
            { variant: "outline", className: "rsk-action", size: "sm", onClick: () => { setError(undefined); setPicking(true); } },
            t("Choose…"),
          ),
        ),
        error === undefined ? null : h("div", { className: "rsk-hint", style: { color: "var(--dsw-alias-state-error-primary)" } }, error),
        picking
          ? h(
              "div",
              {
                className: "rsk-modal",
                onClick: (event) => {
                  if (event.target === event.currentTarget) setPicking(false);
                },
                onKeyDown: (event) => {
                  if (event.key === "Escape") setPicking(false);
                },
              },
              h(
                PanelShell,
                { title: t("Choose the dialogue box"), onClose: () => setPicking(false) },
                h(
                  "div",
                  { className: "rsk-plates" },
                  candidates.map((entry) =>
                    h(
                      "button",
                      {
                        key: entry.path,
                        type: "button",
                        className: "rsk-plate",
                        "data-active": entry.path === current ? "true" : "false",
                        title: entry.path,
                        disabled: busy,
                        onClick: () => void pick(entry.path),
                      },
                      h("img", { src: entry.url, alt: "", draggable: false }),
                      h("span", { className: "rsk-plate-path" }, entry.path),
                      entry.path === current ? h("span", { className: "rsk-plate-current" }, t("In use")) : null,
                    ),
                  ),
                ),
                h("div", { className: "rsk-hint", style: { marginTop: 8 } }, t("The agent can switch this too, with renpy_save_vn.")),
              ),
            )
          : null,
      );
    }

    /**
     * The skin's switch groups, shared by BOTH settings surfaces.
     *
     * The popover and the full page used to render the same controls from two
     * hand-written lists, so a hint added to one went missing in the other and
     * `Sprite stage` ended up filed under "Dialogue" in the popover only. One
     * descriptor, one renderer: a row now appears in both or in neither.
     */
    function SkinSwitches({ settings, set, showLanguage = true, manifest }) {
      const selectedFont = typeof settings.composerFont === "string" ? settings.composerFont : "";
      const gameFonts = manifest?.fonts ?? [];
      const systemFont = SYSTEM_FONT_OPTIONS.includes(selectedFont);
      const gameFont = gameFonts.some((font) => font.path === selectedFont);
      const [customMode, setCustomMode] = useState(selectedFont.length > 0 && !systemFont && !gameFont);
      const fontValue = selectedFont.length === 0 ? "" : customMode || (!systemFont && !gameFont) ? "__custom__" : selectedFont;
      return h(
        "div",
        null,
        h(SwitchRow, {
          label: t("Ren'Py skin enabled"),
          hint: t("Master switch for every layer below."),
          checked: settings.enabled !== false,
          onChange: (v) => set({ enabled: v }),
        }),
        h(
          Section,
          { title: t("Appearance") },
          h(SwitchRow, { label: t("Background"), checked: settings.background !== false, onChange: (v) => set({ background: v }) }),
          h(SliderRow, {
            // Shown as brightness, stored as the dim amount. The setting, the
            // clamp and the CSS gradient all mean "how much to darken", and
            // showing the complement is what makes a control labelled
            // 亮度/brighter move the way the word says: right brightens, left
            // darkens. Renaming the stored key would silently reset anyone who
            // had moved this slider, so the storage semantics stay put.
            //
            // The range is 0-100 rather than 0-1 so that no `step` has to be
            // declared: a range input without one steps by 1, which here IS the
            // granularity we want. Working in whole percent also keeps the
            // arithmetic exact — `1 - 0.7` is 0.30000000000000004 in binary
            // floating point, while `30 / 100` is the very double the literal
            // 0.3 denotes, so the setting keeps two clean decimals.
            label: t("Background brightness"),
            value: 100 - Math.round((typeof settings.backgroundDim === "number" ? settings.backgroundDim : 0.45) * 100),
            min: 0,
            max: 100,
            // The background repaints from the store, so previewing the setting
            // IS the live effect; only the save waits for the release.
            onPreview: (v) => previewSettings({ backgroundDim: (100 - v) / 100 }),
            onChange: (v) => set({ backgroundDim: (100 - v) / 100 }),
            format: (v) => `${Math.round(v)}%`,
          }),
          h(SwitchRow, {
            label: t("Theme tokens"),
            hint: t("Override the DSH alias tokens with the game's accent palette."),
            checked: settings.themeTokens !== false,
            onChange: (v) => set({ themeTokens: v }),
          }),
          // The header popover omits it: the skin's language follows the shell's,
          // and forcing it is a preference, not something reached for mid-reply.
          showLanguage ? h(LanguageRow, { value: settings.lang ?? "auto", onChange: (v) => set({ lang: v }) }) : null,
        ),
        h(
          Section,
          { title: t("Dialogue") },
          h(SwitchRow, {
            label: t("Dialogue box"),
            hint: t("Skin the composer and the user's own messages as the game's say box."),
            checked: settings.dialogbox !== false,
            onChange: (v) => set({ dialogbox: v }),
          }),
          h(SwitchRow, {
            label: t("Question cards"),
            hint: t("Render ask_user_question options as the game's choice menu."),
            checked: settings.questionChoice !== false,
            onChange: (v) => set({ questionChoice: v }),
          }),
          h(SwitchRow, {
            // The modules come from the game's own say screen (name plate,
            // quick-menu row), so this is the one switch that decides whether
            // the dialogue box is the game's box or only its art.
            label: t("Say-screen extras"),
            hint: t("Draw the name plate and quick-menu buttons the game's own say screen defines."),
            checked: settings.dialogboxModules !== false,
            onChange: (v) => set({ dialogboxModules: v }),
          }),
          h(
            "div",
            { className: "rsk-ctl" },
            h(
              "div",
              { className: "rsk-ctl-text" },
              h("div", { className: "rsk-ctl-label" }, t("Composer backdrop")),
              h("div", { className: "rsk-ctl-hint" }, t("The band the shell paints behind the composer while a reply streams.")),
            ),
            h(
              "select",
              {
                className: "rsk-input",
                style: { flex: "0 0 42%" },
                value: settings.composerBackdrop ?? "default",
                onChange: (event) => set({ composerBackdrop: event.target.value }),
              },
              h("option", { value: "default" }, t("Default (shell gradient)")),
              h("option", { value: "transparent" }, t("Transparent — let the game art show")),
              h("option", { value: "solid" }, t("Solid — no fade")),
            ),
          ),
           h(
             "div",
             { className: "rsk-ctl" },
             h("div", { className: "rsk-ctl-text" },
               h("div", { className: "rsk-ctl-label" }, t("Interface font")),
               h("div", { className: "rsk-ctl-hint" }, t("Applies to the whole interface at once. VN fonts first, then default and system fonts.")),
             ),
             h(
               "select",
               {
                 className: "rsk-input",
                 style: { flex: "0 0 42%" },
                 value: fontValue,
                 onChange: (event) => {
                   const value = event.target.value;
                   if (value === "__custom__") {
                     setCustomMode(true);
                     return;
                   }
                   setCustomMode(false);
                   set({ composerFont: value });
                 },
               },
               h("optgroup", { label: t("VN fonts") },
                 gameFonts.map((font) => h("option", { key: font.path, value: font.path }, font.label)),
               ),
               h("optgroup", { label: t("Default and system fonts") },
                 h("option", { value: "" }, t("Default (skin font)")),
                 SYSTEM_FONT_OPTIONS.map((font) => h("option", { key: font, value: font }, font)),
               ),
               h("option", { value: "__custom__" }, t("Custom font location")),
             ),
           ),
           customMode
             ? h(P.Input, {
                 className: "rsk-grow",
                 value: selectedFont,
                 placeholder: "font/MyFont.ttf or Microsoft JhengHei",
                 onChange: (event) => set({ composerFont: event.target.value }),
               })
             : null,
         ),
         h(
           Section,
           { title: t("Stage") },
           h(SwitchRow, { label: t("Sprite stage"), checked: settings.stage !== false, onChange: (v) => set({ stage: v }) }),
          h(SliderRow, {
            // Eight whole sprites: the implicit step of 1 a range input uses
            // when no `step` is declared is exactly this control's granularity,
            // so declaring it would be noise.
            label: t("Max sprites on stage"),
            value: typeof settings.maxStageSprites === "number" ? settings.maxStageSprites : 3,
            min: 1,
            max: 8,
            // StageLayer reads this straight off the store, so previewing it
            // adds or drops a sprite while the thumb moves.
            onPreview: (v) => previewSettings({ maxStageSprites: v }),
            onChange: (v) => set({ maxStageSprites: v }),
          }),
          h(SwitchRow, {
            label: t("Auto-avoid the reserved area"),
            hint: t("Shift sprites out of the name box / side image instead of only warning."),
            checked: settings.autoAvoid === true,
            onChange: (v) => set({ autoAvoid: v }),
          }),
        ),
        h(
          Section,
          { title: t("Interface") },
          h(SwitchRow, {
            label: t("Hide the session list"),
            hint: t("Give the stage the full width. Turn it back on here when you need the list."),
            checked: settings.hideSidebar === true,
            onChange: (v) => set({ hideSidebar: v }),
          }),
          h(SwitchRow, {
            label: t("Hide the dialogue box"),
            hint: t("Hide the composer so the transcript and the stage have the window to themselves. Turn it back on here."),
            checked: settings.hideComposer === true,
            onChange: (v) => set({ hideComposer: v }),
          }),
        ),
        h(
          Section,
          { title: t("Text") },
          h(SwitchRow, {
            label: t("Text animation"),
            hint: t("Typewriter animation for the model's own dialogue."),
            checked: settings.textAnimation !== false,
            onChange: (v) => set({ textAnimation: v }),
          }),
          h(SliderRow, {
            // Chars/sec is a whole-number unit, so the implicit step of 1 is the
            // granularity we want and the old `step: 5` only coarsened it. The
            // ceiling is the host's own clamp for this key, so the slider and
            // the settings writer can never disagree about where the end is.
            label: t("Text speed (chars/sec, 0 = instant)"),
            value: typeof settings.textCps === "number" ? settings.textCps : 30,
            min: 0,
            max: 400,
            onChange: (v) => set({ textCps: Math.round(v) }),
            format: (v) => String(Math.round(v)),
          }),
          h(SwitchRow, {
            label: t("Prompt injection"),
            hint: t("Inject the stage-director brief into the system prompt."),
            checked: settings.promptInjection !== false,
            onChange: (v) => set({ promptInjection: v }),
          }),
        ),
      );
    }

    /**
     * The opening and the music, shared by both settings surfaces.
     *
     * These lived only in the header popover, which advertised a link to "the
     * full settings page" — where the user then could not find either group.
     */

    /**
     * The opening-media picker: everything the game ships, searchable.
     *
     * The list comes from `/media` and not from `manifest.backgrounds`, because
     * a splash VIDEO is not a displayable and never reaches the background
     * index — and a user replacing the opening usually wants exactly that file.
     * Every path here is game-relative, which is what `/asset?p=` serves, so a
     * choice is playable whether the file is loose on disk or inside an `.rpa`.
     */
    function MediaPicker({ onClose, onPick }) {
      const [media, setMedia] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [filter, setFilter] = useState("");
      const [url, setUrl] = useState("");

      useEffect(() => {
        let live = true;
        void fetchJson(`${ROUTE}/media?session=${encodeURIComponent(currentSessionId())}`)
          .then((data) => {
            if (!live) return;
            if (data?.ok !== true) throw new Error(String(data?.error ?? "cannot list the game's media"));
            setMedia({
              videos: Array.isArray(data.videos) ? data.videos : [],
              images: Array.isArray(data.images) ? data.images : [],
            });
          })
          .catch((cause) => {
            if (live) setError(cause instanceof Error ? cause.message : String(cause));
          });
        return () => {
          live = false;
        };
      }, []);

      // Videos first: a replacement opening is nearly always one of them, and
      // they are a handful against the game's thousands of images. The list is
      // capped because rendering every displayable would freeze the panel; the
      // search box is what makes the rest reachable.
      const rows = media === undefined ? [] : [...media.videos, ...media.images];
      const needle = filter.trim().toLowerCase();
      const matches = needle.length === 0 ? rows : rows.filter((path) => path.toLowerCase().includes(needle));
      const shown = matches.slice(0, 400);

      return h(
        "div",
        {
          className: "rsk-modal",
          // The dim area is the backdrop: a click that lands on it (rather than
          // on the panel it contains) dismisses, as does Escape.
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
          onKeyDown: (event) => {
            if (event.key === "Escape") onClose();
          },
        },
        h(
          PanelShell,
          { title: t("Choose the opening media"), onClose },
          h(
            "div",
            { style: { display: "flex", gap: 8 } },
            h(P.Input, {
              className: "rsk-grow",
              value: url,
              placeholder: "https://… or video/echosplash.webm",
              onChange: (event) => setUrl(event.target.value),
            }),
            h(
              P.Button,
              { variant: "outline", className: "rsk-action", size: "sm", disabled: url.trim().length === 0, onClick: () => onPick(url.trim()) },
              t("Use"),
            ),
          ),
          h("div", { className: "rsk-hint" }, t("Or pick one of the files this game ships.")),
          h(
            "div",
            { style: { marginTop: 8 } },
            h(P.Input, {
              className: "rsk-grow",
              value: filter,
              placeholder: t("Search the game's images and videos"),
              onChange: (event) => setFilter(event.target.value),
            }),
          ),
          error !== undefined
            ? h("div", { className: "rsk-hint", style: { color: "var(--dsw-alias-state-error-primary)" } }, error)
            : media === undefined
              ? h("div", { className: "rsk-hint", style: { marginTop: 8 } }, t("Reading the game's media…"))
              : h(
                  "div",
                  { className: "rsk-tracklist" },
                  matches.length === 0
                    ? h("div", { className: "rsk-hint" }, t("Nothing matches."))
                    : shown.map((path) =>
                        h(
                          "button",
                          { key: path, type: "button", className: "rsk-track", title: path, onClick: () => onPick(path) },
                          h("span", { className: "rsk-track-name" }, path),
                        ),
                      ),
                ),
          matches.length > shown.length
            ? h(
                "div",
                { className: "rsk-hint" },
                t("{shown} of {total} shown — narrow the search to see the rest.", { shown: shown.length, total: matches.length }),
              )
            : null,
        ),
      );
    }

    function PlaybackSettings({ settings, set, manifest }) {
      const menuCandidates = manifest?.audio?.menuMusic ?? [];
      /**
       * The opening media is chosen from a floating picker rather than a
       * `<select>` or a free-text box: a game ships thousands of images (the
       * videos are a separate index), so the list has to be searched, and the
       * value is a game-relative path a user cannot be expected to type.
       */
      const [picking, setPicking] = useState(false);
      const chosenSplash = typeof settings.splashMedia === "string" ? settings.splashMedia.trim() : "";
      return h(
        "div",
        null,
        h(
          Section,
          { title: t("Opening") },
          h(SwitchRow, {
            label: t("Play the game's opening on DSH startup"),
            hint: t("Extracted from label splashscreen:. Off by default."),
            checked: settings.splashOnStart === true,
            onChange: (v) => set({ splashOnStart: v }),
          }),
          h(SwitchRow, {
            label: t("Skip on click"),
            checked: settings.splashSkipOnClick !== false,
            onChange: (v) => set({ splashSkipOnClick: v }),
          }),
          h(
            "div",
            { className: "rsk-ctl rsk-ctl--wrap" },
            h(
              "div",
              { className: "rsk-ctl-text" },
              h("div", { className: "rsk-ctl-label" }, t("Splash media")),
              h(
                "div",
                { className: "rsk-ctl-hint" },
                t("Replace the extracted opening with any image or video file the game ships, or a direct URL."),
              ),
            ),
            h(
              "button",
              { type: "button", className: "rsk-btn", onClick: () => setPicking(true) },
              t("Choose a file…"),
            ),
          ),
          chosenSplash.length === 0
            ? null
            : h(
                "div",
                { className: "rsk-ctl" },
                h(
                  "div",
                  { className: "rsk-ctl-text" },
                  h("div", { className: "rsk-ctl-hint" }, t("Selected: {path}", { path: chosenSplash })),
                ),
                // The box this replaced could be cleared by deleting the text;
                // without this the first pick would be permanent.
                h(
                  "button",
                  { type: "button", className: "rsk-btn", onClick: () => set({ splashMedia: "" }) },
                  t("Clear"),
                ),
              ),
          manifest?.splash?.found === false
            ? h("div", { className: "rsk-hint" }, t("No splash screen was found in this game."))
            : null,
        ),
        h(
          Section,
          { title: t("Music playlist") },
          h(SwitchRow, {
            label: t("Follow the game's main menu music"),
            hint: t("Play config.main_menu_music when DSH starts, and when the page is first clicked."),
            checked: settings.menuMusicOnStart === true,
            onChange: (v) => set({ menuMusicOnStart: v }),
          }),
          h(
            "div",
            { className: "rsk-ctl" },
            h(
              "div",
              { className: "rsk-ctl-text" },
              h("div", { className: "rsk-ctl-label" }, t("Main menu track")),
              h(
                "div",
                { className: "rsk-ctl-hint" },
                menuCandidates.length === 0
                  ? t("This game declares no main menu music.")
                  : menuCandidates.length > 1
                    ? t("The game's menu-music expression has more than one branch; this picks which one plays.")
                    : t("The track config.main_menu_music resolves to."),
              ),
            ),
            h(
              "select",
              {
                className: "rsk-input",
                style: { flex: "0 0 42%" },
                value: settings.menuMusicTrack ?? "",
                disabled: menuCandidates.length === 0,
                onChange: (event) => set({ menuMusicTrack: event.target.value }),
              },
              h("option", { value: "" }, t("Automatic")),
              menuCandidates.map((track) => h("option", { key: track.path, value: track.path }, track.title)),
            ),
          ),
          h(SwitchRow, {
            label: t("Autoplay the playlist on load"),
            hint: t("Browsers block audio until the page is clicked, so this waits for your first click."),
            checked: settings.playlistAutoplay === true,
            onChange: (v) => set({ playlistAutoplay: v }),
          }),
          h(SliderRow, {
            // Whole percent rather than 0–1: a range input without `step` steps
            // by 1, so 1% granularity comes for free and is FINER than the 5%
            // the old `step: 0.05` allowed. The stored setting stays 0–1, and
            // `n / 100` is the exact double the percent denotes.
            label: t("Playlist volume"),
            value: Math.round((typeof settings.playlistVolume === "number" ? settings.playlistVolume : 0.6) * 100),
            min: 0,
            max: 100,
            format: (v) => `${Math.round(v)}%`,
            // Audible while dragging: assigning a volume is free, so only the
            // save waits for the release.
            onPreview: (v) => {
              const next = Math.round(v) / 100;
              applyVolume(next);
              previewSettings({ playlistVolume: next });
            },
            onChange: (v) => {
              const next = Math.round(v) / 100;
              applyVolume(next);
              set({ playlistVolume: next });
            },
          }),
        ),
        picking
          ? h(MediaPicker, {
              onClose: () => setPicking(false),
              onPick: (value) => {
                set({ splashMedia: value });
                setPicking(false);
              },
            })
          : null,
      );
    }

    /**
     * The background switcher: every background and CG the game ships, as a
     * searchable 3x3 page of thumbnails with the file's name under each one.
     *
     * The list is `manifest.gallery`, not `manifest.backgrounds`: the latter is
     * the capped, UI-art-filtered list the automatic picker ranks, and it
     * deliberately drops CGs. A choice pins the image's game-relative PATH, so
     * it survives a reload and is re-resolved against the manifest — and
     * `galleryTotal` above the grid is the UNCAPPED count, because a game with
     * thousands of images has to be able to say so.
     */
    const GALLERY_PAGE_SIZE = 9; // 3 columns x 3 rows

    function BackgroundPicker({ manifest, settings, set }) {
      const [filter, setFilter] = useState("");
      const [kind, setKind] = useState("all");
      const [page, setPage] = useState(0);
      const pinned = typeof settings.backgroundImage === "string" ? settings.backgroundImage : "";
      const gallery = manifest?.gallery ?? [];
      const total = typeof manifest?.galleryTotal === "number" ? manifest.galleryTotal : gallery.length;
      const countOf = (wanted) => gallery.filter((entry) => wanted === "all" || entry.kind === wanted).length;
      const needle = filter.trim().toLowerCase();
      const matches = gallery.filter(
        (entry) =>
          (kind === "all" || entry.kind === kind) &&
          // The path is searchable too: `images/cgs/Interlude03` is how a player
          // who knows the game's folders narrows 190 images down.
          (needle.length === 0 || entry.name.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle)),
      );
      const pages = Math.max(1, Math.ceil(matches.length / GALLERY_PAGE_SIZE));
      // A search that shrinks the list must not leave the reader on page 7 of 1.
      const shown = Math.min(page, pages - 1);
      const slice = matches.slice(shown * GALLERY_PAGE_SIZE, shown * GALLERY_PAGE_SIZE + GALLERY_PAGE_SIZE);
      const pinnedEntry = gallery.find((entry) => entry.path === pinned);
      const rebase = (next) => {
        setPage(0);
        next();
      };

      return h(
        "div",
        { className: "rsk-card" },
        h("h4", null, t("Background")),
        h(
          "div",
          { className: "rsk-hint" },
          t("Every background and CG this game ships ({count}). Click one to pin it behind the conversation; Automatic follows the game again.", {
            count: total,
          }),
        ),
        h(
          "div",
          { className: "rsk-gallery-bar" },
          h(P.Input, {
            className: "rsk-grow",
            value: filter,
            placeholder: t("Search by name or path…"),
            onChange: (event) => rebase(() => setFilter(event.target.value)),
          }),
          h(
            "select",
            {
              className: "rsk-input",
              value: kind,
              onChange: (event) => rebase(() => setKind(event.target.value)),
            },
            h("option", { value: "all" }, t("All ({count})", { count: countOf("all") })),
            h("option", { value: "background" }, t("Backgrounds ({count})", { count: countOf("background") })),
            h("option", { value: "cg" }, t("CGs ({count})", { count: countOf("cg") })),
          ),
          h(
            "button",
            { type: "button", className: "rsk-btn", disabled: pinned.length === 0, onClick: () => set({ backgroundImage: "" }) },
            t("Automatic"),
          ),
        ),
        slice.length === 0
          ? h("div", { className: "rsk-hint", style: { marginTop: 8 } }, t("No image matches this search."))
          : h(
              "div",
              { className: "rsk-gallery" },
              slice.map((entry) =>
                h(
                  "button",
                  {
                    key: entry.path,
                    type: "button",
                    className: entry.path === pinned ? "rsk-gallery-item rsk-gallery-item--on" : "rsk-gallery-item",
                    title: entry.path,
                    onClick: () => set({ backgroundImage: entry.path }),
                  },
                  h("img", { className: "rsk-gallery-thumb", src: entry.url, alt: entry.name, loading: "lazy" }),
                  h("span", { className: "rsk-gallery-name" }, entry.name),
                ),
              ),
            ),
        h(
          "div",
          { className: "rsk-gallery-nav" },
          h("button", { type: "button", className: "rsk-btn", disabled: shown <= 0, onClick: () => setPage(shown - 1) }, t("Previous")),
          h(
            "span",
            { className: "rsk-stat" },
            t("Page {page} / {pages} · {count} shown", { page: shown + 1, pages, count: matches.length }),
          ),
          h("button", { type: "button", className: "rsk-btn", disabled: shown >= pages - 1, onClick: () => setPage(shown + 1) }, t("Next")),
        ),
        pinnedEntry === undefined
          ? null
          : h("div", { className: "rsk-hint", style: { marginTop: 6 } }, t("Pinned: {name}", { name: pinnedEntry.name })),
      );
    }

    /**
     * What the agent concluded about this game, read-only.
     *
     * The completion prompt asks one question — apply it now or keep it for the
     * next load — so the record itself lives here: when it was written, what it
     * corrected, what it was told to ignore or drop, whether it was written for
     * a different folder, and the notes that came with it. Nothing in this card
     * changes anything; the popup and 「重新加载」 do.
     */
    function AgentProfileCard({ state }) {
      const vn = state.vn;
      const profile = vn?.profile;
      if (vn === undefined || profile === null || profile === undefined) return null;
      const report = profile.report ?? {};
      const ignored = Array.isArray(report.ignored) ? report.ignored : [];
      const malformed = Array.isArray(report.malformed) ? report.malformed : [];
      const unknownKeys = Array.isArray(report.unknownKeys) ? report.unknownKeys : [];
      const applied = Array.isArray(vn.applied) ? vn.applied : [];
      const unmatched = Array.isArray(vn.unmatched) ? vn.unmatched : [];
      const rejected = vn.rejected ?? null;
      // The card shows a bounded head of the note, so say so: a truncated
      // summary that looks complete is worse than no summary at all.
      const summaryNote = vn.notes?.summary;
      const summaryTruncated =
        summaryNote?.truncated === true && typeof summaryNote.chars === "number";
      return h(
        "div",
        { className: "rsk-card" },
        h("h4", null, t("The profile the agent wrote")),
        h("div", { className: "rsk-hint" }, t("Written {when}.", { when: profile.savedAt ?? "" })),
        rejected === null
          ? h(
              "div",
              { className: "rsk-stat" },
              applied.length > 0
                ? t("{count} fields applied over the scan.", { count: applied.length })
                : t("Nothing was applied over the scan."),
            )
          : h(
              "div",
              { className: "rsk-hint", style: { color: "var(--dsw-alias-state-error-primary)" } },
              t("This profile was written for a different game folder ({dir}); it is not applied.", {
                dir: String(rejected.savedGameDir ?? ""),
              }),
            ),
        ignored.length === 0 ? null : h("div", { className: "rsk-stat" }, t("Ignored: {list}", { list: ignored.join(", ") })),
        malformed.length === 0
          ? null
          : h("div", { className: "rsk-stat" }, t("Dropped: {list}", { list: malformed.join(", ") })),
        unknownKeys.length === 0
          ? null
          : h(
              "div",
              { className: "rsk-stat" },
              t("Unknown fields: {list} (written, but not counted as applied)", {
                list: unknownKeys.join(", "),
              }),
            ),
        unmatched.length === 0
          ? null
          : h(
              "div",
              { className: "rsk-stat" },
              t("Reached nothing in the scan: {list}", { list: unmatched.join(", ") }),
            ),
        typeof vn.summary === "string" && vn.summary.length > 0
          ? h("div", { className: "rsk-hint", style: { marginTop: 6 } }, t("Summary:") + "\n" + vn.summary)
          : null,
        summaryTruncated
          ? h(
              "div",
              { className: "rsk-hint" },
              t("The note is {chars} characters long; only its beginning is shown.", {
                chars: summaryNote.chars,
              }),
            )
          : null,
        typeof vn.dir === "string" && vn.dir.length > 0
          ? h("div", { className: "rsk-stat", style: { marginTop: 6 } }, t("Profile folder: {dir}", { dir: vn.dir }))
          : null,
      );
    }

    /**
     * Display names for the environment rows the host reports.
     *
     * The host answers with ids and facts, never with translated prose — it
     * does not know which language this page is in. A row whose id is missing
     * from this map still renders under its own id, so a requirement added by a
     * newer host is visible before this list catches up.
     */
    const ENVIRONMENT_TITLES = {
      node: "Node.js (part of DSH)",
      python: "Python 3.9 or newer (optional)",
      unrpyc: "unrpyc (optional)",
      dataHome: "Data folder",
    };

    /** Where a tool was found, in words rather than in the host's id. */
    const ENVIRONMENT_SOURCES = {
      setting: "the path set here",
      environment: "an environment variable",
      "dsh-runtime": "a Python shipped with DSH",
      home: "the home Tools folder",
      vendor: "the plugin's own vendor folder",
      tools: "the Tools folder",
      path: "PATH",
    };

    /**
     * What this plugin needs from the machine, and where to point it at a copy.
     *
     * `GET /renpy-skin/doctor` is the only source of these facts. The browser
     * cannot stat a path or start an interpreter, and re-deriving the lookup
     * order here would drift from the one `lib/rpyc.js` actually uses — the card
     * would then say "found" about a copy the host never looks at.
     */
    function EnvironmentCard() {
      const state = useStore(store);
      const settings = state.settings ?? {};
      const [report, setReport] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [busy, setBusy] = useState(false);

      const load = (refresh) => {
        setBusy(true);
        void fetchJson(`${ROUTE}/doctor${refresh === true ? "?refresh=1" : ""}`)
          .then((data) => {
            if (data.ok !== true) throw new Error(data.error ?? "the host refused the request");
            setReport(data);
            setError(undefined);
          })
          .catch((failure) => {
            // A request that failed must not read as "nothing is installed":
            // every row would then be a claim about a machine nobody asked.
            setError(failure instanceof Error ? failure.message : String(failure));
          })
          .then(() => setBusy(false));
      };

      useEffect(() => {
        load(false);
      }, []);

      // A saved path changes what the host finds on its very next read, so the
      // report is re-probed instead of leaving rows that describe the path the
      // user just replaced.
      const commit = (patch) => {
        void saveSettings(patch).then(() => load(true));
      };

      const requirements = Array.isArray(report?.requirements) ? report.requirements : [];
      const rowOf = (id) => requirements.find((entry) => entry.id === id);
      const unrpyc = rowOf("unrpyc");
      const unrpycMissing = unrpyc !== undefined && unrpyc.status !== "ok";

      const link = (href, label) =>
        h("a", { className: "rsk-link", href, target: "_blank", rel: "noreferrer" }, label);

      const row = (entry) => {
        const status =
          entry.status === "ok" ? t("Found") : entry.status === "broken" ? t("Does not work") : t("Not found");
        const source =
          (entry.id === "python" || entry.id === "unrpyc") &&
          typeof entry.source === "string" &&
          entry.source.length > 0
            ? entry.source
            : undefined;
        const links = [
          entry.download === null || entry.download === undefined
            ? null
            : link(entry.download, t(entry.id === "python" ? "Download Python" : "Project page")),
          entry.archive === null || entry.archive === undefined
            ? null
            : link(entry.archive, t("Download unrpyc (source archive, v2.0.4)")),
        ].filter((item) => item !== null);
        return h(
          "div",
          { key: entry.id, className: "rsk-ctl", style: { alignItems: "flex-start", minHeight: 0 } },
          h(
            "div",
            { className: "rsk-ctl-text" },
            h("div", { className: "rsk-ctl-label" }, t(ENVIRONMENT_TITLES[entry.id] ?? entry.id)),
            h(
              "div",
              {
                className: "rsk-ctl-hint",
                style: entry.status === "broken" ? { color: "var(--dsw-alias-state-error-primary)" } : undefined,
              },
              String(entry.detail ?? ""),
            ),
            source === undefined
              ? null
              : h(
                  "div",
                  { className: "rsk-ctl-hint" },
                  t("Found through {source}.", { source: t(ENVIRONMENT_SOURCES[source] ?? source) }),
                ),
            links.length === 0
              ? null
              : h("div", { className: "rsk-ctl-hint", style: { display: "flex", gap: 10, flexWrap: "wrap" } }, ...links),
            entry.legacyPresent === true && typeof entry.legacy === "string"
              ? h(
                  "div",
                  { className: "rsk-ctl-hint", style: { color: "var(--dsw-alias-state-error-primary)" } },
                  t(
                    "The old data folder still exists: {dir}. Two folders at once means one of them is ignored.",
                    { dir: entry.legacy },
                  ),
                )
              : null,
          ),
          h("div", { className: "rsk-ctl-side" }, h("span", { className: "rsk-stat" }, status)),
        );
      };

      return h(
        "div",
        { className: "rsk-card" },
        h("h4", null, t("Environment")),
        h(
          "div",
          { className: "rsk-hint" },
          t(
            "Compiled .rpyc scripts can only be read with Python 3.9 or newer and unrpyc. Both are optional: without them a game still loads and loose .rpy source is read, but every value that lives in a compiled script falls back to its default.",
          ),
        ),
        error === undefined
          ? null
          : h(
              "div",
              { className: "rsk-hint", style: { color: "var(--dsw-alias-state-error-primary)" } },
              t("Could not read the environment: {reason}", { reason: error }),
            ),
        requirements.length === 0
          ? null
          : h("div", { className: "rsk-section" }, ...requirements.map((entry) => row(entry))),
        unrpycMissing
          ? h(
              "div",
              { className: "rsk-hint" },
              t(
                "unrpyc is not on PyPI: `pip install unrpyc` fails with no matching distribution. Unzip the archive and point the path below at unrpyc.py, or copy unrpyc.py into {root}/vendor/unrpyc/.",
                { root: report?.pluginRoot ?? "" },
              ),
            )
          : null,
        typeof report?.install === "string" && report.install.length > 0
          ? h(
              "details",
              { style: { marginTop: 8 } },
              h("summary", { className: "rsk-ctl-label" }, t("How to install unrpyc")),
              // The instruction block is a shell script; pre-wrap keeps its
              // lines, and the monospace face keeps them from re-flowing into
              // prose when the panel is narrow.
              h(
                "pre",
                {
                  className: "rsk-input",
                  style: { whiteSpace: "pre-wrap", marginTop: 6, fontFamily: "monospace", fontSize: 11 },
                },
                report.install,
              ),
            )
          : null,
        h(
          Section,
          { title: t("Tool locations") },
          h(TextRow, {
            label: t("Python"),
            hint: t("Path of python.exe, or a name on PATH. Empty finds one automatically."),
            value: settings.pythonPath ?? "",
            placeholder: "C:\\Python312\\python.exe",
            onCommit: (next) => commit({ pythonPath: next }),
          }),
          h(TextRow, {
            label: t("unrpyc"),
            hint: t("Path of unrpyc.py, or the folder it was unpacked into. Empty searches the tools folder, the plugin's vendor folder and PATH."),
            value: settings.unrpycPath ?? "",
            placeholder: "C:\\Tools\\unrpyc\\unrpyc.py",
            onCommit: (next) => commit({ unrpycPath: next }),
          }),
          h(TextRow, {
            label: t("Tools folder"),
            hint: t("Where to look for unrpyc checkouts. Empty means {dir}.", {
              dir: report?.unrpyc?.toolsDir ?? "~/Tools",
            }),
            value: settings.toolsDir ?? "",
            placeholder: "C:\\Tools",
            onCommit: (next) => commit({ toolsDir: next }),
          }),
        ),
        h(
          "div",
          { className: "rsk-field-actions", style: { marginTop: 8 } },
          h(
            P.Button,
            {
              variant: "outline",
              className: "rsk-action",
              size: "sm",
              disabled: busy,
              onClick: () => load(true),
            },
            busy ? t("Checking…") : t("Check again"),
          ),
          report?.usable === true
            ? h("span", { className: "rsk-stat" }, t("Compiled scripts can be read."))
            : null,
        ),
      );
    }

    /** Display names for the palette rows; a new slot still renders its id. */
    const PALETTE_LABELS = {
      accent: "Accent",
      hover: "Hover",
      idle: "Idle",
      text: "Dialogue text",
      uiText: "Interface text",
      name: "Name",
      choiceIdle: "Choice text",
      choiceHover: "Choice hover",
    };

    /**
     * The two text slots in one line each, because they are easy to confuse.
     *
     * Both default to the same colour, so without a note the rows look like
     * duplicates — and the difference only shows up once one of them is pinned.
     */
    const PALETTE_HINTS = {
      text: "The text inside the dialogue box.",
      uiText:
        "The shell's own text. Left alone the dark theme follows the dialogue colour and the light theme derives from the accent; a pinned colour applies to both themes.",
    };

    /**
     * Where a palette entry came from, in words.
     *
     * The ids are the manifest's provenance vocabulary (`manifest.sources`), so
     * an unknown one renders as itself instead of disappearing.
     */
    const PALETTE_SOURCES = {
      "gui-variable": "a gui variable",
      screen: "the say screen",
      style: "a style block",
      "image-sample": "the text box image",
      "dialogue-text": "the dialogue text colour",
      settings: "this page",
      default: "Ren'Py's default",
    };

    /**
     * One palette row: the game's value, and a picker that can replace it.
     *
     * A colour input fires `input` on every step while the picker is open and
     * `change` once it closes, so the draft follows the drag and the save
     * happens once — the same split `SliderRow` uses, for the same reason: one
     * drag must not become dozens of settings writes.
     */
    function PaletteRow({ entry, override, onCommit }) {
      const stored = typeof override === "string" ? override : entry.value;
      const [draft, setDraft] = useState(stored);
      const open = useRef(false);
      const inputRef = useRef(undefined);
      // The listener below outlives a render, so it reads the live values from
      // a ref rather than from the closure it was created in.
      const latest = useRef({ draft, onCommit, stored });
      latest.current = { draft, onCommit, stored };
      useEffect(() => {
        if (open.current !== true) setDraft(stored);
      }, [stored]);
      useEffect(() => {
        const node = inputRef.current;
        if (node === undefined || node === null) return undefined;
        const closed = () => {
          open.current = false;
          const { draft: value, onCommit: commit, stored: base } = latest.current;
          if (value !== base) commit(value);
        };
        node.addEventListener("change", closed);
        return () => node.removeEventListener("change", closed);
      }, []);
      const overridden = typeof override === "string";
      const label = t(PALETTE_LABELS[entry.key] ?? entry.key);
      const hint = PALETTE_HINTS[entry.key];
      return h(
        "div",
        { className: "rsk-ctl" },
        h(
          "div",
          { className: "rsk-ctl-text" },
          h("div", { className: "rsk-ctl-label" }, label),
          hint === undefined ? null : h("div", { className: "rsk-ctl-hint" }, t(hint)),
          h(
            "div",
            { className: "rsk-ctl-hint" },
            t("Read from {source}.", {
              source: t(PALETTE_SOURCES[entry.source] ?? entry.source ?? "default"),
            }),
          ),
        ),
        h(
          "div",
          { className: "rsk-ctl-side", style: { display: "flex", gap: 6, alignItems: "center" } },
          h("span", { className: "rsk-stat" }, typeof draft === "string" ? draft : ""),
          h("input", {
            ref: inputRef,
            type: "color",
            className: "rsk-color",
            value: draft,
            "aria-label": label,
            onChange: (event) => {
              open.current = true;
              setDraft(event.target.value);
            },
          }),
          overridden
            ? h(
                P.Button,
                { variant: "outline", className: "rsk-action", size: "sm", onClick: () => onCommit(undefined) },
                // The interface colour has no "game" value of its own: it
                // defaults to the dialogue colour, so the way back is named
                // after what it actually returns to.
                entry.key === "uiText" ? t("Follow the dialogue text") : t("Use the game's colour"),
              )
            : null,
        ),
      );
    }

    /**
     * The palette, editable.
     *
     * `manifest.palette` is what the game says, `settings.paletteOverrides` is
     * what the user pinned; a pinned row shows the pin and offers the game's
     * value back. Saving rebuilds the manifest because the alias tokens and
     * this card's sources are both derived during the build — without that the
     * theme would keep describing the palette that was just replaced.
     */
    function PaletteCard({ manifest, settings }) {
      const entries = Array.isArray(manifest?.palette) ? manifest.palette : [];
      const overrides = settings?.paletteOverrides ?? {};
      const commit = (key, value) => {
        const next = { ...overrides };
        if (typeof value === "string" && value.trim() !== "") next[key] = value.trim().toLowerCase();
        else delete next[key];
        void saveSettings({ paletteOverrides: next }).then(() => refreshManifest());
      };
      return h(
        "div",
        { className: "rsk-card" },
        h("h4", null, t("Palette read from the game")),
        entries.length === 0
          ? h(
              "div",
              { className: "rsk-swatches" },
              [
                ["accent", "--dsw-alias-brand-primary"],
                ["text", "--dsw-alias-label-primary"],
                ["base", "--dsw-alias-bg-base"],
              ].map(([label, token]) =>
                h(
                  "div",
                  { key: label, style: { display: "flex", gap: 4, alignItems: "center" } },
                  h("div", { className: "rsk-swatch", style: { background: manifest.theme?.[token]?.dark } }),
                  h("div", { className: "rsk-swatch", style: { background: manifest.theme?.[token]?.light } }),
                  h("span", { className: "rsk-stat" }, t(label)),
                ),
              ),
            )
          : entries.map((entry) =>
              h(PaletteRow, {
                key: entry.key,
                entry,
                override: typeof overrides[entry.key] === "string" ? overrides[entry.key] : undefined,
                onCommit: (value) => commit(entry.key, value),
              }),
            ),
        h(
          "div",
          { className: "rsk-hint", style: { marginTop: 6 } },
          entries.length === 0
            ? t("Left swatch = dark theme, right swatch = light theme.")
            : t("Each colour is read from the game unless you pick one here; a pick applies as soon as the picker closes."),
        ),
      );
    }

    /** The Ren'Py skin settings page. */
    function SettingsPage() {
      const state = useStore(store);
      const settings = state.settings ?? {};
      const [gameDir, setGameDir] = useState(settings.gameDir ?? "");
      /**
       * WHICH action is in flight, not merely whether one is.
       *
       * `Load` reads the path in the box, `Re-read` re-reads the active game.
       * Both drive the same `/library` call, so one shared boolean labelled
       * both buttons "Loading…" and made the pair read as a single control.
       */
      const [busy, setBusy] = useState(undefined);
      const [agentNotice, setAgentNotice] = useState(undefined);
      // Why the last 「用 Agent 加载」 click fell back. The notice itself stays
      // short (it is a line under a button), so the reason is a tooltip.
      const [agentFailure, setAgentFailure] = useState(undefined);
      /**
       * The prompt the last click built, kept so it is not lost to a failure.
       *
       * It is only ever copied when the user presses the copy button: an
       * automatic clipboard fallback reported "copied" and hid the real problem,
       * because that prompt asks the agent to read a game the host never loaded.
       */
      const [agentPrompt, setAgentPrompt] = useState(undefined);
      // A profile already on disk is the only proof that this game has been
      // loaded with the Agent before. While this holds its savedAt stamp, the
      // first click shows what a second one would overwrite instead of starting.
      const [agentConfirm, setAgentConfirm] = useState(undefined);
      const loading = busy !== undefined || state.status === "loading";

      useEffect(() => {
        setGameDir(settings.gameDir ?? "");
      }, [settings.gameDir]);

      // A confirmation belongs to the game it was shown for.
      useEffect(() => {
        setAgentConfirm(undefined);
      }, [settings.gameDir]);

      useEffect(() => {
        if (state.manifest === undefined && state.status === "idle") void refreshManifest();
      }, [state.manifest, state.status]);

      // The profile card shows the profile for whatever game is loaded. A
      // manifest fetch already refreshes it, but the card must also fill in when
      // this page is the first thing opened after a restart.
      useEffect(() => {
        if (state.vn === undefined && state.manifest !== undefined) void refreshVnProfile();
      }, [state.vn, state.manifest]);

      // Only the game directory changes what the host can see, so only that
      // patch is worth a manifest rebuild. Toggling a switch rebuilt the whole
      // manifest (and its archive scan) for nothing.
      const set = (patch) => {
        const needsManifest = Object.prototype.hasOwnProperty.call(patch, "gameDir");
        void saveSettings(patch).then(() => (needsManifest ? refreshManifest() : undefined));
      };

      const manifest = state.manifest;
      const stats = manifest?.stats;

      /**
       * Start the Agent run once any overwrite confirmation has been accepted.
       *
       * The order is what makes this work at all: the host has to load the game
       * BEFORE the session opens, so the request the agent sees already carries
       * the `renpy_*` tools and a prepared workspace. Opening first would send a
       * prompt about a game nothing had loaded.
       */
      const runAgentLoad = () => {
        setBusy("agent");
        setAgentNotice(undefined);
        setAgentFailure(undefined);
        // The notice names the step that failed rather than reading the
        // message: "could not prepare" and "could not open a session" send the
        // user to different places, and only the step order knows which one it
        // was.
        let prepared = false;
        void (async () => {
          const facts = await prepareGame(
            currentSessionId(),
            typeof settings.gameDir === "string" ? settings.gameDir : undefined,
          );
          prepared = true;
          // The profile already on disk must not be mistaken for the one this
          // session is about to write, so the watch is armed with the stamp read
          // before the write.
          const before = await fetchJson(
            `${ROUTE}/vn?session=${encodeURIComponent(currentSessionId())}`,
          ).catch(() => undefined);
          const baseline = before?.profile?.savedAt ?? "";
          const text = agentLoadPrompt(facts);
          setAgentPrompt(text);
          await loadWithAgent(platformCtx, text, facts.profileDir);
          startProfileWatch(baseline);
        })()
          .then(() => {
            setBusy(undefined);
            setAgentNotice(t("Sent to a new session."));
            // The host wrote both listings and switched the game, so the page
            // has to read them back: without this the card keeps showing the
            // old game.
            void refreshManifest();
          })
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            setBusy(undefined);
            setAgentFailure(reason);
            setAgentNotice(
              t(prepared ? "Could not open a session: {reason}" : "Could not prepare the game: {reason}", {
                reason,
              }),
            );
            // The game may still have switched even though the session did not
            // open — the host loads it before it answers — so the page re-reads
            // either way.
            if (prepared) void refreshManifest();
          });
      };

      /**
       * Check for a prior Agent profile before starting a new run.
       *
       * `state.vn` is normally filled by the manifest fetch, but it can still be
       * undefined if the page is opened and clicked before that request lands.
       * Reading it here closes that race instead of silently skipping the
       * overwrite warning. A rejected profile still counts: it is an existing
       * file for this game name that the next run would replace.
       */
      const requestAgentLoad = async () => {
        let vn = state.vn;
        if (vn === undefined) vn = await refreshVnProfile();
        const savedAt = vn?.profile?.savedAt;
        if (typeof savedAt === "string" && savedAt.length > 0 && !agentConfirm) {
          setAgentConfirm(savedAt);
          setAgentNotice(undefined);
          setAgentFailure(undefined);
          return;
        }
        setAgentConfirm(undefined);
        runAgentLoad();
      };

      return h(
        "div",
        { className: "rsk-page" },
        h(
          "div",
          { className: "rsk-card" },
          h("h4", null, t("Known VNs")),
          h(GamePicker, { state }),
        ),
        h(
          "div",
          { className: "rsk-card" },
          h("h4", null, t("Add a game directory")),
          h("div", { className: "rsk-hint" }, t("Point this at a Ren'Py game's folder (the one containing game/) or directly at its game/ directory. Loose files and .rpa archives are both read.")),
          h(
            "div",
            { style: { display: "flex", gap: 8, marginTop: 8 } },
            h(P.Input, {
              className: "rsk-grow",
              value: gameDir,
              placeholder: "D:\\Games\\MyVisualNovel",
              onChange: (event) => setGameDir(event.target.value),
            }),
            h(
              P.Button,
              {
                variant: "primary",
                size: "sm",
                disabled: loading,
                onClick: () => {
                  setBusy("load");
                  void switchGame(gameDir).finally(() => setBusy(undefined));
                },
              },
              busy === "load" || state.status === "loading" ? t("Loading…") : t("Load"),
            ),
          ),
          state.status === "error"
            ? h(
                "div",
                { className: "rsk-hint", style: { color: "var(--dsw-alias-state-error-primary)" } },
                // The raw transport error ("/renpy-skin/manifest -> HTTP 500")
                // is diagnostic, not actionable for a player, so it degrades to
                // the tooltip and the visible line states what went wrong.
                h("span", { title: String(state.error ?? "") }, t("Could not read the game directory.")),
              )
            : null,
          h(
                "div",
                { style: { marginTop: 8, display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between" } },
                h(
                  "div",
                  { style: { minWidth: 0 } },
                manifest === undefined ? null : h("div", { className: "rsk-hint" }, `${manifest.game.name}${manifest.game.version === undefined ? "" : ` v${manifest.game.version}`} · ${manifest.game.screen.w}x${manifest.game.screen.h}`),
                manifest === undefined ? null : h("div", { className: "rsk-stat" }, t("{backgrounds} backgrounds · {tags} characters · {expressions} expressions · {transforms} transforms · {displayables} displayables", { backgrounds: stats.backgrounds, tags: stats.tags, expressions: stats.tags > 0 ? manifest.tags.reduce((sum, tag) => sum + (tag.total ?? tag.expressions.length), 0) : 0, transforms: stats.transforms, displayables: stats.displayables })),
                ),
                h(
                  "div",
                  { style: { display: "flex", gap: 8, flex: "0 0 auto" } },
                  h(
                    P.Button,
                    {
                      variant: "outline",
                      className: "rsk-action",
                      size: "sm",
                      disabled: loading,
                      title: t("Open a new session with this game already loaded, and ask the agent to write its profile."),
                      onClick: () => {
                        void requestAgentLoad();
                      },
                    },
                    busy === "agent"
                      ? t("Opening…")
                      : agentConfirm
                        ? t("Click again to load")
                        : t("Load with Agents"),
                  ),
                  h(
                    P.Button,
                    {
                      variant: "outline",
                      className: "rsk-action",
                      size: "sm",
                      disabled: loading,
                      title: t("Re-read this game"),
                      onClick: () => {
                        setAgentConfirm(undefined);
                        setBusy("reread");
                        void switchGame("").finally(() => setBusy(undefined));
                      },
                    },
                    busy === "reread" ? t("Re-reading…") : t("Re-read this game"),
                  ),
                ),
              ),
          agentConfirm
            ? h(
                "div",
                { className: "rsk-confirm" },
                t(
                  "An Agent profile already exists for this game (written {when}). Click again to open a new session and ask the Agent to regenerate its profile; the existing profile may be overwritten.",
                  { when: agentConfirm },
                ),
              )
            : null,
          agentNotice === undefined
            ? null
            : h(
                "div",
                { className: "rsk-hint", style: { marginTop: 6, display: "flex", gap: 8, alignItems: "center" } },
                h("span", { title: String(agentFailure ?? "") }, agentNotice),
                // The prompt is only on the clipboard because the user asks for
                // it. It is still useful after a failure — the paths in it are
                // real, since the host loads the game before the session
                // opens — but pasting it is a decision that belongs to them.
                agentPrompt === undefined || agentFailure === undefined
                  ? null
                  : h(
                      P.Button,
                      {
                        variant: "outline",
                        className: "rsk-action",
                        size: "sm",
                        onClick: () => {
                          void copyAgentPrompt(agentPrompt).then((copied) => {
                            setAgentNotice(
                              copied ? t("Copied the prompt.") : t("Could not copy the prompt."),
                            );
                            setAgentFailure(undefined);
                          });
                        },
                      },
                      t("Copy the prompt"),
                    ),
              ),
        ),
        h(EnvironmentCard, null),
        h(AgentProfileCard, { state }),
        h(
          "div",
          { className: "rsk-card" },
          h("h4", null, t("Switches")),
          h(SkinSwitches, { settings, set, manifest }),
          h("div", { className: "rsk-divider" }),
          h(PlaybackSettings, { settings, set, manifest }),
        ),
        manifest === undefined ? null : h(PaletteCard, { manifest, settings }),
        manifest === undefined ? null : h(BackgroundPicker, { manifest, settings, set }),
        manifest === undefined ? null : h(PlatePicker, { manifest }),
        manifest === undefined ? null : h(LayoutEditor, { manifest, settings }),
        h(ImportExport, null),
        manifest === undefined
          ? null
          : h(CharacterPicker, { manifest, settings, onChange: set }),
        manifest === undefined ? null : h(RoleplaySection, { manifest, settings, set }),
      );
    }

    // ── header utilities ───────────────────────────────────────────────────

    /** `true` once the opening has had its one chance in this page load. */
    let splashAttempted = false;

    /**
     * Set when the opening should play, consumed when it does.
     *
     * Two flags rather than one because the decision needs `settings` and the
     * playback needs `manifest`, and they do not always arrive together: the
     * settings are persisted locally while the manifest is scanned. A single
     * latch would fire on whichever arrived second and, worse, would let an
     * unrelated manifest refresh replay the opening mid-session.
     */
    let splashWanted = false;

    // The shipped primitive set ships no Ren'Py mark and no music note, so both
    // glyphs are inline SVG. Besides not depending on an icon name a DSH update
    // can rename, an inline glyph inherits `currentColor` from its button and so
    // follows the game's accent palette for free.
    function RenpyMark() {
      return h(
        "svg",
        { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        // A monogram "R": stem and bowl, then the leg.
        h("path", {
          d: "M7 20V4h6.5a4.5 4.5 0 0 1 0 9H9",
          stroke: "currentColor",
          strokeWidth: 2.2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
        h("path", { d: "M13 13l5.5 7", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" }),
      );
    }

    function MusicMark() {
      return h(
        "svg",
        { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M9.5 18V6.2l10-2.2v11.6",
          stroke: "currentColor",
          strokeWidth: 2.1,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
        h("circle", { cx: 6.9, cy: 18, r: 2.6, stroke: "currentColor", strokeWidth: 2.1 }),
        h("circle", { cx: 16.9, cy: 16, r: 2.6, stroke: "currentColor", strokeWidth: 2.1 }),
      );
    }

    /** The memory panel's glyph: a notebook, one page per character. */
    function MemoryMark() {
      return h(
        "svg",
        { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M5 4.5A1.5 1.5 0 0 1 6.5 3H18v18H6.5A1.5 1.5 0 0 1 5 19.5z",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinejoin: "round",
        }),
        h("path", { d: "M9 7.5h5M9 11h5", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" }),
      );
    }

    function PlayMark() {
      return h(
        "svg",
        { width: 11, height: 11, viewBox: "0 0 24 24", "aria-hidden": "true" },
        h("path", { d: "M7 4l13 8-13 8z", fill: "currentColor" }),
      );
    }

    function PauseMark() {
      return h(
        "svg",
        { width: 11, height: 11, viewBox: "0 0 24 24", "aria-hidden": "true" },
        h("path", { d: "M7 4h4v16H7zM13 4h4v16h-4z", fill: "currentColor" }),
      );
    }

    function SkipMark({ back }) {
      return h(
        "svg",
        { width: 11, height: 11, viewBox: "0 0 24 24", "aria-hidden": "true" },
        h("path", { d: back ? "M18 5v14L8 12z" : "M6 5v14l10-7z", fill: "currentColor" }),
        h("path", { d: back ? "M5 5h2v14H5z" : "M17 5h2v14h-2z", fill: "currentColor" }),
      );
    }

    // The single transport button names its state outright instead of relying
    // on a crossed-out variant, because a fourth drawing of the same loop glyph
    // would read as a second control.

    /**
     * The playback-mode icon. One button covers four states, so the glyph has
     * to change with them: a plain loop for the two repeat modes, a crossed
     * pair of arrows for shuffle, and two right-pointing arrows for the order
     * that does not loop at all.
     */
    function PlaybackMark({ mode }) {
      if (mode === "shuffle") {
        return h(
          "svg",
          { width: 12, height: 12, viewBox: "0 0 24 24", "aria-hidden": "true" },
          h("path", {
            d: "M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z",
            fill: "currentColor",
          }),
        );
      }
      if (mode === "order") {
        return h(
          "svg",
          { width: 12, height: 12, viewBox: "0 0 24 24", "aria-hidden": "true" },
          h("path", { d: "M4 6h11v2H4V6zm0 5h8v2H4v-2zm0 5h11v2H4v-2z", fill: "currentColor" }),
          h("path", { d: "M17 8l5 4-5 4V8z", fill: "currentColor" }),
        );
      }
      return h(
        "svg",
        { width: 12, height: 12, viewBox: "0 0 24 24", "aria-hidden": "true" },
        h("path", {
          d: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z",
          fill: "currentColor",
        }),
        mode === "one"
          ? h("path", { d: "M13 15V9h-1l-2 1v1h1.5v4H13z", fill: "currentColor" })
          : null,
      );
    }

    function HeaderButton({ title, active, playing, onClick, children }) {
      return h(
        "button",
        {
          type: "button",
          className: "rsk-head-btn",
          title,
          "aria-label": title,
          "aria-expanded": active === true,
          "data-active": active === true ? "true" : "false",
          "data-playing": playing === true ? "true" : "false",
          onClick,
        },
        children,
      );
    }

    /**
     * The two buttons the header strip gains.
     *
     * Renderable from TWO seats, because the first one does not always exist.
     * `conversation.session.header.utilities` is the right-aligned row next to
     * the shell's own controls. A blank Session slides that row — ours included
     * — to the start of the header, and the stylesheet pins the cluster back to
     * the edge it belongs at (see the `.rsk-head-primary` rules); with no
     * Session at all, the shell renders no Session header whatsoever and swaps
     * the whole slot for an empty title row (`sessionId === void 0`).
     * `conversation.header.leading` is the seat the platform documents as
     * "available without a Session", so the same cluster is registered there as
     * well; CSS keeps exactly one copy on screen. The slot hands an occupant NO
     * props, so each button reads the plugin's own stores directly. The panels
     * they open live in `PopoverLayer` instead of here: a `position: absolute`
     * child of the header bar is at the mercy of that bar's own `overflow` and
     * stacking context.
     *
     * @param seat - Which of the two seats this instance came from.
     */
    function HeaderUtilities({ seat }) {
      const ui = useStore(uiStore);
      const player = useStore(playerStore);
      const toggle = (panel) => uiStore.set({ panel: ui.panel === panel ? undefined : panel });
      return h(
        "div",
        {
          // Marked so the popover's outside-pointer close can tell a header
          // click (which toggles) from a click elsewhere (which dismisses).
          "data-renpy-skin": "header",
          // The class names both carry the styling and let the stylesheet see
          // which seat is live — the fallback hides itself while the primary
          // copy is on screen, and the primary pins itself to the right edge
          // whenever the shell has hidden its title cluster.
          className: seat === "fallback" ? "rsk-head-fallback" : "rsk-head-primary",
          style: { display: "inline-flex", alignItems: "center", gap: 2 },
        },
        h(
          HeaderButton,
          { title: t("Ren'Py settings"), active: ui.panel === "settings", onClick: () => toggle("settings") },
          h(RenpyMark, null),
        ),
        h(
          HeaderButton,
          {
            title: t("Music playlist"),
            active: ui.panel === "music",
            playing: player.playing,
            onClick: () => toggle("music"),
          },
          h(MusicMark, null),
        ),
        h(
          HeaderButton,
          { title: t("Character memory"), active: ui.panel === "memory", onClick: () => toggle("memory") },
          h(MemoryMark, null),
        ),
      );
    }

    /**
     * The `conversation.header.leading` copy of the cluster — the one that
     * survives a Sessionless header, where the shell renders no Session header
     * at all. Registering it is half the fix for the buttons leaving the
     * top-right in a new chat; the styling decides when it is visible.
     */
    function HeaderFallback() {
      return h(HeaderUtilities, { seat: "fallback" });
    }

    /**
     * The shared popover chrome: the frame, its title and its close control.
     *
     * It claims focus on mount so a keyboard user starts INSIDE the panel
     * rather than in the conversation behind it — the panel is painted over the
     * page without a backdrop, so without this Tab walks into content the panel
     * is covering. `role`/`aria-label` give screen readers the same boundary.
     */
    function PanelShell({ title, onClose, children }) {
      const panelRef = useRef(null);
      useEffect(() => {
        // Keep the focus move, but give it back to the header button on close
        // so the keyboard user is not dropped at the top of the document.
        const previous = document.activeElement;
        panelRef.current?.focus?.();
        return () => {
          if (previous instanceof HTMLElement) previous.focus?.();
        };
      }, []);
      return h(
        "div",
        { className: "rsk-layer rsk-pop-layer", "data-renpy-skin": "popover" },
        h(
          "div",
          {
            className: "rsk-panel",
            "data-renpy-panel": "true",
            ref: panelRef,
            tabIndex: -1,
            role: "dialog",
            "aria-label": title,
          },
          h(
            "div",
            { className: "rsk-panel-head" },
            h("div", { className: "rsk-panel-title" }, title),
            h(
              "button",
              { type: "button", className: "rsk-panel-close", "aria-label": t("Close"), onClick: onClose },
              "\u00d7",
            ),
          ),
          children,
        ),
      );
    }

    /**
     * The 「用 Agent 加载」 completion prompt.
     *
     * The agent finishes in another Session, so whatever the user is looking at
     * when the profile lands is where the offer has to appear — that is why this
     * is its own `shell.overlay` layer above the popover and the splash rather
     * than a card inside the settings page. One line and two buttons; the detail
     * stays in the settings page. Escape, the mask and 「先保存」 all mean the
     * same thing: keep the profile for the next load.
     */
    function ProfilePromptLayer() {
      const ui = useStore(uiStore);
      const prompt = ui.profilePrompt;
      if (prompt === undefined) return null;
      const dismiss = () => uiStore.set({ profilePrompt: undefined });
      const apply = () => {
        dismiss();
        // The host rebuilt the manifest when the profile was written, so this
        // reads the cache rather than starting another scan.
        void refreshManifest();
      };
      const name = prompt.name;
      const line =
        prompt.rejected !== null && prompt.rejected !== undefined
          ? t("The agent finished the profile for {name}, but it belongs to a different game folder, so nothing was applied.", { name })
          : prompt.applied > 0
            ? t("The agent finished the profile for {name}: {count} fields corrected.", { name, count: prompt.applied })
            : t("The agent finished the profile for {name}, but corrected nothing the scan got wrong.", { name });
      return h(
        "div",
        {
          className: "rsk-modal rsk-prompt",
          onClick: (event) => {
            if (event.target === event.currentTarget) dismiss();
          },
          onKeyDown: (event) => {
            if (event.key === "Escape") dismiss();
          },
        },
        h(
          PanelShell,
          { title: t("Apply it now?"), onClose: dismiss },
          h("div", { className: "rsk-hint" }, line),
          h(
            "div",
            { className: "rsk-prompt-actions" },
            h(P.Button, { variant: "outline", className: "rsk-action", size: "sm", onClick: dismiss }, t("Later")),
            h(P.Button, { variant: "primary", size: "sm", onClick: apply }, t("Apply now")),
          ),
        ),
      );
    }

    /**
     * The analysed-VN picker: a dropdown of every game ever loaded, the
     * switch-opening toggle, and the Agent-loading stub.
     *
     * Switching is a HOST call (`/library`), not a settings write, because a
     * switch has to drop the previous game's manifest, stage, safe areas and
     * session pin in the same operation — doing it as `saveSettings` + a
     * manifest refetch left the old game's sprites on screen while the new
     * manifest was in flight, which is the "state is still from the last VN"
     * bug. Shared by the header popover and the settings page so both surfaces
     * offer the same list; the re-read button and the directory box belong to
     * the settings page, so they are NOT rendered here.
     */
    function GamePicker({ state, onClose }) {
      const settings = state.settings ?? {};
      const library = Array.isArray(state.library) ? state.library : [];
      const current = settings.gameDir ?? "";
      const [busy, setBusy] = useState(false);
      const set = (patch) => void saveSettings(patch);

      // Every entry is listed, even one that is not in the index yet (a game
      // loaded before this feature existed), so the dropdown always shows the
      // ACTIVE game rather than silently selecting nothing.
      const known = library.some((entry) => entry.gameDir.toLowerCase() === current.toLowerCase());
      const options = known || current.length === 0 ? library : [{ gameDir: current, name: t("Current game") }, ...library];

      const run = (gameDir) => {
        setBusy(true);
        void switchGame(gameDir)
          .then((ok) => {
            if (ok && onClose !== undefined) onClose();
          })
          .finally(() => setBusy(false));
      };

      if (options.length === 0) {
        return h("div", { className: "rsk-hint" }, t("No game has been analysed yet. Load one below."));
      }

      return h(
        "div",
        null,
        h(
          "div",
          { className: "rsk-ctl" },
          h(
            "div",
            { className: "rsk-ctl-text" },
            h("div", { className: "rsk-ctl-label" }, t("Known VNs")),
            h("div", { className: "rsk-ctl-hint" }, t("{count} analysed", { count: options.length })),
          ),
          h(
            "div",
            { className: "rsk-ctl-side" },
            h(
              "select",
              {
                className: "rsk-input",
                style: { flex: "1 1 auto" },
                value: current,
                disabled: busy,
                onChange: (event) => {
                  const next = event.target.value;
                  if (next !== current) run(next);
                },
              },
              options.map((entry) =>
                h(
                  "option",
                  { key: entry.gameDir, value: entry.gameDir },
                  `${entry.name ?? entry.gameDir}${entry.version === undefined ? "" : ` v${entry.version}`}`,
                ),
              ),
            ),
          ),
        ),
        // Sits directly under the switcher because it governs the switcher, not
        // startup: `splashOnStart` is about launching DSH, this is about moving
        // from one VN to another.
        h(SwitchRow, {
          label: t("Replay the opening when switching"),
          hint: t("Show the new game's extracted opening after a switch. Startup is governed by the toggle above."),
          checked: settings.splashOnSwitch === true,
          onChange: (value) => set({ splashOnSwitch: value }),
        }),
      );
    }

    /**
     * The settings the header icon opens.
     *
     * This is deliberately the plugin's OWN surface rather than the DSH settings
     * dialog: the dialog has no documented client API, and the two hops that do
     * reach it (`sidebar.settings`'s entry handle + `slots.resolveStore`) are
     * inspection surfaces that may not be mounted yet. So the popover carries
     * the controls a user reaches for while reading a conversation, and offers
     * the dialog as a deep-link that falls back to the written path when it
     * cannot be reached.
     *
     * Three controls are deliberately NOT here, because they are one-time
     * setup rather than mid-conversation adjustments: the re-read button, the
     * game-directory box, and the language override. They live on the settings
     * page only, which is the surface a user opens to configure the skin.
     */
    function QuickSettings({ state, onClose }) {
      const settings = state.settings ?? {};
      const manifest = state.manifest;
      // Only surfaced after a click actually failed, so a machine where the
      // shell's settings ledger is unreachable still gets the manual route.
      const [linkFailed, setLinkFailed] = useState(false);

      // No `gameDir` rebuild here any more: the directory box and the re-read
      // button both live on the settings page, so nothing in this popover can
      // change which game the host reads.
      const set = (patch) => void saveSettings(patch);

      return h(
        PanelShell,
        { title: t("Quick settings"), onClose },
        h(GamePicker, { state, onClose }),
        h("div", { className: "rsk-divider" }),
        // `showLanguage: false` — see SkinSwitches.
        h(SkinSwitches, { settings, set, showLanguage: false, manifest }),
        h("div", { className: "rsk-divider" }),
        h(PlaybackSettings, { settings, set, manifest }),
        h("div", { className: "rsk-divider" }),
        h(
          "button",
          {
            type: "button",
            className: "rsk-panel-link",
            onClick: () => {
              if (openHostSettings("renpy-skin")) {
                onClose();
                return;
              }
              setLinkFailed(true);
            },
          },
          t("Open the full settings page"),
        ),
        linkFailed
          ? h("div", { className: "rsk-hint" }, t("Full settings live in Settings → Ren'Py skin."))
          : null,
      );
    }

    /**
     * The playlist: the game's own menu theme, then every track it ships under
     * `game/audio/music` (or the nearest audio folder it has).
     */
    function PlaylistPanel({ state, onClose }) {
      const player = useStore(playerStore);
      const manifest = state.manifest;
      const settings = state.settings ?? {};
      const tracks = manifest?.audio?.playlist ?? [];
      const menu = manifest?.audio?.menuMusic ?? [];
      const current = player.source === "playlist" ? tracks[player.index] : undefined;
      const playingMenu = player.source === "menu";
      const set = (patch) => void saveSettings(patch);
      // Mirrors `playbackModeOf()` for rendering; the transport helpers re-read
      // the store themselves so a button click never works from a stale render.
      const mode = playbackModeOf(settings);
      const [filter, setFilter] = useState("");
      const listRef = useRef(undefined);
      // The seek bar is the one control `timeupdate` fights: the element fires
      // ~4 times a second, so echoing `player.time` back into the input makes
      // the handle jump out of the user's grip mid-drag. While the pointer is
      // down the LOCAL draft wins; the release hands control back.
      const seekDrag = useRef(false);
      const [seekDraft, setSeekDraft] = useState(0);

      const needle = filter.trim().toLowerCase();
      const matches =
        needle.length === 0
          ? tracks.map((track, index) => ({ track, index }))
          : tracks
              .map((track, index) => ({ track, index }))
              .filter(
                ({ track }) =>
                  track.title.toLowerCase().includes(needle) || track.path.toLowerCase().includes(needle),
              );

      // Grouped for scanning but kept keyed on the FLAT index: `startTrack`
      // takes a playlist subscript, so a group-local array position would play
      // the wrong track the moment there is more than one group.
      const groups = [];
      const byDirectory = new Map();
      for (const entry of matches) {
        const directory = entry.track.directory ?? "";
        let group = byDirectory.get(directory);
        if (group === undefined) {
          group = { directory, entries: [] };
          byDirectory.set(directory, group);
          groups.push(group);
        }
        group.entries.push(entry);
      }

      const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
      const seekValue = seekDrag.current === true ? seekDraft : Math.min(player.time, duration);

      const seekTo = (value) => {
        if (!Number.isFinite(value)) return;
        const element = audio();
        if (element !== undefined) {
          try {
            element.currentTime = value;
          } catch {
            // Some browsers refuse a seek on a not-yet-seekable stream;
            // the next `timeupdate` re-syncs the display anyway.
          }
        }
        playerStore.set({ time: value });
      };

      // Keep the playing row visible: a 70-track list scrolls well past the
      // panel, so the user could not tell what a Next press actually started.
      useEffect(() => {
        const list = listRef.current;
        if (list === undefined || list === null) return;
        const node = list.querySelector('[data-current="true"]');
        if (node !== null && typeof node.scrollIntoView === "function") {
          node.scrollIntoView({ block: "nearest" });
        }
      }, [player.index, player.source, filter]);

      useEffect(() => {
        const release = () => {
          seekDrag.current = false;
        };
        window.addEventListener("pointerup", release, true);
        window.addEventListener("pointercancel", release, true);
        return () => {
          window.removeEventListener("pointerup", release, true);
          window.removeEventListener("pointercancel", release, true);
        };
      }, []);

      const emptyHint =
        manifest === undefined
          ? t("No game loaded yet.")
          : tracks.length === 0
            ? t("No playable tracks")
            : matches.length === 0
              ? t("No track matches the filter.")
              : undefined;

      return h(
        PanelShell,
        { title: t("Music playlist"), onClose },
        // Deliberately no menu-music controls: this panel is for playback. The
        // switch and the track picker are configuration and live on the
        // settings page — the row that used to sit here made the popover a
        // second settings surface, which is what the round before this one
        // spent its time undoing.
        h(
          "div",
          { className: "rsk-player" },
          h(
            "button",
            {
              type: "button",
              className: "rsk-btn",
              title: t("Previous"),
              disabled: tracks.length === 0,
              onClick: previousTrack,
            },
            h(SkipMark, { back: true }),
          ),
          h(
            "button",
            {
              type: "button",
              className: "rsk-btn",
              title: player.playing ? t("Pause") : t("Play"),
              disabled: tracks.length === 0,
              onClick: togglePlay,
            },
            player.playing ? h(PauseMark, null) : h(PlayMark, null),
          ),
          h(
            "button",
            { type: "button", className: "rsk-btn", title: t("Next"), disabled: tracks.length === 0, onClick: nextTrack },
            h(SkipMark, null),
          ),
          // One button for the four playback modes: order -> repeat all ->
          // repeat one -> shuffle -> order. The visible label names the CURRENT
          // state, so the user reads what happens next instead of decoding a
          // glyph; the title/aria-label carry the same words for hover and
          // screen readers.
          h(
            "button",
            {
              type: "button",
              className: "rsk-btn rsk-mode-btn",
              title: t(PLAYBACK_LABEL[mode]),
              "aria-label": t(PLAYBACK_LABEL[mode]),
              "data-mode": mode,
              "data-active": mode === "order" ? "false" : "true",
              disabled: tracks.length === 0,
              onClick: () => set(PLAYBACK_PATCH[PLAYBACK_NEXT[mode]]),
            },
            h(PlaybackMark, { mode }),
            h("span", null, t(PLAYBACK_LABEL[mode])),
          ),
          h(
            "div",
            { className: "rsk-player-title" },
            player.error ??
              (playingMenu
                ? `${t("Main menu track")} · ${menu[0]?.title ?? ""}`
                : current?.title ??
                  // Nothing selected yet is NOT the same as nothing to play:
                  // `player.index` is -1 after a game switch while the list
                  // below is full, and saying "no playable tracks" there reads
                  // as a broken list.
                  (tracks.length === 0 ? t("No playable tracks") : t("Nothing playing"))),
          ),
          h(
            "span",
            { className: "rsk-stat rsk-nowrap" },
            `${clockTime(seekValue)} / ${clockTime(player.duration)}`,
          ),
        ),
        // A range input, not a SliderRow: the transport row already carries the
        // time readout, and this one commits on every input event because a
        // scrub has to be audible while it happens.
        //
        // The range counts TENTHS of a second so that it needs no `step`: the
        // implicit step of 1 then lands on 0.1s, which is finer than the 0.5s
        // the old `step: 0.5` allowed while still keeping the attribute out.
        h(
          "div",
          { className: "rsk-seek" },
          h("input", {
            type: "range",
            min: 0,
            max: duration > 0 ? Math.round(duration * 10) : 1,
            value: Math.round(seekValue * 10),
            disabled: duration <= 0,
            "aria-label": t("Seek"),
            "aria-valuetext": `${clockTime(seekValue)} / ${clockTime(player.duration)}`,
            onPointerDown: () => {
              seekDrag.current = true;
              setSeekDraft(Math.min(player.time, duration));
            },
            onChange: (event) => {
              const next = Number(event.target.value) / 10;
              setSeekDraft(next);
              // Only a pointer drag is deferred to the release; a keyboard press
              // arrives as a change with no pointer, so it seeks immediately.
              // This row is the "effect that cannot keep up with a drag" half of
              // the slider contract in AGENTS.md: re-cueing the audio dozens of
              // times a second would stutter, so the effect lands with the save.
              if (seekDrag.current !== true) seekTo(next);
            },
            onPointerUp: (event) => {
              seekDrag.current = false;
              seekTo(Number(event.currentTarget.value) / 10);
            },
            onKeyUp: (event) => seekTo(Number(event.currentTarget.value) / 10),
          }),
        ),
        h(SliderRow, {
          // Same whole-percent scale as the settings row, for the same reason:
          // no `step` to declare, and 1% granularity instead of 5%.
          label: t("Playlist volume"),
          value: Math.round((typeof settings.playlistVolume === "number" ? settings.playlistVolume : 0.6) * 100),
          min: 0,
          max: 100,
          format: (v) => `${Math.round(v)}%`,
          onPreview: (v) => {
            const next = Math.round(v) / 100;
            applyVolume(next);
            previewSettings({ playlistVolume: next });
          },
          onChange: (v) => {
            const next = Math.round(v) / 100;
            applyVolume(next);
            set({ playlistVolume: next });
          },
        }),
        emptyHint !== undefined
          ? h(
              "div",
              { className: "rsk-hint", style: { marginTop: 8 } },
              emptyHint,
              // An empty list with no way out is a dead end: the switch that
              // turns the music on lives in the settings panel.
              manifest !== undefined && tracks.length === 0
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "rsk-panel-link",
                      style: { marginTop: 8 },
                      onClick: () => uiStore.set({ panel: "settings" }),
                    },
                    t("Go to settings"),
                  )
                : null,
            )
          : h(
              "div",
              null,
              h(
                "div",
                { className: "rsk-player", style: { marginTop: 10 } },
                h("input", {
                  className: "rsk-input",
                  // `flex-basis: 0`, not `auto`: `.rsk-input` is `width: 100%`,
                  // and an `auto` basis resolves to that width, which leaves the
                  // track count beside it almost no room.
                  style: { flex: "1 1 0%", minWidth: 0 },
                  type: "search",
                  placeholder: t("Filter tracks"),
                  "aria-label": t("Filter tracks"),
                  value: filter,
                  onChange: (event) => setFilter(event.target.value),
                }),
                h("span", { className: "rsk-stat rsk-nowrap" }, t("{count} tracks", { count: matches.length })),
              ),
              h(
                "div",
                { className: "rsk-tracklist", ref: listRef },
                groups.map((group) =>
                  h(
                    "div",
                    { key: group.directory, className: "rsk-track-group" },
                    // A single-group list is the common case, so the heading is
                    // only worth a row when it actually distinguishes anything.
                    groups.length <= 1
                      ? null
                      : h("div", { className: "rsk-track-group-head" }, group.directory.length === 0 ? t("Other") : group.directory),
                    group.entries.map(({ track, index }) => {
                      const isCurrent = player.source === "playlist" && player.index === index;
                      return h(
                        "button",
                        {
                          key: track.path,
                          type: "button",
                          className: "rsk-track",
                          "data-current": isCurrent ? "true" : "false",
                          "data-path": track.path,
                          title: `${track.title}${track.duration === undefined ? "" : ` · ${clockTime(track.duration)}`}`,
                          onClick: () => startTrack(track, "playlist", index),
                        },
                        h("span", { className: "rsk-track-index" }, isCurrent ? "\u25b8" : String(index + 1)),
                        h("span", { className: "rsk-track-name" }, track.title),
                        h("span", { className: "rsk-track-time" }, track.duration === undefined ? "" : clockTime(track.duration)),
                      );
                    }),
                  ),
                ),
              ),
            ),
      );
    }

    /**
     * The popover host. Both panels render here rather than inside the header
     * bar, which is a small element with its own overflow and stacking context.
     */
    /**
     * The header's memory panel: the same editor the settings page shows, in
     * the popover chrome, so a note can be recorded without leaving the scene.
     */
    function MemoryPanel({ state, onClose }) {
      const manifest = state.manifest;
      return h(
        PanelShell,
        { title: t("Character memory"), onClose },
        manifest === undefined
          ? h("div", { className: "rsk-hint" }, t("Load a game to keep memories of its characters."))
          : h(MemoryEditor, { manifest }),
      );
    }

    function PopoverLayer() {
      const ui = useStore(uiStore);
      const state = useStore(store);
      const panel = ui.panel;

      useEffect(() => {
        if (panel === undefined) return undefined;
        const close = () => uiStore.set({ panel: undefined });
        const onKey = (event) => {
          if (event.key === "Escape") close();
        };
        const onPointer = (event) => {
          const target = event.target;
          // A header click must not close the panel: the button's own click
          // handler toggles it, and closing here would make the second click
          // reopen instead of dismiss.
          if (target instanceof Element && target.closest('[data-renpy-panel], [data-renpy-skin="header"]') !== null) return;
          close();
        };
        document.addEventListener("keydown", onKey);
        document.addEventListener("pointerdown", onPointer, true);
        return () => {
          document.removeEventListener("keydown", onKey);
          document.removeEventListener("pointerdown", onPointer, true);
        };
      }, [panel]);

      if (panel === undefined) return null;
      const onClose = () => uiStore.set({ panel: undefined });
      if (panel === "music") return h(PlaylistPanel, { state, onClose });
      if (panel === "memory") return h(MemoryPanel, { state, onClose });
      return h(QuickSettings, { state, onClose });
    }

    /**
     * Resolve what the opening overlay plays.
     *
     * A user-chosen `splashMedia` wins over the extracted one. A bare path goes
     * through the plugin's own `/asset` route so that a file inside a `.rpa`
     * archive is served too; an absolute URL is passed through untouched.
     *
     * `assetToken` is the host's per-build cache key. Without it a bare path
     * that happens to exist in two games would keep playing the first game's
     * file, because the URL — and therefore the browser cache entry — is
     * identical.
     */
    function splashMediaFor(splash, override, assetToken) {
      const chosen = typeof override === "string" ? override.trim() : "";
      const version = typeof assetToken === "string" && assetToken.length > 0
        ? `v=${encodeURIComponent(assetToken)}&`
        : "";
      if (chosen.length > 0) {
        const url = /^(https?:|\/|data:)/i.test(chosen) ? chosen : `${ROUTE}/asset?${version}p=${encodeURIComponent(chosen)}`;
        return { kind: /\.(webm|mp4|ogv|mkv|mov)([?#]|$)/i.test(chosen) ? "video" : "image", url, source: "custom" };
      }
      if (splash === undefined || splash.found !== true) return undefined;
      if (splash.kind === "video" && splash.url !== undefined) return { kind: "video", url: splash.url, source: splash.source };
      if (splash.kind === "image" && splash.url !== undefined) return { kind: "image", url: splash.url, source: splash.source };
      return undefined;
    }

    /**
     * How long to leave a still opening on screen.
     *
     * The host measures this from the splash label's own `timer <n>`, which is
     * how Ren'Py itself decides when an interactive splash is over. The fallback
     * only covers a game that never says — and the cap exists so a stray large
     * `timer` cannot pin the shell.
     */
    const FALLBACK_SPLASH_SECONDS = 4;
    const MAX_SPLASH_SECONDS = 12;

    function splashSeconds(splash) {
      const declared = splash?.duration;
      if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) {
        return Math.min(declared, MAX_SPLASH_SECONDS);
      }
      return FALLBACK_SPLASH_SECONDS;
    }

    /**
     * Fade the shell in as the opening fades out.
     *
     * Done by class on `<html>` rather than by re-rendering: the shell belongs
     * to DSH, and a plugin animating its own wrapper would fight the layout. The
     * class is removed as soon as the animation is over so it cannot linger into
     * an unrelated re-render.
     */
    function revealMainUi() {
      try {
        const root = document.documentElement;
        root.classList.remove("rsk-main-reveal");
        // Reading offsetWidth restarts the animation when two splashes land
        // back to back (a game switch), which a class toggle alone would not.
        void root.offsetWidth;
        root.classList.add("rsk-main-reveal");
        window.setTimeout(() => root.classList.remove("rsk-main-reveal"), SPLASH_FADE_MS + 200);
      } catch {
        // A missing document (a test harness) must not break the dismiss path.
      }
    }

    /** Fade-out length for the overlay; also the shell's fade-in length. */
    const SPLASH_FADE_MS = 420;

    /**
     * Upper bound for a cutscene that never reports `ended`.
     *
     * A video normally ends itself, so this only fires when the browser never
     * started it (a codec the renderer rejects, or a request still being served
     * out of a large `.rpa`). Generous on purpose: cutting a real opening short
     * is a worse failure than a slow hand-off.
     */
    const VIDEO_SPLASH_BACKSTOP_MS = 180000;

    /**
     * The game's opening, replayed full frame on DSH startup.
     *
     * It waits for the manifest: the setting can only be honoured once the host
     * has said what the game's `label splashscreen:` contains. It then fires
     * exactly once per page load — a re-mount must not replay the opening — and
     * a `kind: "video"` splash falls back to the still when the browser refuses
     * to start it unmuted.
     *
     * A still MUST be given a deadline. An `<img>` never fires `ended`, so the
     * old code left an image splash on screen until the user clicked — which is
     * the reported "stuck on the splash forever" bug, and it looked permanent
     * because the hint was easy to miss. The game's own `timer <n>` wins, the
     * fallback is a few seconds, and a separate watchdog covers the case where
     * the media never loads at all (a 404, a codec the browser rejects, or a
     * file still being scanned out of a large `.rpa`).
     */
    function SplashLayer() {
      const state = useStore(store);
      const settings = state.settings ?? {};
      const [media, setMedia] = useState(undefined);
      const [visible, setVisible] = useState(false);
      const [fading, setFading] = useState(false);
      const videoRef = useRef(null);

      // Decide the STARTUP opening, once per page load. A game switch does not
      // come through here: `resetForNewGame(true)` arms `splashWanted` itself,
      // which is what keeps the two toggles independent.
      useEffect(() => {
        if (splashAttempted === true) return;
        if (state.settings === undefined) return;
        splashAttempted = true;
        if (settings.enabled !== false && settings.splashOnStart === true) splashWanted = true;
      }, [state.settings]);

      // Consume the request. `splashWanted` is the ONLY trigger, so a manifest
      // refresh for an unrelated reason can never replay the opening.
      useEffect(() => {
        if (state.settings === undefined || state.manifest === undefined) return;
        if (splashWanted !== true) return;
        splashWanted = false;
        if (settings.enabled === false) return;
        setMedia(splashMediaFor(state.manifest.splash, settings.splashMedia, state.manifest.assetToken));
        setFading(false);
        setVisible(true);
      }, [state.settings, state.manifest]);

      // Dissolve one frame then unmount, so the overlay does not blink out.
      const dismiss = () => {
        if (fading === true) return;
        setFading(true);
        // Pause rather than tear down: the last frame still has to survive the
        // fade. Without this a skipped cutscene keeps its own soundtrack playing
        // underneath the menu music that the very same click starts.
        if (videoRef.current !== null && videoRef.current !== undefined) videoRef.current.pause();
        revealMainUi();
        window.setTimeout(() => {
          setVisible(false);
          setFading(false);
        }, SPLASH_FADE_MS);
      };

      useEffect(() => {
        if (!visible) return undefined;
        const video = videoRef.current;
        if (video !== null && video !== undefined) {
          // A cutscene carries its own audio and a browser refuses an unmuted
          // autoplay, so try it properly first and only fall back to muted:
          // a silent opening beats a black rectangle.
          const started = video.play();
          if (started !== undefined && typeof started.catch === "function") {
            started.catch(() => {
              video.muted = true;
              void video.play().catch(() => undefined);
            });
          }
        }
        // Unmounting removes the `<video>` from the document, and a detached
        // media element goes on playing: the opening's audio would outlive the
        // opening. `media` is a dependency too, so swapping the source tears the
        // old stream down instead of layering the two.
        return () => silence(video);
      }, [visible, media]);

      // The deadline. This is the fix for "stuck on the opening forever": an
      // `<img>` never fires `ended`, so a still with no bound never leaves on
      // its own. A cutscene normally ends by itself, hence the much longer
      // backstop — it only covers media that never starts at all.
      useEffect(() => {
        if (!visible) return undefined;
        if (media !== undefined && media.kind === "video") {
          const backstop = window.setTimeout(() => dismiss(), VIDEO_SPLASH_BACKSTOP_MS);
          return () => window.clearTimeout(backstop);
        }
        const seconds = splashSeconds(state.manifest?.splash);
        const timer = window.setTimeout(() => dismiss(), Math.round(seconds * 1000));
        return () => window.clearTimeout(timer);
      }, [visible, media, state.manifest]);

      if (!visible) return null;
      const skipOnClick = settings.splashSkipOnClick !== false;
      const fallbackImage = state.manifest?.splash?.images?.[0];

      return h(
        "div",
        { className: "rsk-layer", "data-renpy-skin": "splash-layer" },
        h(
          "div",
          {
            className: "rsk-splash",
            "data-renpy-skin": "splash",
            "data-fading": fading === true ? "true" : undefined,
            onClick: skipOnClick ? dismiss : undefined,
          },
          media === undefined
            ? h("div", { className: "rsk-splash-fallback" }, t("No splash screen was found in this game."))
            : media.kind === "video"
              ? h("video", {
                  ref: videoRef,
                  className: "rsk-splash-media",
                  src: media.url,
                  autoPlay: true,
                  playsInline: true,
                  onEnded: dismiss,
                  onError: () => {
                    // A codec the browser cannot decode: show the still the game
                    // shipped instead of leaving the user on a black frame.
                    if (fallbackImage !== undefined) setMedia({ kind: "image", url: fallbackImage.url, source: "splashscreen" });
                    else dismiss();
                  },
                })
              : h("img", {
                  className: "rsk-splash-media",
                  src: media.url,
                  alt: t("Opening"),
                  draggable: false,
                  // A broken image would otherwise hold the frame until the
                  // deadline; this drops it the moment it is known to be broken.
                  onError: dismiss,
                }),
          skipOnClick ? h("div", { className: "rsk-splash-hint" }, t("Click anywhere to skip")) : null,
        ),
      );
    }

    /**
     * Start whatever the user asked to hear, on the first real interaction.
     *
     * Both the browser's autoplay policy and the user's own settings decide
     * this: the game's menu theme first (that is the "follow the game"
     * behaviour), and the playlist only when it was asked to autoplay. The
     * manifest may still be in flight when the click lands, so the wait is
     * bounded rather than one-shot.
     */
    function startOnFirstGesture() {
      const attempt = (triesLeft) => {
        const state = store.get();
        const settings = state.settings ?? {};
        if (state.manifest === undefined && triesLeft > 0) {
          window.setTimeout(() => attempt(triesLeft - 1), 200);
          return;
        }
        if (settings.enabled === false) return;
        const track = menuTrack();
        if (settings.menuMusicOnStart === true && track !== undefined) {
          startTrack(track, "menu", -1);
          return;
        }
        if (settings.playlistAutoplay === true) togglePlay();
      };
      attempt(50);
    }

    // ── plugins ────────────────────────────────────────────────────────────

    /**
     * Register the header strip and the two overlays it drives.
     *
     * `conversation.session.header.utilities` is documented as rendering with
     * empty props, so nothing here can be passed in — the buttons reach the
     * plugin's own stores instead.
     */
    function applyHeader(ctx) {
      // The header slot hands an occupant no props, so the quick-settings panel
      // reaches the shell's settings dialog through this captured context.
      runtimeCtx = ctx;
      ctx.slots.inject("conversation.session.header.utilities", () =>
        ctx.slots.register(
          {
            name: "conversation.session.header.utilities",
            id: "renpy-skin",
            order: 60,
            label: () => t("Ren'Py settings"),
            registrant: "dsh-renpy-skin",
          },
          HeaderUtilities,
        ),
      );
      // The buttons' fallback home. The platform's own slot contract describes
      // this seat as "Global navigation before the Session title, available
      // without a Session" and lists no occupants, so it is the one header seat
      // that survives a Sessionless header — where the utilities row above does
      // not exist at all and the buttons used to disappear with it.
      ctx.slots.inject("conversation.header.leading", () =>
        ctx.slots.register(
          {
            name: "conversation.header.leading",
            id: "renpy-skin:header-fallback",
            order: 60,
            label: () => t("Ren'Py settings"),
            registrant: "dsh-renpy-skin",
          },
          HeaderFallback,
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "renpy-skin:popover", order: -880, registrant: "dsh-renpy-skin" },
          PopoverLayer,
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "renpy-skin:splash", order: -870, registrant: "dsh-renpy-skin" },
          SplashLayer,
        ),
      );
      // Above the popover and the splash: the offer to re-skin from the agent's
      // profile has to be reachable from wherever the user ended up, including
      // inside the Session the agent itself is working in.
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "renpy-skin:profile-prompt", order: -860, registrant: "dsh-renpy-skin" },
          ProfilePromptLayer,
        ),
      );
      // Every listener is installed once and removed on the first gesture, so
      // nothing stays attached for the rest of the session.
      ctx.effect(() => {
        if (typeof document === "undefined") return undefined;
        let done = false;
        const arm = () => {
          if (done) return;
          done = true;
          for (const type of ["pointerdown", "keydown"]) document.removeEventListener(type, arm, true);
          startOnFirstGesture();
        };
        for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, arm, true);
        return () => {
          for (const type of ["pointerdown", "keydown"]) document.removeEventListener(type, arm, true);
        };
      }, "dsh-renpy-skin: first-gesture autoplay");
      // The persisted volume is the source of truth, and it arrives with the
      // settings rather than before them — a player created at the default
      // would otherwise stay at 0.6 for the whole session.
      ctx.effect(() => {
        const sync = () => {
          const volume = store.get().settings?.playlistVolume;
          if (typeof volume !== "number") return;
          if (volume === playerStore.get().volume) return;
          playerStore.set({ volume });
          const element = audio();
          if (element !== undefined) element.volume = volume;
        };
        const unsubscribe = store.subscribe(sync);
        sync();
        return unsubscribe;
      }, "dsh-renpy-skin: player volume");
      // Quitting DSH tears the renderer down asynchronously, so an element left
      // playing keeps its audio process alive until the whole app has exited —
      // the user heard the track for seconds after the window closed.
      //
      // The mechanism that matters is `stopMedia()` releasing the source rather
      // than only pausing. Which unload event the host actually delivers is a
      // host detail: its `close` handler hides the window instead of closing it
      // (app.asar `window.on("close", ...)` -> `hideMainWindow`), and quit hides
      // it once more before `app.quit()`. So all three events are bound rather
      // than betting on one. It is deliberately NOT bound to `visibilitychange`:
      // minimising, or switching workspace, also hides the window and neither
      // must stop the music.
      ctx.effect(() => {
        if (typeof window === "undefined") return undefined;
        const silence = () => stopMedia();
        window.addEventListener("pagehide", silence);
        window.addEventListener("beforeunload", silence);
        // Deprecated, but still the last event a renderer reliably delivers
        // during a native-window teardown, which is the reported case.
        window.addEventListener("unload", silence);
        return () => {
          window.removeEventListener("pagehide", silence);
          window.removeEventListener("beforeunload", silence);
          window.removeEventListener("unload", silence);
        };
      }, "dsh-renpy-skin: silence on unload");
    }

    function applyBackground(ctx) {
      // The background is NOT registered here — see
      // `applyConversationBackground`. `shell.overlay` is a full-frame layer at
      // `z-index: 20`, above the sidebar and the message column, so a background
      // placed there dims the whole shell and covers the text.
      applyConversationBackground(ctx);
      // The stage has the same problem for the same reason, and is likewise
      // appended inside the conversation body instead of the shell overlay.
      applyStageLayer(ctx);
      // Above the stage, below the popover: the say screen's own furniture sits
      // on the composer, which the shell paints over everything else in this
      // layer, so it has to come after the sprites but must not cover the
      // plugin's panels.
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "renpy-skin:modules", order: -890, registrant: "dsh-renpy-skin" },
          ModulesLayer,
        ),
      );
    }

    function applyTheme(ctx) {
      ctx.effect(() => {
        let disposeTokens;
        let applied;
        const sync = () => {
          const state = store.get();
          const settings = state.settings ?? {};
          const manifest = state.manifest;
          // Disposing and re-applying the token override on every store
          // notification re-wrote the whole theme ~once a second. Key the work
          // on what the override actually depends on.
          const want =
            settings.enabled === false || settings.themeTokens === false
              ? undefined
              : manifest?.theme;
          const key = want === undefined ? "" : JSON.stringify([settings.themeTokens, want]);
          if (key === applied) return;
          applied = key;
          if (disposeTokens !== undefined) {
            disposeTokens();
            disposeTokens = undefined;
          }
          if (want === undefined) return;
          disposeTokens = ctx.theme.overrideTokens("dsh-renpy-skin", want);
        };
        const unsubscribe = store.subscribe(sync);
        sync();
        return () => {
          unsubscribe();
          if (disposeTokens !== undefined) disposeTokens();
        };
      }, "dsh-renpy-skin: theme tokens");
    }

    function applySettingsPage(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "renpy-skin",
            order: 120,
            label: () => t("Ren'Py skin"),
            registrant: "dsh-renpy-skin",
          },
          SettingsPage,
        ),
      );
    }

    /**
     * Look up the locale service without ever throwing.
     *
     * `ctx.locale` is a GATED property — reading it while `locale` is absent
     * from `exports.inject` throws `cannot get property "locale" without
     * inject`. `ctx.get("locale")` is the ungated lookup, but it is only a
     * convention: a live report showed the error surfacing out of
     * `service.register(...)` with the same gated-property message, so the
     * lookup is wrapped too. `locale` must NOT be added to `inject`: that would
     * make it a REQUIRED service and a profile without it would refuse to load
     * the whole skin, which is the opposite of the degrade-gracefully contract.
     */
    function localeServiceOf(ctx) {
      try {
        if (typeof ctx.get === "function") return ctx.get("locale");
      } catch {
        // A gated property read is an expected outcome here, not a failure.
      }
      try {
        return ctx.locale;
      } catch {
        return undefined;
      }
    }

    function applyLocale(ctx) {
      const service = localeServiceOf(ctx);
      if (service === undefined) return;
      try {
        attachLocale(service);
      } catch (error) {
        console.error("[dsh-renpy-skin] locale attach failed", error);
      }
      if (typeof service.register !== "function") return;
      ctx.effect(() => {
        let off;
        try {
          // The shipped contract is `register(ns, { zh, en })` — one call, all
          // locales. The 3-arg `register(ns, id, dict)` form never ran, so the
          // namespace was silently absent from the shared catalog.
          off = service.register(LOCALE_NS, { zh, en: {} });
        } catch (error) {
          console.error("[dsh-renpy-skin] locale registration failed", error);
        }
        return () => {
          try {
            if (typeof off === "function") off();
          } catch {
            // Unsubscribing an already-disposed namespace must not throw.
          }
        };
      }, "dsh-renpy-skin: locale");
    }

    /**
     * The dialogue-box and choice-menu skins.
     *
     * Every declaration they write needs `!important` AND an element selector.
     * A custom property resolves to the NEAREST declaration, and the shell
     * declares these names on `<body>` (the wallpaper engine redeclares some of
     * them behind its own attribute selectors), so the `:root` block this used
     * to write reached nothing: measured on the live page, `--dsw-specific-bubble`
     * was ours at `<html>` and the host's at the bubble that reads it. The
     * selectors below are un-hashed attributes the shipped UI sets
     * (`data-chat-flow-kind`, `data-composer-card`, `data-composer-seat`,
     * `data-conversation-content`), which is what keeps the skin intact across
     * DSH rebuilds.
     */
    /** `#rrggbb` + alpha -> `rgba(r,g,b,a)`; already-rgba strings pass through. */
    function fillWithOpacity(fill, opacity) {
      if (fill === undefined || fill === null) return "rgba(0,0,0,0.62)";
      const match = /^#([0-9a-f]{6})$/i.exec(fill);
      if (match === null) return fill; // rgba(...) or other colour, use verbatim
      const r = parseInt(match[1].slice(0, 2), 16);
      const g = parseInt(match[1].slice(2, 4), 16);
      const b = parseInt(match[1].slice(4, 6), 16);
      const a = typeof opacity === "number" && opacity >= 0 && opacity <= 1 ? opacity : 0.62;
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }

    /**
     * Relative luminance of an `#rrggbb` colour, or `undefined` for anything
     * else (an `rgb()` string, a named colour, a missing value).
     */
    function luminanceOf(color) {
      const match = /^#([0-9a-f]{6})$/i.exec(String(color ?? ""));
      if (match === null) return undefined;
      const channel = (offset) => {
        const value = parseInt(match[1].slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    }

    /**
     * The font stack the game's own face is prepended to. Latin-only game fonts
     * (Ren'Py's default `DejaVuSans`, or a VN's Trebuchet) carry no CJK glyphs,
     * so the fallbacks have to cover them or every Chinese label turns into
     * tofu.
     */
    const GAME_FONT_FALLBACK =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif';

    /**
     * One of the game's plates: its own image when it ships one, a translucent
     * fill otherwise (the `gui.textbox_fill` / `gui.textbox_opacity` pair).
     */
    function plateOf(image, fill, opacity) {
      return typeof image === "string" && image.length > 0 ? { image } : { fill: fillWithOpacity(fill, opacity) };
    }

    /**
     * Paint a plate on an element the shell owns.
     *
     * This cannot go through a custom property: the shell paints these boxes
     * with the `background` SHORTHAND, and a `url()` in that shorthand tiles the
     * art at its intrinsic size (the game's textbox is 1920px wide). The art is
     * authored on the game's own canvas, so stretching it to the element is what
     * makes one textbox fill a 600px message.
     */
    function plateRule(selector, plate, { size = "100% 100%", position = "center" } = {}) {
      if (plate.image !== undefined) {
        return (
          `${selector} { background-image: url("${plate.image}") !important; background-size: ${size} !important;` +
          ` background-position: ${position} !important; background-repeat: no-repeat !important; background-color: transparent !important; }`
        );
      }
      return `${selector} { background-image: none !important; background-color: ${plate.fill} !important; }`;
    }

    /**
     * The game's textbox plate is applied only to the composer, and the composer
     * is reshaped into a flat full-width textbox: no outer padding, no card
     * shadow or rounding, VN text insets, and the stats dock folded into the
     * button row. Everything is scoped through the composer's own `data-*`
     * hooks (the hashed class names change per DSH build), and nothing here can
     * match a conversation message.
     */
    /**
     * Where the composer's say box sits, in canvas pixels, plus the `cqw`
     * converter that maps those pixels onto the pane.
     *
     * `dialogboxRules` paints the plate with these numbers and the module layer
     * draws the scan's extra pieces (name plate, quick-menu buttons) over it;
     * the two have to agree on where the box is and how large one canvas pixel
     * is, so both read them from here instead of computing their own.
     *
     * The unit is sized so that the painted plate exactly spans the composer:
     * one canvas pixel is `unit` percent of the seat's width, which is why
     * everything below is expressed in `cqw`.
     *
     * Only once the conversation has begun. A new session shows the shell's own
     * composer (the hero phase); the game's say box takes over with the first
     * message. The shell tags the phase on an ancestor of the composer.
     */
    function composerGeometry(dialogbox, layout, screenWidth, screenHeight) {
      const active = ':is([data-phase="active"], [data-content-phase="active"]) ';
      const seat = `${active}[data-composer-seat]`;
      const root = `${active}div:has(> [data-composer-card])`;
      const card = `${active}[data-composer-card]`;
      const plate = plateOf(dialogbox.textboxImage, dialogbox.fill, dialogbox.opacity);
      const canvasW = screenWidth > 0 ? screenWidth : undefined;
      const canvasH = screenHeight > 0 ? screenHeight : undefined;
      const windowH = typeof layout?.textboxHeight === "number" && layout.textboxHeight > 0 ? layout.textboxHeight : dialogbox.height;
      if (canvasW === undefined || canvasH === undefined || !(windowH > 0)) return { seat, root, card, plate };

      const image = plate.image !== undefined;
      const bounds = dialogbox.textboxImageBounds;
      const imageW = image && bounds?.width > 0 ? bounds.width : canvasW;
      const imageH = image && bounds?.height > 0 ? bounds.height : windowH;
      const painted = dialogbox.textboxImageBox;
      const box = image ? (painted ?? { x: 0, y: 0, width: imageW, height: imageH }) : { x: 0, y: 0, width: canvasW, height: windowH };
      // The window sits at `gui.textbox_yalign` of the canvas, and the image at
      // its own `xalign`/`yalign` inside that window (the template's 0.5 / 1.0
      // unless the game says otherwise).
      const imageAlign = dialogbox.textboxImageAlign ?? { x: 0.5, y: 1 };
      const windowTop = (canvasH - windowH) * (typeof layout?.textboxYalign === "number" ? layout.textboxYalign : 1);
      const boxLeft = image ? (canvasW - imageW) * imageAlign.x + box.x : 0;
      const boxTop = image ? windowTop + (windowH - imageH) * imageAlign.y + box.y : windowTop;
      // Whatever hangs below the canvas is off screen in the game too.
      const visibleHeight = Math.max(1, Math.min(box.height, canvasH - boxTop));
      const unit = 100 / box.width;
      return {
        seat,
        root,
        card,
        plate,
        image,
        imageW,
        imageH,
        canvasW,
        box,
        boxLeft,
        boxTop,
        windowTop,
        visibleHeight,
        cq: (value) => `${(value * unit).toFixed(3)}cqw`,
      };
    }

    function dialogboxRules(dialogbox, layout, screenWidth, screenHeight) {
      const geometry = composerGeometry(dialogbox, layout, screenWidth, screenHeight);
      const { seat, root, card, plate } = geometry;

      // The composer is one flex line-set: the input on its own line, then
      // tools · stats dock · trailing controls on the next, spread by
      // `space-between`. The shell renders the card and the dock as siblings of
      // each other and the button row inside the card, so the card itself
      // dissolves (`display: contents`) and the dock is centred over the row.
      //
      // The ROW must keep a real box. The shell measures it — `observeControlRow`
      // reads `row.getBoundingClientRect().width` and collapses the model chip to
      // a bare icon when the children do not fit. Dissolving the row too made
      // that width 0, so `needed > available` was always true and the chip
      // collapsed in every conversation, however wide the pane.
      const rules = [
        // `space-between` at the ROOT, not just in the row: the card dissolves
        // into this box, so the input and the button row are its two children —
        // the input takes the top of the plate and the row is pushed to the
        // bottom, which is where the game's own textbox keeps its controls.
        `${root} { display: flex !important; flex-direction: column !important; align-items: stretch !important;` +
          ` justify-content: space-between !important; position: relative; padding: 0 !important; }`,
        `${card} { display: contents !important; }`,
        `${card} > [data-input-scroll] { flex: 1 1 auto !important; width: 100% !important; box-sizing: border-box; min-width: 0; }`,
        `${card} > div:last-child { display: flex !important; flex: none !important; width: 100% !important; box-sizing: border-box; align-items: center !important; justify-content: space-between !important; }`,
        `${card} > div:last-child > * { margin: 2px 8px 6px; }`,
        // The dock is a sibling of the card, so it cannot sit between the row's
        // two children by order alone; centring it over them keeps the shell's
        // own left-to-right grouping (tools, stats, model) that the row paints.
        `${root} > div:has(> [data-slot="conversation.composer.dock"]) { position: absolute !important; left: 50% !important; bottom: 4px !important;` +
          ` transform: translateX(-50%) !important; margin: 0 !important; padding: 0 !important; }`,
        // On a narrow pane the centred dock would land on top of the tools and
        // the model chip; the row's own contents matter more than the stats.
        `@container (max-width: 620px) { ${root} > div:has(> [data-slot="conversation.composer.dock"]) { display: none !important; } }`,
      ];

      if (geometry.cq === undefined) {
        rules.push(plateRule(root, plate));
        return rules;
      }

      // Everything below is in canvas pixels, turned into `cqw` of the composer
      // so the box keeps the game's proportions at any pane width. The unit is
      // sized so that the painted plate exactly spans the composer.
      const { image, imageW, imageH, canvasW, box, boxLeft, boxTop, windowTop, visibleHeight, cq } = geometry;

      rules.push(`${seat} { container-type: inline-size; }`);
      if (image) {
        rules.push(
          `${root} { background-image: url("${plate.image}") !important; background-repeat: no-repeat !important; background-color: transparent !important;` +
            ` background-size: ${cq(imageW)} auto !important;` +
            ` background-position: left ${cq(-box.x)} top ${cq(-box.y)} !important; }`,
        );
      } else {
        rules.push(plateRule(root, plate));
      }
      // A fixed box like the game's: a long message scrolls inside it instead of growing
      // past the plate (the plate image is one fixed size and cannot stretch upward).
      rules.push(
        `${root} { height: ${cq(visibleHeight)} !important; min-height: 0 !important; }`,
        `${card} > [data-input-scroll] { max-height: calc(${cq(visibleHeight)} - 44px) !important; overflow-y: auto !important; }`,
      );

      const left = Math.max(0, (typeof layout?.dialogueXpos === "number" ? layout.dialogueXpos : 0) - boxLeft);
      const top = Math.max(0, windowTop + (typeof layout?.dialogueYpos === "number" ? layout.dialogueYpos : 0) - boxTop);
      const textWidth = typeof layout?.dialogueWidth === "number" && layout.dialogueWidth > 0 ? layout.dialogueWidth : canvasW;
      const right = Math.max(0, boxLeft + box.width - ((typeof layout?.dialogueXpos === "number" ? layout.dialogueXpos : 0) + textWidth));
      rules.push(
        `${card} [data-composer-input] { padding-top: ${cq(top)} !important; padding-left: ${cq(left)} !important; padding-right: ${cq(right)} !important; }`,
        `${card} [data-composer-placeholder] { top: ${cq(top)} !important; left: ${cq(left)} !important; right: ${cq(right)} !important; }`,
      );

      // The say text's own look: colour, size on the canvas (never below the
      // shell's own 14px) and alignment.
      const xalign = typeof layout?.dialogueTextXalign === "number" ? layout.dialogueTextXalign : 0;
      const align = xalign >= 0.75 ? "right" : xalign >= 0.25 ? "center" : "left";
      const size = typeof dialogbox.textSize === "number" && dialogbox.textSize > 0 ? `font-size: max(14px, ${cq(dialogbox.textSize)}) !important; line-height: 1.5 !important;` : "";
      const color = typeof dialogbox.textColor === "string" && dialogbox.textColor.length > 0 ? dialogbox.textColor : undefined;
      rules.push(
        `${card} [data-composer-input] { ${color === undefined ? "" : `color: ${color} !important; caret-color: ${color};`} ${size} text-align: ${align} !important; }`,
        `${card} [data-composer-placeholder] { height: auto !important; ${color === undefined ? "" : `color: color-mix(in srgb, ${color} 55%, transparent) !important;`} ${size} text-align: ${align} !important; }`,
      );
      return rules;
    }

    /**
     * The face the user picked for the whole UI, as a ready `font-family` value
     * plus the `@font-face` block it needs (none for a system family), or
     * `undefined` when nothing is picked and the game's own face applies.
     *
     * A VN font gets a family name derived from its path. Re-pointing one fixed
     * name at a different file leaves room for the engine to keep the face it
     * already resolved for that name; a name per file cannot be confused with
     * another and makes the change take effect the moment the style is swapped.
     */
    function chosenFont(manifest, settings) {
      const selected = typeof settings.composerFont === "string" ? settings.composerFont.trim() : "";
      if (selected.length === 0) return undefined;
      const gameFont = (manifest.fonts ?? []).find((font) => font.path === selected);
      if (gameFont?.url !== undefined) {
        let hash = 5381;
        for (let i = 0; i < selected.length; i += 1) hash = ((hash * 33) ^ selected.charCodeAt(i)) >>> 0;
        const family = `RenPySkinFont${hash.toString(36)}`;
        return {
          block: `@font-face { font-family: "${family}"; src: url("${gameFont.url}"); font-display: swap; }`,
          value: `"${family}", ${GAME_FONT_FALLBACK}`,
        };
      }
      const family = selected.replace(/[^a-zA-Z0-9 _-]/g, "").trim();
      if (family.length === 0) return undefined;
      return { block: undefined, value: `"${family}", ${GAME_FONT_FALLBACK}` };
    }

    function buildSkinCss(manifest, settings) {
      const dialogbox = manifest.dialogbox ?? {};
      const accent = manifest.theme?.["--dsw-alias-brand-primary"]?.dark ?? "#4a9eff";
      const blocks = [];
      const vars = [];
      const rules = [];
      if (settings.dialogbox !== false) rules.push(...dialogboxRules(dialogbox, manifest.layout, manifest.game?.screen?.w, manifest.game?.screen?.h));
      if (settings.questionChoice !== false) {
        // The choice options already inherit their text colour from
        // `--dsw-alias-label-primary` (theme override); only their selected
        // state needs the game accent.
        vars.push(`--dsw-alias-interactive-bg-hover: color-mix(in srgb, ${accent} 22%, transparent) !important;`);
      }
      if (settings.themeTokens !== false) {
        // The host paints text on every brand-filled button with
        // `--dsw-alias-label-primary-foreground`, and the theme override turns
        // the fill into the GAME's accent. Leaving the foreground alone makes a
        // light accent (the usual VN gold or pink) render white-on-white, so
        // the placeholder foreground is derived from the accent's luminance and
        // written globally — the only way a client plugin can reach the shell's
        // own buttons. (`--dsw-theme-brand-foreground` does not exist in DSH.)
        const foreground = luminanceOf(accent);
        vars.push(`--dsw-alias-label-primary-foreground: ${foreground !== undefined && foreground > 0.55 ? "#111111" : "#ffffff"} !important;`);
      }
      // One face for the whole UI through the shell's own font variable: the
      // picked font when there is one, the game's dialogue face otherwise. The
      // text SIZE is deliberately left to the shell — scaling it from the
      // game's canvas made the conversation visibly larger than the player is
      // used to.
      const chosen = chosenFont(manifest, settings);
      if (chosen !== undefined) {
        if (chosen.block !== undefined) blocks.push(chosen.block);
        vars.push(`--dsw-font-family: ${chosen.value} !important;`);
      } else if (typeof dialogbox.fontUrl === "string" && dialogbox.fontUrl.length > 0) {
        blocks.push(`@font-face { font-family: "RenPySkinGame"; src: url("${dialogbox.fontUrl}"); font-display: swap; }`);
        vars.push(`--dsw-font-family: "RenPySkinGame", ${GAME_FONT_FALLBACK} !important;`);
      }
      // The composer seat is the band the shell sticks to the bottom of the
      // conversation and fades into the background with its own gradient. Once
      // the game art is painted behind the conversation that opaque gradient
      // hides the bottom of the image, so it is switchable. Scoped by the
      // shell's phase attributes rather than by its hashed classes.
      const seat = settings.composerBackdrop;
      if (seat === "transparent" || seat === "solid") {
        rules.push(
          `[data-phase="active"] [data-composer-seat], [data-content-phase="active"] [data-composer-seat]` +
            ` { background: ${seat === "transparent" ? "transparent" : "var(--dsw-alias-bg-base)"} !important; }`,
        );
      }
      // Hiding the shell's own furniture is a viewing mode, not a skin rule:
      // these apply in every phase, including the blank-session hero composer.
      if (settings.hideSidebar === true) {
        // The frame is a grid whose inline `grid-template-columns` still has a
        // track for the sidebar. Hiding the column alone leaves a 280px hole,
        // so the two columns after it are re-seated across the same tracks.
        rules.push(
          `div:has(> [data-shell-overlay]) > div:has([data-slot="sidebar"]) { display: none !important; }`,
          `div:has(> [data-shell-overlay]) > div:has([data-slot="sidebar"]) + div { grid-column: 1 / 3 !important; }`,
          `div:has(> [data-shell-overlay]) > div:has([data-slot="sidebar"]) + div + div { grid-column: 3 !important; }`,
        );
      }
      if (settings.hideComposer === true) {
        // The say-screen extras are measured onto the composer; leaving them
        // behind after the composer is gone draws buttons over empty space.
        rules.push(`[data-composer-seat] { display: none !important; }`, `.rsk-modules { display: none !important; }`);
      }
      if (vars.length > 0) blocks.push(`body { ${vars.join(" ")} }`);
      blocks.push(...rules);
      return blocks.join("\n");
    }

    // ── the typewriter ─────────────────────────────────────────────────────

    /**
     * Ren'Py's in-text pacing tags — the four the stage-director brief promises
     * the model may use. Any other brace (`{i}`, or a literal `{"json": true}`
     * inside a code block) is left alone: this runs over a model's answer, which
     * is full of braces that are not Ren'Py syntax.
     */
    const RENPY_PACING_TAG = /\{(w(?:=[0-9.]+)?|p|cps=[0-9.]+|fast)\}/gi;
    /** What `{p}` waits for in Ren'Py is a click; here it is a beat. */
    const BARE_PAUSE_SECONDS = 0.5;
    /** Ceiling on one reveal, so a 6000-character essay is not held for 2 minutes. */
    const TYPING_MAX_SECONDS = 8;

    /**
     * One text node's content, with the pacing tags removed and their effect
     * recorded as marks on the CLEANED text.
     */
    function stripPacing(raw) {
      let cleaned = "";
      const marks = [];
      const pattern = new RegExp(RENPY_PACING_TAG.source, "gi");
      let last = 0;
      let match;
      while ((match = pattern.exec(raw)) !== null) {
        cleaned += raw.slice(last, match.index);
        const token = match[1].toLowerCase();
        const at = cleaned.length;
        if (token === "p" || token === "w") marks.push({ at, kind: "pause", value: BARE_PAUSE_SECONDS });
        else if (token === "fast") marks.push({ at, kind: "fast", value: 0 });
        else if (token.startsWith("w=")) marks.push({ at, kind: "pause", value: Math.min(5, Math.max(0, Number(token.slice(2)))) });
        else if (token.startsWith("cps=")) marks.push({ at, kind: "rate", value: Math.min(400, Math.max(1, Number(token.slice(4)))) });
        last = match.index + match[0].length;
      }
      cleaned += raw.slice(last);
      return { cleaned, marks };
    }

    /**
     * The text nodes of one answer, in document order, skipping code.
     *
     * Code is skipped because a fenced block is the one place a brace is
     * certainly literal — and because a code block that types itself out is
     * unreadable.
     */
    function typingTargets(root) {
      const out = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            if ((child.nodeValue ?? "").length > 0) out.push(child);
            continue;
          }
          if (child.nodeType !== 1) continue;
          const name = child.tagName?.toLowerCase();
          if (name === "code" || name === "pre") continue;
          walk(child);
        }
      };
      walk(root);
      return out;
    }

    /** The one reveal that can be in flight, if any. */
    let typing;

    /** Write the revealed prefix of every node in the plan. */
    function paintTyping(plan) {
      const limit = Math.floor(plan.shown);
      plan.writing = true;
      for (const entry of plan.nodes) {
        const end = Math.max(0, Math.min(entry.cleaned.length, limit - entry.start));
        const next = end >= entry.cleaned.length ? entry.cleaned : entry.cleaned.slice(0, end);
        if (entry.node.nodeValue !== next) entry.node.nodeValue = next;
      }
      plan.writing = false;
    }

    /** Re-read the block's text after the shell rewrote it, keeping the reveal position. */
    function planTyping(root, cps) {
      const nodes = [];
      const events = [];
      let base = 0;
      for (const node of typingTargets(root)) {
        const raw = String(node.nodeValue ?? "");
        const { cleaned, marks } = stripPacing(raw);
        if (raw.length === 0) continue;
        for (const mark of marks) events.push({ at: base + mark.at, kind: mark.kind, value: mark.value });
        nodes.push({ node, cleaned, start: base });
        base += cleaned.length;
      }
      return { root, nodes, events, total: base, cps, shown: 0, wait: 0, event: 0, writing: false };
    }

    function stepTyping(now) {
      const plan = typing;
      if (plan === undefined) return;
      plan.raf = undefined;
      const dt = Math.min(0.25, Math.max(0, (now - plan.last) / 1000));
      plan.last = now;
      if (plan.wait > 0) {
        plan.wait -= dt;
      } else {
        // `{cps=}` is the rate the model asked for; the ceiling keeps a long
        // answer from being unreadable-slow, which is not what Ren'Py's own cps
        // means either (it paces a dialogue LINE).
        const rate = Math.max(plan.cps, plan.total / TYPING_MAX_SECONDS);
        plan.shown = Math.min(plan.total, plan.shown + rate * dt);
        while (plan.event < plan.events.length && plan.events[plan.event].at <= plan.shown) {
          const mark = plan.events[plan.event];
          plan.event += 1;
          if (mark.kind === "pause") plan.wait = Math.max(plan.wait, mark.value);
          else if (mark.kind === "rate") plan.cps = mark.value;
          else plan.shown = plan.total;
        }
      }
      paintTyping(plan);
      if (plan.shown < plan.total) plan.raf = requestAnimationFrame(stepTyping);
    }

    function stopTyping() {
      const plan = typing;
      typing = undefined;
      if (plan === undefined) return;
      if (plan.raf !== undefined) cancelAnimationFrame(plan.raf);
      // Leave the text whole: the effect can be switched off mid-answer, and
      // half a sentence must not stay on screen.
      plan.shown = Number.POSITIVE_INFINITY;
      paintTyping(plan);
    }

    function syncTyping() {
      const plan = typing;
      if (plan === undefined || plan.writing === true) return;
      if (plan.root.isConnected !== true) {
        stopTyping();
        return;
      }
      const rebuilt = planTyping(plan.root, plan.cps);
      plan.nodes = rebuilt.nodes;
      plan.events = rebuilt.events;
      plan.total = rebuilt.total;
      plan.event = 0;
      while (plan.event < plan.events.length && plan.events[plan.event].at <= plan.shown) plan.event += 1;
      if (plan.shown >= plan.total) {
        paintTyping(plan);
        return;
      }
      if (plan.raf === undefined) {
        plan.last = performance.now();
        plan.raf = requestAnimationFrame(stepTyping);
      }
    }

    /**
     * The typewriter for the model's own dialogue.
     *
     * `textAnimation` / `textCps` had NO reader at all while the injected brief
     * promised `{w=0.5}` / `{p}` / `{cps=20}` / `{fast}` — the tags rendered as
     * literal text. This is that reader.
     *
     * It reveals by writing a PREFIX of the answer's text nodes and growing it
     * from a frame loop; it never restructures the tree. A span per character
     * would fight React, which owns these nodes and rewrites them as the reply
     * streams — and the shell has to keep being able to update its own DOM. Our
     * writes are corrected before paint (a MutationObserver callback is a
     * microtask), so the un-prefixed text never flashes.
     */
    function applyTypewriter(ctx) {
      ctx.effect(() => {
        if (typeof document === "undefined" || typeof MutationObserver !== "function") return undefined;
        if (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          // Motion the reader asked the OS to remove, and nothing is lost: the
          // text is all there either way.
          return undefined;
        }
        const consider = () => {
          const settings = store.get().settings ?? {};
          const cps = typeof settings.textCps === "number" ? settings.textCps : 30;
          if (settings.enabled === false || settings.textAnimation === false || cps <= 0) {
            stopTyping();
            return;
          }
          // The newest answer is the one being read; animating history would
          // re-type every older message whenever the page re-renders.
          const roots = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]:not([data-turn-process-hidden])');
          const root = roots.length === 0 ? undefined : roots[roots.length - 1];
          if (root === undefined) return;
          if (typing?.root === root) return;
          stopTyping();
          typing = planTyping(root, cps);
          typing.last = performance.now();
          typing.raf = requestAnimationFrame(stepTyping);
        };
        const observer = new MutationObserver(() => {
          consider();
          syncTyping();
        });
        const host = document.querySelector("[data-conversation-content], [data-chat-flow]") ?? document.body;
        observer.observe(host, { childList: true, subtree: true, characterData: true });
        consider();
        const unsubscribe = store.subscribe(() => consider());
        return () => {
          observer.disconnect();
          unsubscribe();
          stopTyping();
        };
      }, "dsh-renpy-skin: typewriter");
    }

    function applySkinCss(ctx) {
      ctx.effect(() => {
        let tag;
        let written;
        const sync = () => {
          const state = store.get();
          const settings = state.settings ?? {};
          const manifest = state.manifest;
          let css = "";
          if (settings.enabled !== false && manifest !== undefined) {
            // `buildSkinCss` returns "" once every group it can write is
            // switched off, so the decision lives in one place. The allow-list
            // that used to stand here silently dropped the composer backdrop
            // whenever the dialogue-box switch was off.
            css = buildSkinCss(manifest, settings);
          }
          // Reuse the tag when the CSS is unchanged. Tearing it down and
          // recreating it on every store notification made the browser restyle
          // the whole document ~once a second for no reason.
          if (css === written) return;
          written = css;
          if (css === "" || typeof document === "undefined") {
            if (tag !== undefined) {
              tag.remove();
              tag = undefined;
            }
            return;
          }
          if (tag === undefined) {
            tag = document.createElement("style");
            tag.dataset.plugin = "dsh-renpy-skin";
            tag.dataset.pluginCss = "dsh-renpy-skin/skin";
            document.head.appendChild(tag);
          }
          tag.textContent = css;
        };
        const unsubscribe = store.subscribe(sync);
        sync();
        return () => {
          unsubscribe();
          if (tag !== undefined) tag.remove();
        };
      }, "dsh-renpy-skin: skin css");
    }

    function applyPolling(ctx) {
      ctx.effect(() => {
        let cancelled = false;
        const tick = async () => {
          if (cancelled) return;
          await pollStage();
          if (!cancelled) pollTimer = window.setTimeout(tick, POLL_MS);
        };
        void refreshManifest().then(tick);
        return () => {
          cancelled = true;
          if (pollTimer !== undefined) window.clearTimeout(pollTimer);
          // The profile watch belongs to the same lifetime: both are timers the
          // plugin owns, and a released layer must not keep polling /vn.
          stopProfileWatch();
        };
      }, "dsh-renpy-skin: stage polling");
    }

    /**
     * The game directory the client currently believes is loaded.
     *
     * Written by `switchGame` so the watcher below can tell a switch it just
     * performed from one that happened elsewhere.
     */
    let activeGameDir;

    /**
     * Notice a game switch that did NOT come from the client's own picker.
     *
     * The model can switch VNs with the `renpy_configure` tool, and a second
     * window can change the same config file. Both arrive here only as a
     * `settings.gameDir` change on the 900 ms stage poll — and the manifest,
     * the palette, the cast, the backgrounds and the playlist all stay the
     * PREVIOUS game's until someone refetches. That was the "some state is still
     * from the last VN" bug: switching was only ever handled on the picker path.
     */
    function applyGameSwitch(ctx) {
      ctx.effect(() => {
        const sync = () => {
          const state = store.get();
          // Wait for the FIRST settings snapshot before latching. `applyPolling`
          // starts its manifest fetch before this watcher runs and does not await
          // it, so a synchronous first call would see `settings === undefined`,
          // latch `""`, and then treat the real `gameDir` arriving a moment later
          // as somebody else's switch — one wasted full `.rpa` rescan per page
          // load. The initial fetch is `applyPolling`'s job either way.
          if (state.settings === undefined) return;
          const gameDir = state.settings.gameDir ?? "";
          if (activeGameDir === undefined) {
            activeGameDir = gameDir;
            return;
          }
          if (gameDir === activeGameDir) return;
          activeGameDir = gameDir;
          resetForNewGame(state.settings?.splashOnSwitch === true);
          void refreshManifest();
        };
        const unsubscribe = store.subscribe(sync);
        sync();
        return unsubscribe;
      }, "dsh-renpy-skin: external game switch");
    }

    /**
     * Install the plugin's own `.rsk-*` stylesheet.
     *
     * `globalThis.styles` is only defined for a `cordis-client-runner` closure,
     * where it arrives as a parameter; this bundle is a Module Loader package
     * (`factory(require)`), so the global is `undefined` and guarding on it
     * silently dropped the whole stylesheet. Fall back to a direct
     * `document.head` tag — the same pattern `applySkinCss` uses, and the one
     * the loader reclaims through `data-plugin`.
     */
    function applyStylesheet(ctx) {
      if (typeof document === "undefined") return;
      ctx.effect(() => {
        const styles = globalThis.styles;
        if (styles !== undefined && typeof styles.insert === "function") {
          return styles.insert(CSS);
        }
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-renpy-skin";
        tag.dataset.pluginCss = "dsh-renpy-skin/base";
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, "dsh-renpy-skin: stylesheet");
    }

    function apply(ctx) {
      // The whole body is guarded: a failure here must degrade to "the skin is
      // missing", never to a blank shell.
      try {
        platformCtx = ctx;
        // The New Session flow needs services that may mount after this plugin
        // does, and `ctx.get` would throw for every one of them. `ctx.inject`
        // waits instead, and the scoped context it hands over is what the click
        // handler resolves through.
        try {
          ctx.inject(["uiWorkspace", "sessions"], (scoped) => {
            agentServices = {
              uiWorkspace: scoped.uiWorkspace,
              sessions: scoped.sessions,
              // `workspaces` is the Workspace CRUD service, and it is optional.
              // Cordis validates a nested read against the inject list, so it
              // has to be asked for separately; a profile without it leaves the
              // session opening in whatever folder is current.
              workspaces: workspaceService,
            };
          });
        } catch (error) {
          console.error("[dsh-renpy-skin] could not wait for the session services", error);
        }
        try {
          ctx.inject(["workspaces"], (scoped) => {
            workspaceService = scoped.workspaces;
            if (agentServices !== undefined) agentServices.workspaces = scoped.workspaces;
          });
        } catch (error) {
          // A shell that has no Workspace CRUD service: the flow still works.
          console.warn("[dsh-renpy-skin] workspaces service unavailable", error);
        }
        ctx.effect(() => () => {
          if (platformCtx === ctx) platformCtx = undefined;
        }, "renpy-skin: release context");
        // Unloading the plugin has to take the music with it. The element is not
        // collected the moment this closure goes away, and the replacement load
        // looks for it on the global — so hand it over rather than leaving it
        // audible for the next build to stack on.
        ctx.effect(() => () => {
          const element = playerElement;
          playerElement = undefined;
          if (globalThis[AUDIO_GLOBAL] === element) globalThis[AUDIO_GLOBAL] = undefined;
          silence(element);
        }, "dsh-renpy-skin: audio");
      } catch (error) {
        console.error("[dsh-renpy-skin] audio teardown registration failed", error);
      }
      try {
        applyStylesheet(ctx);
      } catch (error) {
        console.error("[dsh-renpy-skin] stylesheet failed", error);
      }
      try {
        applyPolling(ctx);
      } catch (error) {
        console.error("[dsh-renpy-skin] polling failed", error);
      }
      try {
        applyGameSwitch(ctx);
      } catch (error) {
        console.error("[dsh-renpy-skin] game-switch watcher failed", error);
      }
      try {
        applyTheme(ctx);
      } catch (error) {
        console.error("[dsh-renpy-skin] theme override failed", error);
      }
      try {
        applyBackground(ctx);
      } catch (error) {
        console.error("[dsh-renpy-skin] overlay registration failed", error);
      }
      try {
        applyHeader(ctx);
      } catch (error) {
        console.error("[dsh-renpy-skin] header utilities failed", error);
      }
      try {
        applySettingsPage(ctx);
      } catch (error) {
        console.error("[dsh-renpy-skin] settings page registration failed", error);
      }
      try {
        applyLocale(ctx);
      } catch (error) {
        console.error("[dsh-renpy-skin] locale registration failed", error);
      }
      try {
        applySkinCss(ctx);
      } catch (error) {
        console.error("[dsh-renpy-skin] skin css failed", error);
      }
      try {
        applyTypewriter(ctx);
      } catch (error) {
        console.error("[dsh-renpy-skin] typewriter failed", error);
      }
    }

    exports.apply = apply;
    exports.buildSkinCss = buildSkinCss;
    // Exported for test/client.test.mjs: the New-Session flow is otherwise only
    // reachable by clicking the button in a live shell, so its decisions —
    // which Session it queues into, and when it refuses to — would ship untested.
    exports.loadWithAgent = loadWithAgent;
    // Same reason, same test file: the profile watch decides whether the user is
    // offered the new profile, and it is driven by timers a test can hold.
    exports.startProfileWatch = startProfileWatch;
    exports.stopProfileWatch = stopProfileWatch;
    // And the two halves the button composes: the prompt has to carry the paths
    // the host prepared (a prompt without them is the dead end this replaced),
    // and the prepare call has to read a refusal out of the body instead of the
    // status line — both are decisions, not formatting.
    exports.agentLoadPrompt = agentLoadPrompt;
    exports.prepareGame = prepareGame;
    exports.copyAgentPrompt = copyAgentPrompt;
    // The shuffle draw and the mode cycle are the pieces of the transport that
    // are pure: they take no DOM and no store, so a test can pin the rule that a
    // draw never repeats the current track and that one button reaches every
    // state. The rest of the transport needs a live `<audio>`.
    exports.shuffleIndex = shuffleIndex;
    exports.playbackModeOf = playbackModeOf;
    exports.PLAYBACK_NEXT = PLAYBACK_NEXT;
    exports.PLAYBACK_PATCH = PLAYBACK_PATCH;
    exports.inject = ["slots", "theme"];
    return module.exports;
  },
});
