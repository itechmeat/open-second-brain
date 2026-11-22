/**
 * The MCP seam of a machine that has NOT switched to the brain store,
 * whose configured vault folder is gone (an unmounted disk, a renamed
 * folder).
 *
 * Such a machine is not a fresh installation: its brain is somewhere
 * else, and the folder it names is the only trace of where. So
 *
 *  - `brain_context` leads with the notice (the slot the `UNAVAILABLE:`
 *    block uses) and keeps `present: false`;
 *  - every refusal names the missing folder BEFORE any advice to
 *    initialise a new brain - the advice stays, second;
 *  - `brain_doctor` reports the missing folder ahead of the
 *    "brain root absent" entry, whose `o2b brain init` advice stays.
 *
 * The machine with no vault configured beside it keeps today's guidance
 * word for word: there is no folder to be missing, and a fresh
 * installation must not look like a broken one.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { MCPServer } from "../../src/mcp/index.ts";
import {
  MISSING_VAULT_WORDS,
  noVaultConfigured,
  STORE_SHAPES,
  unswitchedVaultGone,
} from "../core/store/fixtures/unswitched-vault-gone.ts";
import type { StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

async function request(server: MCPServer, name: string, args: object) {
  return (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as {
    result?: Record<string, any>;
    error?: { message?: string; data?: { code?: string } };
  };
}

/** The text a tool answered with, or the refusal it refused with. */
function answerOf(response: {
  result?: Record<string, any>;
  error?: { message?: string };
}): string {
  const text = response.result?.["content"] as Array<{ text: string }> | undefined;
  const fromResult = (text ?? []).map((c) => c.text).join("\n");
  return fromResult.length > 0 ? fromResult : (response.error?.message ?? "");
}

for (const shape of STORE_SHAPES) {
  test(`brain_context leads with the notice on an unswitched machine ${shape.label} whose vault folder is gone`, async () => {
    env = unswitchedVaultGone(
      `osb-mcp-gone-${shape.withStore ? "store" : "nostore"}-`,
      shape.withStore,
    );
    const server = new MCPServer(
      { vault: env.vault, configPath: env.configPath },
      { reach: "local" },
    );

    const response = await request(server, "brain_context", {});
    expect(response.error).toBeUndefined();
    const payload = response.result?.["structuredContent"] as Record<string, unknown>;
    // The brain is not there, and it is not a fresh installation either.
    expect(payload?.["present"]).toBe(false);
    const content = String(payload?.["content"] ?? "");
    expect(content.startsWith("UNAVAILABLE: ")).toBe(true);
    for (const word of MISSING_VAULT_WORDS) expect(content).toContain(word);
    // The folder that is gone is not recreated.
    expect(existsSync(env.vault)).toBe(false);
  }, 60_000);

  test(`brain_doctor reports the missing folder ahead of the brain-root-absent entry (${shape.label})`, async () => {
    env = unswitchedVaultGone(
      `osb-mcp-gone-doctor-${shape.withStore ? "store" : "nostore"}-`,
      shape.withStore,
    );
    const server = new MCPServer(
      { vault: env.vault, configPath: env.configPath },
      { reach: "local" },
    );

    const response = await request(server, "brain_doctor", {});
    expect(response.error).toBeUndefined();
    const payload = response.result?.["structuredContent"] as Record<string, unknown>;
    const warnings = (payload?.["warnings"] ?? []) as Array<Record<string, unknown>>;
    // The missing folder is the FIRST finding.
    expect(warnings[0]?.["code"]).toBe("vault-folder-missing");
    for (const word of MISSING_VAULT_WORDS)
      expect(String(warnings[0]?.["message"])).toContain(word);
    expect(warnings[0]?.["next_command"]).toBe("o2b status");
    // The brain-root-absent finding and its advice stay, second.
    const absent = warnings.find((w) => w["code"] === "brain-root-absent");
    expect(absent).toBeDefined();
    expect(absent?.["next_command"]).toBe("o2b brain init");
    expect(warnings.indexOf(absent!)).toBeGreaterThan(0);
  }, 60_000);

  test(`a write refusal names the missing folder before the store advice (${shape.label})`, async () => {
    env = unswitchedVaultGone(
      `osb-mcp-gone-write-${shape.withStore ? "store" : "nostore"}-`,
      shape.withStore,
    );
    const server = new MCPServer(
      { vault: env.vault, configPath: env.configPath },
      { reach: "local" },
    );

    const response = await request(server, "brain_feedback", {
      topic: "tabs",
      principle: "Prefer tabs.",
      signal: "positive",
    });
    // With a store the write answers; without one it refuses. Both are
    // pinned on the same point: a refusal names the missing folder first.
    if (shape.withStore) {
      expect(response.error).toBeUndefined();
    } else {
      const text = answerOf(response);
      expect(text).toContain("is missing");
      expect(text.indexOf("is missing")).toBeLessThan(text.indexOf("o2b store init"));
    }
  }, 60_000);
}

// ----- The refusals, on the machine without a store -------------------------

test("every refusal names the missing folder before the advice to initialise", async () => {
  env = unswitchedVaultGone("osb-mcp-gone-refusals-", false);
  const server = new MCPServer(
    { vault: env.vault, configPath: env.configPath },
    { reach: "local" },
  );

  // The search refuses on a missing index; the refusal must name the
  // missing folder first, and the `o2b search index` advice stays.
  const search = await request(server, "brain_search", { query: "tabs" });
  const searchText = answerOf(search);
  expect(searchText).toContain("is missing");
  expect(searchText.indexOf("is missing")).toBeLessThan(searchText.indexOf("o2b search index"));

  // The write refuses on the missing store; the advice stays, second.
  const feedback = await request(server, "brain_feedback", {
    topic: "tabs",
    principle: "Prefer tabs.",
    signal: "positive",
  });
  const feedbackText = answerOf(feedback);
  expect(feedbackText).toContain("is missing");
  expect(feedbackText.indexOf("is missing")).toBeLessThan(feedbackText.indexOf("o2b store init"));
}, 60_000);

// ----- The machine beside it: no vault configured ---------------------------

for (const shape of STORE_SHAPES) {
  test(`a machine with no vault configured keeps today's guidance (${shape.label})`, async () => {
    env = noVaultConfigured(
      `osb-mcp-novault-${shape.withStore ? "store" : "nostore"}-`,
      shape.withStore,
    );
    const server = new MCPServer({ vault: null, configPath: env.configPath }, { reach: "local" });

    const context = await request(server, "brain_context", {});
    expect(context.error).toBeUndefined();
    const payload = context.result?.["structuredContent"] as Record<string, unknown>;
    expect(String(payload?.["content"] ?? "")).not.toContain("is missing");

    const doctor = await request(server, "brain_doctor", {});
    const doctorPayload = doctor.result?.["structuredContent"] as Record<string, unknown>;
    const warnings = (doctorPayload?.["warnings"] ?? []) as Array<Record<string, unknown>>;
    expect(warnings.map((w) => w["code"])).not.toContain("vault-folder-missing");

    const feedback = await request(server, "brain_feedback", {
      topic: "tabs",
      principle: "Prefer tabs.",
      signal: "positive",
    });
    // Without a store the refusal is today's refusal, word for word: the
    // store advice, with no notice in front of it.
    if (!shape.withStore) {
      const text = answerOf(feedback);
      expect(text).toContain("run `o2b store init`");
      expect(text).not.toContain("is missing");
    }
  }, 60_000);
}
