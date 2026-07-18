/**
 * A4 (t_f79b4fe0): CLI surface for the write-time conflict advisory.
 *
 * `o2b brain feedback` records the signal as before, and additionally
 * surfaces a non-blocking advisory when the incoming principle resembles a
 * confirmed same-scope preference. The write always proceeds regardless.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-feedback-advisory-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

async function seedConfirmed(principle: string, scope: string): Promise<void> {
  const out = await runCli(
    [
      "brain",
      "feedback",
      "--topic",
      "tabs-rule",
      "--signal",
      "positive",
      "--principle",
      principle,
      "--scope",
      scope,
      "--force-confirmed",
    ],
    { env: env() },
  );
  expect(out.returncode).toBe(0);
}

describe("o2b brain feedback - write-conflict advisory", () => {
  test("surfaces the advisory when the incoming principle resembles a confirmed same-scope preference", async () => {
    await seedConfirmed("always indent source with tabs not spaces", "coding");
    const out = await runCli(
      [
        "brain",
        "feedback",
        "--topic",
        "tabs-again",
        "--signal",
        "negative",
        "--principle",
        "always indent source with tabs not spaces",
        "--scope",
        "coding",
        "--json",
      ],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as {
      signal_id: string;
      advisory?: { scope: string | null; conflicts: Array<{ pref_id: string; jaccard: number }> };
    };
    // The write proceeded.
    expect(payload.signal_id).toMatch(/^sig-/);
    // The advisory names the confirmed preference.
    expect(payload.advisory).toBeDefined();
    expect(payload.advisory!.conflicts.map((c) => c.pref_id)).toContain("pref-tabs-rule");
  });

  test("no advisory for a non-conflicting principle; the write still proceeds", async () => {
    await seedConfirmed("always indent source with tabs not spaces", "coding");
    const out = await runCli(
      [
        "brain",
        "feedback",
        "--topic",
        "semantic-html",
        "--signal",
        "positive",
        "--principle",
        "prefer semantic HTML over generic containers",
        "--scope",
        "coding",
        "--json",
      ],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { signal_id: string; advisory?: unknown };
    expect(payload.signal_id).toMatch(/^sig-/);
    expect(payload.advisory).toBeUndefined();
  });
});
