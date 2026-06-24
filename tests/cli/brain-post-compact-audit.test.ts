import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePinnedContext, readPinnedContext } from "../../src/core/brain/pinned.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-cli-post-compact-audit-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const PAYLOAD = JSON.stringify({
  session_id: "session-cli",
  messages: [
    { role: "system", content: "[CONTEXT SUMMARY]: Operator set a deployment freeze window." },
    { role: "user", content: "Telemetry stays opt-in for every preset." },
  ],
});

test("default off: post-compact-audit is a no-op without the gate", async () => {
  writePinnedContext(vault, "- Maintain the deployment freeze window.");
  const result = await runCli(["brain", "post-compact-audit", "--vault", vault, "--json"], {
    stdin: PAYLOAD,
    env: { OPEN_SECOND_BRAIN_POST_COMPACT_SURVIVAL_AUDIT: "" },
  });
  expect(result.returncode).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.enabled).toBe(false);
  expect(body.compaction_detected).toBe(false);
  expect(readPinnedContext(vault).content).not.toContain("Re-asserted standing context");
});

test("gated on: re-asserts the drifted anchor from stdin", async () => {
  writePinnedContext(vault, "- Maintain the deployment freeze window.");
  const result = await runCli(["brain", "post-compact-audit", "--vault", vault, "--json"], {
    stdin: PAYLOAD,
    env: { OPEN_SECOND_BRAIN_POST_COMPACT_SURVIVAL_AUDIT: "true" },
  });
  expect(result.returncode).toBe(0);
  expect(result.stderr).toBe("");
  const body = JSON.parse(result.stdout);
  expect(body.enabled).toBe(true);
  expect(body.compaction_detected).toBe(true);
  expect(body.drifted).toEqual(["Maintain the deployment freeze window."]);
  expect(body.reasserted).toBe(true);
  expect(readPinnedContext(vault).content).toContain("Re-asserted standing context");
});

test("--force runs the audit even when the gate is off", async () => {
  writePinnedContext(vault, "- Maintain the deployment freeze window.");
  const result = await runCli(
    ["brain", "post-compact-audit", "--vault", vault, "--force", "--json"],
    { stdin: PAYLOAD, env: { OPEN_SECOND_BRAIN_POST_COMPACT_SURVIVAL_AUDIT: "" } },
  );
  expect(result.returncode).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.compaction_detected).toBe(true);
  expect(body.reasserted).toBe(true);
});
