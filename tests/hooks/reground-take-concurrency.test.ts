/**
 * Exactly-once delivery of queued re-grounding parts across concurrent hook
 * processes: the property the per-scope advisory lock exists for. Each child
 * is a separate bun process racing `takeRegroundPart` on one seeded queue.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LEDGER_KEY_REGROUND, beginInjectionEpoch } from "../../hooks/lib/injection-ledger.ts";
import {
  HOOK_STATE_STALE_LOCK_MS,
  hookStateFilePath,
  readHookStamp,
} from "../../hooks/lib/session-state.ts";

const LEDGER_MODULE = resolve(import.meta.dir, "../../hooks/lib/injection-ledger.ts");
const SESSION = "race-session";
const CHILDREN = 6;
/** Seven queued parts: the most a split can queue (8 parts, part 1 emitted). */
const QUEUED = ["p2", "p3", "p4", "p5", "p6", "p7", "p8"];
const NOW = Date.now();

/**
 * Each child spins until a shared start time, then takes until the queue is
 * empty (a busy take retries), and prints the indices it received.
 */
const CHILD_SCRIPT = `
const { takeRegroundPart } = await import(process.env.LEDGER_MODULE);
const [vault, session, now, startAt] = process.argv.slice(-4);
while (Date.now() < Number(startAt)) {}
const got = [];
for (let i = 0; i < 2000; i++) {
  const take = takeRegroundPart(vault, session, Number(now));
  if (take.status === "part") got.push(take.index);
  else if (take.status === "empty") break;
}
console.log(JSON.stringify(got));
`;

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-reground-race-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

async function race(): Promise<number[]> {
  const startAt = Date.now() + 1500;
  const children = Array.from({ length: CHILDREN }, () =>
    Bun.spawn(
      [process.execPath, "-e", CHILD_SCRIPT, vault, SESSION, String(NOW), String(startAt)],
      { env: { ...process.env, LEDGER_MODULE }, stdout: "pipe", stderr: "pipe" },
    ),
  );
  const outputs = await Promise.all(
    children.map(async (child) => {
      const text = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return JSON.parse(text.trim()) as number[];
    }),
  );
  return outputs.flat();
}

function expectExactlyOnce(delivered: number[]): void {
  expect(new Set(delivered).size).toBe(delivered.length);
  const queue = readHookStamp(vault, SESSION, LEDGER_KEY_REGROUND, NOW);
  const next = typeof queue?.data?.["next"] === "number" ? queue.data["next"] : QUEUED.length;
  const stillQueued = QUEUED.slice(next).map((_, i) => next + i + 2);
  expect([...delivered, ...stillQueued].toSorted((a, b) => a - b)).toEqual(
    QUEUED.map((_, i) => i + 2),
  );
}

function seed(): void {
  expect(
    beginInjectionEpoch(
      vault,
      SESSION,
      { epoch: "ep-race", emittedPaths: [], regroundParts: QUEUED, partCeilingChars: 9000 },
      NOW,
    ),
  ).toBe(true);
}

describe("takeRegroundPart across processes", () => {
  test("concurrent takers never receive the same part", async () => {
    seed();
    expectExactlyOnce(await race());
  }, 30_000);

  test("concurrent takers racing a stale-lock takeover never receive the same part", async () => {
    seed();
    const lockPath = hookStateFilePath(vault, SESSION) + ".lock";
    writeFileSync(lockPath, "left behind by a killed hook\n");
    const old = (Date.now() - HOOK_STATE_STALE_LOCK_MS - 5_000) / 1000;
    utimesSync(lockPath, old, old);
    expectExactlyOnce(await race());
  }, 30_000);
});
