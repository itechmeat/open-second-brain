/**
 * The supersession chain index on a switched machine. Memory pages come
 * from the store's folds and every other page under `Brain/` (a thesis, a
 * plan) is an entry of its lane, so a chain through a lane page resolves
 * from the lane store. The frozen legacy tree a switched machine may
 * still hold is not walked: a page only it holds (a preference or a lane
 * page the store does not have) does not keep resolving.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildChainLookup } from "../../../../src/core/brain/lifecycle/tombstone.ts";
import { resolveChainTip } from "../../../../src/core/brain/lifecycle/tombstone-read.ts";
import { writeLaneText } from "../../../../src/core/store/lane-pages.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

describe("the chain lookup once switched", () => {
  test("reads neither the legacy memory folders nor the legacy lane folders", () => {
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
    // The store holds the plan with no successor; the frozen file says otherwise.
    writeLaneText(
      env.vault,
      join(env.vault, "Brain", "projects", "plan-old.md"),
      "---\nid: plan-old\n---\n",
    );
    const lookup = buildChainLookup(env.vault);
    expect(lookup("pref-stale")).toBeNull();
    expect(lookup("plan-old")).toEqual({ supersededBy: null });
  });

  test("a chain through lane pages resolves from the store on a vault with no Brain/", () => {
    env = makeStoreEnv("osb-chain-lookup-lanes-", { legacyTree: false });
    const { vault } = env;
    const theses = join(vault, "Brain", "theses");
    writeLaneText(
      vault,
      join(theses, "old-claim.md"),
      "---\nsuperseded_by: new-claim\n---\n\nOld.\n",
    );
    writeLaneText(vault, join(theses, "new-claim.md"), "---\ntitle: New\n---\n\nNew.\n");
    expect(existsSync(join(vault, "Brain"))).toBe(false);

    const lookup = buildChainLookup(vault);
    expect(lookup("old-claim")).toEqual({ supersededBy: "new-claim" });
    expect(resolveChainTip("old-claim", lookup)).toEqual({
      tip: "new-claim",
      steps: 1,
      cycle: false,
      resolvedAll: true,
    });
    // The readable filter applies to lane pages as it does to files.
    const hidden = buildChainLookup(vault, (rel) => !rel.endsWith("new-claim.md"));
    expect(hidden("new-claim")).toBeNull();
  });
});
