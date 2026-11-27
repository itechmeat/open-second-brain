/**
 * Automatic dream on a machine whose store is in the vault (the default
 * with a vault since 2.0.1): the session start hook, run as the host runs
 * it, starts the dream worker on the owner's device once the previous day
 * is closed, and the worker records the new day. Open Second Brain 2.0.5
 * keyed the trigger by the store root resolved as if no vault were
 * configured, found no store there and started nothing, every day.
 *
 * One simulated machine (`fixtures/update-machine.ts`): its own HOME, XDG
 * folders, machine config naming the vault and no store root. The store,
 * the dream owner claim and the verified stub agent are set up in this
 * process as the machine; the trigger record is placed where the store
 * `o2b store path` names keeps it. The worker is real and detached; the
 * test waits, by file watches with a deadline (no timed sleep), for the
 * record to show the worker's day and for the worker to give its claim
 * back, then for every process carrying the scratch mark to end (Linux).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DreamAgentCommand } from "../../src/core/brain/dream-queue/agent-config.ts";
import { recordDreamAgentVerification } from "../../src/core/brain/dream-queue/agent-verified.ts";
import { assertDreamOwner } from "../../src/core/brain/dream-owner/gate.ts";
import { DREAM_RUN_CLAIM_FLAG } from "../../src/core/brain/dream-trigger/constants.ts";
import { dreamWorkerLogPath } from "../../src/core/brain/dream-trigger/due.ts";
import {
  dreamTriggerClaimPath,
  dreamTriggerRecordPath,
  emptyDreamTriggerRecord,
  parseDreamTriggerRecord,
  readDreamTriggerRecord,
  writeDreamTriggerRecord,
} from "../../src/core/brain/dream-trigger/record.ts";
import { ensureBrainStore } from "../../src/core/brain/init-store.ts";
import { isoDate } from "../../src/core/brain/time.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { SETTING_SET_KIND, STORE_VAULT_DIR } from "../../src/core/store/constants.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { markedProcessesEnded } from "../helpers/process-mark.ts";
import {
  logFinished,
  machine,
  REMOVE_SCRATCH_TIMEOUT_MS,
  removeScratch,
  runO2b,
  scratch,
  sessionStart,
  type Machine,
} from "./fixtures/update-machine.ts";

const DEVICE = "dev-vault-a";
const FAKE_AGENT = join(import.meta.dir, "..", "helpers", "fake-dream-agent.ts");
const AGENT: DreamAgentCommand = {
  label: "custom",
  preset: null,
  program: process.execPath,
  args: [FAKE_AGENT, "{mcp_config}", "answer-all", "{prompt}"],
};
/** How long the worker may take before the test gives up (a deadline, not a wait). */
const WORKER_DEADLINE_MS = 90_000;

/** The keys this process takes from the machine while it sets the machine up. */
const PINNED = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "LOCALAPPDATA",
  "APPDATA",
  "OPEN_SECOND_BRAIN_CONFIG",
  "OPEN_SECOND_BRAIN_STORE_ROOT",
  "O2B_DEVICE_ID",
  "VAULT_DIR",
] as const;

