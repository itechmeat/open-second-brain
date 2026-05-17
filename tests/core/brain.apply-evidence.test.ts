import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BrainPreferenceNotFoundError,
  appendApplyEvidence,
} from "../../src/core/brain/apply-evidence.ts";
import { parseLogDay } from "../../src/core/brain/log.ts";
import { brainConfigPath, logPath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-apply-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-apply-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  // bootstrapBrain wrote `_brain.yaml`; existence sanity-check.
  if (!existsSync(brainConfigPath(vault))) {
    throw new Error("test setup failed: _brain.yaml not created");
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function prefFixture(slug: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `Rule for ${slug}`,
    created_at: "2026-05-14T10:42:00Z",
    unconfirmed_until: "2026-05-28T10:42:00Z",
    status: "unconfirmed",
    evidenced_by: [`[[sig-2026-05-13-${slug}]]`],
    scope: "writing",
    confirmed_at: null,
  });
}

describe("appendApplyEvidence — happy path", () => {
  test("logs one apply-evidence event with the expected fields", () => {
    prefFixture("no-internal-abbrev");

    const now = new Date("2026-05-14T14:22:00Z");
    const res = appendApplyEvidence(
      vault,
      {
        pref_id: "pref-no-internal-abbrev",
        artifact: "[[Daily/2026.05.14#section]]",
        result: "applied",
        agent: "claude",
        note: "Expanded OSB on first use.",
      },
      { now },
    );

    expect(res.logged_at).toBe("2026-05-14T14:22:00Z");
    expect(res.log_path).toBe(logPath(vault, "2026-05-14"));

    const { entries, warnings } = parseLogDay(vault, "2026-05-14");
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.eventType).toBe("apply-evidence");
    expect(e.timestamp).toBe("2026-05-14T14:22:00Z");
    expect(e.body["preference"]).toBe("[[pref-no-internal-abbrev|Rule for no-internal-abbrev]]");
    expect(e.body["artifact"]).toBe("[[Daily/2026.05.14#section]]");
    expect(e.body["agent"]).toBe("claude");
    expect(e.body["result"]).toBe("applied");
    expect(e.body["note"]).toBe("Expanded OSB on first use.");
  });

  test("accepts the bare slug form (without `pref-` prefix)", () => {
    prefFixture("foo-rule");
    const res = appendApplyEvidence(
      vault,
      {
        pref_id: "foo-rule",
        artifact: "[[bar]]",
        result: "violated",
        agent: "claude",
      },
      { now: new Date("2026-05-14T10:00:00Z") },
    );
    const bytes = readFileSync(res.log_path, "utf8");
    expect(bytes).toContain("preference: [[pref-foo-rule|Rule for foo-rule]]");
    expect(bytes).toContain("result: violated");
  });
});

describe("appendApplyEvidence — missing preference", () => {
  test("throws BrainPreferenceNotFoundError when the pref file is absent", () => {
    expect(() =>
      appendApplyEvidence(vault, {
        pref_id: "pref-does-not-exist",
        artifact: "[[bar]]",
        result: "applied",
        agent: "claude",
      }),
    ).toThrow(BrainPreferenceNotFoundError);
  });

  test("error names the search path", () => {
    try {
      appendApplyEvidence(vault, {
        pref_id: "missing",
        artifact: "[[x]]",
        result: "applied",
        agent: "claude",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainPreferenceNotFoundError);
      const e = err as BrainPreferenceNotFoundError;
      expect(e.prefId).toBe("pref-missing");
      expect(e.searchedPath).toContain("Brain/preferences/pref-missing.md");
    }
  });
});

describe("appendApplyEvidence — log file creation on first event", () => {
  test("first event of the day creates the log file with header", () => {
    prefFixture("first-event");
    // No log file exists yet.
    expect(existsSync(logPath(vault, "2026-05-14"))).toBe(false);

    appendApplyEvidence(
      vault,
      {
        pref_id: "first-event",
        artifact: "[[x]]",
        result: "applied",
        agent: "claude",
      },
      { now: new Date("2026-05-14T07:00:00Z") },
    );

    expect(existsSync(logPath(vault, "2026-05-14"))).toBe(true);
    const bytes = readFileSync(logPath(vault, "2026-05-14"), "utf8");
    expect(bytes).toContain("kind: brain-log");
    expect(bytes).toContain("date: 2026-05-14");
    expect(bytes).toContain("# Brain log — 2026-05-14");
    expect(bytes).toContain("## 07:00:00Z — apply-evidence");
  });

  test("invalid `result` is rejected at the input layer", () => {
    prefFixture("bad-result");
    expect(() =>
      appendApplyEvidence(vault, {
        pref_id: "bad-result",
        artifact: "[[x]]",
        result: "neutral" as unknown as "applied",
        agent: "claude",
      }),
    ).toThrow(/must be 'applied', 'violated', or 'outdated'/);
  });

  test("missing required input fields throw naming the field", () => {
    prefFixture("missing-field");
    expect(() =>
      appendApplyEvidence(vault, {
        pref_id: "",
        artifact: "[[x]]",
        result: "applied",
        agent: "claude",
      }),
    ).toThrow(/missing field: pref_id/);
    expect(() =>
      appendApplyEvidence(vault, {
        pref_id: "missing-field",
        artifact: "",
        result: "applied",
        agent: "claude",
      }),
    ).toThrow(/missing field: artifact/);
    expect(() =>
      appendApplyEvidence(vault, {
        pref_id: "missing-field",
        artifact: "[[x]]",
        result: "applied",
        agent: "",
      }),
    ).toThrow(/missing field: agent/);
  });
});

describe("appendApplyEvidence — sanitisation (§7)", () => {
  test("redacts secrets in artifact and note", () => {
    prefFixture("redact-target");
    appendApplyEvidence(
      vault,
      {
        pref_id: "redact-target",
        artifact: "[[file]] token: abcdef",
        result: "applied",
        agent: "claude",
        note: 'logged with api_key=hunter2 here',
      },
      { now: new Date("2026-05-15T10:00:00Z") },
    );
    const { entries } = parseLogDay(vault, "2026-05-15");
    const ev = entries.find((e) => e.eventType === "apply-evidence");
    expect(ev).toBeDefined();
    const artifact = String(ev!.body["artifact"] ?? "");
    expect(artifact).toContain("***REDACTED***");
    expect(artifact).not.toContain("abcdef");
    const note = String(ev!.body["note"] ?? "");
    expect(note).toContain("***REDACTED***");
    expect(note).not.toContain("hunter2");
  });

  test("strips C0 controls in artifact and caps note length", () => {
    prefFixture("cap-target");
    appendApplyEvidence(
      vault,
      {
        pref_id: "cap-target",
        artifact: "[[fi\x07le]]",
        result: "applied",
        agent: "claude",
        note: "x".repeat(8000),
      },
      { now: new Date("2026-05-15T11:00:00Z") },
    );
    const { entries } = parseLogDay(vault, "2026-05-15");
    const ev = entries.find((e) => e.eventType === "apply-evidence");
    expect(ev).toBeDefined();
    expect(String(ev!.body["artifact"])).not.toContain("\x07");
    expect(String(ev!.body["note"]).length).toBeLessThanOrEqual(4096);
  });

  test("rejects when sanitisation strips artifact down to empty", () => {
    prefFixture("empty-artifact");
    expect(() =>
      appendApplyEvidence(vault, {
        pref_id: "empty-artifact",
        artifact: "\x00\x07",
        result: "applied",
        agent: "claude",
      }),
    ).toThrow(/missing field: artifact/);
  });
});
