/**
 * `o2b brain extract-signals` CLI surface (salience-lifecycle-enrichment,
 * unit 2, t_1dace26d). Claims pinned here:
 *
 *  1. The plan phase's `--json` payload carries the mined turns, the two
 *     limits, and exactly one needs-llm-step envelope.
 *  2. The commit phase's `--json` payload names what it wrote.
 *  3. A refused payload exits 1 and carries the refusal in `--json` under
 *     `ok: false` - never a stack trace and never a zero exit.
 *  4. A missing session reference is a usage error (exit 2).
 *  5. The verb has its own `--help`, not a dump of the whole brain help.
 *  6. A commit that lands nothing tombstones the session, and the next
 *     plan names it with the recorded breakdown; --force bypasses the
 *     tombstone for exactly one plan call.
 *  7. A ledger write failure on a successful commit exits 0 and names the
 *     failure, in --json and in text.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AUTO_EXTRACT_PER_SESSION_CAP } from "../../src/core/brain/extract-signals.ts";
import { sessionMiningLedgerPath } from "../../src/core/brain/session-mining-ledger.ts";
import { importSessionRecall } from "../../src/core/brain/session-recall.ts";
import { runCli } from "../helpers/run-cli.ts";

const SESSION = "sess-cli";
let tmp: string;
let vault: string;
let configPath: string;

const ITEM = {
  topic: "heading-style",
  signal: "positive",
  principle: "Name the release theme in the heading.",
  confidence: 0.91,
};

function run(args: ReadonlyArray<string>) {
  return runCli(["brain", "extract-signals", ...args, "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-extract-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  importSessionRecall(vault, {
    sessionId: SESSION,
    turns: [
      {
        turnId: "t1",
        timestamp: "2026-08-22T09:01:00Z",
        role: "user",
        text: "Always name the release theme in the heading.",
      },
    ],
    createdAt: "2026-08-22T10:00:00Z",
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("the plan phase --json carries the turns, the limits, and one envelope", async () => {
  const r = await run([SESSION, "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    ok: boolean;
    session_id: string;
    turns_mined: Array<{ turn_id: string; text: string }>;
    cap: number;
    confidence_floor: number;
    llm_step: { status: string; step: string; target_path: string };
  };
  expect(payload.ok).toBe(true);
  expect(payload.session_id).toBe(SESSION);
  expect(payload.turns_mined.map((t) => t.turn_id)).toEqual(["t1"]);
  expect(payload.cap).toBe(AUTO_EXTRACT_PER_SESSION_CAP);
  expect(payload.confidence_floor).toBeGreaterThan(0);
  expect(payload.llm_step.status).toBe("needs-llm-step");
  expect(payload.llm_step.target_path).toBe("Brain/inbox");
});

test("the commit phase --json names what it wrote", async () => {
  const r = await run([SESSION, "--payload", JSON.stringify({ items: [ITEM] }), "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    ok: boolean;
    written: Array<{ id: string; path: string; topic: string }>;
    staged: number;
    deduped: number;
    durability_rejected: number;
  };
  expect(payload.ok).toBe(true);
  expect(payload.written.map((w) => w.topic)).toEqual(["heading-style"]);
  expect(payload.staged).toBe(0);
  expect(payload.deduped).toBe(0);
  expect(payload.durability_rejected).toBe(0);
});

test("a refused payload exits 1 and names the limit in --json", async () => {
  const items = Array.from({ length: AUTO_EXTRACT_PER_SESSION_CAP + 1 }, (_v, i) => ({
    ...ITEM,
    topic: `topic-${i}`,
  }));
  const r = await run([SESSION, "--payload", JSON.stringify({ items }), "--json"]);
  expect(r.returncode).toBe(1);
  const payload = JSON.parse(r.stdout) as { ok: boolean; message: string };
  expect(payload.ok).toBe(false);
  expect(payload.message).toContain(String(AUTO_EXTRACT_PER_SESSION_CAP));
});

test("an unimported session is refused by name, not reported as empty", async () => {
  const r = await run(["sess-nowhere", "--json"]);
  expect(r.returncode).toBe(1);
  const payload = JSON.parse(r.stdout) as { ok: boolean; message: string };
  expect(payload.ok).toBe(false);
  expect(payload.message).toContain("sess-nowhere");
});

test("a missing session reference is a usage error", async () => {
  const r = await run([]);
  expect(r.returncode).toBe(2);
  expect(r.stderr).toContain("o2b brain extract-signals");
});

test("--help prints the verb's own usage", async () => {
  const r = await runCli(["brain", "extract-signals", "--help"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(r.returncode).toBe(0);
  expect(r.stdout.startsWith("usage:")).toBe(true);
  expect(r.stdout).toContain("o2b brain extract-signals");
});

describe("think-block strip (t_dac8bf7e)", () => {
  test("a <think>-prefixed payload succeeds, names the strip, and writes the clean case's items", async () => {
    const r = await run([
      SESSION,
      "--payload",
      `<think>weighing the turns</think>${JSON.stringify({ items: [ITEM] })}`,
      "--json",
    ]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      note?: string;
      written: Array<{ id: string; topic: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.note).toContain("<think>");
    // Identical to the clean case's pinned written items.
    expect(payload.written.map((w) => w.topic)).toEqual(["heading-style"]);
  });

  test("text mode names the strip too - never a silent strip", async () => {
    const r = await run([
      SESSION,
      "--payload",
      `<think>weighing the turns</think>${JSON.stringify({ items: [ITEM] })}`,
    ]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("<think>");
  });

  test("garbage still exits 1 with the plain ok:false refusal", async () => {
    const r = await run([SESSION, "--payload", "not json", "--json"]);
    expect(r.returncode).toBe(1);
    const payload = JSON.parse(r.stdout) as { ok: boolean; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.message).toBe("payload must be valid JSON");
  });

  test("a payload that still does not parse after the strip names the attempt and exits 1", async () => {
    const r = await run([SESSION, "--payload", "<think>r</think>not json", "--json"]);
    expect(r.returncode).toBe(1);
    const payload = JSON.parse(r.stdout) as { ok: boolean; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain("<think>");
  });

  test("a clean payload's --json output carries no note key", async () => {
    const r = await run([SESSION, "--payload", JSON.stringify({ items: [ITEM] }), "--json"]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as Record<string, unknown>;
    expect("note" in payload).toBe(false);
  });
});

// ----- The zero-yield mining tombstone on the surface ------------------------
//
//  6. A commit that lands nothing tombstones the session - keyed on the
//     surveyed hash the plan printed, which the commit relays back - and
//     the next plan says so by name with the recorded breakdown, in --json
//     and in text, instead of re-offering the same turns. A commit that
//     answers no plan records nothing, so the session stays eligible.
//  7. --force bypasses the tombstone for exactly one plan call: the forced
//     plan carries the envelope, and the plan after it is suppressed again.
//  8. A ledger write failure on a successful commit exits 0 and names the
//     failure in --json and in text - never a throw, never a silent drop.

function corruptMiningLedger(): void {
  mkdirSync(dirname(sessionMiningLedgerPath(vault)), { recursive: true });
  writeFileSync(sessionMiningLedgerPath(vault), "{ truncated");
}

/** The plan's surveyed hash, from the --json plan phase. */
async function surveyedHash(): Promise<string> {
  const r = await run([SESSION, "--json"]);
  expect(r.returncode).toBe(0);
  return (JSON.parse(r.stdout) as { surveyed_turns_hash: string }).surveyed_turns_hash;
}

