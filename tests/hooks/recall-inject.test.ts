import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hookAuditDir } from "../../src/core/brain/paths.ts";
import {
  isRecallInjectFault,
  RECALL_INJECT_FAULT,
  RECALL_INJECT_FAULTS,
  recallInjectAuditDetails,
  recallInjectTelemetryMetadata,
  type RecallInjectDecision,
} from "../../src/core/brain/recall-inject.ts";
import { listRecallTelemetry, RECALL_CHANNEL } from "../../src/core/brain/recall-telemetry.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "recall-inject.ts",
);

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hook-recall-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hook-recall-cfg-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: configHome,
  };
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, stderr, exit };
}

function auditRecords(): Array<Record<string, unknown>> {
  const dir = hookAuditDir(vault);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
}

describe("recall-inject hook", () => {
  test("flag off (default) is a silent no-op: no stdout, no audit", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "how do receipts work" },
      { VAULT_DIR: vault },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(auditRecords()).toHaveLength(0);
  });

  test("flag on stays fail-open and audits a decision on an empty vault", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "how do receipts work" },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    // Nothing to recall in a bare vault, so the hook abstains and injects nothing.
    expect(r.stdout).toBe("");
    const records = auditRecords();
    expect(records.length).toBeGreaterThanOrEqual(1);
    const record = records.find((rec) => rec["actor"] === "recall-inject");
    expect(record).toBeDefined();
    const details = (record?.["details"] ?? {}) as Record<string, unknown>;
    expect(["inject", "abstain", "error"]).toContain(details["decision"] as string);
  });

  test("flag on stays silent when the vault cannot be resolved", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "receipts" },
      {
        OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true",
      },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("flag on abstains without stdout on an empty prompt", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "   " },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    const record = auditRecords().find((rec) => rec["actor"] === "recall-inject");
    const details = (record?.["details"] ?? {}) as Record<string, unknown>;
    expect(details["decision"]).toBe("abstain");
    expect(details["reason"]).toBe("empty_prompt");
  });
});

describe("recall-inject telemetry", () => {
  test("the flag-off no-op writes no telemetry, exactly as it writes no audit", async () => {
    await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "how do receipts work" },
      { VAULT_DIR: vault },
    );
    expect(listRecallTelemetry(vault, { channel: RECALL_CHANNEL.hook })).toHaveLength(0);
  });

  test("an abstain is recorded as an empty delivery, not as no delivery", async () => {
    // The whole point of the channel dimension: a hook that ran and
    // decided not to inject must be distinguishable from a hook that was
    // never installed. Emitting nothing here would destroy that.
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "   " },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");

    const records = listRecallTelemetry(vault, { channel: RECALL_CHANNEL.hook });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({
      channel: RECALL_CHANNEL.hook,
      status: "empty",
      result_count: 0,
      metadata: { decision: "abstain", reason: "empty_prompt" },
    });
  });

  test("an error's telemetry metadata carries a classification, never the retriever's message", () => {
    // `errorReason()` used to hand the raw `Error.message` straight to the
    // telemetry metadata, and `brain_recall_telemetry` returns those
    // records verbatim to a model. A SQLite, store or config failure names
    // the index file or the config path, and the shared redactor removes
    // secret-shaped tokens, not paths.
    const decision: RecallInjectDecision = {
      kind: "error",
      fault: RECALL_INJECT_FAULT.retrieverFailed,
      detail:
        "cannot read schema_version from /home/operator/vault/.open-second-brain/brain.sqlite: " +
        "disk I/O error",
    };
    const metadata = recallInjectTelemetryMetadata(decision);
    expect(metadata).toEqual({ decision: "error", fault: RECALL_INJECT_FAULT.retrieverFailed });
    expect(JSON.stringify(metadata)).not.toContain("brain.sqlite");
    expect(JSON.stringify(metadata)).not.toContain("/home/operator");
  });

  test("the local audit line keeps the message, because that file never leaves the machine", () => {
    const decision: RecallInjectDecision = {
      kind: "error",
      fault: RECALL_INJECT_FAULT.retrieverFailed,
      detail:
        "cannot read schema_version from /home/operator/vault/.open-second-brain/brain.sqlite",
    };
    const details = recallInjectAuditDetails(decision);
    expect(details["fault"]).toBe(RECALL_INJECT_FAULT.retrieverFailed);
    expect(String(details["detail"])).toContain("brain.sqlite");
  });

  test("the two projections agree wherever nothing is being withheld", () => {
    const decisions: ReadonlyArray<RecallInjectDecision> = [
      { kind: "inject", brief: "a fenced brief", noteCount: 2, topScore: 0.9 },
      { kind: "abstain", reason: "empty_prompt", topScore: 0 },
      { kind: "error", fault: RECALL_INJECT_FAULT.timeout },
    ];
    for (const decision of decisions) {
      expect(recallInjectAuditDetails(decision), decision.kind).toEqual(
        recallInjectTelemetryMetadata(decision) as Record<string, unknown>,
      );
    }
  });

  test("every fault a decision can carry is a member of the closed vocabulary", () => {
    for (const fault of RECALL_INJECT_FAULTS) expect(isRecallInjectFault(fault)).toBe(true);
    expect(isRecallInjectFault("a retriever sentence about /var/lib")).toBe(false);
  });

  test("a decision on a bare vault reaches the hook channel with a mapped status", async () => {
    await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "how do receipts work" },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true" },
    );
    const records = listRecallTelemetry(vault, { channel: RECALL_CHANNEL.hook });
    expect(records).toHaveLength(1);
    const payload = records[0]!.payload;
    expect(payload["mode"]).toBe("search");
    // inject -> ok, abstain -> empty, error -> error. Nothing else.
    expect(["ok", "empty", "error"]).toContain(payload["status"] as string);
  });
});
