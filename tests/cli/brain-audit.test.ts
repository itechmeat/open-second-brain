/**
 * CLI tests for `o2b brain audit`.
 *
 * The verb wraps `readPrefAudit` / `renderPrefAudit`. Here we lock the
 * CLI surface: argument normalisation (pref- / ret- / bare slug all
 * resolve to one trail), `--json`, the empty-trail path, and exit code.
 * The audit trail itself is produced by the merge chokepoint, which has
 * its own unit coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePreference } from "../../src/core/brain/preference.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-audit-cli-test-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(brainInit.returncode).toBe(0);
}

function makePref(slug: string): void {
  writePreference(vault, {
    slug,
    topic: "commits",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
  });
}

describe("o2b brain audit", () => {
  test("usage error with no argument", async () => {
    await bootstrap();
    const r = await runCli(["brain", "audit"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).not.toBe(0);
  });

  test("reports no records for a preference with no audit trail", async () => {
    await bootstrap();
    const r = await runCli(["brain", "audit", "pref-nothing"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no audit records");
  });

  test("renders the merge audit trail (text + json, bare-slug normalised)", async () => {
    await bootstrap();
    makePref("keep");
    makePref("drop");
    const merge = await runCli(["brain", "merge", "pref-keep", "pref-drop", "--force"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(merge.returncode).toBe(0);

    // Bare slug resolves to the same `pref-keep` trail.
    const text = await runCli(["brain", "audit", "keep"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("pref-keep");
    expect(text.stdout).toContain("merge");

    const json = await runCli(["brain", "audit", "pref-keep", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(json.returncode).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      pref_id: string;
      records: Array<{ op: string }>;
    };
    expect(parsed.pref_id).toBe("pref-keep");
    expect(parsed.records.some((r) => r.op === "merge")).toBe(true);

    // The dropped pref's trail shows the retire(merged-into).
    const drop = await runCli(["brain", "audit", "ret-drop", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const dropParsed = JSON.parse(drop.stdout) as { records: Array<{ op: string }> };
    expect(dropParsed.records.some((r) => r.op === "retire")).toBe(true);
  });
});
