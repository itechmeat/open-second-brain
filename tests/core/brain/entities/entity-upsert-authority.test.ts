/**
 * An entity upserted, related or archived by an agent's process over an
 * entity page an operator's command wrote, on a machine whose lane pages
 * live in the store (change `tool-lane-write-keeps-standing`, design D5
 * site 6).
 *
 * `o2b brain entity set` writes the page at authority `human`. The agent's
 * process (channel `mcp-tool`) then rewrites it through the registry:
 * `upsertEntity` with a new alias (the call the entity intake and the
 * label writer make; the `brain_entity` tool itself only reads),
 * `relateEntities` (the entity intake's relation step) and
 * `archiveEntity`. Each rewrite must read back. The control is the same
 * flow on a machine that has not switched.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  archiveEntity,
  getEntity,
  relateEntities,
  upsertEntity,
} from "../../../../src/core/brain/entities/registry.ts";
import { ORIGIN_CHANNEL, setOriginChannel } from "../../../../src/core/origin-channel.ts";
import { parseLanePage } from "../../../../src/core/store/lane-pages.ts";
import { storeOnlyMode } from "../../../../src/core/store/store-only.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice } from "../store-only/fixtures.ts";

const NOW = new Date("2026-06-22T09:00:00Z");

let env: StoreEnv | undefined;

afterEach(() => {
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

function machineFor(machine: "switched" | "unswitched", prefix: string): StoreEnv {
  return machine === "switched" ? switchedMachine(prefix) : unswitchedMachine(`${prefix}legacy-`);
}

/** The operator's own command: `o2b brain entity set people <name>`. Returns the page path. */
async function setThroughCli(configPath: string, name: string): Promise<string> {
  const result = await runCli(["brain", "entity", "set", "people", name, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(result.returncode).toBe(0);
  return (JSON.parse(result.stdout) as { path: string }).path;
}

function caseName(machine: "switched" | "unswitched", what: string): string {
  return machine === "switched"
    ? `on a switched machine ${what}`
    : `control: on a machine that has not switched ${what}`;
}

describe("an entity rewritten by an agent's process over an operator's page", () => {
  for (const machine of ["switched", "unswitched"] as const) {
    test(caseName(machine, "an upsert with a new alias is answered and read back"), async () => {
      env = machineFor(machine, "osb-entity-upsert-authority-");
      await setThroughCli(env.configPath, "Ada Lovelace");

      setOriginChannel(ORIGIN_CHANNEL.mcpTool);
      const upserted = upsertEntity(env.vault, {
        category: "people",
        name: "Ada Lovelace",
        aliases: ["Countess of Lovelace"],
        agent: "claude",
        now: NOW,
      });
      expect({ created: upserted.created, aliases: upserted.entity.aliases }).toEqual({
        created: false,
        aliases: ["Countess of Lovelace"],
      });
      expect(getEntity(env.vault, { query: "Ada Lovelace" })?.aliases).toEqual([
        "Countess of Lovelace",
      ]);
    });

    test(caseName(machine, "a relation between two entities reads back"), async () => {
      env = machineFor(machine, "osb-entity-relate-authority-");
      const adaPath = await setThroughCli(env.configPath, "Ada Lovelace");
      await setThroughCli(env.configPath, "Charles Babbage");
      const babbage = getEntity(env.vault, { query: "Charles Babbage" })!.id;

      setOriginChannel(ORIGIN_CHANNEL.mcpTool);
      relateEntities(env.vault, {
        from: { query: "Ada Lovelace" },
        relation: "related",
        to: { query: "Charles Babbage" },
        now: NOW,
      });
      const [meta] = parseLanePage(env.vault, adaPath);
      expect(meta["related"]).toEqual([`[[${babbage}]]`]);
    });

    test(caseName(machine, "an archive reads back"), async () => {
      env = machineFor(machine, "osb-entity-archive-authority-");
      const adaPath = await setThroughCli(env.configPath, "Ada Lovelace");

      setOriginChannel(ORIGIN_CHANNEL.mcpTool);
      archiveEntity(env.vault, { query: "Ada Lovelace" }, { restore: false, now: NOW });
      const [meta] = parseLanePage(env.vault, adaPath);
      expect(meta["status"]).toBe("archived");
    });
  }
});
