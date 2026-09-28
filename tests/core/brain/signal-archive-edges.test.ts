/**
 * Inbox archive edges (issue #195): the files the archive step leaves in
 * the inbox on purpose, the archive names it cannot take, and the clock it
 * runs against.
 *
 * The doctor's `inbox-archivable` count is the dream pass's own selection,
 * so the warning clears once a pass has run whatever else the inbox holds.
 * A name already present in `inbox/archived/` - whether that file parses or
 * not - is a collision the plan reports instead of planning a move the apply
 * step would then refuse. And a pass run with `--now` in the future archives
 * nothing that is still inside the window at the real time.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { ARCHIVE_NAME_COLLISION_CODE } from "../../../src/core/brain/signal-archive.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW = new Date("2026-06-30T12:00:00Z");
const STALE = "2026-05-01T10:00:00Z";
const CODE = "inbox-archivable";
const DAY_MS = 24 * 60 * 60 * 1000;

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-archive-edges-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function sig(topic: string, createdAt: string): { id: string; path: string } {
  return writeSignal(vault, {
    topic,
    signal: "positive",
    agent: "claude",
    principle: `Principle for ${topic}`,
    created_at: createdAt,
    date: createdAt.slice(0, 10),
    slug: topic,
  });
}

function tombstoned(text: string): string {
  return text.replace(/^---\n/, "---\n_status: tombstoned\n");
}

/** Inbox signals the pass must leave alone, each for a different reason. */
function seedLeftovers(): { tombstonedPath: string; corruptPath: string; collidingPath: string } {
  const dirs = brainDirs(vault);
  const tomb = sig("tombstoned-old", STALE);
  atomicWriteFileSync(tomb.path, tombstoned(readFileSync(tomb.path, "utf8")));
  const corruptPath = join(dirs.inbox, "sig-2026-05-01-corrupt-old.md");
  atomicWriteFileSync(corruptPath, `---\ncreated_at: ${STALE}\ntopic: corrupt-old\n---\n`);
  const colliding = sig("colliding-old", STALE);
  mkdirSync(dirs.archived, { recursive: true });
  atomicWriteFileSync(
    join(dirs.archived, `${colliding.id}.md`),
    tombstoned(readFileSync(colliding.path, "utf8")),
  );
  return { tombstonedPath: tomb.path, corruptPath, collidingPath: colliding.path };
}

function finding(now: Date = NOW) {
  return runDoctor(vault, { now }).warnings.find((w) => w.code === CODE);
}

describe("inbox-archivable counts what the pass archives", () => {
  test("the count equals the dry-run archive set", () => {
    seedLeftovers();
    sig("plain-old", STALE);
    const planned = dream(vault, { now: NOW, dryRun: true }).archived_signals ?? [];
    expect(planned.length).toBe(1);
    const w = finding();
    expect(w).toBeDefined();
    expect(w!.message).toContain("1 of them");
  });

  test("clears after a pass although tombstoned, corrupt and colliding files remain", () => {
    const left = seedLeftovers();
    sig("plain-old", STALE);
    dream(vault, { now: NOW });
    expect(existsSync(left.tombstonedPath)).toBe(true);
    expect(existsSync(left.corruptPath)).toBe(true);
    expect(existsSync(left.collidingPath)).toBe(true);
    expect(finding()).toBeUndefined();
  });
});

describe("archive name collisions", () => {
  test("a tombstoned archive file of the same name is a collision, not a planned move", () => {
    const colliding = sig("colliding-old", STALE);
    const dirs = brainDirs(vault);
    mkdirSync(dirs.archived, { recursive: true });
    atomicWriteFileSync(
      join(dirs.archived, `${colliding.id}.md`),
      tombstoned(readFileSync(colliding.path, "utf8")),
    );

    const summary = dream(vault, { now: NOW });
    expect(summary.archived_signals ?? []).toEqual([]);
    expect(summary.changed).toBe(false);
    expect(summary.warnings.some((w) => w.code === ARCHIVE_NAME_COLLISION_CODE)).toBe(true);
    expect(existsSync(colliding.path)).toBe(true);
  });

  test("an unparseable archive file of the same name is a collision too", () => {
    const colliding = sig("colliding-old", STALE);
    const dirs = brainDirs(vault);
    mkdirSync(dirs.archived, { recursive: true });
    atomicWriteFileSync(join(dirs.archived, `${colliding.id}.md`), "---\ntopic: broken\n---\n");

    const summary = dream(vault, { now: NOW, dryRun: true });
    expect(summary.archived_signals ?? []).toEqual([]);
    expect(summary.warnings.some((w) => w.code === ARCHIVE_NAME_COLLISION_CODE)).toBe(true);
  });
});

describe("a future --now does not archive against a clock that has not come", () => {
  test("a signal inside the window at the real time stays in the inbox", () => {
    const createdAt = new Date(Date.now() - DAY_MS).toISOString();
    const recent = sig("recent", createdAt);
    const future = new Date(Date.now() + 60 * DAY_MS);

    const summary = dream(vault, { now: future });
    expect(summary.archived_signals ?? []).toEqual([]);
    expect(existsSync(recent.path)).toBe(true);
    expect(finding(future)).toBeUndefined();
  });

  test("a signal outside the window at the real time is still archived", () => {
    const createdAt = new Date(Date.now() - 60 * DAY_MS).toISOString();
    const old = sig("old", createdAt);
    const future = new Date(Date.now() + 60 * DAY_MS);

    const summary = dream(vault, { now: future });
    expect(summary.archived_signals ?? []).toEqual([old.id]);
  });
});
