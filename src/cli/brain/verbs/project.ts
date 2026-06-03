/**
 * `o2b brain project <link|list|remove|status>` (Workspace Insight
 * Suite, t_1375e69f): pointer files that link project directories to
 * their owning vault, plus the linked-projects registry.
 */

import { resolve } from "node:path";

import { defaultConfigPath, resolveVault } from "../../../core/config.ts";
import {
  findVaultPointer,
  linkedProjectsStatus,
  listLinkedProjects,
  readVaultPointer,
  registerLinkedProject,
  removeVaultPointer,
  unregisterLinkedProject,
  writeVaultPointer,
} from "../../../core/brain/portability/pointer.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainProject(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action || !["link", "list", "remove", "status"].includes(action)) {
    return fail("usage: o2b brain project <link|list|remove|status> [path] [--vault V] [--json]");
  }
  const { flags, positional } = parse(argv.slice(1), {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const json = flags["json"] === true;

  try {
    if (action === "link") {
      const target = positional[0];
      if (!target) return fail("brain project link requires a project path");
      const projectDir = resolve(target);
      const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
      const priorPointer = readVaultPointer(projectDir);
      const pointerPath = writeVaultPointer(projectDir, vault);
      try {
        registerLinkedProject(config, projectDir, vault);
      } catch (registryErr) {
        // Keep the two stores in agreement: roll the pointer back to
        // its prior state before surfacing the registry failure.
        if (priorPointer === null) removeVaultPointer(projectDir);
        else if (priorPointer.pointer !== null) {
          writeVaultPointer(projectDir, priorPointer.pointer.vault);
        }
        throw registryErr;
      }
      if (json) okJson({ ok: true, path: projectDir, vault, pointer: pointerPath });
      else ok(`linked ${projectDir} -> ${vault}`);
      return 0;
    }

    if (action === "list") {
      const projects = listLinkedProjects(config);
      if (json) {
        okJson({ ok: true, projects: projects.map((p) => ({ path: p.path, vault: p.vault })) });
        return 0;
      }
      if (projects.length === 0) {
        ok("no linked projects");
        return 0;
      }
      for (const p of projects) ok(`${p.path} -> ${p.vault}`);
      return 0;
    }

    if (action === "remove") {
      const target = positional[0];
      if (!target) return fail("brain project remove requires a project path");
      const projectDir = resolve(target);
      // Registry first: if the pointer removal then fails, a re-run
      // still succeeds (pointer present, entry already gone). The
      // reverse order would leave a registered project with no pointer.
      const removedEntry = unregisterLinkedProject(config, projectDir);
      const removedPointer = removeVaultPointer(projectDir);
      if (!removedPointer && !removedEntry) {
        return fail(`no project link found at ${projectDir}`);
      }
      if (json) {
        okJson({
          ok: true,
          path: projectDir,
          pointer_removed: removedPointer,
          registry_removed: removedEntry,
        });
      } else ok(`unlinked ${projectDir}`);
      return 0;
    }

    // status: walk-up probe for [path]/cwd + registry-wide health.
    const probeDir = resolve(positional[0] ?? process.cwd());
    const probe = findVaultPointer(probeDir);
    const resolvedVault = resolveVault(config, { cwd: probeDir });
    const mode =
      process.env["VAULT_DIR"] !== undefined && process.env["VAULT_DIR"] !== ""
        ? "env"
        : probe !== null && probe.pointer !== null && resolvedVault === probe.pointer.vault
          ? "pointer"
          : resolvedVault !== null
            ? "config"
            : "unresolved";
    const projects = linkedProjectsStatus(config);
    if (json) {
      okJson({
        ok: true,
        probe_dir: probeDir,
        resolved_vault: resolvedVault,
        resolution: mode,
        pointer:
          probe === null
            ? null
            : {
                path: probe.path,
                dir: probe.dir,
                vault: probe.pointer?.vault ?? null,
                error: probe.error,
              },
        projects: projects.map((p) => ({
          path: p.path,
          vault: p.vault,
          pointer: p.pointer,
          vault_exists: p.vaultExists,
        })),
      });
      return 0;
    }
    ok(`resolved vault: ${resolvedVault ?? "(none)"} [${mode}]`);
    if (probe !== null) {
      if (probe.error !== null) ok(`pointer ${probe.path}: MALFORMED (${probe.error})`);
      else ok(`pointer ${probe.path} -> ${probe.pointer!.vault}`);
    }
    for (const p of projects) {
      const vaultNote = p.vaultExists ? "" : " (vault missing)";
      ok(`${p.path} -> ${p.vault} [${p.pointer}]${vaultNote}`);
    }
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
