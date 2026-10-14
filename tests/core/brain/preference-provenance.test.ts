/**
 * Pure origin-join core for standing-instruction provenance (recall lane).
 *
 * `preference-provenance.ts` is a read-time join: it parses a signal's
 * `session_ref` into origin coordinates and resolves a preference's
 * `evidenced_by` wikilinks to those coordinates through an injected
 * lookup. Three producers write `session_ref` today, each with its own
 * shape:
 *
 *   - import-session: `<portable basename>#<turn id>` — the ref is
 *     composed at src/core/brain/sessions/import.ts:445 from the key
 *     `sessionRefIdentity` returns (the session file's basename, never
 *     a machine-local path);
 *   - capture lifecycle: `session:<id>#<event>` — composed by
 *     `sessionReference` at src/core/brain/session-lifecycle.ts:858;
 *     the fragment is a hook event NAME (UserPromptSubmit, Stop,
 *     SessionEnd), not an event id, so it resolves as SESSION-level
 *     provenance (kind `session`) and is labeled as such;
 *   - auto-extract: a bare session reference with no fragment —
 *     src/core/brain/extract-signals.ts:646 stores the caller's
 *     session id verbatim, so no turn is available.
 *
 * The never-guess rule under every case below: a ref whose shape no
 * producer emits yields NO provenance, never a best-effort reading.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  parseSessionRef,
  resolvePreferenceProvenance,
} from "../../../src/core/brain/preference-provenance.ts";
// The live writer half of the import-session ref: the portable session
// key is exactly what `sessionRefIdentity` returns.
import { sessionRefIdentity } from "../../../src/core/brain/sessions/import.ts";

describe("parseSessionRef: producer shapes", () => {
  test("an import-session ref splits into portable basename and turn id", () => {
    // Live writer shape: `${sessionKey}#${input.turnId}` where the key
    // is `sessionRefIdentity`'s portable basename.
    const key = sessionRefIdentity("/host/only/path/sessions/claude-2026-06-01.jsonl");
    expect(key).toBe("claude-2026-06-01.jsonl");
    const origin = parseSessionRef(`${key}#turn-user-1`);
    expect(origin).toEqual({
      sessionKey: "claude-2026-06-01.jsonl",
      fragment: "turn-user-1",
      kind: "turn",
    });
  });

  test("a capture-lifecycle ref resolves as session-level provenance, labeled as such", () => {
    // Live writer shape: `session:${payload.sessionId}#${payload.event}`.
    // The fragment is the hook event's NAME, not an event id, so every
    // prompt-sourced signal in a session shares the one coordinate: the
    // kind says session, never a turn claim.
    const origin = parseSessionRef("session:00000000-0000-0000-0000-000000000001#UserPromptSubmit");
    expect(origin).toEqual({
      sessionKey: "session:00000000-0000-0000-0000-000000000001",
      fragment: "UserPromptSubmit",
      kind: "session",
    });
  });

  test("the degenerate unknown-session capture ref keeps its verbatim key", () => {
    // session-lifecycle stamps `unknown` when the host payload carries
    // no session id; the shape is still a lifecycle ref.
    const origin = parseSessionRef("session:unknown#SessionEnd");
    expect(origin).toEqual({
      sessionKey: "session:unknown",
      fragment: "SessionEnd",
      kind: "session",
    });
  });

  test("a session-prefixed key that is neither lifecycle form yields no provenance", () => {
    // Import keys are verbatim basenames: a session file named with the
    // lifecycle scheme collides with it, and the ref alone cannot tell
    // the two apart. The join refuses the label instead of guessing one -
    // no provenance, never a wrong kind.
    expect(parseSessionRef("session:my-session.jsonl#turn-user-1")).toBeNull();
    expect(parseSessionRef("session:conv-01#UserPromptSubmit")).toBeNull();
  });

  test("an auto-extract ref carries no fragment and yields no provenance", () => {
    // Live writer shape: the bare caller session id, no `#`.
    expect(parseSessionRef("session:conv-01")).toBeNull();
  });

  test("any ref without a fragment yields no provenance", () => {
    expect(parseSessionRef("claude-minimal.jsonl")).toBeNull();
  });
});

describe("parseSessionRef: malformed shapes are refused, never guessed", () => {
  test("missing and blank refs yield no provenance", () => {
    expect(parseSessionRef("")).toBeNull();
    expect(parseSessionRef("   ")).toBeNull();
  });

  test("an empty key or an empty fragment yields no provenance", () => {
    expect(parseSessionRef("#turn-1")).toBeNull();
    expect(parseSessionRef("claude-minimal.jsonl#")).toBeNull();
    expect(parseSessionRef("session:#UserPromptSubmit")).toBeNull();
  });

  test("a second hash — a shape no producer emits — yields no provenance", () => {
    expect(parseSessionRef("claude-minimal.jsonl#turn-1#extra")).toBeNull();
    expect(parseSessionRef("session:conv-01#UserPromptSubmit#x")).toBeNull();
  });
});

describe("resolvePreferenceProvenance", () => {
  const LOOKUP: Record<string, string | undefined> = {
    "sig-2026-05-16-mocking": "claude-minimal.jsonl#turn-user-1",
    "sig-2026-05-17-lifecycle": "session:00000000-0000-0000-0000-000000000002#UserPromptSubmit",
    "sig-2026-05-18-bare": "session:conv-02",
    "sig-2026-05-19-dup": "claude-minimal.jsonl#turn-user-1",
  };
  const lookup = (signalId: string): string | undefined => LOOKUP[signalId];

  test("resolves both producer kinds in evidence order, earliest cited first", () => {
    const provenance = resolvePreferenceProvenance(
      {
        id: "pref-db-mocking",
        evidenced_by: ["[[sig-2026-05-16-mocking]]", "[[sig-2026-05-17-lifecycle]]"],
      },
      lookup,
    );
    expect(provenance).not.toBeNull();
    expect(provenance?.key).toBe("pref:pref-db-mocking");
    expect(provenance?.preferenceId).toBe("pref-db-mocking");
    expect(provenance?.origins).toEqual([
      { sessionKey: "claude-minimal.jsonl", fragment: "turn-user-1", kind: "turn" },
      {
        sessionKey: "session:00000000-0000-0000-0000-000000000002",
        fragment: "UserPromptSubmit",
        kind: "session",
      },
    ]);
    // The earliest cited origin leads: the preference's evidence order,
    // never re-sorted, and never a chronological claim.
    expect(provenance?.origins[0]).toEqual({
      sessionKey: "claude-minimal.jsonl",
      fragment: "turn-user-1",
      kind: "turn",
    });
  });

  test("evidence whose signal is unknown is skipped without leaving a hole", () => {
    const provenance = resolvePreferenceProvenance(
      {
        id: "pref-partial",
        evidenced_by: ["[[sig-missing]]", "[[sig-2026-05-16-mocking]]"],
      },
      lookup,
    );
    expect(provenance?.origins).toEqual([
      { sessionKey: "claude-minimal.jsonl", fragment: "turn-user-1", kind: "turn" },
    ]);
  });

  test("an existing signal without a session_ref contributes no origin", () => {
    const provenance = resolvePreferenceProvenance(
      { id: "pref-noref", evidenced_by: ["[[sig-no-session-ref]]"] },
      () => undefined,
    );
    expect(provenance).toBeNull();
  });

  test("evidence entries that are not exact wikilinks are never guessed at", () => {
    const provenance = resolvePreferenceProvenance(
      {
        id: "pref-loose",
        evidenced_by: [
          "sig-2026-05-16-mocking", // bare id, no brackets
          "see [[sig-2026-05-16-mocking]] in context", // embedded in prose
          "", // empty entry
          "[[sig-2026-05-16-mocking|alias]]", // alias form: not what writers emit
          "[[sig-2026-05-16-mocking]]", // the one exact form
        ],
      },
      lookup,
    );
    expect(provenance?.origins).toEqual([
      { sessionKey: "claude-minimal.jsonl", fragment: "turn-user-1", kind: "turn" },
    ]);
  });

  test("duplicate origins dedupe to their first position", () => {
    const provenance = resolvePreferenceProvenance(
      {
        id: "pref-dup",
        evidenced_by: [
          "[[sig-2026-05-16-mocking]]",
          "[[sig-2026-05-17-lifecycle]]",
          "[[sig-2026-05-19-dup]]", // resolves to the same ref as the first
        ],
      },
      lookup,
    );
    expect(provenance?.origins).toEqual([
      { sessionKey: "claude-minimal.jsonl", fragment: "turn-user-1", kind: "turn" },
      {
        sessionKey: "session:00000000-0000-0000-0000-000000000002",
        fragment: "UserPromptSubmit",
        kind: "session",
      },
    ]);
  });

  test("ordering follows the preference's own evidence order, never a re-sort", () => {
    const provenance = resolvePreferenceProvenance(
      {
        id: "pref-order",
        evidenced_by: ["[[sig-late-z]]", "[[sig-early-a]]"],
      },
      (signalId) => (signalId === "sig-late-z" ? "zeta.jsonl#t9" : "alpha.jsonl#t1"),
    );
    expect(provenance?.origins).toEqual([
      { sessionKey: "zeta.jsonl", fragment: "t9", kind: "turn" },
      { sessionKey: "alpha.jsonl", fragment: "t1", kind: "turn" },
    ]);
  });

  test("a ref a producer cannot emit yields no provenance even through the lookup", () => {
    const provenance = resolvePreferenceProvenance(
      { id: "pref-weird", evidenced_by: ["[[sig-weird-ref]]"] },
      () => "not-even-wrong#k#v",
    );
    expect(provenance).toBeNull();
  });

  test("nothing resolves to null, not to an empty-hints value", () => {
    expect(
      resolvePreferenceProvenance({ id: "pref-none", evidenced_by: ["[[sig-missing]]"] }, lookup),
    ).toBeNull();
    expect(resolvePreferenceProvenance({ id: "pref-empty", evidenced_by: [] }, lookup)).toBeNull();
  });

  test("the join is deterministic across repeated calls", () => {
    const input = {
      id: "pref-det",
      evidenced_by: ["[[sig-2026-05-17-lifecycle]]", "[[sig-2026-05-16-mocking]]"],
    };
    const first = resolvePreferenceProvenance(input, lookup);
    const second = resolvePreferenceProvenance(input, lookup);
    expect(first).toEqual(second);
    expect(first?.origins[0]?.fragment).toBe("UserPromptSubmit");
  });
});

describe("purity pin", () => {
  test("the module is an import-free leaf: no fs, no path, no vault APIs", () => {
    const source = readFileSync(
      new URL("../../../src/core/brain/preference-provenance.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/^[ \t]*import\b/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toContain("node:fs");
    expect(source).not.toContain("node:path");
    expect(source).not.toContain("vault");
  });
});
