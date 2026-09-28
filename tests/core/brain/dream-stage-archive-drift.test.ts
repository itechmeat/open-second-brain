/**
 * Staged dream bundles and the inbox archive (issue #195).
 *
 * The archive step is housekeeping driven by the clock: a signal staged
 * inside the contradiction window can cross its edge before the bundle is
 * validated or applied. That must not read as drift, or every bundle staged
 * a day earlier would be refused. The comparison of every other key stays
 * strict, and it runs over the keys of both plans, not only the recomputed
 * one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDreamBundle,
  stageDream,
  validateDreamBundle,
} from "../../../src/core/brain/dream-stage.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const STAGED_AT = new Date("2026-06-05T12:00:00Z");
// Two days later: a signal created 13 days before STAGED_AT has left the
// 14-day window by then.
const APPLIED_AT = new Date("2026-06-07T12:00:00Z");

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-dream-stage-archive-"));
  vault = join(tmp, "vault");
  const configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function edgeSignal(): string {
  return writeSignal(vault, {
    topic: "edge-topic",
    signal: "positive",
    agent: "claude",
    principle: "Rule for edge-topic.",
    created_at: "2026-05-23T12:00:00Z",
    date: "2026-05-23",
    slug: "edge-topic",
  }).id;
}

describe("staged bundle and the archive step", () => {
  test("a signal that crossed the window edge after staging is not drift", () => {
    const id = edgeSignal();
    const bundle = stageDream(vault, { now: STAGED_AT });
    expect(bundle.plan.archived_signals).toBeUndefined();

    const validation = validateDreamBundle(vault, bundle.runId, { now: APPLIED_AT });
    expect(validation.drift).toEqual([]);
    expect(validation.valid).toBe(true);

    const outcome = applyDreamBundle(vault, bundle.runId, { now: APPLIED_AT });
    expect(outcome.applied).toBe(true);
    expect(existsSync(join(brainDirs(vault).archived, `${id}.md`))).toBe(true);
  });

  test("a key only the staged plan carries is reported as drift", () => {
    edgeSignal();
    const bundle = stageDream(vault, { now: STAGED_AT });
    const manifestPath = join(bundle.dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const plan = manifest["plan"] as Record<string, unknown>;
    atomicWriteFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, plan: { ...plan, stale_key: ["x"] } }, null, 2) + "\n",
    );

    const validation = validateDreamBundle(vault, bundle.runId, { now: STAGED_AT });
    expect(validation.valid).toBe(false);
    expect(validation.drift.some((d) => d.startsWith("stale_key:"))).toBe(true);
  });
});
