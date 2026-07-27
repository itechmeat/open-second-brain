/**
 * `brain_doctor` names its exits over MCP (no-dead-ends, task 4).
 *
 * The CLI twin of this surface gained the structural next command; an
 * agent driving the doctor over MCP would otherwise still get a code and
 * a sentence and have to re-derive the repair. The tool resolves each
 * reported issue against the same registry the CLI uses, and carries the
 * command as a field on the issue record - there is no stream here to
 * contaminate, so the field is the only form the pointer takes.
 *
 * The absent case matters as much as the present one: a code with no
 * registered signal must arrive with no `next_command` key, never with a
 * generic one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { DIAGNOSTIC_SIGNALS } from "../../src/core/brain/diagnostics.ts";
import { DOCTOR_EXIT_EXCLUSIONS } from "../../src/core/brain/doctor-exits.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";

const REPAIR_COMMAND = DIAGNOSTIC_SIGNALS.get("broken-wikilink")!.nextCommand;

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-doctor-next-step-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  resetVaultIdentityPins();
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function callDoctor(): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "doctor-next-step-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: "brain_doctor", arguments: {} },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

type IssueRecord = Record<string, unknown> & { code: string };

function issues(payload: Record<string, unknown>, key: string): ReadonlyArray<IssueRecord> {
  return (payload[key] ?? []) as ReadonlyArray<IssueRecord>;
}

describe("brain_doctor - the next command reaches an MCP caller", () => {
  test("a registered warning carries next_command", async () => {
    mkdirSync(join(vault, "Brain", "log", "dream-runs"), { recursive: true });
    writePreference(vault, {
      slug: "dead-pointer",
      topic: "dead-pointer",
      principle: "a rule whose evidence pointer went missing",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-does-not-exist]]"],
    });
    const payload = await callDoctor();
    const hit = issues(payload, "warnings").find((w) => w.code === "broken-wikilink");
    expect(hit).toBeDefined();
    expect(hit!["next_command"]).toBe(REPAIR_COMMAND);
  });

  test("an unregistered warning carries no next_command key", async () => {
    writePreference(vault, {
      slug: "mismatch",
      topic: "mismatch",
      principle: "a rule filed under the wrong folder",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
    });
    const path = join(vault, "Brain", "preferences", "pref-mismatch.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("_status: unconfirmed", "_status: retired"),
      "utf8",
    );
    const payload = await callDoctor();
    const hit = issues(payload, "warnings").find((w) => w.code === "status-folder-mismatch");
    expect(hit).toBeDefined();
    expect(Object.hasOwn(hit!, "next_command")).toBe(false);
  });

  test("an unregistered warning arrives with the published reason it has none", async () => {
    writePreference(vault, {
      slug: "mismatch",
      topic: "mismatch",
      principle: "a rule filed under the wrong folder",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
    });
    const path = join(vault, "Brain", "preferences", "pref-mismatch.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("_status: unconfirmed", "_status: retired"),
      "utf8",
    );
    const payload = await callDoctor();
    // Beside the streams, once per code - the same shape and the same key
    // the CLI's `--json` renderer uses.
    expect((payload["no_exit"] as Record<string, string>)["status-folder-mismatch"]).toBe(
      DOCTOR_EXIT_EXCLUSIONS.get("status-folder-mismatch")!,
    );
  });

  test("a clean vault reports no issues and invents no commands", async () => {
    const payload = await callDoctor();
    expect(issues(payload, "errors")).toEqual([]);
    expect(issues(payload, "warnings")).toEqual([]);
    for (const record of issues(payload, "uncertain")) {
      // The hand-built fixture root is marked, so `uncertain` is empty
      // here; the assertion holds the invariant if that ever changes.
      expect(Object.hasOwn(record, "next_command")).toBe(
        DIAGNOSTIC_SIGNALS.has(record.code as string),
      );
    }
  });
});
