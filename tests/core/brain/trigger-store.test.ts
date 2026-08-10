/**
 * Grounded trigger queue (Workspace Insight Suite, t_cd1fee79):
 * Markdown-first trigger records in Brain/triggers/ with an anti-nag
 * lifecycle - cooldown-key dedup, status transitions, expiry, and
 * once-per-cooldown brief delivery.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import {
  briefTriggers,
  createTriggers,
  listTriggers,
  markTriggersDelivered,
  readTriggers,
  recordRecurrence,
  transitionTrigger,
  triggersDir,
  TriggerSourceArtifactsError,
  TriggerFieldError,
  TRIGGER_LOCK_STALE_MS,
  TRIGGER_TTL_DAYS,
} from "../../../src/core/brain/triggers/store.ts";
import {
  TRIGGER_OPEN_STATUSES,
  TRIGGER_STATUS,
  TRIGGER_STATUSES,
  TRIGGER_TERMINAL_STATUSES,
  type InsightCandidate,
} from "../../../src/core/brain/triggers/types.ts";

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

// ── Suppression (silence-is-not-an-answer, U5) ──────────────────────────────

test("the two status partitions exactly cover the status vocabulary", () => {
  const union = [...TRIGGER_OPEN_STATUSES, ...TRIGGER_TERMINAL_STATUSES].toSorted();
  expect(union).toEqual([...TRIGGER_STATUSES].toSorted());
  // Disjoint: a status in both partitions would make the terminal
  // rejection and the open-status expiry rule contradict each other.
  for (const status of TRIGGER_OPEN_STATUSES) {
    expect(TRIGGER_TERMINAL_STATUSES.has(status)).toBe(false);
  }
});

test("a suppressed twin blocks recreation indefinitely with the suppressed reason", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "suppress", { now: NOW });

  const aYearLater = new Date(NOW.getTime() + 365 * DAY_MS);
  const again = createTriggers(vault, [candidate()], { now: aYearLater, cooldownDays: 7 });
  expect(again.created).toHaveLength(0);
  expect(again.skipped[0]!.reason).toBe("suppressed");
  expect(listTriggers(vault, { now: aYearLater })).toHaveLength(1);
});

test("every blocked scan records one recurrence and the instant it fired", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "suppress", { now: NOW });
  expect(listTriggers(vault, { now: NOW })[0]!.occurrences).toBe(1);

  let last = NOW;
  for (const day of [1, 2, 3]) {
    last = new Date(NOW.getTime() + day * DAY_MS);
    createTriggers(vault, [candidate()], { now: last });
  }
  const record = listTriggers(vault, { now: last })[0]!;
  expect(record.occurrences).toBe(4);
  expect(record.lastSeenAt).toBe(last.toISOString());
});

test("a cooldown-blocked twin records a recurrence too, not only a suppressed one", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });
  const during = new Date(NOW.getTime() + 3 * DAY_MS);
  const blocked = createTriggers(vault, [candidate()], { now: during, cooldownDays: 7 });
  expect(blocked.skipped[0]!.reason).toBe("cooldown");
  expect(listTriggers(vault, { now: during })[0]!.occurrences).toBe(2);
});

test("a materially different cooldown key is created while the twin is suppressed", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "suppress", { now: NOW });
  const other = createTriggers(vault, [candidate({ cooldownKey: "contradiction:pref-c:pref-d" })], {
    now: NOW,
  });
  expect(other.created).toHaveLength(1);
  expect(other.created[0]!.status).toBe("pending");
});

test("dismiss then suppress then unsuppress restores the state and its cooldown", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  const dismissed = transitionTrigger(vault, id, "dismiss", { now: NOW });
  const resolvedAt = dismissed.resolvedAt;
  expect(resolvedAt).toBe(NOW.toISOString());

  const suppressed = transitionTrigger(vault, id, "suppress", {
    now: new Date(NOW.getTime() + DAY_MS),
  });
  expect(suppressed.status).toBe("suppressed");
  expect(suppressed.suppressedFrom).toBe("dismissed");
  // The resolution instant is untouched, which is what makes the restore
  // exact rather than reconstructed.
  expect(suppressed.resolvedAt).toBe(resolvedAt);

  const restored = transitionTrigger(vault, id, "unsuppress", {
    now: new Date(NOW.getTime() + 2 * DAY_MS),
  });
  expect(restored.status).toBe("dismissed");
  expect(restored.resolvedAt).toBe(resolvedAt);
  expect(restored.suppressedAt).toBeNull();
  expect(restored.suppressedFrom).toBeNull();

  // The original seven-day cooldown still measures from the original
  // resolution instant, not from the unsuppress.
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

test("suppress is legal from a terminal state and is idempotent", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  transitionTrigger(vault, id, "act", { now: NOW });
  const first = transitionTrigger(vault, id, "suppress", { now: NOW });
  expect(first.suppressedFrom).toBe("acted");
  const second = transitionTrigger(vault, id, "suppress", {
    now: new Date(NOW.getTime() + DAY_MS),
  });
  expect(second.status).toBe("suppressed");
  expect(second.suppressedAt).toBe(first.suppressedAt);
  expect(second.suppressedFrom).toBe("acted");
});

test("suppress is legal from an expired trigger and unsuppress restores the stored status", () => {
  createTriggers(vault, [candidate()], { now: NOW });
  const later = new Date(NOW.getTime() + (TRIGGER_TTL_DAYS + 1) * DAY_MS);
  const expired = listTriggers(vault, { now: later })[0]!;
  expect(expired.effectiveStatus).toBe("expired");

  const suppressed = transitionTrigger(vault, expired.id, "suppress", { now: later });
  expect(suppressed.effectiveStatus).toBe("suppressed");
  // The stored status was still pending; that is what is restored, and
  // expiry is re-applied on read exactly as before.
  expect(suppressed.suppressedFrom).toBe("pending");
  const restored = transitionTrigger(vault, expired.id, "unsuppress", { now: later });
  expect(restored.status).toBe("pending");
  expect(restored.effectiveStatus).toBe("expired");
});

test("unsuppressing something that is not suppressed throws naming its status", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  expect(() => transitionTrigger(vault, id, "unsuppress", { now: NOW })).toThrow("pending");
  transitionTrigger(vault, id, "dismiss", { now: NOW });
  expect(() => transitionTrigger(vault, id, "unsuppress", { now: NOW })).toThrow("dismissed");
});

test("unsuppressing an unknown id throws", () => {
  expect(() => transitionTrigger(vault, "tr-nope", "unsuppress", { now: NOW })).toThrow("unknown");
  expect(() => transitionTrigger(vault, "tr-nope", "suppress", { now: NOW })).toThrow("unknown");
});

test("a hand-edited suppressed record with no prior status throws naming the field", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  const path = created[0]!.path;
  transitionTrigger(vault, id, "suppress", { now: NOW });
  writeFileSync(path, readFileSync(path, "utf8").replace(/^suppressed_from: .*$\n/mu, ""), "utf8");
  expect(() => transitionTrigger(vault, id, "unsuppress", { now: NOW })).toThrow("suppressed_from");
});

test("a suppressed trigger is hidden from the brief and stays out of it forever", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "suppress", { now: NOW });
  expect(briefTriggers(vault, { now: NOW, cap: 5, cooldownDays: 7 })).toHaveLength(0);
  const aYearLater = new Date(NOW.getTime() + 365 * DAY_MS);
  expect(briefTriggers(vault, { now: aYearLater, cap: 5, cooldownDays: 7 })).toHaveLength(0);
});

test("markTriggersDelivered never revives a suppressed trigger", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  transitionTrigger(vault, id, "suppress", { now: NOW });
  markTriggersDelivered(vault, [id], { now: NOW });
  expect(listTriggers(vault, { now: NOW })[0]!.status).toBe("suppressed");
});

test("suppression state round-trips through the Markdown file", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const suppressed = transitionTrigger(vault, created[0]!.id, "suppress", { now: NOW });
  const raw = readFileSync(suppressed.path, "utf8");
  expect(raw).toContain(`status: ${TRIGGER_STATUS.suppressed}`);
  expect(raw).toContain(`suppressed_at: ${NOW.toISOString()}`);
  expect(raw).toContain("suppressed_from: pending");
  expect(raw).toContain("occurrences: 1");
  expect(raw).toContain(`last_seen_at: ${NOW.toISOString()}`);
});

test("a record written before this change reads as one recorded occurrence", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  writeFileSync(
    path,
    readFileSync(path, "utf8")
      .replace(/^occurrences: .*$\n/mu, "")
      .replace(/^last_seen_at: .*$\n/mu, ""),
    "utf8",
  );
  const record = listTriggers(vault, { now: NOW })[0]!;
  expect(record.occurrences).toBe(1);
  expect(record.lastSeenAt).toBe(record.createdAt);
});

test("recordRecurrence increments the ledger and persists it", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const later = new Date(NOW.getTime() + DAY_MS);
  const next = recordRecurrence(created[0]!, later);
  expect(next.occurrences).toBe(2);
  expect(next.lastSeenAt).toBe(later.toISOString());
  expect(listTriggers(vault, { now: later })[0]!.occurrences).toBe(2);
});

// ── Defect: a malformed grounding list must not read as an ungrounded one ───

test("an unparseable source-artifact list refuses instead of reading as empty", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^source_artifacts: .*$/mu, 'source_artifacts: "[[pref-a"'),
    "utf8",
  );
  expect(() => listTriggers(vault, { now: NOW })).toThrow(TriggerSourceArtifactsError);
  expect(() => listTriggers(vault, { now: NOW })).toThrow("source_artifacts");
});

test("a record naming no grounding artifacts still reads as an empty list", () => {
  const result = createTriggers(vault, [candidate({ sourceArtifacts: [] })], { now: NOW });
  expect(result.created[0]!.sourceArtifacts).toEqual([]);
  expect(listTriggers(vault, { now: NOW })[0]!.sourceArtifacts).toEqual([]);
});

// ── Defect: a corrupt recurrence field must not read as a pre-ledger record ──
//
// Absent recurrence keys mean the record predates the ledger, and reading
// them as "one occurrence, last seen when it was created" is the true count
// of what anybody recorded. A key that is PRESENT and unreadable is a
// different claim: silently crediting it the same one occurrence would state
// a number nothing supports, and would understate a finding that has fired
// forty times. Absent and corrupt are told apart.

test("an unreadable occurrence count refuses instead of reading as a fresh record", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^occurrences: .*$/mu, "occurrences: many"),
    "utf8",
  );
  expect(() => listTriggers(vault, { now: NOW })).toThrow(TriggerFieldError);
  expect(() => listTriggers(vault, { now: NOW })).toThrow("occurrences");
});

test("a negative or zero occurrence count refuses", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^occurrences: .*$/mu, "occurrences: 0"),
    "utf8",
  );
  expect(() => listTriggers(vault, { now: NOW })).toThrow("occurrences");
});

test("an unreadable last-seen instant refuses instead of reading as the creation instant", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^last_seen_at: .*$/mu, "last_seen_at: whenever"),
    "utf8",
  );
  expect(() => listTriggers(vault, { now: NOW })).toThrow(TriggerFieldError);
  expect(() => listTriggers(vault, { now: NOW })).toThrow("last_seen_at");
});

// ── Defect: one corrupt record must not take the whole queue down ────────────
//
// The field refusals above are right, but they used to leave `listTriggers` -
// which every surface reads through - and so one hand-edited file made
// `list`, `history`, the brief, delivery, creation AND every transition fail
// together. The operator could not even dismiss or suppress a healthy record
// to get out of it. A refusal now names the record it belongs to and stops
// there, and the surfaces report the naming instead of omitting the record.

const SECOND_KEY = "contradiction:pref-c:pref-d";

/** Overwrite one frontmatter line of a stored trigger. */
function rewriteLine(path: string, line: RegExp, replacement: string): void {
  writeFileSync(path, readFileSync(path, "utf8").replace(line, replacement), "utf8");
}

