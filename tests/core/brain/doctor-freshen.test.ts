/**
 * The doctor warns when background index runs started by stale reads keep
 * failing: three in a row is a broken index, not a transient hiccup, and
 * until it is fixed every search answers from an ageing index.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { writeFreshenState } from "../../../src/core/search/freshen.ts";

let tmp: string;
let vault: string;
let derived: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-freshen-"));
  vault = join(tmp, "vault");
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  derived = join(vault, ".open-second-brain");
  mkdirSync(derived, { recursive: true });
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function failures(n: number): void {
  writeFreshenState(derived, {
    failures: n,
    backoffUntil: new Date(Date.now() + 60_000).toISOString(),
    lastOutcome: "failed",
    lastRunAt: new Date().toISOString(),
    lastDurationMs: 10,
    lastError: "database disk image is malformed",
    lastChanged: null,
  });
}

function freshenWarnings() {
  return runDoctor(vault, { dbPath: join(derived, "brain.sqlite") }).warnings.filter(
    (w) => w.code === "freshen-failing",
  );
}

test("three failed background runs in a row are a warning naming the last error", () => {
  failures(3);
  const hits = freshenWarnings();
  expect(hits).toHaveLength(1);
  expect(hits[0]!.message).toContain("3");
  expect(hits[0]!.message).toContain("database disk image is malformed");
});

test("fewer than three failures stay quiet", () => {
  failures(2);
  expect(freshenWarnings()).toEqual([]);
});

test("no state file is no warning", () => {
  expect(freshenWarnings()).toEqual([]);
});
