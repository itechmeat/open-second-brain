/**
 * `o2b vault inspect <relpath>` — point-check one vault-relative path.
 *
 * Anchored in `docs/plans/2026-05-19-vault-scope-design.md` §7.2.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import {
  inspectPath,
  resolveVaultScope,
} from "../../../core/vault-scope/index.ts";
import { CliError, parseFlags } from "../../argparse.ts";
import { resolveBrainVault } from "../../brain/helpers.ts";
import { fail, info, writeJson } from "../../output.ts";

export async function cmdVaultInspect(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const relpath = positional[0];
  if (!relpath) {
    process.stderr.write(
      "error: usage: o2b vault inspect <relpath> [--vault <path>] [--json]\n",
    );
    return 2;
  }
  const config = defaultConfigPath();
  let vault: string;
  try {
    vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  } catch (exc) {
    if (exc instanceof CliError) return fail(exc.message);
    throw exc;
  }
  let result: ReturnType<typeof inspectPath>;
  try {
    const scope = resolveVaultScope(vault);
    result = inspectPath(relpath, scope, vault);
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? exc}\n`);
    return 2;
  }
  // Per design §7.2: the rule decision is meaningful even for paths
  // that do not exist on disk (operator may be checking the policy
  // before authoring the file), but the operator should know
  // whether the answer applies to a real path or a hypothetical one.
  const notFoundSuffix = result.existsOnDisk ? "" : " (not found on disk)";
  if (flags["json"]) {
    writeJson({
      relpath: result.relPath,
      status: result.excluded ? "excluded" : "included",
      exists_on_disk: result.existsOnDisk,
      matched_rule: result.rule
        ? { raw: result.rule.raw, kind: result.rule.kind }
        : null,
      matched_at: result.matchedAt,
      source: result.source,
    });
    return 0;
  }
  info(`relpath:      ${result.relPath}`);
  if (!result.excluded) {
    info(`status:       included${notFoundSuffix}`);
    return 0;
  }
  info(`status:       excluded${notFoundSuffix}`);
  if (result.rule) info(`matched rule: ${result.rule.raw} (${result.rule.kind})`);
  if (result.matchedAt) info(`matched at:   ${result.matchedAt}`);
  info(`source:       ${result.source}`);
  return 0;
}
