/**
 * Client-half load test — the browser bundle, executed outside a browser.
 *
 * `lib/client.js` is a Module Loader package (`window.__ModuleLoader__.load`),
 * so nothing in `node --test` would ever touch it: a top-level typo, a missing
 * `require`, or a `ctx.slots.register` that throws at mount time all ship
 * invisibly and only surface as a plugin that silently does nothing in the GUI.
 * The whole browser half went unexecuted for the entire life of the features it
 * implements for exactly that reason.
 *
 * So this file runs it: the source is evaluated with stubbed platform globals
 * and a fake client context, then `apply(ctx)` is called and the resulting
 * registrations are inspected.
 *
 * What this can and cannot prove. It proves the module parses, exports the
 * expected shape, reaches every registration, and that no guarded `apply` block
 * threw. It cannot prove the components *render* — rendering needs a real React
 * and a DOM. Anything that only fails during render (a bad hook order, an
 * undefined primitive) still has to be seen in a live GUI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CLIENT_SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/**
 * Evaluate the client bundle and return its module exports.
 *
 * `factory(require)` is called with a stub resolver rather than the real one, so
 * the ONLY specifier the bundle is allowed to reach for is `react` (its platform
 * seed key) plus the primitives package. A new third-party `require` would throw
 * here, which is the point: the host half must stay dependency-free.
 *
 * `overrides` is for the flows that need more than stubs to be observable at
 * all: the agent's New Session reads a DOM, a clipboard and a timer, so a test
 * can hand it those instead of the inert defaults below.
 */
function loadClientModule(overrides = {}) {
  let factory;
  const window = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    ...(overrides.window ?? {}),
    __ModuleLoader__: {
      load: ({ id, factory: f }) => {
        factory = f;
        window.__moduleId = id;
      },
    },
  };
  const document = {
    createElement: () => ({ dataset: {}, style: {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    ...(overrides.document ?? {}),
  };
  // Node already defines a read-only `navigator`; the bundle reads it as a free
  // variable, so it is supplied positionally instead of through globalThis.
  const navigator = overrides.navigator ?? { language: "en" };
  const fetch = overrides.fetch ?? (async () => ({ ok: false, status: 0, json: async () => ({}) }));
  // The bundle reaches for the BARE `setTimeout` in the New Session wait loop
  // and nowhere else (every other timer is `window.setTimeout`). Firing it
  // immediately keeps a test from waiting out a six-second poll; the delay
  // itself is not what these tests are about.
  const setTimeout = overrides.setTimeout ?? ((fn) => {
    fn();
    return 0;
  });

  // eslint-disable-next-line no-new-func
  new Function("window", "document", "navigator", "fetch", "setTimeout", CLIENT_SOURCE)(
    window,
    document,
    navigator,
    fetch,
    setTimeout,
  );
  assert.ok(factory !== undefined, "client.js must call window.__ModuleLoader__.load");

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect: () => {},
    useRef: () => ({ current: undefined }),
    useState: (initial) => [initial, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  // Any primitive the bundle names resolves to an inert component, so a typo in
  // an icon name still fails (the real package would export undefined), while an
  // unknown primitive name does not.
  const primitives = new Proxy(
    {},
    { get: (_target, key) => (props) => ({ type: String(key), props: props ?? {} }) },
  );

  const require = (specifier) => {
    if (specifier === "react") return react;
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`client.js must not require ${specifier}`);
  };

  const exports = factory(require);
  return { exports, moduleId: window.__moduleId };
}

/** A client context that records what the bundle registers and how it fails. */
function fakeClientContext() {
  const recorded = { slots: [], effects: [], errors: [], injected: [] };
  const ctx = {
    // Every optional service: absent. `exports.inject` lists only slots+theme,
    // so this is the shape a profile without webServer/locale/systemPrompt has.
    get: () => undefined,
    // Cordis hands a scoped context to the callback once the service exists.
    // Nothing exists here, so the callback never runs — which is the case the
    // New Session flow has to survive.
    inject: (names, callback) => {
      recorded.injected.push(names.join(","));
      return () => {};
    },
    effect: (body, label) => {
      recorded.effects.push(label);
      try {
        body();
      } catch (error) {
        recorded.errors.push(`${label}: ${error.message}`);
      }
    },
    slots: {
      inject: (name, callback) => {
        recorded.slots.push(name);
        return callback();
      },
      register: (options) => {
        recorded.slots.push(`${options.name}#${options.id ?? ""}`);
        return () => {};
      },
      entries: () => [],
      resolveStore: () => undefined,
    },
    theme: { overrideTokens: () => () => {} },
  };
  return { ctx, recorded };
}

test("the client bundle loads, exports apply/inject, and leaves only 'react' as a dependency", () => {
  const { exports, moduleId } = loadClientModule();
  assert.equal(moduleId, "dsh-renpy-skin", "the module loads under the plugin's own id");
  assert.equal(typeof exports.apply, "function");
  // inject is the fiber's required-service set. Widening it makes the plugin
  // fail to load on a profile that lacks one of the services, which is why
  // every other service is read through the ungated ctx.get instead.
  assert.deepEqual(exports.inject, ["slots", "theme"], "inject stays minimal");
});

test("apply() registers every layer and throws nothing with no optional service present", () => {
  const { exports } = loadClientModule();
  const { ctx, recorded } = fakeClientContext();

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    exports.apply(ctx);
  } finally {
    console.error = originalError;
  }

  // Each layer is wrapped in its own try/catch by design, so a failure shows up
  // as a console.error and a missing registration rather than as a throw.
  assert.deepEqual(errors, [], "no apply block reported a failure");
  assert.deepEqual(recorded.errors, [], "no effect body threw");

  const ids = recorded.slots.filter((entry) => entry.includes("#"));
  assert.ok(
    !ids.includes("shell.overlay#renpy-skin:stage"),
    "the stage no longer lives on the full-frame overlay, where it covered the sidebar and the transcript",
  );
  assert.ok(
    ids.includes("shell.overlay#renpy-skin:modules"),
    "the say-screen module layer still registers above the composer",
  );
  assert.ok(
    ids.includes("conversation.session.header.utilities#renpy-skin"),
    "the header utility entry registers — the four requested features' home",
  );
  assert.ok(ids.includes("shell.overlay#renpy-skin:popover"), "the settings/music popover registers");
  assert.ok(ids.includes("shell.overlay#renpy-skin:splash"), "the splash layer registers");
  assert.ok(ids.includes("settings.section#renpy-skin"), "the settings section still registers");
  assert.ok(
    recorded.effects.includes("dsh-renpy-skin: audio"),
    "the audio teardown hook registers, so unloading the plugin cannot leave a track playing",
  );
  // The New Session flow cannot reach these with `ctx.get`: a Cordis context
  // throws for a name outside `inject`, and widening `inject` would make the
  // whole plugin fail to load on a profile without a workspace service. The
  // wait has to be an `inject`, and both halves of the pair must be asked for.
  assert.ok(
    recorded.injected.includes("uiWorkspace,sessions"),
    "the flow waits on the session services instead of reading them at click time",
  );
});

test("apply() survives a context whose slots service is entirely absent", () => {
  const { exports } = loadClientModule();
  const ctx = { get: () => undefined, effect: () => {} }; // no slots, no theme

  // The bundle declares inject = ["slots","theme"], so the platform would not
  // call apply at all in this shape. Reaching in anyway is the hostile case:
  // a half-mounted context must degrade to "no UI", never to a broken apply.
  assert.doesNotThrow(() => exports.apply(ctx));
});

test("a gated service lookup is caught, not surfaced", () => {
  // The live symptom: `[dsh-renpy-skin] locale registration failed Error: cannot
  // get property "locale" without inject`. A Cordis context gates its own
  // properties, so reading one whose name is absent from `exports.inject` THROWS
  // instead of answering undefined — and `inject` must stay minimal, so the
  // lookup has to be defensive rather than the dependency widened.
  const { exports } = loadClientModule();
  const gated = (name) => { throw new Error(`cannot get property "${name}" without inject`); };
  const ctx = {
    get: gated,
    // A real client context always carries `inject`; only `get` is gated here,
    // which is the asymmetry this test is about.
    inject: () => () => {},
    effect: (body, label) => { body(); return () => {}; },
    slots: { inject: (name, callback) => callback(), register: () => () => {}, entries: () => [], resolveStore: () => undefined },
    theme: { overrideTokens: () => () => {} },
  };

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    assert.doesNotThrow(() => exports.apply(ctx), "a gated lookup must not escape apply");
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, [], "and must not be reported as a failure either — locale is optional");
});

