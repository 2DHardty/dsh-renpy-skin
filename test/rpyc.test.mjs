// The `.rpyc` half of the test suite: decompile REAL compiled Ren'Py scripts
// with the REAL unrpyc tool, not a hand-written fixture.
//
// The rpa test file records why this matters: the first RPA reader shared its
// author's misunderstanding of the pickle format with a hand-rolled fixture,
// so the two "verified" each other while both being wrong about every real
// archive on disk. The same rule applies here. `isRpyc` and `decompileRpyc`
// are exercised against `.rpyc` bytes produced by the actual Ren'Py compiler
// (the `testcases/compiled/` set shipped inside the unrpyc checkout), so the
// magic-number check can only pass by agreeing with what unrpyc itself reads.
//
// Two groups of tests below:
//   - A few always run. They assert the DIAGNOSIS, because "the decompiler is
//     absent on this machine" used to be reported by five silent skips and
//     nothing else, so a dead decompilation chain looked exactly like a green
//     suite.
//   - The real decompilation tests need an actual unrpyc checkout. They are
//     skipped only when there is none, and the skip message says so.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureTools,
  configuredToolPaths,
  decompileRpyc,
  decompileRpycBatch,
  decompileRpycMany,
  findPython,
  findUnrpyc,
  isRpyc,
  rpycDiagnostics,
  unrpycToolsDir,
} from "../lib/rpyc.js";

/**
 * The unrpyc checkout whose fixtures are compiled scripts.
 *
 * Derived from the environment only — never from a drive letter that happens to
 * exist on the machine this test was written on, because a hardcoded default
 * turns "no unrpyc here" into a test that fails for the next person instead of
 * skipping with a reason.
 */
const UNRPYC = findUnrpyc();
const UNRPYC_ROOT = process.env.DSH_RENPY_UNRPYC_ROOT ??
  (UNRPYC === null ? undefined : join(UNRPYC, ".."));
const FIXTURE_SKIP = UNRPYC === null
  ? "这台机器上没有 unrpyc（可用 DSH_RENPY_UNRPYC 指定 unrpyc.py，或 DSH_RENPY_UNRPYC_ROOT 指定检出目录），因此跳过真实反编译用例"
  : findPython() === null
    ? "找到了 unrpyc 但没有可用的 Python 解释器，因此跳过真实反编译用例"
    : UNRPYC_ROOT === undefined
      ? "没有 unrpyc 检出目录，因此跳过需要编译器产物的用例"
      : false;

/** A real compiled script from the checkout, or undefined when unavailable. */
function fixture(...segments) {
  if (UNRPYC_ROOT === undefined) return undefined;
  try {
    return readFileSync(join(UNRPYC_ROOT, ...segments));
  } catch {
    return undefined;
  }
}

const SCRIPT_RPYC = fixture("testcases", "compiled", "the_question-8.2", "script.rpyc");
const OPTIONS_RPYC = fixture("testcases", "compiled", "the_question-8.2", "options.rpyc");
// The only bundled fixture that genuinely declares `image` statements (the
// plugin's image discovery depends on those surviving decompilation).
const TUTORIAL_VIDEO_RPYC = fixture(
  "testcases",
  "compiled",
  "tutorial-8.2",
  "tutorial_video.rpyc",
);

const FIXTURE_BYTES_SKIP = SCRIPT_RPYC === undefined
  ? "没有找到 unrpyc 自带编译器产物（testcases/compiled/the_question-8.2/script.rpyc），因此跳过"
  : false;

// ---------------------------------------------------------------------------
// Always-on: the diagnosis. These never skip, so the state of the decompilation
// chain is visible on every machine instead of hidden behind skips.
// ---------------------------------------------------------------------------

