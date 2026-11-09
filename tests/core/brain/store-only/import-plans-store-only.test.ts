/**
 * Re-imports on a store-only machine (task 2.10): the import and the
 * host-memory promotion plan against the store's fold, not the absent
 * preference pages, so an unchanged source is skipped, a changed one
 * keeps its evidence, a retired preference is not resurrected, and the
 * promotion history lives in the device-local state, never under
 * `Brain/`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { promoteHostMemory } from "../../../../src/core/brain/continuity/promote-host-memory.ts";
import { recordHostMemoryWrite } from "../../../../src/core/brain/host-memory-write.ts";
import { importClaudeMemory } from "../../../../src/core/brain/import-claude-memory.ts";
import { preferencePath } from "../../../../src/core/brain/paths.ts";
import { moveToRetired, preferencePresence } from "../../../../src/core/brain/preference.ts";
import { digestVaultTree } from "../../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;
let memDir: string | undefined;
afterEach(() => {
  if (memDir !== undefined) rmSync(memDir, { recursive: true, force: true });
  memDir = undefined;
  env?.cleanup();
  env = undefined;
});

const NOW = new Date("2026-11-06T12:00:00Z");

function switched(prefix: string): StoreEnv {
  const e = makeStoreEnv(prefix, { dualWrite: false });
  switchDevice(e.storeRoot);
  return e;
}

describe("claude memory re-import once switched", () => {
  const memory = (body: string) =>
    `---\nname: rule-x\ndescription: A rule.\nmetadata:\n  type: feedback\n---\n\n${body}\n`;

  test("an unchanged memory is skipped and a changed one is an update", () => {
    env = switched("osb-import-plan-so-");
    memDir = mkdtempSync(join(env.parent, "mem-"));
    writeFileSync(join(memDir, "feedback_x.md"), memory("Body v1."), "utf8");
    const run = (at: Date) =>
      importClaudeMemory({
        vault: env!.vault,
        memoryDir: memDir!,
        mode: "apply",
        allowArbitraryMemoryPath: true,
        now: at,
      });
    expect(run(NOW).plans.map((p) => p.action)).toEqual(["CREATE"]);
    expect(run(new Date("2026-11-06T12:00:01Z")).plans.map((p) => p.action)).toEqual([
      "SKIP_UNCHANGED",
    ]);
    writeFileSync(join(memDir, "feedback_x.md"), memory("Body v2."), "utf8");
    expect(run(new Date("2026-11-06T12:00:02Z")).plans.map((p) => p.action)).toEqual(["UPDATE"]);
  });

  test("a changed memory of a retired preference does not revive it", () => {
    env = switched("osb-import-retired-so-");
    memDir = mkdtempSync(join(env.parent, "mem-"));
    writeFileSync(join(memDir, "feedback_x.md"), memory("Body v1."), "utf8");
    const run = (at: Date) =>
      importClaudeMemory({
        vault: env!.vault,
        memoryDir: memDir!,
        mode: "apply",
        allowArbitraryMemoryPath: true,
        now: at,
      });
    const slug = run(NOW).plans[0]!.prefId.slice("pref-".length);
    moveToRetired(env.vault, preferencePath(env.vault, slug), "stale-no-evidence", {
      now: NOW,
      retired_by: "[[Brain/log/2026-11-06]]",
      authority: "agent",
    });
    writeFileSync(join(memDir, "feedback_x.md"), memory("Body v2."), "utf8");
    const again = run(new Date("2026-11-06T12:00:02Z"));
    expect(again.applied).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual([
      `a retired copy exists (ret-${slug}); restore or delete it first`,
    ]);
    expect(preferencePresence(env.vault, slug)).toBe("retired");
  });
});

describe("host memory promotion once switched", () => {
  test("a second run skips what landed and writes nothing under Brain/", () => {
    env = switched("osb-promote-plan-so-");
    mkdirSync(join(env.vault, "Brain"), { recursive: true });
    recordHostMemoryWrite(env.vault, {
      action: "add",
      target: "user",
      content: "Prefer small commits",
      createdAt: "2026-11-05T10:00:00Z",
    });
    const before = digestVaultTree(join(env.vault, "Brain"));
    const first = promoteHostMemory({ vault: env.vault, mode: "apply", now: NOW });
    expect(first.applied).toHaveLength(1);
    const second = promoteHostMemory({ vault: env.vault, mode: "dry-run", now: NOW });
    expect(second.plans.map((p) => p.action)).toEqual(["SKIP_UNCHANGED"]);
    expect(digestVaultTree(join(env.vault, "Brain"))).toEqual(before);
  });

  test("a preference retired in the store is not promoted again", () => {
    env = switched("osb-promote-retired-so-");
    recordHostMemoryWrite(env.vault, {
      action: "add",
      target: "user",
      content: "Prefer small commits",
      createdAt: "2026-11-05T10:00:00Z",
    });
    const first = promoteHostMemory({ vault: env.vault, mode: "apply", now: NOW });
    const slug = first.plans[0]!.prefId.slice("pref-".length);
    moveToRetired(env.vault, preferencePath(env.vault, slug), "stale-no-evidence", {
      now: NOW,
      retired_by: "[[Brain/log/2026-11-06]]",
      authority: "agent",
    });
    const again = promoteHostMemory({ vault: env.vault, mode: "dry-run", now: NOW });
    expect(again.plans).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual([
      `a retired copy exists (ret-${slug}); restore or delete it first`,
    ]);
  });
});
