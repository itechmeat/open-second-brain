/**
 * `o2b doctor selftest` - the functional self-test harness (t_c00cc548).
 *
 * The harness drives a real throwaway store end to end (open + migrate,
 * index pass, direct document roundtrip, keyword/trigram query, concurrent
 * writers through the writer lock, delete, orderly close) and must satisfy
 * two contracts the plan pins:
 *
 *   - the `--json` report is STABLE: no timestamps, no paths, no durations -
 *     two runs on one machine stringify byte-identically;
 *   - the operator's configured vault is never touched - the harness creates
 *     its own temp vault and config, and even a hostile environment pointing
 *     the search store and the semantic lane at the operator's files must
 *     not move a single write outside the throwaway directory.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runDoctorSelftest,
  SELFTEST_STAGES,
  SELFTEST_STAGE_NAMES,
  type SelftestJsonPayload,
} from "../../src/core/doctor-selftest.ts";
import { SearchError } from "../../src/core/search/search-error.ts";
import { runCli, type RunResult } from "../helpers/run-cli.ts";

let sandbox: string;
let canaryVault: string;
let canaryConfig: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "o2b-selftest-test-"));
  canaryVault = join(sandbox, "operator-vault");
  mkdirSync(join(canaryVault, "Brain"), { recursive: true });
  writeFileSync(join(canaryVault, "Brain", "canary.md"), "# canary\n\nuntouched\n");
  canaryConfig = join(sandbox, "operator-config.yaml");
  writeFileSync(canaryConfig, `vault: ${canaryVault}\n`);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * The environment the CLI runs under: everything points at the CANARY, so
 * if the harness touched the operator-side configuration at all, the writes
 * would land where the test can see them.
 */
function canaryEnv(): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: canaryConfig,
    VAULT_DIR: canaryVault,
    // Hostile overrides: the store location must NOT be honored (the
    // harness pins the db inside its own temp vault), and the semantic
    // lane must NOT be honored (the harness is network-free).
    OPEN_SECOND_BRAIN_SEARCH_DB: join(canaryVault, "hostile-store.sqlite"),
    OPEN_SECOND_BRAIN_SEARCH_SEMANTIC: "true",
  };
}

