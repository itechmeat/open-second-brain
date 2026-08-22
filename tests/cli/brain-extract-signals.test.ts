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
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTO_EXTRACT_PER_SESSION_CAP } from "../../src/core/brain/extract-signals.ts";
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
