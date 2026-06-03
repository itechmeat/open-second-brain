/**
 * Grounded trigger queue (Workspace Insight Suite, t_cd1fee79):
 * Markdown-first trigger records in Brain/triggers/ with an anti-nag
 * lifecycle - cooldown-key dedup, status transitions, expiry, and
 * once-per-cooldown brief delivery.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  briefTriggers,
  createTriggers,
  listTriggers,
  markTriggersDelivered,
  transitionTrigger,
  TRIGGER_TTL_DAYS,
} from "../../../src/core/brain/triggers/store.ts";
import type { InsightCandidate } from "../../../src/core/brain/triggers/types.ts";

let vault: string;
const NOW = new Date("2026-06-03T10:00:00Z");
const DAY_MS = 24 * 3600 * 1000;

function candidate(overrides: Partial<InsightCandidate> = {}): InsightCandidate {
  return {
    kind: "contradiction",
    urgency: "high",
    reason: "pref-a contradicts pref-b on the same scope",
    suggestedAction: "Review both preferences and retire one",
    sourceArtifacts: ["[[pref-a]]", "[[pref-b]]"],
    contextSnippets: ["pref-a: do X", "pref-b: never do X"],
    cooldownKey: "contradiction:pref-a:pref-b",
    ...overrides,
  };
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-triggers-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("createTriggers persists Markdown records with full frontmatter", () => {
  const result = createTriggers(vault, [candidate()], { now: NOW });
  expect(result.created).toHaveLength(1);
  const record = result.created[0]!;
  expect(record.status).toBe("pending");
  expect(record.expiresAt).toBe(new Date(NOW.getTime() + TRIGGER_TTL_DAYS * DAY_MS).toISOString());
  const raw = readFileSync(record.path, "utf8");
  expect(raw).toContain("trigger_type: contradiction");
  expect(raw).toContain("urgency: high");
  expect(raw).toContain("## Reason");
  expect(raw).toContain("## Suggested action");
  expect(raw).toContain("pref-b: never do X");
  expect(readdirSync(join(vault, "Brain", "triggers"))).toHaveLength(1);
});

test("repeated scans are idempotent: an active twin blocks recreation", () => {
  createTriggers(vault, [candidate()], { now: NOW });
  const second = createTriggers(vault, [candidate()], { now: NOW });
  expect(second.created).toHaveLength(0);
  expect(second.skipped[0]!.reason).toBe("active");
  expect(listTriggers(vault, { now: NOW })).toHaveLength(1);
});

test("a dismissed trigger stays silent during cooldown, recreatable after", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  const during = createTriggers(vault, [candidate()], {
    now: new Date(NOW.getTime() + 3 * DAY_MS),
    cooldownDays: 7,
  });
  expect(during.created).toHaveLength(0);
  expect(during.skipped[0]!.reason).toBe("cooldown");

  const after = createTriggers(vault, [candidate()], {
    now: new Date(NOW.getTime() + 8 * DAY_MS),
    cooldownDays: 7,
  });
  expect(after.created).toHaveLength(1);
});

test("lifecycle transitions are enforced", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  const acked = transitionTrigger(vault, id, "acknowledge", { now: NOW });
  expect(acked.status).toBe("acknowledged");
  const acted = transitionTrigger(vault, id, "act", { now: NOW });
  expect(acted.status).toBe("acted");
  // Terminal: no further transitions.
  expect(() => transitionTrigger(vault, id, "dismiss", { now: NOW })).toThrow("terminal");
  expect(() => transitionTrigger(vault, "tr-nope", "act", { now: NOW })).toThrow("unknown");
});

test("expiry is computed on read and unblocks recreation", () => {
  createTriggers(vault, [candidate()], { now: NOW });
  const later = new Date(NOW.getTime() + (TRIGGER_TTL_DAYS + 1) * DAY_MS);
  const listed = listTriggers(vault, { now: later });
  expect(listed[0]!.effectiveStatus).toBe("expired");
  const recreate = createTriggers(vault, [candidate()], { now: later });
  expect(recreate.created).toHaveLength(1);
});

test("per-kind candidate cap bounds one scan", () => {
  const flood = Array.from({ length: 25 }, (_, i) =>
    candidate({ cooldownKey: `contradiction:pair-${i}` }),
  );
  const result = createTriggers(vault, flood, { now: NOW, maxPerKind: 10 });
  expect(result.created).toHaveLength(10);
  expect(result.skipped.filter((s) => s.reason === "kind-cap")).toHaveLength(15);
});

test("briefTriggers delivers pending once per cooldown window", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const first = briefTriggers(vault, { now: NOW, cap: 5, cooldownDays: 7 });
  expect(first.map((t) => t.id)).toEqual([created[0]!.id]);
  markTriggersDelivered(
    vault,
    first.map((t) => t.id),
    { now: NOW },
  );

  // Delivered yesterday -> silent today (anti-nag).
  const tomorrow = new Date(NOW.getTime() + 1 * DAY_MS);
  expect(briefTriggers(vault, { now: tomorrow, cap: 5, cooldownDays: 7 })).toHaveLength(0);

  // Past the cooldown window the still-open trigger resurfaces.
  const nextWeek = new Date(NOW.getTime() + 8 * DAY_MS);
  expect(briefTriggers(vault, { now: nextWeek, cap: 5, cooldownDays: 7 })).toHaveLength(1);

  // A dismissed trigger never resurfaces in the brief.
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: nextWeek });
  expect(briefTriggers(vault, { now: nextWeek, cap: 5, cooldownDays: 7 })).toHaveLength(0);
});

test("briefTriggers ranks by urgency then recency and respects the cap", () => {
  createTriggers(
    vault,
    [
      candidate({ cooldownKey: "k1", urgency: "low" }),
      candidate({ cooldownKey: "k2", urgency: "high" }),
      candidate({ cooldownKey: "k3", urgency: "medium" }),
    ],
    { now: NOW },
  );
  const listed = briefTriggers(vault, { now: NOW, cap: 2, cooldownDays: 7 });
  expect(listed).toHaveLength(2);
  expect(listed.map((t) => t.urgency)).toEqual(["high", "medium"]);
});
