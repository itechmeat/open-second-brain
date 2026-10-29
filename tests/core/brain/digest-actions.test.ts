/**
 * Coverage for the v0.10.15 ranked maintenance actions surfaced via
 * `brain_digest`. Confirms the JSON payload carries an `actions`
 * array, that the Markdown renderer emits a `## Actions` section
 * when populated, and that an empty vault stays quiet.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderDigest } from "../../../src/core/brain/digest.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../src/core/brain/types.ts";
import { GATE_MODE } from "../../../src/core/integrity/stamp.ts";

// A forwarding mock over the dedup scan (the claim-provenance precedent):
// inert unless this file's failing-scan test turns it on, so the mocks
// never answer differently for any other test file sharing the process.
import * as pageDedupModule from "../../../src/core/brain/page-dedup.ts";

const realFindDuplicateCandidates = pageDedupModule.findDuplicateCandidates;
let failDedup = false;

mock.module("../../../src/core/brain/page-dedup.ts", () => ({
  ...pageDedupModule,
  findDuplicateCandidates: (vault: string) => {
    // The raised message carries a host path, as a real refusal's does.
    if (failDedup)
      throw new Error(`the dedup scan refused: ${join(vault, "Brain", "preferences")}`);
    return realFindDuplicateCandidates(vault);
  },
}));

let vault: string;

const DERIVED_KEYS = new Set([
  "status",
  "applied_count",
  "violated_count",
  "last_evidence_at",
  "confidence",
  "confidence_value",
  "evidenced_by",
  "contradicted_by",
  "lifecycle",
  "confirmed_at",
]);

function writePref(slug: string, fields: Record<string, string>) {
  const lines = [
    "---",
    "kind: brain-preference",
    `id: pref-${slug}`,
    "tags: [brain, brain/preference]",
  ];
  for (const [k, v] of Object.entries(fields)) {
    const key = DERIVED_KEYS.has(k) ? `_${k}` : k;
    lines.push(`${key}: ${v}`);
  }
  lines.push("---", "");
  writeFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), lines.join("\n"));
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-digest-actions-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox", "processed"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("brain_digest collect_errors surface (review M10)", () => {
  test("a healthy vault renders no collect_errors row", () => {
    const res = renderDigest(vault, {
      format: "json",
      since: new Date("2026-05-24T00:00:00Z"),
      until: new Date("2026-05-25T00:00:00Z"),
    });
    const payload = JSON.parse(res.content) as { collect_errors?: unknown };
    expect(payload.collect_errors).toBeUndefined();
  });

  test("a failed scan is rendered as a named collect_errors row", () => {
    failDedup = true;
    try {
      const res = renderDigest(vault, {
        format: "json",
        since: new Date("2026-05-24T00:00:00Z"),
        until: new Date("2026-05-25T00:00:00Z"),
      });
      const payload = JSON.parse(res.content) as {
        collect_errors?: ReadonlyArray<{ scan: string; message: string }>;
      };
      expect(payload.collect_errors).toEqual([
        {
          scan: "dedup",
          message: `the dedup scan refused: ${join(vault, "Brain", "preferences")}`,
        },
      ]);
    } finally {
      failDedup = false;
    }
  });

  test("below local reach (a readable filter) the row is the closed form, never the host path", () => {
    failDedup = true;
    try {
      const res = renderDigest(vault, {
        format: "json",
        since: new Date("2026-05-24T00:00:00Z"),
        until: new Date("2026-05-25T00:00:00Z"),
        readable: () => true,
      });
      const payload = JSON.parse(res.content) as {
        collect_errors?: ReadonlyArray<{ scan: string; message: string }>;
      };
      expect(payload.collect_errors).toEqual([
        { scan: "dedup", message: "dedup scan failed (error)" },
      ]);
      expect(res.content).not.toContain(tmpdir());
    } finally {
      failDedup = false;
    }
  });
});

describe("brain_digest actions surface", () => {
  test("empty vault renders no Actions section in markdown", () => {
    const res = renderDigest(vault, {
      format: "markdown",
      since: new Date("2026-05-24T00:00:00Z"),
      until: new Date("2026-05-25T00:00:00Z"),
    });
    expect(res.content).not.toContain("## Actions");
  });

  test("empty vault still carries an empty actions array in JSON", () => {
    const res = renderDigest(vault, {
      format: "json",
      since: new Date("2026-05-24T00:00:00Z"),
      until: new Date("2026-05-25T00:00:00Z"),
    });
    const payload = JSON.parse(res.content) as { actions: unknown };
    expect(Array.isArray(payload.actions)).toBe(true);
    expect((payload.actions as Array<unknown>).length).toBe(0);
  });

  test("dedup candidates appear as a ranked action in markdown when window has activity", () => {
    // One window-active preference makes the digest non-empty so
    // the full renderer (and therefore the ## Actions section) runs.
    writePref("active", {
      topic: "writing",
      principle: "Active in window",
      status: "unconfirmed",
      created_at: "2026-05-24T12:00:00Z",
      unconfirmed_until: "2026-06-01T00:00:00Z",
    });
    // Dedup pair (out-of-window, vault-state).
    writePref("alpha", {
      topic: "writing",
      principle: "Use imperative voice",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("alpha-dup", {
      topic: "writing",
      principle: "Use imperative voice",
      created_at: "2026-02-01T00:00:00Z",
    });
    const res = renderDigest(vault, {
      format: "markdown",
      since: new Date("2026-05-24T00:00:00Z"),
      until: new Date("2026-05-25T00:00:00Z"),
    });
    expect(res.content).toContain("## Actions");
    expect(res.content).toContain("[dedup]");
    expect(res.content).toContain("pref-alpha");
  });

  test("JSON payload exposes the actions list even when the window is empty", () => {
    // No window-active items - the JSON still carries the full
    // shape, including the (vault-state) actions array. Operators
    // and downstream consumers can read it without checking the
    // emptiness flag first.
    writePref("a", {
      topic: "x",
      principle: "y",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("b", {
      topic: "x",
      principle: "y",
      created_at: "2026-02-01T00:00:00Z",
    });
    const json = renderDigest(vault, {
      format: "json",
      since: new Date("2026-05-24T00:00:00Z"),
      until: new Date("2026-05-25T00:00:00Z"),
    });
    const payload = JSON.parse(json.content) as {
      actions: Array<{ category: string; impact: number }>;
    };
    expect(payload.actions.length).toBeGreaterThanOrEqual(1);
    expect(payload.actions[0]!.category).toBe("dedup");
    expect(payload.actions[0]!.impact).toBeGreaterThan(0);
  });
});

/**
 * The actions list is collected vault-wide, so it can name a preference
 * every section beside it withholds under
 * `integrity.owner_scope_delivery: fail`. These rows pin the same
 * isolation the other digest sections already honour: another owner's
 * stale page is absent from `actions` on every format, while an action
 * whose target the caller may see still appears (no over-filtering),
 * and a scope requested without the gate changes nothing.
 */
