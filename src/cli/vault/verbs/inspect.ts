/**
 * `o2b vault inspect <relpath>` — point-check one vault-relative path.
 *
 * Anchored in `docs/plans/2026-05-19-vault-scope-design.md` §7.2.
 *
 * Reports TWO independent verdicts about the same path, because they
 * answer different questions and an operator who conflates them will
 * look in the wrong file:
 *
 *   - VAULT SCOPE — is this path part of the vault at all? Governs every
 *     walker (indexer, scanners) and is declared in `vault.ignore_paths`.
 *   - WRITE BINDING — may a CALLER-NAMED write author here? Governs
 *     `brain_create_note` and the update / append / batch arms, and is
 *     declared in `write_binding.path_prefixes`
 *     (provenance-at-the-boundary, unit B).
 *
 * This verb is the registered exit for `write-binding-refused`, so the
 * binding half is not decoration: it is the surface that answers the
 * question the refusal raises.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import { inspectPath, resolveVaultScope } from "../../../core/vault-scope/index.ts";
import { resolveWriteBinding, writeBindingAdmits } from "../../../core/write-binding/index.ts";
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
    process.stderr.write("error: usage: o2b vault inspect <relpath> [--vault <path>] [--json]\n");
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
  let binding: ReturnType<typeof resolveWriteBinding>;
  try {
    const scope = resolveVaultScope(vault);
    result = inspectPath(relpath, scope, vault);
    binding = resolveWriteBinding(vault);
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? exc}\n`);
    return 2;
  }
  // Three states, not two. "No binding is declared" is a different
  // answer from "a binding is declared and admits this path", and
  // collapsing them would tell an operator their boundary is working
  // when they never declared one.
  const bindingAdmits = binding === null ? null : writeBindingAdmits(binding, result.relPath);
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
      matched_rule: result.rule ? { raw: result.rule.raw, kind: result.rule.kind } : null,
      matched_at: result.matchedAt,
      source: result.source,
      write_binding:
        binding === null
          ? { declared: false }
          : {
              declared: true,
              admits: bindingAdmits,
              path_prefixes: binding.pathPrefixes,
            },
    });
    return 0;
  }
  info(`relpath:      ${result.relPath}`);
  if (!result.excluded) {
    info(`status:       included${notFoundSuffix}`);
    reportWriteBinding(binding, bindingAdmits);
    return 0;
  }
  info(`status:       excluded${notFoundSuffix}`);
  if (result.rule) info(`matched rule: ${result.rule.raw} (${result.rule.kind})`);
  if (result.matchedAt) info(`matched at:   ${result.matchedAt}`);
  info(`source:       ${result.source}`);
  reportWriteBinding(binding, bindingAdmits);
  return 0;
}

/** Human-stream rendering of the three write-binding states. */
function reportWriteBinding(
  binding: ReturnType<typeof resolveWriteBinding>,
  admits: boolean | null,
): void {
  if (binding === null) {
    info("write binding: none declared");
    return;
  }
  info(`write binding: ${admits === true ? "admits" : "refuses"} caller-named writes`);
  info(`  prefixes:    ${binding.pathPrefixes.join(", ")}`);
}
