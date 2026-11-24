/**
 * The store migration's lines on the runtime notices channel (change
 * auto-store-migration, design D6): at most one short line about a failed
 * or waiting automatic migration, and the one-time success notice, which
 * only a session start asks for, shows once and then clears.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainActivePath } from "../../../src/core/brain/paths.ts";
import { collectRuntimeNotices } from "../../../src/core/brain/runtime-notices.ts";
import {
  autoMigrationStateDir,
  autoMigrationStatePath,
  claimAutoMigrationLock,
  readAutoMigrationNotice,
  recordAutoMigrationAttempt,
  releaseAutoMigrationLock,
  recordAutoMigrationFailure,
  recordAutoMigrationNotice,
  recordAutoMigrationWaiting,
  consumeAutoMigrationNotice,
  autoMigrationNoticePath,
  recoverClaimedAutoMigrationNotices,
} from "../../../src/core/store-migration/auto-state.ts";
import { assembleActiveContext, createInjectionMeter } from "../../../hooks/lib/active-context.ts";

/** A fixed clock: nothing here advances it. */
const NOW = new Date("2026-11-18T12:00:00.000Z");
const AUTO_ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";
/** Longest a migration line may be, inside the digest's budget. */
const LINE_CEILING = 400;

let root: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osb-notices-migration-"));
  vault = join(root, "vault");
  configPath = join(root, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Something left to migrate: without it a failure line depends on the
 * automatic migration's setting (with it off a failure is still shown,
 * with it on and nothing to move the failure is moot), so the tests that
 * expect a failure line seed it and pass whatever the environment says.
 */
function seedLegacy(): void {
  writeFileSync(join(vault, "Brain", "legacy-note.md"), "a legacy item\n");
}

const migrationNotices = (oneTime = false) =>
  collectRuntimeNotices(vault, { configPath, env: {}, oneTime }).filter((n) =>
    n.code.startsWith("store_migration"),
  );

describe("one line of the update a day at session start", () => {
  test("a session start shows it once a day; status shows it every time", () => {
    seedLegacy();
    recordAutoMigrationFailure(vault, "the disk is full", {
      manualCommand: "o2b brain migrate-store",
      now: NOW,
    });
    expect(migrationNotices(true)).toHaveLength(1);
    // A second start the same day says nothing more about the update.
    expect(migrationNotices(true)).toEqual([]);
    // Status and doctor read it every time.
    expect(migrationNotices(false)).toHaveLength(1);
    // The next day (the device-local day stamp moved back one day): again.
    writeFileSync(
      join(autoMigrationStateDir(vault), "update-notice.json"),
      `${JSON.stringify({ day: "2000-01-01" })}\n`,
    );
    expect(migrationNotices(true)).toHaveLength(1);
  });

  test("a start with the news that the brain moved shows that line alone", () => {
    seedLegacy();
    recordAutoMigrationNotice(vault, { snapshot: "store-migration-run" }, NOW);
    recordAutoMigrationWaiting(vault, { missing: [], firstMachines: ["dev-b"] }, NOW);
    const first = collectRuntimeNotices(vault, { configPath, env: {}, oneTime: true });
    const update = first.filter((n) => n.code.startsWith("store_"));
    expect(update.map((n) => n.code)).toEqual(["store_migration_done"]);
  });
});