function setGate(mode: string | null): void {
  const body = mode === null ? "" : `integrity:\n  owner_scope_delivery: ${mode}\n`;
  writeFileSync(brainConfigPath(vault), `schema_version: 1\n${body}`);
}

describe("digest actions honor the caller's agent scope", () => {
  const OURS = "our-stale-page";
  const THEIRS = "their-stale-page";
  /** Old enough to be past the stale-stable cap on any run date. */
  const OLD = "2024-01-01T00:00:00Z";

  function seedTwoOwnerStalePages(): void {
    for (const [slug, owner] of [
      [OURS, undefined],
      [THEIRS, "agent-a"],
    ] as const) {
      writePref(slug, {
        topic: slug,
        principle: `principle for ${slug}`,
        status: "unconfirmed",
        created_at: OLD,
        unconfirmed_until: "2024-06-01T00:00:00Z",
        ...(owner !== undefined ? { owner } : {}),
      });
    }
  }

  test("under fail, another owner's stale page is absent from actions and the caller's own still appear", () => {
    seedTwoOwnerStalePages();
    setGate(GATE_MODE.fail);

    const json = renderDigest(vault, {
      format: "json",
      since: new Date(OLD),
      until: new Date("2024-01-02T00:00:00Z"),
      agentScope: "agent-b",
    });
    const payload = JSON.parse(json.content) as {
      actions: Array<{ id: string; category: string; title: string; target?: string }>;
    };
    expect(payload.actions.some((a) => a.target === `pref-${THEIRS}`)).toBe(false);
    expect(json.content).not.toContain(THEIRS);
    // No over-filtering: the action whose target the caller may see is
    // still ranked, category and target intact.
    expect(
      payload.actions.some((a) => a.category === "lifecycle" && a.target === `pref-${OURS}`),
    ).toBe(true);

    // The markdown renderer draws from the same filtered rows.
    const md = renderDigest(vault, {
      format: "markdown",
      since: new Date(OLD),
      until: new Date("2024-01-02T00:00:00Z"),
      agentScope: "agent-b",
    });
    expect(md.content).toContain("## Actions");
    expect(md.content).toContain(`pref-${OURS}`);
    expect(md.content).not.toContain(THEIRS);

    // Its own owner still sees the maintenance suggestion.
    const asOwner = renderDigest(vault, {
      format: "json",
      since: new Date(OLD),
      until: new Date("2024-01-02T00:00:00Z"),
      agentScope: "agent-a",
    });
    expect(asOwner.content).toContain(THEIRS);
  });

  test("a scope requested under off or warn changes no action", () => {
    seedTwoOwnerStalePages();
    const unscoped = renderDigest(vault, {
      format: "json",
      since: new Date(OLD),
      until: new Date("2024-01-02T00:00:00Z"),
    });
    const baseline = JSON.parse(unscoped.content).actions;
    // The fixture really does rank both pages, so the comparison below
    // is not an agreement over an empty list.
    expect(baseline.some((a: { target?: string }) => a.target === `pref-${THEIRS}`)).toBe(true);
    expect(baseline.some((a: { target?: string }) => a.target === `pref-${OURS}`)).toBe(true);

    for (const mode of [GATE_MODE.off, GATE_MODE.warn]) {
      setGate(mode);
      const scoped = renderDigest(vault, {
        format: "json",
        since: new Date(OLD),
        until: new Date("2024-01-02T00:00:00Z"),
        agentScope: "agent-b",
      });
      expect(JSON.parse(scoped.content).actions).toEqual(baseline);
    }
  });
});

