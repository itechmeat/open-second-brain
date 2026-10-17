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
  TRIGGER_SNOOZE_DAYS,
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

test("a dismissed trigger stays silent while its source artifacts are unchanged, however long", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  const during = createTriggers(vault, [candidate()], {
    now: new Date(NOW.getTime() + 3 * DAY_MS),
    cooldownDays: 7,
  });
  expect(during.created).toHaveLength(0);
  expect(during.skipped[0]!.reason).toBe("dismissed");

  // Past the old cooldown window the twin is STILL skipped, not
  // recreated: movement, not the clock, is what resurrects a dismissed
  // finding.
  const after = createTriggers(vault, [candidate()], {
    now: new Date(NOW.getTime() + 8 * DAY_MS),
    cooldownDays: 7,
  });
  expect(after.created).toHaveLength(0);
  expect(after.skipped[0]!.reason).toBe("dismissed");
});

test("a dismissed trigger is recreated when the finding re-fires on changed source artifacts", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // Same cooldown key, changed grounding: the finding moved, so the
  // dismissal no longer covers it and a NEW pending record arrives
  // through the normal creation path.
  const moved = createTriggers(
    vault,
    [candidate({ sourceArtifacts: ["[[pref-a]]", "[[pref-c]]"] })],
    { now: new Date(NOW.getTime() + DAY_MS) },
  );
  expect(moved.created).toHaveLength(1);
  expect(moved.created[0]!.id).not.toBe(created[0]!.id);
  expect(moved.created[0]!.status).toBe("pending");
  expect(moved.created[0]!.sourceArtifacts).toEqual(["[[pref-a]]", "[[pref-c]]"]);
});

test("the dismissed movement comparison is order-insensitive and duplicate-insensitive", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // Same set in a different order, with a duplicate: not movement.
  const reordered = createTriggers(
    vault,
    [candidate({ sourceArtifacts: ["[[pref-b]]", "[[pref-a]]", "[[pref-b]]"] })],
    { now: new Date(NOW.getTime() + DAY_MS) },
  );
  expect(reordered.created).toHaveLength(0);
  expect(reordered.skipped[0]!.reason).toBe("dismissed");
});

test("a dismissed record with no persisted artifacts is never read as moved", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });
  // Hand-strip the persisted grounding, as a record written before the
  // key existed would read: absence is the neutral reading, never a
  // claim that the finding moved.
  rewriteLine(path, /^source_artifacts: .*$\n/mu, "");

  const later = createTriggers(vault, [candidate()], {
    now: new Date(NOW.getTime() + 8 * DAY_MS),
    cooldownDays: 7,
  });
  expect(later.created).toHaveLength(0);
  expect(later.skipped[0]!.reason).toBe("dismissed");
});

test("a dismissed trigger stays dismissed when a re-fire grounds a subset of its artifacts", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // A remote `brain_trigger scan` re-firing a SUBSET of the persisted
  // grounding introduces nothing the dismissal did not already cover, so
  // it is not movement and must not resurrect the finding.
  const subset = createTriggers(vault, [candidate({ sourceArtifacts: ["[[pref-a]]"] })], {
    now: new Date(NOW.getTime() + DAY_MS),
  });
  expect(subset.created).toHaveLength(0);
  expect(subset.skipped[0]!.reason).toBe("dismissed");

  // Still not movement past the old cooldown window: the dismissal has
  // no clock, and the subset adds nothing new at any age.
  const later = createTriggers(vault, [candidate({ sourceArtifacts: ["[[pref-a]]"] })], {
    now: new Date(NOW.getTime() + 8 * DAY_MS),
    cooldownDays: 7,
  });
  expect(later.created).toHaveLength(0);
  expect(later.skipped[0]!.reason).toBe("dismissed");
});

test("a dismissed trigger is recreated when a re-fire introduces an artifact the dismissal never covered", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // The superset direction: everything persisted is named again, but the
  // candidate also grounds the finding in something new - the finding
  // moved, so a NEW pending record arrives.
  const widened = createTriggers(
    vault,
    [candidate({ sourceArtifacts: ["[[pref-a]]", "[[pref-b]]", "[[pref-c]]"] })],
    { now: new Date(NOW.getTime() + DAY_MS) },
  );
  expect(widened.created).toHaveLength(1);
  expect(widened.created[0]!.id).not.toBe(created[0]!.id);
  expect(widened.created[0]!.sourceArtifacts).toEqual(["[[pref-a]]", "[[pref-b]]", "[[pref-c]]"]);
});

// ── Dismissed movement for the kinds whose key pins their artifacts ─────────
//
// For stale_claim, contradiction, retention_action and the idea kinds the
// cooldown key is derived from the same artifact ids the movement gate
// compares (`stale_claim:<id>` grounds itself in `[[<id>]]` alone), so the
// artifact set can never change for a given twin and the gate above can
// never see movement: dismissing one of these findings was permanent. The
// gate therefore also reads a grounding fingerprint - a content hash of
// the finding's reason and context, persisted at dismissal time - so
// changed grounding resurrects the finding while a re-sight of untouched
// grounding stays silent.
//
// The candidates below are the REAL adapter shapes (adapters.ts), not
// synthetic ones: their reasons embed the clock (day counts, ages,
// scores), so a fingerprint of the raw text would read the clock's own
// movement as the finding's movement and resurrect an untouched finding
// at the first day boundary - the nag the movement gate replaced. The
// fingerprint normalizes clock projections away; the tests pin both
// directions of that choice.

