/**
 * Regression smoke for GitHub #161: two `o2b brain feedback` calls with the
 * same topic and date used to race the slug probe, and the loser exited 1
 * with "signal already exists" - its event gone, with nothing looping back
 * to try `-2`.
 *
 * This is a smoke test, not the proof. Eight real processes overlapping is
 * probabilistic: on a slow machine they may serialise and every probe may
 * see the previous file, in which case the run proves only that the happy
 * path still allocates distinct names. The deterministic proof lives in
 * `tests/core/brain.paths.test.ts`, where the injected `create` replays the
 * loser's view of the race exactly.
 *
 * In-process runs cannot overlap (they swap process-wide state and the
 * helper refuses), so this uses `{ subprocess: true }`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

const WRITERS = 8;

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-feedback-race-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-feedback-race-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test(
  "eight concurrent feedback writes on one topic and date all land",
  async () => {
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_unused, i) =>
        runCli(
          [
            "brain",
            "feedback",
            "--topic",
            "one-topic-one-date",
            "--slug",
            "one-topic-one-date",
            "--date",
            "2026-06-01",
            "--signal",
            "positive",
            "--principle",
            `Concurrent writer ${i} must not lose its event`,
          ],
          { env: { OPEN_SECOND_BRAIN_CONFIG: configPath }, subprocess: true },
        ),
      ),
    );

    // Assert on the messages rather than the codes: a failure then reports
    // WHY it failed instead of "expected 0, got 1".
    const failures = results.filter((r) => r.returncode !== 0).map((r) => r.stderr.trim());
    expect(failures).toEqual([]);

    const written = readdirSync(brainDirs(vault).inbox).filter((name) =>
      name.startsWith("sig-2026-06-01-one-topic-one-date"),
    );
    expect(new Set(written).size).toBe(WRITERS);
  },
  { timeout: 60_000 },
);
