/**
 * The supersession chain index on a switched machine whose legacy tree is
 * still in the vault (task 2.10): the memory pages come from the store
 * only, so a stale page the frozen tree still holds (a preference the
 * store no longer has) does not keep resolving; other Brain pages are
 * still walked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildChainLookup } from "../../../../src/core/brain/lifecycle/tombstone.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

describe("the chain lookup once switched", () => {
  test("skips the legacy memory folders and still walks the rest of Brain/", () => {
    env = makeStoreEnv("osb-chain-lookup-", { dualWrite: false });
    const page = (dir: string, id: string) => {
      mkdirSync(join(env!.vault, "Brain", dir), { recursive: true });
      writeFileSync(
        join(env!.vault, "Brain", dir, `${id}.md`),
        `---\nid: ${id}\nsuperseded_by: "[[pref-new]]"\n---\n`,
      );
    };
    page("preferences", "pref-stale");
    page("projects", "plan-old");
    switchDevice(env.storeRoot);
    const lookup = buildChainLookup(env.vault);
    expect(lookup("pref-stale")).toBeNull();
    expect(lookup("plan-old")).toEqual({ supersededBy: "[[pref-new]]" });
  });
});
