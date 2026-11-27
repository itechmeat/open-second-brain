/**
 * An entity upsert builds on the entity it locked (change
 * `tool-lane-write-keeps-standing`, design D2 item 5, spec "An entity
 * upsert builds on the entity it locked").
 *
 * The registry resolves an upsert's target from the entity index before it
 * takes the page's lock. Another version of the entity, with an alias of
 * its own, written after that index read and before the lock, must be kept:
 * the upsert writes both that alias and its own. The race is placed with a
 * test double of `buildEntityIndex` that answers the index taken before
 * the other version was written; every other export of the module is the
 * real one, and the double answers the real index whenever no stale index
 * is set.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import * as indexBuilder from "../../../../src/core/brain/entities/index-builder.ts";
import type { EntityIndex } from "../../../../src/core/brain/entities/index-builder.ts";
import { ORIGIN_CHANNEL, setOriginChannel } from "../../../../src/core/origin-channel.ts";
import { storeOnlyMode } from "../../../../src/core/store/store-only.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice } from "../store-only/fixtures.ts";

const real = { ...indexBuilder };
/** The index the registry's next index reads answer with, or null for the real one. */
let staleIndex: EntityIndex | null = null;
mock.module("../../../../src/core/brain/entities/index-builder.ts", () => ({
  ...real,
  buildEntityIndex: (...args: Parameters<typeof real.buildEntityIndex>) =>
    staleIndex ?? real.buildEntityIndex(...args),
}));

const { getEntity, upsertEntity } = await import("../../../../src/core/brain/entities/registry.ts");

const NOW = new Date("2026-06-22T09:00:00Z");
const NAME = "Ada Lovelace";
const FIRST_ALIAS = "Countess of Lovelace";
const OTHER_ALIAS = "Augusta Ada King";
const OWN_ALIAS = "Lady Lovelace";

let env: StoreEnv | undefined;

afterEach(() => {
  staleIndex = null;
  env?.cleanup();
  env = undefined;
});

/** A machine whose lane pages live in the store: switched, no legacy tree. */
function switchedMachine(prefix: string): StoreEnv {
  const made = makeStoreEnv(prefix, { legacyTree: false });
  // This device's own `device-switched` record, as the migration writes it.
  switchDevice(made.storeRoot);
  expect(storeOnlyMode({ vault: made.vault })).toMatchObject({
    storeOnly: true,
    reason: "device-switched",
  });
  return made;
}

/** A machine that has not switched: a legacy `Brain/` tree, pages are files. */
function unswitchedMachine(prefix: string): StoreEnv {
  const made = makeStoreEnv(prefix);
  expect(storeOnlyMode({ vault: made.vault })).toMatchObject({
    storeOnly: false,
    reason: "legacy",
  });
  return made;
}

/** The operator's own command: `o2b brain entity set people <name> --alias <alias>`. */
async function setThroughCli(configPath: string, alias: string): Promise<void> {
  const result = await runCli(["brain", "entity", "set", "people", NAME, "--alias", alias], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(result.returncode).toBe(0);
}

describe("an entity upsert builds on the entity it locked", () => {
  for (const machine of ["switched", "unswitched"] as const) {
    const name =
      machine === "switched"
        ? "on a switched machine a version written after the index read keeps its alias"
        : "control: on a machine that has not switched a version written after the index read keeps its alias";
    test(name, async () => {
      env =
        machine === "switched"
          ? switchedMachine("osb-entity-upsert-lock-")
          : unswitchedMachine("osb-entity-upsert-lock-legacy-");
      await setThroughCli(env.configPath, FIRST_ALIAS);
      // The index the agent's upsert resolves its target from.
      const before = real.buildEntityIndex(env.vault);
      // Another version, with an alias of its own, lands before the lock.
      await setThroughCli(env.configPath, OTHER_ALIAS);

      setOriginChannel(ORIGIN_CHANNEL.mcpTool);
      staleIndex = before;
      const upserted = upsertEntity(env.vault, {
        category: "people",
        name: NAME,
        aliases: [OWN_ALIAS],
        agent: "claude",
        now: NOW,
      });
      staleIndex = null;

      const expected = [FIRST_ALIAS, OTHER_ALIAS, OWN_ALIAS].toSorted();
      expect({
        created: upserted.created,
        answered: [...upserted.entity.aliases].toSorted(),
        read: [...(getEntity(env.vault, { query: NAME })?.aliases ?? [])].toSorted(),
      }).toEqual({ created: false, answered: expected, read: expected });
    });
  }
});
