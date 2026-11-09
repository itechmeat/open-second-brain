/**
 * The automatic transition import (task 2.4): a switched machine imports
 * what a machine still on the old release writes, from the dream and the
 * session-start triggers, stats files only when nothing changed, runs at
 * most once an hour from session start, and stops once no roster device
 * is left on the legacy layout.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { runAutoTransition } from "../../../src/core/store-migration/auto-transition.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { legacyDevices } from "../../../src/core/store-migration/migration-records.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";
import { moveNeverHeld } from "../../helpers/held-partitions.ts";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

const HOUR = 3_600_000;
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

  test("an item held back for a partition this machine lacks idles until the partitions change", () => {
    fleet = makeFleet(["dev-a", "dev-c"]);
    const [a, c] = [fleet.machine("dev-a"), fleet.machine("dev-c")];
    a.use();
    expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
    // A no longer holds the private partition; dev-c writes a private page.
    const aside = join(fleet.parent, "private-aside");
    moveNeverHeld(a.storeRoot, aside);
    const rel = "Brain/inbox/2026-11-07-secret.md";
    c.write(rel, `---\nid: sig-secret\ntopic: s\nprinciple: s\nvisibility: private\n---\n`);
    fleet.syncVaultFile("dev-c", "dev-a", rel);
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
