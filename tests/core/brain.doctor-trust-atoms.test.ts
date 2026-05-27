/**
 * v0.10.16: `RunDoctorResult` gains four optional trust-layer fields.
 * Atom commit asserts the public shape and the absent-by-default
 * contract; population lands in the consumer commit that wires the
 * trust helpers into the doctor pass.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../src/core/brain/doctor.ts";
import { brainConfigPath, brainDirs } from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-doctor-trust-atoms-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(brainConfigPath(tmp), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("RunDoctorResult trust-layer atoms", () => {
  test("clean vault: legacy fields empty, trust verdict computed by C4", () => {
    const result = runDoctor(tmp);
    // Old surface unchanged.
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
    // New optional fields: trust_verdict is populated by the C4
    // integration (default `clean` on a healthy vault); the rest
    // remain absent / empty because no dream summary was supplied.
    expect(result.trust_verdict).toBe("clean");
    expect(result.verification_delta_summary).toBeUndefined();
    expect(result.instruction_file_warnings ?? []).toEqual([]);
    expect(result.uncertain ?? []).toEqual([]);
  });

  test("frozen result", () => {
    const result = runDoctor(tmp);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
