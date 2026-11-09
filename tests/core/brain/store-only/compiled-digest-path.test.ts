/**
 * Where the compiled digests live (task 2.10, design D14 item 7): a
 * machine with no vault keeps one digest cache whether a caller passes
 * `null` (the MCP server) or the no-vault stand-in path (the hooks), and
 * a switched machine renders on demand even while its vault folder cannot
 * be listed, as the rest of its machine state does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  compiledDigestPath,
  digestsRenderedOnDemand,
} from "../../../../src/core/brain/compiled-digest-path.ts";
import { noVaultRoot } from "../../../../src/core/platform-dirs.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

describe("compiled digest paths", () => {
  test("no vault and its stand-in path share one cache, and a blank vault is no vault", () => {
    env = makeStoreEnv("osb-digest-novault-", { legacyTree: false, configureVault: false });
    const cache = compiledDigestPath(null, "active");
    expect(compiledDigestPath(noVaultRoot(), "active")).toBe(cache);
    expect(compiledDigestPath("", "active")).toBe(cache);
  });

  test("a switched machine whose vault folder is missing still renders on demand", () => {
    env = makeStoreEnv("osb-digest-switched-");
    switchDevice(env.storeRoot);
    const missing = join(env.parent, "unmounted-vault");
    expect(digestsRenderedOnDemand(missing)).toBe(true);
    expect(compiledDigestPath(missing, "lessons").startsWith(missing)).toBe(false);
  });
});
