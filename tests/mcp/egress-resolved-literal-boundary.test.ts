/**
 * The WIRED resolved-literal boundaries (trust-surface-hardening review,
 * major fix): the mechanism was already unit-tested in
 * `tests/core/egress-resolved-literals.test.ts`, but no production caller
 * ever passed `resolvedLiterals`, so the redaction never fired at any
 * boundary. These tests drive the real compositions - the MCP status
 * tool's config-mapping redaction, the one builder every JSON-RPC error
 * answer passes through, and the server's tools/call error envelope - over
 * a vault whose custody store holds the values, and prove a store-resolved
 * value is scrubbed where the bytes leave for model context.
 *
 * The honest degrades are pinned next to the wiring: an absent, empty or
 * LOCKED store contributes nothing, and the boundary then answers exactly
 * as the pre-literal redactor did - a boundary that cannot know the vault's
 * values must not pretend to redact them.
 *
 * Every credential-shaped string below is assembled at runtime via the
 * fake-credentials helper.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setSecret, secretsDir } from "../../src/core/brain/secrets/store.ts";
import { lockSecretKeyfile, unlockSecretKeyfile } from "../../src/core/brain/secrets/store.ts";
import { redactErrorForCaller } from "../../src/mcp/error-redaction.ts";
import { internalErrorResponse, MCPServer } from "../../src/mcp/server.ts";
import { REDACTION_PLACEHOLDER } from "../../src/core/redactor.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

const NOW = new Date("2026-06-05T10:00:00Z");
// Quiet shapes on purpose: no vendor prefix, no long digit run, so the
// structural passes alone leave the value untouched and the test isolates
// the literal pass.
const STORED = fakeCredential("alpha-gamma-", "epsilon-theta-eta-iota");

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-egress-boundary-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  for (const k of [
    "VAULT_DIR",
    "VAULT_AGENT_NAME",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS",
    "OPEN_SECOND_BRAIN_MCP_ROUTE_METRICS_ENABLED",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function storeCredential(): void {
  setSecret(vault, { name: "quiet_value", value: STORED, agent: "tester", now: NOW });
}

function writeMachineConfig(body: string): void {
  writeFileSync(configPath, body, "utf8");
}

describe("second_brain_status config mapping (real boundary)", () => {
  test("a store-resolved value that reached the config snapshot is scrubbed in the payload", async () => {
    storeCredential();
    // The quiet key name is exactly the case the structural passes miss:
    // the credential rides under a name that declares nothing.
    writeMachineConfig(`vault: ${JSON.stringify(vault)}\nquiet_note: ${JSON.stringify(STORED)}\n`);
    const server = new MCPServer({ vault, configPath });
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: "status-1",
      method: "tools/call",
      params: { name: "second_brain_status", arguments: {} },
    });
    const rendered = JSON.stringify(response);
    expect(rendered).not.toContain(STORED);
    expect(rendered).toContain(REDACTION_PLACEHOLDER);
  });

  test("without a custody store the mapping answers byte-identically to the bare redactor", async () => {
    // No storeCredential(): the same config value is NOT a known literal,
    // so the pre-literal behaviour is pinned, not the leak.
    writeMachineConfig(`vault: ${JSON.stringify(vault)}\nquiet_note: ${JSON.stringify(STORED)}\n`);
    const server = new MCPServer({ vault, configPath });
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: "status-2",
      method: "tools/call",
      params: { name: "second_brain_status", arguments: {} },
    });
    expect(JSON.stringify(response)).toContain(STORED);
  });
});

describe("the JSON-RPC internal error boundary (real composition)", () => {
  test("an error naming a store-resolved value leaves without it", () => {
    storeCredential();
    const response = internalErrorResponse(
      "err-1",
      new Error(`upstream probe failed: ${STORED} refused`),
      vault,
      TRANSPORT_REACH.remote,
    );
    const rendered = JSON.stringify(response);
    expect(rendered).not.toContain(STORED);
    expect(rendered).toContain(REDACTION_PLACEHOLDER);
  });

  test("a locked store contributes nothing: the answer is byte-identical to the bare redactor", () => {
    storeCredential();
    const passphrase = fakeCredential("boundary-wrap-", "phrase-5c2a");
    unlockSecretKeyfile(vault, passphrase, { agent: "tester", now: NOW });
    lockSecretKeyfile(vault, { agent: "tester", now: NOW });
    const raw = `upstream probe failed: ${STORED} refused`;
    const response = internalErrorResponse("err-2", new Error(raw), vault, TRANSPORT_REACH.remote);
    // A boundary that cannot know the values (the store is locked) must
    // not pretend: the message is exactly what the three-argument redactor
    // always produced, marker for marker.
    expect(response.error?.message).toBe(
      `internal error: ${redactErrorForCaller(raw, vault, TRANSPORT_REACH.remote)}`,
    );
    expect(response.error?.message).toContain(STORED);
  });

  test("a missing keyfile contributes nothing and the scan mints no keyfile", () => {
    // The locked state's sibling: the per-secret resolve now refuses the
    // missing-keyfile state by name, the scan swallows it like any other
    // per-entry refusal, and the boundary answers byte-identically to the
    // bare redactor - leaving no custody state behind.
    storeCredential();
    rmSync(join(secretsDir(vault), "keyfile"));
    const raw = `upstream probe failed: ${STORED} refused`;
    const response = internalErrorResponse("err-3", new Error(raw), vault, TRANSPORT_REACH.remote);
    expect(response.error?.message).toBe(
      `internal error: ${redactErrorForCaller(raw, vault, TRANSPORT_REACH.remote)}`,
    );
    expect(response.error?.message).toContain(STORED);
    expect(existsSync(join(secretsDir(vault), "keyfile"))).toBe(false);
  });

  test("an empty store contributes nothing: the answer is byte-identical to the bare redactor", () => {
    const raw = `upstream probe failed: ${STORED} refused`;
    const response = internalErrorResponse("err-4", new Error(raw), vault, TRANSPORT_REACH.remote);
    expect(response.error?.message).toBe(
      `internal error: ${redactErrorForCaller(raw, vault, TRANSPORT_REACH.remote)}`,
    );
  });

  test("the tools/call error envelope scrubs the literal at remote reach", async () => {
    storeCredential();
    writeMachineConfig(`vault: ${JSON.stringify(vault)}\n`);
    const server = new MCPServer(
      { vault, configPath, repoRoot: null },
      { reach: TRANSPORT_REACH.remote },
    );
    // `artifact_get` on a well-formed but absent id throws the plain Error
    // `unknown or expired artifact_id: <id>` - the caller-controlled echo
    // the tools/call catch redacts before the envelope leaves.
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "brain_artifact_get", arguments: { artifact_id: `probe-${STORED}` } },
    });
    const rendered = JSON.stringify(response);
    expect(rendered).not.toContain(STORED);
    expect(rendered).toContain(REDACTION_PLACEHOLDER);
  });
});
