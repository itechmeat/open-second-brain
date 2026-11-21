/**
 * `o2b mcp` on a vault this process cannot examine.
 *
 * The server used to resolve the token map before it started, and on a
 * vault whose `Brain/` cannot be looked at that read throws the
 * store-only predicate's `StoreOnlyUndeterminedError`: the process printed
 * the "cannot tell" line and exited before `initialize`, so a host saw a
 * dead server. The server must start, list its tools, answer each tool
 * call with `vault_unreadable`, and answer normally once the vault can
 * be read again, with no restart.
 */

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const CLI = join(import.meta.dir, "../../src/cli/main.ts");

let env: StoreEnv | undefined;
afterEach(() => {
  if (env !== undefined) chmodSync(env.vault, 0o755);
  env?.cleanup();
  env = undefined;
});

function frame(id: number, method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

/** The parsed responses on stdout, waited for by id. */
function responses(
  stream: ReadableStream<Uint8Array>,
): (id: number) => Promise<Record<string, any>> {
  const seen = new Map<number, Record<string, any>>();
  const waiting = new Map<number, (r: Record<string, any>) => void>();
  let ended = false;
  const failures: Array<() => void> = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        let parsed: Record<string, any>;
        try {
          parsed = JSON.parse(line) as Record<string, any>;
        } catch {
          continue;
        }
        if (typeof parsed["id"] !== "number") continue;
        seen.set(parsed["id"], parsed);
        waiting.get(parsed["id"])?.(parsed);
      }
    }
    ended = true;
    for (const fail of failures) fail();
  })();
  return (id) =>
    new Promise((done, fail) => {
      const hit = seen.get(id);
      if (hit !== undefined) return done(hit);
      if (ended) return fail(new Error(`the server exited before answering request ${id}`));
      waiting.set(id, done);
      failures.push(() => fail(new Error(`the server exited before answering request ${id}`)));
    });
}

/** The error code a tool result carries, or null for a result that is not an error. */
function toolErrorCode(response: Record<string, any>): string | null {
  const result = response["result"];
  if (result?.["isError"] !== true) return null;
  return result["_meta"]?.["open-second-brain/error"]?.["code"] ?? "untyped";
}

// chmod cannot deny access on Windows or as root (tests/helpers/platform.ts).
test.skipIf(CHMOD_CANNOT_DENY)(
  "the server starts on an unreadable vault, answers vault_unreadable per tool and recovers",
  async () => {
    env = makeStoreEnv("osb-mcp-vault-unreadable-");
    const { vault, configPath } = env;
    chmodSync(vault, 0o000);
    const proc = Bun.spawn([process.execPath, CLI, "mcp", "--config", configPath], {
      env: { ...process.env } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(proc.stderr).text();
    const answer = responses(proc.stdout);
    try {
      proc.stdin.write(
        frame(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      );
      const initialized = await answer(1);
      expect(initialized["result"]?.["serverInfo"]?.["name"]).toBe("open-second-brain");

      proc.stdin.write(frame(2, "tools/list"));
      const listed = (await answer(2))["result"]?.["tools"] as Array<{ name: string }>;
      expect(listed.map((t) => t.name)).toContain("brain_feedback");

      const feedback = {
        name: "brain_feedback",
        arguments: { topic: "style", principle: "prefer tabs", signal: "positive" },
      };
      proc.stdin.write(frame(3, "tools/call", feedback));
      expect(toolErrorCode(await answer(3))).toBe("vault_unreadable");
      proc.stdin.write(frame(4, "tools/call", { name: "second_brain_status", arguments: {} }));
      expect(toolErrorCode(await answer(4))).toBe("vault_unreadable");

      // Readable again: the same process answers, no restart.
      chmodSync(vault, 0o755);
      proc.stdin.write(frame(5, "tools/call", feedback));
      const recovered = await answer(5);
      // A JSON-RPC error carries no result and no tool error code: it must
      // not pass for a recovery.
      expect(recovered["error"]).toBeUndefined();
      expect(recovered["result"]?.["isError"]).not.toBe(true);
      expect(Array.isArray(recovered["result"]?.["content"])).toBe(true);
      expect(toolErrorCode(recovered)).toBeNull();
    } finally {
      proc.stdin.end();
      proc.kill();
      await proc.exited;
    }
    expect(await stderr).not.toContain("cannot tell whether");
  },
);