/** The exact stale-claim shape candidatesFromHealth emits. */
function staleClaimCandidate(
  id: string,
  ageDays: number,
  lastEvidenceAt: string,
): InsightCandidate {
  return {
    kind: "stale_claim",
    urgency: "medium",
    reason: `${id} has had no fresh evidence for ${ageDays} days (last: ${lastEvidenceAt})`,
    suggestedAction: "Re-evidence the preference or let the dream pass retire it",
    sourceArtifacts: [`[[${id}]]`],
    contextSnippets: [`last_evidence_at: ${lastEvidenceAt}`],
    cooldownKey: `stale_claim:${id}`,
  };
}

/** The exact contradiction shape candidatesFromHealth emits. */
function healthContradictionCandidate(
  a: string,
  aSign: string,
  b: string,
  bSign: string,
  scope: string,
  jaccard: string,
): InsightCandidate {
  return {
    kind: "contradiction",
    urgency: "high",
    reason: `${a} (${aSign}) contradicts ${b} (${bSign}) in scope '${scope}' (principle similarity ${jaccard})`,
    suggestedAction: "Review the pair and retire, merge, or rescope one of the rules",
    sourceArtifacts: [`[[${a}]]`, `[[${b}]]`],
    contextSnippets: [`signs: ${a}=${aSign}, ${b}=${bSign}`],
    cooldownKey: `contradiction:${[a, b].toSorted().join(":")}`,
  };
}

/** The exact retention_action shape candidatesFromRetention emits. */
function retentionCandidate(
  id: string,
  action: "park" | "prune",
  grounds: string,
  path: string,
): InsightCandidate {
  return {
    kind: "retention_action",
    urgency: action === "prune" ? "medium" : "low",
    reason: `retention recommends '${action}' for ${id}: ${grounds}`,
    suggestedAction:
      action === "prune"
        ? "Prune the artifact (it no longer earns its keep)"
        : "Park the artifact out of the active set",
    sourceArtifacts: [`[[${id}]]`],
    contextSnippets: [`path: ${path}`],
    cooldownKey: `retention_action:${id}:${action}`,
  };
}

/** The exact idea_direction shape ideaCandidates emits for an inbox signal. */
function inboxIdeaCandidate(
  topic: string,
  name: string,
  ageDays: number,
  score: string,
): InsightCandidate {
  return {
    kind: "idea_direction",
    urgency: "low",
    reason: `inbox signal '${topic}' has waited ${ageDays}d without becoming a preference`,
    suggestedAction: "Pick this up as a next direction or archive it deliberately",
    sourceArtifacts: [`Brain/inbox/${name}`],
    contextSnippets: [`score: ${score}`],
    cooldownKey: `idea_direction:Brain/inbox/${name}`,
  };
}

test("a dismissed stale_claim is recreated when the preference is re-evidenced and goes stale again", () => {
  const { created } = createTriggers(vault, [staleClaimCandidate("pref-x", 30, "2026-05-04")], {
    now: NOW,
  });
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // The reviewer's scenario: same artifact, same cooldown key, rescan a
  // year later. The preference WAS re-evidenced in between (a fresh
  // evidence date landed in the note) and has gone stale again - the
  // grounding changed, so the dismissal no longer covers it and a new
  // pending record arrives.
  const rescan = createTriggers(vault, [staleClaimCandidate("pref-x", 45, "2027-03-01")], {
    now: new Date("2027-04-15T10:00:00Z"),
  });
  expect(rescan.created).toHaveLength(1);
  expect(rescan.created[0]!.cooldownKey).toBe("stale_claim:pref-x");
  expect(rescan.created[0]!.status).toBe("pending");
});

test("a dismissed stale_claim stays silent when only the clock moved", () => {
  const { created } = createTriggers(vault, [staleClaimCandidate("pref-x", 30, "2026-05-04")], {
    now: NOW,
  });
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // A year later the SAME candidate re-fires except for the day count,
  // which the clock grew. Untouched grounding: the dismissal still
  // covers it, however long. A fingerprint of the raw reason text would
  // read the day count as movement and resurrect the finding here.
  const rescan = createTriggers(vault, [staleClaimCandidate("pref-x", 330, "2026-05-04")], {
    now: new Date("2027-04-15T10:00:00Z"),
  });
  expect(rescan.created).toHaveLength(0);
  expect(rescan.skipped[0]!.reason).toBe("dismissed");
});

test("a dismissed contradiction is recreated when the pair is edited and still conflicts", () => {
  const { created } = createTriggers(
    vault,
    [healthContradictionCandidate("pref-a", "positive", "pref-b", "negative", "testing", "0.81")],
    { now: NOW },
  );
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // Both notes were rewritten; they still conflict, with a flipped sign,
  // a moved scope and a different overlap. Same pair, same key, changed
  // grounding: the operator hears about it again.
  const rescan = createTriggers(
    vault,
    [
      healthContradictionCandidate(
        "pref-a",
        "negative",
        "pref-b",
        "negative",
        "code-review",
        "0.63",
      ),
    ],
    { now: new Date(NOW.getTime() + DAY_MS) },
  );
  expect(rescan.created).toHaveLength(1);
  expect(rescan.created[0]!.cooldownKey).toBe("contradiction:pref-a:pref-b");
});

