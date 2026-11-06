/**
 * `vault_name` in `Brain/_BRAIN.md` does not flip between two spellings of
 * the same vault directory, nor between the directory names two devices
 * give one synced vault.
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

/**
 * Whether the temp filesystem treats `Vault` and `vault` as one name,
 * probed once in a directory of its own so a skip is reported as a skip.
 */
function tmpIsCaseInsensitive(): boolean {
  const probeRoot = mkdtempSync(join(tmpdir(), "o2b-case-probe-"));
  try {
    mkdirSync(join(probeRoot, "Probe"));
    return existsSync(join(probeRoot, "probe"));
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE_TMP = tmpIsCaseInsensitive();

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
  // A vault synced between devices is a different directory on each, often
  // under a different name (`/Users/<user>/Vault` on a Mac, `/root/vault` on
  // a server). The manual is synced content, so the name it already carries
  // stays; re-rendering it per device made every device undo the other's
  // write on every start.
  test.skipIf(CASE_INSENSITIVE_TMP)(
    "a manual synced from a directory named in another case is not a pending change",
    () => {
      const upper = join(root, "Vault");
      const lower = join(root, "vault");
      bootstrap(upper);
      bootstrap(lower);
      copyFileSync(brainManualPath(upper), brainManualPath(lower));

      expect(manualPlan(lower).status).toBe("noop");
    },
  );

  test("a manual naming an unrelated directory keeps that name", () => {
    const vault = join(root, "notes");
    bootstrap(vault);
    const path = brainManualPath(vault);
    const body = readFileSync(path, "utf8").replace("vault_name: notes", "vault_name: Elsewhere");
    atomicWriteFileSync(path, body);

    expect(manualPlan(vault).status).toBe("noop");
  });

  test("a manual without a vault_name line gets this vault's name", () => {
    const vault = join(root, "notes");
    bootstrap(vault);
    const path = brainManualPath(vault);
    atomicWriteFileSync(path, readFileSync(path, "utf8").replace(/^vault_name: .*\n/m, ""));

    const plan = manualPlan(vault);

    expect(plan.status).toBe("update");
    expect(plan.after).toContain("vault_name: notes");
  });

  test("a vault_name line in the body is not the manual's name", () => {
    const vault = join(root, "notes");
    bootstrap(vault);
    const path = brainManualPath(vault);
    const body = readFileSync(path, "utf8").replace(/^vault_name: .*\n/m, "");
    atomicWriteFileSync(path, `${body}\nvault_name: Operator note\n`);

    const plan = manualPlan(vault);

    expect(plan.status).toBe("update");
    expect(plan.after).toContain("vault_name: notes");
    expect(plan.after).not.toContain("vault_name: Operator note\nschema_version");
  });

  test("a kept name that reads like a placeholder stays literal", () => {
    const vault = join(root, "notes");
    bootstrap(vault);
    const path = brainManualPath(vault);
    const named = readFileSync(path, "utf8").replace(
      "vault_name: notes",
      "vault_name: {{schema_version}}",
    );
    atomicWriteFileSync(path, named);

    expect(manualPlan(vault).status).toBe("noop");
  });

  test("a manual saved with a byte order mark keeps its name", () => {
    const vault = join(root, "notes");
    bootstrap(vault);
    const path = brainManualPath(vault);
    const named = readFileSync(path, "utf8").replace("vault_name: notes", "vault_name: Elsewhere");
    atomicWriteFileSync(path, `\uFEFF${named}`);

    const plan = manualPlan(vault);

    expect(plan.after).toContain("vault_name: Elsewhere");
  });
});
