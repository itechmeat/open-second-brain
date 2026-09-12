/**
 * The `vault_path` field an MCP tool response carries.
 *
 * By default this is the opaque, stable store reference
 * (`vault://<hex>`) rather than the absolute host path, since MCP
 * responses land in model context. The `expose_host_paths` config escape
 * hatch restores the raw path for operators whose tooling depends on it
 * (D2).
 *
 * Both branches read the device-local config - the escape hatch is a
 * config flag and the reference is keyed by a config-held secret - so an
 * unreadable config leaves this field, and ONLY this field, unresolvable.
 * It reports the reason rather than raising, because raising here took
 * down whole diagnostic payloads on their very last field. Degrading to
 * the raw host path instead would breach the redaction contract this
 * function exists to enforce, so there is no value to fall back to.
 *
 * The reason it reports is {@link CONFIG_UNREADABLE_REASON} rather than
 * the error's own message, which names the config file - a path under
 * the operator's home, in the one field written to keep host paths out
 * of model context.
 *
 * ## Why it is a module of its own
 *
 * It used to be a private function inside `./tools.ts`, where the ten
 * Brain domain modules that emit the same field could not reach it -
 * `tools.ts` imports them, so importing it back would close the cycle
 * `tests/core/architecture/import-cycles.test.ts` gates. So they emitted
 * `ctx.vault` instead, and the contract above was honoured at three
 * sites of forty-four. A contract with one implementation needs that
 * implementation to be reachable from every site it governs; this leaf
 * imports nothing from the tool surface, so it is.
 *
 * `tests/core/architecture/vault-path-census.test.ts` is what keeps the
 * next site from finding its own way to say `ctx.vault`.
 */

import { ConfigReadError, resolveExposeHostPaths, vaultStoreReference } from "../core/config.ts";
import { escapeRegex } from "../core/strings.ts";
import type { UnresolvedField } from "../core/vault-presence.ts";
import type { OutputSchema } from "./output-contract.ts";

/**
 * A field whose value could not be resolved, carrying the reason. Same
 * shape `toolStatus` already degrades the `vault` block to when the vault
 * scope cannot be resolved, and `buildSearchStatusBlock` its own: the
 * failure is a value the consumer reads, never a key it has to notice is
 * missing.
 */
export function unresolvedField(err: Error): UnresolvedField {
  return { error: err.message };
}

/**
 * How a declared `outputSchema` describes the field.
 *
 * The value is `string | { error: string }` and the output-contract
 * descriptor language (`src/core/brain/response-shape.ts`) has no union
 * form - no `oneOf`, no `anyOf`. Two schemas used to say `type:
 * "string"`, which was true of what they emitted (the raw host path) and
 * false of what this function returns: on an unreadable config the
 * server's `assertOutputContract` would reject the degraded value and
 * destroy the whole payload, on precisely the condition the degraded
 * value exists to report.
 *
 * So the descriptor widens to the honest form the same schemas already
 * use for a field they cannot narrow (`generated_at: {}`), and it is
 * named ONCE here rather than spelled twice, so the two schemas cannot
 * drift from each other or from the producer above.
 */
export const VAULT_PATH_OUTPUT_SCHEMA: OutputSchema = Object.freeze({});

/**
 * The one field the path POLICY reads: which config decides it.
 *
 * Declared structurally rather than as {@link ServerContext} so the
 * OpenClaw plugin - a second runtime with its own context shape, and
 * three emissions of this same field - can reach it. A contract honoured
 * on one runtime and not the other is the defect this module exists to
 * close, one surface over.
 *
 * Split from {@link VaultPathSource} because the policy readers below
 * take a path (or a sentence) as their subject and never look at
 * `ctx.vault`: asking them for a vault they ignore reads as if the vault
 * were the thing being rendered.
 */
export interface HostPathPolicySource {
  readonly configPath?: string | null;
}

/** The policy source plus the vault {@link vaultPathField} renders. */
export interface VaultPathSource extends HostPathPolicySource {
  readonly vault: string;
}