/** A two-record vault in which only the SECOND record is unreadable. */
function vaultWithOneCorruptSibling(): { healthyId: string; brokenPath: string } {
  const { created } = createTriggers(vault, [candidate(), candidate({ cooldownKey: SECOND_KEY })], {
    now: NOW,
  });
  expect(created).toHaveLength(2);
  const brokenPath = created[1]!.path;
  rewriteLine(brokenPath, /^occurrences: .*$/mu, "occurrences: many");
  return { healthyId: created[0]!.id, brokenPath };
}

test("a corrupt record is named and reported next to its readable siblings", () => {
  const { healthyId, brokenPath } = vaultWithOneCorruptSibling();
  const scan = readTriggers(vault, { now: NOW });
  expect(scan.records.map((r) => r.id)).toEqual([healthyId]);
  expect(scan.unreadable).toHaveLength(1);
  expect(scan.unreadable[0]!.path).toBe(brokenPath);
  expect(scan.unreadable[0]!.key).toBe("occurrences");
  expect(scan.unreadable[0]!.error.message).toContain(brokenPath);
});

test("a corrupt record leaves its healthy sibling transitionable", () => {
  const { healthyId } = vaultWithOneCorruptSibling();
  const suppressed = transitionTrigger(vault, healthyId, "suppress", { now: NOW });
  expect(suppressed.status).toBe("suppressed");
});

