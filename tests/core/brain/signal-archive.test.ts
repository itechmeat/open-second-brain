/**
 * Inbox archive policy (issue #195).
 *
 * A signal in `Brain/inbox/` whose `created_at` lies outside
 * `dream.contradiction_window_days` can never contribute to a candidate
 * again: every counting path in the dream pass filters through
 * `filterWithinWindow`, and time only moves forward. The pass moves such
 * signals into `Brain/inbox/archived/` instead of leaving them in the inbox
 * for ever. These tests pin the rule's boundaries, the run's idempotency and
 * dry-run preview, and - the property the issue insists on - that archiving
 * changes no promotion outcome for signals still inside the window.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath, brainDirs, logPath } from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW_1 = new Date("2026-06-30T12:00:00Z");
const NOW_2 = new Date("2026-07-03T12:00:00Z");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-signal-archive-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function newVault(name: string, opts: { archive?: boolean } = {}): string {
  const vault = join(tmp, name);
  const configPath = join(tmp, `${name}.yaml`);
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  const path = brainConfigPath(vault);
  let yaml = readFileSync(path, "utf8").replace(
    /^ {2}candidate_threshold: \d+$/m,
    "  candidate_threshold: 2",
  );
  if (opts.archive === false) {
    yaml = yaml.replace(
      /^ {2}contradiction_window_days: 14$/m,
      "  contradiction_window_days: 14\n  archive_stale_signals: false",
    );
  }
  atomicWriteFileSync(path, yaml);
  return vault;
}

function sig(
  vault: string,
  topic: string,
  sign: "positive" | "negative",
  createdAt: string,
  extra: { slug?: string; expiration_date?: string } = {},
): string {
  return writeSignal(vault, {
    topic,
    signal: sign,
    agent: "claude",
    principle: `Principle for ${topic}`,
    created_at: createdAt,
    date: createdAt.slice(0, 10),
    slug: extra.slug ?? topic,
    ...(extra.expiration_date ? { expiration_date: extra.expiration_date } : {}),
  }).id;
}

function confirmedPref(vault: string, slug: string, evidencedBy: ReadonlyArray<string>): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `Rule of record for ${slug}.`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-15T00:00:00Z",
    confirmed_at: "2026-05-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: evidencedBy.map((id) => `[[${id}]]`),
    applied_count: 2,
    violated_count: 0,
    last_evidence_at: "2026-06-25T00:00:00Z",
    confidence: "medium",
  });
}

function names(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .toSorted();
}

function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names(dir)) out[n] = readFileSync(join(dir, n), "utf8");
  return out;
}

/** The fixture every test starts from; returns the ids by role. */
function seed(vault: string) {
  const ids = {
    insideSingleton: sig(vault, "inside-singleton", "positive", "2026-06-25T10:00:00Z"),
    outsideSingleton: sig(vault, "outside-singleton", "positive", "2026-06-01T10:00:00Z"),
    // The window's lower bound is inclusive: exactly `now - 14d` still counts.
    edgeIn: sig(vault, "edge-in", "positive", "2026-06-16T12:00:00Z"),
    edgeOut: sig(vault, "edge-out", "positive", "2026-06-16T11:59:59Z"),
    promotedA: sig(vault, "promoted-topic", "positive", "2026-06-20T10:00:00Z", {
      slug: "promoted-topic-a",
    }),
    promotedB: sig(vault, "promoted-topic", "positive", "2026-06-22T10:00:00Z", {
      slug: "promoted-topic-b",
    }),
    promotedStale: sig(vault, "promoted-topic", "positive", "2026-05-20T10:00:00Z", {
      slug: "promoted-topic-stale",
    }),
    redundantIn: sig(vault, "redundant-topic", "positive", "2026-06-26T10:00:00Z"),
    redundantOut: sig(vault, "redundant-topic", "positive", "2026-05-26T10:00:00Z", {
      slug: "redundant-topic-old",
    }),
    // A preference whose only evidence link resolves to an old inbox signal:
    // the pass derives the rule's sign from it, archived or not.
    signEvidence: sig(vault, "sign-topic", "negative", "2026-05-10T10:00:00Z"),
    // A preference with no evidence links: the pass falls back to the
    // topic's other signals for its sign. Three old positives made it a
    // negative rule while they sat in the inbox; archived, they must still.
    fallbackOld1: sig(vault, "fallback-topic", "positive", "2026-05-02T10:00:00Z", {
      slug: "fallback-topic-1",
    }),
    fallbackOld2: sig(vault, "fallback-topic", "positive", "2026-05-03T10:00:00Z", {
      slug: "fallback-topic-2",
    }),
    fallbackOld3: sig(vault, "fallback-topic", "positive", "2026-05-04T10:00:00Z", {
      slug: "fallback-topic-3",
    }),
    expiredInWindow: sig(vault, "expired-in-window", "positive", "2026-06-18T10:00:00Z", {
      expiration_date: "2026-06-19",
    }),
  };
  confirmedPref(vault, "redundant-topic", [ids.redundantIn]);
  confirmedPref(vault, "sign-topic", [ids.signEvidence]);
  confirmedPref(vault, "fallback-topic", []);
  return ids;
}

