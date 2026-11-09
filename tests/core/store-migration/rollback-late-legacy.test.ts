/**
 * `--rollback` keeps the late legacy writes of a machine still on the old
 * release (design D11a): lines and pages another device wrote into its
 * legacy tree after this machine switched, which sync delivered here but
 * no transition import has read yet, are imported before the snapshot is
 * restored, so the restore cannot wipe them and the replay writes them
 * back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { rollback } from "../../../src/core/store-migration/outcome.ts";
import { RollbackRefusedError } from "../../../src/core/store-migration/rollback.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";
import { moveNeverHeld } from "../../helpers/held-partitions.ts";

const FAST = { settleMs: 0 } as const;
let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function legacyLogText(vault: string): string {
  const dir = join(vault, "Brain", "log");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("");
}

function row(ts: string, text: string): string {
  return `${JSON.stringify({ ts, kind: "note", payload: { text }, prev: null, h: "0".repeat(64) })}\n`;
}

describe("rollback after late legacy writes", () => {
  test("lines and pages another device wrote after the switch survive the rollback", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);

    // dev-b, still on the old release, keeps writing its legacy tree, and
    // sync delivers its files into dev-a's vault after the switch.
    const grown = join(a.vault, "Brain", "log", "2026-11-01.dev-b.jsonl");
    a.write(
      "Brain/log/2026-11-01.dev-b.jsonl",
      readFileSync(grown, "utf8") + row("2026-11-01T18:00:00Z", "late line from dev-b"),
    );
    a.write("Brain/log/2026-11-09.dev-b.jsonl", row("2026-11-09T08:00:00Z", "new day from dev-b"));
    a.write(
      "Brain/inbox/2026-11-09-late.md",
      "---\nkind: brain-signal\nid: sig-late\ntopic: late\nprinciple: Written by dev-b late\n---\nLate.\n",
    );

    rollback(a.vault);

    const log = legacyLogText(a.vault);
    expect(log).toContain("late line from dev-b");
    expect(log).toContain("new day from dev-b");
    const inbox = join(a.vault, "Brain", "inbox");
    const pages = readdirSync(inbox).filter((name) => name.endsWith(".md"));
    const late = pages.map((name) => readFileSync(join(inbox, name), "utf8")).join("");
    expect(late).toContain("Written by dev-b late");
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);
  });

  test("a late item of a partition this machine does not hold refuses the rollback", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // A no longer holds the private partition when dev-b's private page arrives.
    moveNeverHeld(a.storeRoot, join(fleet.parent, "private-aside"));
    const rel = "Brain/inbox/2026-11-09-secret.md";
    a.write(
      rel,
      "---\nkind: brain-signal\nid: sig-secret\ntopic: s\nprinciple: s\nvisibility: private\n---\n",
    );
    expect(() => rollback(a.vault)).toThrow(RollbackRefusedError);
    // Nothing was restored: the late page is still there.
    expect(existsSync(join(a.vault, ...rel.split("/")))).toBe(true);
  });

  test("a late item the import cannot read is kept aside before the restore", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    a.write("Brain/log/2026-11-09.dev-b.jsonl", "{ not json\n");
    const result = rollback(a.vault);
    expect(result.legacy_tree_kept).not.toBeNull();
    expect(
      readFileSync(join(result.legacy_tree_kept!, "log", "2026-11-09.dev-b.jsonl"), "utf8"),
    ).toBe("{ not json\n");
  });
});
