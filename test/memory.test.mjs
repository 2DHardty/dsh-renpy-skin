/**
 * Tests for the roleplay memory store and the roleplay brief.
 *
 * Memory is the part of the roleplay preset that outlives a conversation, so
 * the failures that matter are the quiet ones: a write that reports success but
 * lands nowhere, a memory that is silently truncated to nothing, a character
 * whose notes never reach the prompt, or a brief that leaks the user's name into
 * a session that is not roleplay. Each of those is pinned here.
 *
 * Usage:
 *   node --test "test/*.test.mjs"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMemory,
  clampMemory,
  MEMORY_HEAD,
  MEMORY_LIMIT,
  memoryHeads,
  memoryPath,
  readMemories,
  replaceMemory,
  writeMemories,
} from "../lib/memory.js";
import { roleplayBrief } from "../lib/index.js";

/** A throwaway data home the test removes afterwards. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "rsk-memory-test-"));
  return { home: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const PROFILE = "My Novel";

test("a memory round-trips through the store", () => {
  const { home, cleanup } = scratch();
  try {
    assert.deepEqual(readMemories(home, PROFILE), {}, "a game with no memory file reads as empty");

    const first = "She promised to visit the archive.";
    assert.deepEqual(appendMemory(home, PROFILE, "eileen", first), {
      ok: true,
      chars: first.length,
      trimmed: 0,
    });
    assert.equal(readMemories(home, PROFILE).eileen, first);

    // The second append keeps the first line: this is the "跨会话" half of the
    // feature, and an append that replaced would look identical in a one-line
    // test.
    appendMemory(home, PROFILE, "eileen", "She found the letter.");
    assert.equal(
      readMemories(home, PROFILE).eileen,
      "She promised to visit the archive.\nShe found the letter.",
    );

    // Another character's memory must not be touched by either write.
    replaceMemory(home, PROFILE, "lucy", "She is still angry about the vase.");
    assert.equal(readMemories(home, PROFILE).eileen, "She promised to visit the archive.\nShe found the letter.");
    assert.equal(readMemories(home, PROFILE).lucy, "She is still angry about the vase.");
  } finally {
    cleanup();
  }
});

test("an empty write deletes rather than storing a blank entry", () => {
  const { home, cleanup } = scratch();
  try {
    appendMemory(home, PROFILE, "eileen", "something");
    const removed = replaceMemory(home, PROFILE, "eileen", "   ");
    assert.deepEqual(removed, { ok: true, chars: 0, trimmed: 0 });
    assert.deepEqual(readMemories(home, PROFILE), {});
    // The file itself goes too: a `{}` left behind is indistinguishable from
    // "the user deleted everything" only by reading it, and the data directory
    // is meant to show what has actually been recorded.
    assert.equal(existsSync(memoryPath(home, PROFILE)), false);
  } finally {
    cleanup();
  }
});

test("an empty append is refused instead of silently doing nothing", () => {
  const { home, cleanup } = scratch();
  try {
    const result = appendMemory(home, PROFILE, "eileen", "  ");
    assert.equal(result.ok, false);
    assert.match(result.error, /empty/);
  } finally {
    cleanup();
  }
});

test("a memory longer than the limit keeps its newest part and reports the cut", () => {
  const { home, cleanup } = scratch();
  try {
    // Two entries whose combined length is over the cap, so the trim has a line
    // boundary to cut at — the boundary is the difference between a memory that
    // starts mid-sentence and one that starts at an entry.
    const older = "old line\n".repeat(400);
    const newest = "the newest thing";
    writeMemories(home, PROFILE, { eileen: clampMemory(older + newest).text });
    const result = appendMemory(home, PROFILE, "eileen", "x".repeat(MEMORY_LIMIT));
    assert.equal(result.ok, true);
    assert.ok(result.trimmed > 0, "the trim is reported, not silent");
    const stored = readMemories(home, PROFILE).eileen;
    assert.ok(stored.length <= MEMORY_LIMIT);
    assert.ok(stored.endsWith("x"), "the newest entry survives the trim");
  } finally {
    cleanup();
  }
});

test("a corrupt memory file reads as empty rather than failing a load", () => {
  const { home, cleanup } = scratch();
  try {
    writeMemories(home, PROFILE, { eileen: "fine" });
    writeFileSync(memoryPath(home, PROFILE), "{ not json", "utf8");
    assert.deepEqual(readMemories(home, PROFILE), {});
    // And a write over the wreckage still succeeds, so the next session is not
    // stuck with an unreadable file.
    assert.equal(appendMemory(home, PROFILE, "eileen", "recovered").ok, true);
    assert.equal(readMemories(home, PROFILE).eileen, "recovered");
  } finally {
    cleanup();
  }
});

test("memory heads follow the cast order and bound both per character and in total", () => {
  const memories = { lucy: "a", eileen: "b".repeat(MEMORY_HEAD + 50), renpy: "c" };
  const { entries } = memoryHeads(memories, ["eileen", "lucy"]);
  // The manifest's order wins for the characters it knows; a memory for a tag
  // the cast list forgot is still carried, after them, rather than dropped.
  assert.deepEqual(
    entries.map((entry) => entry.tag),
    ["eileen", "lucy", "renpy"],
  );
  const eileen = entries[0];
  assert.equal(eileen.truncated, true);
  assert.ok(eileen.text.length <= MEMORY_HEAD + 2, "only the newest part is carried");
  assert.equal(entries[1].truncated, false);
});

test("the roleplay brief names the user, carries the extra prompt and never invents a name", () => {
  const manifest = {
    game: { name: "My Novel" },
    tags: [{ tag: "eileen" }],
    characters: { e: { name: "Eileen", image: "eileen" } },
  };
  const named = roleplayBrief(manifest, {
    settings: { roleplayPrompt: "今晚下着雨。" },
    memories: { eileen: "She owes you an apology." },
    playerName: "阿岚",
  });
  assert.match(named, /阿岚/);
  assert.match(named, /今晚下着雨。/);
  assert.match(named, /She owes you an apology\./);
  assert.match(named, /renpy_memory/);
  // The stage dialect belongs to the stage-director section; a second copy here
  // would be the one that goes stale.
  assert.doesNotMatch(named, /Accepted syntax/);

  const unnamed = roleplayBrief(manifest, { settings: {}, memories: {}, playerName: "" });
  assert.match(unnamed, /没有设定名字/);
  assert.doesNotMatch(unnamed, /「」/);
  assert.match(unnamed, /还没有记下任何事/);
});

test("the memory route's file shape stays a plain tag-to-text map", () => {
  const { home, cleanup } = scratch();
  try {
    writeMemories(home, PROFILE, { eileen: "one", lucy: "two" });
    const raw = JSON.parse(readFileSync(memoryPath(home, PROFILE), "utf8"));
    assert.deepEqual(raw, { eileen: "one", lucy: "two" });
  } finally {
    cleanup();
  }
});