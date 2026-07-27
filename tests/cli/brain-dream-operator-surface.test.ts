/**
 * The two shipped dream capabilities reach an operator (no-dead-ends,
 * phase 3, item 1).
 *
 * `runDreamStep` and the per-run gate override both landed as TypeScript
 * arguments with no flag, no MCP argument and no way to reach them from a
 * shell. The kanban unit they implement asked for exactly the operator
 * capability - run a targeted pass "without the stateful, error-prone
 * dance of toggling phase gates and remembering to revert them" - so a
 * TypeScript-only argument does not deliver it.
 *
 * What is asserted here:
 *   - both runnable steps run from `o2b brain dream --step <name>`;
 *   - every other token is REFUSED BY NAME, carrying the specific reason
 *     and the runnable set, on both the human and the `--json` stream;
 *   - `--gate <name>=<true|false>` steers one run and leaves
 *     `Brain/_brain.yaml` byte-identical;
 *   - the same two capabilities exist on MCP `brain_dream`;
 *   - with neither flag present the verb is byte-identical to today.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { DREAM_PHASE } from "../../src/core/brain/dream-phases.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-dream-operator-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const brainConfigPath = (): string => join(vault, "Brain", "_brain.yaml");

/** Three same-sign signals: enough that a full pass promotes them. */
function seedPromotion(topic = "operator-surface"): void {
  for (const [i, date] of ["2026-05-20", "2026-05-21", "2026-05-22"].entries()) {
    writeSignal(vault, {
      topic,
      signal: "positive",
      agent: "claude",
      principle: "Prefer the operated approach",
      created_at: `${date}T10:00:00Z`,
      date,
      slug: `op${i}`,
      scope: "writing",
    });
  }
}

/**
 * Two user pages where one mentions the other's exact title, so the
 * heal enrichment has something deterministic to rewrite.
 */
function makeLinkableNotes(): string {
  const notes = join(vault, "Notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "target.md"), "---\ntitle: Widget Registry\n---\n\nBody.\n", "utf8");
  const refPath = join(notes, "ref.md");
  writeFileSync(
    refPath,
    "---\ntitle: Reference Page\n---\n\nSee the Widget Registry for details.\n",
    "utf8",
  );
  return refPath;
}

async function makeServer(): Promise<MCPServer> {
  const server = new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dream-operator-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return server;
}

let callId = 100;
async function callDream(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ structured?: Record<string, unknown>; errorCode?: number; errorMessage?: string }> {
  callId += 1;
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: callId,
    method: "tools/call",
    params: { name: "brain_dream", arguments: args },
  })) as {
    result?: { structuredContent?: Record<string, unknown> };
    error?: { code: number; message: string };
  };
  if (r.error) return { errorCode: r.error.code, errorMessage: r.error.message };
  return { structured: r.result?.structuredContent };
}