/**
 * The confidence-shift and contradiction rows are parsed from dream log
 * lines, so the log-level filter reads the whole line as one reference
 * and cannot resolve the preference it names; the parsed id is what
 * carries the row. Those ids resolve through the Brain id-directories,
 * so the rows are judged by the same composed view the actions are kept
 * through: under `integrity.owner_scope_delivery: fail` another owner's
 * shift or contradiction is absent with its pref id, counts and
 * description, while the caller's own rows still render, and a scope
 * requested without the gate changes nothing.
 */
describe("digest confidence shifts and contradictions honor the caller's agent scope", () => {
  const OURS = "shared";
  const THEIRS = "owned-by-a";
  const DREAM_AT = "2026-05-24T12:00:00.000Z";
  const SINCE = new Date("2026-05-24T00:00:00Z");
  const UNTIL = new Date("2026-05-25T00:00:00Z");

  function seedShifts(): void {
    writePref(OURS, {
      topic: OURS,
      principle: `principle for ${OURS}`,
      status: "confirmed",
      created_at: "2026-05-01T00:00:00Z",
      confirmed_at: "2026-05-02T00:00:00Z",
    });
    writePref(THEIRS, {
      topic: THEIRS,
      principle: `principle for ${THEIRS}`,
      status: "confirmed",
      created_at: "2026-05-01T00:00:00Z",
      confirmed_at: "2026-05-02T00:00:00Z",
      owner: "agent-a",
    });
    appendLogEvent(
      vault,
      {
        timestamp: DREAM_AT,
        eventType: BRAIN_LOG_EVENT_KIND.dream,
        body: {
          run_id: "run-shifts",
          confidence_shifts: [
            `[[pref-${THEIRS}]] high -> medium (applied: 11, violated: 0)`,
            `[[pref-${OURS}]] low -> high (applied: 3, violated: 1)`,
          ],
          contradictions: [
            `[[pref-${THEIRS}]] contradicts the logged behaviour (topic: ${OURS})`,
            `[[pref-${OURS}]] conflicts with the recorded evidence`,
          ],
        },
      },
      { deviceId: "" },
    );
  }

  interface ShiftRow {
    readonly id: string;
    readonly applied_count: number | null;
  }
  interface ContradictionRow {
    readonly id: string;
    readonly description: string;
  }

  function rows(content: string): {
    shifts: ReadonlyArray<ShiftRow>;
    contradictions: ReadonlyArray<ContradictionRow>;
  } {
    const payload = JSON.parse(content) as {
      confidence_shifts: ReadonlyArray<ShiftRow>;
      contradictions: ReadonlyArray<ContradictionRow>;
    };
    return { shifts: payload.confidence_shifts, contradictions: payload.contradictions };
  }

  test("under fail, another owner's shift and contradiction rows are absent and the caller's own render", () => {
    seedShifts();
    setGate(GATE_MODE.fail);

    const json = renderDigest(vault, {
      format: "json",
      since: SINCE,
      until: UNTIL,
      agentScope: "agent-b",
    });
    const scoped = rows(json.content);
    expect(scoped.shifts.map((r) => r.id)).toEqual([`pref-${OURS}`]);
    expect(scoped.contradictions.map((r) => r.id)).toEqual([`pref-${OURS}`]);
    // The description of a withheld contradiction is raw log prose; none
    // of it travels either.
    expect(json.content).not.toContain(THEIRS);
    expect(json.content).not.toContain("contradicts the logged behaviour");
    // No over-filtering: the caller's own rows keep their counts and text.
    expect(scoped.shifts[0]).toMatchObject({ applied_count: 3 });
    expect(scoped.contradictions[0]!.description).toContain("conflicts with the recorded evidence");

    // Its own owner still reads both rows.
    const asOwner = renderDigest(vault, {
      format: "json",
      since: SINCE,
      until: UNTIL,
      agentScope: "agent-a",
    });
    const owned = rows(asOwner.content);
    expect(owned.shifts.map((r) => r.id)).toEqual([`pref-${THEIRS}`, `pref-${OURS}`]);
    expect(owned.contradictions.map((r) => r.id)).toEqual([`pref-${THEIRS}`, `pref-${OURS}`]);
  });

  test("a scope requested under off or warn changes no shift or contradiction row", () => {
    seedShifts();
    const unscoped = rows(
      renderDigest(vault, { format: "json", since: SINCE, until: UNTIL }).content,
    );
    // The fixture really does carry both owners' rows on both lists.
    expect(unscoped.shifts.map((r) => r.id)).toEqual([`pref-${THEIRS}`, `pref-${OURS}`]);
    expect(unscoped.contradictions.map((r) => r.id)).toEqual([`pref-${THEIRS}`, `pref-${OURS}`]);

    for (const mode of [GATE_MODE.off, GATE_MODE.warn]) {
      setGate(mode);
      const scoped = rows(
        renderDigest(vault, {
          format: "json",
          since: SINCE,
          until: UNTIL,
          agentScope: "agent-b",
        }).content,
      );
      expect(scoped.shifts).toEqual(unscoped.shifts);
      expect(scoped.contradictions).toEqual(unscoped.contradictions);
    }
  });
});
