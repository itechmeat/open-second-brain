/**
 * Project vault pointers (Workspace Insight Suite, t_1375e69f): a JSON
 * pointer file links any project directory to its owning vault, with a
 * walk-up discovery used by `resolveVault` and a linked-projects
 * registry beside the config file.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VAULT_POINTER_FILE,
  findVaultPointer,
  linkedProjectsStatus,
  listLinkedProjects,
  projectsRegistryPath,
  readVaultPointer,
  registerLinkedProject,
  removeVaultPointer,
  resolvePointerVault,
  unregisterLinkedProject,
  writeVaultPointer,
} from "../../../src/core/brain/portability/pointer.ts";
import { resolveVault } from "../../../src/core/config.ts";

let tmp: string;
let vault: string;
let project: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pointer-"));
  vault = join(tmp, "vault");
  project = join(tmp, "project");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(project, { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── pointer file round-trip ─────────────────────────────────────────────────

test("writeVaultPointer creates the pointer file and readVaultPointer round-trips", () => {
  const path = writeVaultPointer(project, vault);
  expect(path).toBe(join(project, VAULT_POINTER_FILE));
  const probe = readVaultPointer(project);
  expect(probe).not.toBeNull();
  expect(probe!.pointer!.vault).toBe(vault);
  expect(probe!.error).toBeNull();
  // On-disk shape is snake_case with a linked_at stamp.
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  expect(raw["vault"]).toBe(vault);
  expect(typeof raw["linked_at"]).toBe("string");
});

test("readVaultPointer returns null when no pointer file exists", () => {
  expect(readVaultPointer(project)).toBeNull();
});

test("writeVaultPointer validates project dir, vault dir, and self-links", () => {
  expect(() => writeVaultPointer(join(tmp, "ghost"), vault)).toThrow("project directory");
  expect(() => writeVaultPointer(project, join(tmp, "no-vault"))).toThrow("vault");
  // A directory inside the vault must not point at that same vault.
  const inside = join(vault, "Brain", "sub");
  mkdirSync(inside, { recursive: true });
  expect(() => writeVaultPointer(inside, vault)).toThrow("inside");
  expect(() => writeVaultPointer(vault, vault)).toThrow("inside");
});

test("removeVaultPointer deletes the file and reports absence", () => {
  writeVaultPointer(project, vault);
  expect(removeVaultPointer(project)).toBe(true);
  expect(readVaultPointer(project)).toBeNull();
  expect(removeVaultPointer(project)).toBe(false);
});

// ── walk-up discovery ───────────────────────────────────────────────────────

test("findVaultPointer walks up from a nested directory", () => {
  writeVaultPointer(project, vault);
  const nested = join(project, "packages", "api", "src");
  mkdirSync(nested, { recursive: true });
  const probe = findVaultPointer(nested);
  expect(probe).not.toBeNull();
  expect(probe!.dir).toBe(project);
  expect(probe!.pointer!.vault).toBe(vault);
});

test("findVaultPointer returns null when nothing is found up to the root", () => {
  expect(findVaultPointer(project)).toBeNull();
});

test("a malformed pointer is surfaced with an error and resolves to null", () => {
  writeFileSync(join(project, VAULT_POINTER_FILE), "{not json");
  const probe = findVaultPointer(project);
  expect(probe).not.toBeNull();
  expect(probe!.pointer).toBeNull();
  expect(probe!.error).not.toBeNull();
  expect(resolvePointerVault(project)).toBeNull();
});

test("resolvePointerVault is fail-soft when the pointed vault is gone", () => {
  writeVaultPointer(project, vault);
  rmSync(vault, { recursive: true, force: true });
  expect(resolvePointerVault(project)).toBeNull();
});

// ── resolveVault integration ────────────────────────────────────────────────

test("resolveVault prefers a project pointer over the config vault key", () => {
  const otherVault = join(tmp, "other-vault");
  mkdirSync(join(otherVault, "Brain"), { recursive: true });
  writeVaultPointer(project, otherVault);
  const nested = join(project, "deep", "dir");
  mkdirSync(nested, { recursive: true });
  expect(resolveVault(configPath, { cwd: nested })).toBe(otherVault);
});

test("VAULT_DIR env still wins over a project pointer", () => {
  writeVaultPointer(project, vault);
  const prev = process.env["VAULT_DIR"];
  process.env["VAULT_DIR"] = join(tmp, "env-vault");
  try {
    expect(resolveVault(configPath, { cwd: project })).toBe(join(tmp, "env-vault"));
  } finally {
    if (prev === undefined) delete process.env["VAULT_DIR"];
    else process.env["VAULT_DIR"] = prev;
  }
});

test("resolveVault without a pointer keeps the config-key behaviour", () => {
  expect(resolveVault(configPath, { cwd: project })).toBe(vault);
});

// ── linked-projects registry ────────────────────────────────────────────────

test("register/list/unregister round-trip with stable path order", () => {
  const projectB = join(tmp, "a-project");
  mkdirSync(projectB, { recursive: true });
  registerLinkedProject(configPath, project, vault);
  registerLinkedProject(configPath, projectB, vault);
  const listed = listLinkedProjects(configPath);
  expect(listed.map((p) => p.path)).toEqual([projectB, project].toSorted());
  expect(listed[0]!.vault).toBe(vault);
  expect(unregisterLinkedProject(configPath, projectB)).toBe(true);
  expect(unregisterLinkedProject(configPath, projectB)).toBe(false);
  expect(listLinkedProjects(configPath)).toHaveLength(1);
});

test("a malformed registry is tolerated on read", () => {
  writeFileSync(projectsRegistryPath(configPath), "{broken");
  expect(listLinkedProjects(configPath)).toHaveLength(0);
});

test("linkedProjectsStatus reports ok, missing, malformed, and broken vaults", () => {
  registerLinkedProject(configPath, project, vault);
  writeVaultPointer(project, vault);

  const missing = join(tmp, "missing-pointer");
  mkdirSync(missing, { recursive: true });
  registerLinkedProject(configPath, missing, vault);

  const malformed = join(tmp, "malformed-pointer");
  mkdirSync(malformed, { recursive: true });
  registerLinkedProject(configPath, malformed, vault);
  writeFileSync(join(malformed, VAULT_POINTER_FILE), "{broken");

  const statuses = linkedProjectsStatus(configPath);
  const byPath = new Map(statuses.map((s) => [s.path, s]));
  expect(byPath.get(project)!.pointer).toBe("ok");
  expect(byPath.get(project)!.vaultExists).toBe(true);
  expect(byPath.get(missing)!.pointer).toBe("missing");
  expect(byPath.get(malformed)!.pointer).toBe("malformed");
});

test("linkedProjectsStatus flags a pointer that disagrees with the registry", () => {
  const otherVault = join(tmp, "other-vault");
  mkdirSync(join(otherVault, "Brain"), { recursive: true });
  registerLinkedProject(configPath, project, vault);
  writeVaultPointer(project, otherVault);
  const statuses = linkedProjectsStatus(configPath);
  expect(statuses[0]!.pointer).toBe("mismatch");
});