describe("o2b brain dream --step", () => {
  test("runs the scan step and reports only what the scan observed", async () => {
    seedPromotion();
    const r = await runCli(["brain", "dream", "--step", "scan", "--vault", vault, "--json"]);

    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.step).toBe("scan");
    expect(payload.partial).toBe(true);
    expect(payload.active_signals).toBe(3);
    expect(payload.preferences).toBe(0);
    // A partial result must not assert the fields a full pass owns.
    expect(payload).not.toHaveProperty("run_id");
    expect(payload).not.toHaveProperty("changed");
    // A pure read promotes nothing.
    const after = await runCli(["brain", "dream", "--step", "scan", "--vault", vault, "--json"]);
    expect(JSON.parse(after.stdout).preferences).toBe(0);
  });

  test("runs the heal-enrich step even with the config gate off", async () => {
    const refPath = makeLinkableNotes();
    const before = readFileSync(brainConfigPath(), "utf8");

    const r = await runCli(["brain", "dream", "--step", "heal-enrich", "--vault", vault, "--json"]);

    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.step).toBe("heal-enrich");
    expect(payload.partial).toBe(true);
    expect(payload.enriched).toBe(1);
    expect(readFileSync(refPath, "utf8")).toContain("[[Widget Registry]]");
    // Asking for the step IS the opt-in; it never writes the config back.
    expect(readFileSync(brainConfigPath(), "utf8")).toBe(before);
  });

  test("human output names the step and its counters", async () => {
    seedPromotion();
    const r = await runCli(["brain", "dream", "--step", "scan", "--vault", vault]);

    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("step: scan\n");
    expect(r.stdout).toContain("active_signals: 3\n");
  });

  test("refuses a reporting phase by name and prints the runnable set", async () => {
    const r = await runCli(["brain", "dream", "--step", DREAM_PHASE.synthesize, "--vault", vault]);

    expect(r.returncode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`dream step '${DREAM_PHASE.synthesize}' is not independently`);
    // The SPECIFIC reason, not a generic "unsupported".
    expect(r.stderr).toContain("planRefresh and planAutoRetires mutate each other's accumulators");
    expect(r.stderr).toContain("Independently runnable steps: scan, heal-enrich");
  });

  test("refuses a token that is not even a reporting phase", async () => {
    const r = await runCli(["brain", "dream", "--step", "hibernate", "--vault", vault]);

    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain(
      "it is neither a runnable dream step nor one of the dream reporting phases",
    );
    expect(r.stderr).toContain("Independently runnable steps: scan, heal-enrich");
  });

  test("every non-runnable phase is refused, each with its own reason", async () => {
    const reasons = new Set<string>();
    for (const phase of Object.values(DREAM_PHASE)) {
      // oxlint-disable-next-line no-await-in-loop -- runCli patches process.stdout in-process, so concurrent invocations would interleave each other's captured output
      const r = await runCli(["brain", "dream", "--step", phase, "--vault", vault]);
      expect(`${phase} exit: ${r.returncode}`).toBe(`${phase} exit: 2`);
      reasons.add(r.stderr);
    }
    expect(reasons.size).toBe(Object.values(DREAM_PHASE).length);
  });

  test("the refusal is a clean JSON payload under --json", async () => {
    const r = await runCli([
      "brain",
      "dream",
      "--step",
      DREAM_PHASE.log,
      "--vault",
      vault,
      "--json",
    ]);

    expect(r.returncode).toBe(2);
    const payload = JSON.parse(r.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.step).toBe(DREAM_PHASE.log);
    expect(payload.runnable).toEqual(["scan", "heal-enrich"]);
    expect(typeof payload.reason).toBe("string");
    expect(payload.reason.length).toBeGreaterThan(0);
  });

  test("refuses --step combined with the flags a full pass owns", async () => {
    for (const extra of [["--dry-run"], ["--strict"], ["--expect", "0"]]) {
      // oxlint-disable-next-line no-await-in-loop -- runCli patches process.stdout in-process, so concurrent invocations would interleave each other's captured output
      const r = await runCli(["brain", "dream", "--step", "scan", ...extra, "--vault", vault]);
      expect(`${extra[0]} exit: ${r.returncode}`).toBe(`${extra[0]} exit: 2`);
      expect(r.stderr).toContain(extra[0]!);
    }
  });

  test("refuses --step on an action other than run", async () => {
    const r = await runCli(["brain", "dream", "list", "--step", "scan", "--vault", vault]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--step");
    expect(r.stderr).toContain("list");
  });
});

