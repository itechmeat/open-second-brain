import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MCPServer } from "../../src/mcp/server.ts";
import { ArtifactStore } from "../../src/mcp/artifact-store.ts";

let tmp: string;
let vault: string;
let server: MCPServer;
const RUN_ID = "run-fetch";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-artifact-get-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  server = new MCPServer({ vault }, { artifactRunId: RUN_ID });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function call(args: Record<string, unknown>) {
  return server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "brain_artifact_get", arguments: args },
  });
}

describe("brain_artifact_get", () => {
  test("returns the full stored payload for a known id", async () => {
    // Stage an artifact under the same vault + runId the server uses.
    const helper = new ArtifactStore({ vault, runId: RUN_ID });
    const payload = JSON.stringify({ rows: Array.from({ length: 100 }, (_, i) => i) });
    const stored = helper.put(payload);

    const result = await server.callTool("brain_artifact_get", {
      artifact_id: stored.artifactId,
    });
    const sc = result["structuredContent"] as Record<string, unknown>;
    expect(sc["artifact_id"]).toBe(stored.artifactId);
    expect(sc["full_chars"]).toBe(payload.length);
    expect(sc["content"]).toBe(payload);
  });

  test("unknown id yields a tool-level error envelope, not a thrown 500", async () => {
    const res = await call({ artifact_id: "deadbeefdeadbeef" });
    expect(res).not.toBeNull();
    const result = res!.result as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
  });

  test("a path-traversal id is rejected", async () => {
    const res = await call({ artifact_id: "../../etc/passwd" });
    expect(res).not.toBeNull();
    // Either a JSON-RPC error frame or a tool-level error envelope is fine,
    // as long as it is not a successful fetch.
    const errored =
      res!.error !== undefined ||
      (res!.result as Record<string, unknown> | undefined)?.["isError"] === true;
    expect(errored).toBe(true);
  });

  test("is advertised in full scope but not in writer scope", () => {
    const full = new MCPServer({ vault }, { scope: "full" });
    const writer = new MCPServer({ vault }, { scope: "writer" });
    expect(full.tools.some((t) => t.name === "brain_artifact_get")).toBe(true);
    expect(writer.tools.some((t) => t.name === "brain_artifact_get")).toBe(false);
  });
});
