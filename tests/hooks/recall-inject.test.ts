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

  test("the telemetry projection carries the whole decision, match quality included", () => {
    // Asserted against literals rather than against the other projection.
    // Comparing the two proves nothing: `recallInjectAuditDetails` RETURNS
    // the telemetry object unchanged except on `error` with a `detail`, so
    // over these three fixtures the comparison is an identity, and every
    // field could be deleted from both with the test still green.
    // `match_quality` is the field that reaches the synced continuity log
    // and `brain_recall_telemetry`, so it is the one that needs naming.
    expect(
      recallInjectTelemetryMetadata({
        kind: "inject",
        brief: "a fenced brief",
        noteCount: 2,
        topScore: 0.9,
        matchQuality: 0.8,
      }),
    ).toEqual({ decision: "inject", note_count: 2, top_score: 0.9, match_quality: 0.8 });
    expect(
      recallInjectTelemetryMetadata({
        kind: "abstain",
        reason: "below_floor",
        topScore: 0.65,
        matchQuality: 0.2,
      }),
    ).toEqual({
      decision: "abstain",
      reason: "below_floor",
      top_score: 0.65,
      match_quality: 0.2,
    });
    // An unmeasurable quality travels as null, not as a substituted
    // number: the log must be able to say "there was no measurement".
    expect(
      recallInjectTelemetryMetadata({
        kind: "abstain",
        reason: "unmeasurable_quality",
        topScore: 0.65,
        matchQuality: null,
      }),
    ).toEqual({
      decision: "abstain",
      reason: "unmeasurable_quality",
      top_score: 0.65,
      match_quality: null,
    });
    expect(recallInjectTelemetryMetadata({ kind: "error", fault: RECALL_INJECT_FAULT.timeout }))
      // The error projection carries no quality and no score at all.
      .toEqual({ decision: "error", fault: RECALL_INJECT_FAULT.timeout });
  });

  test("the audit projection adds the message and nothing else", () => {
    // The one place the two projections may differ, stated as a
    // difference rather than as an identity over fixtures that cannot
    // produce one.
    const withDetail: RecallInjectDecision = {
      kind: "error",
      fault: RECALL_INJECT_FAULT.retrieverFailed,
      detail: "disk I/O error",
    };
    expect(recallInjectAuditDetails(withDetail)).toEqual({
      decision: "error",
      fault: RECALL_INJECT_FAULT.retrieverFailed,
      detail: "disk I/O error",
    });
    const noDetail: RecallInjectDecision = { kind: "error", fault: RECALL_INJECT_FAULT.timeout };
    expect(recallInjectAuditDetails(noDetail)).toEqual(
      recallInjectTelemetryMetadata(noDetail) as Record<string, unknown>,
    );
    // And an abstain never grows one, however the retriever failed.
    const abstain: RecallInjectDecision = {
      kind: "abstain",
      reason: "no_matches",
      topScore: 0,
      matchQuality: 0,
    };
    expect(Object.keys(recallInjectAuditDetails(abstain))).not.toContain("detail");
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
