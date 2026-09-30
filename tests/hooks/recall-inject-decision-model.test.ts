/**
 * The real recall-inject hook entry (`hooks/recall-inject.ts`) with the
 * `recall_inject` decision-model use, against a loopback fake
 * `/v1/systemone` server (issue #213, Part 9).
 *
 * The four activation cases (no config, key without enabling, enabling
 * without key, enabled with key) and the modes: in the first three, and in
 * shadow, the hook's stdout is byte-identical to the hook without the
 * feature. A slow server costs at most the sub-budget, and a decision
 * timeout never turns an injection into an empty one.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hookAuditDir } from "../../src/core/brain/paths.ts";
import { listRecallTelemetry, RECALL_CHANNEL } from "../../src/core/brain/recall-telemetry.ts";
import { listDecisionModelCalls } from "../../src/core/decision-model/record.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { FAKE_DECISION_KEY } from "../helpers/fake-credentials.ts";
import { homeEnv } from "../helpers/platform.ts";
import { createTempVault, writeMd } from "../helpers/search-fixtures.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "recall-inject.ts",
);
const KEY_VAR = "O2B_TEST_RECALL_DM_KEY";
const PROMPT = "heron migration schedule";
const GROCERY = "Grocery heron list: bread and milk.";

interface FakeServer {
  url: string;
  requests: Array<Record<string, unknown>>;
  delayMs: number;
  /** helps probability by whether the note text contains a marker. */
  lowFor: string | null;
  injectAny: number;
  stop(): void;
}

function startServer(): FakeServer {
  const state: FakeServer = {
    url: "",
    requests: [],
    delayMs: 0,
    lowFor: null,
    injectAny: 0.9,
    stop: () => undefined,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      state.requests.push(body);
      if (state.delayMs > 0) await Bun.sleep(state.delayMs);
      const questions = body["questions"] as Record<string, unknown>;
      const notes = (body["state"] as { notes: Record<string, string> }).notes;
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(questions)) {
        let p = 0.9;
        if (id === "inject_any") p = state.injectAny;
        else if (state.lowFor !== null) {
          const text = notes[`N${id.slice("helps_".length)}`] ?? "";
          if (text.includes(state.lowFor)) p = 0.05;
        }
        answers[id] = { type: "noul", noul: p };
      }
      return Response.json({
        model: "fake-model-1.0",
        answers,
        usage: { input_tokens: 200, output_tokens: 4 },
      });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => void server.stop(true);
  return state;
}

let server: FakeServer;
let vault: string;
let cleanup: () => void;
let configPath: string;

beforeAll(() => {
  server = startServer();
});
afterAll(() => {
  server.stop();
});

beforeEach(async () => {
  ({ vault, cleanup } = createTempVault("recall-dm-hook"));
  writeMd(
    vault,
    "notes/schedule.md",
    "# Heron schedule\n\nThe heron migration schedule starts in October.",
  );
  writeMd(vault, "notes/nests.md", "# Heron nests\n\nHeron migration routes pass the river nests.");
  writeMd(vault, "notes/grocery.md", `# Groceries\n\n${GROCERY} Schedule a heron migration trip.`);
  configPath = join(vault, ".o2b-test-config.yaml");
  writeConfig({});
  await indexVault(resolveSearchConfig({ vault, configPath }));
  server.requests.length = 0;
  server.delayMs = 0;
  server.lowFor = null;
  server.injectAny = 0.9;
});
afterEach(() => cleanup());

function writeConfig(entries: Record<string, string>): void {
  const all = { search_recency_amplitude: "0", ...entries };
  writeFileSync(
    configPath,
    Object.entries(all)
      .map(([k, v]) => `${k}: "${v}"`)
      .join("\n") + "\n",
  );
}

const DECISION = (): Record<string, string> => ({
  decision_model_enabled: "true",
  decision_model_provider: "compatible",
  decision_model_threshold_profile: "jev-1.13",
  decision_model_base_url: server.url,
  decision_model_id: "fake-model-1",
  decision_model_env_key: KEY_VAR,
  decision_model_uses: "recall_inject:shadow",
});

interface HookRun {
  readonly stdout: string;
  readonly exit: number;
  readonly wallMs: number;
}

async function runHook(env: Record<string, string> = {}): Promise<HookRun> {
  const started = Date.now();
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...homeEnv(join(vault, ".home")),
      VAULT_DIR: vault,
      OPEN_SECOND_BRAIN_CONFIG: configPath,
      OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true",
      // The spawned hook does not run the test preload, so without this it
      // would mint a device id into each rewritten config and spread its
      // audit records over several week shards; "last record" below needs
      // the single legacy week file the preload pins in-process.
      O2B_DEVICE_ID: "",
      ...env,
    },
  });
  proc.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: PROMPT }));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  return { stdout, exit, wallMs: Date.now() - started };
}