describe("the store migration's runtime notices", () => {
  test("nothing recorded, nothing said", () => {
    expect(migrationNotices(true)).toEqual([]);
  });

  test("a failed attempt: one short warning naming the reason and the command", () => {
    seedLegacy();
    recordAutoMigrationFailure(vault, "x".repeat(2000), {
      manualCommand: "o2b brain migrate-store",
      now: NOW,
    });
    const notices = migrationNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.severity).toBe("warning");
    expect(notices[0]!.message).toContain("o2b brain migrate-store");
    expect(notices[0]!.message.length).toBeLessThanOrEqual(LINE_CEILING);
  });

  test("a failure promises a retry only while the automatic migration is on", () => {
    // Something left to migrate, and a cooldown that has not run out: the
    // line restates what the next start does about it.
    seedLegacy();
    recordAutoMigrationFailure(vault, "the disk is full", {
      manualCommand: "o2b brain migrate-store",
      now: new Date(),
    });
    const saved = process.env[AUTO_ENV];
    try {
      process.env[AUTO_ENV] = "true";
      expect(migrationNotices()[0]!.message).toContain("tries again after");
      process.env[AUTO_ENV] = "false";
      const off = migrationNotices()[0]!.message;
      expect(off).not.toContain("tries again");
      expect(off).toContain("off on this machine");
      expect(off).toContain("o2b brain migrate-store");
    } finally {
      if (saved === undefined) delete process.env[AUTO_ENV];
      else process.env[AUTO_ENV] = saved;
    }
  });

  test("a failure text reaches the session sanitised like the doctor's", () => {
    // A record as an older build, or a hand edit, could have left it.
    // The home this process always knows, on every platform.
    seedLegacy();
    const home = homedir();
    const path = autoMigrationStatePath(vault);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        state: "failed",
        failed_at: NOW.toISOString(),
        error: `cannot write ${join(home, "notes")}\u001b[31m\nnext line`,
        consecutive_failures: 1,
        retry_after: NOW.toISOString(),
        manual_command: "o2b brain migrate-store",
      }),
    );
    const message = migrationNotices()[0]!.message;
    expect(message).not.toContain(home);
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\n");
  });

  test("the record of an attempt whose worker still runs is not shown as a failure", () => {
    seedLegacy();
    recordAutoMigrationAttempt(vault, NOW);
    const token = claimAutoMigrationLock(vault, new Date());
    try {
      expect(migrationNotices()).toEqual([]);
    } finally {
      releaseAutoMigrationLock(vault, token!);
    }
    expect(migrationNotices()).toHaveLength(1);
  });

  test("a waiting machine: one info line", () => {
    recordAutoMigrationWaiting(vault, { missing: [], firstMachines: ["dev-b"] }, NOW);
    const notices = migrationNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.severity).toBe("info");
    expect(notices[0]!.message).toContain("dev-b");
  });

  test("the success notice is for a session start only, and reading it clears nothing", () => {
    recordAutoMigrationNotice(vault, { snapshot: "store-migration-run" }, NOW);
    expect(migrationNotices()).toEqual([]);
    const notices = migrationNotices(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain("store-migration-run");
    expect(notices[0]!.message).toContain("o2b brain migrate-store --rollback");
    expect(readAutoMigrationNotice(vault)).not.toBeNull();
  });
});

describe("the session start", () => {
  test("shows the success notice once, then clears it", () => {
    recordAutoMigrationNotice(vault, { snapshot: "store-migration-run" }, NOW);

    const first = assembleActiveContext(vault, 10_000, createInjectionMeter(10_000), {
      startsSession: true,
    });
    expect(first).toContain("o2b brain migrate-store --rollback");
    expect(readAutoMigrationNotice(vault)).toBeNull();

    const second = assembleActiveContext(vault, 10_000, createInjectionMeter(10_000), {
      startsSession: true,
    });
    expect(second).not.toContain("o2b brain migrate-store --rollback");
  });

  test("a start whose active digest cannot be read keeps the notice for the next one", () => {
    recordAutoMigrationNotice(vault, { snapshot: "store-migration-run" }, NOW);
    // A digest that cannot be read: the assembly throws, and the session
    // gets the last-good cache, which never held this notice.
    const active = brainActivePath(vault);
    rmSync(active, { force: true });
    mkdirSync(active, { recursive: true });

    expect(() =>
      assembleActiveContext(vault, 10_000, createInjectionMeter(10_000), { startsSession: true }),
    ).toThrow();
    expect(readAutoMigrationNotice(vault)).not.toBeNull();
  });

  test("a subagent's context neither shows nor clears it", () => {
    recordAutoMigrationNotice(vault, { snapshot: "store-migration-run" }, NOW);
    const text = assembleActiveContext(vault, 10_000, createInjectionMeter(10_000));
    expect(text).not.toContain("o2b brain migrate-store --rollback");
    expect(readAutoMigrationNotice(vault)).not.toBeNull();
  });
});

describe("two session starts at once", () => {
  test("only the one that consumes the notice shows it", async () => {
    recordAutoMigrationNotice(vault, { snapshot: "store-migration-run" }, NOW);
    const child = join(import.meta.dir, "fixtures", "notice-session-child.ts");
    const go = join(root, "go");
    const outs = [join(root, "a"), join(root, "b")];
    const procs = outs.map((out) =>
      Bun.spawn([process.execPath, "run", child, vault, out, go], {
        env: { ...process.env },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      }),
    );
    // Both sessions hold a rendered copy before either goes on.
    const deadline = Date.now() + 25_000;
    while (!outs.every((o) => existsSync(`${o}.rendered`)) && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(10);
    }
    writeFileSync(go, "");
    await Promise.all(procs.map((p) => p.exited));
    const shown = outs.map((o) => readFileSync(o, "utf8")).filter((s) => s === "shown");
    expect(shown).toHaveLength(1);
    expect(readAutoMigrationNotice(vault)).toBeNull();
  }, 60_000);
});

