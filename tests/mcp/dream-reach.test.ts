/**
 * `brain_dream` answers at the caller's reach.
 *
 * Vault A of tests/helpers/reach-log-fixture.ts holds a preference and a
 * retired record withheld from a remote caller by visibility; here it also
 * holds three withheld inbox signals on a topic of their own. Vault B
 * never had any of them. Both hold the same readable preference and three
 * readable signals on a public topic. A server with no reach minted is a
 * remote caller: its dry run must plan as if the withheld records were
 * absent, and a real pass, a single step and the staged lifecycle are
 * refused with one fixed answer and leave every vault file unchanged. The
 * local control proves the withheld records are there to plan over.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSignal } from "../../src/core/brain/signal.ts";
import { BRAIN_SIGNAL_SIGN } from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  PRIVATE_SLUG,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_dream";
const PUBLIC_TOPIC = "public-topic";
const WITHHELD_TOPIC = "withheld-topic";
const AGENTS = ["claude", "codex", "hermes"] as const;
const REFUSAL = "run at local reach only";
const MINUTE_MS = 60_000;
/** The clock suffix of a run id: two passes moments apart differ only there. */
const RUN_CLOCK_RE = /(dream-<T>)-\d{6}/g;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function reserveFile(abs: string): void {
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(
    abs,
    `${text.slice(0, close)}\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]${text.slice(close)}`,
  );
}

/** Three same-sign signals from three agents: enough for a new preference. */
function seedCluster(vault: string, topic: string): ReadonlyArray<string> {
  // Recent captures, so the pass plans over them instead of archiving them.
  const now = Date.now();
  return AGENTS.map((agent, i) => {
    const at = new Date(now - (i + 1) * MINUTE_MS).toISOString();
    return writeSignal(vault, {
      topic,
      signal: BRAIN_SIGNAL_SIGN.positive,
      agent,
      principle: `Always follow the ${topic} rule.`,
      created_at: `${at.slice(0, 19)}Z`,
      date: at.slice(0, 10),
      slug: topic,
    }).path;
  });
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-dream-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  seedCluster(f.vault, PUBLIC_TOPIC);
  if (withPrivate) for (const path of seedCluster(f.vault, WITHHELD_TOPIC)) reserveFile(path);
  return f;
}

async function answer(
  f: Fixture,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<string> {
  try {
    const result = await reachServer(f, reach).callTool(TOOL, args);
    return maskVolatile(f, result["structuredContent"] ?? result).replace(RUN_CLOCK_RE, "$1");
  } catch (error) {
    // A refusal is part of the answer: it must read alike over both vaults.
    return maskVolatile(f, { error: (error as Error).message });
  }
}

/** Every file under the vault with its bytes, so any write shows. */
function vaultBytes(f: Fixture): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(f.vault, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    out[abs] = readFileSync(abs, "utf8");
  }
  return out;
}

const DRY_RUN = { action: "run", dry_run: true };

describe("brain_dream answers at the caller's reach", () => {
  test("remote reach: a dry run plans as if the withheld records were absent", async () => {
    const a = fixture(true);
    const before = vaultBytes(a);
    const withheld = await answer(a, DRY_RUN);
    expect(withheld).toBe(await answer(fixture(false), DRY_RUN));
    expect(withheld).toContain(PUBLIC_TOPIC);
    expect(withheld).not.toContain(WITHHELD_TOPIC);
    expect(withheld).not.toContain(PRIVATE_SLUG);
    expect(vaultBytes(a)).toEqual(before);
  });

  const REFUSED: ReadonlyArray<Record<string, unknown>> = [
    {},
    { action: "run" },
    { action: "run", dry_run: true, step: "scan" },
    { action: "run", step: "scan" },
    { action: "stage" },
    { action: "list" },
    { action: "validate", run_id: "run-1" },
    { action: "apply", run_id: "run-1" },
    { action: "retriage", run_id: "run-1" },
    { action: "discard", run_id: "run-1" },
  ];
  for (const args of REFUSED) {
    test(`remote reach: ${JSON.stringify(args)} is refused and writes nothing`, async () => {
      const a = fixture(true);
      const before = vaultBytes(a);
      const withheld = await answer(a, args);
      expect(withheld).toBe(await answer(fixture(false), args));
      expect(withheld).toContain(REFUSAL);
      expect(vaultBytes(a)).toEqual(before);
    });
  }

  test("local control: the operator's dry run plans over the withheld records", async () => {
    const local = await answer(fixture(true), DRY_RUN, TRANSPORT_REACH.local);
    expect(local).toContain(WITHHELD_TOPIC);
  });

  test("local control: the operator's real pass still runs", async () => {
    const local = await answer(fixture(true), { action: "run" }, TRANSPORT_REACH.local);
    expect(local).not.toContain(REFUSAL);
    expect(local).toContain(`pref-${WITHHELD_TOPIC}`);
  });
});
