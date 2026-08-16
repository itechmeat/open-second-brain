/**
 * Sync lockfile primitive for the brain write path. Single-attempt
 * exclusive create via `fs.openSync(target + '.lock', 'wx')`. Collisions
 * surface as a regular Error with `.code === 'ELOCKED'`; the brain
 * txn layer maps that to a `BrainCollisionError({ kind: 'SourceLock' })`.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireLockSync,
  acquireLockSyncWithRetry,
  LOCK_WAIT_BUDGET_MS,
  LOCK_WAIT_INTERACTIVE_MS,
  lockScanRoots,
  scanStaleLocks,
} from "../../../src/core/brain/sync-lockfile.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "osb-sync-lock-"));
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("acquireLockSync", () => {
  test("creates a .lock sibling file and release removes it", () => {
    const target = join(tmpRoot, "pref-foo.md");
    writeFileSync(target, "---\nkind: brain-preference\n---\n");

    const handle = acquireLockSync(target);
    expect(handle.path).toBe(target + ".lock");
    expect(existsSync(target + ".lock")).toBe(true);

    handle.release();
    expect(existsSync(target + ".lock")).toBe(false);
  });

  test("throws Error with code ELOCKED when the lock is already held", () => {
    const target = join(tmpRoot, "pref-bar.md");
    writeFileSync(target, "---\nkind: brain-preference\n---\n");

    const first = acquireLockSync(target);
    try {
      let caught: unknown;
      try {
        acquireLockSync(target);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as NodeJS.ErrnoException).code).toBe("ELOCKED");
    } finally {
      first.release();
    }
  });

  test("after release, target is acquirable again", () => {
    const target = join(tmpRoot, "pref-baz.md");
    writeFileSync(target, "---\n---\n");

    const first = acquireLockSync(target);
    first.release();
    const second = acquireLockSync(target);
    expect(existsSync(target + ".lock")).toBe(true);
    second.release();
  });

  test("release is idempotent (second call is a no-op)", () => {
    const target = join(tmpRoot, "pref-idem.md");
    writeFileSync(target, "");
    const handle = acquireLockSync(target);
    handle.release();
    handle.release(); // must not throw
    expect(existsSync(target + ".lock")).toBe(false);
  });

  test("acquire creates the lock even when the target file does not exist", () => {
    // The brain txn path needs to be able to lock the target before the
    // file is created (first-time write). The lock primitive must not
    // require the target to exist.
    const target = join(tmpRoot, "pref-new.md");
    const handle = acquireLockSync(target);
    try {
      expect(existsSync(target + ".lock")).toBe(true);
      expect(existsSync(target)).toBe(false);
    } finally {
      handle.release();
    }
  });
});

describe("scanStaleLocks", () => {
  test("returns paths of every .lock file under Brain/", () => {
    const a = join(tmpRoot, "Brain", "preferences", "pref-a.md");
    const b = join(tmpRoot, "Brain", "log", "continuity", "2026-06.jsonl");
    mkdirSync(dirname(a), { recursive: true });
    mkdirSync(dirname(b), { recursive: true });
    writeFileSync(a, "");
    const ha = acquireLockSync(a);
    // Manually drop a lock deeper in the tree to exercise the walk.
    writeFileSync(b + ".lock", "");

    const found = scanStaleLocks(tmpRoot).toSorted();
    expect(found).toContain(a + ".lock");
    expect(found).toContain(b + ".lock");

    ha.release();
    require("node:fs").unlinkSync(b + ".lock");
  });

  /**
   * The manifest and the ingest checkpoint - the two locks the parallel
   * ingest path takes most often - live in `.open-second-brain/`, not in
   * `Brain/`. A scan rooted at `Brain/` alone reported nothing for them,
   * so a crashed ingest left a lock the doctor could not name.
   */
  test("returns .lock files under the derived-store directory too", () => {
    const manifest = join(tmpRoot, ".open-second-brain", "ingest-manifest.json");
    const checkpoint = join(
      tmpRoot,
      ".open-second-brain",
      "ingest-checkpoints",
      "0123456789abcdef.json",
    );
    mkdirSync(dirname(checkpoint), { recursive: true });
    const hm = acquireLockSync(manifest);
    const hc = acquireLockSync(checkpoint);
    try {
      const found = scanStaleLocks(tmpRoot);
      expect(found).toContain(manifest + ".lock");
      expect(found).toContain(checkpoint + ".lock");
    } finally {
      hm.release();
      hc.release();
    }
  });

  test("returns an empty array when no locks exist", () => {
    const found = scanStaleLocks(tmpRoot);
    expect(found).toEqual([]);
  });

  test("a lock outside every enumerated root is not reported", () => {
    // Not a defect - it is the enumeration's boundary, stated so the
    // census below has something to be a census OF.
    const stray = join(tmpRoot, "notes", "user-note.md");
    mkdirSync(dirname(stray), { recursive: true });
    const handle = acquireLockSync(stray);
    try {
      expect(scanStaleLocks(tmpRoot)).toEqual([]);
    } finally {
      handle.release();
    }
  });
});

/**
 * The scan walks an ENUMERATED set of roots ({@link lockScanRoots}) rather
 * than one hard-coded directory, so a lock location that is not under one
 * of them escapes `brain doctor` silently - which is exactly what happened
 * to the manifest and the checkpoint.
 *
 * This census reads the sources rather than their behaviour, in the same
 * discipline as `tests/hooks/audit-root.test.ts`: the defect is not that
 * any one module locks the wrong place today, it is that adding a
 * thirteenth lock site under a third root would leave the scan quietly
 * incomplete. A new site fails this list until its author states which
 * root the scan will find it under.
 */
