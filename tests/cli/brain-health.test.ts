/**
 * CLI smoke tests for the v0.14.0 semantic-health surfaces:
 * `o2b brain health`, `o2b brain history <slug>`, and
 * `o2b brain doctor --remediate [--dry-run]`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { appendEditHistory } from "../../src/core/brain/health/edit-history.ts";
import { computeContentHash } from "../../src/core/brain/content-hash.ts";
import { parsePreference, writePreference } from "../../src/core/brain/preference.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-health-cli-"));
  vault = join(tmp, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

function writeDriftedPref(slug: string): void {
  writePreference(
    vault,
    {
      slug,
      topic: slug,
      principle: "always write tests first in production code",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      confirmed_at: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      content_hash: "0".repeat(64),
    },
    { overwrite: true },
  );
}

describe("o2b brain health", () => {
  test("clean vault prints verdict clean", async () => {
    const r = await runCli(["brain", "health"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("verdict: clean");
  });

  test("--json prints the structured report", async () => {
    const r = await runCli(["brain", "health", "--json"], { env: env() });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as { verdict: string };
    expect(payload.verdict).toBe("clean");
  });
});

describe("o2b brain history", () => {
  test("renders an edit-history timeline", async () => {
    appendEditHistory(vault, "tabs", [
      {
        ts: "2026-05-27T00:00:00Z",
        agent: "tester",
        revision: 1,
        field: "principle",
        before: "use tabs",
        after: "use spaces",
      },
    ]);
    const r = await runCli(["brain", "history", "tabs"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("rev 1");
    expect(r.stdout).toContain("use spaces");
  });

  test("missing slug argument fails", async () => {
    const r = await runCli(["brain", "history"], { env: env() });
    expect(r.returncode).toBe(1);
  });
});

describe("o2b brain doctor --remediate", () => {
  test("--dry-run previews the content-hash re-stamp without writing", async () => {
    writeDriftedPref("a-drift");
    const r = await runCli(["brain", "doctor", "--remediate", "--dry-run"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("would apply");
    expect(r.stdout).toContain("content-hash-drift");
    const pref = parsePreference(join(brainDirs(vault).preferences, "pref-a-drift.md"));
    expect(pref.content_hash).not.toBe(computeContentHash(pref.principle, pref.scope));
  });

  test("applies the re-stamp and fixes the drift", async () => {
    writeDriftedPref("a-drift");
    const r = await runCli(["brain", "doctor", "--remediate"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("applied");
    const pref = parsePreference(join(brainDirs(vault).preferences, "pref-a-drift.md"));
    expect(pref.content_hash).toBe(computeContentHash(pref.principle, pref.scope));
  });
});
