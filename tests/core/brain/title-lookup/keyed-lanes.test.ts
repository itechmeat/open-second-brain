/**
 * The lanes whose records a topic names by a looser identity than the
 * exact title (preferences, by `topicKey`; captured ideas, by keying
 * alike), as one table over where the record lives: a vault page, the
 * store's fold on a switched machine, the store with no vault at all.
 *
 * 1. The caller's reach is asked of the record that exists (live or
 *    retired), never of a path no record has: a store holds one of the
 *    two, and an absent page is not a withheld one.
 * 2. A topic never selects another record that sits at its new slug when
 *    its own record is under its old slug.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  moveToRetired,
  resolvePreferenceSlug,
  writePreference,
} from "../../../../src/core/brain/preference.ts";
import { preferencePathOf, retiredPathOf } from "../../../../src/core/brain/paths.ts";
import { resolveTitleSlug, slugify } from "../../../../src/core/vault.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice } from "../store-only/fixtures.ts";

const TOPIC = "Проект release";
const FIXED = "远程办公提高长期效率";
const KEYED = `${FIXED}!`;

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function rule(vault: string | null, slug: string, topic: string) {
  return writePreference(vault, {
    slug,
    topic,
    principle: `Follow ${topic}.`,
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-02T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-02T00:00:00Z",
    evidenced_by: ["[[sig-x]]"],
  });
}

const SETUPS = [
  ["a vault page", () => makeStoreEnv("osb-keyed-vault-", { dualWrite: false }), false],
  [
    "a switched vault (the store's fold)",
    () => {
      const e = makeStoreEnv("osb-keyed-switched-", { dualWrite: false });
      switchDevice(e.storeRoot);
      return e;
    },
    false,
  ],
  [
    "a machine with no vault",
    () => makeStoreEnv("osb-keyed-novault-", { legacyTree: false, configureVault: false }),
    true,
  ],
] as const;

/** The vault a setup's writers and lookups take: none on a vaultless machine. */
function vaultFor(vaultless: boolean): string | null {
  return vaultless ? null : env!.vault;
}

/** The slug a rule for `topic` files under, as the given setup resolves it. */
function resolveIn(vaultless: boolean, topic: string, readable?: (rel: string) => boolean): string {
  return resolvePreferenceSlug(vaultFor(vaultless), topic, env!.configPath, readable);
}

/** A reach that reads exactly the given paths: anything else, absent or not, is refused. */
function only(...rels: string[]): (rel: string) => boolean {
  return (rel) => rels.includes(rel.replaceAll("\\", "/"));
}

for (const [where, setup, vaultless] of SETUPS) {
  describe(`preferences on ${where}`, () => {
    test("a live rule the caller may read is met, though no retired page exists", () => {
      env = setup();
      rule(vaultFor(vaultless), "release", TOPIC);
      expect(resolveIn(vaultless, TOPIC, only(preferencePathOf(null, "release")))).toBe("release");
    });

    test("a retired rule the caller may read is met, though no live page exists", () => {
      env = setup();
      const written = rule(vaultFor(vaultless), "release", TOPIC);
      moveToRetired(vaultFor(vaultless), written.path, "stale-no-evidence", {
        now: new Date("2026-11-07T12:00:00Z"),
        retired_by: "@t",
      });
      expect(resolveIn(vaultless, TOPIC, only(retiredPathOf(null, "release")))).toBe("release");
    });

    test("the rule's own page withheld answers as an absent rule", () => {
      env = setup();
      rule(vaultFor(vaultless), "release", TOPIC);
      expect(resolveIn(vaultless, TOPIC, only(retiredPathOf(null, "release")))).toBe(
        "проект-release",
      );
    });

    test("a topic never selects another rule that sits at its new slug", () => {
      env = setup();
      rule(vaultFor(vaultless), slugify(FIXED), FIXED);
      rule(vaultFor(vaultless), FIXED, KEYED);
      expect(resolveIn(vaultless, FIXED)).toBe(slugify(FIXED));
      expect(resolveIn(vaultless, KEYED)).toBe(FIXED);
    });
  });
}

describe("captured ideas (keying alike, resolveTitleSlug's default)", () => {
  const notes = new Map<string, readonly string[]>([[slugify(FIXED), [FIXED]]]);
  const stored = (slug: string): readonly string[] | null => notes.get(slug) ?? null;

  test("an idea keying like a note an older release filed under its hashed slug joins it", () => {
    expect(resolveTitleSlug(KEYED, stored)).toBe(slugify(FIXED));
  });

  test("an idea that keys like nothing stored takes its own slug", () => {
    expect(resolveTitleSlug("远程办公", stored)).toBe("远程办公");
  });
});
