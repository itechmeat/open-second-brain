/**
 * The claim graph keeps a signal the dream pass archived (issue #195).
 *
 * Archiving moves an inbox signal into `Brain/inbox/archived/` byte for
 * byte; the claim it carries is history, not deleted, so the projection
 * reads the archive the way it reads `inbox/processed/`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildClaimGraph } from "../../../src/core/brain/claim-graph.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";

const NOW = new Date("2026-06-30T12:00:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-claim-graph-archived-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("a signal archived by the dream pass stays in the claim graph", () => {
  const { id } = writeSignal(vault, {
    topic: "old-claim",
    signal: "positive",
    agent: "claude",
    principle: "Principle for old-claim",
    created_at: "2026-05-01T10:00:00Z",
    date: "2026-05-01",
    slug: "old-claim",
  });
  expect(buildClaimGraph(vault).nodes.find((n) => n.id === id)?.path).toBe(`Brain/inbox/${id}.md`);

  expect(dream(vault, { now: NOW }).archived_signals).toEqual([id]);

  const node = buildClaimGraph(vault).nodes.find((n) => n.id === id);
  expect(node?.path).toBe(`Brain/inbox/archived/${id}.md`);
  expect(node?.principle).toBe("Principle for old-claim");
});