test("rpycDiagnostics always returns the documented shape and never throws", () => {
  const diagnostics = rpycDiagnostics({ refresh: true });
  assert.equal(typeof diagnostics, "object");
  assert.ok(diagnostics !== null);

  // python
  assert.ok(diagnostics.python !== null && typeof diagnostics.python === "object");
  assert.ok(
    diagnostics.python.path === null || typeof diagnostics.python.path === "string",
    "python.path is a string or null",
  );
  assert.ok(Array.isArray(diagnostics.python.checked), "python.checked is an array");
  assert.ok(
    diagnostics.python.reason === null || typeof diagnostics.python.reason === "string",
  );

  // unrpyc
  assert.ok(diagnostics.unrpyc !== null && typeof diagnostics.unrpyc === "object");
  assert.ok(
    diagnostics.unrpyc.path === null || typeof diagnostics.unrpyc.path === "string",
  );
  assert.ok(Array.isArray(diagnostics.unrpyc.tried), "unrpyc.tried is an array");
  assert.ok(
    diagnostics.unrpyc.tried.length > 0,
    "unrpyc.tried must never be empty: the lookup always has at least one candidate",
  );
  assert.equal(typeof diagnostics.unrpyc.toolsDir, "string");

  // top level
  assert.ok(diagnostics.reason === null || typeof diagnostics.reason === "string");
  assert.equal(typeof diagnostics.usable, "boolean");
  assert.ok(diagnostics.install === null || typeof diagnostics.install === "string");
  assert.equal(
    diagnostics.usable,
    diagnostics.python.path !== null && diagnostics.unrpyc.path !== null,
    "usable is exactly 'both tools resolved'",
  );

  // A reason and an install hint are two halves of one contract.
  if (diagnostics.reason === null) {
    assert.equal(diagnostics.usable, true, "no reason means the chain is usable");
    assert.equal(diagnostics.install, null, "nothing to install when usable");
  } else {
    assert.ok(diagnostics.reason.length > 0, "a reported reason is never empty");
    assert.equal(typeof diagnostics.install, "string");
    assert.ok(diagnostics.install.length > 0, "a failure always carries an install hint");
  }

  // The one thing a user can actually act on: if the reason is "no unrpyc", the
  // text has to name unrpyc, or it describes a different problem.
  if (diagnostics.unrpyc.path === null) {
    assert.match(
      diagnostics.reason ?? "",
      /unrpyc/i,
      "a missing unrpyc is named in the reason",
    );
    assert.match(
      diagnostics.install ?? "",
      /unrpyc/i,
      "the install instructions name unrpyc",
    );
  }
});

test("the diagnosis is cached, and { refresh: true } re-probes", () => {
  const first = rpycDiagnostics({ refresh: true });
  const cached = rpycDiagnostics();
  assert.equal(cached, first, "the same object is handed back until refreshed");
  const refreshed = rpycDiagnostics({ refresh: true });
  assert.notEqual(refreshed, first, "refresh re-probes and returns a new object");
  assert.deepEqual(
    { usable: refreshed.usable, reason: refreshed.reason },
    { usable: first.usable, reason: first.reason },
    "re-probing the same machine reaches the same conclusion",
  );
});

test("unrpyc.tried survives a DSH_RENPY_TOOLS directory that does not exist", () => {
  // Regression: `unrpycCandidates()` used to compute its candidates inside the
  // same try/catch as `readdirSync`, so an absent tools directory deleted the
  // whole ~/Tools branch from the list and the log read "tried unrpyc.py" —
  // losing the one fact the lookup had just established.
  const missing = join(
    unrpycToolsDir() ?? process.cwd(),
    "dsh-renpy-skin-test-missing-tools-dir",
  );
  const previous = process.env.DSH_RENPY_TOOLS;
  const previousUnrpyc = process.env.DSH_RENPY_UNRPYC;
  try {
    process.env.DSH_RENPY_TOOLS = missing;
    delete process.env.DSH_RENPY_UNRPYC;
    const diagnostics = rpycDiagnostics({ refresh: true });
    const { tried } = diagnostics.unrpyc;

    const bare = join(missing, "unrpyc.py");
    assert.ok(
      tried.includes(bare),
      `the tools directory is reported even though it does not exist: ${tried.join(", ")}`,
    );
    assert.ok(
      tried.includes("unrpyc.py"),
      "the PATH candidate is still reported after a failed directory scan",
    );
    assert.ok(
      diagnostics.unrpyc.reason !== null,
      "an absent tools directory still produces a reason",
    );
    assert.match(diagnostics.unrpyc.reason, /unrpyc/i);
  } finally {
    if (previous === undefined) delete process.env.DSH_RENPY_TOOLS;
    else process.env.DSH_RENPY_TOOLS = previous;
    if (previousUnrpyc === undefined) delete process.env.DSH_RENPY_UNRPYC;
    else process.env.DSH_RENPY_UNRPYC = previousUnrpyc;
    rpycDiagnostics({ refresh: true });
  }
});

