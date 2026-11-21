/**
 * A signal page's lifecycle state on a legacy machine is its folder: the
 * legacy reader (`read/signals.ts`) and every legacy mover put a consumed
 * page in `inbox/processed/`, an archived one in `inbox/archived/`. The
 * migration carries that state into the store, so a page an operator moved
 * into `processed/` by hand, with no `_status` of its own, is consumed on
 * the switched machine too, as it was before the switch.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readSignals } from "../../../src/core/store/read/signals.ts";
import { removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

function signalPage(id: string, extra = ""): string {
  return (
    `---\nkind: brain-signal\nid: ${id}\ncreated_at: 2026-10-02T00:00:00Z\n` +
    `topic: t-${id}\nsignal: positive\nagent: tester\nprinciple: Rule ${id}.\n${extra}---\n\n` +
    `## Raw\n\nraw ${id}\n`
  );
}

test("a signal page keeps the state its folder gave it across the migration", () => {
  bench = makeMigrationBench("osb-signal-folder-state-");
  const { vault } = bench;
  const inbox = join(vault, "Brain", "inbox");
  mkdirSync(join(inbox, "processed"), { recursive: true });
  mkdirSync(join(inbox, "archived"), { recursive: true });
  writeFileSync(join(inbox, "processed", "sig-hand-moved.md"), signalPage("sig-hand-moved"));
  writeFileSync(join(inbox, "archived", "sig-hand-archived.md"), signalPage("sig-hand-archived"));
  writeFileSync(join(inbox, "sig-still-active.md"), signalPage("sig-still-active"));

  const stateOf = () =>
    new Map(readSignals({ vault }, { states: "all" }).map((s) => [s.id, s.state]));
  const before = stateOf();
  expect(before.get("sig-hand-moved")).toBe("consumed");
  expect(before.get("sig-hand-archived")).toBe("archived");
  expect(before.get("sig-still-active")).toBe("active");

  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);

  const after = stateOf();
  expect(after.get("sig-hand-moved")).toBe("consumed");
  expect(after.get("sig-hand-archived")).toBe("archived");
  expect(after.get("sig-still-active")).toBe("active");
  // The fixture's own processed page (`2026-10-01-old.md`, no `_status`)
  // and its pending page keep theirs too.
  expect(after.get("sig-old")).toBe("consumed");
  expect(after.get("sig-staged")).toBe("staged");
  const live = readSignals({ vault }).map((s) => s.id);
  expect(live).not.toContain("sig-hand-moved");
});
