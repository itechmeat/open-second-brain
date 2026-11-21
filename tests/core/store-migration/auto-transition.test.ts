/**
 * The automatic transition import (task 2.4): a switched machine imports
 * what a machine still on the old release writes, from the dream and the
 * session-start triggers, stats files only when nothing changed, runs at
 * most once an hour from session start, and stops once no roster device
 * is left on the legacy layout.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RACY_WINDOW_MS } from "../../../src/core/fs-stamp.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { runAutoTransition } from "../../../src/core/store-migration/auto-transition.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { legacyDevices } from "../../../src/core/store-migration/migration-records.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";
import { moveNeverHeld } from "../../helpers/held-partitions.ts";

let fleet: Fleet | null = null;
afterEach(() => {
  setSystemTime();
  fleet?.cleanup();
  fleet = null;
});

const HOUR = 3_600_000;

/**
 * Moves the clock past the racy window (`fs-stamp.ts`). A legacy file
 * changed less than that before a watermark is taken gets a stamp that
 * matches nothing, so the next run imports again rather than idle: a
 * same-size rewrite inside one tick of the volume's clock would keep
 * every field. A test that expects an idle run lets the files it wrote
 * settle before the run that records the watermark.
 */
function settle(): void {
  setSystemTime(new Date(Date.now() + RACY_WINDOW_MS + 1_000));
}
const SIGNAL = (id: string): string => `---\nid: ${id}\ntopic: ${id}\nprinciple: ${id}\n---\n`;