test("the vendor directory is always among the unrpyc candidates", () => {
  const diagnostics = rpycDiagnostics({ refresh: true });
  const vendored = diagnostics.unrpyc.tried.some((entry) =>
    entry.includes(`${join("vendor", "unrpyc", "unrpyc.py")}`),
  );
  assert.ok(
    vendored,
    `the plugin's own vendor/unrpyc/unrpyc.py is a candidate: ${diagnostics.unrpyc.tried.join(", ")}`,
  );
});

test("decompileRpycBatch({}, ...) is empty rather than fatal", () => {
  const result = decompileRpycBatch([], {});
  assert.ok(result.files instanceof Map, "files is a Map");
  assert.equal(result.files.size, 0);
  assert.equal(result.diagnostics.attempted, 0);
  assert.equal(result.diagnostics.decompiled, 0);
  assert.equal(result.diagnostics.failed, 0);
  assert.equal(
    result.diagnostics.reason,
    null,
    "nothing handed over is not a failure and must not invent a reason",
  );

  // Non-array and blank-byte inputs must not throw either.
  const fallback = decompileRpycBatch(undefined, {});
  assert.equal(fallback.files.size, 0);
});

test("decompileRpycBatch reports why a batch could not run", () => {
  const result = decompileRpycBatch(
    [{ name: "scripts/gui.rpyc", bytes: SCRIPT_RPYC ?? Buffer.from("RENPY RPC2junk") }],
    { python: null },
  );
  assert.equal(result.files.size, 0, "no interpreter means no output");
  assert.equal(result.diagnostics.attempted, 1, "the entry was handed over");
  assert.equal(result.diagnostics.decompiled, 0);
  assert.equal(result.diagnostics.failed, 1);
  assert.equal(typeof result.diagnostics.reason, "string");
  assert.ok(result.diagnostics.reason.length > 0);
  // python missing is the injected cause here, so that is what must be named.
  assert.match(result.diagnostics.reason, /python/i);
});

test("decompileRpycBatch names the missing tool when unrpyc is absent", () => {
  const result = decompileRpycBatch(
    [{ name: "scripts/gui.rpyc", bytes: SCRIPT_RPYC ?? Buffer.from("RENPY RPC2junk") }],
    { unrpyc: null },
  );
  assert.equal(result.files.size, 0);
  assert.equal(result.diagnostics.failed, 1);
  // The injected miss is "unrpyc is absent", but on a machine that also lacks
  // Python the full probe is the honest answer and may mention both.
  assert.match(result.diagnostics.reason ?? "", /unrpyc|python/i);
});

test("decompileRpycBatch reports a process that never started as such", () => {
  // Regression: an unrpyc that cannot be spawned at all (a host that denies
  // child processes, an interpreter that vanished) used to be reported as
  // "unrpyc failed to decompile all 1 script(s)" — blaming the bytecode for an
  // environment fault, which sends the reader to the wrong fix.
  const result = decompileRpycBatch(
    [{ name: "scripts/gui.rpyc", bytes: SCRIPT_RPYC ?? Buffer.from("RENPY RPC2junk") }],
    {
      python: join(tmpdir(), "dsh-renpy-skin-no-such-python"),
      unrpyc: join(tmpdir(), "dsh-renpy-skin-no-such-unrpyc.py"),
    },
  );
  assert.equal(result.files.size, 0);
  assert.equal(result.diagnostics.attempted, 1);
  assert.equal(result.diagnostics.decompiled, 0);
  assert.equal(result.diagnostics.failed, 1);
  const reason = result.diagnostics.reason ?? "";
  assert.match(
    reason,
    /could not run|ENOENT|EPERM|spawn/i,
    `a spawn failure is reported in its own words, got: ${reason}`,
  );
  assert.doesNotMatch(
    reason,
    /failed to decompile all/i,
    "a process that never started is not a decompilation failure",
  );
});

