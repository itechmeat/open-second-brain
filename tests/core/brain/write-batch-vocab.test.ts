/**
 * Kernel 2 vocabulary extension (W2, t_7718ab22): apply_evidence and
 * append_log_line operations, plus the mixed all-or-nothing contract
 * across the full operation vocabulary. Each new op maps to an existing
 * core writer (appendApplyEvidence / appendBrainNote); the kernel does
 * not reimplement them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { applyWriteBatch, WriteBatchError } from "../../../src/core/brain/write-batch.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-write-batch-vocab-"));
  bootstrapBrain(vault);
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function writePref(slug: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "tags: [brain, brain/preference]",
      `topic: ${slug}`,
      "_status: confirmed",
      "principle: always test first",
      "created_at: 2026-01-01T00:00:00Z",
      "unconfirmed_until: 2026-01-15T00:00:00Z",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("applyWriteBatch apply_evidence and append_log_line", () => {
  test("apply_evidence appends an evidence event to today's log", () => {
    writePref("test-first");
    const res = applyWriteBatch(vault, [
      {
        kind: "apply_evidence",
        input: {
          pref_id: "test-first",
          artifact: "[[src/x.ts]]",
          result: "applied",
          agent: "claude",
        },
      },
    ]);
    expect(res.applied).toBe(1);
    const only = res.results[0]!;
    expect(only.kind).toBe("apply_evidence");
    expect("logged_at" in only && typeof only.logged_at === "string").toBe(true);
  });

  test("apply_evidence with a missing preference aborts with a typed error", () => {
    try {
      applyWriteBatch(vault, [
        {
          kind: "apply_evidence",
          input: {
            pref_id: "does-not-exist",
            artifact: "[[x]]",
            result: "applied",
            agent: "claude",
          },
        },
      ]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("preference_not_found");
    }
  });

  test("apply_evidence with an invalid result enum aborts before writing", () => {
    writePref("test-first");
    expect(() =>
      applyWriteBatch(vault, [
        {
          kind: "apply_evidence",
          input: {
            pref_id: "test-first",
            artifact: "[[x]]",
            // deliberately invalid
            result: "maybe" as never,
            agent: "claude",
          },
        },
      ]),
    ).toThrow(WriteBatchError);
  });

  test("append_log_line writes a note event to today's log", () => {
    const res = applyWriteBatch(vault, [
      { kind: "append_log_line", input: { text: "shipped v1.35.0", agent: "claude" } },
    ]);
    expect(res.applied).toBe(1);
    expect(res.results[0]!.kind).toBe("append_log_line");
  });

  test("append_log_line with empty text aborts with a typed error", () => {
    try {
      applyWriteBatch(vault, [{ kind: "append_log_line", input: { text: "   " } }]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("invalid_operation");
    }
  });
});

describe("applyWriteBatch mixed all-or-nothing", () => {
  test("a mixed batch commits every operation", () => {
    writePref("test-first");
    const res = applyWriteBatch(vault, [
      { kind: "create_note", path: "Notes/A.md", content: "a" },
      { kind: "append_log_line", input: { text: "did a thing", agent: "claude" } },
      {
        kind: "apply_evidence",
        input: {
          pref_id: "test-first",
          artifact: "[[Notes/A.md]]",
          result: "applied",
          agent: "claude",
        },
      },
    ]);
    expect(res.applied).toBe(3);
    expect(existsSync(join(vault, "Notes/A.md"))).toBe(true);
  });

  test("a later invalid op aborts the whole batch: earlier note op does not land", () => {
    expect(() =>
      applyWriteBatch(vault, [
        // op 0: valid create.
        { kind: "create_note", path: "Notes/First.md", content: "one" },
        // op 1: invalid apply_evidence (missing preference). Must abort
        // before any commit.
        {
          kind: "apply_evidence",
          input: { pref_id: "ghost", artifact: "[[x]]", result: "applied", agent: "claude" },
        },
      ]),
    ).toThrow(WriteBatchError);
    // Op 0's note must NOT have been created because op 1 failed validation.
    expect(existsSync(join(vault, "Notes/First.md"))).toBe(false);
  });
});
