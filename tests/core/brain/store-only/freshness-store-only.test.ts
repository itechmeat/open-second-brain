/**
 * Source freshness on a switched vault with no `Brain/` tree. The pages
 * that carry a freshness contract are derived pages the brain writes
 * itself (a session handoff note under `Brain/handoffs/`), so once
 * switched they are lane entries; the scan reads them from the lane store
 * beside the vault's own pages, instead of reporting no contract at all.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  checkPageFreshness,
  computeSourceStamp,
  scanFreshness,
} from "../../../../src/core/brain/freshness.ts";
import { planRecompile } from "../../../../src/core/brain/recompile.ts";
import { writeLanePage } from "../../../../src/core/store/lane-pages.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test("a stale lane page and a stale vault page are both reported", () => {
  env = makeStoreEnv("osb-freshness-", { legacyTree: false });
  const { vault } = env;
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "src.md"), "# Source\n\nfirst\n");
  const stamp = computeSourceStamp(vault, ["notes/src.md"]);
  const handoff = join(vault, "Brain", "handoffs", "2026-11-19-s1.md");
  writeLanePage(vault, handoff, { session_id: "s1", ...stamp }, "Handoff.\n", { overwrite: true });
  writeFileSync(
    join(vault, "notes", "derived.md"),
    `---\nsource_paths: ["notes/src.md"]\nsource_hashes: ["${stamp.source_hashes[0]}"]\n---\n\nDerived.\n`,
  );
  writeFileSync(join(vault, "notes", "src.md"), "# Source\n\nchanged\n");
  expect(existsSync(join(vault, "Brain"))).toBe(false);

  const report = scanFreshness(vault);
  expect(report.with_contract).toBe(2);
  expect(report.stale.map((s) => s.page).toSorted()).toEqual(
    [handoff, join(vault, "notes", "derived.md")].toSorted(),
  );
  expect(checkPageFreshness(vault, handoff)?.status).toBe("stale");
});

test("the recompile plan re-derives a stale handoff lane page from its transcript", () => {
  env = makeStoreEnv("osb-freshness-recompile-", { legacyTree: false });
  const { vault, parent } = env;
  const transcript = join(parent, "session.jsonl");
  writeFileSync(transcript, "{}\n");
  const stamp = computeSourceStamp(vault, [transcript]);
  const handoff = join(vault, "Brain", "handoffs", "2026-11-19-s1.md");
  writeLanePage(vault, handoff, { session_id: "s1", ...stamp }, "Handoff.\n", { overwrite: true });
  writeFileSync(transcript, "{}\n{}\n");

  expect(planRecompile(vault).entries).toEqual([
    {
      kind: "rederive-handoff",
      page: handoff,
      transcript,
      session_id: "s1",
      reason: `changed source(s): ${transcript}`,
    },
  ]);
});
