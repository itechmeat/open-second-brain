/**
 * `brain_feedback` under the signal-lane review gate (write-side trust,
 * Task 6). The tool calls `writeSignal` without a target directory, so the
 * gate resolves at the chokepoint and the receipt reports it: `staged:
 * true` with `signal_path` under `Brain/pending/` when the signals lane is
 * on, `staged: false` and the historical inbox path when it is off. The
 * dedup consumption is identical on both sides of the gate - a retried
 * idempotency key still dedupes against the staged original.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { FEEDBACK_TOOLS } from "../../src/mcp/brain/feedback-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const MASTER_ENV = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_ENABLED";

let vault: string;
let configHome: string;
let ctx: ServerContext;
let savedMaster: string | undefined;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-feedback-staged-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-feedback-staged-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  if (savedMaster === undefined) delete process.env[MASTER_ENV];
  else process.env[MASTER_ENV] = savedMaster;
  savedMaster = undefined;
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function setGate(on: boolean): void {
  if (savedMaster === undefined) savedMaster = process.env[MASTER_ENV];
  if (on) process.env[MASTER_ENV] = "true";
  else delete process.env[MASTER_ENV];
}

const tool = FEEDBACK_TOOLS.find((t) => t.name === "brain_feedback");
const handler = tool!.handler;

const ARGS = {
  topic: "staged feedback",
  signal: "positive",
  principle: "the gate reports staging on the receipt",
};

function pendingFiles(): string[] {
  return readdirSync(brainDirs(vault).pending).filter((f) => f.endsWith(".md"));
}

describe("brain_feedback staged receipt", () => {
  test("gate off keeps the inbox path with staged false", async () => {
    setGate(false);
    const res = (await handler(ctx, ARGS)) as Record<string, unknown>;
    expect(res["staged"]).toBe(false);
    expect(String(res["signal_path"]).startsWith("Brain/inbox/")).toBe(true);
    // Bootstrap creates the pending directory eagerly; the gate-off call
    // leaves it empty and lands the signal in the inbox.
    expect(pendingFiles()).toEqual([]);
  });

  test("gate on stages the signal and reports pending_id-ready coordinates", async () => {
    setGate(true);
    const res = (await handler(ctx, ARGS)) as Record<string, unknown>;
    expect(res["staged"]).toBe(true);
    expect(String(res["signal_path"]).startsWith("Brain/pending/")).toBe(true);
    expect(pendingFiles()).toEqual([`${String(res["signal_id"])}.md`]);
    expect(String(res["path"]).startsWith("Brain/pending/")).toBe(true);
  });

  test("a retried idempotency key dedupes against the staged original", async () => {
    setGate(true);
    const first = (await handler(ctx, { ...ARGS, idempotency_key: "staged-retry-1" })) as Record<
      string,
      unknown
    >;
    expect(first["deduped"]).toBeUndefined();
    expect(first["staged"]).toBe(true);
    const second = (await handler(ctx, { ...ARGS, idempotency_key: "staged-retry-1" })) as Record<
      string,
      unknown
    >;
    expect(second["deduped"]).toBe(true);
    expect(second["staged"]).toBe(false);
    expect(second["signal_id"]).toBe(first["signal_id"]);
    // The retry consumed nothing: the queue still holds exactly the original.
    expect(pendingFiles()).toEqual([`${String(first["signal_id"])}.md`]);
  });
});