test("a dismissed retention_action is recreated when the recommendation's grounds change", () => {
  const { created } = createTriggers(
    vault,
    [
      retentionCandidate(
        "sig-keep",
        "prune",
        "old processed one-off signal has no source pointers; safe candidate for manual pruning",
        "Brain/signals/sig-keep.md",
      ),
    ],
    { now: NOW },
  );
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // The artifact's content changed, so the review's grounds changed with
  // it, while the id, action and path - and with them the key and the
  // artifact set - did not. Changed grounding: recreated.
  const rescan = createTriggers(
    vault,
    [
      retentionCandidate(
        "sig-keep",
        "prune",
        "the signal now duplicates pref-x without adding evidence",
        "Brain/signals/sig-keep.md",
      ),
    ],
    { now: new Date(NOW.getTime() + DAY_MS) },
  );
  expect(rescan.created).toHaveLength(1);
  expect(rescan.created[0]!.cooldownKey).toBe("retention_action:sig-keep:prune");
});

test("a dismissed idea_direction is recreated when the signal's topic changes", () => {
  const { created } = createTriggers(
    vault,
    [inboxIdeaCandidate("draft-memory-ttl", "sig-memory.md", 20, "0.121")],
    { now: NOW },
  );
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // The signal's frontmatter grew a new topic; the file, and with it the
  // key and the artifact set, did not change. Changed grounding:
  // recreated.
  const rescan = createTriggers(
    vault,
    [inboxIdeaCandidate("memory-ttl-policy", "sig-memory.md", 40, "0.141")],
    { now: new Date(NOW.getTime() + DAY_MS) },
  );
  expect(rescan.created).toHaveLength(1);
  expect(rescan.created[0]!.cooldownKey).toBe("idea_direction:Brain/inbox/sig-memory.md");
});

test("a dismissed idea_direction stays silent when only its age and score drifted", () => {
  const { created } = createTriggers(
    vault,
    [inboxIdeaCandidate("draft-memory-ttl", "sig-memory.md", 20, "0.121")],
    { now: NOW },
  );
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // The idea detector's score carries an age bonus and its reason an age
  // count, so an untouched signal re-fires every scan with different
  // numbers. The clock's drift is not movement: the dismissal holds.
  const rescan = createTriggers(
    vault,
    [inboxIdeaCandidate("draft-memory-ttl", "sig-memory.md", 300, "0.365")],
    { now: new Date(NOW.getTime() + 280 * DAY_MS) },
  );
  expect(rescan.created).toHaveLength(0);
  expect(rescan.skipped[0]!.reason).toBe("dismissed");
});

test("a dismissed record written before fingerprints existed is never resurrected by the fingerprint arm", () => {
  const { created } = createTriggers(vault, [staleClaimCandidate("pref-x", 30, "2026-05-04")], {
    now: NOW,
  });
  const path = created[0]!.path;
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });
  // Hand-strip the persisted fingerprint, as a record dismissed by an
  // older build would read: absence is the neutral reading - the
  // fingerprint arm cannot claim movement it has no baseline for, the
  // artifact arm sees none, and the finding stays dismissed.
  rewriteLine(path, /^dismissed_fingerprint: .*$\n/mu, "");

  const rescan = createTriggers(vault, [staleClaimCandidate("pref-x", 45, "2027-03-01")], {
    now: new Date("2027-04-15T10:00:00Z"),
  });
  expect(rescan.created).toHaveLength(0);
  expect(rescan.skipped[0]!.reason).toBe("dismissed");
});

test("the dismissal fingerprint round-trips through the record and refuses an unreadable value", () => {
  const { created } = createTriggers(vault, [staleClaimCandidate("pref-x", 30, "2026-05-04")], {
    now: NOW,
  });
  const path = created[0]!.path;
  const dismissed = transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });
  expect(dismissed.dismissedFingerprint).not.toBeNull();
  expect(readTriggers(vault, { now: NOW }).records[0]!.dismissedFingerprint).toBe(
    dismissed.dismissedFingerprint,
  );
  expect(readFileSync(path, "utf8")).toContain("dismissed_fingerprint: ");

  // A present value that cannot be read as the hash it claims to be
  // refuses, naming the field - it never silently reads as absence,
  // which would retire the record's own dismissal coverage. The refusal
  // is confined to the record that carries it.
  rewriteLine(path, /^dismissed_fingerprint: .*$/mu, "dismissed_fingerprint: [not, a, hash]");
  const scan = readTriggers(vault, { now: NOW });
  expect(scan.records).toHaveLength(0);
  expect(scan.unreadable).toHaveLength(1);
  expect(scan.unreadable[0]!.key).toBe("dismissed_fingerprint");
  expect(scan.unreadable[0]!.path).toBe(path);
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

// ── Snooze plumbing (t_00e9de6a) ─────────────────────────────────────────────

/**
 * Rewrite a stored record's frontmatter into a hand-written snoozed one,
 * exactly the bytes an operator or an older build could have left.
 */
function handSnooze(path: string, at: string, until: string, from = "pending"): void {
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      /^status: .*$/mu,
      `status: snoozed\nsnoozed_at: ${at}\nsnoozed_until: ${until}\nsnoozed_from: ${from}`,
    ),
    "utf8",
  );
}

