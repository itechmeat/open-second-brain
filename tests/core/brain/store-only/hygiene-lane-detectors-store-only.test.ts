/**
 * The capture-scope and document-dedup hygiene detectors on a switched
 * vault with no `Brain/` tree. Both walked the `Brain/` lane folders
 * (sources, distillations, reports, entities) on disk; on a switched vault
 * those pages are lane entries of the store, so both answered clean.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { detectCaptureScope } from "../../../../src/core/brain/hygiene/detectors/capture-scope.ts";
import { detectDocumentDedup } from "../../../../src/core/brain/hygiene/detectors/document-dedup.ts";
import { writeLanePage } from "../../../../src/core/store/lane-pages.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const NEAR_A =
  "Collect the latency metrics before optimizing the render loop and archive the traces weekly";
const NEAR_B =
  "Collect the latency metrics before optimizing the render loop and archive the traces daily";

function sourcePage(vault: string, slug: string, body: string, sourcePath: string): void {
  writeLanePage(
    vault,
    join(vault, "Brain", "sources", `src-${slug}.md`),
    {
      kind: "brain-source",
      source_path: sourcePath,
      source_hash: "a".repeat(64),
      tags: ["brain", "brain/source"],
    },
    `${body}\n`,
  );
}

test("capture-scope reads the lane pages of the store on a vault with no Brain/", () => {
  env = makeStoreEnv("osb-hygiene-capture-", { legacyTree: false });
  sourcePage(env.vault, "remote", NEAR_A, "https://example.com/a");
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);

  const findings = detectCaptureScope(env.vault);
  expect(findings.map((f) => f.targets)).toEqual([["Brain/sources/src-remote.md"]]);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});

test("document dedup reads the ingest summaries of the store on a vault with no Brain/", () => {
  env = makeStoreEnv("osb-hygiene-docdedup-", { legacyTree: false });
  sourcePage(env.vault, "weekly", NEAR_A, "imports/weekly.md");
  sourcePage(env.vault, "daily", NEAR_B, "imports/daily.md");
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);

  const findings = detectDocumentDedup(env.vault, { now: new Date(0) });
  expect(findings.map((f) => [...f.targets].toSorted())).toEqual([
    ["Brain/sources/src-daily.md", "Brain/sources/src-weekly.md"],
  ]);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});
