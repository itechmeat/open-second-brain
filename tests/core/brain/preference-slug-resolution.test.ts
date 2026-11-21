/**
 * The slug a rule derived from a topic files under meets the rule an older
 * release filed under the Latin-only slug, wherever the rule lives: a page
 * of the vault, the store's fold on a switched machine, or the store with
 * no vault at all. Only the same topic (by `topicKey`, the identity the
 * dream pass groups topics by) meets it; a topic that merely keys alike,
 * an old slug no rule can hold (`con`), and a rule the caller may not read
 * all answer as an absent rule.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  moveToRetired,
  resolvePreferenceSlug,
  writePreference,
} from "../../../src/core/brain/preference.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

const TOPIC = "Проект release";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

/** A rule for `topic` under the slug an older release gave it (`release`). */
function storeOldRule(vault: string | null, topic = TOPIC) {
  return writePreference(vault, {
    slug: "release",
    topic,
    principle: "Ship the release notes with every tag.",
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-02T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-02T00:00:00Z",
    evidenced_by: ["[[sig-x]]"],
  });
}

/** The vault a setup's writers and lookups take: none on a vaultless machine. */
function vaultFor(vaultless: boolean): string | null {
  return vaultless ? null : (env?.vault ?? null);
}

/** The slug a rule for `topic` files under, as the given setup resolves it. */
function resolveIn(vaultless: boolean, topic: string, readable?: (rel: string) => boolean) {
  return resolvePreferenceSlug(vaultFor(vaultless), topic, env!.configPath, readable);
}

const SETUPS = [
  ["a vault page", () => makeStoreEnv("osb-pref-slug-vault-", { dualWrite: false }), false],
  [
    "a switched vault (the store's fold)",
    () => {
      const e = makeStoreEnv("osb-pref-slug-switched-", { dualWrite: false });
      switchDevice(e.storeRoot);
      return e;
    },
    false,
  ],
  [
    "a machine with no vault",
    () => makeStoreEnv("osb-pref-slug-novault-", { legacyTree: false, configureVault: false }),
    true,
  ],
] as const;

for (const [where, setup, vaultless] of SETUPS) {
  describe(`resolvePreferenceSlug on ${where}`, () => {
    test("the same topic meets its rule under the old slug, live or retired", () => {
      env = setup();
      const written = storeOldRule(vaultFor(vaultless));
      expect(resolveIn(vaultless, TOPIC)).toBe("release");
      expect(resolveIn(vaultless, "проект   release")).toBe("release");
      moveToRetired(vaultFor(vaultless), written.path, "stale-no-evidence", {
        now: new Date("2026-11-07T12:00:00Z"),
        retired_by: "@t",
      });
      expect(resolveIn(vaultless, TOPIC)).toBe("release");
    });

    test("a topic that only keys alike does not reach the rule", () => {
      env = setup();
      storeOldRule(vaultFor(vaultless));
      expect(resolveIn(vaultless, "Проект: release")).toBe("проект-release");
      expect(resolveIn(vaultless, "Тема release")).toBe("тема-release");
    });

    test("a rule the caller may not read answers as an absent one", () => {
      env = setup();
      storeOldRule(vaultFor(vaultless));
      expect(resolveIn(vaultless, TOPIC, (rel) => !rel.endsWith("pref-release.md"))).toBe(
        "проект-release",
      );
    });

    test("an old slug no rule can hold counts as absent", () => {
      env = setup();
      expect(resolveIn(vaultless, "Проект CON")).toBe("проект-con");
    });
  });
}
