/**
 * `brain_context` is the second return path for the operator's standing
 * rules (silence-is-not-an-answer, U8): runtimes without a SessionStart
 * hook pull the same preamble through this tool, so the constitution has
 * to lead the content here exactly as it leads the injected payload.
 *
 * The envelope extension follows the `vault_instruction` precedent -
 * absent file means the field is omitted so hosts that strip unknown
 * fields stay byte-identical.
 *
 * The suite also pins the vault-instruction defect this unit closed: a
 * configuration error in the instruction-file setting used to be
 * swallowed into `null`, so the field simply vanished and the operator
 * was told nothing at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { STANDING_RULES_HEADER } from "../../src/core/brain/standing-rules.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

const RULES = "Never force-push to main.\nAsk before deleting anything under Archive/.";
const RULES_REL = "Brain/standing-rules.md";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-standing-"));
  vault = join(tmp, "vault");
  for (const dir of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", dir), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-standing-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "standing-rules-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callContext(): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context", arguments: {} },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(r.result.content[0]!.text);
}

function writeRules(body: string): void {
  writeFileSync(join(vault, "Brain", "standing-rules.md"), body, "utf8");
}

interface StandingRulesField {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

describe("brain_context standing_rules field", () => {
  test("absent file: the envelope OMITS standing_rules and the content is untouched", async () => {
    const out = await callContext();
    expect("standing_rules" in out).toBe(false);
    expect(out["content"]).not.toContain(STANDING_RULES_HEADER);
  });

  test("present file: path, content and truncated are reported", async () => {
    writeRules(RULES);
    const out = await callContext();
    const field = out["standing_rules"] as StandingRulesField;
    expect(field.path).toBe(RULES_REL);
    expect(field.content).toBe(RULES);
    expect(field.truncated).toBe(false);
  });

  test("present file: the block leads the returned content", async () => {
    writeRules(RULES);
    const content = (await callContext())["content"] as string;
    expect(content.startsWith(STANDING_RULES_HEADER)).toBe(true);
    expect(content).toContain(RULES);
    expect(content.indexOf(RULES)).toBeLessThan(content.indexOf("Active Brain Preferences"));
  });

  test("the block precedes the pinned-context append", async () => {
    writeRules(RULES);
    writeFileSync(join(vault, "Brain", "pinned.md"), "Deploy window is Tuesday.\n", "utf8");
    const content = (await callContext())["content"] as string;
    expect(content.startsWith(STANDING_RULES_HEADER)).toBe(true);
    expect(content.indexOf(RULES)).toBeLessThan(content.indexOf("Pinned context"));
  });

  test("an over-cap file reports truncated and carries the loud notice", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nactive:\n  standing_rules_max_chars: 200\n",
    );
    writeRules(Array.from({ length: 100 }, (_, i) => `Standing rule number ${i}.`).join("\n"));
    const out = await callContext();
    const field = out["standing_rules"] as StandingRulesField;
    expect(field.truncated).toBe(true);
    expect(field.content.length).toBeLessThanOrEqual(200);
    expect(out["content"]).toContain("Standing rules truncated");
  });

  test.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "the branch that reports Brain/ as absent still says why the rules are unavailable",
    async () => {
      // A vault directory the process cannot traverse makes `existsSync`
      // answer false for `Brain/`, which is the one return path that used
      // to fire before the standing-rules read: it handed back
      // `present: false` and an empty body with nothing saying that the
      // constitution had not been consulted.
      writeRules(RULES);
      chmodSync(vault, 0o000);
      try {
        const out = await callContext();
        expect(out["present"]).toBe(false);
        const content = out["content"] as string;
        expect(content).toContain(STANDING_RULES_HEADER);
        expect(content).toContain("UNAVAILABLE");
        // No record to report for bytes nobody could read.
        expect("standing_rules" in out).toBe(false);
      } finally {
        chmodSync(vault, 0o755);
      }
    },
  );

  test("the prefix survives the branch that zeroes the content", async () => {
    // A directory where active.md belongs makes the regenerate/read arm
    // fail, which is the branch that used to hand back an empty body.
    // The constitution must still reach the caller.
    writeRules(RULES);
    mkdirSync(join(vault, "Brain", "active.md"));
    const out = await callContext();
    expect(out["error"]).toBeDefined();
    const content = out["content"] as string;
    expect(content.startsWith(STANDING_RULES_HEADER)).toBe(true);
    expect(content).toContain(RULES);
    expect((out["standing_rules"] as StandingRulesField).content).toBe(RULES);
  });
});

/**
 * Defect closed alongside U8: `brain_context` swallowed every throw out
 * of `readVaultInstructionFile` into `null`, so the field simply
 * vanished from the response and the operator was told nothing. The
 * reachable case is an instruction file that EXISTS and cannot be read -
 * the reader itself used to answer that with `null` too, which put a
 * permission error and a vault with no instruction file on the same
 * wire. Both layers now speak.
 */
describe("brain_context surfaces vault-instruction read failures", () => {
  const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

  test("a healthy vault reports no instruction error", async () => {
    writeFileSync(join(vault, "VAULT.md"), "# Project context\n");
    const out = await callContext();
    expect("vault_instruction_error" in out).toBe(false);
    expect(out["vault_instruction"]).toBeDefined();
  });

  test("an absent instruction file reports neither the field nor an error", async () => {
    const out = await callContext();
    expect("vault_instruction" in out).toBe(false);
    expect("vault_instruction_error" in out).toBe(false);
  });

  test.skipIf(RUNNING_AS_ROOT)(
    "an unreadable instruction file is named, not reported as absent",
    async () => {
      const path = join(vault, "VAULT.md");
      writeFileSync(path, "# Project context\n");
      chmodSync(path, 0o000);
      try {
        const out = await callContext();
        expect("vault_instruction" in out).toBe(false);
        const message = out["vault_instruction_error"] as string;
        expect(message).toContain(path);
        expect(message.toLowerCase()).toContain("permission denied");
        // Best-effort enrichment: the rest of the envelope still resolves.
        expect(out["present"]).toBe(true);
        expect(out["content"]).toContain("Active Brain Preferences");
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );
});
