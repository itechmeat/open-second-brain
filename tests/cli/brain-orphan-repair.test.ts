/**
 * `o2b brain orphan-repair` (t_6cc80627). The verb is the only door to
 * the detach repair: dry-run is the default and writes nothing; --apply
 * requires the exact --confirm phrase; a rerun converges to zero writes.
 *
 * The last describe pins the boundary the design states rather than
 * discovers: the doctor pass REPORTS the orphan and never repairs it,
 * and the verb is not wired into the pass - the repair is reachable only
 * by an operator typing the command.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { ORPHAN_SESSION_REPAIR_COMMAND } from "../../src/core/brain/doctor/orphan-session-check.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { signalPath as brainSignalPath } from "../../src/core/brain/paths.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";

/** Event date and slug of the single fixture signal; the production
 * path builder composes the same file name from them. */
const FIXTURE_DATE = "2026-06-01";
const FIXTURE_SLUG = "orphan";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-orphan-repair-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
  bootstrapBrain(vault, { configPath: config });
  writeOrphan();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function signalPath(): string {
  // The production path builder derives the exact file name from the
  // date and slug the fixture writes with. Walking the inbox would be
  // fragile: readdirSync order is filesystem-defined, and the bootstrap
  // also places the `archived/` and `processed/` sibling directories
  // there, so on some filesystems the first entry is a directory.
  return brainSignalPath(vault, FIXTURE_DATE, FIXTURE_SLUG);
}

function writeOrphan(): void {
  // The canonical writer, so the doctor's own record check parses the
  // fixture cleanly and the only finding in play is the orphan itself.
  writeSignal(vault, {
    topic: FIXTURE_SLUG,
    signal: "positive",
    agent: "tester",
    principle: "observations keep their provenance",
    created_at: "2026-06-01T00:00:00Z",
    date: FIXTURE_DATE,
    slug: FIXTURE_SLUG,
    source_type: "session",
    source: ["[[session:sess-gone#turn-1]]"],
    session_ref: "session:sess-gone#turn-1",
    raw: "the observation body",
  });
}

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

test("dry-run reports the detach and writes nothing", async () => {
  const before = readFileSync(signalPath(), "utf8");
  const res = await runCli(["brain", "orphan-repair", "--json"], { env: env() });
  expect(res.returncode).toBe(0);
  const report = JSON.parse(res.stdout) as { mode: string; detached: number; decisions: unknown[] };
  expect(report.mode).toBe("dry-run");
  expect(report.detached).toBe(1);
  expect(report.decisions.length).toBe(1);
  expect(readFileSync(signalPath(), "utf8")).toBe(before);
});

test("apply without the exact confirmation phrase is refused", async () => {
  const res = await runCli(["brain", "orphan-repair", "--apply", "--confirm", "nope"], {
    env: env(),
  });
  expect(res.returncode).not.toBe(0);
  expect(readFileSync(signalPath(), "utf8")).toContain("session_ref:");
});

test("a refused apply under --json emits a JSON error envelope, not plain text", async () => {
  const res = await runCli(["brain", "orphan-repair", "--apply", "--confirm", "nope", "--json"], {
    env: env(),
  });
  expect(res.returncode).toBe(1);
  const parsed = JSON.parse(res.stdout) as { ok: boolean; message: string };
  expect(parsed.ok).toBe(false);
  expect(parsed.message).toContain("confirmation phrase");
});

test("apply with the exact phrase detaches the reference, and a rerun is a no-op", async () => {
  const applied = await runCli(
    ["brain", "orphan-repair", "--apply", "--confirm", "apply orphan repair", "--json"],
    { env: env() },
  );
  expect(applied.returncode).toBe(0);
  const first = JSON.parse(applied.stdout) as { detached: number };
  expect(first.detached).toBe(1);
  const after = readFileSync(signalPath(), "utf8");
  expect(after).not.toContain("session_ref:");
  expect(after).toContain("the observation body");

  const rerun = await runCli(
    ["brain", "orphan-repair", "--apply", "--confirm", "apply orphan repair", "--json"],
    { env: env() },
  );
  const second = JSON.parse(rerun.stdout) as { detached: number };
  expect(second.detached).toBe(0);
  expect(readFileSync(signalPath(), "utf8")).toBe(after);
});

test("the doctor pass reports the orphan and never repairs it", async () => {
  const before = readFileSync(signalPath(), "utf8");
  const res = await runCli(["brain", "doctor", "--json"], { env: env() });
  expect(res.returncode).toBe(0);
  const report = JSON.parse(res.stdout) as { warnings: Array<{ code: string; fix?: string }> };
  const orphan = report.warnings.filter((w) => w.code === "orphan-session-ref");
  expect(orphan.length).toBe(1);
  expect(orphan[0]!.fix).toBe(ORPHAN_SESSION_REPAIR_COMMAND);
  // The pass is read-only: the dangling reference is still on disk after
  // the doctor ran, and the repair it names is the verb's to make.
  expect(readFileSync(signalPath(), "utf8")).toBe(before);
});

test("the repair is not wired into the doctor pass", () => {
  // A source-level boundary: no doctor module may import the repair or
  // reach the verb, so a future refactor cannot make `runDoctor` mutate.
  const doctorDir = join(import.meta.dir, "..", "..", "src", "core", "brain", "doctor");
  const modules = [join(doctorDir, "..", "doctor.ts")];
  for (const entry of readdirSync(doctorDir)) {
    if (entry.endsWith(".ts")) modules.push(join(doctorDir, entry));
  }
  // A module path containing the repair, on a `from` clause - never
  // prose: the check module's docblock names the repair module as the
  // write half it must not become, and must stay free to do so.
  const IMPORT_RE = /^[^\n]*\bfrom\s+"[^"]*orphan-repair[^"]*";/m;
  for (const path of modules) {
    const source = readFileSync(path, "utf8");
    expect(`${path} imports repair: ${IMPORT_RE.test(source)}`).toBe(
      `${path} imports repair: false`,
    );
  }
});
