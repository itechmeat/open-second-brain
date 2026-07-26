/**
 * Issue #149 - the force-confirmed cold start (no-dead-ends, task 22).
 *
 * The report said a `force_confirmed` preference is stuck at 0.00
 * confidence in a deadlock, and proposed two fixes. Reconnaissance found
 * the report partially right with its load-bearing half wrong: there is
 * no division by zero (`confidence.ts` guards `n > 0`), and the
 * de-prioritization it describes does not exist on `active.md`, which
 * filters on confirmed status with no cutoff and sorts by BAND, not
 * value - both proposed values land in the same band, so neither would
 * move the preference one position in the injected context.
 *
 * The real defect the report missed is one line away from the one it
 * found: the value is written as `null`, not `0`, and `null` ranks WORSE
 * than `0`. Two surfaces map an absent value to negative infinity and
 * then sort and slice, so a brand-new confirmed rule sorts below every
 * rule that has a number - including one whose measured confidence is
 * zero. The dream pass already pre-seeds new preferences with an
 * explicit `0` for exactly this reason; the two force-confirm writers
 * did not.
 *
 * This file pins the fix and both refusals:
 *
 *   - both writers emit an explicit `0`;
 *   - both ranking surfaces put it ABOVE a valueless entry;
 *   - the existing `low-evidence-confirmed` detector names recording
 *     real evidence as the exit;
 *   - and NO apply-evidence row is written, because forging one would
 *     assert a rule was exercised against work that never happened.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../src/mcp/index.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { buildMorningBrief } from "../../../src/core/brain/morning-brief.ts";
import { buildPreCompressPack } from "../../../src/core/brain/pre-compress-pack.ts";
import { DIAGNOSTIC_SIGNALS } from "../../../src/core/brain/diagnostics.ts";
import { listLogDates, readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { parsePreference, writePreference } from "../../../src/core/brain/preference.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../src/core/brain/types.ts";
import { runCli } from "../../helpers/run-cli.ts";

const LOW_EVIDENCE_CODE = "low-evidence-confirmed";

let tmp: string;
let vault: string;
let config: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cold-start-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  writeFileSync(config, `vault: ${vault}\nagent_name: test-agent\n`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = config;
  resetVaultIdentityPins();
  bootstrapBrain(vault, { configPath: config });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function preferenceFile(slug: string): string {
  return readFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), "utf8");
}

/** Every log event kind recorded anywhere in `Brain/log/`. */
function loggedEventKinds(): ReadonlySet<string> {
  const kinds = new Set<string>();
  for (const date of listLogDates(vault)) {
    for (const entry of readLogDay(vault, date).entries) kinds.add(entry.eventType);
  }
  return kinds;
}

async function callMcpFeedback(args: Record<string, unknown>): Promise<void> {
  const server = new MCPServer({ vault, configPath: config });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cold-start-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: "brain_feedback", arguments: args },
  });
}

describe("the value is written, not left absent", () => {
  test("the CLI writer emits an explicit zero", async () => {
    const r = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "cli-cold",
        "--signal",
        "positive",
        "--principle",
        "prefer the explicit zero",
        "--force-confirmed",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(preferenceFile("cli-cold")).toContain("_confidence_value: 0\n");
    const pref = parsePreference(join(vault, "Brain", "preferences", "pref-cli-cold.md"));
    expect(pref.confidence_value).toBe(0);
  });

  test("the MCP writer emits an explicit zero", async () => {
    await callMcpFeedback({
      topic: "mcp-cold",
      signal: "positive",
      principle: "prefer the explicit zero",
      force_confirmed: true,
    });
    expect(preferenceFile("mcp-cold")).toContain("_confidence_value: 0\n");
    const pref = parsePreference(join(vault, "Brain", "preferences", "pref-mcp-cold.md"));
    expect(pref.confidence_value).toBe(0);
  });

  test("no apply-evidence row is forged for the rule that was never applied", async () => {
    // Option A in the report writes one. That row is the canonical
    // durable signal that a preference was exercised against real work:
    // forging it corrupts the most-applied ranking, the recent-
    // applications section and the outcome-regression ratio, and
    // consumes one of the two events the low-evidence warning needs.
    await callMcpFeedback({
      topic: "mcp-cold",
      signal: "positive",
      principle: "prefer the explicit zero",
      force_confirmed: true,
    });
    expect(loggedEventKinds().has(BRAIN_LOG_EVENT_KIND.applyEvidence)).toBe(false);
    const pref = parsePreference(join(vault, "Brain", "preferences", "pref-mcp-cold.md"));
    expect(pref.applied_count).toBe(0);
    expect(pref.evidenced_by.some((link) => link.includes("sig-"))).toBe(true);
  });
});