/**
 * The channel between two loads of the client half.
 *
 * Reloading the plugin — including a host restart that the page survives —
 * evaluates the factory again in a fresh closure, so the one-element reference
 * inside it starts out empty while the previous build's element is still
 * playing. The global is the only thing that can reach it, which is also why the
 * test may name it: it IS the contract between the two loads.
 */
const AUDIO_GLOBAL = "__dshRenpySkinAudio";

function fakeAudioElement() {
  const calls = [];
  return {
    calls,
    pause: () => calls.push("pause"),
    removeAttribute: (name) => calls.push(`removeAttribute:${name}`),
    load: () => calls.push("load"),
  };
}

test("a reload silences the audio element the previous load left playing", () => {
  // The live symptom: every reload the old track kept playing, the new build's
  // first-gesture autoplay started the same menu music on top of it, and the two
  // copies beat against each other — "it sounds noisy".
  const stale = fakeAudioElement();
  globalThis[AUDIO_GLOBAL] = stale;
  try {
    loadClientModule();
  } finally {
    delete globalThis[AUDIO_GLOBAL];
  }
  assert.deepEqual(
    stale.calls,
    ["pause", "removeAttribute:src", "load"],
    "the previous load's element is torn down, not merely orphaned",
  );
});

test("a load with nothing to retire leaves no audio global behind", () => {
  // The reset path: a plain page load must not invent a global, or the next
  // reload would try to silence an element that never existed.
  delete globalThis[AUDIO_GLOBAL];
  loadClientModule();
  assert.equal(globalThis[AUDIO_GLOBAL], undefined, "nothing is parked by loading alone");
});

// ── buildSkinCss: the font choice ───────────────────────────────────────