describe("dream archives inbox signals that can no longer become candidates", () => {
  test("rule boundaries: inside, outside, edge, promoted, redundant", () => {
    const vault = newVault("v");
    const ids = seed(vault);
    const dirs = brainDirs(vault);

    const summary = dream(vault, { now: NOW_1 });

    const archivedExpected = [
      ids.fallbackOld1,
      ids.fallbackOld2,
      ids.fallbackOld3,
      ids.outsideSingleton,
      ids.edgeOut,
      ids.promotedStale,
      ids.redundantOut,
      ids.signEvidence,
    ].toSorted();
    expect([...(summary.archived_signals ?? [])].toSorted()).toEqual(archivedExpected);
    expect(names(dirs.archived)).toEqual(archivedExpected.map((id) => `${id}.md`));
    // Still able to contribute: stays in the inbox.
    expect(names(dirs.inbox)).toEqual(
      [ids.insideSingleton, ids.edgeIn, ids.expiredInWindow].toSorted().map((id) => `${id}.md`),
    );
    // Promoted and redundant signals go to processed/, never to the archive.
    expect(names(dirs.processed)).toEqual(
      [ids.promotedA, ids.promotedB, ids.redundantIn].toSorted().map((id) => `${id}.md`),
    );
    // The run's audit trail names every archived signal.
    const log = readFileSync(logPath(vault, "2026-06-30"), "utf8");
    for (const id of archivedExpected) expect(log).toContain(id);
    expect(log).toContain("archived_signals");
  });

  test("archiving moves the file byte for byte", () => {
    const vault = newVault("v");
    const ids = seed(vault);
    const dirs = brainDirs(vault);
    const before = readFileSync(join(dirs.inbox, `${ids.outsideSingleton}.md`), "utf8");
    dream(vault, { now: NOW_1 });
    expect(readFileSync(join(dirs.archived, `${ids.outsideSingleton}.md`), "utf8")).toBe(before);
  });

  test("a second pass archives nothing and changes nothing", () => {
    const vault = newVault("v");
    seed(vault);
    dream(vault, { now: NOW_1 });
    const archivedBefore = contents(brainDirs(vault).archived);
    const second = dream(vault, { now: NOW_1 });
    expect(second.changed).toBe(false);
    expect(second.archived_signals ?? []).toEqual([]);
    expect(contents(brainDirs(vault).archived)).toEqual(archivedBefore);
  });

  test("dry run reports the archivable count and touches nothing", () => {
    const vault = newVault("v");
    const ids = seed(vault);
    const dirs = brainDirs(vault);
    const inboxBefore = names(dirs.inbox);
    const preview = dream(vault, { now: NOW_1, dryRun: true });
    expect([...(preview.archived_signals ?? [])].toSorted()).toContain(ids.outsideSingleton);
    expect(preview.archived_signals?.length).toBe(8);
    expect(names(dirs.inbox)).toEqual(inboxBefore);
    expect(names(dirs.archived)).toEqual([]);
  });

  test("a pass whose only work is archiving still runs and logs", () => {
    const vault = newVault("v");
    const id = sig(vault, "lonely", "positive", "2026-05-01T10:00:00Z");
    const summary = dream(vault, { now: NOW_1 });
    expect(summary.changed).toBe(true);
    expect(summary.archived_signals).toEqual([id]);
  });

  test("an existing file in the archive is never overwritten", () => {
    const vault = newVault("v");
    const id = sig(vault, "clash", "positive", "2026-05-01T10:00:00Z");
    const dirs = brainDirs(vault);
    atomicWriteFileSync(join(dirs.archived, `${id}.md`), "operator copy\n");
    const summary = dream(vault, { now: NOW_1 });
    expect(summary.archived_signals ?? []).toEqual([]);
    expect(readFileSync(join(dirs.archived, `${id}.md`), "utf8")).toBe("operator copy\n");
    expect(names(dirs.inbox)).toEqual([`${id}.md`]);
  });

  test("archive_stale_signals: false keeps the historical behaviour", () => {
    const vault = newVault("v", { archive: false });
    seed(vault);
    const summary = dream(vault, { now: NOW_1 });
    expect(summary.archived_signals ?? []).toEqual([]);
    expect(names(brainDirs(vault).archived)).toEqual([]);
  });
});

describe("archiving changes no promotion outcome", () => {
  test("two passes produce the same preferences with and without the archive", () => {
    const archiving = newVault("archiving");
    const keeping = newVault("keeping", { archive: false });

    for (const vault of [archiving, keeping]) {
      seed(vault);
      dream(vault, { now: NOW_1 });
      // Between the passes: a restatement of an archived singleton's topic,
      // two signals agreeing with the sign-evidenced rule, and a fresh
      // cluster that promotes.
      sig(vault, "outside-singleton", "positive", "2026-07-02T10:00:00Z", {
        slug: "outside-singleton-again",
      });
      sig(vault, "sign-topic", "negative", "2026-07-02T10:00:00Z", { slug: "sign-topic-a" });
      sig(vault, "sign-topic", "negative", "2026-07-02T11:00:00Z", { slug: "sign-topic-b" });
      sig(vault, "fallback-topic", "negative", "2026-07-02T10:00:00Z", {
        slug: "fallback-topic-a",
      });
      sig(vault, "fallback-topic", "negative", "2026-07-02T11:00:00Z", {
        slug: "fallback-topic-b",
      });
      sig(vault, "fresh-topic", "positive", "2026-07-01T10:00:00Z", { slug: "fresh-topic-a" });
      sig(vault, "fresh-topic", "positive", "2026-07-02T10:00:00Z", { slug: "fresh-topic-b" });
      dream(vault, { now: NOW_2 });
    }

    const a = brainDirs(archiving);
    const k = brainDirs(keeping);
    expect(contents(a.preferences)).toEqual(contents(k.preferences));
    expect(contents(a.retired)).toEqual(contents(k.retired));
    expect(contents(a.processed)).toEqual(contents(k.processed));
    // Both rules kept their sign: the agreeing pairs were noted redundant
    // rather than read as rebuttals.
    expect(names(a.retired)).toEqual([]);
    // The union of inbox and archive is the historical inbox.
    expect([...names(a.inbox), ...names(a.archived)].toSorted()).toEqual(names(k.inbox));
    expect(names(a.archived).length).toBeGreaterThan(0);
  });
});
