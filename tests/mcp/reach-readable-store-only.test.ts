/**
 * `readableAtContextReach` on a store-only machine and on a server with
 * no vault: a path that leaves the root is answered before anything is
 * read, and an ordinary vault note outside `Brain/` is still judged by the
 * vault rules (its `visibility:`), not waved through as a lane page.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { noVaultRoot } from "../../src/core/platform-dirs.ts";
import { readableAtContextReach } from "../../src/mcp/brain/reach-readable.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { switchDevice } from "../core/brain/fixtures/memory-twins.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function remote(vault: string | null): ServerContext {
  return {
    vault: vault ?? "",
    vaultOrNull: vault,
    configPath: env!.configPath,
    repoRoot: null,
    agentName: "me-agent",
    reach: TRANSPORT_REACH.remote,
  } as ServerContext;
}

/** A public page in a folder outside `root`, and its path from `root`. */
function besides(root: string): string {
  const dir = join(env!.parent, "beside");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sibling.md"), "---\ntitle: sibling\n---\nbody\n");
  return relative(root, join(dir, "sibling.md"));
}

describe("readableAtContextReach once switched", () => {
  test("a public page beside the vault is not readable at remote reach", () => {
    env = makeStoreEnv("osb-reach-store-only-", { dualWrite: false });
    switchDevice(env);
    expect(readableAtContextReach(remote(env.vault))(besides(env.vault))).toBe(false);
  });

  test("a private vault note outside Brain/ is still withheld at remote reach", () => {
    env = makeStoreEnv("osb-reach-store-only-", { dualWrite: false });
    switchDevice(env);
    mkdirSync(join(env.vault, "Notes"), { recursive: true });
    writeFileSync(join(env.vault, "Notes", "secret.md"), "---\nvisibility: private\n---\nbody\n");
    writeFileSync(join(env.vault, "Notes", "open.md"), "---\ntitle: open\n---\nbody\n");
    const readable = readableAtContextReach(remote(env.vault));
    expect(readable("Notes/secret.md")).toBe(false);
    expect(readable("Notes/open.md")).toBe(true);
  });
});

describe("readableAtContextReach with no vault", () => {
  test("a path that leaves the no-vault root is not readable at remote reach", () => {
    env = makeStoreEnv("osb-reach-no-vault-", { dualWrite: false, configureVault: false });
    const root = noVaultRoot();
    mkdirSync(root, { recursive: true });
    const rel = besides(root);
    expect(rel.startsWith("..")).toBe(true);
    expect(readableAtContextReach(remote(null))(rel)).toBe(false);
    expect(readableAtContextReach(remote(null))(join(env.parent, "beside", "sibling.md"))).toBe(
      false,
    );
  });
});
