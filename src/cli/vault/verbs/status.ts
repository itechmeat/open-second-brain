/**
 * `o2b vault status` — one-shot view of the vault-scope policy.
 *
 * Walks the vault under the active rule set and prints inclusion
 * counts plus a per-rule list of excluded directories. Anchored in
 * `docs/plans/2026-05-19-vault-scope-design.md` §7.1.
 *
 * The counts are what the INDEX would see: since v1.46.0 the walk
 * applies the index-admission filter the search walker always applied,
 * so this verb no longer reports coverage for paths the indexer
 * refuses.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import { resolveVaultScope, walkVaultScope } from "../../../core/vault-scope/index.ts";
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
      rules: scope.rules.ignore.map((r) => ({ raw: r.raw, kind: r.kind })),
      // `null`, never `[]`: a machine caller must be able to tell "no
      // allowlist declared" from "an allowlist that admits nothing",
      // which is the distinction the config parser refuses to blur.
      include_paths: scope.includePaths === null ? null : [...scope.includePaths],
      included: { files: walk.includedFiles, dirs: walk.includedDirs },
      excluded: {
        dirs: walk.excludedDirs.map(renderExcluded),
        files: walk.excludedFiles.map(renderExcluded),
      },
    });
    return 0;
  }

  info(`vault:         ${vault}`);
  info(`ignore source: ${scope.source}`);
  if (scope.includePaths !== null) {
    info(`include roots: ${scope.includePaths.join(", ")}`);
  }
  info("");
  info(`included: ${walk.includedFiles} files, ${walk.includedDirs} directories`);
  info(`excluded: ${walk.excludedDirs.length} directories, ${walk.excludedFiles.length} files`);
  if (walk.excludedDirs.length > 0) {
    info("");
    info("excluded directories:");
    for (const d of walk.excludedDirs) info(`  ${d.relPath.padEnd(30)} ${describeRefusal(d)}`);
  }
  if (walk.excludedFiles.length > 0) {
    info("");
    info("excluded files:");
    for (const f of walk.excludedFiles) info(`  ${f.relPath.padEnd(30)} ${describeRefusal(f)}`);
  }
  return 0;
}

type Excluded = ReturnType<typeof walkVaultScope>["excludedDirs"][number];

function renderExcluded(entry: Excluded): Record<string, unknown> {
  return {
    rel_path: entry.relPath,
    reason: entry.reason,
    rule: entry.rule === null ? null : entry.rule.raw,
    kind: entry.rule === null ? null : entry.rule.kind,
  };
}

/**
 * One line per refusal, naming what an operator would have to change.
 * A rule that fired is printed; a refusal with no rule behind it says
 * which polarity refused, because there is no entry to point at.
 */
function describeRefusal(entry: Excluded): string {
  if (entry.rule !== null) return `rule ${entry.rule.raw} (${entry.rule.kind})`;
  return `reason ${entry.reason}`;
}
