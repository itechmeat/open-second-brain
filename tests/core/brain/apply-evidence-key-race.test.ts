/**
 * Concurrent keyed evidence on a switched machine (review finding R2A-1):
 * processes applying the same idempotency key at once count it once. The
 * fold counts evidence records by occurrence, so a caller that missed the
 * consult and wrote its record before losing the key race would add a
 * second application. The children are real `bun` processes started at a
 * shared instant, the discipline of `pinned-concurrency.test.ts`.
 */

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { writePreference } from "../../../src/core/brain/preference.ts";
import { readPreferences } from "../../../src/core/store/read/preferences.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

const WRITERS = 4;
const KEYS = 12;
const SPAWN_TIMEOUT_MS = 60_000;
/** Children spin until a shared instant so their applies really overlap. */
const BARRIER_LEAD_MS = 1_500;

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test(
  "the same key applied by concurrent processes counts once",
  async () => {
    env = makeStoreEnv("osb-evidence-race-", { dualWrite: false });
    switchDevice(env.storeRoot);
    writePreference(
      env.vault,
      {
        slug: "race",
        topic: "race",
        principle: "principle race",
        created_at: "2026-11-01T00:00:00Z",
        unconfirmed_until: "2026-11-30T00:00:00Z",
        status: "unconfirmed",
        evidenced_by: [],
      },
      { authority: "agent" },
    );
    const script = join(env.vault, "..", "evidence-writer.ts");
    const module = join(import.meta.dir, "../../../src/core/brain/apply-evidence.ts");
    writeFileSync(
      script,
      [
        `import { appendApplyEvidence } from ${JSON.stringify(module)};`,
        "const [vault, keys, startAt] = process.argv.slice(2);",
        "while (Date.now() < Number(startAt)) Bun.sleepSync(1);",
        "for (let k = 0; k < Number(keys); k++) {",
        "  appendApplyEvidence(vault, { pref_id: 'race', artifact: `[[work-${k}]]`,",
        "    result: 'applied', agent: 'tester', idempotency_key: `key-${k}` });",
        "}",
      ].join("\n"),
      "utf8",
    );
    const startAt = String(Date.now() + BARRIER_LEAD_MS);
    const procs = Array.from({ length: WRITERS }, () =>
      Bun.spawn([process.execPath, script, env!.vault, String(KEYS), startAt], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      }),
    );
    const failures: string[] = [];
    await Promise.all(
      procs.map(async (proc) => {
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        if (code !== 0) failures.push(`exit ${code}: ${err.trim()}`);
      }),
    );
    expect(failures).toEqual([]);
    const race = readPreferences({ vault: env.vault }).find((p) => p.id === "pref-race");
    expect(race?.counters.applied_count).toBe(KEYS);
  },
  SPAWN_TIMEOUT_MS,
);
