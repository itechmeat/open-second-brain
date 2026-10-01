/**
 * `o2b brain repair-lane` (G1, t_6832aac6). Dry-run is the default and writes
 * nothing; --apply requires the exact --confirm phrase before any edge is
 * written; a rerun after apply converges to zero writes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import {
  stageHubSelection,
  type HubRefusal,
} from "../../src/core/brain/link-graph/hub-candidates.ts";
import {
  IDENTITY_STRENGTH,
  type RepairCandidate,
} from "../../src/core/brain/link-graph/repair-lane.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-repair-lane-cli-"));
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
  const abs = join(vault, rel);
  // The hub fixtures land in directories the shared beforeEach does not
  // create; recursive mkdir is a no-op where the parent already exists.
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    ["---", "kind: brain-note", `title: ${title}`, "---", "", body, ""].join("\n"),
    "utf8",
  );
}

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

/** Stage one area-membership candidate and one skip-no-hub refusal for the lane. */
function stageHubFixtures(): void {
  writeNote("captured/idea.md", "Idea", "an atomic idea note");
  writeNote("Brain/areas/ops.md", "Ops Hub", "[[a]] [[b]] [[c]] [[d]] [[e]]");
  const candidate: RepairCandidate = {
    source: "captured/idea.md",
    target: "Brain/areas/ops.md",
    strength: IDENTITY_STRENGTH.areaMembership,
    confidence: 1,
    reason: "area hub Brain/areas/ops.md for scope bucket (unscoped)",
  };
  const refusal: HubRefusal = {
    source: "captured/grocery.md",
    target: "",
    strength: IDENTITY_STRENGTH.areaMembership,
    confidence: 1,
    action: "skip-no-hub",
    reason: "no hub page in scope bucket (unscoped)",
  };
  stageHubSelection(vault, { outcome: "candidate", candidate });
  stageHubSelection(vault, { outcome: "refusal", refusal });
}

test("dry-run reports a candidate and writes nothing", async () => {
  const before = readFileSync(join(vault, "Notes/alpha.md"), "utf8");
  const res = await runCli(["brain", "repair-lane", "--json"], { env: env() });
  expect(res.returncode).toBe(0);
  const report = JSON.parse(res.stdout) as { mode: string; decisions: unknown[] };
  expect(report.mode).toBe("dry-run");
  expect(report.decisions.length).toBeGreaterThan(0);
  expect(readFileSync(join(vault, "Notes/alpha.md"), "utf8")).toBe(before);
});

test("apply without the exact confirmation phrase is refused", async () => {
  const res = await runCli(["brain", "repair-lane", "--apply", "--confirm", "nope"], {
    env: env(),
  });
  expect(res.returncode).not.toBe(0);
  expect(readFileSync(join(vault, "Notes/alpha.md"), "utf8")).not.toContain("[[");
});

test("a refused apply under --json emits a JSON error envelope, not plain text", async () => {
  const res = await runCli(["brain", "repair-lane", "--apply", "--confirm", "nope", "--json"], {
    env: env(),
  });
  expect(res.returncode).toBe(1);
  const parsed = JSON.parse(res.stdout) as { ok: boolean; message: string };
  expect(parsed.ok).toBe(false);
  expect(parsed.message).toContain("confirmation phrase");
});

test("apply with the exact phrase writes the edge, and a rerun is a no-op", async () => {
  const applied = await runCli(
    ["brain", "repair-lane", "--apply", "--confirm", "apply repair", "--json"],
    { env: env() },
  );
  expect(applied.returncode).toBe(0);
  const first = JSON.parse(applied.stdout) as { written: number };
  expect(first.written).toBeGreaterThan(0);
  expect(readFileSync(join(vault, "Notes/alpha.md"), "utf8")).toContain("beta");

  const rerun = await runCli(
    ["brain", "repair-lane", "--apply", "--confirm", "apply repair", "--json"],
    { env: env() },
  );
  const second = JSON.parse(rerun.stdout) as { written: number };
  expect(second.written).toBe(0);
});

describe("staged hub records (t_23bd347d)", () => {
  test("a dry-run merges the staged candidate and refusal into its decisions", async () => {
    stageHubFixtures();
    const res = await runCli(["brain", "repair-lane", "--json"], { env: env() });
    expect(res.returncode).toBe(0);
    const report = JSON.parse(res.stdout) as {
      mode: string;
      written: number;
      decisions: Array<{ source: string; target: string; action: string; strength: string }>;
    };
    expect(report.mode).toBe("dry-run");
    const candidate = report.decisions.find((d) => d.source === "captured/idea.md");
    expect(candidate).toBeDefined();
    expect(candidate!.action).toBe("write");
    expect(candidate!.strength).toBe("area_membership");
    expect(candidate!.target).toBe("Brain/areas/ops.md");
    const refusal = report.decisions.find((d) => d.source === "captured/grocery.md");
    expect(refusal).toBeDefined();
    expect(refusal!.action).toBe("skip-no-hub");
    expect(refusal!.target).toBe("");
  });

  test("an apply writes the staged candidate through the gate; the refusal is never written", async () => {
    stageHubFixtures();
    const res = await runCli(
      ["brain", "repair-lane", "--apply", "--confirm", "apply repair", "--json"],
      { env: env() },
    );
    expect(res.returncode).toBe(0);
    const report = JSON.parse(res.stdout) as {
      written: number;
      decisions: Array<{ source: string; target: string; action: string }>;
    };
    expect(report.written).toBeGreaterThan(0);
    // The edge landed through the lane's own apply path, under the section
    // heading the lane owns.
    const idea = readFileSync(join(vault, "captured/idea.md"), "utf8");
    expect(idea).toContain("[[Brain/areas/ops.md]]");
    expect(idea).toContain("## Related (repair-lane)");
    // The refusal proposed no edge and named no target, so no note changed.
    expect(report.decisions.find((d) => d.source === "captured/grocery.md")!.action).toBe(
      "skip-no-hub",
    );
    expect(existsSync(join(vault, "captured/grocery.md"))).toBe(false);
  });

  test("a rerun after the apply converges to zero writes (forward-scan idempotence)", async () => {
    stageHubFixtures();
    await runCli(["brain", "repair-lane", "--apply", "--confirm", "apply repair", "--json"], {
      env: env(),
    });
    const rerun = await runCli(
      ["brain", "repair-lane", "--apply", "--confirm", "apply repair", "--json"],
      { env: env() },
    );
    const second = JSON.parse(rerun.stdout) as { written: number };
    expect(second.written).toBe(0);
  });
});
