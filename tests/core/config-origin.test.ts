/**
 * `CONFIG_ORIGIN` and the provenance-returning sibling of `envOrConfig`.
 *
 * Two properties, and the second is the reason the first is safe to add.
 *
 * The vocabulary follows the house four-piece shape (frozen object,
 * derived union, membership list, guard), so a layer name that survives a
 * round trip through a string is still checkable.
 *
 * The delegation is asserted rather than claimed: `envOrConfig` drives
 * roughly fifty-five keys and did not change signature, so the ONLY thing
 * keeping it honest is that it returns `resolveWithOrigin(...).value`. A
 * reimplementation that drifted on one branch - the empty-string branch
 * is the one that has bitten this repository before - would be invisible
 * at every call site. The table below drives every branch and requires
 * the two functions to agree on all of them.
 */

import { describe, expect, test } from "bun:test";

import {
  CONFIG_ORIGIN,
  CONFIG_ORIGINS,
  envOrConfig,
  isConfigOrigin,
  resolveWithOrigin,
  type ConfigOrigin,
} from "../../src/core/validate.ts";

const ENV_KEY = "OPEN_SECOND_BRAIN_CONFIG_ORIGIN_PROBE";
const CONFIG_KEY = "config_origin_probe";

interface Branch {
  readonly name: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config: Readonly<Record<string, string>>;
  readonly value: string | null;
  readonly origin: ConfigOrigin;
}

/** Every combination of the three states each source can be in. */
const BRANCHES: ReadonlyArray<Branch> = [
  {
    name: "env set, config absent",
    env: { [ENV_KEY]: "from-env" },
    config: {},
    value: "from-env",
    origin: CONFIG_ORIGIN.env,
  },
  {
    name: "env set, config set - env wins",
    env: { [ENV_KEY]: "from-env" },
    config: { [CONFIG_KEY]: "from-config" },
    value: "from-env",
    origin: CONFIG_ORIGIN.env,
  },
  {
    name: "env empty string, config set - config wins",
    env: { [ENV_KEY]: "" },
    config: { [CONFIG_KEY]: "from-config" },
    value: "from-config",
    origin: CONFIG_ORIGIN.userConfig,
  },
  {
    name: "env empty string, config empty string - neither",
    env: { [ENV_KEY]: "" },
    config: { [CONFIG_KEY]: "" },
    value: null,
    origin: CONFIG_ORIGIN.default,
  },
  {
    name: "env absent, config set",
    env: {},
    config: { [CONFIG_KEY]: "from-config" },
    value: "from-config",
    origin: CONFIG_ORIGIN.userConfig,
  },
  {
    name: "env absent, config empty string - neither",
    env: {},
    config: { [CONFIG_KEY]: "" },
    value: null,
    origin: CONFIG_ORIGIN.default,
  },
  {
    name: "neither source has the key",
    env: {},
    config: {},
    value: null,
    origin: CONFIG_ORIGIN.default,
  },
];

describe("CONFIG_ORIGIN vocabulary", () => {
  test("names exactly the four resolution layers", () => {
    expect([...CONFIG_ORIGINS].toSorted()).toEqual([
      "default",
      "env",
      "user-config",
      "vault-config",
    ]);
  });

  test("the membership list is exactly the frozen object's values", () => {
    expect([...CONFIG_ORIGINS].toSorted()).toEqual(Object.values(CONFIG_ORIGIN).toSorted());
    expect(Object.isFrozen(CONFIG_ORIGIN)).toBe(true);
  });

  test("the guard accepts every member and rejects everything else", () => {
    for (const origin of CONFIG_ORIGINS) expect(isConfigOrigin(origin)).toBe(true);
    for (const outsider of ["", "ENV", "config", "vault", null, undefined, 0, {}]) {
      expect(isConfigOrigin(outsider)).toBe(false);
    }
  });
});

describe("resolveWithOrigin", () => {
  for (const branch of BRANCHES) {
    test(`${branch.name} - reports the layer that produced the value`, () => {
      const resolved = resolveWithOrigin(branch.env, branch.config, ENV_KEY, CONFIG_KEY);
      expect(resolved.value).toBe(branch.value);
      expect(resolved.origin).toBe(branch.origin);
    });
  }
});

describe("envOrConfig delegates to resolveWithOrigin", () => {
  for (const branch of BRANCHES) {
    test(`${branch.name} - the two agree on the value`, () => {
      const delegated = envOrConfig(branch.env, branch.config, ENV_KEY, CONFIG_KEY);
      const sibling = resolveWithOrigin(branch.env, branch.config, ENV_KEY, CONFIG_KEY);
      expect(delegated).toBe(sibling.value);
    });
  }
});