function audits(): Array<Record<string, unknown>> {
  const dir = hookAuditDir(vault);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    )
    .filter((r) => r["actor"] === "recall-inject");
}

function lastDetails(): Record<string, unknown> {
  const all = audits();
  return (all[all.length - 1]?.["details"] ?? {}) as Record<string, unknown>;
}

async function baseline(): Promise<string> {
  writeConfig({});
  const r = await runHook();
  expect(r.exit).toBe(0);
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
  expect(out.hookSpecificOutput.additionalContext).toContain("notes/grocery.md");
  return r.stdout;
}

describe("recall-inject hook with the decision-model use", () => {
  test("1-3: no config, key without enabling, enabling without key: identical, no request", async () => {
    const today = await baseline();
    expect(lastDetails()["decision_model"]).toBeUndefined();

    const { decision_model_enabled: _, ...notEnabled } = DECISION();
    const cases: Array<[Record<string, string>, Record<string, string>]> = [
      [{}, {}],
      [notEnabled, { [KEY_VAR]: FAKE_DECISION_KEY }],
      [DECISION(), {}],
    ];
    for (const [config, env] of cases) {
      writeConfig(config);
      // eslint-disable-next-line no-await-in-loop -- one config file, one hook at a time
      const r = await runHook(env);
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe(today);
      expect(lastDetails()["decision_model"]).toBeUndefined();
    }
    expect(server.requests).toHaveLength(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
  }, 30_000);

  test("4 shadow: one request, one record, stdout byte-identical", async () => {
    const today = await baseline();
    server.lowFor = GROCERY;
    writeConfig(DECISION());
    const r = await runHook({ [KEY_VAR]: FAKE_DECISION_KEY });
    expect(r.stdout).toBe(today);
    expect(server.requests).toHaveLength(1);
    expect(JSON.stringify(server.requests[0])).not.toContain(FAKE_DECISION_KEY);
    expect(lastDetails()["decision_model"]).toMatchObject({
      mode: "shadow",
      outcome: "ok",
      notes_dropped: 1,
      abstained: false,
    });
    const records = listDecisionModelCalls(vault);
    expect(records).toHaveLength(1);
    const payload = JSON.stringify(records[0]!.payload);
    expect(payload).not.toContain(PROMPT);
    expect(payload).not.toContain("Grocery heron list");
    const telemetry = listRecallTelemetry(vault, { channel: RECALL_CHANNEL.hook });
    expect(telemetry[0]!.payload["metadata"]).toMatchObject({
      decision: "inject",
      decision_model: { mode: "shadow", outcome: "ok" },
    });
    expect(JSON.stringify(telemetry[0]!.payload)).not.toContain(PROMPT);
  }, 30_000);

  test("4 enforce: the unhelpful note is dropped from the injected brief", async () => {
    await baseline();
    server.lowFor = GROCERY;
    writeConfig({ ...DECISION(), decision_model_uses: "recall_inject:enforce" });
    const r = await runHook({ [KEY_VAR]: FAKE_DECISION_KEY });
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).not.toContain("notes/grocery.md");
    expect(out.hookSpecificOutput.additionalContext).toContain("notes/schedule.md");
    expect(lastDetails()["decision_model"]).toMatchObject({ mode: "enforce", notes_dropped: 1 });
  }, 30_000);

  test("4 enforce: inject_any low withholds the brief with decision_model_abstain", async () => {
    server.injectAny = 0.05;
    writeConfig({ ...DECISION(), decision_model_uses: "recall_inject:enforce" });
    const r = await runHook({ [KEY_VAR]: FAKE_DECISION_KEY });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(lastDetails()).toMatchObject({
      decision: "abstain",
      reason: "decision_model_abstain",
      decision_model: { abstained: true },
    });
  }, 30_000);

  test("a server slower than the sub-budget: today's brief, never an empty injection", async () => {
    const today = await baseline();
    server.delayMs = 5_000;
    writeConfig({
      ...DECISION(),
      decision_model_uses: "recall_inject:enforce",
      decision_model_hook_budget_ms: "300",
    });
    const r = await runHook({ [KEY_VAR]: FAKE_DECISION_KEY });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe(today);
    expect(lastDetails()["decision_model"]).toMatchObject({
      outcome: "degraded",
      degrade_reason: "timeout",
    });
    // The hook never waits for the slow server (process start included).
    expect(r.wallMs).toBeLessThan(4_500);
  }, 30_000);
});
