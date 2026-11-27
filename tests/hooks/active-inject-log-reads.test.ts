/**
 * The session start hook on a store-only machine reads the store log once
 * (the dream digest notice, the active and the lessons digests share one
 * read), and a later session start trusts what this machine verified of
 * the store before (`src/core/store/verified-prefixes.ts`) with the same
 * injected context.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appendApplyEvidence } from "../../src/core/brain/apply-evidence.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { switchDevice } from "../core/brain/fixtures/memory-twins.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, "..", "..", "hooks", "active-inject.ts");
const PRELOAD = join(HERE, "fixtures", "record-log-reads-preload.ts");
// No detached worker (a reindex, a dream) outlives the test.
const SPAWNS = join(HERE, "fixtures", "record-spawns-preload.ts");

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

interface Counters {
  readonly log: { readonly storeReads: number; readonly cacheHits: number };
  readonly prefixes: { readonly trustedLines: number; readonly verifiedLines: number } | null;
}

let runs = 0;

async function runHook(e: StoreEnv): Promise<{ context: string; counters: Counters }> {
  runs += 1;
  const record = join(e.parent, `log-reads-${runs}.json`);
  const proc = Bun.spawn(["bun", "--preload", SPAWNS, "--preload", PRELOAD, HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
      RECORD_LOG_READS_TO: record,
      RECORD_SPAWNS_TO: join(e.parent, `spawns-${runs}.log`),
    },
  });
  proc.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect({ exit: await proc.exited, stderr }).toEqual({ exit: 0, stderr: "" });
  const context =
    stdout.trim() === ""
      ? ""
      : (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } })
          .hookSpecificOutput.additionalContext;
  return { context, counters: JSON.parse(readFileSync(record, "utf8")) as Counters };
}

function storeOnlyWithEvidence(): StoreEnv {
  const e = makeStoreEnv("osb-inject-log-reads-", { dualWrite: false });
  // Held before anything else can throw, so afterEach removes it.
  env = e;
  switchDevice(e);
  for (const slug of ["alpha", "beta"]) {
    writePreference(
      e.vault,
      {
        slug,
        topic: slug,
        principle: `principle ${slug}`,
        created_at: "2026-11-01T00:00:00Z",
        unconfirmed_until: "2026-11-08T00:00:00Z",
        status: "confirmed",
        evidenced_by: [],
      },
      { authority: "agent" },
    );
    appendApplyEvidence(e.vault, {
      pref_id: `pref-${slug}`,
      artifact: "[[notes/a]]",
      agent: "claude",
      result: "applied",
    });
  }
  return e;
}

describe("active-inject on a store-only machine", () => {
  test("reads the store log once per session start", async () => {
    storeOnlyWithEvidence();
    const e = env!;
    const first = await runHook(e);
    expect(first.context).toContain("principle alpha");
    expect(first.counters.log.storeReads).toBe(1);
    expect(first.counters.log.cacheHits).toBeGreaterThanOrEqual(2);
  });

  test("a later session start trusts the verified store and injects the same context", async () => {
    storeOnlyWithEvidence();
    const e = env!;
    const first = await runHook(e);
    const second = await runHook(e);
    expect(second.counters.log.storeReads).toBe(1);
    expect(second.counters.prefixes?.trustedLines ?? 0).toBeGreaterThan(0);
    expect(second.context).toBe(first.context);
  });
});