/** Recursive (path, size, mtime, content) snapshot of a directory tree. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const stat = statSync(path);
      out.set(path, `${stat.size}:${stat.mtimeMs}:${readFileSync(path, "utf8").length}`);
    }
  };
  walk(root);
  return out;
}

function parseSelftestJson(result: RunResult): SelftestJsonPayload {
  return JSON.parse(result.stdout) as SelftestJsonPayload;
}

test("every stage passes on a healthy machine and the JSON report is stable across runs", async () => {
  const before = snapshot(canaryVault);
  const first = await runCli(["doctor", "selftest", "--json"], { env: canaryEnv() });
  const second = await runCli(["doctor", "selftest", "--json"], { env: canaryEnv() });
  expect(first.returncode).toBe(0);
  expect(second.returncode).toBe(0);

  // Stability is byte-level: no timestamps, paths or durations anywhere.
  expect(first.stdout).toBe(second.stdout);
  expect(first.stdout).not.toContain("durationMs");
  expect(first.stdout).not.toContain("tempVault");
  expect(first.stdout).not.toContain(sandbox);
  expect(first.stdout).not.toContain(tmpdir());

  const report = parseSelftestJson(first);
  expect(report.verb).toBe("doctor-selftest");
  expect(report.harnessRan).toBe(true);
  expect(report.ok).toBe(true);
  expect(report.walMode === "wal" || report.walMode === "delete").toBe(true);
  expect(report.warnings).toBe(report.walMode === "delete" ? 1 : 0);
  expect(report.stages.map((s) => s.name)).toEqual([...SELFTEST_STAGE_NAMES]);
  for (const stage of report.stages) {
    expect(stage.ok, `${stage.name}: ${stage.message}`).toBe(true);
  }
  expect(report.summary).toEqual({ stages: SELFTEST_STAGE_NAMES.length, failed: 0 });

  const search = report.stages.find((s) => s.name === "search");
  expect(search?.metrics?.["queries"]).toBeGreaterThan(0);
  expect(search?.metrics?.["keywordHits"]).toBeGreaterThan(0);
  expect(search?.metrics?.["trigramHits"]).toBeGreaterThan(0);

  // The configured vault is untouched, and the hostile store override
  // never materialized a file.
  expect(snapshot(canaryVault)).toEqual(before);
  expect(existsSync(join(canaryVault, "hostile-store.sqlite"))).toBe(false);
});

test("human output lists every stage with timings and a summary line", async () => {
  const res = await runCli(["doctor", "selftest"], { env: canaryEnv() });
  expect(res.returncode).toBe(0);
  for (const name of SELFTEST_STAGE_NAMES) {
    expect(res.stdout).toContain(name);
  }
  // Timings live in the human surface only.
  expect(res.stdout).toMatch(/\(\d+ms\)/);
  expect(res.stdout).toContain("(removed)");
  expect(res.stdout).toContain(
    `doctor selftest: ok (${SELFTEST_STAGE_NAMES.length} stages, 0 warnings)`,
  );
});

test("a deliberately broken stage fails with name and fix, and the temp vault is cleaned up", async () => {
  const stages = SELFTEST_STAGES.map((spec) =>
    spec.name === "upsert"
      ? {
          ...spec,
          run: () => {
            throw new SearchError("INVALID_INPUT", "injected selftest fault");
          },
        }
      : spec,
  );
  const report = await runDoctorSelftest({ stages });
  expect(report.ok).toBe(false);
  expect(report.harnessRan).toBe(true);
  expect(report.tempRemoved).toBe(true);
  expect(report.tempRoot).not.toBeNull();
  expect(existsSync(report.tempRoot ?? "")).toBe(false);
  // The run stops at the first failure: the stages after the broken one
  // never ran.
  expect(report.stages.map((s) => s.name)).toEqual(["temp-vault", "store-open", "index", "upsert"]);
  const failed = report.stages.at(-1);
  expect(failed?.ok).toBe(false);
  expect(failed?.message).toContain("INVALID_INPUT");
  expect(failed?.message).toContain("injected selftest fault");
  expect(failed?.fix).toBe("o2b search check");
});

test("the harness could not run when temp storage is unavailable", async () => {
  // A FILE sitting where os.tmpdir() points makes every mkdtemp under it
  // fail with ENOTDIR (ENOENT on Windows), regardless of process
  // privileges. A real subprocess is required: os.tmpdir() is resolved from
  // the environment the process starts with, so an in-process env swap
  // cannot redirect it. The block must name every variable os.tmpdir()
  // consults on each platform - TMPDIR on POSIX, TEMP then TMP on Windows -
  // so the canary denies the child a usable temp root either way.
  const blocked = join(sandbox, "not-a-directory");
  writeFileSync(blocked, "in the way");
  const res = await runCli(["doctor", "selftest", "--json"], {
    env: { ...canaryEnv(), TMPDIR: blocked, TEMP: blocked, TMP: blocked },
    subprocess: true,
  });
  expect(res.returncode).toBe(6);
  const report = parseSelftestJson(res);
  expect(report.harnessRan).toBe(false);
  expect(report.ok).toBe(false);
  const first = report.stages[0];
  expect(first?.name).toBe("temp-vault");
  expect(first?.ok).toBe(false);
  expect(first?.fix).toBeTruthy();
});

test("the concurrent-write stage exercises the writer lock with two writers", async () => {
  const report = await runDoctorSelftest();
  expect(report.ok).toBe(true);
  const stage = report.stages.find((s) => s.name === "concurrent-write");
  expect(stage?.ok).toBe(true);
  expect(stage?.metrics?.["writers"]).toBe(2);
});