test("configureTools puts the settings page ahead of the environment and the probes", () => {
  // The settings page is the only place a user can fix "unrpyc not found"
  // without editing the environment. If its value were merely appended to the
  // candidate list, the field would look saved and change nothing when an
  // earlier candidate still wins; and a configured interpreter that cannot run
  // must fail loudly instead of silently falling back to PATH, or the page
  // would report success while the path the user typed names something else.
  const dir = mkdtempSync(join(tmpdir(), "dsh-rpyc-configured-"));
  const chosen = join(dir, "my-unrpyc.py");
  const toolsDir = join(dir, "tools");
  // A real file: `findUnrpyc` only checks that the path exists, never runs it.
  writeFileSync(chosen, "# configured by the settings page\n", "utf8");
  const fromEnvironment = join(dir, "from-environment.py");
  const previous = {
    unrpyc: process.env.DSH_RENPY_UNRPYC,
    tools: process.env.DSH_RENPY_TOOLS,
    python: process.env.DSH_RENPY_PYTHON,
  };
  try {
    const bogusPython = join(dir, "no-such-python.exe");
    process.env.DSH_RENPY_UNRPYC = fromEnvironment;
    delete process.env.DSH_RENPY_TOOLS;
    delete process.env.DSH_RENPY_PYTHON;

    configureTools({ python: bogusPython, unrpyc: chosen, toolsDir });
    assert.deepEqual(configuredToolPaths(), { python: bogusPython, unrpyc: chosen, toolsDir });

    const diagnosis = rpycDiagnostics({ refresh: true });
    // The configured path is both tried first and the one that wins; the
    // environment variable is still listed, just no longer used.
    assert.equal(diagnosis.unrpyc.tried[0], chosen);
    assert.ok(
      diagnosis.unrpyc.tried.includes(fromEnvironment),
      "the environment candidate is still reported, so the page can explain the precedence",
    );
    assert.equal(diagnosis.unrpyc.path, chosen);
    assert.equal(diagnosis.unrpyc.source, "setting");
    assert.equal(diagnosis.unrpyc.toolsDir, toolsDir);
    assert.equal(diagnosis.unrpyc.toolsDirSource, "setting");
    assert.equal(findUnrpyc(), chosen);

    assert.equal(findPython(), null, "a configured interpreter never falls back to another one");
    assert.equal(diagnosis.python.path, null);
    assert.equal(diagnosis.python.checked[0], bogusPython);
    assert.match(diagnosis.python.reason ?? "", /settings page/i);
    assert.equal(diagnosis.usable, false);
    assert.equal(typeof diagnosis.install, "string");

    // The documented shape still holds with paths configured.
    assert.ok(Array.isArray(diagnosis.python.checked));
    assert.ok(Array.isArray(diagnosis.unrpyc.tried) && diagnosis.unrpyc.tried.length > 0);
  } finally {
    // Leaving a path configured would poison every later test in this file that
    // relies on the environment or on probing this machine.
    configureTools({ python: "", unrpyc: "", toolsDir: "" });
    if (previous.unrpyc === undefined) delete process.env.DSH_RENPY_UNRPYC;
    else process.env.DSH_RENPY_UNRPYC = previous.unrpyc;
    if (previous.tools === undefined) delete process.env.DSH_RENPY_TOOLS;
    else process.env.DSH_RENPY_TOOLS = previous.tools;
    if (previous.python === undefined) delete process.env.DSH_RENPY_PYTHON;
    else process.env.DSH_RENPY_PYTHON = previous.python;
    rmSync(dir, { recursive: true, force: true });
    rpycDiagnostics({ refresh: true });
  }
});