function asMachine<T>(m: Machine, fn: () => T): T {
  const saved = PINNED.map((k) => [k, process.env[k]] as const);
  for (const k of PINNED) {
    const value = m.env[k];
    if (value === undefined || value === "") delete process.env[k];
    else process.env[k] = value;
  }
  // From the machine's vault, so a project pointer of this checkout names nothing.
  const cwd = process.cwd();
  process.chdir(m.vault);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The dream worker's log in the store's device-local state on `m`. */
function workerLog(m: Machine, storeRoot: string): string {
  return asMachine(m, () => dreamWorkerLogPath(openStore({ root: storeRoot, device: DEVICE })));
}

let parent: string | null = null;

afterEach(async () => {
  await removeScratch(parent);
  parent = null;
}, REMOVE_SCRATCH_TIMEOUT_MS);

interface Owned {
  readonly m: Machine;
  readonly storeRoot: string;
  readonly recordPath: string;
  readonly yesterday: string;
  readonly today: string;
}

/**
 * A machine with a vault, its store in the vault's folder, this device the
 * dream owner, the stub agent verified, automatic dream on, and the
 * previous UTC day closed in the trigger record.
 */
async function ownedMachine(): Promise<Owned> {
  parent = scratch("osb-dream-auto-vault-");
  const seed = join(parent, "seed-vault");
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, "note.md"), "# A note\n");
  const m = machine(parent, "a", seed, DEVICE);
  // Automatic dream at its default (on); the agent the worker launches.
  m.env["OPEN_SECOND_BRAIN_DREAM_AUTO"] = "";
  // A host `VAULT_DIR` must not reach the children: the machine's config names the vault.
  m.env["VAULT_DIR"] = "";
  m.env["OPEN_SECOND_BRAIN_DREAM_AGENT_COMMAND"] = JSON.stringify([AGENT.program, ...AGENT.args]);
  const configPath = m.env["OPEN_SECOND_BRAIN_CONFIG"]!;

  asMachine(m, () => {
    const created = ensureBrainStore({ configPath, dreamOwnerFor: { vault: m.vault } });
    expect(created.root).toBe(join(m.vault, STORE_VAULT_DIR));
    try {
      assertDreamOwner(m.vault, { live: true, configPath });
    } catch {
      // the first look notes the claim
    }
    recordDreamAgentVerification(AGENT, {
      agent: AGENT.label,
      model: "fake-model-1",
      programVersion: null,
    });
  });

  // Where the product says the store is: the trigger's record is keyed by it.
  const shown = await runO2b(m, ["store", "path", "--json"]);
  expect(shown.code).toBe(0);
  const storeRoot = (JSON.parse(shown.stdout) as { root: { path: string } }).root.path;
  expect(storeRoot).toBe(join(m.vault, STORE_VAULT_DIR));

  const now = Date.now();
  const today = isoDate(new Date(now));
  const yesterday = isoDate(new Date(now - 86_400_000));
  const recordPath = asMachine(m, () => dreamTriggerRecordPath(storeRoot));
  writeDreamTriggerRecord(recordPath, {
    ...emptyDreamTriggerRecord(storeRoot),
    day: yesterday,
    closed: true,
    last_run: {
      started_at: new Date(now - 86_400_000).toISOString(),
      ended_at: new Date(now - 86_400_000 + 60_000).toISOString(),
      outcome: "complete",
      by: "worker",
    },
  });
  return { m, storeRoot, recordPath, yesterday, today };
}

describe("automatic dream with the store in the vault", () => {
  test(
    "a session start on a new day starts the worker, and the day is recorded",
    async () => {
      const { m, storeRoot, recordPath, today } = await ownedMachine();
      await sessionStart(m, "run");
      // The worker records its day, then gives its claim back.
      await logFinished(recordPath, (text) => {
        const r = text === "" ? null : parseDreamTriggerRecord(text);
        return r !== null && r.day === today && r.last_run?.ended_at != null;
      });
      await logFinished(dreamTriggerClaimPath(recordPath), (text) => text === "");
      await markedProcessesEnded(parent!, WORKER_DEADLINE_MS);
      expect(existsSync(workerLog(m, storeRoot))).toBe(true);
      const after = readDreamTriggerRecord(recordPath, storeRoot);
      expect(after).not.toBeNull();
      expect(after!.day).toBe(today);
      expect(after!.last_run).toMatchObject({ by: "worker" });
      expect(after!.last_run!.ended_at).not.toBeNull();
      expect(after!.closed).toBe(true);
      expect(after!.owner).toMatchObject({ device: DEVICE, mine: true });
    },
    WORKER_DEADLINE_MS + 30_000,
  );

  test(
    "with automatic dream off, a session start starts nothing",
    async () => {
      const { m, storeRoot, recordPath, yesterday } = await ownedMachine();
      asMachine(m, () => {
        appendRecord(openStore({ root: storeRoot, device: DEVICE }), {
          partition: "shared",
          stream: "settings",
          kind: SETTING_SET_KIND,
          agent: "o2b",
          body: { authority: "human", key: "dream.auto", value: false },
        });
      });
      // Spawns recorded, not run: the hook's other detached work (the index
      // rebuild) would outlive the test, and on Windows, where marked
      // processes cannot be found, hold the scratch open at its removal.
      await sessionStart(m, "record");
      const log = join(m.root, "spawns.log");
      const spawned = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(spawned).not.toContain(JSON.stringify(DREAM_RUN_CLAIM_FLAG));
      expect(existsSync(workerLog(m, storeRoot))).toBe(false);
      const after = readDreamTriggerRecord(recordPath, storeRoot);
      expect(after).not.toBeNull();
      expect(after!.day).toBe(yesterday);
      expect(after!.auto).toBe(false);
    },
    WORKER_DEADLINE_MS + 30_000,
  );
});