describe("mining tombstone", () => {
  test("a barren commit tombstones the session and the next plan names it", async () => {
    const hash = await surveyedHash();
    const mine = await run([
      SESSION,
      "--payload",
      JSON.stringify({ items: [] }),
      "--surveyed-turns-hash",
      hash,
      "--json",
    ]);
    expect(mine.returncode).toBe(0);
    const r = await run([SESSION, "--json"]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      llm_step: unknown;
      turns_mined: unknown[];
      skipped?: {
        reason: string;
        mining_outcome?: {
          written: number;
          staged: number;
          deduped: number;
          durability_rejected: number;
        };
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.skipped?.reason).toBe("mining_tombstone");
    expect(payload.skipped?.mining_outcome).toEqual({
      written: 0,
      staged: 0,
      deduped: 0,
      durability_rejected: 0,
    });
    expect(payload.llm_step).toBeNull();
    expect(payload.turns_mined).toEqual([]);
  });

  test("a barren commit without the surveyed hash records nothing and fails open", async () => {
    // The relay is what makes the tombstone honest: without it the commit
    // has no material to key on, records nothing, and the session stays
    // eligible - never suppressed on unverified evidence.
    const mine = await run([SESSION, "--payload", JSON.stringify({ items: [] }), "--json"]);
    expect(mine.returncode).toBe(0);
    const r = await run([SESSION, "--json"]);
    const payload = JSON.parse(r.stdout) as { skipped?: unknown };
    expect(payload.skipped).toBeUndefined();
  });

  test("text mode names the tombstone and the force escape", async () => {
    const hash = await surveyedHash();
    await run([SESSION, "--payload", JSON.stringify({ items: [] }), "--surveyed-turns-hash", hash]);
    const r = await run([SESSION]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("already mined");
    expect(r.stdout).toContain("--force");
    // The evidence rides the line too, not just the verdict.
    expect(r.stdout).toMatch(/deduped 0/);
  });

  test("the text line renders the recorded breakdown, field for field", async () => {
    // A first yield, then a re-mine of the same payload where the only
    // item dedups: the recorded outcome is written 0, staged 0, deduped 1,
    // and the suppressed plan's text line must read exactly that - the
    // same numbers the --json surface prints for the same record.
    const hash = await surveyedHash();
    await run([
      SESSION,
      "--payload",
      JSON.stringify({ items: [ITEM] }),
      "--surveyed-turns-hash",
      hash,
      "--json",
    ]);
    await run([
      SESSION,
      "--payload",
      JSON.stringify({ items: [ITEM] }),
      "--surveyed-turns-hash",
      hash,
      "--json",
    ]);
    const r = await run([SESSION]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(
      "yielded nothing (written 0, staged 0, deduped 1, durability-rejected 0)",
    );
  });

  test("--force bypasses the tombstone for exactly one plan call", async () => {
    const hash = await surveyedHash();
    await run([
      SESSION,
      "--payload",
      JSON.stringify({ items: [] }),
      "--surveyed-turns-hash",
      hash,
      "--json",
    ]);
    const forced = await run([SESSION, "--force", "--json"]);
    expect(forced.returncode).toBe(0);
    const forcedPayload = JSON.parse(forced.stdout) as {
      llm_step: { status: string } | null;
      skipped?: unknown;
    };
    expect(forcedPayload.skipped).toBeUndefined();
    expect(forcedPayload.llm_step?.status).toBe("needs-llm-step");
    // The bypass is per call: the next unforced plan is suppressed again.
    const after = await run([SESSION, "--json"]);
    const afterPayload = JSON.parse(after.stdout) as { skipped?: { reason: string } };
    expect(afterPayload.skipped?.reason).toBe("mining_tombstone");
  });

  test("a yielding commit records its outcome and the session stays minable", async () => {
    // The distilled state rides the same record the tombstone does: the
    // yield is the census's evidence, not a suppression, so the next plan
    // still offers the session.
    const hash = await surveyedHash();
    const mine = await run([
      SESSION,
      "--payload",
      JSON.stringify({ items: [ITEM] }),
      "--surveyed-turns-hash",
      hash,
      "--json",
    ]);
    expect(mine.returncode).toBe(0);
    const ledger = JSON.parse(readFileSync(sessionMiningLedgerPath(vault), "utf8")) as {
      entries: Record<
        string,
        {
          outcome: { written: number; staged: number; deduped: number; durabilityRejected: number };
        }
      >;
    };
    expect(ledger.entries[SESSION]?.outcome).toEqual({
      written: 1,
      staged: 0,
      deduped: 0,
      durabilityRejected: 0,
    });
    const r = await run([SESSION, "--json"]);
    expect(r.returncode).toBe(0);
    expect((JSON.parse(r.stdout) as { skipped?: unknown }).skipped).toBeUndefined();
  });

  test("a ledger write failure on a successful commit exits 0 and names the failure", async () => {
    const hash = await surveyedHash();
    corruptMiningLedger();
    const mine = await run([
      SESSION,
      "--payload",
      JSON.stringify({ items: [] }),
      "--surveyed-turns-hash",
      hash,
      "--json",
    ]);
    expect(mine.returncode).toBe(0);
    const payload = JSON.parse(mine.stdout) as { ok: boolean; mining_ledger_failure?: string };
    expect(payload.ok).toBe(true);
    expect(payload.mining_ledger_failure).toContain("session mining ledger is corrupted JSON");

    // Text mode names it too, on the same exit code (this commit relays
    // the hash as well, so the record attempt happens here too).
    const text = await run([
      SESSION,
      "--payload",
      JSON.stringify({ items: [] }),
      "--surveyed-turns-hash",
      hash,
    ]);
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("mining ledger");
  });
});