test("a checkout folder is accepted where the unrpyc file is expected", () => {
  // Real report: our own install instructions hand the user a folder
  // (`D:\Tools\unrpyc-2.0.4`), so that folder is what gets typed into the
  // "unrpyc" field. Treating it as a file candidate answered "unrpyc not
  // found" while the tool sat one level down — which reads as "the field does
  // nothing", not as "point one level deeper".
  const dir = mkdtempSync(join(tmpdir(), "dsh-rpyc-folder-"));
  const checkout = join(dir, "unrpyc-2.0.4");
  const empty = join(dir, "empty-checkout");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(empty, { recursive: true });
  const previous = {
    unrpyc: process.env.DSH_RENPY_UNRPYC,
    tools: process.env.DSH_RENPY_TOOLS,
  };
  try {
    delete process.env.DSH_RENPY_UNRPYC;
    delete process.env.DSH_RENPY_TOOLS;
    writeFileSync(join(checkout, "unrpyc.py"), "# unpacked checkout\n", "utf8");

    configureTools({ unrpyc: checkout });
    const diagnosis = rpycDiagnostics({ refresh: true });
    const inside = join(checkout, "unrpyc.py");
    assert.equal(findUnrpyc(), inside, "a folder resolves to the unrpyc.py inside it");
    assert.equal(diagnosis.unrpyc.path, inside);
    assert.equal(
      diagnosis.unrpyc.tried[0],
      inside,
      "the report names the file that was checked, not the folder that was typed",
    );

    // The folder without the file is the case that must explain itself. It is
    // only observable when no other source supplies unrpyc, so the always-run
    // assertion above carries the regression; this half adds the wording when
    // this machine really has nothing else.
    configureTools({ unrpyc: empty });
    const missing = rpycDiagnostics({ refresh: true });
    if (missing.unrpyc.path === null) {
      assert.match(missing.unrpyc.reason ?? "", /is a folder/i);
      assert.match(missing.unrpyc.reason ?? "", /no unrpyc\.py inside it/i);
    }
  } finally {
    configureTools({ python: "", unrpyc: "", toolsDir: "" });
    if (previous.unrpyc === undefined) delete process.env.DSH_RENPY_UNRPYC;
    else process.env.DSH_RENPY_UNRPYC = previous.unrpyc;
    if (previous.tools === undefined) delete process.env.DSH_RENPY_TOOLS;
    else process.env.DSH_RENPY_TOOLS = previous.tools;
    rmSync(dir, { recursive: true, force: true });
    rpycDiagnostics({ refresh: true });
  }
});

// ---------------------------------------------------------------------------
// Always-on: pure byte checks (no external tool involved).
// ---------------------------------------------------------------------------

test("isRpyc rejects plain text, empties, paths and null", () => {
  assert.equal(
    isRpyc(Buffer.from("define gui.text_size = 22\n")),
    false,
    "plain .rpy source is not a compiled script",
  );
  assert.equal(isRpyc(Buffer.alloc(0)), false, "empty buffer is not rpyc");
  assert.equal(
    isRpyc("D:\\some\\path.rpyc"),
    false,
    "a path string is not bytes; isRpyc never stats the filesystem",
  );
  assert.equal(isRpyc(null), false, "null is not rpyc");
  assert.equal(
    isRpyc(Buffer.from("RENPY RPC2")),
    true,
    "the v2 magic alone is enough to be recognised",
  );
});

test("decompileRpyc returns null for empty input and for garbage", () => {
  assert.equal(decompileRpyc(Buffer.alloc(0)), null);
  // A plain text blob will not parse as rpyc; unrpyc fails and we degrade.
  // `unrpyc: null` keeps this from costing a Python spawn on machines that do
  // have the tool.
  assert.equal(
    decompileRpyc(Buffer.from("this is not a compiled script\n"), { unrpyc: null }),
    null,
  );
});

test("decompileRpyc returns null when python or unrpyc is missing", () => {
  // Force the "no interpreter"/"no tool" branch without touching the process PATH.
  const bytes = SCRIPT_RPYC ?? Buffer.from("RENPY RPC2junk");
  assert.equal(decompileRpyc(bytes, { python: null }), null);
  assert.equal(decompileRpyc(bytes, { unrpyc: null }), null);
});

test("decompileRpycMany still returns a bare empty map when unrpyc is missing", () => {
  // `lib/manifest.js` consumes the Map directly; the added diagnosis must not
  // leak into this return type.
  const result = decompileRpycMany(
    [{ name: "scripts/gui.rpyc", bytes: SCRIPT_RPYC ?? Buffer.from("RENPY RPC2junk") }],
    { unrpyc: null },
  );
  assert.ok(result instanceof Map, "decompileRpycMany returns a Map, not a wrapper");
  assert.equal(result.size, 0);
  assert.deepEqual([...result.keys()], []);
});