describe("guard: consuming the notice", () => {
  test("a session that rendered an older notice leaves a newer one in place", () => {
    recordAutoMigrationNotice(vault, { snapshot: "first", runId: "run-1" }, NOW);
    const rendered = readAutoMigrationNotice(vault)!;
    const later = new Date(NOW.getTime() + 1000);
    recordAutoMigrationNotice(vault, { snapshot: "second", runId: "run-2" }, later);
    expect(consumeAutoMigrationNotice(vault, rendered.at)).toBe(false);
    expect(readAutoMigrationNotice(vault)?.snapshot).toBe("second");
  });

  test("the mark of a notice already shown is never consumed as one", () => {
    recordAutoMigrationAttempt(vault, NOW);
    recordAutoMigrationNotice(vault, { snapshot: "first", runId: "run-1" }, NOW);
    const rendered = readAutoMigrationNotice(vault)!;
    expect(consumeAutoMigrationNotice(vault, rendered.at)).toBe(true);
    // The attempt is unfinished: the mark stays, and nothing is shown again.
    expect(readAutoMigrationNotice(vault)).toBeNull();
    expect(consumeAutoMigrationNotice(vault, rendered.at)).toBe(false);
    recordAutoMigrationNotice(vault, { snapshot: "first", runId: "run-1" }, NOW);
    expect(readAutoMigrationNotice(vault)).toBeNull();
  });
});

/** What a session killed right after its rename leaves: the notice under a claimed name. */
function killedAfterRename(): string {
  const path = autoMigrationNoticePath(vault);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  const claimed = `${path}.shown-${dead}-0badf00d`;
  renameSync(path, claimed);
  return claimed;
}

describe("a session killed while it consumes the notice", () => {
  test("its notice is shown by the next session start, and the claimed file goes", () => {
    recordAutoMigrationNotice(vault, { snapshot: "store-migration-run" }, NOW);
    const claimed = killedAfterRename();
    const text = assembleActiveContext(vault, 10_000, createInjectionMeter(10_000), {
      startsSession: true,
    });
    expect(text).toContain("o2b brain migrate-store --rollback");
    expect(existsSync(claimed)).toBe(false);
    expect(readAutoMigrationNotice(vault)).toBeNull();
  });

  test("killed after its mark: the notice it never showed replaces the mark once", () => {
    recordAutoMigrationAttempt(vault, NOW);
    recordAutoMigrationNotice(vault, { snapshot: "first", runId: "run-1" }, NOW);
    const claimed = killedAfterRename();
    // The killed session wrote the mark of the run before it died.
    writeFileSync(autoMigrationNoticePath(vault), JSON.stringify({ consumed_run: "run-1" }));
    const text = assembleActiveContext(vault, 10_000, createInjectionMeter(10_000), {
      startsSession: true,
    });
    expect(text).toContain("o2b brain migrate-store --rollback");
    expect(existsSync(claimed)).toBe(false);
    // Shown now: the mark is back, and the notice is not shown again.
    expect(readAutoMigrationNotice(vault)).toBeNull();
  });

  test("a newer notice written since is kept, and the claimed older one goes", () => {
    recordAutoMigrationNotice(vault, { snapshot: "first", runId: "run-1" }, NOW);
    const claimed = killedAfterRename();
    recordAutoMigrationNotice(
      vault,
      { snapshot: "second", runId: "run-2" },
      new Date(NOW.getTime() + 1000),
    );
    recoverClaimedAutoMigrationNotices(vault);
    expect(existsSync(claimed)).toBe(false);
    expect(readAutoMigrationNotice(vault)?.snapshot).toBe("second");
  });

  test("guard: a live session's claimed file is left alone", () => {
    recordAutoMigrationNotice(vault, { snapshot: "first", runId: "run-1" }, NOW);
    const path = autoMigrationNoticePath(vault);
    const claimed = `${path}.shown-${process.pid}-0badf00d`;
    renameSync(path, claimed);
    recoverClaimedAutoMigrationNotices(vault);
    expect(existsSync(claimed)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});

describe("a notice written between the rename and the mark", () => {
  test("is kept: the mark never replaces it", () => {
    recordAutoMigrationAttempt(vault, NOW);
    recordAutoMigrationNotice(vault, { snapshot: "first", runId: "run-1" }, NOW);
    const rendered = readAutoMigrationNotice(vault)!;
    const consumed = consumeAutoMigrationNotice(vault, rendered.at, {
      afterRename: () => {
        recordAutoMigrationNotice(
          vault,
          { snapshot: "second", runId: "run-2" },
          new Date(NOW.getTime() + 1000),
        );
      },
    });
    expect(consumed).toBe(true);
    expect(readAutoMigrationNotice(vault)?.snapshot).toBe("second");
  });
});