test("snoozed joins the terminal partition, not the open one", () => {
  // Terminal, so the TTL expiry clock never governs the snooze wake: the
  // snooze window is the wake clock, and the partition membership - not a
  // branch - is what hides a snoozed record from `list` and shows it in
  // `history`.
  expect(TRIGGER_TERMINAL_STATUSES.has(TRIGGER_STATUS.snoozed)).toBe(true);
  expect(TRIGGER_OPEN_STATUSES.has(TRIGGER_STATUS.snoozed)).toBe(false);
});

test("a snoozed record round-trips through the Markdown file with snoozed_at/snoozed_until/snoozed_from", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  const until = new Date(NOW.getTime() + 3 * DAY_MS).toISOString();
  handSnooze(path, NOW.toISOString(), until);

  const record = listTriggers(vault, { now: NOW })[0]!;
  expect(record.status).toBe("snoozed");
  expect(record.snoozedAt).toBe(NOW.toISOString());
  expect(record.snoozedUntil).toBe(until);
  expect(record.snoozedFrom).toBe("pending");

  // The recurrence write renders the WHOLE record, so the snooze state
  // has to survive a ledger stamp verbatim.
  const next = recordRecurrence(record, new Date(NOW.getTime() + DAY_MS));
  const raw = readFileSync(next.path, "utf8");
  expect(raw).toContain("status: snoozed");
  expect(raw).toContain(`snoozed_at: ${NOW.toISOString()}`);
  expect(raw).toContain(`snoozed_until: ${until}`);
  expect(raw).toContain("snoozed_from: pending");
});

test("a snoozed record without snooze fields reads with a null snooze state", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  rewriteLine(created[0]!.path, /^status: .*$/mu, "status: snoozed");
  const record = listTriggers(vault, { now: NOW })[0]!;
  expect(record.status).toBe("snoozed");
  expect(record.snoozedAt).toBeNull();
  expect(record.snoozedUntil).toBeNull();
  expect(record.snoozedFrom).toBeNull();
});

test("an unreadable snoozed_at refuses instead of silently defaulting", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  handSnooze(path, NOW.toISOString(), new Date(NOW.getTime() + 3 * DAY_MS).toISOString());
  rewriteLine(path, /^snoozed_at: .*$/mu, "snoozed_at: whenever");
  expect(() => listTriggers(vault, { now: NOW })).toThrow(TriggerFieldError);
  expect(() => listTriggers(vault, { now: NOW })).toThrow("snoozed_at");
});

test("an unreadable snoozed_until refuses instead of silently defaulting", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  handSnooze(path, NOW.toISOString(), new Date(NOW.getTime() + 3 * DAY_MS).toISOString());
  rewriteLine(path, /^snoozed_until: .*$/mu, "snoozed_until: whenever");
  expect(() => listTriggers(vault, { now: NOW })).toThrow(TriggerFieldError);
  expect(() => listTriggers(vault, { now: NOW })).toThrow("snoozed_until");
});

test("an unreadable snoozed_from refuses instead of silently defaulting", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  handSnooze(path, NOW.toISOString(), new Date(NOW.getTime() + 3 * DAY_MS).toISOString());
  rewriteLine(path, /^snoozed_from: .*$/mu, "snoozed_from: forgot");
  expect(() => listTriggers(vault, { now: NOW })).toThrow(TriggerFieldError);
  expect(() => listTriggers(vault, { now: NOW })).toThrow("snoozed_from");
});

// ── Defect: a restore-from field naming its own status class is a zombie ─────
//
// `snoozed_from: snoozed` and `suppressed_from: suppressed` describe a
// restore that restores into itself: the wake arm reads the record back to
// its own status forever, so it hides from `list` behind the terminal
// partition and refuses every transition - undismissable, unwakeable,
// silent. The write site can never produce one (a snooze seeds its restore
// from the computed status), but the parser admitted one, so a hand-edited
// or pre-upgrade record became a permanent zombie with nothing anywhere
// saying so. The read boundary now refuses, naming the field and the fix.

test("a snoozed_from reading snoozed refuses at the read boundary instead of zombifying", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  handSnooze(
    path,
    NOW.toISOString(),
    new Date(NOW.getTime() + 3 * DAY_MS).toISOString(),
    "snoozed",
  );

  const scan = readTriggers(vault, { now: NOW });
  expect(scan.records).toHaveLength(0);
  expect(scan.unreadable).toHaveLength(1);
  expect(scan.unreadable[0]!.key).toBe("snoozed_from");
  expect(scan.unreadable[0]!.path).toBe(path);
  // The refusal tells the operator to fix the field - never to dismiss,
  // which a snoozed record refuses (terminal) and a record this broken
  // could not reach anyway.
  expect(scan.unreadable[0]!.error.message).not.toMatch(/\bdismiss\b/i);
  expect(() => listTriggers(vault, { now: NOW })).toThrow(TriggerFieldError);
  expect(() => listTriggers(vault, { now: NOW })).toThrow("snoozed_from");
});

