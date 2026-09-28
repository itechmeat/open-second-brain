/**
 * `vault_name` in `Brain/_BRAIN.md` does not flip between two spellings of
 * the same vault directory.
 *
 * The display name is the basename of the vault path as the caller spelled
 * it. On a case-insensitive filesystem (macOS, Windows) `.../vault` and
 * `.../Vault` open the same directory, so one runtime rendering `vault` and
 * another rendering `Vault` made `o2b brain upgrade` see a pending change
 * that no apply could ever settle - and the self-heal upgrade re-ran it
 * (snapshot included) on every start.
 *
 * A symlink with the other spelling reproduces "two spellings, one
 * directory" on a case-sensitive filesystem too, so these tests run on every
 * host and exercise the real filesystem probe rather than a stub.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainManualPath } from "../../../src/core/brain/paths.ts";
import { planUpgrade } from "../../../src/core/brain/upgrade.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-vault-name-case-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function bootstrap(vault: string): void {
  mkdirSync(vault, { recursive: true });
  const configPath = join(root, `config-${Math.random().toString(36).slice(2)}.yaml`);
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
}

function manualPlan(vault: string) {
  return planUpgrade(vault).files.find((f) => f.path === "Brain/_BRAIN.md")!;
}

/** Whether `root` itself treats `Vault` and `vault` as one name. */
function rootIsCaseInsensitive(): boolean {
  mkdirSync(join(root, "Probe"));
  const insensitive = existsSync(join(root, "probe"));
  rmSync(join(root, "Probe"), { recursive: true });
  return insensitive;
}

describe("vault_name under two spellings of one vault directory", () => {
  test("a manual rendered under the other spelling is not a pending change", () => {
    const canonical = join(root, "Vault");
    bootstrap(canonical);
    const other = join(root, "vault");
    if (!existsSync(other)) {
      // A case-sensitive filesystem: make `vault` open the same directory.
      symlinkSync(canonical, other, "dir");
    }
    expect(readFileSync(brainManualPath(canonical), "utf8")).toContain("vault_name: Vault");

    const plan = planUpgrade(other);

    expect(plan.pending).toBe(0);
  });
});

describe("vault_name for two different directories", () => {
  test.skipIf(process.platform === "win32" || process.platform === "darwin")(
    "a case-only difference that names ANOTHER directory is still a pending change",
    () => {
      if (rootIsCaseInsensitive()) return;
      // Two real vaults whose names differ only in case. The manual copied
      // from `Vault` into `vault` really is stale there.
      const upper = join(root, "Vault");
      const lower = join(root, "vault");
      bootstrap(upper);
      bootstrap(lower);
      copyFileSync(brainManualPath(upper), brainManualPath(lower));

      const plan = manualPlan(lower);

      expect(plan.status).toBe("update");
      expect(plan.after).toContain("vault_name: vault");
    },
  );

  test("a manual naming an unrelated vault is still a pending change", () => {
    const vault = join(root, "notes");
    bootstrap(vault);
    const path = brainManualPath(vault);
    const body = readFileSync(path, "utf8").replace("vault_name: notes", "vault_name: Elsewhere");
    atomicWriteFileSync(path, body);

    expect(manualPlan(vault).status).toBe("update");
  });
});