/**
 * The contract above, applied to any absolute host path.
 *
 * `vaultStoreReference` never required the path to be the vault - it
 * keys an HMAC over whatever it is handed - and the redaction contract
 * is about the response landing in model context, which is equally true
 * of a linked project's directory. `second_brain_wiring` renders both
 * sides of a project link through this, so there is one path policy on
 * this surface rather than a second one written for the second field.
 */
/**
 * What the degraded field says instead of {@link ConfigReadError}'s own
 * message.
 *
 * That message names the config file twice - once in the condition and
 * once in the `chmod` remedy - and it is right to, on the four channels
 * it was written for: a CLI refusal, an MCP error envelope, a hook's
 * stderr, and the two read-only diagnostics whose whole job is to name
 * the broken file. This is none of those. It is the field forty-five
 * tools emit into model context precisely so that an absolute host path
 * does not travel there, and the config file lives under the operator's
 * home. Reporting the condition by naming that path would reintroduce,
 * in the degraded branch, the leak the resolved branch exists to
 * prevent.
 *
 * Nothing is lost to the operator: `second_brain_status` and
 * `vault_health` still name the file, from their own fields, under the
 * contract that says those fields may.
 */
export const CONFIG_UNREADABLE_REASON =
  "the device-local config could not be read, so this reference cannot be " +
  "resolved; call second_brain_status for the file and the remedy";

export function hostPathReference(
  path: string,
  source: HostPathPolicySource,
): string | UnresolvedField {
  const configPath = source.configPath ?? undefined;
  try {
    return resolveExposeHostPaths(configPath) ? path : vaultStoreReference(path, configPath);
  } catch (err) {
    if (err instanceof ConfigReadError) return { error: CONFIG_UNREADABLE_REASON };
    throw err;
  }
}

/** The contract above, as the one value every emitting site returns. */
export function vaultPathField(ctx: VaultPathSource): string | UnresolvedField {
  return hostPathReference(ctx.vault, ctx);
}

/** How a folded path names the host home. */
const HOME_REFERENCE = "~";

/**
 * The shortest home this function will fold.
 *
 * A home of `/` (or the empty string an unresolved lookup leaves) is a
 * prefix of every absolute path on the machine, so folding it would
 * rewrite unrelated paths into nonsense rather than redact anything.
 */
const SHORTEST_FOLDABLE_HOME = 2;

/**
 * What may NOT follow the home for the match to be the home.
 *
 * A plain prefix replacement run under a home named `dev` would clip a
 * sibling named `developer` in the same sentence into `~eloper`: a
 * mangled path is worse than either the raw one or the folded one,
 * because it names a file that does not exist. The home matches only
 * where the next character cannot continue a directory name - a
 * separator, punctuation, whitespace, or the end of the sentence.
 */
const NAME_CHARACTER = "[A-Za-z0-9._-]";

/**
 * Free-form adapter prose with the host home folded to `~`.
 *
 * `verify()` composes its `details` and `fix_hint` sentences from
 * `InstallEnv.home`, so a drifted install names an absolute path under
 * the operator's account - in the same MCP payload whose `vault_path`
 * was deliberately reduced to an opaque reference. {@link
 * hostPathReference} does not apply: a store reference keys the VAULT,
 * and hashing a third party's `~/.grok/hooks/...` would name nothing the
 * reader can act on.
 *
 * So the home PREFIX is folded instead. The file stays identifiable, the
 * account name does not travel, and the rewrite is one exact
 * substitution of a string this run resolved - never a search for
 * path-shaped text inside a sentence.
 *
 * Fails closed: an unreadable config folds, because printing raw host
 * paths is the branch an operator opts into.
 */
export function foldHostHome(text: string, home: string, source: HostPathPolicySource): string {
  if (home.length < SHORTEST_FOLDABLE_HOME) return text;
  try {
    if (resolveExposeHostPaths(source.configPath ?? undefined)) return text;
  } catch (err) {
    if (!(err instanceof ConfigReadError)) throw err;
    // Fall through and fold: an unreadable config is not consent to
    // print host paths, and the branch that prints them is opt-in.
  }
  return text.replace(new RegExp(`${escapeRegex(home)}(?!${NAME_CHARACTER})`, "g"), HOME_REFERENCE);
}