test("a suppressed_from reading suppressed refuses at the read boundary instead of zombifying", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  transitionTrigger(vault, created[0]!.id, "suppress", { now: NOW });
  rewriteLine(path, /^suppressed_from: .*$/mu, "suppressed_from: suppressed");

  const scan = readTriggers(vault, { now: NOW });
  expect(scan.records).toHaveLength(0);
  expect(scan.unreadable).toHaveLength(1);
  expect(scan.unreadable[0]!.key).toBe("suppressed_from");
  expect(scan.unreadable[0]!.error.message).not.toMatch(/\bdismiss\b/i);
  expect(() => listTriggers(vault, { now: NOW })).toThrow(TriggerFieldError);
  expect(() => listTriggers(vault, { now: NOW })).toThrow("suppressed_from");
});

test("a record zombied before the fix names the field to fix instead of vanishing", () => {
  // A record written before the parser refused: the operator must be able
  // to find it through the surfaces they have, and the naming must point at
  // the hand fix.
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  handSnooze(
    path,
    NOW.toISOString(),
    new Date(NOW.getTime() + 3 * DAY_MS).toISOString(),
    "snoozed",
  );
  expect(() => transitionTrigger(vault, created[0]!.id, "unsnooze", { now: NOW })).toThrow(
    "snoozed_from",
  );
  expect(() => transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW })).toThrow(
    "snoozed_from",
  );
  // The unreadable record stays confined to itself: its sibling is still
  // readable and operable.
  const { created: fresh } = createTriggers(
    vault,
    [candidate({ cooldownKey: "contradiction:pref-c:pref-d" })],
    { now: NOW },
  );
  expect(readTriggers(vault, { now: NOW }).records.map((r) => r.id)).toEqual([fresh[0]!.id]);
});

test("a restore-from field naming the OTHER silence class still reads and restores verbatim", () => {
  // Only the self-referential values are zombies. A snooze over a
  // suppression (and a suppression over a snooze) is a real lifecycle
  // position: `snoozed_from: suppressed` restores into suppressed, which is
  // exactly what the verbatim-restore contract promises.
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  transitionTrigger(vault, created[0]!.id, "snooze", { now: NOW });
  rewriteLine(path, /^snoozed_from: .*$/mu, "snoozed_from: suppressed");
  const record = listTriggers(vault, { now: NOW })[0]!;
  expect(record.snoozedFrom).toBe("suppressed");
  // The wake restores suppressed, the terminal status the snooze
  // interrupted - not a zombie, an honest lifecycle position.
  const woken = listTriggers(vault, { now: new Date(NOW.getTime() + 4 * DAY_MS) })[0]!;
  expect(woken.effectiveStatus).toBe("suppressed");
});

// ── Snooze transition and wake (t_00e9de6a) ─────────────────────────────────

test("snooze defers a trigger for a bounded window, then the original resurfaces with its ledger intact", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const snoozed = transitionTrigger(vault, created[0]!.id, "snooze", { now: NOW });
  expect(snoozed.status).toBe("snoozed");
  expect(snoozed.snoozedAt).toBe(NOW.toISOString());
  expect(snoozed.snoozedUntil).toBe(new Date(NOW.getTime() + 3 * DAY_MS).toISOString());
  expect(snoozed.snoozedFrom).toBe("pending");
  // A pause, not a resolution: the deferral writes no resolution instant.
  expect(snoozed.resolvedAt).toBeNull();

  // A scan during the window is blocked by the snooze and records the
  // recurrence - the ledger keeps the re-sighting auditable.
  const during = new Date(NOW.getTime() + DAY_MS);
  const blocked = createTriggers(vault, [candidate()], { now: during });
  expect(blocked.created).toHaveLength(0);
  expect(blocked.skipped[0]!.reason).toBe("snoozed");

  // After the window the ORIGINAL resurfaces, ledger intact - not a
  // fresh record.
  const after = new Date(NOW.getTime() + 4 * DAY_MS);
  const resurfaced = listTriggers(vault, { now: after })[0]!;
  expect(resurfaced.id).toBe(created[0]!.id);
  expect(resurfaced.effectiveStatus).toBe("pending");
  expect(resurfaced.occurrences).toBe(2);
  expect(resurfaced.lastSeenAt).toBe(during.toISOString());

  // And a scan after the wake meets an open twin, not a duplicate.
  const laterScan = createTriggers(vault, [candidate()], { now: after });
  expect(laterScan.created).toHaveLength(0);
  expect(laterScan.skipped[0]!.reason).toBe("active");
});

test("re-snoozing a clock-woken trigger restores the computed status, never snoozed", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  transitionTrigger(vault, id, "snooze", { now: NOW });

  // The window elapses: the stored status still reads snoozed, but the
  // wake arm computes the open status the snooze interrupted.
  const woken = new Date(NOW.getTime() + 4 * DAY_MS);
  expect(listTriggers(vault, { now: woken })[0]!.effectiveStatus).toBe("pending");

  // Re-snooze the woken trigger. The deferral must seed its restore from
  // the COMPUTED status - a snooze can never restore INTO snoozed, or
  // the next wake restores snoozed and the bounded deferral becomes an
  // indefinite silent kill.
  const resnoozed = transitionTrigger(vault, id, "snooze", { now: woken });
  expect(resnoozed.snoozedFrom).toBe("pending");

  // Past the SECOND window the record must surface again, and stay in
  // the operator's hands: listable as open, dismissable.
  const afterSecond = new Date(woken.getTime() + 4 * DAY_MS);
  const resurfaced = listTriggers(vault, { now: afterSecond })[0]!;
  expect(resurfaced.id).toBe(id);
  expect(resurfaced.effectiveStatus).toBe("pending");
  expect(
    briefTriggers(vault, { now: afterSecond, cap: 5, cooldownDays: 7 }).map((t) => t.id),
  ).toEqual([id]);
  const dismissed = transitionTrigger(vault, id, "dismiss", { now: afterSecond });
  expect(dismissed.status).toBe("dismissed");
});

