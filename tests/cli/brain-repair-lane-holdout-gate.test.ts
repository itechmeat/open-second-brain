/**
 * The graph-efficacy holdout gate on `o2b brain repair-lane --apply`
 * (what-the-index-already-knew, final unit).
 *
 * `CHANGELOG.md` has shipped the claim since v1.36.0: "the paired holdout
 * harness measures graph lift separately from direct recall and fails the
 * gate on any dangling or unhydrated target". The harness existed; no
 * production caller reached it, so no operator could ever meet the gate.
 * These tests are what makes the shipped sentence true.
 *
 * The gate rides on the verb's existing write flag. Dry-run is the verb's
 * preview mode and stays byte-identical; `--apply` plans first, evaluates
 * the harness over the edges that plan proposes, and refuses to write when
 * the harness reports a target that resolves to nothing or hydrates to no
 * evidence.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { DIAGNOSTIC_SIGNALS } from "../../src/core/brain/diagnostics.ts";
import { runCli } from "../helpers/run-cli.ts";

/** The code the gate's refusal resolves its exit through. */
const HOLDOUT_GATE_CODE = "repair-holdout-unresolved";

/** The month shard the fixture continuity record lands in. */
const FIXTURE_CONTINUITY_MONTH = "2026-06";
const FIXTURE_CONTINUITY_AT = `${FIXTURE_CONTINUITY_MONTH}-13T12:00:00Z`;

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-repair-holdout-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "Notes"), { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
  writeNote("Notes/alpha.md", "Alpha", "This note discusses Beta at length.");
  writeNote("Notes/beta.md", "Beta", "standalone");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeNote(rel: string, title: string, body: string): void {
  writeFileSync(
    join(vault, rel),
    ["---", "kind: brain-note", `title: ${title}`, "---", "", body, ""].join("\n"),
    "utf8",
  );
}

/**
 * Record two notes as co-referenced in one session event. Written through
 * the store's own builder so the fixture cannot drift from the record shape
 * the reader parses.
 */
function writeContinuityPair(left: string, right: string): void {
  const record = buildContinuityRecord({
    kind: "recall_telemetry",
    createdAt: FIXTURE_CONTINUITY_AT,
    sourceRefs: [
      { id: "left", path: left },
      { id: "right", path: right },
    ],
    payload: { host: "test" },
  });
  const dir = join(vault, "Brain", "log", "continuity");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${FIXTURE_CONTINUITY_MONTH}.jsonl`), `${JSON.stringify(record)}\n`);
}

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

const applyArgs = ["brain", "repair-lane", "--apply", "--confirm", "apply repair", "--json"];

interface RefusalEnvelope {
  readonly ok: boolean;
  readonly message: string;
  readonly next_command?: string;
  readonly holdout?: Record<string, number | boolean>;
}

test("an apply whose proposed edges dangle is refused and writes nothing", async () => {
  // A session event co-references a live note and one that no longer
  // exists: the lane proposes that edge, and its target resolves to no
  // durable memory at all.
  writeContinuityPair("Notes/beta.md", "Notes/ghost.md");
  const before = readFileSync(join(vault, "Notes/alpha.md"), "utf8");

  const res = await runCli(applyArgs, { env: env() });

  expect(res.returncode).toBe(1);
  const envelope = JSON.parse(res.stdout) as RefusalEnvelope;
  expect(envelope.ok).toBe(false);
  expect(envelope.holdout?.["passed"]).toBe(false);
  expect(envelope.holdout?.["dangling"]).toBeGreaterThan(0);
  expect(envelope.message).toContain("Notes/ghost.md");
  // The refusal names its exit through the registered diagnostic.
  expect(envelope.next_command).toBe(DIAGNOSTIC_SIGNALS.get(HOLDOUT_GATE_CODE)!.nextCommand);
  // Nothing was written, including the edge that would have passed.
  expect(readFileSync(join(vault, "Notes/alpha.md"), "utf8")).toBe(before);
});

test("an apply whose proposed edge hydrates to no evidence is refused", async () => {
  // The target resolves to durable memory but carries no body, so the edge
  // cannot lift recall even though it is not dangling.
  writeNote("Notes/gamma.md", "Gamma", "");
  writeNote("Notes/delta.md", "Delta", "This note discusses Gamma at length.");
  const before = readFileSync(join(vault, "Notes/delta.md"), "utf8");

  const res = await runCli(applyArgs, { env: env() });

  expect(res.returncode).toBe(1);
  const envelope = JSON.parse(res.stdout) as RefusalEnvelope;
  expect(envelope.holdout?.["dangling"]).toBe(0);
  expect(envelope.holdout?.["unhydrated"]).toBeGreaterThan(0);
  expect(readFileSync(join(vault, "Notes/delta.md"), "utf8")).toBe(before);
});

test("a clean apply still writes the edge and reports the lift split", async () => {
  const res = await runCli(applyArgs, { env: env() });

  expect(res.returncode).toBe(0);
  const report = JSON.parse(res.stdout) as {
    written: number;
    holdout: Record<string, number | boolean>;
  };
  expect(report.written).toBeGreaterThan(0);
  expect(report.holdout["passed"]).toBe(true);
  expect(report.holdout["dangling"]).toBe(0);
  expect(report.holdout["unhydrated"]).toBe(0);
  // Direct recall and graph lift are counted apart, which is the whole
  // point of the paired harness.
  expect(Object.keys(report.holdout).toSorted()).toEqual([
    "dangling",
    "direct_recall",
    "graph_lift",
    "passed",
    "resolved",
    "total",
    "unhydrated",
  ]);
  expect(readFileSync(join(vault, "Notes/alpha.md"), "utf8")).toContain("beta");
});

test("without --apply the report bytes carry no gate at all", async () => {
  // Byte identity when the feature is off: the gate is evaluated on the
  // write branch only, so the preview a caller already parses is unchanged
  // even in a vault whose candidates would fail the gate.
  writeContinuityPair("Notes/beta.md", "Notes/ghost.md");

  const res = await runCli(["brain", "repair-lane", "--json"], { env: env() });

  expect(res.returncode).toBe(0);
  expect(res.stdout).not.toContain("holdout");
  expect(Object.keys(JSON.parse(res.stdout) as Record<string, unknown>)).toEqual([
    "ok",
    "mode",
    "written",
    "decisions",
  ]);
});

test("the human refusal names the failing edge and the command that resolves it", async () => {
  writeContinuityPair("Notes/beta.md", "Notes/ghost.md");

  const res = await runCli(["brain", "repair-lane", "--apply", "--confirm", "apply repair"], {
    env: env(),
  });

  expect(res.returncode).not.toBe(0);
  expect(res.stderr).toContain("Notes/ghost.md");
  expect(res.stderr).toContain(DIAGNOSTIC_SIGNALS.get(HOLDOUT_GATE_CODE)!.nextCommand);
});
