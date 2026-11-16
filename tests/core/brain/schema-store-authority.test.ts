/**
 * Who may change a schema field list on a store-only machine (task 3.12,
 * design D19 item 1): each entry folds as its own register, human over
 * agent, so the writers refuse an agent change the fold would ignore, per
 * entry for an apply and for every entry a whole-list settings write
 * would change, in the normalised form the pack parser reads.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  BrainSettingError,
  getBrainSetting,
  setBrainSetting,
  unsetBrainSetting,
} from "../../../src/core/brain/policy/settings-write.ts";
import { applySchemaAdminMutations } from "../../../src/core/brain/schema-admin.ts";
import type { SchemaMutation } from "../../../src/core/brain/schema-mutate.ts";
import { loadSchemaPack } from "../../../src/core/brain/schema-pack.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const type = (op: "add_type" | "remove_type", token: string): SchemaMutation => ({
  op,
  category: "page_types",
  token,
});

async function apply(
  e: StoreEnv,
  authority: "human" | "agent",
  mutations: SchemaMutation[],
): Promise<void> {
  await applySchemaAdminMutations(e.vault, mutations, { actor: authority, authority });
}

const agentCtx = (e: StoreEnv) => ({ vault: e.vault, authority: "agent" as const, agent: "bot" });

function storeOnly(prefix: string): StoreEnv {
  const e = makeStoreEnv(prefix);
  switchDevice(e.storeRoot);
  return e;
}

/** The review's scenario: the operator removed `paper`, the agent owns the newest entry record. */
async function operatorRemovedPaper(e: StoreEnv): Promise<void> {
  await apply(e, "agent", [type("add_type", "memo")]);
  await apply(e, "human", [type("add_type", "paper")]);
  await apply(e, "human", [type("remove_type", "paper")]);
  await apply(e, "agent", [type("remove_type", "memo")]);
  await apply(e, "agent", [type("add_type", "memo")]);
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof BrainSettingError) return err.code;
    throw err;
  }
}

describe("an agent's whole-list write of a field folded per entry", () => {
  for (const list of [
    ["Paper", "memo"],
    [" paper", "memo"],
    ["paper", "memo"],
  ]) {
    test(`cannot bring back an entry the operator removed: ${JSON.stringify(list)}`, async () => {
      env = storeOnly("osb-schema-authority-list-");
      await operatorRemovedPaper(env);
      expect(code(() => setBrainSetting(agentCtx(env!), "schema.page_types", list))).toBe(
        "human_value_in_force",
      );
      expect(loadSchemaPack(env.vault).declarations.page_types).toEqual(["memo"]);
    });
  }

  test("an agent unset that would remove a human entry is refused", async () => {
    env = storeOnly("osb-schema-authority-unset-");
    await apply(env, "human", [type("add_type", "paper")]);
    await apply(env, "agent", [type("add_type", "memo")]);
    expect(code(() => unsetBrainSetting(agentCtx(env!), "schema.page_types"))).toBe(
      "human_value_in_force",
    );
    expect(loadSchemaPack(env.vault).declarations.page_types).toEqual(["paper", "memo"]);
  });

  test("an accepted write reports the value the fold holds, not the one requested", async () => {
    env = storeOnly("osb-schema-authority-report-");
    await apply(env, "agent", [type("add_type", "memo")]);
    const result = setBrainSetting(agentCtx(env), "schema.page_types", ["memo", "Memo", "person"]);
    expect(result.changed).toBe(true);
    const inForce = getBrainSetting({ vault: env.vault }, "schema.page_types").value;
    expect(result.value).toEqual(inForce);
    expect(inForce).toEqual(["Memo", "person"]);
  });
});

describe("an agent apply beside the operator's entries", () => {
  test("an agent may add an entry no human record decides", async () => {
    env = storeOnly("osb-schema-authority-add-");
    await apply(env, "human", [type("add_type", "paper")]);
    await apply(env, "agent", [type("add_type", "extra")]);
    expect(loadSchemaPack(env.vault).declarations.page_types).toEqual(["paper", "extra"]);
  });

  test("an agent may not remove an entry the operator added", async () => {
    env = storeOnly("osb-schema-authority-remove-");
    await apply(env, "human", [type("add_type", "paper")]);
    await apply(env, "agent", [type("add_type", "memo")]);
    await expect(apply(env, "agent", [type("remove_type", "paper")])).rejects.toMatchObject({
      code: "human_value_in_force",
    });
    expect(loadSchemaPack(env.vault).declarations.page_types).toEqual(["paper", "memo"]);
  });

  test("the operator may remove an entry an agent added", async () => {
    env = storeOnly("osb-schema-authority-human-");
    await apply(env, "agent", [type("add_type", "memo")]);
    await apply(env, "human", [type("remove_type", "memo")]);
    expect(loadSchemaPack(env.vault).declarations.page_types).toBeUndefined();
  });
});