test("a snoozed trigger stays snoozed when a scan re-sights the finding unchanged", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "snooze", { now: NOW });

  // Five minutes later a scan re-sights the SAME finding: the detectors
  // report state, so any rescan fires a still-true condition and agents
  // can scan at will. A bare re-sighting is not a refire - the snooze
  // must hold, and the record must stay out of `list` and the brief.
  const rescan = new Date(NOW.getTime() + 5 * 60 * 1000);
  const blocked = createTriggers(vault, [candidate()], { now: rescan });
  expect(blocked.created).toHaveLength(0);
  expect(blocked.skipped[0]!.reason).toBe("snoozed");

  const still = readTriggers(vault, { now: rescan }).records[0]!;
  expect(still.id).toBe(created[0]!.id);
  expect(still.effectiveStatus).toBe("snoozed");
  // Terminal, so the brief - the surfacing lane - still hides it.
  expect(briefTriggers(vault, { now: rescan, cap: 5, cooldownDays: 7 })).toHaveLength(0);
  // The re-sighting is still on the ledger: occurrences keep counting.
  expect(still.occurrences).toBe(2);
  expect(still.lastSeenAt).toBe(rescan.toISOString());
});

test("a snoozed trigger wakes early, in place, when a re-fire introduces an artifact it never saw", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "snooze", { now: NOW });

  // The re-fire grounds the finding in an artifact the snoozed record
  // never saw: movement. The record wakes IN PLACE - the exact status
  // the snooze interrupted is restored, the snooze state is cleared -
  // and the waking scan meets an open twin, not a duplicate.
  const rescan = new Date(NOW.getTime() + DAY_MS);
  const moved = createTriggers(
    vault,
    [candidate({ sourceArtifacts: ["[[pref-a]]", "[[pref-c]]"] })],
    { now: rescan },
  );
  expect(moved.created).toHaveLength(0);
  expect(moved.skipped[0]!.reason).toBe("active");

  const woken = readTriggers(vault, { now: rescan }).records[0]!;
  expect(woken.id).toBe(created[0]!.id);
  expect(woken.status).toBe("pending");
  expect(woken.effectiveStatus).toBe("pending");
  expect(woken.snoozedAt).toBeNull();
  expect(woken.snoozedUntil).toBeNull();
  expect(woken.snoozedFrom).toBeNull();
  expect(woken.snoozedFingerprint).toBeNull();
  expect(woken.occurrences).toBe(2);
  expect(woken.lastSeenAt).toBe(rescan.toISOString());
  expect(listTriggers(vault, { now: rescan }).map((t) => t.id)).toEqual([created[0]!.id]);
});

test("a snoozed trigger wakes early when the re-firing finding's grounding content changed", () => {
  const { created } = createTriggers(vault, [staleClaimCandidate("pref-x", 30, "2026-05-04")], {
    now: NOW,
  });
  transitionTrigger(vault, created[0]!.id, "snooze", { now: NOW });

  // Same artifact, same key, re-evidenced content: the fingerprint the
  // snooze persisted no longer matches, and the window has not ended -
  // movement wakes the snooze early anyway.
  const rescan = new Date(NOW.getTime() + DAY_MS);
  const moved = createTriggers(vault, [staleClaimCandidate("pref-x", 3, "2026-05-31")], {
    now: rescan,
  });
  expect(moved.created).toHaveLength(0);
  expect(moved.skipped[0]!.reason).toBe("active");
  const woken = readTriggers(vault, { now: rescan }).records[0]!;
  expect(woken.id).toBe(created[0]!.id);
  expect(woken.effectiveStatus).toBe("pending");
});

test("a hand-written snoozed record without a fingerprint wakes on artifact movement, never on a bare re-sighting", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  handSnooze(path, NOW.toISOString(), new Date(NOW.getTime() + 3 * DAY_MS).toISOString());

  // A record snoozed by an older build carries no grounding fingerprint:
  // the fingerprint arm has no baseline and stays silent, so a bare
  // re-sighting holds the snooze exactly as for a fresh one.
  const rescan = new Date(NOW.getTime() + DAY_MS);
  const bare = createTriggers(vault, [candidate()], { now: rescan });
  expect(bare.created).toHaveLength(0);
  expect(bare.skipped[0]!.reason).toBe("snoozed");
  expect(readTriggers(vault, { now: rescan }).records[0]!.effectiveStatus).toBe("snoozed");

  // The artifact arm never needed the fingerprint: an introduced artifact
  // is movement, and wakes the record.
  const movedAt = new Date(rescan.getTime() + DAY_MS);
  const moved = createTriggers(
    vault,
    [candidate({ sourceArtifacts: ["[[pref-a]]", "[[pref-c]]"] })],
    {
      now: movedAt,
    },
  );
  expect(moved.created).toHaveLength(0);
  expect(moved.skipped[0]!.reason).toBe("active");
  expect(readTriggers(vault, { now: movedAt }).records[0]!.effectiveStatus).toBe("pending");
});