describe("runAutoTransition", () => {
  test("imports late writes, idles on an unchanged tree, throttles hooks, stops when no roster device is left on the legacy layout", () => {
    fleet = makeFleet(["dev-a", "dev-c"]);
    const [a, c] = [fleet.machine("dev-a"), fleet.machine("dev-c")];
    let clock = Date.UTC(2026, 10, 7, 9, 0, 0);
    const now = () => clock;

    c.use();
    // Not switched yet: nothing runs.
    expect(
      runAutoTransition({
        store: c.store(),
        vault: c.vault,
        agent: "t",
        vaultId: null,
        trigger: "dream",
      }).status,
    ).toBe("not-switched");

    a.use();
    settle();
    expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
    const run = (trigger: "dream" | "session-start") =>
      runAutoTransition({
        store: a.store(),
        vault: a.vault,
        agent: "t",
        vaultId: null,
        trigger,
        now,
      });

    // dev-c (old release) writes; vault sync delivers it to A.
    c.write("Brain/inbox/2026-11-07-from-c.md", SIGNAL("sig-from-c"));
    fleet.syncVaultFile("dev-c", "dev-a", "Brain/inbox/2026-11-07-from-c.md");
    settle();
    const first = run("dream");
    expect(first.status).toBe("imported");
    if (first.status === "imported") expect(first.imported).toBe(1);
    expect(run("dream").status).toBe("idle");

    // From session start: at most once an hour.
    clock += 1000;
    expect(run("session-start").status).toBe("idle");
    expect(run("session-start").status).toBe("throttled");
    clock += HOUR + 1;
    expect(run("session-start").status).toBe("idle");

    // dev-c and dev-b are retired: no device is left on the legacy layout,
    // so nothing is left to import from. dev-b is not a machine of this
    // fleet, but the legacy fixture's shard names include it, so the
    // watermark and the cohort count it as a legacy device until it is
    // retired too.
    appendRecord(a.store(), {
      partition: "shared",
      stream: "settings",
      kind: "device-retire",
      agent: "t",
      body: { authority: "human", device: "dev-c" },
    });
    appendRecord(a.store(), {
      partition: "shared",
      stream: "settings",
      kind: "device-retire",
      agent: "t",
      body: { authority: "human", device: "dev-b" },
    });
    expect(run("dream").status).toBe("no-legacy-devices");
    expect(a.byKey().get("Brain/inbox/2026-11-07-from-c.md")).toHaveLength(1);
  });

  test("a same-size rewrite in place with mtime put back is imported", () => {
    // What a volume whose clock did not move between two writes reports:
    // same inode, size and mtime. The watermark keys on the full stat
    // stamp, ctime included, and never trusts one younger than the racy
    // window, so the rewrite is not taken for an unchanged tree.
    fleet = makeFleet(["dev-a", "dev-c"]);
    const [a, c] = [fleet.machine("dev-a"), fleet.machine("dev-c")];
    a.use();
    settle();
    expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
    const rel = "Brain/inbox/2026-11-07-from-c.md";
    c.write(rel, SIGNAL("sig-from-c"));
    fleet.syncVaultFile("dev-c", "dev-a", rel);
    // A whole second, so `utimes` can put it back exactly.
    const path = join(a.vault, rel);
    const mtime = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(path, mtime, mtime);
    settle();
    const run = () =>
      runAutoTransition({
        store: a.store(),
        vault: a.vault,
        agent: "t",
        vaultId: null,
        trigger: "dream",
      });
    expect(run().status).toBe("imported");
    expect(run().status).toBe("idle");
    // Back to the real clock: the rewrite below is as young as it is.
    setSystemTime();

    writeFileSync(path, readFileSync(path, "utf8").replaceAll("sig-from-c", "sig-from-d"));
    utimesSync(path, mtime, mtime);
    expect(run().status).toBe("imported");
  });

  test("an item held back for a partition this machine lacks idles until the partitions change", () => {
    fleet = makeFleet(["dev-a", "dev-c"]);
    const [a, c] = [fleet.machine("dev-a"), fleet.machine("dev-c")];
    a.use();
    settle();
    expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
    // A no longer holds the private partition; dev-c writes a private page.
    const aside = join(fleet.parent, "private-aside");
    moveNeverHeld(a.storeRoot, aside);
    const rel = "Brain/inbox/2026-11-07-secret.md";
    c.write(rel, `---\nid: sig-secret\ntopic: s\nprinciple: s\nvisibility: private\n---\n`);
    fleet.syncVaultFile("dev-c", "dev-a", rel);
    settle();
    const run = () =>
      runAutoTransition({
        store: a.store(),
        vault: a.vault,
        agent: "t",
        vaultId: null,
        trigger: "dream",
      });
    const first = run();
    expect(first.status).toBe("imported");
    if (first.status === "imported") expect(first.held_back).toBe(1);
    // Nothing changed: the held-back item cannot be imported yet.
    expect(run().status).toBe("idle");
    // The private partition is back: the held-back item is retried.
    renameSync(aside, join(a.storeRoot, "private"));
    const again = run();
    expect(again.status).toBe("imported");
    if (again.status === "imported") {
      expect(again.held_back).toBe(0);
      expect(again.imported).toBe(1);
    }
  });

  test("a device never seen before that syncs a legacy shard is imported after the cohort switched", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    settle();
    expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
    // Every other cohort device is retired: nothing is left on the legacy layout.
    for (const device of legacyDevices(a.store(), [])) {
      appendRecord(a.store(), {
        partition: "shared",
        stream: "settings",
        kind: "device-retire",
        agent: "t",
        body: { authority: "human", device },
      });
    }
    const run = () =>
      runAutoTransition({
        store: a.store(),
        vault: a.vault,
        agent: "t",
        vaultId: null,
        trigger: "dream",
      });
    expect(run().status).toBe("no-legacy-devices");
    // An old-release device absent from the initial tree syncs its first shard.
    const rel = "Brain/log/2026-11-08.dev-new.jsonl";
    a.write(
      rel,
      `${JSON.stringify({ ts: "2026-11-08T10:00:00Z", kind: "note", payload: { text: "new" } })}\n`,
    );
    const found = run();
    expect(found.status).toBe("imported");
    if (found.status === "imported") {
      expect(found.imported).toBe(1);
      expect(found.legacy_devices).toContain("dev-new");
    }
    expect(a.byKey().has(`${rel}#1`)).toBe(true);
  });

  test("a page-only arrival is imported after every known device switched or retired", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    settle();
    expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
    for (const device of legacyDevices(a.store(), [])) {
      appendRecord(a.store(), {
        partition: "shared",
        stream: "settings",
        kind: "device-retire",
        agent: "t",
        body: { authority: "human", device },
      });
    }
    let clock = Date.UTC(2026, 10, 8, 9, 0, 0);
    const run = (trigger: "dream" | "session-start" = "dream") =>
      runAutoTransition({
        store: a.store(),
        vault: a.vault,
        agent: "t",
        vaultId: null,
        trigger,
        now: () => clock,
      });
    expect(run().status).toBe("no-legacy-devices");
    // An old-release device syncs a page and no log shard.
    const rel = "Brain/inbox/2026-11-08-page-only.md";
    a.write(rel, SIGNAL("sig-page-only"));
    settle();
    const found = run();
    expect(found.status).toBe("imported");
    if (found.status === "imported") expect(found.imported).toBe(1);
    expect(a.byKey().get(rel)).toHaveLength(1);
    // Unchanged since: only the listing and the stats, no import.
    expect(run().status).toBe("no-legacy-devices");
    // From session start it is throttled like the import itself.
    expect(run("session-start").status).toBe("no-legacy-devices");
    clock += 1000;
    expect(run("session-start").status).toBe("throttled");
  });

  test("a page synced between the switch and the first automatic run is imported", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    settle();
    expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
    for (const device of legacyDevices(a.store(), [])) {
      appendRecord(a.store(), {
        partition: "shared",
        stream: "settings",
        kind: "device-retire",
        agent: "t",
        body: { authority: "human", device },
      });
    }
    // An old-release device syncs a page before this machine's first
    // automatic run: the migration's own watermark already says the tree
    // changed since its final pass.
    const rel = "Brain/inbox/2026-11-08-early.md";
    a.write(rel, SIGNAL("sig-early"));
    settle();
    const run = () =>
      runAutoTransition({
        store: a.store(),
        vault: a.vault,
        agent: "t",
        vaultId: null,
        trigger: "dream",
      });
    const found = run();
    expect(found.status).toBe("imported");
    expect(a.byKey().get(rel)).toHaveLength(1);
    expect(run().status).toBe("no-legacy-devices");
  });

  test("with no watermark and no legacy device left, the journal decides what to import", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    settle();
    expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
    for (const device of legacyDevices(a.store(), [])) {
      appendRecord(a.store(), {
        partition: "shared",
        stream: "settings",
        kind: "device-retire",
        agent: "t",
        body: { authority: "human", device },
      });
    }
    // A machine switched before the migration recorded a watermark.
    rmSync(join(migrationDir(a.store()), "transition-watermark.json"), { force: true });
    const rel = "Brain/inbox/2026-11-08-unwatched.md";
    a.write(rel, SIGNAL("sig-unwatched"));
    settle();
    const run = () =>
      runAutoTransition({
        store: a.store(),
        vault: a.vault,
        agent: "t",
        vaultId: null,
        trigger: "dream",
      });
    const found = run();
    expect(found.status).toBe("imported");
    if (found.status === "imported") expect(found.imported).toBe(1);
    expect(a.byKey().get(rel)).toHaveLength(1);
    expect(run().status).toBe("no-legacy-devices");
  });
});
