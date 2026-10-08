/**
 * The doctor warns when background index runs started by stale reads keep
 * failing: three in a row is a broken index, not a transient hiccup, and
 * until it is fixed every search answers from an ageing index.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { applyRepair } from "../../../src/core/brain/diagnostics.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { writeFreshenState } from "../../../src/core/search/freshen.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { MCPServer } from "../../../src/mcp/server.ts";
import { runCli } from "../../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;
let derived: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-freshen-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  derived = join(vault, ".open-second-brain");
  // The surfaces below resolve the index path themselves; the state file
  // has to sit where they look.
  expect(dirname(resolveSearchConfig({ vault, configPath }).dbPath)).toBe(derived);
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

test("the repair plan lists a failing freshen as not auto-repairable", () => {
  failures(3);
  const outcome = applyRepair(vault, { dryRun: true, dbPath: join(derived, "brain.sqlite") });
  expect(outcome.unfixable.map((u) => u.code)).toContain("freshen-failing");
});

test("o2b brain doctor --repair reaches the failing freshen", async () => {
  failures(3);
  const r = await runCli(["brain", "doctor", "--vault", vault, "--repair", "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(r.returncode).toBe(0);
  const outcome = JSON.parse(r.stdout) as { unfixable: ReadonlyArray<{ code: string }> };
  expect(outcome.unfixable.map((u) => u.code)).toContain("freshen-failing");
});

test("brain_doctor reaches the failing freshen in its report and its repair preview", async () => {
  failures(3);
  const saved = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  try {
    const server = new MCPServer({ vault, configPath });
    const report = JSON.stringify(await server.callTool("brain_doctor", {}));
    expect(report).toContain("freshen-failing");
    const repair = JSON.stringify(await server.callTool("brain_doctor", { repair: true }));
    expect(repair).toContain("freshen-failing");
  } finally {
    if (saved === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
    else process.env["OPEN_SECOND_BRAIN_CONFIG"] = saved;
  }
});
