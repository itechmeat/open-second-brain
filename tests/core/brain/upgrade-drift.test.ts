/**
 * Compare-before-write upgrades: `applyUpgrade` writes the plan it was
 * handed, and a managed file that changed on disk after that plan was read
 * is refused by name instead of being overwritten.
 *
 * Two windows are pinned. An edit made after the plan and before the apply
 * is refused before any snapshot is taken. An edit that lands while the
 * snapshot runs (injected through a spy on `createSnapshot`) is refused at
 * its own row: with nothing written yet the message says so and points at a
 * fresh dry run; with rows already rewritten it names them and points at
 * the same dry run. No rollback is offered: the snapshot manifest predates
 * the apply, so a plain rollback refuses on the rewritten rows and a forced
 * one would destroy the edit.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath, brainManualPath } from "../../../src/core/brain/paths.ts";
import * as snapshotModule from "../../../src/core/brain/snapshot.ts";
import { listSnapshots } from "../../../src/core/brain/snapshot.ts";
import {
  BrainUpgradeError,
  applyUpgrade,
  planUpgrade,
  type UpgradeFilePlan,
  type UpgradePlan,
} from "../../../src/core/brain/upgrade.ts";
import { sealWithDigest } from "../../../src/core/integrity/digest.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-upgrade-drift-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-upgrade-drift-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function row(plan: UpgradePlan, path: string) {
  const found = plan.files.find((f) => f.path === path);
  if (found === undefined) throw new Error(`no plan row for ${path}`);
  return found;
}

function upgradeError(fn: () => unknown): BrainUpgradeError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BrainUpgradeError);
    return err as BrainUpgradeError;
  }
  throw new Error("expected a BrainUpgradeError");
}

function snapshotCount(): number {
  return listSnapshots(vault).snapshots.length;
}

/**
 * A plan a caller recomputed for its own rows: the body changes, so the
 * seal must be recomputed with it. This is what an honest caller does;
 * the seal test below covers the dishonest one who skips it.
 */
function reseal(plan: UpgradePlan, files: ReadonlyArray<UpgradeFilePlan>): UpgradePlan {
  const { digest: _stale, ...body } = plan;
  return Object.freeze(sealWithDigest({ ...body, files: Object.freeze(files) }));
}

/**
 * A plan with both managed files pending: a stale manual, and a config with
 * its trailing `snapshots:` block cut. The cut pins the default layout, so
 * it is asserted to have happened before the plan is trusted.
 */
function twoRowPlan(): { plan: UpgradePlan; without: string } {
  writeFileSync(brainManualPath(vault), "stale\n");
  const yaml = readFileSync(brainConfigPath(vault), "utf8");
  const without = yaml.replace(/\nsnapshots:[\s\S]*$/, "\n");
  expect(without).not.toBe(yaml);
  writeFileSync(brainConfigPath(vault), without);
  const plan = planUpgrade(vault);
  expect(plan.pending).toBe(2);
  return { plan, without };
}

/** Run `applyUpgrade` with `edit` injected right after the snapshot is taken. */
function applyWithEditDuringSnapshot(plan: UpgradePlan, edit: () => void): BrainUpgradeError {
  const realCreate = snapshotModule.createSnapshot;
  const spy = spyOn(snapshotModule, "createSnapshot").mockImplementationOnce((v, id, opts) => {
    const snap = realCreate(v, id, opts);
    edit();
    return snap;
  });
  try {
    const err = upgradeError(() => applyUpgrade(vault, { plan, agent: "test-agent" }));
    expect(spy).toHaveBeenCalledTimes(1);
    return err;
  } finally {
    spy.mockRestore();
  }
}

describe("plan rows tell an absent file from an empty one", () => {
  test("a missing _brain.yaml plans before: null", () => {
    rmSync(brainConfigPath(vault), { force: true });
    expect(row(planUpgrade(vault), "Brain/_brain.yaml").before).toBeNull();
  });

  test("an empty _brain.yaml is still refused as malformed, never planned as absent", () => {
    // The strict parser needs `schema_version`, so an empty config is an
    // `error` row (fix by hand), not an update from `null`.
    writeFileSync(brainConfigPath(vault), "");
    const yaml = row(planUpgrade(vault), "Brain/_brain.yaml");
    expect(yaml.status).toBe("error");
    expect(yaml.before).not.toBeNull();
  });

  test("an empty _BRAIN.md plans before: an empty string", () => {
    writeFileSync(brainManualPath(vault), "");
    const manual = row(planUpgrade(vault), "Brain/_BRAIN.md");
    expect(manual.status).toBe("update");
    expect(manual.before).toBe("");
  });

  test("a missing _BRAIN.md plans before: null", () => {
    rmSync(brainManualPath(vault), { force: true });
    const manual = row(planUpgrade(vault), "Brain/_BRAIN.md");
    expect(manual.status).toBe("update");
    expect(manual.before).toBeNull();
  });
});

