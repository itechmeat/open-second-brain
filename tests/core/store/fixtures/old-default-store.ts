/**
 * A machine in the owner's 2.0.0 state for the relocation tests: switched
 * to the store, its store at the 2.0.0 default root outside the vault
 * (`store-relocation.ts`). Shared by the relocation test files.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord, type AppendInput } from "../../../../src/core/store/appender.ts";
import { readPartition } from "../../../../src/core/store/state-digest.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore, type StoreHandle } from "../../../../src/core/store/store-open.ts";
import { migrateStore } from "../../../../src/core/store-migration/outcome.ts";
import {
  makeVaultFleet,
  type VaultFleet,
  type VaultMachine,
} from "../../store-migration/fixtures/vault-fleet.ts";

export interface OldDefaultMachine {
  readonly fleet: VaultFleet;
  readonly a: VaultMachine;
}

/** One machine, `dev-a`, switched with its store outside the vault; `use`d. */
export function machineOnOldDefault(): OldDefaultMachine {
  const fleet = makeVaultFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  initStore({ root: a.externalStore });
  const outcome = migrateStore(a.vault, { resume: true, settleMs: 0 });
  if (outcome.mode !== "migration") {
    fleet.cleanup();
    throw new Error(`the fixture's migration did not run: ${outcome.mode}`);
  }
  return { fleet, a };
}

/** A note event in `shared`. */
export const EVENT: AppendInput = {
  partition: "shared",
  stream: "events",
  agent: "@t",
  kind: "log-event",
  body: { event_type: "note", text: "fixture" },
};

/** The ids of every record under `root`, sorted. */
export function recordIds(root: string): string[] {
  return (["shared", "private"] as const)
    .flatMap((p) => readPartition(join(root, p)).flatMap((s) => s.all))
    .map((r) => r.id)
    .toSorted();
}

/** A handle on the old root, opened before any move, with one event written through it. */
export function staleHandle(a: VaultMachine): StoreHandle {
  a.use();
  const stale = openStore({ root: a.externalStore, device: "dev-a" });
  appendRecord(stale, EVENT);
  return stale;
}

/** The path of `dev-a`'s events shard under `root` (the one {@link staleHandle} wrote). */
export function ownEventsShard(root: string): string {
  const rel = readdirSync(join(root, "shared", "events", "dev-a")).find((f) =>
    f.endsWith(".jsonl"),
  );
  if (rel === undefined) throw new Error(`no events shard of dev-a under ${root}`);
  return join(root, "shared", "events", "dev-a", rel);
}

/** The last line of `shard` as a record, with `id` in place of its own: a line an older release writes. */
export function lateLine(shard: string, id: string): string {
  const last = JSON.parse(readFileSync(shard, "utf8").trimEnd().split("\n").at(-1)!) as object;
  return `${JSON.stringify({ ...last, id })}\n`;
}