test("the snooze persists its grounding fingerprint and unsnooze clears it", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const path = created[0]!.path;
  const snoozed = transitionTrigger(vault, created[0]!.id, "snooze", { now: NOW });
  expect(snoozed.snoozedFingerprint).not.toBeNull();
  expect(readFileSync(path, "utf8")).toContain("snoozed_fingerprint: ");
  expect(readTriggers(vault, { now: NOW }).records[0]!.snoozedFingerprint).toBe(
    snoozed.snoozedFingerprint,
  );

  const woken = transitionTrigger(vault, created[0]!.id, "unsnooze", {
    now: new Date(NOW.getTime() + DAY_MS),
  });
  expect(woken.snoozedFingerprint).toBeNull();
  expect(readFileSync(path, "utf8")).not.toContain("snoozed_fingerprint: ");
});

test("snooze without an explicit window uses the bounded default", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const snoozed = transitionTrigger(vault, created[0]!.id, "snooze", { now: NOW });
  expect(snoozed.snoozedUntil).toBe(
    new Date(NOW.getTime() + TRIGGER_SNOOZE_DAYS * DAY_MS).toISOString(),
  );
});

test("snooze is refused on a terminal trigger and names its state", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "act", { now: NOW });
  expect(() => transitionTrigger(vault, created[0]!.id, "snooze", { now: NOW })).toThrow(
    "terminal (acted)",
  );

  // Snoozed is itself terminal: re-snoozing is refused naming snoozed,
  // not silently treated as idempotent.
  const { created: fresh } = createTriggers(
    vault,
    [candidate({ cooldownKey: "contradiction:pref-c:pref-d" })],
    { now: NOW },
  );
  transitionTrigger(vault, fresh[0]!.id, "snooze", { now: NOW });
  expect(() => transitionTrigger(vault, fresh[0]!.id, "snooze", { now: NOW })).toThrow(
    "terminal (snoozed)",
  );
});

test("unsnooze restores the interrupted status before the window ends", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  transitionTrigger(vault, id, "acknowledge", { now: NOW });
  transitionTrigger(vault, id, "snooze", { now: NOW });
  const woken = transitionTrigger(vault, id, "unsnooze", {
    now: new Date(NOW.getTime() + DAY_MS),
  });
  expect(woken.status).toBe("acknowledged");
  expect(woken.effectiveStatus).toBe("acknowledged");
  expect(woken.snoozedAt).toBeNull();
  expect(woken.snoozedUntil).toBeNull();
  expect(woken.snoozedFrom).toBeNull();
});

test("unsnoozing a trigger that is not snoozed throws naming its status", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  expect(() => transitionTrigger(vault, id, "unsnooze", { now: NOW })).toThrow("pending");
  transitionTrigger(vault, id, "dismiss", { now: NOW });
  expect(() => transitionTrigger(vault, id, "unsnooze", { now: NOW })).toThrow("dismissed");
});

test("unsnoozing a hand-edited snoozed record with no prior status throws naming the field", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  const path = created[0]!.path;
  transitionTrigger(vault, id, "snooze", { now: NOW });
  rewriteLine(path, /^snoozed_from: .*$/mu, "");
  let message = "";
  try {
    transitionTrigger(vault, id, "unsnooze", { now: NOW });
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("snoozed_from");
  // The remedy must be reachable: `dismiss` is refused on a snoozed
  // record (terminal), so advertising it strands the operator. The way
  // out of a hand-edited Markdown record is the hand fix it names.
  expect(message).not.toMatch(/\bdismiss\b/i);
  expect(message).toContain("by hand");
});

test("suppressing a snoozed trigger and unsuppressing restores the snooze with its window still armed", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  const id = created[0]!.id;
  transitionTrigger(vault, id, "snooze", { now: NOW });
  transitionTrigger(vault, id, "suppress", { now: NOW });
  const restored = transitionTrigger(vault, id, "unsuppress", {
    now: new Date(NOW.getTime() + DAY_MS),
  });
  expect(restored.status).toBe("snoozed");
  expect(restored.effectiveStatus).toBe("snoozed");
  expect(restored.snoozedUntil).toBe(
    new Date(NOW.getTime() + TRIGGER_SNOOZE_DAYS * DAY_MS).toISOString(),
  );
});

test("a snoozed trigger is hidden from the brief until its window ends", () => {
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "snooze", { now: NOW });
  const during = new Date(NOW.getTime() + DAY_MS);
  expect(briefTriggers(vault, { now: during, cap: 5, cooldownDays: 7 })).toHaveLength(0);
  const after = new Date(NOW.getTime() + 4 * DAY_MS);
  expect(briefTriggers(vault, { now: after, cap: 5, cooldownDays: 7 }).map((t) => t.id)).toEqual([
    created[0]!.id,
  ]);
});

