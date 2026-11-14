/**
 * The `template_revision` stamp in `Brain/_BRAIN.md` and the upgrade rules
 * built on it.
 *
 * The manual is synced vault content, and devices sharing one vault do not
 * always run the same release. Without a stamp, a device on an older release
 * saw a newer release's manual as a pending upgrade and rewrote it back to
 * its own template; the newer device then upgraded it forward again, each
 * step behind a pre-apply snapshot. With the stamp, a manual from a newer
 * template revision is left as it is.
 *
 * The hash guard keeps the stamp honest: the hash of the manual as this
 * release renders it (every substitution but the device-local vault name)
 * is recorded next to its revision, so changing the template text or a
 * release constant it renders without bumping the revision fails here.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainManualPath, snapshotsDir } from "../../../src/core/brain/paths.ts";
import {
  BRAIN_MANUAL_TEMPLATE_PATH,
  BRAIN_MANUAL_TEMPLATE_REVISION,
  BRAIN_MANUAL_TEMPLATE_SHA256,
  buildSubstitutions,
  renderTemplate,
  templateRevisionOf,
} from "../../../src/core/brain/templates.ts";
import { planUpgrade } from "../../../src/core/brain/upgrade.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  runSelfHealUpgrade,
  SELF_HEAL_UPGRADE_OUTCOME,
} from "../../../src/core/maintenance/self-heal-upgrade.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const MANUAL = "Brain/_BRAIN.md";

let root: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-manual-revision-"));
  vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(root, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function manual(): string {
  return readFileSync(brainManualPath(vault), "utf8");
}

function writeManual(body: string): void {
  atomicWriteFileSync(brainManualPath(vault), body);
}

/** The current manual with its stamp set to `revision` (or removed when null). */
function withRevision(body: string, revision: string | null): string {
  const stamp = /^template_revision: .*\n/m;
  return revision === null
    ? body.replace(stamp, "")
    : body.replace(stamp, `template_revision: ${revision}\n`);
}

function manualRow() {
  return planUpgrade(vault).files.find((f) => f.path === MANUAL)!;
}

