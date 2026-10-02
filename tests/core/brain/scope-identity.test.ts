/**
 * Server-resolved scope identity for the scoped operator rules.
 *
 * Project: the basename of the directory holding the nearest
 * `.o2b-vault.json` pointer. Host: the device id. Harness: the launch-time
 * `--harness` option, else the install target. None of them is ever named
 * by a caller.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  VAULT_POINTER_FILE,
  writeVaultPointer,
} from "../../../src/core/brain/portability/pointer.ts";
import {
  resolveHarnessScope,
  resolveHostScope,
  resolveProjectScope,
} from "../../../src/core/brain/scope-identity.ts";
import { withDeviceId } from "../../helpers/device-id.ts";
import { tempDirs } from "../../helpers/temp-dir.ts";

const mkTemp = tempDirs();

describe("resolveProjectScope", () => {
  test("a linked project resolves from a subdirectory to the key of its basename", () => {
    const root = mkTemp("o2b-scope-project-");
    const vault = join(root, "vault");
    const project = join(root, "My_Project.v2");
    const sub = join(project, "src", "deep");
    mkdirSync(vault, { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeVaultPointer(project, vault);
    expect(resolveProjectScope(sub, vault)).toBe("my-project-v2");
    expect(resolveProjectScope(project, vault)).toBe("my-project-v2");
  });

  test("no pointer, a null directory and a malformed pointer give null", () => {
    const root = mkTemp("o2b-scope-none-");
    const vault = join(root, "vault");
    mkdirSync(vault, { recursive: true });
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    expect(resolveProjectScope(bare, vault)).toBeNull();
    expect(resolveProjectScope(null, vault)).toBeNull();

    const broken = join(root, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, VAULT_POINTER_FILE), "{not json");
    expect(resolveProjectScope(broken, vault)).toBeNull();
  });

  test("a project whose name has no Latin character still keys", () => {
    const root = mkTemp("o2b-scope-script-");
    const vault = join(root, "vault");
    const project = join(root, "Проект Альфа");
    mkdirSync(vault, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeVaultPointer(project, vault);
    expect(resolveProjectScope(project, vault)).toBe("проект-альфа");
  });

  test("a directory whose name has no letter or digit gives null", () => {
    const root = mkTemp("o2b-scope-dashes-");
    const vault = join(root, "vault");
    const project = join(root, "---");
    mkdirSync(vault, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeVaultPointer(project, vault);
    expect(resolveProjectScope(project, vault)).toBeNull();
  });
});

/** A vault and a project `client-a` linked to it. */
function linkedTree(): { root: string; vault: string; project: string } {
  const root = mkTemp("o2b-scope-serving-");
  const vault = join(root, "vault");
  const project = join(root, "client-a");
  mkdirSync(vault, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeVaultPointer(project, vault);
  return { root, vault, project };
}

describe("resolveProjectScope and the serving vault", () => {
  test("a pointer naming another vault in a subdirectory is skipped", () => {
    const { root, vault, project } = linkedTree();
    const other = join(root, "other-vault");
    const clone = join(project, "vendor", "evil");
    mkdirSync(other, { recursive: true });
    mkdirSync(join(clone, "src"), { recursive: true });
    writeVaultPointer(clone, other);
    expect(resolveProjectScope(join(clone, "src"), vault)).toBe("client-a");
    expect(resolveProjectScope(join(clone, "src"), other)).toBe("evil");
  });

  test("a malformed pointer in a subdirectory is skipped and the parent pointer wins", () => {
    const { vault, project } = linkedTree();
    const broken = join(project, "vendor", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, VAULT_POINTER_FILE), "{not json");
    expect(resolveProjectScope(broken, vault)).toBe("client-a");
  });

  test("only pointers naming another vault give null", () => {
    const { root, project } = linkedTree();
    const other = join(root, "other-vault");
    mkdirSync(other, { recursive: true });
    expect(resolveProjectScope(project, other)).toBeNull();
  });
});

describe("resolveHostScope", () => {
  test("a device id keys the host", () => {
    expect(withDeviceId("aaaa0001", () => resolveHostScope(undefined))).toEqual({
      host: "aaaa0001",
      unreadable: false,
    });
  });

  test("the empty device id is the explicit opt-out, not a failure", () => {
    expect(withDeviceId("", () => resolveHostScope(undefined))).toEqual({
      host: null,
      unreadable: false,
    });
  });

  test("an unreadable config is reported, not read as absent", () => {
    // A directory in the config file's place fails the read on every
    // platform, so no permission bit is needed.
    const root = mkTemp("o2b-scope-host-");
    const configPath = join(root, "config.yaml");
    mkdirSync(configPath, { recursive: true });
    // An invalid override falls through to the config file.
    expect(withDeviceId("NOT A VALID ID", () => resolveHostScope(configPath))).toEqual({
      host: null,
      unreadable: true,
    });
  });
});

describe("resolveHarnessScope", () => {
  test("the --harness value wins over the install target", () => {
    expect(resolveHarnessScope("codex", "cursor")).toBe("codex");
    expect(resolveHarnessScope(undefined, "cursor")).toBe("cursor");
    expect(resolveHarnessScope(undefined, undefined)).toBeNull();
  });
});
