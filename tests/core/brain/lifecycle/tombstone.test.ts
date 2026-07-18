import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter, writeFrontmatter } from "../../../../src/core/vault.ts";
import { readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import {
  TombstoneError,
  isTombstoned,
  readLifecycleState,
  resolveChainTip,
  resolveChainTipInVault,
  supersede,
  tombstone,
} from "../../../../src/core/brain/lifecycle/tombstone.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-tombstone-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, extra: Record<string, string> = {}, body = "Prose."): string {
  const rel = join("Brain", "preferences", `pref-${slug}.md`);
  writeFrontmatter(
    join(vault, rel),
    {
      kind: "brain-preference",
      id: `pref-${slug}`,
      _status: "confirmed",
      topic: slug,
      principle: `principle for ${slug}`,
      tags: ["brain"],
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-02-01T00:00:00Z",
      ...extra,
    },
    body,
  );
  return rel;
}

const NOW = new Date("2026-07-18T12:00:00Z");

test("tombstone sets lifecycle frontmatter without deleting the file and preserves the body", () => {
  const rel = writePref("alpha", {}, "This is the human prose body.");
  const res = tombstone({ vault, path: rel, reason: "wrong belief", agent: "tester", now: NOW });

  expect(res.changed).toBe(true);
  expect(res.state.tombstoned).toBe(true);
  expect(res.state.tombstoneReason).toBe("wrong belief");
  expect(res.state.tombstonedAt).toBe("2026-07-18T12:00:00Z");

  const [meta, body] = parseFrontmatter(join(vault, rel));
  expect(meta["_status"]).toBe("tombstoned");
  expect(meta["tombstoned_at"]).toBe("2026-07-18T12:00:00Z");
  expect(meta["tombstone_reason"]).toBe("wrong belief");
  expect(body).toBe("This is the human prose body.");
});

test("re-issuing a tombstone is a byte-identical no-op returning the existing state", () => {
  const rel = writePref("beta");
  tombstone({ vault, path: rel, reason: "first", agent: "tester", now: NOW });
  const after1 = readFileSync(join(vault, rel), "utf8");

  const res2 = tombstone({
    vault,
    path: rel,
    reason: "different reason",
    agent: "tester",
    now: new Date("2026-07-19T00:00:00Z"),
  });
  const after2 = readFileSync(join(vault, rel), "utf8");

  expect(res2.changed).toBe(false);
  expect(res2.state.tombstoneReason).toBe("first");
  expect(after2).toBe(after1);
});

test("tombstone logs exactly one tombstone event on the changing write and none on the no-op", () => {
  const rel = writePref("gamma");
  tombstone({ vault, path: rel, reason: "obsolete", agent: "tester", now: NOW });
  tombstone({ vault, path: rel, reason: "obsolete", agent: "tester", now: NOW });

  const { entries } = readLogDay(vault, "2026-07-18");
  const tombstones = entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.tombstone);
  expect(tombstones.length).toBe(1);
  expect(tombstones[0]!.body["reason"]).toBe("obsolete");
  expect(tombstones[0]!.body["prior_status"]).toBe("confirmed");
});

test("tombstone throws a typed error when the target does not exist", () => {
  expect(() =>
    tombstone({ vault, path: "Brain/preferences/pref-missing.md", reason: "x", now: NOW }),
  ).toThrow(TombstoneError);
});

test("tombstone throws a typed error on an empty reason", () => {
  const rel = writePref("delta");
  expect(() => tombstone({ vault, path: rel, reason: "   ", now: NOW })).toThrow(TombstoneError);
});

test("supersede tombstones the predecessor and records the replacement pointer", () => {
  const oldRel = writePref("old-fact");
  writePref("new-fact");

  const res = supersede({
    vault,
    predecessor: oldRel,
    successor: "pref-new-fact",
    agent: "tester",
    now: NOW,
  });

  expect(res.changed).toBe(true);
  expect(res.state.tombstoned).toBe(true);
  expect(res.state.supersededBy).toBe("[[pref-new-fact]]");

  const [meta] = parseFrontmatter(join(vault, oldRel));
  expect(meta["_status"]).toBe("tombstoned");
  expect(meta["superseded_by"]).toBe("[[pref-new-fact]]");
});

test("isTombstoned reads both the prefixed and normalized status key", () => {
  expect(isTombstoned({ _status: "tombstoned" })).toBe(true);
  expect(isTombstoned({ status: "tombstoned" })).toBe(true);
  expect(isTombstoned({ _status: "confirmed" })).toBe(false);
  expect(isTombstoned({})).toBe(false);
});

test("readLifecycleState reports the superseded_by pointer normalized", () => {
  const state = readLifecycleState({ _status: "tombstoned", superseded_by: "[[pref-x]]" });
  expect(state.tombstoned).toBe(true);
  expect(state.supersededBy).toBe("[[pref-x]]");
});

function mapLookup(
  map: Record<string, string | null>,
): (link: string) => { supersededBy: string | null } | null {
  return (link) => (link in map ? { supersededBy: map[link]! } : null);
}

test("resolveChainTip walks a chain of superseded_by links to the live tip", () => {
  const res = resolveChainTip(
    "[[pref-a]]",
    mapLookup({ "pref-a": "[[pref-b]]", "pref-b": "[[pref-c]]", "pref-c": null }),
  );
  expect(res.tip).toBe("pref-c");
  expect(res.steps).toBe(2);
  expect(res.cycle).toBe(false);
  expect(res.resolvedAll).toBe(true);
});

test("resolveChainTip detects a cycle instead of looping forever", () => {
  const res = resolveChainTip(
    "pref-a",
    mapLookup({ "pref-a": "[[pref-b]]", "pref-b": "[[pref-a]]" }),
  );
  expect(res.cycle).toBe(true);
});

test("resolveChainTip returns the start unchanged when it has no successor", () => {
  const res = resolveChainTip("pref-solo", () => ({ supersededBy: null }));
  expect(res.tip).toBe("pref-solo");
  expect(res.steps).toBe(0);
});

test("resolveChainTipInVault follows real supersede chains on disk", () => {
  const oldRel = writePref("v1");
  writePref("v2");
  supersede({ vault, predecessor: oldRel, successor: "pref-v2", now: NOW });

  const res = resolveChainTipInVault(vault, "pref-v1");
  expect(res.tip).toBe("pref-v2");
});

test("tombstone works cross-type on a signal file", () => {
  const rel = join("Brain", "inbox", "sig-2026-01-01-note.md");
  writeFrontmatter(
    join(vault, rel),
    { kind: "brain-signal", id: "sig-2026-01-01-note", topic: "note", signal: "positive" },
    "signal body",
  );
  const res = tombstone({ vault, path: rel, reason: "captured in error", now: NOW });
  expect(res.changed).toBe(true);
  const [meta, body] = parseFrontmatter(join(vault, rel));
  expect(meta["_status"]).toBe("tombstoned");
  expect(body).toBe("signal body");
});