function snapshotCount(): number {
  const dir = snapshotsDir(vault);
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

describe("template revision hash guard", () => {
  test("the recorded hash matches the manual this release renders", () => {
    // Every substitution but the device-local vault name: the template text
    // and the release constants it renders decide the bytes together.
    const substitutions = new Map(buildSubstitutions("guard"));
    substitutions.delete("vault_name");
    const template = readFileSync(BRAIN_MANUAL_TEMPLATE_PATH, "utf8").replace(/\r\n/g, "\n");
    const text = renderTemplate(template, substitutions);
    const actual = createHash("sha256").update(text, "utf8").digest("hex");
    if (actual !== BRAIN_MANUAL_TEMPLATE_SHA256) {
      throw new Error(
        "src/core/brain/templates/_BRAIN.md.tpl, or a release constant it renders " +
          "(schema_version, manifest_sidecar_since), changed without a revision bump. " +
          "Increase BRAIN_MANUAL_TEMPLATE_REVISION in src/core/brain/templates.ts by one " +
          `and set BRAIN_MANUAL_TEMPLATE_SHA256 to "${actual}". ` +
          "Devices on an older revision keep a newer manual as it is, so a template change " +
          "that keeps the old revision would be fought over between releases.",
      );
    }
    expect(actual).toBe(BRAIN_MANUAL_TEMPLATE_SHA256);
  });
});

describe("the rendered manual carries the revision", () => {
  test("a fresh manual is stamped with this release's revision", () => {
    expect(templateRevisionOf(manual())).toBe(BRAIN_MANUAL_TEMPLATE_REVISION);
    expect(manualRow().status).toBe("noop");
  });

  test("a manual without a stamp reads as revision 0", () => {
    expect(templateRevisionOf(withRevision(manual(), null))).toBe(0);
  });

  test("a stamp that is not a non-negative integer reads as revision 0", () => {
    for (const bad of ["abc", "-3", "1.5", ""]) {
      expect(templateRevisionOf(withRevision(manual(), bad))).toBe(0);
    }
  });

  test("a manual saved with a byte order mark keeps its revision", () => {
    expect(templateRevisionOf(`\uFEFF${manual()}`)).toBe(BRAIN_MANUAL_TEMPLATE_REVISION);
  });

  test("a stamp outside the frontmatter is not the manual's revision", () => {
    const body = `${withRevision(manual(), null)}\ntemplate_revision: 99\n`;
    expect(templateRevisionOf(body)).toBe(0);
  });
});

describe("upgrade plan rules for the manual", () => {
  test("a manual from before the stamp is upgraded to the stamped rendering", () => {
    const current = manual();
    writeManual(withRevision(current, null));

    const row = manualRow();
    expect(row.status).toBe("update");
    expect(row.after).toBe(current);
  });

  test("a manual from an older revision is upgraded", () => {
    const current = manual();
    writeManual(`${withRevision(current, String(BRAIN_MANUAL_TEMPLATE_REVISION - 1))}old text\n`);

    expect(manualRow().status).toBe("update");
  });

  test("a manual from the same revision with other bytes is still repaired", () => {
    const current = manual();
    writeManual(`${current}hand edit\n`);

    const row = manualRow();
    expect(row.status).toBe("update");
    expect(row.after).toBe(current);
  });

  test("a manual from a newer revision is left as it is and reported", () => {
    const newer = `${withRevision(manual(), String(BRAIN_MANUAL_TEMPLATE_REVISION + 1))}newer rule\n`;
    writeManual(newer);

    const plan = planUpgrade(vault);
    const row = plan.files.find((f) => f.path === MANUAL)!;
    expect(row.status).toBe("noop");
    expect(row.aheadRevision).toBe(BRAIN_MANUAL_TEMPLATE_REVISION + 1);
    expect(plan.pending).toBe(0);
  });

  test("self-heal neither rewrites nor snapshots a manual from a newer revision", () => {
    const newer = `${withRevision(manual(), String(BRAIN_MANUAL_TEMPLATE_REVISION + 1))}newer rule\n`;
    writeManual(newer);

    expect(runSelfHealUpgrade(vault).outcome).toBe(SELF_HEAL_UPGRADE_OUTCOME.current);
    expect(manual()).toBe(newer);
    expect(snapshotCount()).toBe(0);
  });
});

/** Replace the manual with one a newer release would write. */
function writeNewer(): void {
  writeManual(`${withRevision(manual(), String(BRAIN_MANUAL_TEMPLATE_REVISION + 1))}newer rule\n`);
}

describe("the newer revision is visible to the operator", () => {
  test("`o2b brain upgrade --dry-run` names both revisions", async () => {
    writeNewer();
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(
      `${MANUAL}: kept; written by a newer release (template revision ` +
        `${BRAIN_MANUAL_TEMPLATE_REVISION + 1}, this release ships ${BRAIN_MANUAL_TEMPLATE_REVISION})`,
    );
  });

  test("`o2b brain upgrade --check --json` reports it without a pending change", async () => {
    writeNewer();
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--check", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      pending: number;
      files: Array<{ path: string; status: string; ahead_revision?: number }>;
    };
    expect(out.pending).toBe(0);
    const row = out.files.find((f) => f.path === MANUAL)!;
    expect(row.status).toBe("noop");
    expect(row.ahead_revision).toBe(BRAIN_MANUAL_TEMPLATE_REVISION + 1);
  });

  test("`o2b brain status` lists it as a problem", async () => {
    writeNewer();
    const r = await runCli(["brain", "status", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.stdout).toContain("[managed-file-from-newer-release]");
    expect(r.stdout).toContain(`template revision ${BRAIN_MANUAL_TEMPLATE_REVISION + 1}`);
  });

  test("`o2b brain status` stays quiet when the manual is current", async () => {
    const r = await runCli(["brain", "status", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.stdout).not.toContain("[managed-file-from-newer-release]");
  });
});