describe("every module that takes a lock is under a scanned root", () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

  /**
   * Declared lock sites, each with the vault-relative root
   * {@link lockScanRoots} reaches it through. Verified against the path
   * builders: every entry resolves under `Brain/` except the two ingest
   * artefacts, which live in the derived-store directory.
   */
  const DECLARED: ReadonlyMap<string, string> = new Map([
    ["core/brain/architect/generate.ts", "Brain"],
    ["core/brain/continuity/store.ts", "Brain"],
    ["core/brain/diagnostics.ts", "Brain"],
    ["core/brain/git/store.ts", "Brain"],
    ["core/brain/health/remediation.ts", "Brain"],
    ["core/brain/idempotency-ledger.ts", "Brain"],
    ["core/brain/ingest/checkpoint.ts", ".open-second-brain"],
    ["core/brain/ingest/content-manifest.ts", ".open-second-brain"],
    ["core/brain/lineage/ledger.ts", "Brain"],
    ["core/brain/preference-txn.ts", "Brain"],
    ["core/brain/query-demand.ts", "Brain"],
    ["core/brain/sessions/discover.ts", ".open-second-brain"],
    ["core/brain/skill-proposals.ts", "Brain"],
  ]);

  /** Every `src/` file that calls the lock primitive, vault-relative to `src/`. */
  function lockCallers(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = full.slice(SRC.length + 1).replaceAll("\\", "/");
        if (rel === "core/brain/sync-lockfile.ts") continue;
        const text = readFileSync(full, "utf8");
        if (/acquireLockSync(WithRetry)?\(/.test(text)) out.push(rel);
      }
    };
    walk(SRC);
    return out.toSorted();
  }

  test("the sweep actually found the lock callers", () => {
    // A census over an empty set passes for the wrong reason.
    expect(lockCallers().length).toBeGreaterThan(5);
  });

  test("no lock site is missing from the declared set", () => {
    const undeclared = lockCallers().filter((rel) => !DECLARED.has(rel));
    expect(undeclared).toEqual([]);
  });

  test("every declared root is one the scan actually walks", () => {
    const roots = lockScanRoots("/vault").map((abs) => abs.slice("/vault/".length));
    for (const root of new Set(DECLARED.values())) {
      expect(roots).toContain(root);
    }
  });
});

describe("acquireLockSyncWithRetry — the budget is a bound this module can honour", () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "refuses budgetMs %p by name instead of waiting on it",
    (budget) => {
      const target = join(tmpRoot, "budget.json");
      const held = acquireLockSync(target);
      try {
        expect(() => acquireLockSyncWithRetry(target, budget)).toThrow(
          /budgetMs must be an integer >= 0/,
        );
      } finally {
        held.release();
      }
    },
  );

  test("a zero budget is legal and means exactly one attempt", () => {
    const target = join(tmpRoot, "zero-budget.json");
    const held = acquireLockSync(target);
    try {
      const started = Date.now();
      let caught: NodeJS.ErrnoException | null = null;
      try {
        acquireLockSyncWithRetry(target, 0);
      } catch (err) {
        caught = err as NodeJS.ErrnoException;
      }
      expect(caught?.code).toBe("ELOCKED");
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      held.release();
    }
  });
});

/**
 * The wait is a synchronous FREEZE of the whole thread. That is the cost
 * the module's docblock states rather than argues away, and this is what
 * pins it, in both halves: the freeze is total (no timer runs during it,
 * so no progress event is emitted, no SIGINT handler runs, and inside the
 * MCP server no other tool call proceeds), and it ends when the budget
 * does rather than running on.
 */
describe("acquireLockSyncWithRetry — what the caller gives up while it waits", () => {
  test("the wait freezes the event loop, and ends when the budget does", () => {
    const target = join(tmpRoot, "frozen.json");
    const held = acquireLockSync(target);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 10);
    try {
      const budget = 300;
      const started = Date.now();
      let caught: NodeJS.ErrnoException | null = null;
      try {
        acquireLockSyncWithRetry(target, budget);
      } catch (err) {
        caught = err as NodeJS.ErrnoException;
      }
      const elapsed = Date.now() - started;
      expect(caught?.code).toBe("ELOCKED");
      // Bounded: the wait ends at the budget, not at some multiple of it.
      expect(elapsed).toBeGreaterThanOrEqual(budget);
      expect(elapsed).toBeLessThan(budget + 500);
      // Total: a 10 ms interval got no tick across 300 ms of waiting.
      // If this ever reads non-zero the wait has become interruptible,
      // and the docblock - not this expectation - is what should change
      // first.
      expect(ticks).toBe(0);
    } finally {
      clearInterval(timer);
      held.release();
    }
  });

  /**
   * The budget is not one number for everyone: it is how long a caller is
   * willing to freeze its process, which differs by what losing the race
   * costs that caller. Pinned so neither number can drift into the other's
   * job unnoticed - the default is the fan-out's, and the interactive one
   * is strictly shorter.
   */
  test("an interactive caller waits strictly less than the fan-out default", () => {
    expect(LOCK_WAIT_INTERACTIVE_MS).toBeLessThan(LOCK_WAIT_BUDGET_MS);
    // 1 s reproducibly fails the four-process manifest race, so the
    // shorter budget is a refusal to freeze, not a second default.
    expect(LOCK_WAIT_BUDGET_MS).toBeGreaterThanOrEqual(5_000);
  });

  test("the architect takes the interactive budget, not the default", () => {
    const generate = readFileSync(
      join(
        resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
        "src/core/brain/architect/generate.ts",
      ),
      "utf8",
    );
    // An interactive pass with a progress stream and a Ctrl-C behind it
    // must not park the terminal for the fan-out's budget.
    expect(generate).toContain("acquireLockSyncWithRetry(dir, LOCK_WAIT_INTERACTIVE_MS)");
  });
});
