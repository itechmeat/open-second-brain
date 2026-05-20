/**
 * `o2b vault status` — one-shot view of the vault-scope policy.
 *
 * Walks the vault under the active rule set and prints inclusion
 * counts plus a per-rule list of excluded directories. Anchored in
 * `docs/plans/2026-05-19-vault-scope-design.md` §7.1.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import {
  resolveVaultScope,
  walkVaultScope,
} from "../../../core/vault-scope/index.ts";
import { CliError, parseFlags } from "../../argparse.ts";
import { resolveBrainVault } from "../../brain/helpers.ts";
import { fail, info, writeJson } from "../../output.ts";

export async function cmdVaultStatus(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  let vault: string;
  try {
    vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  } catch (exc) {
    if (exc instanceof CliError) return fail(exc.message);
    throw exc;
  }
  let scope: ReturnType<typeof resolveVaultScope>;
  let walk: ReturnType<typeof walkVaultScope>;
  try {
    scope = resolveVaultScope(vault);
    walk = walkVaultScope(vault, scope);
  } catch (exc) {
    return fail(`vault status failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    writeJson({
      vault,
      ignore_source: scope.source,
      rules: scope.rules.map((r) => ({ raw: r.raw, kind: r.kind })),
      included: { files: walk.includedFiles, dirs: walk.includedDirs },
      excluded: {
        dirs: walk.excludedDirs.map((d) => ({
          rel_path: d.relPath,
          rule: d.rule.raw,
          kind: d.rule.kind,
        })),
        files: walk.excludedFiles.map((f) => ({
          rel_path: f.relPath,
          rule: f.rule.raw,
          kind: f.rule.kind,
        })),
      },
    });
    return 0;
  }

  info(`vault:         ${vault}`);
  info(`ignore source: ${scope.source}`);
  info("");
  info(`included: ${walk.includedFiles} files, ${walk.includedDirs} directories`);
  info(
    `excluded: ${walk.excludedDirs.length} directories, ${walk.excludedFiles.length} files`,
  );
  if (walk.excludedDirs.length > 0) {
    info("");
    info("excluded directories:");
    for (const d of walk.excludedDirs) {
      info(`  ${d.relPath.padEnd(30)} rule ${d.rule.raw} (${d.rule.kind})`);
    }
  }
  if (walk.excludedFiles.length > 0) {
    info("");
    info("excluded files:");
    for (const f of walk.excludedFiles) {
      info(`  ${f.relPath.padEnd(30)} rule ${f.rule.raw} (${f.rule.kind})`);
    }
  }
  return 0;
}