test("a corrupt record neither hides the brief nor blocks its delivery", () => {
  const { healthyId } = vaultWithOneCorruptSibling();
  expect(briefTriggers(vault, { now: NOW, cap: 5, cooldownDays: 7 }).map((t) => t.id)).toEqual([
    healthyId,
  ]);
  markTriggersDelivered(vault, [healthyId], { now: NOW });
  const delivered = readTriggers(vault, { now: NOW }).records.find((r) => r.id === healthyId)!;
  expect(delivered.status).toBe("delivered");
});

test("a corrupt record does not stop a scan from recording new findings", () => {
  const { brokenPath } = vaultWithOneCorruptSibling();
  const result = createTriggers(
    vault,
    [candidate({ cooldownKey: "contradiction:pref-e:pref-f" })],
    {
      now: NOW,
    },
  );
  expect(result.created).toHaveLength(1);
  expect(result.unreadable.map((u) => u.path)).toEqual([brokenPath]);
});

test("an unknown id names the records that could not be read", () => {
  vaultWithOneCorruptSibling();
  // The id may well belong to the record nobody could parse, so "unknown"
  // on its own would be a claim the store cannot support.
  expect(() => transitionTrigger(vault, "tr-nope", "dismiss", { now: NOW })).toThrow("occurrences");
});