function skinManifest(extra = {}) {
  return {
    dialogbox: { textSize: 52, fontUrl: "/renpy-skin/asset?p=fonts%2Fgame.ttf" },
    fonts: [
      { path: "fonts/a.ttf", label: "a", url: "/renpy-skin/asset?p=fonts%2Fa.ttf" },
      { path: "fonts/b.ttf", label: "b", url: "/renpy-skin/asset?p=fonts%2Fb.ttf" },
    ],
    ...extra,
  };
}

function fontFamilyOf(css) {
  return /--dsw-font-family: ([^;]*?) !important;/.exec(css)?.[1];
}

test("the conversation's font size is never scaled from the game's text size", () => {
  // Symptom: a VN with `gui.text_size = 52` made every message visibly larger
  // than the player is used to. The size knob belongs to the shell.
  const { exports } = loadClientModule();
  const css = exports.buildSkinCss(skinManifest(), {});
  assert.doesNotMatch(css, /--dsh-content-font-size/);
});

test("a picked font becomes the whole interface's face, not just the composer's", () => {
  const { exports } = loadClientModule();
  const css = exports.buildSkinCss(skinManifest(), { composerFont: "fonts/a.ttf" });
  assert.match(fontFamilyOf(css), /^"RenPySkinFont\w+",/, "the shell's font variable carries the pick");
  assert.match(css, /@font-face \{ font-family: "RenPySkinFont\w+"; src: url\("\/renpy-skin\/asset\?p=fonts%2Fa\.ttf"\)/);
  assert.doesNotMatch(css, /\[data-composer-input\] \{ font-family/, "no composer-only font rule remains");
});

test("two different picks never share a family name", () => {
  // Symptom: switching the font in settings changed nothing until a reload,
  // because one fixed family name was re-pointed at another file.
  const { exports } = loadClientModule();
  const a = fontFamilyOf(exports.buildSkinCss(skinManifest(), { composerFont: "fonts/a.ttf" }));
  const b = fontFamilyOf(exports.buildSkinCss(skinManifest(), { composerFont: "fonts/b.ttf" }));
  assert.notEqual(a, b);
});

test("a system font is used by name, and no pick falls back to the game's face", () => {
  const { exports } = loadClientModule();
  const system = exports.buildSkinCss(skinManifest(), { composerFont: "Microsoft YaHei" });
  assert.match(fontFamilyOf(system), /^"Microsoft YaHei",/);
  assert.doesNotMatch(system, /@font-face \{ font-family: "RenPySkinFont/);
  const none = exports.buildSkinCss(skinManifest(), { composerFont: "" });
  assert.match(fontFamilyOf(none), /^"RenPySkinGame",/);
});

const GTST_MANIFEST = {
  game: { screen: { w: 1920, h: 1080 } },
  dialogbox: {
    textboxImage: "/a?p=gui%2Ftextbox.png",
    // A 1920x1080 file whose paper covers only the bottom strip.
    textboxImageBounds: { width: 1920, height: 1080 },
    textboxImageBox: { x: 276, y: 788, width: 1411, height: 292, imageWidth: 1920, imageHeight: 1080 },
    textColor: "#404040",
    textSize: 40,
    height: 278,
  },
  layout: { textboxHeight: 278, dialogueXpos: 402, dialogueYpos: 75, dialogueWidth: 1116, dialogueTextXalign: 0.5 },
};

test("the composer shows only the painted part of the textbox image, at the game's proportions", () => {
  // Symptom: GoToSnowTown's textbox is a 1920x1080 file with the paper in the
  // bottom quarter; scaling the whole file to the composer showed a cropped
  // slab of transparent canvas. The unit is 100/1411 cqw per canvas pixel.
  const { exports } = loadClientModule();
  const css = exports.buildSkinCss(GTST_MANIFEST, {});
  assert.match(css, /background-size: 136\.074cqw auto !important;/, "the whole 1920px file, scaled so 1411px spans the composer");
  assert.match(css, /background-position: left -19\.561cqw top -55\.847cqw !important;/, "offset to the paper's top-left corner inside the file");
  assert.match(css, /height: 20\.695cqw !important;/, "292px of paper tall");
});

test("the text is placed relative to the painted box, not the whole canvas", () => {
  // Window top = 1080-278 = 802; paper top = 788 -> text 75+802-788 = 89px down.
  // Paper left = (1920-1920)/2 + 276 = 276 -> text 402-276 = 126px in.
  const { exports } = loadClientModule();
  const css = exports.buildSkinCss(GTST_MANIFEST, {});
  assert.match(css, /padding-top: 6\.308cqw !important; padding-left: 8\.930cqw !important; padding-right: 11\.977cqw !important;/);
  assert.match(css, /color: #404040 !important; caret-color: #404040;\s+font-size: max\(14px, 2\.835cqw\) !important; line-height: 1\.5 !important; text-align: center !important;/);
});

test("the dock is centred over the button row, which keeps a measurable box", () => {
  // The row must NOT dissolve. The shell's `observeControlRow` reads
  // `row.getBoundingClientRect().width` to decide whether the model chip fits;
  // with `display: contents` that width is 0, so the chip collapsed to a bare
  // icon in every conversation no matter how wide the pane.
  const { exports } = loadClientModule();
  const css = exports.buildSkinCss(GTST_MANIFEST, {});
  assert.match(css, /justify-content: space-between !important/);
  assert.match(css, /\[data-composer-card\] \{ display: contents !important; \}/, "the card still dissolves");
  assert.doesNotMatch(
    css,
    /\[data-composer-card\] > div:last-child \{ display: contents/,
    "the row keeps its own box so the shell can measure it",
  );
  assert.match(
    css,
    /\[data-composer-card\] > div:last-child \{ display: flex !important/,
    "the row is the flex line the tools and the trailing controls share",
  );
  assert.match(
    css,
    /composer\.dock"\]\) \{ position: absolute !important; left: 50% !important/,
    "the dock is centred over the row instead of being a flex sibling",
  );
});

test("every composer rule waits for the conversation to begin", () => {
  // A new session shows the shell's own composer; only a conversation that has
  // messages (the shell's `active` phase) gets the game's say box.
  const { exports } = loadClientModule();
  const css = exports.buildSkinCss(GTST_MANIFEST, {});
  const composerRules = css
    .split("\n")
    .filter((rule) => /data-composer-(card|input|placeholder|seat)|:has\(> \[data-composer-card\]\)/.test(rule))
    // The "hide the dialogue box" switch is not a skin rule: it has to hide the
    // composer in every phase, including the blank-session hero box.
    .filter((rule) => !/^\[data-composer-seat\] \{ display: none/.test(rule))
    // A rule may sit inside an `@container` block; the phase guard is what the
    // selector (after the at-rule's opening brace) has to carry.
    .map((rule) => rule.replace(/^@container[^{]*\{\s*/, ""));
  assert.ok(composerRules.length > 5);
  for (const rule of composerRules) assert.match(rule, /^:is\(\[data-phase="active"\], \[data-content-phase="active"\]\) /, rule.slice(0, 80));
});

test("hiding the shell chrome is opt-in and reclaims the sidebar's grid track", () => {
  // Symptom: the session list stayed hidden but its 280px track did not, so the
  // conversation moved right and left a blank column. The frame's template is
  // inline, so the columns after it are re-seated explicitly.
  const { exports } = loadClientModule();
  const shown = exports.buildSkinCss(GTST_MANIFEST, {});
  assert.doesNotMatch(shown, /data-shell-overlay/);
  assert.doesNotMatch(shown, /\[data-composer-seat\] \{ display: none/);

  const hidden = exports.buildSkinCss(GTST_MANIFEST, { hideSidebar: true, hideComposer: true });
  assert.match(hidden, /div:has\(> \[data-shell-overlay\]\) > div:has\(\[data-slot="sidebar"\]\) \{ display: none !important; \}/);
  assert.match(hidden, /\[data-slot="sidebar"\]\) \+ div \{ grid-column: 1 \/ 3 !important; \}/);
  assert.match(hidden, /\+ div \+ div \{ grid-column: 3 !important; \}/);
  assert.match(hidden, /\[data-composer-seat\] \{ display: none !important; \}/);
  assert.match(hidden, /\.rsk-modules \{ display: none !important; \}/);
});

test("a plain-fill textbox (no image) still gets the window's proportions", () => {
  const { exports } = loadClientModule();
  const css = exports.buildSkinCss({ game: { screen: { w: 1920, h: 1080 } }, dialogbox: { fill: "#000000", opacity: 0.5, height: 278 }, layout: { textboxHeight: 278 } }, {});
  assert.match(css, /height: 14\.479cqw !important;/);
  assert.match(css, /background-color: rgba\(0, 0, 0, 0\.5\)/);
});

test("a game with no canvas size falls back to the plain plate without scaled sizes", () => {
  const { exports } = loadClientModule();
  const css = exports.buildSkinCss({ dialogbox: { textColor: "#ffffff", textSize: 40 }, layout: {} }, {});
  assert.doesNotMatch(css, /cqw/);
});

/**
 * The agent-load path (the settings page's 「用 Agent 加载」).
 *
 * It has to reach three platform services — `uiWorkspace` to open a New Session,
 * `sessions` to obtain the Session object, and the Session's own `prompt` to
 * deliver the text — and a Cordis context answers all three by THROWING for a
 * name it was not injected with. So the lookups must be guarded one by one
 * rather than declared in `inject`, which would make them hard requirements.
 */
test("no service lookup outside the guarded helper can throw on a minimal profile", () => {
  // `localeServiceOf` is the one other direct read, and it is itself the double
  // try/catch for the gated `locale` lookup. A comment may name `ctx.get`.
  const offenders = CLIENT_SOURCE.split("\n").filter(
    (line) =>
      /ctx\.get\(/.test(line) &&
      !/serviceOf\(ctx, /.test(line) &&
      !line.includes('ctx.get("locale")') &&
      !line.trimStart().startsWith("*"),
  );
  assert.deepEqual(offenders, [], "every other lookup goes through the guarded helper");
});

test("the agent load reads the Session through the binding, not a lookup that does not exist", () => {
  // `sessions.get(id)` is the natural guess and it is not a method on the
  // service; the object the composer itself drives is `sessions.binding(id).session`.
  assert.match(CLIENT_SOURCE, /sessions\.binding\(target\)/);
  assert.match(CLIENT_SOURCE, /binding\.session/);
  assert.doesNotMatch(CLIENT_SOURCE, /sessions\.get\(/, "no invented method on the sessions service");
  assert.doesNotMatch(CLIENT_SOURCE, /ctx\.sessions/, "the guarded lookup is the only way in");
});

/**
 * A client context with the three optional services the New Session flow reads,
 * plus the DOM hooks it watches.
 *
 * `ids` is what `[data-conversation-session]` answers with, one entry per read
 * and the last one repeating, so a test says whether the shell changed the id at
 * all. `begun` is the composer's phase hook: `true` means the pane is still the
 * conversation the user was reading, which is the case the flow has to refuse.
 */
function agentHarness({ ids = ["s1"], begun = false, workspaces, refuse = false, clipboard = true } = {}) {
  const started = [];
  const prompted = [];
  const copied = [];
  const injected = [];
  let reads = 0;
  const document = {
    querySelector: (selector) => {
      if (selector.includes("data-conversation-session")) {
        const id = ids[Math.min(reads, ids.length - 1)];
        reads += 1;
        return id === undefined ? null : { getAttribute: () => id };
      }
      return begun ? { phase: "active" } : null;
    },
  };
  const navigator = { language: "en" };
  if (clipboard) navigator.clipboard = { writeText: async (text) => { copied.push(text); } };
  const services = {
    uiWorkspace: { startSession: (id) => started.push(id) },
    sessions: {
      binding: (id) => ({
        session: {
          prompt: async (content, mode) => {
            prompted.push({ id, content, mode });
            return refuse ? { ok: false, error: { message: "refused" } } : { ok: true };
          },
        },
      }),
    },
  };
  if (workspaces !== undefined) services.workspaces = workspaces;
  return {
    ctx: {
      get: (name) => services[name],
      // The flow reaches the services through `ctx.inject`; answering the
      // callback synchronously is the "already mounted" case.
      inject: (names, callback) => {
        injected.push(names.join(","));
        return callback(Object.fromEntries(names.map((name) => [name, services[name]])));
      },
    },
    document,
    navigator,
    started,
    prompted,
    copied,
    injected,
  };
}

/** Run `body` with console.warn captured — every fallback path logs its reason. */
async function withCapturedWarn(body) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await body();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test("the agent prompt is queued into the Session the shell opened", async () => {
  const harness = agentHarness({ ids: ["s1", "s2"] });
  const { exports } = loadClientModule({ document: harness.document, navigator: harness.navigator });

  assert.equal(await exports.loadWithAgent(harness.ctx, "prompt text", undefined), "sent");
  assert.deepEqual(harness.prompted.map((entry) => entry.id), ["s2"], "the NEW id, not the one that was showing");
  assert.deepEqual(harness.prompted[0].content, [{ type: "text", text: "prompt text" }]);
  assert.equal(harness.prompted[0].mode, "queue", "the same call the composer itself makes");
  assert.deepEqual(harness.started, [undefined], "no workspace path, so nothing to register");
});

test("a blank Session the shell reuses IS the new Session", async () => {
  // `startSession()` may reuse the already-blank Session instead of minting
  // one: the id then stays the same and the pane is still in its hero phase.
  // That is not a failure, and the prompt has to be delivered anyway.
  const harness = agentHarness({ ids: ["s1"] });
  const { exports } = loadClientModule({ document: harness.document, navigator: harness.navigator });

  assert.equal(await exports.loadWithAgent(harness.ctx, "prompt text", undefined), "sent");
  assert.deepEqual(harness.prompted.map((entry) => entry.id), ["s1"]);
});

test("an unchanged id on a conversation that has begun is refused, not queued into", async () => {
  // The old behaviour: after the poll ran out the flow assumed the reuse case
  // and queued the prompt into whatever was on screen — the user's own chat —
  // and then reported success. Now it refuses, and the refusal is the whole
  // outcome: the settings page shows the reason and offers the prompt for the
  // user to copy themselves.
  const harness = agentHarness({ ids: ["s1"], begun: true });
  const { exports } = loadClientModule({ document: harness.document, navigator: harness.navigator });

  await assert.rejects(
    () => exports.loadWithAgent(harness.ctx, "prompt text", undefined),
    /kept the current conversation/,
  );
  assert.deepEqual(harness.prompted, [], "nothing may be queued into the conversation the user is reading");
  assert.deepEqual(harness.copied, [], "and nothing may reach the clipboard without the user asking");
});

test("the workspace id the host returns is what the session is opened in", async () => {
  const harness = agentHarness({
    ids: ["s1", "s2"],
    // The host is free to name the field; both spellings have to work.
    workspaces: { create: async ({ path }) => ({ path, workspaceId: "ws-1" }) },
  });
  const { exports } = loadClientModule({ document: harness.document, navigator: harness.navigator });

  assert.equal(await exports.loadWithAgent(harness.ctx, "prompt text", "D:\\data\\game\\Test VN"), "sent");
  assert.deepEqual(harness.started, ["ws-1"]);
});

test("a workspace the host refuses does not cost the session", async () => {
  // The folder may not exist yet, and a failing workspace call used to abort the
  // whole flow into the clipboard — no session, nothing sent, for a step that is
  // only about where the agent's scratch files land.
  const harness = agentHarness({
    ids: ["s1", "s2"],
    workspaces: { create: async () => { throw new Error("no such directory"); } },
  });
  const { exports } = loadClientModule({ document: harness.document, navigator: harness.navigator });

  const warnings = await withCapturedWarn(async () => {
    assert.equal(await exports.loadWithAgent(harness.ctx, "prompt text", "D:\\data\\game\\Test VN"), "sent");
  });
  assert.deepEqual(harness.prompted.map((entry) => entry.id), ["s2"]);
  assert.deepEqual(harness.started, [undefined], "the session opens, just not in the profile folder");
  assert.match(warnings.join("\n"), /workspace registration failed/);
});

test("the workspace service is kept even when it mounts before the session services", async () => {
  // `workspaces` is a separate `ctx.inject` wait from `uiWorkspace`+`sessions`,
  // and nothing orders the two: whichever service mounts first fires first.
  // Holding `workspaces` inside the object the other wait creates loses it
  // whenever it arrives first — the button would then open the Session in
  // whatever folder happens to be current, with no error anywhere.
  const { exports } = loadClientModule({
    document: {
      querySelector: (selector) =>
        selector.includes("data-conversation-session") ? { getAttribute: () => "s2" } : null,
    },
    navigator: { language: "en" },
  });
  const { ctx } = fakeClientContext();
  const created = [];
  const prompted = [];
  ctx.inject = (names, callback) => {
    // The order Cordis actually uses is the services' own mount order, so drive
    // the losing order here: `workspaces` resolves first, the pair second.
    if (names.includes("workspaces")) {
      callback({
        workspaces: {
          create: async ({ path }) => {
            created.push(path);
            return { path, workspaceId: "ws-1" };
          },
        },
      });
    } else {
      callback({
        uiWorkspace: { startSession: () => {} },
        sessions: { binding: () => ({ session: { prompt: async (content) => { prompted.push(content); return { ok: true }; } } }) },
      });
    }
    return () => {};
  };

  exports.apply(ctx);

  assert.equal(await exports.loadWithAgent(ctx, "prompt text", "C:\\home\\game\\Test VN"), "sent");
  assert.deepEqual(created, ["C:\\home\\game\\Test VN"], "the profile folder still registers the workspace");
  assert.equal(prompted.length, 1);
});


test("every failure aborts with its reason instead of copying the prompt", async () => {
  // The prompt asks the agent to read a game the HOST loaded: the tools, the
  // manifest and the workspace all live host-side. A copy of it pasted into a
  // chat whose session was never opened therefore describes a game nothing has
  // loaded — the exact dead end this whole flow exists to remove. Copying is
  // the user's decision, made through the button that carries its own label.
  const refused = agentHarness({ ids: ["s1", "s2"], refuse: true });
  const loaded = loadClientModule({ document: refused.document, navigator: refused.navigator });
  await assert.rejects(() => loaded.exports.loadWithAgent(refused.ctx, "prompt text", undefined), /refused/);
  assert.deepEqual(refused.copied, [], "a refused prompt must not land on the clipboard");

  // A minimal profile: no session service at all. The reason names the missing
  // half, because "nothing happened" gives the user nothing to fix.
  const bare = agentHarness();
  const minimal = loadClientModule({ document: bare.document, navigator: bare.navigator });
  await assert.rejects(
    () => minimal.exports.loadWithAgent({ get: () => undefined, inject: () => () => {} }, "prompt text", undefined),
    /no workspace service/,
  );
  assert.deepEqual(bare.copied, []);

  // A binding that never appears: the id changed but the Session never resolved,
  // so there is nothing to queue into.
  const bound = agentHarness({ ids: ["s1", "s2"] });
  const original = bound.ctx.get;
  bound.ctx.get = (name) => (name === "sessions" ? { binding: () => undefined } : original(name));
  const unbound = loadClientModule({ document: bound.document, navigator: bound.navigator });
  await assert.rejects(
    () => unbound.exports.loadWithAgent(bound.ctx, "prompt text", undefined),
    /s2" resolved no binding/,
  );
});


test("the reason names what went wrong, in the host's own words where there are any", async () => {
  // The notice under the button is one line; the reason is what tells the user
  // what to do next, so it must not collapse into a generic "it did not work".
  const harness = agentHarness({ ids: ["s1", "s2"], refuse: true });
  const { exports } = loadClientModule({ document: harness.document, navigator: harness.navigator });
  await assert.rejects(
    () => exports.loadWithAgent(harness.ctx, "prompt text", undefined),
    /refused/,
    "the host's own message, not a generic one",
  );

  const busy = agentHarness({ ids: ["s1"], begun: true });
  const second = loadClientModule({ document: busy.document, navigator: busy.navigator });
  await assert.rejects(
    () => second.exports.loadWithAgent(busy.ctx, "prompt text", undefined),
    /kept the current conversation/,
  );
});

test("the prompt carries the paths the host prepared, so nothing has to be asked", () => {
  // The live failure: the prompt told the agent to load a game nobody had
  // loaded, so the only way to find it was to ask — and the model answered by
  // scanning, or gave up. `/agent/prepare` now answers with the real paths and
  // the prompt has to spell them out; the agent cannot discover them itself,
  // because a fresh Session inherits neither the workspace nor the game.
  const { exports } = loadClientModule();
  const prompt = exports.agentLoadPrompt({
    name: "Test VN",
    gameDir: "D:\\games\\Test VN\\game",
    profileDir: "C:\\home\\game\\Test VN",
    paths: {
      gameDir: "D:\\games\\Test VN\\game",
      profileDir: "C:\\home\\game\\Test VN",
      compactTree: "C:\\home\\game\\Test VN\\scan-tree.md",
      fullTree: "C:\\home\\game\\Test VN\\scan-tree.full.txt",
    },
    stats: { images: 1622, audio: 431, scripts: 50, fonts: 40, backgrounds: 152, characters: 3, spriteTags: 5 },
  });

  assert.match(prompt, /D:\\games\\Test VN\\game/, "the game directory is stated, not asked for");
  assert.match(prompt, /C:\\home\\game\\Test VN/, "the workspace the agent writes into is stated");
  assert.match(prompt, /scan-tree\.md/, "the compact map is named");
  assert.match(prompt, /scan-tree\.full\.txt/, "the full listing is named");
  assert.match(prompt, /1622 images/, "the counts are handed over instead of counted again");
  assert.match(prompt, /Backgrounds: 152/, "so the answer needs no second scan");
  // The cast and the sprite buckets are different lists: CSE declares six
  // speakers whose artwork is filed under folder names the tags do not use.
  assert.match(prompt, /Characters declared: 3/, "the declared cast is reported as such");
  assert.match(prompt, /Sprite tags: 5/, "and kept apart from the sprite buckets");
  assert.match(prompt, /already loaded this game/, "and the agent is told not to load it again");
  assert.doesNotMatch(prompt, /Ask me for the game's folder/, "there is nothing left to ask for");
});

test("without a prepared game the prompt still asks, and says so", () => {
  // The button is also reachable before any game is loaded. The prompt then has
  // to fall back to the old wording rather than claiming a game is ready: the
  // "already loaded" sentence sends the agent straight to `renpy_read_manifest`
  // for a game the host was never told about.
  const { exports } = loadClientModule();
  const prompt = exports.agentLoadPrompt(undefined);
  assert.doesNotMatch(prompt, /already loaded this game/);
  assert.match(prompt, /Ask me for its folder first/);
  assert.match(prompt, /load it with renpy_configure/);
  assert.doesNotMatch(prompt, /do not call it for this one/);
});

test("prepareGame reads a refusal out of the body, not the status line", async () => {
  // The host answers 400 with `{ ok:false, error:"not a Ren'Py game: …" }`, and
  // that sentence is the only thing that tells the user which folder was wrong
  // and why. `fetchJson` would throw "HTTP 400" and lose it.
  const calls = [];
  const { exports } = loadClientModule({
    fetch: async (path, init) => {
      calls.push({ path, init });
      return { ok: false, status: 400, json: async () => ({ ok: false, error: "not a Ren'Py game: no .rpy here" }) };
    },
  });
  await assert.rejects(
    () => exports.prepareGame("s1", "D:\\games\\Empty"),
    /not a Ren'Py game: no \.rpy here/,
  );
  assert.equal(calls[0].path, "/renpy-skin/agent/prepare");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { session: "s1", gameDir: "D:\\games\\Empty" });
});

test("prepareGame sends no gameDir when the box is empty, so the host uses the loaded one", async () => {
  const calls = [];
  const { exports } = loadClientModule({
    fetch: async (path, init) => {
      calls.push({ path, init });
      return { ok: true, status: 200, json: async () => ({ ok: true, name: "Test VN" }) };
    },
  });
  const facts = await exports.prepareGame("s1", "   ");
  assert.equal(facts.name, "Test VN");
  assert.deepEqual(JSON.parse(calls[0].init.body), { session: "s1" }, "a blank box is not a path");
});

test("the profile watch offers the new profile once, and only when the stamp changes", async () => {
  // The agent writes the profile in another Session; the watch is how the user
  // hears about it. It must survive an unchanged profile (the same one read
  // twice is not news) and stop at the first real change: a second offer after
  // the user dismissed the first would be a nag.
  const pending = [];
  const answers = [
    { ok: true, dir: "D:/home/game/Test VN", profile: { name: "Test VN", savedAt: "t0" }, applied: [], rejected: null },
    { ok: true, dir: "D:/home/game/Test VN", profile: { name: "Test VN", savedAt: "t1" }, applied: ["dialogbox.textColor"], rejected: null },
  ];
  let calls = 0;
  const { exports } = loadClientModule({
    window: { setTimeout: (fn) => pending.push(fn), clearTimeout: () => {} },
    fetch: async (path) => {
      assert.match(String(path), /\/renpy-skin\/vn\?session=/, "the watch reads the profile and nothing else");
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return { ok: true, status: 200, json: async () => answer };
    },
  });

  exports.startProfileWatch("t0");
  assert.equal(pending.length, 1, "the watch waits before its first look");
  assert.equal(calls, 0, "arming it polls nothing");

  await pending.shift()();
  assert.equal(calls, 1);
  assert.equal(pending.length, 1, "an unchanged stamp keeps watching");

  await pending.shift()();
  assert.equal(calls, 2);
  assert.equal(pending.length, 0, "the changed stamp ends the watch — the offer is a one-shot");
});

test("the prompt names the archives, and calls loose scripts loose", () => {
  // The live failure this covers: CSE ships zero `.rpy` files and 29 scripts
  // inside its `.rpa`. The prompt said "0 scripts", so the agent reported a game
  // with no script at all and never opened the archive. The archive count and
  // its breakdown are what make the scripts findable.
  const { exports } = loadClientModule();
  const prompt = exports.agentLoadPrompt({
    name: "CSE",
    gameDir: "D:\\games\\CSE\\game",
    stats: {
      images: 12,
      audio: 3,
      scripts: 0,
      fonts: 1,
      archives: 2,
      archiveEntries: { audio: 40, images: 900, movies: 2, scripts: 29 },
    },
  });

  assert.match(prompt, /Files: 12 images, 3 audio files, 0 loose scripts \(29 inside archives\), 1 fonts\./);
  assert.match(prompt, /Archives: 2 \(audio 40, images 900, movies 2, scripts 29 entries\)\./);
});

test("a host that sends no archive counts gets no archive line", () => {
  // `archives` is newer than the prompt. An older host (or a game the scan could
  // not read) must not make the agent read "Archives: undefined" as a finding.
  const { exports } = loadClientModule();
  const prompt = exports.agentLoadPrompt({
    name: "Test VN",
    gameDir: "D:\\games\\Test VN\\game",
    stats: { images: 1, audio: 1, scripts: 4, fonts: 1 },
  });

  assert.match(prompt, /Files: 1 images, 1 audio files, 4 scripts, 1 fonts\./);
  assert.doesNotMatch(prompt, /Archives/);
  assert.doesNotMatch(prompt, /undefined/);
});

test("a shuffle draw never lands on the track already playing", () => {
  // The rule the transport relies on: "next" in shuffle mode has to be a
  // different track. Drawing a fresh index from the `length - 1` others keeps
  // that true without a retry loop, and it holds at every position.
  const { exports } = loadClientModule();
  for (let current = 0; current < 5; current += 1) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const index = exports.shuffleIndex(5, current);
      assert.notEqual(index, current, "a draw must not repeat the current track");
      assert.ok(index >= 0 && index < 5, "a draw stays inside the list");
    }
  }
  assert.equal(exports.shuffleIndex(1, 0), 0, "a one-track list can only play that track");
  assert.ok(exports.shuffleIndex(4, -1) >= 0, "no selection yet still draws a real track");
});

test("one button reaches every playback mode and writes a state it can read back", () => {
  // The transport has a single mode button, so the cycle has to be closed:
  // four presses return to the start, every state is reachable, and the patch
  // each press writes must read back as that same state. A patch that left
  // `playlistRepeat` behind would come back as a fifth, unnameable mode.
  const { exports } = loadClientModule();
  const modes = ["order", "all", "one", "shuffle"];
  let mode = "order";
  const seen = [];
  for (let press = 0; press < modes.length; press += 1) {
    seen.push(mode);
    const patch = exports.PLAYBACK_PATCH[mode];
    assert.ok(patch !== undefined, `every mode has a patch: ${mode}`);
    const settings = { playlistRepeat: "off", playlistShuffle: false, ...patch };
    assert.equal(
      exports.playbackModeOf(settings),
      mode,
      `the written settings must read back as the state the button showed (${mode})`,
    );
    mode = exports.PLAYBACK_NEXT[mode];
  }
  assert.deepEqual(seen, modes, "one press per state, in a fixed order");
  assert.equal(mode, "order", "the cycle closes");
  // A shuffled config that still says `all` must not report "Repeat all".
  assert.equal(exports.playbackModeOf({ playlistRepeat: "all", playlistShuffle: true }), "shuffle");
  assert.equal(exports.playbackModeOf({}), "order", "an empty config means no looping");
});

test("the completion prompt is its own overlay layer, above every other", () => {
  // The offer has to be reachable from wherever the user is, including inside
  // the Session the agent is working in, so it is a layer of its own and not a
  // card in the settings page. Layer order is the z-index contract.
  assert.match(CLIENT_SOURCE, /id: "renpy-skin:profile-prompt", order: -860/);
  assert.match(CLIENT_SOURCE, /function ProfilePromptLayer\(\)/);
  // `.rsk-layer` is pointer-events:none (the host forces it on every overlay
  // child), so the mask has to take the pointer back or nothing is clickable.
  assert.match(CLIENT_SOURCE, /\.rsk-prompt \{ pointer-events: auto !important; \}/);
  assert.match(CLIENT_SOURCE, /className: "rsk-modal rsk-prompt"/);
  // Answered means gone: the offer is cleared, never left on screen.
  assert.match(CLIENT_SOURCE, /uiStore\.set\(\{ profilePrompt: undefined \}\)/);
});
