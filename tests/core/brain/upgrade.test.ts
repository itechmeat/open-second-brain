/**
 * Tests for `src/core/brain/upgrade.ts`.
 *
 * Two layers:
 *   1. `mergeBrainYaml` — pure string transform. Covers missing
 *      sections, missing nested keys, all-present, malformed input
 *      handled at planUpgrade caller (not here).
 *   2. `planUpgrade` / `applyUpgrade` — end-to-end against fixture
 *      vaults bootstrapped via `bootstrapBrain`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { applyUpgrade, mergeBrainYaml, planUpgrade } from "../../../src/core/brain/upgrade.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { brainConfigPath, brainManualPath } from "../../../src/core/brain/paths.ts";
import { listSnapshots } from "../../../src/core/brain/snapshot.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-upgrade-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-upgrade-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("mergeBrainYaml", () => {
  const FULL = `schema_version: 1

primary_agent: null

dream:
  candidate_threshold: 3
  unconfirmed_window_days: 14
  contradiction_window_days: 14

retire:
  stale_evidence_days: 90

confidence:
  low_max_applied: 2
  medium_min: 0.40
  high_min: 0.75

snapshots:
  retention_count: 10
`;

  test("identical input → identical output (no merge needed)", () => {
    expect(mergeBrainYaml(FULL, FULL)).toBe(FULL);
  });

  test("missing top-level section is appended at end-of-file", () => {
    const minimal = `schema_version: 1

primary_agent: null

dream:
  candidate_threshold: 3
  unconfirmed_window_days: 14
  contradiction_window_days: 14
`;
    const merged = mergeBrainYaml(minimal, FULL);
    expect(merged).toContain("retire:");
    expect(merged).toContain("stale_evidence_days: 90");
    expect(merged).toContain("snapshots:");
    expect(merged).toContain("retention_count: 10");
    // Existing keys must remain at their original spot.
    expect(merged.indexOf("schema_version: 1")).toBeLessThan(merged.indexOf("retire:"));
    expect(merged.indexOf("dream:")).toBeLessThan(merged.indexOf("retire:"));
  });

  test("missing nested key is inserted at end of its section", () => {
    const live = `schema_version: 1

primary_agent: null

dream:
  candidate_threshold: 3
  unconfirmed_window_days: 14
  contradiction_window_days: 14

retire:
  stale_evidence_days: 90

confidence:
  low_max_applied: 2
  medium_min: 0.40

snapshots:
  retention_count: 10
`;
    const merged = mergeBrainYaml(live, FULL);
    expect(merged).toContain("high_min: 0.75");
    // Existing `medium_min` line stays where it is.
    const lines = merged.split("\n");
    const mediumIdx = lines.findIndex((l) => l.includes("medium_min: 0.40"));
    const highIdx = lines.findIndex((l) => l.includes("high_min: 0.75"));
    expect(highIdx).toBeGreaterThan(mediumIdx);
  });

  test("user-customised value is preserved (never rewritten)", () => {
    const live = `schema_version: 1

primary_agent: null

dream:
  candidate_threshold: 5
  unconfirmed_window_days: 14
  contradiction_window_days: 14

retire:
  stale_evidence_days: 90

confidence:
  low_max_applied: 2
  medium_min: 0.40
  high_min: 0.75

snapshots:
  retention_count: 10
`;
    const merged = mergeBrainYaml(live, FULL);
    // The user-tuned candidate_threshold of 5 must survive.
    expect(merged).toContain("candidate_threshold: 5");
    expect(merged).not.toContain("candidate_threshold: 3");
  });
});

describe("planUpgrade", () => {
  test("freshly-bootstrapped vault → all files noop", () => {
    const plan = planUpgrade(vault);
    expect(plan.pending).toBe(0);
    expect(plan.errors).toBe(0);
    for (const f of plan.files) {
      expect(f.status).toBe("noop");
    }
  });

  test("file ordering is _brain.yaml, _BRAIN.md", () => {
    const plan = planUpgrade(vault);
    expect(plan.files.map((f) => f.path)).toEqual(["Brain/_brain.yaml", "Brain/_BRAIN.md"]);
  });

  test("missing snapshots section in _brain.yaml → update with appended block", () => {
    const yamlPath = brainConfigPath(vault);
    const original = readFileSync(yamlPath, "utf8");
    // Strip the snapshots block.
    const without = original.replace(/\nsnapshots:[\s\S]*$/, "\n");
    atomicWriteFileSync(yamlPath, without);

    const plan = planUpgrade(vault);
    expect(plan.pending).toBe(1);
    const yamlPlan = plan.files.find((f) => f.path === "Brain/_brain.yaml")!;
    expect(yamlPlan.status).toBe("update");
    expect(yamlPlan.before).toBe(without);
    expect(yamlPlan.after).toContain("snapshots:");
    expect(yamlPlan.after).toContain("retention_count: 10");
  });

  test("malformed _brain.yaml surfaces as error (apply must refuse)", () => {
    atomicWriteFileSync(brainConfigPath(vault), "not: a valid: brain yaml\n");
    const plan = planUpgrade(vault);
    expect(plan.errors).toBe(1);
    const yamlPlan = plan.files.find((f) => f.path === "Brain/_brain.yaml")!;
    expect(yamlPlan.status).toBe("error");
    expect(yamlPlan.error.length).toBeGreaterThan(0);
  });

  test("missing _brain.yaml → status: update with empty before (recoverable)", () => {
    // ENOENT path: a user (or a bad rsync) deleted _brain.yaml from
    // an otherwise-bootstrapped vault. Upgrade must restore it from
    // the canonical default rather than refusing every managed-file
    // update behind one missing config.
    rmSync(brainConfigPath(vault), { force: true });
    const plan = planUpgrade(vault);
    expect(plan.errors).toBe(0);
    const yamlPlan = plan.files.find((f) => f.path === "Brain/_brain.yaml")!;
    expect(yamlPlan.status).toBe("update");
    expect(yamlPlan.before).toBe("");
    expect(yamlPlan.after).toContain("schema_version: 1");
  });

  test("hand-edited _BRAIN.md → status update with full diff", () => {
    atomicWriteFileSync(brainManualPath(vault), "stale operator copy\n");
    const plan = planUpgrade(vault);
    const manualPlan = plan.files.find((f) => f.path === "Brain/_BRAIN.md")!;
    expect(manualPlan.status).toBe("update");
    expect(manualPlan.before).toBe("stale operator copy\n");
    expect(manualPlan.after).toContain("Brain");
  });
});

describe("applyUpgrade", () => {
  test("nothing to do → no snapshot, no log row", () => {
    const before = listSnapshots(vault).length;
    const res = applyUpgrade(vault, { agent: "claude-vps-agent" });
    expect(res.files_updated).toEqual([]);
    expect(res.run_id).toBe("");
    expect(listSnapshots(vault).length).toBe(before);
  });

  test("pending update → snapshot, files rewritten, idempotent re-run", () => {
    atomicWriteFileSync(brainManualPath(vault), "stale operator copy\n");
    const res = applyUpgrade(vault, { agent: "claude-vps-agent" });
    expect(res.run_id.startsWith("upgrade-")).toBe(true);
    expect(res.files_updated).toContain("Brain/_BRAIN.md");
    // Snapshot exists with the upgrade prefix.
    const snaps = listSnapshots(vault);
    expect(snaps.some((s) => s.run_id === res.run_id)).toBe(true);
    // The live file is now the canonical template body.
    expect(readFileSync(brainManualPath(vault), "utf8")).not.toBe("stale operator copy\n");
    // Idempotent re-run: plan is now empty.
    const res2 = applyUpgrade(vault, { agent: "claude-vps-agent" });
    expect(res2.files_updated).toEqual([]);
  });

  test("log row records run id, agent, snapshot, files list", () => {
    atomicWriteFileSync(brainManualPath(vault), "stale operator copy\n");
    const res = applyUpgrade(vault, {
      agent: "claude-vps-agent",
      now: new Date("2026-05-18T10:00:00Z"),
    });
    const logPath = join(vault, "Brain", "log", "2026-05-18.md");
    expect(existsSync(logPath)).toBe(true);
    const logBody = readFileSync(logPath, "utf8");
    expect(logBody).toContain("upgrade");
    expect(logBody).toContain(res.run_id);
    expect(logBody).toContain("claude-vps-agent");
    expect(logBody).toContain("Brain/_BRAIN.md");
  });

  test("malformed _brain.yaml refuses to apply (no snapshot taken)", () => {
    atomicWriteFileSync(brainConfigPath(vault), "not: a valid: brain yaml\n");
    const before = listSnapshots(vault).length;
    expect(() => applyUpgrade(vault, { agent: "claude" })).toThrow(/upgrade aborted/);
    expect(listSnapshots(vault).length).toBe(before);
  });

  test("can rollback to upgrade-<ts> snapshot to undo the apply", () => {
    atomicWriteFileSync(brainManualPath(vault), "stale operator copy\n");
    const beforeBytes = readFileSync(brainManualPath(vault), "utf8");
    const res = applyUpgrade(vault, { agent: "claude" });
    expect(res.files_updated.length).toBeGreaterThan(0);
    // Smoke: snapshot is restorable. We don't run restoreSnapshot
    // directly here — that path has its own coverage; we just verify
    // the snapshot exists and the upgrade actually changed bytes.
    const afterBytes = readFileSync(brainManualPath(vault), "utf8");
    expect(afterBytes).not.toBe(beforeBytes);
    expect(listSnapshots(vault).some((s) => s.run_id === res.run_id)).toBe(true);
  });
});

// ── Corrupted preference principle repair (token-diet, t_40eb1de7) ─────────

describe("planUpgrade / applyUpgrade — preference principle repair", () => {
  const PREF_DIR = "Brain/preferences";

  function writeCorruptedPref(slug: string): string {
    const path = join(vault, PREF_DIR, `pref-${slug}.md`);
    // Faithful copy of the live-vault corruption shape: multi-level
    // backslash-quote chains plus a leaked tool-call XML fragment,
    // inside a double-quoted YAML scalar.
    const principle =
      'When the user describes a rule like \\\\\\"давай так:\\\\\\" wait for approval.</principle>\\\\n<parameter name=\\\\\\"scope\\\\\\">collaboration';
    const content = [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      'created_at: "2026-05-17T15:12:12Z"',
      'unconfirmed_until: "2026-05-17T15:12:12Z"',
      `tags: [brain, brain/preference, brain/topic/${slug}]`,
      `topic: ${slug}`,
      "_status: confirmed",
      `principle: "${principle}"`,
      "_applied_count: 0",
      "_violated_count: 0",
      "_last_evidence_at: null",
      "_confidence: low",
      "_confidence_value: 0",
      "pinned: false",
      "---",
      "",
      "## Origin",
      "",
      "test fixture",
      "",
    ].join("\n");
    atomicWriteFileSync(path, content);
    return path;
  }

  function writeCleanPref(slug: string): string {
    const path = join(vault, PREF_DIR, `pref-${slug}.md`);
    const content = [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      'created_at: "2026-05-17T15:12:12Z"',
      'unconfirmed_until: "2026-05-17T15:12:12Z"',
      `tags: [brain, brain/preference, brain/topic/${slug}]`,
      `topic: ${slug}`,
      "_status: confirmed",
      'principle: "Use measured punctuation in docs."',
      "_applied_count: 2",
      "_violated_count: 0",
      "_last_evidence_at: null",
      "_confidence: medium",
      "_confidence_value: 0.5",
      "pinned: false",
      "---",
      "",
      "## Origin",
      "",
      "test fixture",
      "",
    ].join("\n");
    atomicWriteFileSync(path, content);
    return path;
  }

  test("plan flags a corrupted principle and leaves clean preferences alone", () => {
    writeCorruptedPref("broken");
    writeCleanPref("healthy");
    const plan = planUpgrade(vault);
    const prefPlans = plan.files.filter((f) => f.path.startsWith(PREF_DIR));
    expect(prefPlans.map((f) => f.path)).toEqual([`${PREF_DIR}/pref-broken.md`]);
    expect(prefPlans[0]!.status).toBe("update");
    expect(prefPlans[0]!.after).not.toContain("</principle>");
    expect(prefPlans[0]!.after).not.toContain("<parameter");
  });

  test("apply rewrites the corrupted file once and is idempotent", () => {
    const path = writeCorruptedPref("broken");
    const res = applyUpgrade(vault, { agent: "claude-dev-agent" });
    expect(res.files_updated).toContain(`${PREF_DIR}/pref-broken.md`);

    const bytes = readFileSync(path, "utf8");
    expect(bytes).not.toContain("</principle>");
    expect(bytes).not.toContain("<parameter");
    expect(bytes).not.toContain('\\\\"');
    expect(bytes).toContain('\\"давай так:\\"');
    // Untouched fields survive verbatim.
    expect(bytes).toContain("_status: confirmed");
    expect(bytes).toContain("topic: broken");
    expect(bytes).toContain("## Origin");

    // Second pass: nothing pending.
    const plan2 = planUpgrade(vault);
    expect(plan2.files.filter((f) => f.path.startsWith(PREF_DIR))).toEqual([]);
    const res2 = applyUpgrade(vault, { agent: "claude-dev-agent" });
    expect(res2.files_updated).toEqual([]);
  });
});
