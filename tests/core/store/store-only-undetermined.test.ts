/**
 * A vault the process cannot look into shows no `Brain/` folder to
 * `existsSync`, and was taken for a fresh, store-only vault: its writes
 * went into the store on a guess and its readers answered from an empty
 * store. Whether it holds a legacy tree cannot be told, so the store-only
 * predicate says so (`StoreOnlyUndeterminedError`), and readers and
 * writers that branch on it fail with that reason instead of picking a side.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

import { buildDedupIndex } from "../../../src/core/brain/dedup-hash.ts";
import { readLaneText, writeLaneText } from "../../../src/core/store/lane-pages.ts";
import { readSignals } from "../../../src/core/store/read/signals.ts";
import {
  isStoreOnly,
  storeOnlyAnswer,
  storeOnlyMode,
  StoreOnlyUndeterminedError,
} from "../../../src/core/store/store-only.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  if (env !== undefined) chmodSync(env.vault, 0o755);
  env?.cleanup();
  env = undefined;
});

function storeRecordCount(storeRoot: string): number {
  return (["shared", "private"] as const)
    .map((p) => readPartition(join(storeRoot, p)).reduce((n, shard) => n + shard.all.length, 0))
    .reduce((a, b) => a + b, 0);
}

// chmod cannot deny access on Windows or as root (tests/helpers/platform.ts).
test.skipIf(CHMOD_CANNOT_DENY)(
  "a vault that cannot be looked into is neither store-only nor legacy",
  () => {
    env = makeStoreEnv("osb-store-only-undetermined-");
    const { vault, storeRoot } = env;
    const page = join(vault, "Brain", "notes", "guess.md");
    const before = storeRecordCount(storeRoot);
    chmodSync(vault, 0o000);

    const answer = storeOnlyAnswer({ vault });
    expect(answer.reason).toBe("undetermined");
    expect(() => storeOnlyMode({ vault })).toThrow(StoreOnlyUndeterminedError);
    expect(() => isStoreOnly({ vault })).toThrow(/cannot tell whether .* holds a Brain\/ tree/);

    // No write lands in the store on a guess.
    expect(() => writeLaneText(vault, page, "---\ntitle: guess\n---\n\nbody\n")).toThrow(
      StoreOnlyUndeterminedError,
    );
    expect(storeRecordCount(storeRoot)).toBe(before);
    // No reader answers "nothing here" from an empty store.
    expect(() => readLaneText(vault, page)).toThrow(StoreOnlyUndeterminedError);
    expect(() => readSignals({ vault })).toThrow(StoreOnlyUndeterminedError);
    expect(() => buildDedupIndex(vault)).toThrow(StoreOnlyUndeterminedError);

    chmodSync(vault, 0o755);
    expect(existsSync(join(vault, "Brain"))).toBe(true);
    expect(storeOnlyMode({ vault })).toMatchObject({ storeOnly: false, reason: "legacy" });
  },
);

test("a vault with no Brain/ folder is still store-only, and none at all too", () => {
  env = makeStoreEnv("osb-store-only-absent-", { legacyTree: false });
  expect(storeOnlyMode({ vault: env.vault })).toMatchObject({
    storeOnly: true,
    reason: "no-legacy-tree",
  });
  expect(storeOnlyMode({ vault: join(env.parent, "missing") }).reason).toBe("no-legacy-tree");
  expect(storeOnlyMode({ vault: null }).reason).toBe("no-legacy-tree");
  // A path no file can have holds no tree either.
  expect(storeOnlyMode({ vault: "/nonexistent/\0bad" }).reason).toBe("no-legacy-tree");
});
