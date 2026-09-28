/**
 * The waiting lock's fairness, its budget override and what a refusal tells
 * the operator (issue #198).
 *
 * The wait loop used to be unfair in one specific way: a writer that
 * released a lock and came straight back for it re-created the lock file
 * before any sleeping waiter woke, so under a steady stream of writes one
 * waiter could lose every draw for the whole budget and be refused on a
 * perfectly healthy race. A waiter now marks the held lock file, and a
 * holder that releases a marked lock steps back before it re-acquires.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { manifestPath, updateManifest } from "../../../src/core/brain/ingest/content-manifest.ts";
import {
  acquireLockSync,
  acquireLockSyncWithRetry,
  LOCK_WAIT_BUDGET_ENV,
  LOCK_WAIT_BUDGET_MS,
  resolveLockWaitBudgetMs,
} from "../../../src/core/brain/sync-lockfile.ts";

let root: string;
let savedEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-lock-fair-"));
  savedEnv = process.env[LOCK_WAIT_BUDGET_ENV];
  delete process.env[LOCK_WAIT_BUDGET_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[LOCK_WAIT_BUDGET_ENV];
  else process.env[LOCK_WAIT_BUDGET_ENV] = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

/** Refusal raised by `fn`, or a failed expectation if it did not throw. */
function refusal(fn: () => unknown): NodeJS.ErrnoException {
  try {
    fn();
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
  throw new Error("expected a lock refusal, got none");
}

describe("resolveLockWaitBudgetMs — the environment override", () => {
  test("unset or blank means the built-in default", () => {
    expect(resolveLockWaitBudgetMs({})).toBe(LOCK_WAIT_BUDGET_MS);
    expect(resolveLockWaitBudgetMs({ [LOCK_WAIT_BUDGET_ENV]: "  " })).toBe(LOCK_WAIT_BUDGET_MS);
  });

  test.each([
    ["20000", 20_000],
    [" 750 ", 750],
    ["0", 0],
  ])("%p is a budget of %p ms", (raw, expected) => {
    expect(resolveLockWaitBudgetMs({ [LOCK_WAIT_BUDGET_ENV]: raw })).toBe(expected);
  });

  test.each(["5s", "-1", "1.5", "NaN", "Infinity", "1e400"])(
    "%p is refused by name rather than replaced with the default",
    (raw) => {
      expect(() => resolveLockWaitBudgetMs({ [LOCK_WAIT_BUDGET_ENV]: raw })).toThrow(
        LOCK_WAIT_BUDGET_ENV,
      );
    },
  );

  test("a caller that passes no budget waits for the override, not the default", () => {
    const target = join(root, "override.json");
    const held = acquireLockSync(target);
    try {
      process.env[LOCK_WAIT_BUDGET_ENV] = "60";
      const started = Date.now();
      const err = refusal(() => acquireLockSyncWithRetry(target));
      expect(err.code).toBe("ELOCKED");
      expect(Date.now() - started).toBeLessThan(LOCK_WAIT_BUDGET_MS / 2);
    } finally {
      held.release();
    }
  });
});

describe("acquireLockSyncWithRetry — a refusal says what to do next", () => {
  test("names the lock, the wait, the retry and the override", () => {
    const target = join(root, "remedy.json");
    const held = acquireLockSync(target);
    try {
      process.env[LOCK_WAIT_BUDGET_ENV] = "40";
      const err = refusal(() => acquireLockSyncWithRetry(target));
      expect(err.code).toBe("ELOCKED");
      expect(err.path).toBe(`${target}.lock`);
      expect(err.message).toContain(`lock busy: ${target}.lock`);
      expect(err.message).toMatch(/after waiting \d+ ms/);
      expect(err.message).toContain("retry");
      expect(err.message).toContain(`${LOCK_WAIT_BUDGET_ENV}`);
      // The original single-attempt collision stays reachable.
      expect((err.cause as NodeJS.ErrnoException).code).toBe("ELOCKED");
    } finally {
      held.release();
    }
  });

  test("an explicit short budget does not point at the override it ignores", () => {
    const target = join(root, "interactive.json");
    const held = acquireLockSync(target);
    try {
      const err = refusal(() => acquireLockSyncWithRetry(target, 30));
      expect(err.message).toContain("retry");
      expect(err.message).not.toContain(LOCK_WAIT_BUDGET_ENV);
    } finally {
      held.release();
    }
  });

  test("a refused ingest write tells the operator to retry, serialize or wait longer", () => {
    const vault = root;
    writeFileSync(join(vault, "source.md"), "body", "utf8");
    const manifestLock = acquireLockSync(manifestPath(vault));
    try {
      process.env[LOCK_WAIT_BUDGET_ENV] = "40";
      const err = refusal(() => updateManifest(vault, ["source.md"]));
      expect(err.code).toBe("ELOCKED");
      expect(err.message).toContain("lock busy");
      expect(err.message).toContain("retry the ingest");
      expect(err.message).toContain("one at a time");
      expect(err.message).toContain(LOCK_WAIT_BUDGET_ENV);
    } finally {
      manifestLock.release();
    }
  });
});

describe("acquireLockSyncWithRetry — a waiter is not starved by a returning holder", () => {
  test("a holder that releases a lock someone waits on hands it over before re-acquiring", async () => {
    const target = join(root, "handoff.json");
    const lockPath = `${target}.lock`;
    const marker = join(root, "waiter-acquired");
    const child = join(root, "waiter.ts");
    writeFileSync(
      child,
      [
        `import { acquireLockSyncWithRetry } from ${JSON.stringify(join(import.meta.dir, "../../../src/core/brain/sync-lockfile.ts"))};`,
        "const [target, marker] = process.argv.slice(2);",
        "const h = acquireLockSyncWithRetry(target, 20000);",
        `require("node:fs").writeFileSync(marker, String(Date.now()));`,
        "Bun.sleepSync(50);",
        "h.release();",
      ].join("\n"),
      "utf8",
    );

    let held = acquireLockSync(target);
    const baseSize = statSync(lockPath).size;
    const proc = Bun.spawn(["bun", child, target, marker], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    try {
      // Wait until the child has failed at least one draw and marked the lock.
      const until = Date.now() + 20_000;
      while (statSync(lockPath).size <= baseSize) {
        if (Date.now() > until) throw new Error("the waiter never marked the held lock");
        // oxlint-disable-next-line no-await-in-loop -- polling the child's progress, one wait at a time by design
        await Bun.sleep(5);
      }
      // Release and come straight back, as a writer in a loop does. Without
      // the hand-over this re-acquire wins before the sleeping waiter wakes.
      held.release();
      held = acquireLockSyncWithRetry(target);
      expect(existsSync(marker)).toBe(true);
    } finally {
      held.release();
      const code = await proc.exited;
      const err = await new Response(proc.stderr).text();
      expect(`${code} ${err.trim()}`).toBe("0 ");
    }
  }, 60_000);

  test.skipIf(process.platform === "win32")(
    "a waiter's mark never writes through a symlink planted at the lock path",
    () => {
      const victim = join(root, "victim.txt");
      writeFileSync(victim, "unchanged", "utf8");
      const target = join(root, "planted.json");
      symlinkSync(victim, `${target}.lock`);
      const err = refusal(() => acquireLockSyncWithRetry(target, 60));
      expect(err.code).toBe("ELOCKED");
      expect(readFileSync(victim, "utf8")).toBe("unchanged");
    },
  );

  test("an uncontended writer in a loop does not pay the hand-over pause", () => {
    const target = join(root, "loop.json");
    const rounds = 40;
    const started = Date.now();
    for (let i = 0; i < rounds; i++) acquireLockSyncWithRetry(target).release();
    // A pause on every round would cost at least rounds x 50 ms.
    expect(Date.now() - started).toBeLessThan(rounds * 25);
  });
});
