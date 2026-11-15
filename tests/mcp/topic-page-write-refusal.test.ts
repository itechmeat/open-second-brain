/**
 * A note tool never writes a topic page (task 3.3, spec `topics` "Direct
 * page write is refused"): `brain_create_note` and `brain_update_note`
 * on a path inside the view's topics folder are refused with a message
 * that names the topic event tool to use instead, and the page on disk
 * keeps its bytes. A page beside the view folder is written as before.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { VIEW_TARGET_ENV } from "../../src/core/view/constants.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

const ENV_KEYS = [VIEW_TARGET_ENV, "VAULT_AGENT_NAME", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"];
const saved = new Map<string, string | undefined>();
let tmp: string;
let vault: string;
let configPath: string;

const PAGE_REL = "Views/brain/topics/2026-11-02-brain-store/topic.md";
const PAGE_BYTES =
  "<!-- open-second-brain-view store=x page=topics/2026-11-02-brain-store/topic.md -->\n\n# Brain store\n";

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  tmp = mkdtempSync(join(tmpdir(), "o2b-topic-page-refusal-"));
  vault = join(tmp, "vault");
  for (const dir of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", dir), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  mkdirSync(join(vault, "Views", "brain", "topics", "2026-11-02-brain-store"), { recursive: true });
  writeFileSync(join(vault, PAGE_REL), PAGE_BYTES);
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  delete process.env["VAULT_AGENT_NAME"];
  delete process.env["VAULT_DIR"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  process.env[VIEW_TARGET_ENV] = join(vault, "Views", "brain");
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const server = new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "topic-refusal-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  const out = await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return JSON.stringify(out);
}

describe("note tools on a topic page", () => {
  test("brain_create_note refuses a page in the topics folder and names brain_topic", async () => {
    const rel = "Views/brain/topics/2026-11-03-new/topic.md";
    const text = await callTool("brain_create_note", { path: rel, content: "# Forged" });
    expect(text).toContain("human view folder");
    expect(text).toContain("brain_topic");
    expect(existsSync(join(vault, rel))).toBe(false);
  });

  test("brain_update_note refuses the existing topic page and leaves its bytes", async () => {
    const text = await callTool("brain_update_note", { path: PAGE_REL, content: "# Forged goal" });
    expect(text).toContain("human view folder");
    expect(text).toContain("brain_topic");
    expect(readFileSync(join(vault, PAGE_REL), "utf8")).toBe(PAGE_BYTES);
  });

  test("a note beside the view folder is written as before", async () => {
    await callTool("brain_create_note", { path: "Views/topics-notes.md", content: "mine" });
    expect(readFileSync(join(vault, "Views", "topics-notes.md"), "utf8")).toContain("mine");
  });
});
