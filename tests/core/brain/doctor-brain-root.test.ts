/**
 * Unit J - the doctor must not report a `Brain`-less root as clean.
 *
 * The diagnostic that should catch a mis-resolved vault actively masked
 * it: an absent `Brain/` returned `{errors: [], trust_verdict: "clean"}`,
 * so the one command an operator runs to check the store said the wrong
 * root was fine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-brain-root-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("runDoctor on a root with no Brain layer", () => {
  test("names the condition instead of reporting clean", () => {
    const result = runDoctor(vault);
    expect(result.trust_verdict).not.toBe("clean");
    expect(result.warnings.map((w) => w.code)).toContain("brain-root-absent");
    const warning = result.warnings.find((w) => w.code === "brain-root-absent")!;
    expect(warning.path).toBe(join(vault, "Brain"));
    expect(result.uncertain?.map((u) => u.code)).toContain("brain-root-absent");
  });

  test("still never throws", () => {
    expect(() => runDoctor(vault)).not.toThrow();
  });

  test("a root that does have a Brain layer is unaffected", () => {
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
    mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
    const result = runDoctor(vault);
    expect(result.warnings.map((w) => w.code)).not.toContain("brain-root-absent");
  });
});