test("decompileRpycMany and decompileRpycBatch agree on the files", () => {
  const entries = [
    { name: "scripts/gui.rpyc", bytes: SCRIPT_RPYC ?? Buffer.from("RENPY RPC2junk") },
  ];
  const options = { python: null, unrpyc: null };
  const files = decompileRpycMany(entries, options);
  const batch = decompileRpycBatch(entries, options);
  assert.deepEqual([...files.entries()], [...batch.files.entries()]);
});

// ---------------------------------------------------------------------------
// Real decompilation. Skipped only when this machine really cannot do it, and
// the skip message says which half is missing.
// ---------------------------------------------------------------------------

test("isRpyc accepts a real compiled script", { skip: FIXTURE_BYTES_SKIP }, () => {
  assert.equal(isRpyc(SCRIPT_RPYC), true, "compiler output should read as rpyc");
  assert.equal(
    isRpyc(new Uint8Array(SCRIPT_RPYC)),
    true,
    "Uint8Array input is accepted",
  );
});

test("decompileRpyc returns the real decompiled source of a compiled script", {
  skip: FIXTURE_SKIP,
}, () => {
  const source = decompileRpyc(SCRIPT_RPYC);
  assert.equal(typeof source, "string", "decompile should return text");
  assert.ok(source.length > 0, "decompiled source is non-empty");
  // `the_question/script.rpy` has `define`+`label` but no `image` statement;
  // assert what the source actually contains, not what a guess expected.
  for (const keyword of ["label", "define"]) {
    assert.ok(
      source.includes(keyword),
      `decompiled source should contain ${JSON.stringify(keyword)}`,
    );
  }
});

test("decompileRpyc recovers image statements from a fixture that has them", {
  skip: TUTORIAL_VIDEO_RPYC === undefined
    ? "这台机器上没有 unrpyc 的 tutorial-8.2 编译产物，因此跳过"
    : FIXTURE_SKIP,
}, () => {
  const source = decompileRpyc(TUTORIAL_VIDEO_RPYC);
  assert.ok(source.includes("image"), "image statements survive decompilation");
});

test("decompileRpyc accepts a path and reads the compiled file", {
  skip: FIXTURE_SKIP,
}, () => {
  const source = decompileRpyc(join(
    UNRPYC_ROOT,
    "testcases",
    "compiled",
    "the_question-8.2",
    "script.rpyc",
  ));
  assert.equal(typeof source, "string");
  assert.ok(source.includes("label start:"), "the_question script has a start label");
});

test("decompileRpyc recovers gui/config defines from options.rpyc", {
  skip: OPTIONS_RPYC === undefined
    ? "这台机器上没有 unrpyc 的 options.rpyc 编译产物，因此跳过"
    : FIXTURE_SKIP,
}, () => {
  const source = decompileRpyc(OPTIONS_RPYC);
  assert.ok(source.includes("define"), "options decompiles to define statements");
});

test("decompileRpycMany decompiles several real rpyc files in one call", {
  skip: OPTIONS_RPYC === undefined
    ? "这台机器上没有 unrpyc 的 the_question-8.2 编译产物，因此跳过"
    : FIXTURE_SKIP,
}, () => {
  const result = decompileRpycMany([
    { name: "scripts/gui.rpyc", bytes: SCRIPT_RPYC },
    { name: "scripts/options.rpyc", bytes: OPTIONS_RPYC },
  ]);
  assert.ok(result.has("scripts/gui.rpyc"), "gui.rpyc decompiles");
  assert.ok(result.has("scripts/options.rpyc"), "options.rpyc decompiles");
  assert.ok(result.get("scripts/gui.rpyc").length > 0);
});

test("decompileRpycBatch counts what it attempted and what it got", {
  skip: FIXTURE_SKIP,
}, () => {
  const result = decompileRpycBatch([
    { name: "scripts/gui.rpyc", bytes: SCRIPT_RPYC },
    { name: "scripts/options.rpyc", bytes: OPTIONS_RPYC ?? SCRIPT_RPYC },
  ]);
  assert.equal(result.diagnostics.attempted, 2);
  assert.equal(
    result.diagnostics.decompiled,
    result.files.size,
    "the count and the map describe the same successes",
  );
  assert.equal(
    result.diagnostics.decompiled + result.diagnostics.failed,
    result.diagnostics.attempted,
    "every attempted entry is either decompiled or failed",
  );
  assert.equal(result.diagnostics.reason, null, "a clean run has no reason");
});