describe("zero outranks absent on both surfaces that rank on the number", () => {
  /**
   * Two confirmed rules identical but for the value: one carrying the
   * explicit `0` a force-confirm now writes, one carrying `null` as a
   * force-confirm used to. `null` reads back as negative infinity in
   * both rankers, so the ordering is the whole assertion.
   */
  function seedPair(): void {
    writePreference(vault, {
      slug: "zero-valued",
      topic: "zero-valued",
      principle: "the rule a force-confirm writes today",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-01T00:00:00Z",
      confirmed_at: "2026-01-01T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      confidence_value: 0,
    });
    writePreference(vault, {
      slug: "value-absent",
      topic: "value-absent",
      principle: "the rule a force-confirm used to write",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-01T00:00:00Z",
      confirmed_at: "2026-01-01T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
    });
    expect(
      parsePreference(join(vault, "Brain", "preferences", "pref-value-absent.md")).confidence_value,
    ).toBeNull();
  }

  test("the pre-compress pack ranks the zero above the absent value", () => {
    seedPair();
    const pack = buildPreCompressPack(vault, { topK: 5 });
    const ids = pack.items.map((item) => item.id);
    expect(ids.indexOf("pref-zero-valued")).toBeLessThan(ids.indexOf("pref-value-absent"));
    expect(ids.indexOf("pref-zero-valued")).toBe(0);
  });

  test("the morning brief ranks the zero above the absent value", () => {
    seedPair();
    const brief = buildMorningBrief(vault, {
      now: new Date("2026-02-01T00:00:00Z"),
      topK: 5,
    });
    const ids = brief.preferences.map((p) => p.id);
    expect(ids.indexOf("pref-zero-valued")).toBeLessThan(ids.indexOf("pref-value-absent"));
    expect(ids.indexOf("pref-zero-valued")).toBe(0);
  });
});

describe("the detector names the exit", () => {
  /** A confirmed rule past its trial window with no real use. */
  function seedColdRule(): void {
    writePreference(vault, {
      slug: "never-used",
      topic: "never-used",
      principle: "a rule confirmed long ago and never applied",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-01T00:00:00Z",
      confirmed_at: "2026-01-01T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      confidence_value: 0,
    });
  }

  test("the code resolves to the command that records real evidence", () => {
    const signal = DIAGNOSTIC_SIGNALS.get(LOW_EVIDENCE_CODE);
    expect(signal).toBeDefined();
    expect(signal!.nextCommand.startsWith("o2b brain apply-evidence")).toBe(true);
    expect(signal!.autoRepairable).toBe(false);
  });

  test("the doctor's human output names the command", async () => {
    seedColdRule();
    const r = await runCli(["brain", "doctor", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.stdout).toContain(`[WARN]  ${LOW_EVIDENCE_CODE}:`);
    expect(r.stdout).toContain(`next: ${DIAGNOSTIC_SIGNALS.get(LOW_EVIDENCE_CODE)!.nextCommand}\n`);
  });

  test("the doctor's JSON output carries the command as a field", async () => {
    seedColdRule();
    const r = await runCli(["brain", "doctor", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const payload = JSON.parse(r.stdout) as {
      warnings: ReadonlyArray<{ code: string; next_command?: string }>;
    };
    const hit = payload.warnings.find((w) => w.code === LOW_EVIDENCE_CODE);
    expect(hit?.next_command).toBe(DIAGNOSTIC_SIGNALS.get(LOW_EVIDENCE_CODE)!.nextCommand);
  });
});
