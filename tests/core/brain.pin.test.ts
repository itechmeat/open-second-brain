import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isPinned, setPinned } from "../../src/core/brain/pin.ts";
import { parseLogDay } from "../../src/core/brain/log.ts";
import { parsePreference, writePreference } from "../../src/core/brain/preference.ts";
import { BrainPreferenceNotFoundError } from "../../src/core/brain/apply-evidence.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import type { BrainPreference } from "../../src/core/brain/types.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pin-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-pin-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function makePref(slug: string, pinned: boolean): string {
  const r = writePreference(vault, {
    slug,
    topic: slug,
    principle: `Rule for ${slug}`,
    created_at: "2026-05-14T10:42:00Z",
    unconfirmed_until: "2026-05-28T10:42:00Z",
    status: "unconfirmed",
    evidenced_by: [`[[sig-2026-05-13-${slug}]]`],
    pinned,
  });
  return r.path;
}

describe("setPinned — happy paths", () => {
  test("false → true: changed: true, log gets a pin event, frontmatter flipped", () => {
    const path = makePref("flippable", false);
    const before = parsePreference(path);
    expect(before.pinned).toBe(false);

    const res = setPinned(vault, "flippable", true, {
      now: new Date("2026-05-14T07:00:00Z"),
      agent: "claude",
    });
    expect(res.changed).toBe(true);
    expect(res.path).toBe(path);

    const after = parsePreference(path);
    expect(after.pinned).toBe(true);

    const { entries } = parseLogDay(vault, "2026-05-14");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.eventType).toBe("pin");
    expect(entries[0]!.body["preference"]).toBe("[[pref-flippable|Rule for flippable]]");
    expect(entries[0]!.body["agent"]).toBe("claude");
  });

  test("true → false: changed: true, log gets an unpin event", () => {
    const path = makePref("unpinnable", true);
    const res = setPinned(vault, "unpinnable", false, {
      now: new Date("2026-05-14T08:00:00Z"),
    });
    expect(res.changed).toBe(true);
    const reparsed = parsePreference(path);
    expect(reparsed.pinned).toBe(false);

    const { entries } = parseLogDay(vault, "2026-05-14");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.eventType).toBe("unpin");
  });

  test("accepts both 'pref-foo' and 'foo' forms", () => {
    makePref("either-form", false);
    const a = setPinned(vault, "pref-either-form", true, {
      now: new Date("2026-05-14T09:00:00Z"),
    });
    expect(a.changed).toBe(true);
    // Idempotent path: prefixed form should still resolve to same file.
    const b = setPinned(vault, "either-form", true, {
      now: new Date("2026-05-14T09:00:01Z"),
    });
    expect(b.changed).toBe(false);
  });
});

describe("setPinned — idempotency", () => {
  test("true → true: changed: false and no log event", () => {
    makePref("already-pinned", true);

    const res = setPinned(vault, "already-pinned", true, {
      now: new Date("2026-05-14T10:00:00Z"),
    });
    expect(res.changed).toBe(false);

    // The log file should not have been created on an idempotent
    // no-op — the appender writes the canonical header on first
    // event, so a missing file is the cleanest assertion.
    const { entries } = parseLogDay(vault, "2026-05-14");
    expect(entries).toEqual([]);
  });

  test("false → false: changed: false and no log event", () => {
    makePref("never-pinned", false);
    const res = setPinned(vault, "never-pinned", false, {
      now: new Date("2026-05-14T10:00:00Z"),
    });
    expect(res.changed).toBe(false);
    const { entries } = parseLogDay(vault, "2026-05-14");
    expect(entries).toEqual([]);
  });
});

describe("setPinned — body preservation", () => {
  test("preference body (How to apply section, etc) is unchanged", () => {
    const path = makePref("preserve-body", false);
    const before = readFileSync(path, "utf8");
    const bodyBefore = before.split("---\n").slice(2).join("---\n");

    setPinned(vault, "preserve-body", true, {
      now: new Date("2026-05-14T10:00:00Z"),
    });

    const after = readFileSync(path, "utf8");
    const bodyAfter = after.split("---\n").slice(2).join("---\n");
    expect(bodyAfter).toBe(bodyBefore);
  });
});

describe("setPinned — error paths", () => {
  test("missing preference throws BrainPreferenceNotFoundError", () => {
    expect(() => setPinned(vault, "does-not-exist", true)).toThrow(BrainPreferenceNotFoundError);
  });

  test("empty pref_id throws", () => {
    expect(() => setPinned(vault, "", true)).toThrow(/missing field|empty slug/);
  });
});

describe("isPinned — accessor", () => {
  test("returns false on a parsed preference whose frontmatter omits pinned", () => {
    // Construct an object that mimics a parsed preference with
    // pinned: false (the parser's default).
    const fake: BrainPreference = Object.freeze({
      kind: "brain-preference",
      id: "pref-x",
      created_at: "2026-05-14T10:42:00Z",
      confirmed_at: null,
      unconfirmed_until: "2026-05-28T10:42:00Z",
      tags: ["brain"],
      topic: "x",
      status: "unconfirmed",
      principle: "...",
      evidenced_by: [],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence: "low",
      confidence_value: null,
      pinned: false,
    });
    expect(isPinned(fake)).toBe(false);
  });

  test("returns true when frontmatter explicitly sets pinned: true", () => {
    makePref("explicit-pinned", true);
    const parsed = parsePreference(`${vault}/Brain/preferences/pref-explicit-pinned.md`);
    expect(isPinned(parsed)).toBe(true);
  });
});
