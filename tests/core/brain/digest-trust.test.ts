/**
 * v0.10.16: digest renders the trust-layer fields when supplied with
 * a doctor result and / or a dream summary. Clean vault input keeps
 * the markdown and JSON output bit-identical to v0.10.15 when no
 * trust input is threaded through.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DigestJson } from "../../../src/core/brain/digest.ts";
import { renderDigest } from "../../../src/core/brain/digest.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import type { DreamRunSummary } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

let vault: string;

function emptyDream(over: Partial<DreamRunSummary> = {}): DreamRunSummary {
  return Object.freeze({
    run_id: "dream-2026-05-25-000000",
    changed: false,
    new_unconfirmed: [],
    confirmed: [],
    retired: [],
    contradictions: [],
    moved_to_processed: [],
    suppressed: [],
    warnings: [],
    uncertain: [],
    quarantined: [],
    ...over,
  }) as DreamRunSummary;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-digest-trust-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("digest trust integration", () => {
  test("JSON: trust_verdict + counts populate when inputs supplied", () => {
    const doctor = runDoctor(vault);
    const dream = emptyDream({
      uncertain: [{ code: "u", message: "m" }] as DreamRunSummary["uncertain"],
      quarantined: [
        {
          topic: "t",
          signal_count: 2,
          distinct_agents: 1,
          age_days: 0,
          failed_gates: ["min_distinct_agents"],
        },
      ] as DreamRunSummary["quarantined"],
    });
    const r = renderDigest(vault, {
      format: "json",
      doctorResult: doctor,
      dreamSummary: dream,
    });
    const payload = JSON.parse(r.content) as DigestJson;
    expect(payload.trust_verdict).toBe("clean");
    expect(payload.uncertain_count).toBe(1);
    expect(payload.quarantined_count).toBe(1);
  });

  test("markdown shows the Trust section when input supplied", () => {
    const doctor = runDoctor(vault);
    const dream = emptyDream();
    const r = renderDigest(vault, {
      format: "markdown",
      doctorResult: doctor,
      dreamSummary: dream,
    });
    expect(r.content).toContain("## Trust");
    expect(r.content).toContain("clean");
  });

  test("no trust inputs: digest stays bit-identical to v0.10.15 surface", () => {
    const r = renderDigest(vault, { format: "json" });
    const payload = JSON.parse(r.content) as DigestJson;
    expect(payload.trust_verdict).toBeUndefined();
    expect(payload.uncertain_count).toBe(0);
    expect(payload.quarantined_count).toBe(0);
  });
});
