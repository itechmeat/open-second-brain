/**
 * One reading of a moved root's `relocated.json` for every decision
 * (`relocation-target.ts`): a marker that is there and cannot be read is
 * never taken for an absent one, so neither the resolver, nor a stale
 * handle, nor `store init` uses either root while it stays unreadable.
 * And a relocation lock whose holder cannot be examined counts as held.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { ensureBrainStore } from "../../../src/core/brain/init-store.ts";
import { collectRuntimeNotices } from "../../../src/core/brain/runtime-notices.ts";
import { buildStoreStatusBlock } from "../../../src/core/store/store-status.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { STORE_RELOCATED_FILE } from "../../../src/core/store/constants.ts";
import { relocationRunning } from "../../../src/core/store/relocation-marker.ts";
import {
  inspectStore,
  openStore,
  RelocatedStoreUnavailableError,
} from "../../../src/core/store/store-open.ts";
import { pendingRelocation, relocateStore } from "../../../src/core/store/store-relocation.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import {
  EVENT,
  machineOnOldDefault,
  recordIds,
  staleHandle,
  type OldDefaultMachine,
} from "./fixtures/old-default-store.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let machine: OldDefaultMachine | null = null;
let scratch: string | null = null;
afterEach(() => {
  machine?.fleet.cleanup();
  machine = null;
  if (scratch !== null) {
    chmodSync(join(scratch, "state"), 0o700);
    rmSync(scratch, { recursive: true, force: true });
  }
  scratch = null;
});

const DAMAGE: ReadonlyArray<readonly [string, (text: string) => string]> = [
  ["cut short", (text) => text.slice(0, 20)],
  [
    "whose offset is a string",
    (text) => JSON.stringify({ ...JSON.parse(text), files: { "shared/events/x.jsonl": "999999" } }),
  ],
  ["whose files are a list", (text) => JSON.stringify({ ...JSON.parse(text), files: [7] })],
  [
    "whose offset is negative",
    (text) => JSON.stringify({ ...JSON.parse(text), files: { "shared/events/x.jsonl": -1 } }),
  ],
];

describe("a moved root whose relocation marker cannot be read", () => {
  for (const [label, damage] of DAMAGE) {
    test(`a marker ${label}: neither root is opened or written, and no second store is created`, () => {
      machine = machineOnOldDefault();
      const { a } = machine;
      const stale = staleHandle(a);
      expect(relocateStore().kind).toBe("relocated");
      const marker = join(a.externalStore, STORE_RELOCATED_FILE);
      writeFileSync(marker, damage(readFileSync(marker, "utf8")));
      const oldIds = recordIds(a.externalStore);
      const newIds = recordIds(a.vaultStore);
      a.use();
      // The resolver names the old root, and opening it refuses with the marker's path.
      expect(a.root()).toBe(a.externalStore);
      expect(pendingRelocation()).toBeNull();
      expect(() => openStore({ root: a.root(), device: "dev-a" })).toThrow(marker);
      expect(() => inspectStore(a.root())).toThrow(RelocatedStoreUnavailableError);
      // A handle opened before the move is refused the same way.
      expect(() => appendRecord(stale, EVENT)).toThrow(RelocatedStoreUnavailableError);
      // `store init` creates no store of another id beside it.
      expect(() => ensureBrainStore()).toThrow(RelocatedStoreUnavailableError);
      expect(recordIds(a.externalStore)).toEqual(oldIds);
      expect(recordIds(a.vaultStore)).toEqual(newIds);
    });
  }

  test("the session start, the status and the doctor name the marker", async () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    const marker = join(a.externalStore, STORE_RELOCATED_FILE);
    writeFileSync(marker, "{");
    a.use();
    const line = collectRuntimeNotices(a.vault, { oneTime: true }).find(
      (n) => n.code === "store_relocation_unreadable",
    );
    expect(line?.message).toContain(marker);
    expect(JSON.stringify(buildStoreStatusBlock({ vault: a.vault, configPath: null }))).toContain(
      STORE_RELOCATED_FILE,
    );
    expect(JSON.stringify(await runDoctor(a.vault))).toContain(STORE_RELOCATED_FILE);
  });
});

describe("the relocation lock as an append sees it", () => {
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a holder that cannot be examined counts as a relocation that runs",
    () => {
      scratch = mkdtempSync(join(tmpdir(), "osb-relocation-lock-"));
      const state = join(scratch, "state");
      mkdirSync(state);
      // No search permission: the holder file cannot be examined at all.
      chmodSync(state, 0o600);
      expect(relocationRunning(state)).toBe(true);
    },
  );
});
