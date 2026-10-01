/**
 * `/health` reports the process-level fault counts when the CLI hands
 * the transport a getter for them, and stays exactly as it was without
 * one, so a supervisor already parsing the body sees no change.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHttp, type HttpServerHandle, type McpFaultCounts } from "../../src/mcp/http.ts";

const temps: string[] = [];
const handles: HttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

async function serve(faultCounts?: () => McpFaultCounts): Promise<HttpServerHandle> {
  const vault = mkdtempSync(join(tmpdir(), "osb-mcp-health-faults-"));
  temps.push(vault);
  const handle = await startHttp(
    { vault },
    { port: 0, ...(faultCounts !== undefined ? { faultCounts } : {}) },
  );
  handles.push(handle);
  return handle;
}

async function health(handle: HttpServerHandle): Promise<Record<string, unknown>> {
  const res = await fetch(`${handle.url}/health`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("/health fault counts", () => {
  test("carries the counts the injected getter returns, read per request", async () => {
    let counts: McpFaultCounts = {
      unhandled_rejection: 0,
      uncaught_exception: 0,
      last_fault_at: null,
    };
    const handle = await serve(() => counts);
    expect((await health(handle))["faults"]).toEqual(counts);

    counts = {
      unhandled_rejection: 3,
      uncaught_exception: 0,
      last_fault_at: "2026-10-01T03:00:00.000Z",
    };
    const body = await health(handle);
    expect(body["faults"]).toEqual(counts);
    // The drain fields are unchanged beside it.
    expect(body["status"]).toBe("ok");
    expect(body["transport"]).toBe("http");
    expect(body["in_flight"]).toBe(0);
  });

  test("without a getter the body has no faults field", async () => {
    const handle = await serve();
    const body = await health(handle);
    expect(Object.keys(body).toSorted()).toEqual(["in_flight", "status", "transport"]);
  });
});
