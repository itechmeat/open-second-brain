/**
 * The transport reach is MINTED, never parsed
 * (private-is-not-a-suggestion, unit 2).
 *
 * Which pages a caller may read now depends on how that caller reached
 * this process. That fact is held by the transport and by nothing else,
 * so each transport mints it and a reach-shaped member in a tool's
 * arguments is refused BY NAME - the rule
 * `src/mcp/owner-scope-refusal.ts` states once for owner identity: a
 * trust claim echoed back from the request is not a trust claim.
 *
 * Refused rather than ignored, because a silently dropped argument
 * answers a question nobody asked, and refused rather than honoured,
 * because honouring it would make the boundary a request parameter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { httpBindReach, startHttp } from "../../src/mcp/http.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import {
  REACH_REFUSAL,
  RESERVED_REACH_ARGUMENTS,
  assertNoCallerSuppliedReach,
  findCallerSuppliedReach,
} from "../../src/mcp/reach-refusal.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { STDIO_TRANSPORT_REACH, serveStdio } from "../../src/mcp/stdio.ts";
import { contextReach } from "../../src/mcp/tool-contract.ts";
import type { ToolDefinition } from "../../src/mcp/tool-contract.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "reach-refusal-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("a context with no minted reach", () => {
  test("fails closed to remote", () => {
    // A hand-built context - an embedded caller, a test - established
    // nothing about who is asking, and an unestablished reach is not the
    // absence of one.
    expect(contextReach({ vault, configPath: null, repoRoot: null })).toBe(TRANSPORT_REACH.remote);
  });

  test("is what a server built without a transport reports", () => {
    expect(contextReach(new MCPServer({ vault }).context)).toBe(TRANSPORT_REACH.remote);
  });
});

describe("a minted reach reaches the handler context", () => {
  for (const reach of [TRANSPORT_REACH.local, TRANSPORT_REACH.remote]) {
    test(`${reach} survives onto ServerContext`, () => {
      const server = new MCPServer({ vault }, { reach });
      expect(contextReach(server.context)).toBe(reach);
    });
  }
});

describe("each transport mints its own reach", () => {
  test("stdio mints local: the caller already started this process", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.resume();
    let minted: string | undefined;
    const loop = serveStdio(
      { vault },
      {
        stdin,
        stdout,
        onStart: (handle) => {
          minted = handle.reach;
        },
      },
    );
    stdin.end();
    await loop;
    expect(minted).toBe(STDIO_TRANSPORT_REACH);
    expect(STDIO_TRANSPORT_REACH).toBe(TRANSPORT_REACH.local);
  });

  test("an HTTP bind mints on the loopback question alone", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]:8080", "LOCALHOST"]) {
      expect(httpBindReach(host)).toBe(TRANSPORT_REACH.local);
    }
    for (const host of ["0.0.0.0", "192.168.1.10", "example.internal", "::"]) {
      expect(httpBindReach(host)).toBe(TRANSPORT_REACH.remote);
    }
  });

  test("a live loopback bind reports the reach it minted", async () => {
    const handle = await startHttp({ vault }, { host: "127.0.0.1", port: 0 });
    try {
      expect(handle.reach).toBe(TRANSPORT_REACH.local);
    } finally {
      await handle.close();
    }
  });

  test("a runtime option cannot override what the transport established", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.resume();
    let minted: string | undefined;
    const loop = serveStdio(
      { vault },
      {
        stdin,
        stdout,
        onStart: (handle) => {
          minted = handle.reach;
        },
      },
      { reach: TRANSPORT_REACH.remote },
    );
    stdin.end();
    await loop;
    expect(minted).toBe(TRANSPORT_REACH.local);
  });
});

/** A tool whose schema is OPEN, so the unknown-argument gate says nothing. */
const OPEN_SCHEMA_TOOL: ToolDefinition = Object.freeze({
  name: "open_schema_probe",
  description: "probe",
  inputSchema: { type: "object", properties: {} },
  handler: () => ({}),
});

describe("a caller-supplied reach is refused by name", () => {
  test("every reserved spelling is found, whatever its case or separator", () => {
    for (const name of RESERVED_REACH_ARGUMENTS) {
      expect(findCallerSuppliedReach({ [name]: TRANSPORT_REACH.local })).toEqual([name]);
    }
    expect(findCallerSuppliedReach({ TRANSPORT_REACH: "local" })).toEqual(["TRANSPORT_REACH"]);
    expect(findCallerSuppliedReach({ "transport-reach": "local" })).toEqual(["transport-reach"]);
  });

  test("an ordinary argument is not mistaken for one", () => {
    // `disclosure` is the progressive result-DEPTH mode and is a real
    // argument on the recall surfaces; refusing it would break them.
    expect(
      findCallerSuppliedReach({ query: "x", disclosure: "cards", visibility: ["team"] }),
    ).toEqual([]);
  });

  test("the refusal names the argument, the reason, and what mints it", () => {
    let thrown: unknown;
    try {
      assertNoCallerSuppliedReach(OPEN_SCHEMA_TOOL, { reach: TRANSPORT_REACH.local });
    } catch (exc) {
      thrown = exc;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    const err = thrown as MCPError;
    expect(err.message).toContain(OPEN_SCHEMA_TOOL.name);
    expect(err.message).toContain("reach");
    expect(err.message).toContain(REACH_REFUSAL);
    const data = err.data as { readonly refused_arguments: ReadonlyArray<string> };
    expect(data.refused_arguments).toEqual(["reach"]);
  });

  test("an open schema is refused too, so this is not the unknown-argument gate", () => {
    // The unknown-argument gate reads `additionalProperties: false` and
    // says nothing about an open schema. This rule does not depend on the
    // schema at all.
    expect(() => assertNoCallerSuppliedReach(OPEN_SCHEMA_TOOL, { reach: "local" })).toThrow(
      MCPError,
    );
    expect(() => assertNoCallerSuppliedReach(OPEN_SCHEMA_TOOL, { query: "x" })).not.toThrow();
  });

  test("the live server refuses it on the tool-call seam", async () => {
    const server = new MCPServer({ vault }, { reach: TRANSPORT_REACH.local });
    await expect(server.callTool("brain_search", { query: "x", reach: "local" })).rejects.toThrow(
      new RegExp(REACH_REFUSAL),
    );
  });
});
