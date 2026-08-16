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
 * The two fields this producer reads, and nothing else.
 *
 * Declared structurally rather than as {@link ServerContext} so the
 * OpenClaw plugin - a second runtime with its own context shape, and
 * three emissions of this same field - can reach it. A contract honoured
 * on one runtime and not the other is the defect this module exists to
 * close, one surface over.
 */
export interface VaultPathSource {
  readonly vault: string;
  readonly configPath?: string | null;
}

/** The contract above, as the one value every emitting site returns. */
export function vaultPathField(ctx: VaultPathSource): string | UnresolvedField {
  const configPath = ctx.configPath ?? undefined;
  try {
    return resolveExposeHostPaths(configPath)
      ? ctx.vault
      : vaultStoreReference(ctx.vault, configPath);
  } catch (err) {
    if (err instanceof ConfigReadError) return unresolvedField(err);
    throw err;
  }
}
