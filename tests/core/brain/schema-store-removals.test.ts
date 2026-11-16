/**
 * Removals on a store-only machine (task 3.12, design D19 item 1): the
 * cascade of `remove_link_type` reaches the field lists the store holds,
 * and a removal no audited apply wrote is reported even when it empties
 * the last schema field, so the pack reads as absent.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { applySchemaAdminMutations } from "../../../src/core/brain/schema-admin.ts";
import {
  assessSchemaPackIntegrity,
  SCHEMA_DECIDED_RECORDS_FIELD,
} from "../../../src/core/brain/schema-integrity.ts";
import type { SchemaMutation } from "../../../src/core/brain/schema-mutate.ts";
import { loadSchemaPack } from "../../../src/core/brain/schema-pack.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { SETTING_ENTRY_KIND } from "../../../src/core/store/constants.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { twoMachines, use, type Machine } from "./store-only/two-machines.ts";

/** The link type the removal case keeps. */
const DEPENDS_ON = "depends_on";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
  setSystemTime();
});

/** A fixed clock past the fixtures' own wall time: each step is one second after the one before. */
let step = 0;
function tick(): Date {
  step += 1;
  const now = new Date(Date.UTC(2030, 0, 1, 12, 0, step));
  setSystemTime(now);
  return now;
}

async function apply(m: Machine, mutations: SchemaMutation[]): Promise<void> {
  use(m);
  const now = tick();
  await applySchemaAdminMutations(m.vault, mutations, {
    actor: m.device,
    now,
    authority: "human",
  });
}

/** One `setting-entry` record written past the audited apply path. */
function rawEntry(m: Machine, key: string, entry: string, present: boolean): string {
  use(m);
  tick();
  return appendRecord(openStore({ root: m.storeRoot, device: m.device }), {
    partition: "shared",
    stream: "settings",
    kind: SETTING_ENTRY_KIND,
    agent: "other-tool",
    body: { authority: "human", key, entry, present },
  }).record.id;
}

describe("remove_link_type on a store-only machine", () => {
  test("drops the pairs of other link types that name it, and the pack stays attested", async () => {
    env = makeStoreEnv("osb-schema-removals-link-");
    const [a] = twoMachines(env);
    await apply(a, [
      { op: "add_type", category: "page_types", token: "paper" },
      { op: "add_link_type", token: "cites" },
      { op: "add_link_type", token: DEPENDS_ON },
      { op: "add_link_constraint", link_type: "depends_on", source: "paper", target: "paper" },
      { op: "add_link_constraint", link_type: "depends_on", source: "cites", target: "paper" },
    ]);
    await apply(a, [{ op: "remove_link_type", token: "cites" }]);
    use(a);
    const pack = loadSchemaPack(a.vault);
    expect(pack.link_types).toEqual(["depends_on"]);
    expect(pack.link_constraints).toEqual({ depends_on: ["paper->paper"] });
    expect(assessSchemaPackIntegrity(a.vault).status).toBe("ok");
  });
});

describe("a removal that empties the last schema field", () => {
  test("an unattested removal is reported though the pack reads as absent", async () => {
    env = makeStoreEnv("osb-schema-removals-unattested-");
    const [a] = twoMachines(env);
    await apply(a, [{ op: "add_type", category: "page_types", token: "paper" }]);
    const forged = rawEntry(a, "brain.schema.page_types", "paper", false);
    use(a);
    expect(loadSchemaPack(a.vault).declarations.page_types).toBeUndefined();
    const integrity = assessSchemaPackIntegrity(a.vault);
    expect(integrity.status).toBe("modified");
    expect(integrity.digest).toBeNull();
    expect(integrity.unverified_reason).toBeUndefined();
    expect(integrity.mismatches).toEqual([
      {
        field: SCHEMA_DECIDED_RECORDS_FIELD,
        expected: "every deciding record attested by an audit row",
        actual: `unattested: ${forged}`,
      },
    ]);
  });

  test("an audited removal leaves the absent pack unverified", async () => {
    env = makeStoreEnv("osb-schema-removals-audited-");
    const [a] = twoMachines(env);
    await apply(a, [{ op: "add_type", category: "page_types", token: "paper" }]);
    await apply(a, [{ op: "remove_type", category: "page_types", token: "paper" }]);
    use(a);
    const integrity = assessSchemaPackIntegrity(a.vault);
    expect(integrity).toMatchObject({
      status: "unverified",
      digest: null,
      unverified_reason: "config-absent",
      mismatches: [],
    });
  });
});
