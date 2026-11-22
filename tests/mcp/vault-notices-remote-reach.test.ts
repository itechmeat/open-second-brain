/**
 * The two vault notices this change adds, at remote reach: the missing
 * vault of a machine that has NOT switched (`configuredVaultMissing`) and
 * the unreachable vault of a switched one (`servedVault`). Both name the
 * configured vault, a host path, and a caller below local reach never
 * reads a host path (`brain/device-path.ts`).
 *
 * Every tool and every resource is asked once, with no arguments, on each
 * machine shape, and no answer - result, tool error or JSON-RPC refusal -
 * may carry the fixture's root, under which the vault, the store, the
 * home and the config all sit. A local caller keeps the full notice.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, renameSync } from "node:fs";

import { MCPServer } from "../../src/mcp/index.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { unswitchedVaultGone } from "../core/store/fixtures/unswitched-vault-gone.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

let env: StoreEnv | undefined;
const undo: Array<() => void> = [];
afterEach(() => {
  try {
    for (const step of undo.splice(0)) step();
  } finally {
    env?.cleanup();
    env = undefined;
  }
});

/** A switched machine whose vault is cut off in `shape`. */
function switchedMachine(prefix: string, shape: "gone" | "unreadable"): StoreEnv {
  const e = makeStoreEnv(prefix, { legacyTree: false });
  switchDevice(e.storeRoot);
  if (shape === "gone") {
    renameSync(e.vault, `${e.vault}-away`);
  } else {
    chmodSync(e.vault, 0o000);
    undo.push(() => chmodSync(e.vault, 0o755));
  }
  return e;
}

const MACHINES = [
  {
    label: "an unswitched machine without a store whose vault folder is gone",
    skip: false,
    make: () => unswitchedVaultGone("osb-reach-gone-nostore-", false),
  },
  {
    label: "an unswitched machine with a store whose vault folder is gone",
    skip: false,
    make: () => unswitchedVaultGone("osb-reach-gone-store-", true),
  },
  {
    label: "a switched machine whose vault folder is gone",
    skip: false,
    make: () => switchedMachine("osb-reach-switched-gone-", "gone"),
  },
  {
    label: "a switched machine whose vault is at mode 000",
    skip: CHMOD_CANNOT_DENY,
    make: () => switchedMachine("osb-reach-switched-000-", "unreadable"),
  },
] as const;

/**
 * Whether any string in `value` holds `path`, compared decoded: every
 * string is walked as the caller reads it, and a string that is itself
 * JSON (a tool result's text) is walked once more, so a Windows path is
 * never hidden by the backslashes a serialisation escapes.
 */
function holdsPath(value: unknown, path: string): boolean {
  if (typeof value === "string") {
    if (value.includes(path)) return true;
    try {
      const inner: unknown = JSON.parse(value);
      return typeof inner === "object" && inner !== null && holdsPath(inner, path);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some((item) => holdsPath(item, path));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, item]) => holdsPath(key, path) || holdsPath(item, path),
    );
  }
  return false;
}

test("the sweep finds a path however deep the answer serialises it", () => {
  const path = String.raw`C:\Users\someone\osb-reach-x`;
  const nested = { result: { content: [{ text: JSON.stringify({ note: `at ${path}` }) }] } };
  expect(JSON.stringify(nested).includes(path)).toBe(false);
  expect(holdsPath(nested, path)).toBe(true);
  expect(holdsPath({ result: { content: [{ text: "clean" }] } }, path)).toBe(false);
});

async function rpc(server: MCPServer, method: string, params: object): Promise<any> {
  return server.handleRequest({ jsonrpc: "2.0", id: 1, method, params });
}

for (const { label, skip, make } of MACHINES) {
  test.skipIf(skip)(
    `at remote reach no answer names a host path on ${label}`,
    async () => {
      env = make();
      const server = new MCPServer(
        { vault: env.vault, configPath: env.configPath },
        { reach: "remote" },
      );
      const leaks: string[] = [];
      const tools = (await rpc(server, "tools/list", {})).result.tools as Array<{ name: string }>;
      for (const { name } of tools) {
        // eslint-disable-next-line no-await-in-loop
        const answer = await rpc(server, "tools/call", { name, arguments: {} });
        if (holdsPath(answer, env.parent))
          leaks.push(`${name}: ${JSON.stringify(answer).slice(0, 300)}`);
      }
      const resources = (await rpc(server, "resources/list", {})).result.resources as Array<{
        uri: string;
      }>;
      for (const { uri } of resources) {
        // eslint-disable-next-line no-await-in-loop
        const answer = await rpc(server, "resources/read", { uri });
        if (holdsPath(answer, env.parent))
          leaks.push(`${uri}: ${JSON.stringify(answer).slice(0, 300)}`);
      }
      expect(leaks).toEqual([]);
    },
    120_000,
  );
}

test("a tool error keeps the missing-vault notice, with the vault named only at local reach", async () => {
  env = unswitchedVaultGone("osb-reach-gone-notice-", false);
  const answerAt = async (reach: "local" | "remote"): Promise<string> => {
    const server = new MCPServer({ vault: env!.vault, configPath: env!.configPath }, { reach });
    // A tool that fails with a plain exception, not a typed refusal.
    const response = await rpc(server, "tools/call", { name: "brain_watchdog", arguments: {} });
    expect(response.result?.isError).toBe(true);
    return (response.result.content as Array<{ text: string }>).map((c) => c.text).join("\n");
  };
  const local = await answerAt("local");
  expect(local.startsWith(`the configured vault folder ${env.vault} is missing`)).toBe(true);
  const remote = await answerAt("remote");
  expect(remote.startsWith("the configured vault folder <vault> is missing")).toBe(true);
  expect(remote).not.toContain(env.parent);
}, 60_000);