test("the strict reader still refuses a partial view of the queue", () => {
  vaultWithOneCorruptSibling();
  expect(() => listTriggers(vault, { now: NOW })).toThrow(TriggerFieldError);
});

// ── Defect: a missing creation instant must be refused where it originates ──

test("a record with no creation instant is refused rather than corrupted", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  rewriteLine(path, /^created_at: .*$\n/mu, "");

  const first = readTriggers(vault, { now: NOW });
  expect(first.records).toHaveLength(0);
  expect(first.unreadable.map((u) => u.key)).toEqual(["created_at"]);

  // The old reading substituted "" and wrote it straight back as an empty
  // `last_seen_at` on the first recurrence; the next read refused THAT
  // field, so the record blamed a line the operator never touched.
  createTriggers(vault, [candidate()], { now: new Date(NOW.getTime() + DAY_MS) });
  expect(readTriggers(vault, { now: NOW }).unreadable.map((u) => u.key)).toEqual(["created_at"]);
  expect(readFileSync(path, "utf8")).toContain(`last_seen_at: ${NOW.toISOString()}`);
});

// ── Defect: the ledger must count exactly what the documentation claims ─────

test("a candidate the per-kind cap drops records a recurrence on its own record", () => {
  createTriggers(vault, [candidate()], { now: NOW });
  const later = new Date(NOW.getTime() + (TRIGGER_TTL_DAYS + 1) * DAY_MS);
  // The twin has expired, so nothing blocks recreation: the cap is what
  // silenced this candidate, and the finding did fire again.
  const result = createTriggers(
    vault,
    [candidate({ cooldownKey: "contradiction:fresh" }), candidate()],
    { now: later, maxPerKind: 1 },
  );
  expect(result.created).toHaveLength(1);
  expect(result.skipped.map((s) => s.reason)).toEqual(["kind-cap"]);
  const record = readTriggers(vault, { now: later }).records.find(
    (r) => r.cooldownKey === candidate().cooldownKey,
  )!;
  expect(record.occurrences).toBe(2);
  expect(record.lastSeenAt).toBe(later.toISOString());
});

test("one scan seeing the same finding twice is one occurrence, not two", () => {
  createTriggers(vault, [candidate()], { now: NOW });
  const later = new Date(NOW.getTime() + DAY_MS);
  const blocked = createTriggers(vault, [candidate(), candidate()], { now: later });
  expect(blocked.created).toHaveLength(0);
  expect(blocked.skipped.map((s) => s.reason)).toEqual(["active", "duplicate"]);
  expect(readTriggers(vault, { now: later }).records[0]!.occurrences).toBe(2);
});

test("the transition and delivery writers serialize on the trigger-directory lock", () => {
  // The counter used to be race-free against scans only: both of these
  // write the full record - occurrences included - from a snapshot read
  // earlier, so a scan interleaving with a suppress lost one of the two.
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  const release = lockfile.lockSync(triggersDir(vault), {
    stale: TRIGGER_LOCK_STALE_MS,
    realpath: false,
  });
  try {
    expect(() => transitionTrigger(vault, id, "dismiss", { now: NOW })).toThrow();
    expect(() => markTriggersDelivered(vault, [id], { now: NOW })).toThrow();
  } finally {
    release();
  }
  expect(readTriggers(vault, { now: NOW }).records[0]!.status).toBe("pending");
});

test("a recorded occurrence count survives a read whatever the frontmatter yields", () => {
  // Guards the number-versus-string trap: the count is written as a bare
  // integer, so a parser that materializes it as a number must not fall
  // through to the pre-ledger reading and quietly discard a real count.
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^occurrences: .*$/mu, "occurrences: 7"),
    "utf8",
  );
  expect(listTriggers(vault, { now: NOW })[0]!.occurrences).toBe(7);
});
