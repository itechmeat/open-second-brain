/**
 * `verifyTensions` on a store-only machine: the tension page is a store
 * record with no file behind it, so its visibility is read from the
 * record. A shared tension still gets a verdict; a private one is still
 * never sent.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { NoteContradictionFinding } from "../../../src/core/brain/health/contradiction.ts";
import { listTensions, persistTension } from "../../../src/core/brain/tensions.ts";
import { verifyTensions } from "../../../src/core/brain/tension-verdicts.ts";
import { activeDecisionConfig } from "../../helpers/fake-decision-provider.ts";
import { FakeChoiceProvider } from "../../helpers/fake-choice-decision.ts";
import { switchDevice } from "../brain/fixtures/memory-twins.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function note(vault: string, rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, ["---", "title: t", "---", "", body, ""].join("\n"));
}

const finding: NoteContradictionFinding = {
  aId: "notes/spaces.md",
  bId: "notes/tabs.md",
  subject: "tabs use",
  jaccard: 0.6,
  aSign: "negative",
  bSign: "positive",
  aQuote: "Never use tabs.",
  bQuote: "Always use tabs.",
  action: "ask_user",
};

test("a shared tension held in the store is verified on a switched machine", async () => {
  env = makeStoreEnv("o2b-tension-verify-store-", { dualWrite: false });
  switchDevice(env);
  const vault = env.vault;
  note(vault, "notes/tabs.md", "Always use tabs.");
  note(vault, "notes/spaces.md", "Never use tabs.");
  const { record } = persistTension(vault, finding, { agent: "tester" });
  const config = activeDecisionConfig({
    vault,
    uses: { ...activeDecisionConfig().uses, rerank: "off", tension: "enforce" },
  });
  const provider = new FakeChoiceProvider(() => ({ choice: "contradicts", p: 0.9 }));
  const out = await verifyTensions(vault, listTensions(vault), { config, provider });
  expect(out.available).toBe(true);
  const row = out.rows.find((r) => r.item.slug === record.slug)!;
  expect(row.verdict?.verdict).toBe("contradicts");
  expect(JSON.stringify(provider.requests)).toContain("Never use tabs.");
});
