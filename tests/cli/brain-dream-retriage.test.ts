/**
 * `o2b brain dream retriage <run-id>` (salience-lifecycle-enrichment,
 * unit 1, t_de8a0b2d).
 *
 * A staged bundle records the salience partition it was staged with. A
 * later threshold change silently changes what a re-stage would fold, so
 * `retriage` is the read-only answer to "what would move": it re-runs the
 * gate against the CURRENT threshold and reports the delta. It never
 * touches the bundle - re-staging stays the operator's decision.
 *
 * Claims pinned here:
 *   1. A staged bundle records its salience partition in the manifest,
 *      including the open-gate case (`threshold: null`).
 *   2. `retriage` after raising the threshold names every fact that
 *      would newly be excluded, with both the staged and the current
 *      score, and leaves the bundle byte-identical.
 *   3. Lowering the threshold back reports the newly-admitted set with
 *      the same shape.
 *   4. An unchanged threshold reports `changed: false` and empty deltas.
 *   5. An unknown bundle is refused by name on both streams, exit 2,
 *      with a `--json` failure shape.
 *   6. A bundle staged before the gate existed is refused by name rather
 *      than compared against an assumed-open partition.
 *   7. The action requires a run id, like its validate/apply/discard
 *      siblings.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

const NOW = "2026-06-01T00:00:00Z";
const LOUD = "loud";
const QUIET = ["quiet-a", "quiet-b", "quiet-c"] as const;

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-retriage-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`, "utf8");
  bootstrapBrain(vault, { configPath });
  setThreshold(null);
  for (const slug of [LOUD, ...QUIET]) {
    const loud = slug === LOUD;
    writePreference(vault, {
      slug,
      topic: slug,
      principle: `principle for ${slug}`,
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-08T00:00:00Z",
      confirmed_at: "2026-01-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      applied_count: loud ? 8 : 0,
      violated_count: 0,
      // Both kinds carry recent evidence dates so the stale-no-evidence
      // auto-retire never fires; the quiet ones differ only in having no
      // applied/violated counters and no apply-evidence in the log, which
      // is exactly what the gate reads.
      last_evidence_at: "2026-05-30T00:00:00Z",
      confidence_value: loud ? 0.8 : 0,
    });
  }
  for (const day of ["2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30"]) {
    appendLogEvent(vault, {
      timestamp: `${day}T00:00:00Z`,
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: {
        preference: `[[pref-${LOUD}]]`,
        artifact: "[[src/foo.ts]]",
        agent: "tester",
        result: BRAIN_APPLY_RESULT.applied,
      },
    });
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setThreshold(threshold: number | null): void {
  const block = threshold === null ? "" : `dream:\n  salience_threshold: ${threshold}\n`;
  atomicWriteFileSync(brainConfigPath(vault), `schema_version: 1\n${block}`);
}

async function cli(args: ReadonlyArray<string>): Promise<{
  stdout: string;
  stderr: string;
  returncode: number;
}> {
  return runCli([...args, "--vault", vault], { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
}

async function stageBundle(): Promise<string> {
  const r = await cli(["brain", "dream", "stage", "--now", NOW, "--json"]);
  expect(r.returncode).toBe(0);
  return String(JSON.parse(r.stdout)["run_id"]);
}

function manifestPath(runId: string): string {
  return join(vault, "Brain", "dream", "staged", runId, "manifest.json");
}

function manifest(runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath(runId), "utf8")) as Record<string, unknown>;
}

test("a staged bundle records its salience partition, open gate included", async () => {
  const runId = await stageBundle();
  const salience = manifest(runId)["salience"] as Record<string, unknown>;
  expect(salience).toBeDefined();
  expect(salience["threshold"]).toBeNull();
  expect(salience["considered"]).toBe(4);
  expect(salience["admitted"]).toBe(4);
  expect(salience["excluded"]).toEqual([]);
});

test("raising the threshold names every newly-excluded fact and leaves the bundle alone", async () => {
  const runId = await stageBundle();
  const before = readFileSync(manifestPath(runId), "utf8");
  setThreshold(0.2);

  const r = await cli(["brain", "dream", "retriage", runId, "--now", NOW, "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as Record<string, unknown>;
  expect(payload["run_id"]).toBe(runId);
  expect(payload["staged_threshold"]).toBeNull();
  expect(payload["current_threshold"]).toBe(0.2);
  expect(payload["changed"]).toBe(true);
  const newlyExcluded = payload["newly_excluded"] as Array<Record<string, unknown>>;
  expect(newlyExcluded.map((e) => e["pref_id"])).toEqual(QUIET.map((slug) => `pref-${slug}`));
  for (const entry of newlyExcluded) {
    expect(entry["path"]).toBe(`Brain/preferences/${entry["pref_id"]}.md`);
    expect(entry["score"]).toBe(0);
    // Nothing was scored at stage time, so there is no staged score to
    // report - and the field says so rather than inventing a zero.
    expect(entry["staged_score"]).toBeNull();
  }
  expect(payload["newly_admitted"]).toEqual([]);
  // Read-only: the bundle is exactly as it was staged.
  expect(readFileSync(manifestPath(runId), "utf8")).toBe(before);
});

test("lowering the threshold reports the newly-admitted set", async () => {
  setThreshold(0.2);
  const runId = await stageBundle();
  expect((manifest(runId)["salience"] as Record<string, unknown>)["admitted"]).toBe(1);
  setThreshold(0);

  const r = await cli(["brain", "dream", "retriage", runId, "--now", NOW, "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as Record<string, unknown>;
  expect(payload["changed"]).toBe(true);
  const newlyAdmitted = payload["newly_admitted"] as Array<Record<string, unknown>>;
  expect(newlyAdmitted.map((e) => e["pref_id"])).toEqual(QUIET.map((slug) => `pref-${slug}`));
  expect(newlyAdmitted[0]!["staged_score"]).toBe(0);
  expect(payload["newly_excluded"]).toEqual([]);
});

test("an unchanged threshold reports no delta at all", async () => {
  setThreshold(0.2);
  const runId = await stageBundle();
  const r = await cli(["brain", "dream", "retriage", runId, "--now", NOW, "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as Record<string, unknown>;
  expect(payload["changed"]).toBe(false);
  expect(payload["newly_admitted"]).toEqual([]);
  expect(payload["newly_excluded"]).toEqual([]);
  expect(payload["staged_threshold"]).toBe(0.2);
  expect(payload["current_threshold"]).toBe(0.2);
});

test("the human stream names the delta as well", async () => {
  const runId = await stageBundle();
  setThreshold(0.2);
  const r = await cli(["brain", "dream", "retriage", runId, "--now", NOW]);
  expect(r.returncode).toBe(0);
  expect(r.stdout).toContain("newly excluded: 3");
  for (const slug of QUIET) expect(r.stdout).toContain(`pref-${slug}`);
});

test("an unknown bundle is refused by name, exit 2, on both streams", async () => {
  const human = await cli(["brain", "dream", "retriage", "stage-2026-06-01-000000", "--now", NOW]);
  expect(human.returncode).toBe(2);
  expect(human.stderr).toContain("stage-2026-06-01-000000");

  const asJson = await cli([
    "brain",
    "dream",
    "retriage",
    "stage-2026-06-01-000000",
    "--now",
    NOW,
    "--json",
  ]);
  expect(asJson.returncode).toBe(2);
  const payload = JSON.parse(asJson.stdout) as Record<string, unknown>;
  expect(payload["ok"]).toBe(false);
  expect(payload["run_id"]).toBe("stage-2026-06-01-000000");
  expect(String(payload["message"])).toContain("stage-2026-06-01-000000");
});

test("a bundle staged before the gate existed is refused, never assumed open", async () => {
  const runId = await stageBundle();
  const raw = manifest(runId);
  delete raw["salience"];
  writeFileSync(manifestPath(runId), JSON.stringify(raw, null, 2) + "\n", "utf8");

  const r = await cli(["brain", "dream", "retriage", runId, "--now", NOW, "--json"]);
  expect(r.returncode).toBe(2);
  const payload = JSON.parse(r.stdout) as Record<string, unknown>;
  expect(payload["ok"]).toBe(false);
  expect(String(payload["message"])).toMatch(/re-stage/);
});

test("retriage requires a run id, like its validate and apply siblings", async () => {
  const r = await cli(["brain", "dream", "retriage", "--now", NOW]);
  expect(r.returncode).toBe(2);
  expect(r.stderr).toContain("retriage");
});

test("--step and --gate stay refused on the retriage action", async () => {
  const runId = await stageBundle();
  const r = await cli([
    "brain",
    "dream",
    "retriage",
    runId,
    "--gate",
    "heal_enrich=true",
    "--json",
  ]);
  expect(r.returncode).toBe(2);
  const payload = JSON.parse(r.stdout) as Record<string, unknown>;
  expect(payload["ok"]).toBe(false);
  expect(payload["action"]).toBe("retriage");
});