describe("applyUpgrade applies the plan it is handed", () => {
  test("the given plan's bytes are written, not a re-plan", () => {
    writeFileSync(brainManualPath(vault), "stale\n");
    const plan = planUpgrade(vault);
    const shown = reseal(
      plan,
      plan.files.map((f) =>
        f.path === "Brain/_BRAIN.md" ? Object.freeze({ ...f, after: "the shown body\n" }) : f,
      ),
    );
    const res = applyUpgrade(vault, { plan: shown, agent: "test-agent" });
    expect(res.files_updated).toEqual(["Brain/_BRAIN.md"]);
    expect(readFileSync(brainManualPath(vault), "utf8")).toBe("the shown body\n");
  });

  test("a clean apply of a given plan snapshots, logs and is idempotent", () => {
    writeFileSync(brainManualPath(vault), "stale\n");
    const before = snapshotCount();
    const res = applyUpgrade(vault, {
      plan: planUpgrade(vault),
      agent: "test-agent",
      now: new Date("2026-10-06T10:00:00Z"),
    });
    expect(res.run_id.startsWith("upgrade-")).toBe(true);
    expect(snapshotCount()).toBe(before + 1);
    const log = readFileSync(join(vault, "Brain", "log", "2026-10-06.md"), "utf8");
    expect(log).toContain(res.run_id);
    expect(planUpgrade(vault).pending).toBe(0);
    expect(applyUpgrade(vault, { plan: planUpgrade(vault) }).files_updated).toEqual([]);
  });
});

describe("a managed file holding invalid UTF-8", () => {
  const stale = Buffer.from([...Buffer.from("stale "), 0xff, 0x0a]);

  test("upgrades when nobody touched it since the plan", () => {
    writeFileSync(brainManualPath(vault), stale);
    const plan = planUpgrade(vault);

    const res = applyUpgrade(vault, { plan, agent: "test-agent" });

    expect(res.files_updated).toEqual(["Brain/_BRAIN.md"]);
    expect(planUpgrade(vault).pending).toBe(0);
  });

  test("is drift when its text changed since the plan", () => {
    writeFileSync(brainManualPath(vault), stale);
    const plan = planUpgrade(vault);
    const edited = Buffer.from([...Buffer.from("edited "), 0xff, 0x0a]);
    writeFileSync(brainManualPath(vault), edited);

    const err = upgradeError(() => applyUpgrade(vault, { plan }));

    expect(err.drifted).toEqual(["Brain/_BRAIN.md"]);
    expect(readFileSync(brainManualPath(vault))).toEqual(edited);
  });
});

describe("a caller-supplied plan that does not verify (t_18fda844)", () => {
  test("a tampered plan is refused by its seal BEFORE the byte-drift check", () => {
    writeFileSync(brainManualPath(vault), "stale\n");
    const plan = planUpgrade(vault);
    // The plan was edited after it was sealed and never re-sealed: the
    // carried digest describes a different body.
    const { digest: _carried, ...body } = plan;
    const tampered: UpgradePlan = Object.freeze({
      ...body,
      files: body.files.map((f) =>
        f.path === "Brain/_BRAIN.md" ? Object.freeze({ ...f, after: "tampered\n" }) : f,
      ),
      digest: plan.digest,
    });
    // Real disk drift too, so the ORDER of the two refusals is what the
    // assertion observes: the seal is checked first.
    writeFileSync(brainManualPath(vault), "hand edit after the plan\n");
    const before = snapshotCount();

    const err = upgradeError(() => applyUpgrade(vault, { plan: tampered, agent: "test-agent" }));

    expect(err.runId).toBeNull();
    expect(err.drifted).toEqual([]);
    expect(err.message).toContain("digest");
    expect(err.message).not.toContain("changed on disk");
    expect(err.message).toContain("o2b brain upgrade --dry-run");
    expect(snapshotCount()).toBe(before);
    expect(readFileSync(brainManualPath(vault), "utf8")).toBe("hand edit after the plan\n");
  });

  test("a plan whose digest is missing is refused the same way", () => {
    writeFileSync(brainManualPath(vault), "stale\n");
    const plan = planUpgrade(vault);
    const { digest: _none, ...unsealed } = plan;
    const before = snapshotCount();

    const err = upgradeError(() =>
      applyUpgrade(vault, { plan: unsealed as UpgradePlan, agent: "test-agent" }),
    );

    expect(err.runId).toBeNull();
    expect(err.message).toContain("digest");
    expect(snapshotCount()).toBe(before);
    expect(readFileSync(brainManualPath(vault), "utf8")).toBe("stale\n");
  });
});

