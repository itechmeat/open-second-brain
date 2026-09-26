/**
 * The secrets directory inside a Syncthing folder.
 *
 * The directory's `.gitignore` keeps the keyfile out of a git commit, but
 * Syncthing reads only the `.stignore` at its folder root. The doctor
 * warns when that file does not ignore the directory, and names the line
 * to add; it never edits `.stignore` itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import { SECRETS_SYNC_EXPOSED_CODE } from "../../../../src/core/brain/doctor/secrets-sync-check.ts";
import { loadOrCreateKey } from "../../../../src/core/brain/secrets/crypto.ts";
import { secretsSyncExposure } from "../../../../src/core/brain/secrets/sync-exposure.ts";
import { secretsDir } from "../../../../src/core/brain/secrets/store.ts";
import { runCli } from "../../../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-secrets-sync-"));
  vault = join(tmp, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function withSecrets(): void {
  loadOrCreateKey(join(secretsDir(vault), "keyfile"));
}

function syncthingFolder(root: string, stignore: string | null): void {
  mkdirSync(join(root, ".stfolder"), { recursive: true });
  if (stignore !== null) writeFileSync(join(root, ".stignore"), stignore);
}

async function exposureFindings(): Promise<ReadonlyArray<{ message: string; path?: string }>> {
  const report = await runDoctor(vault);
  return report.warnings.filter((i) => i.code === SECRETS_SYNC_EXPOSED_CODE);
}

describe("the secrets-sync-exposed doctor check", () => {
  test("says nothing when the vault is not in a Syncthing folder", async () => {
    withSecrets();
    expect(await exposureFindings()).toHaveLength(0);
  });

  test("says nothing when the vault has no secrets directory", async () => {
    syncthingFolder(vault, null);
    expect(await exposureFindings()).toHaveLength(0);
  });

  test("warns with the exact line when .stignore is missing, and does not create it", async () => {
    withSecrets();
    syncthingFolder(vault, null);
    const found = await exposureFindings();
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("/.open-second-brain/secrets");
    expect(found[0]!.path).toBe(join(vault, ".stignore"));
    expect(existsSync(join(vault, ".stignore"))).toBe(false);
  });

  test("warns when .stignore names other things only, and leaves it untouched", async () => {
    withSecrets();
    const content = "// my patterns\n*.tmp\n.obsidian/workspace.json\n";
    syncthingFolder(vault, content);
    expect(await exposureFindings()).toHaveLength(1);
    expect(readFileSync(join(vault, ".stignore"), "utf8")).toBe(content);
  });

  test.each([
    ["/.open-second-brain/secrets\n"],
    ["/.open-second-brain\n"],
    [".open-second-brain/\n"],
    ["(?d)/.open-second-brain/secrets\n"],
    ["(?i)/.OPEN-second-brain\n"],
    ["**/secrets\n"],
    ["/.open-second-brain/*\n"],
  ])("an ignore line covering the directory silences it: %j", async (stignore) => {
    withSecrets();
    syncthingFolder(vault, stignore);
    expect(await exposureFindings()).toHaveLength(0);
  });

  test("a negation that matches first keeps the directory synced", async () => {
    withSecrets();
    syncthingFolder(vault, "!/.open-second-brain\n/.open-second-brain\n");
    expect(await exposureFindings()).toHaveLength(1);
  });

  test("an #include'd file is read", async () => {
    withSecrets();
    writeFileSync(join(vault, ".stglobalignore"), "/.open-second-brain/secrets\n");
    syncthingFolder(vault, "#include .stglobalignore\n");
    expect(await exposureFindings()).toHaveLength(0);
  });

  test("a vault that is a subdirectory of the synced folder is anchored at the folder root", async () => {
    withSecrets();
    syncthingFolder(tmp, "/.open-second-brain/secrets\n");
    // Anchored at the WRONG level: the folder root is `tmp`, not the vault.
    const found = await exposureFindings();
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("/vault/.open-second-brain/secrets");

    writeFileSync(join(tmp, ".stignore"), "/vault/.open-second-brain/secrets\n");
    expect(await exposureFindings()).toHaveLength(0);
  });
});

test("secret set warns on stderr when a Syncthing folder would carry the keyfile", async () => {
  syncthingFolder(vault, null);
  const set = await runCli(["brain", "secret", "set", "api-key", "--vault", vault], {
    stdin: "sk-sync-12345\n",
  });
  expect(set.returncode).toBe(0);
  expect(set.stderr).toContain(".stignore");
  expect(set.stderr).toContain("/.open-second-brain/secrets");
  expect(existsSync(join(vault, ".stignore"))).toBe(false);

  writeFileSync(join(vault, ".stignore"), "/.open-second-brain/secrets\n");
  const again = await runCli(["brain", "secret", "set", "other", "--vault", vault], {
    stdin: "sk-sync-67890\n",
  });
  expect(again.returncode).toBe(0);
  expect(again.stderr).not.toContain(".stignore");
});

describe("a vault reached through a symbolic link", () => {
  // Syncthing walks real directories. A vault opened as `<tmp>/linked`,
  // a link to `<tmp>/sync/notes/vault` inside a Syncthing folder, is
  // carried by that folder even though no `.stfolder` sits above the
  // spelled path.
  function linkedVault(): { linked: string; folder: string } {
    const folder = join(tmp, "sync");
    const real = join(folder, "notes", "vault");
    mkdirSync(join(real, "Brain"), { recursive: true });
    syncthingFolder(folder, null);
    const linked = join(tmp, "linked");
    symlinkSync(real, linked, "dir");
    loadOrCreateKey(join(secretsDir(linked), "keyfile"));
    return { linked, folder };
  }

  test("is reported against the folder its target sits in", () => {
    const { linked, folder } = linkedVault();
    const exposure = secretsSyncExposure(linked);
    expect(exposure).not.toBeNull();
    expect(exposure!.stignorePath).toBe(join(realpathOf(folder), ".stignore"));
    expect(exposure!.suggestedPattern).toBe("/notes/vault/.open-second-brain/secrets");
  });

  test("is quiet once that folder's .stignore covers the directory", () => {
    const { linked, folder } = linkedVault();
    const exposure = secretsSyncExposure(linked)!;
    writeFileSync(join(folder, ".stignore"), `${exposure.suggestedPattern}\n`);
    expect(secretsSyncExposure(linked)).toBeNull();
  });
});

function realpathOf(p: string): string {
  return realpathSync(p);
}
