/**
 * The provider registries work with no vault in both directions: a
 * provider added with no vault is found with no vault, in this machine's
 * device-local state.
 */
import { afterEach, expect, test } from "bun:test";

import {
  addProviderProfile,
  getProviderProfile,
  removeProviderProfile,
} from "../../../src/core/search/embeddings/registry.ts";
import {
  addRerankProviderProfile,
  loadRerankRegistry,
} from "../../../src/core/search/rerank/registry.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test("add, look up and remove a provider with no vault", () => {
  env = makeStoreEnv("osb-registry-novault-", { legacyTree: false, configureVault: false });
  const profile = {
    name: "mine",
    baseUrl: "http://127.0.0.1:9/v1",
    defaultModel: "m",
    envKey: "K",
  };
  addProviderProfile(null, profile);
  expect(getProviderProfile(null, "mine")).toEqual(profile);
  expect(removeProviderProfile(null, "mine").removed).toBe(true);
  addRerankProviderProfile(null, { ...profile, name: "rr" });
  expect(loadRerankRegistry(null).map((p) => p.name)).toEqual(["rr"]);
});