describe("drift found before the snapshot", () => {
  test("a hand edit after the plan refuses with drifted, no snapshot, the edit survives", () => {
    writeFileSync(brainManualPath(vault), "stale\n");
    const plan = planUpgrade(vault);
    writeFileSync(brainManualPath(vault), "hand edit after the plan\n");
    const before = snapshotCount();

    const err = upgradeError(() => applyUpgrade(vault, { plan, agent: "test-agent" }));

    expect(err.runId).toBeNull();
    expect(err.drifted).toEqual(["Brain/_BRAIN.md"]);
    expect(err.message).toContain("Brain/_BRAIN.md");
    expect(err.message).toContain("o2b brain upgrade");
    expect(snapshotCount()).toBe(before);
    expect(readFileSync(brainManualPath(vault), "utf8")).toBe("hand edit after the plan\n");
  });

  test("a file planned as absent that appeared since is drift", () => {
    rmSync(brainManualPath(vault), { force: true });
    const plan = planUpgrade(vault);
    writeFileSync(brainManualPath(vault), "");

    const err = upgradeError(() => applyUpgrade(vault, { plan }));

    expect(err.drifted).toEqual(["Brain/_BRAIN.md"]);
    expect(readFileSync(brainManualPath(vault), "utf8")).toBe("");
  });

  test("a file planned as present that vanished since is drift", () => {
    writeFileSync(brainManualPath(vault), "stale\n");
    const plan = planUpgrade(vault);
    rmSync(brainManualPath(vault), { force: true });

    const err = upgradeError(() => applyUpgrade(vault, { plan }));

    expect(err.drifted).toEqual(["Brain/_BRAIN.md"]);
    expect(existsSync(brainManualPath(vault))).toBe(false);
  });

  test("every drifted path is named, and no row is written", () => {
    const { plan, without } = twoRowPlan();
    writeFileSync(brainManualPath(vault), "edited manual\n");
    writeFileSync(brainConfigPath(vault), `${without}# a comment\n`);

    const err = upgradeError(() => applyUpgrade(vault, { plan }));

    expect(err.drifted.toSorted()).toEqual(["Brain/_BRAIN.md", "Brain/_brain.yaml"]);
    expect(readFileSync(brainConfigPath(vault), "utf8")).toBe(`${without}# a comment\n`);
  });
});

describe("drift found at the write", () => {
  test("drift at the first row: nothing was written, re-plan, no rollback offered", () => {
    writeFileSync(brainManualPath(vault), "stale\n");
    const plan = planUpgrade(vault);
    const err = applyWithEditDuringSnapshot(plan, () =>
      writeFileSync(brainManualPath(vault), "hand edit during the snapshot\n"),
    );

    expect(err.runId).not.toBeNull();
    expect(err.runId!.startsWith("upgrade-")).toBe(true);
    expect(err.drifted).toEqual(["Brain/_BRAIN.md"]);
    expect(err.message).toContain("Brain/_BRAIN.md");
    expect(err.message).toContain("Nothing was written");
    expect(err.message).toContain("o2b brain upgrade --dry-run");
    expect(err.message).not.toContain("rollback");
    expect(readFileSync(brainManualPath(vault), "utf8")).toBe("hand edit during the snapshot\n");
  });

  test("drift at a later row: names the rewritten rows, re-plans against the edit", () => {
    const { plan } = twoRowPlan();
    const rows = plan.files.filter((f) => f.status === "update");
    const [first, second] = [rows[0]!, rows[1]!];
    const secondAbs = join(vault, second.path);
    const edit = "# hand edit during the snapshot\n";
    const err = applyWithEditDuringSnapshot(plan, () => writeFileSync(secondAbs, edit));

    expect(readFileSync(join(vault, first.path), "utf8")).toBe(first.after);
    expect(readFileSync(secondAbs, "utf8")).toBe(edit);
    expect(err.drifted).toEqual([second.path]);
    expect(err.message).toContain(second.path);
    expect(err.message).toContain(`1 file(s) already rewritten: ${first.path}`);
    expect(err.message).toContain("o2b brain upgrade --dry-run");
    expect(err.message).not.toContain("rollback");
    // The offered dry run plans the rest from the partial state: the
    // rewritten row is settled and the drifted row is read with the edit.
    const replan = planUpgrade(vault);
    expect(row(replan, first.path).status).toBe("noop");
    expect(row(replan, second.path).before).toBe(edit);
  });
});