test("an acted trigger keeps the plain cooldown window and records its recurrences", () => {
  // Movement gating is scoped to DISMISSED findings; acting on a
  // trigger resolves the work, so the time window it always had stays.
  const { created } = createTriggers(vault, [candidate()], { now: NOW });
  transitionTrigger(vault, created[0]!.id, "act", { now: NOW });
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

// ── Defect: a batch key built from the observed endpoints shifts with reach ──
//
// The batch_inflation key names the burst's observed endpoints, so a
// reach-narrowed scan - which sees a subset of the burst's records -
// derives a different key for the SAME finding and resurrects a
// suppressed or dismissed twin. The persisted record, not the observed
// endpoint list, is the identity a sighting must resolve to.

const BURST_IDS = ["pref-a", "pref-b", "pref-c", "pref-d", "pref-e", "pref-f"];

function burstCandidate(cooldownKey: string, ids: ReadonlyArray<string>): InsightCandidate {
  return candidate({
    kind: "batch_inflation",
    urgency: "low",
    reason: `${ids.length} preferences confirmed together`,
    suggestedAction: "Review the batch for near-duplicates",
    cooldownKey,
    sourceArtifacts: ids.map((id) => `[[${id}]]`),
  });
}

test("a reach-narrowed sighting of a batch resolves to the persisted twin, not a shifted key", () => {
  const { created } = createTriggers(
    vault,
    [burstCandidate("batch_inflation:pref-a:pref-f", BURST_IDS)],
    {
      now: NOW,
    },
  );
  expect(created).toHaveLength(1);
  transitionTrigger(vault, created[0]!.id, "suppress", { now: NOW });

  // The narrowed scan observes a subset: the burst endpoints shift and
  // with them the key it derives. The sighting grounds itself in records
  // the twin already covers, so it must resolve to the twin's own key -
  // reach-stable - and stay silenced by it.
  const later = new Date(NOW.getTime() + DAY_MS);
  const narrowed = createTriggers(
    vault,
    [burstCandidate("batch_inflation:pref-b:pref-f", BURST_IDS.slice(1))],
    { now: later },
  );
  expect(narrowed.created).toHaveLength(0);
  expect(narrowed.skipped[0]!.reason).toBe("suppressed");
  expect(narrowed.skipped[0]!.cooldownKey).toBe("batch_inflation:pref-a:pref-f");
  // One cooldown entry: the suppressed twin, its ledger crediting the
  // narrowed sighting.
  const records = readTriggers(vault, { now: later }).records;
  expect(records).toHaveLength(1);
  expect(records[0]!.occurrences).toBe(2);
});

test("a reach-narrowed sighting of a dismissed batch stays dismissed like any subset re-fire", () => {
  const { created } = createTriggers(
    vault,
    [burstCandidate("batch_inflation:pref-a:pref-f", BURST_IDS)],
    {
      now: NOW,
    },
  );
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  const narrowed = createTriggers(
    vault,
    [burstCandidate("batch_inflation:pref-b:pref-f", BURST_IDS.slice(1))],
    { now: new Date(NOW.getTime() + DAY_MS) },
  );
  expect(narrowed.created).toHaveLength(0);
  expect(narrowed.skipped[0]!.reason).toBe("dismissed");
});

test("a batch sighting introducing a record the twin never saw is movement, not a narrowed sighting", () => {
  const { created } = createTriggers(
    vault,
    [burstCandidate("batch_inflation:pref-a:pref-f", BURST_IDS)],
    {
      now: NOW,
    },
  );
  transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });

  // A superset grounds the finding in something the persisted record
  // never saw: the movement gate must keep working across the shift.
  const widened = createTriggers(
    vault,
    [burstCandidate("batch_inflation:pref-a:pref-g", [...BURST_IDS, "pref-g"])],
    { now: new Date(NOW.getTime() + DAY_MS) },
  );
  expect(widened.created).toHaveLength(1);
  expect(widened.created[0]!.status).toBe("pending");
});

test("a batch twin with no persisted grounding is never read as covering a sighting", () => {
  const { created } = createTriggers(
    vault,
    [burstCandidate("batch_inflation:pref-a:pref-f", BURST_IDS)],
    {
      now: NOW,
    },
  );
  transitionTrigger(vault, created[0]!.id, "suppress", { now: NOW });
  // Hand-strip the persisted grounding, as a record written before the
  // key existed would read: absence is the neutral reading, and coverage
  // of nothing is nothing.
  rewriteLine(created[0]!.path, /^source_artifacts: .*$\n/mu, "");

  const narrowed = createTriggers(
    vault,
    [burstCandidate("batch_inflation:pref-b:pref-f", BURST_IDS.slice(1))],
    { now: new Date(NOW.getTime() + DAY_MS) },
  );
  expect(narrowed.created).toHaveLength(1);
});

test("dismiss then suppress then unsuppress restores the state and its resolution instant", () => {
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

  // The restore preserves the resolution instant, and the dismissed twin
  // blocks on its unchanged grounding at any age - the suppression
  // detour restarts neither.
  const during = createTriggers(vault, [candidate()], {
    now: new Date(NOW.getTime() + 3 * DAY_MS),
    cooldownDays: 7,
  });
  expect(during.created).toHaveLength(0);
  expect(during.skipped[0]!.reason).toBe("dismissed");
  const after = createTriggers(vault, [candidate()], {
    now: new Date(NOW.getTime() + 8 * DAY_MS),
    cooldownDays: 7,
  });
  expect(after.created).toHaveLength(0);
  expect(after.skipped[0]!.reason).toBe("dismissed");
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
  let message = "";
  try {
    transitionTrigger(vault, id, "unsuppress", { now: NOW });
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("suppressed_from");
  // Same reachable-remedy rule as the unsnooze refusal: dismiss is
  // refused on a suppressed record (terminal), so the refusal must point
  // at the hand fix instead.
  expect(message).not.toMatch(/\bdismiss\b/i);
  expect(message).toContain("by hand");
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