describe("o2b brain dream --gate", () => {
  test("turns the heal gate on for one run and leaves the config byte-identical", async () => {
    seedPromotion();
    const refPath = makeLinkableNotes();
    const before = readFileSync(brainConfigPath(), "utf8");

    const r = await runCli([
      "brain",
      "dream",
      "--gate",
      "heal_enrich=true",
      "--now",
      "2026-05-30T10:00:00Z",
      "--vault",
      vault,
      "--json",
    ]);

    expect(r.returncode).toBe(0);
    expect(JSON.parse(r.stdout).changed).toBe(true);
    expect(readFileSync(refPath, "utf8")).toContain("[[Widget Registry]]");
    expect(readFileSync(brainConfigPath(), "utf8")).toBe(before);
  });

  test("turns the heal gate off for one run on a vault whose config enables it", async () => {
    seedPromotion();
    const refPath = makeLinkableNotes();
    writeFileSync(
      brainConfigPath(),
      "schema_version: 1\ndream:\n  heal_enrich_enabled: true\n",
      "utf8",
    );
    const before = readFileSync(brainConfigPath(), "utf8");

    const r = await runCli([
      "brain",
      "dream",
      "--gate",
      "heal_enrich=false",
      "--now",
      "2026-05-30T10:00:00Z",
      "--vault",
      vault,
      "--json",
    ]);

    expect(r.returncode).toBe(0);
    expect(readFileSync(refPath, "utf8")).not.toContain("[[Widget Registry]]");
    expect(readFileSync(brainConfigPath(), "utf8")).toBe(before);
  });

  test("refuses an unknown gate name, listing the known ones", async () => {
    const r = await runCli(["brain", "dream", "--gate", "retire_floor=true", "--vault", vault]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("retire_floor");
    expect(r.stderr).toContain("heal_enrich");
  });

  test("refuses a value that is not a boolean token", async () => {
    const r = await runCli(["brain", "dream", "--gate", "heal_enrich=maybe", "--vault", vault]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("maybe");
    expect(r.stderr).toContain("true");
    expect(r.stderr).toContain("false");
  });

  test("refuses an entry with no value at all", async () => {
    const r = await runCli(["brain", "dream", "--gate", "heal_enrich", "--vault", vault]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("heal_enrich");
  });

  test("refuses two contradictory overrides of the same gate", async () => {
    const r = await runCli([
      "brain",
      "dream",
      "--gate",
      "heal_enrich=true",
      "--gate",
      "heal_enrich=false",
      "--vault",
      vault,
    ]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("heal_enrich");
  });

  test("refuses --gate together with --step", async () => {
    const r = await runCli([
      "brain",
      "dream",
      "--step",
      "heal-enrich",
      "--gate",
      "heal_enrich=true",
      "--vault",
      vault,
    ]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--gate");
  });
});

describe("byte-identical when absent", () => {
  test("a run with neither flag prints exactly what it printed before", async () => {
    const r = await runCli([
      "brain",
      "dream",
      "--dry-run",
      "--now",
      "2026-05-30T10:00:00Z",
      "--vault",
      vault,
    ]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe("run_id: dream-2026-05-30-100000\nchanged: false\n");
    expect(r.stderr).toBe("");
  });

  test("the JSON run payload gains no step or gate key", async () => {
    const r = await runCli([
      "brain",
      "dream",
      "--dry-run",
      "--now",
      "2026-05-30T10:00:00Z",
      "--vault",
      vault,
      "--json",
    ]);
    const payload = JSON.parse(r.stdout);
    expect(payload).not.toHaveProperty("step");
    expect(payload).not.toHaveProperty("gates");
    expect(payload).toHaveProperty("run_id");
  });
});

describe("the manifest advertises both flags", () => {
  test("help --json models --step and --gate on brain dream", async () => {
    const r = await runCli(["help", "--json"]);
    const parsed = JSON.parse(r.stdout);
    const brain = parsed.commands.find((c: { name: string }) => c.name === "brain");
    const dream = brain.commands.find((c: { name: string }) => c.name === "dream");
    expect(dream.flags).toContainEqual({ name: "step", type: "string" });
    expect(dream.flags).toContainEqual({ name: "gate", type: "string-array" });
  });

  test("completions advertise the new flags", async () => {
    const r = await runCli(["completions", "bash"]);
    expect(r.stdout).toContain("--step");
    expect(r.stdout).toContain("--gate");
  });
});

describe("MCP brain_dream carries the same two capabilities", () => {
  test("step=scan returns the partial scan result", async () => {
    seedPromotion();
    const server = await makeServer();
    const r = await callDream(server, { step: "scan" });
    expect(r.errorCode).toBeUndefined();
    expect(r.structured!["step"]).toBe("scan");
    expect(r.structured!["partial"]).toBe(true);
    expect(r.structured!["active_signals"]).toBe(3);
  });

  test("step=heal-enrich runs the enrichment with the config gate off", async () => {
    const refPath = makeLinkableNotes();
    const server = await makeServer();
    const r = await callDream(server, { step: "heal-enrich" });
    expect(r.errorCode).toBeUndefined();
    expect(r.structured!["enriched"]).toBe(1);
    expect(readFileSync(refPath, "utf8")).toContain("[[Widget Registry]]");
  });

  test("a non-runnable step is INVALID_PARAMS carrying the specific reason", async () => {
    const server = await makeServer();
    const r = await callDream(server, { step: DREAM_PHASE.heal });
    expect(r.errorCode).toBe(-32602);
    expect(r.errorMessage).toContain("planAutoRetires deletes from refresh.updated");
    expect(r.errorMessage).toContain("Independently runnable steps: scan, heal-enrich");
  });

  test("gates override the vault config for one run and write nothing back", async () => {
    seedPromotion();
    const refPath = makeLinkableNotes();
    const before = readFileSync(brainConfigPath(), "utf8");
    const server = await makeServer();

    const r = await callDream(server, {
      gates: { heal_enrich: true },
      now: "2026-05-30T10:00:00Z",
    });

    expect(r.errorCode).toBeUndefined();
    expect(r.structured!["changed"]).toBe(true);
    expect(readFileSync(refPath, "utf8")).toContain("[[Widget Registry]]");
    expect(readFileSync(brainConfigPath(), "utf8")).toBe(before);
  });

  test("an unknown gate is INVALID_PARAMS naming the known gates", async () => {
    const server = await makeServer();
    const r = await callDream(server, { gates: { retire_floor: true } });
    expect(r.errorCode).toBe(-32602);
    expect(r.errorMessage).toContain("retire_floor");
    expect(r.errorMessage).toContain("heal_enrich");
  });

  test("a non-boolean gate value is INVALID_PARAMS", async () => {
    const server = await makeServer();
    const r = await callDream(server, { gates: { heal_enrich: "yes" } });
    expect(r.errorCode).toBe(-32602);
  });

  test("the tool advertises both arguments", async () => {
    const server = await makeServer();
    const listed = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 900,
      method: "tools/list",
    })) as { result: { tools: Array<{ name: string; inputSchema: { properties: object } }> } };
    const tool = listed.result.tools.find((t) => t.name === "brain_dream")!;
    expect(Object.keys(tool.inputSchema.properties)).toContain("step");
    expect(Object.keys(tool.inputSchema.properties)).toContain("gates");
  });
});
