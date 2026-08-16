/**
 * One failure message with no host location in it.
 *
 * Three surfaces already needed this and each had grown its own copy:
 * `schema-report`'s `locationFreeDetail`, `backlinks`' `failureReason` and
 * `scaffold-stub`'s `hostPathFree`. The reason is always the same one - a
 * {@link BrainParseError} separates prose from location, but the same
 * scans meet plain `node:fs` and YAML errors that carry the absolute path
 * INSIDE the message (`ENOENT: … open '/home/…/Brain/log/x.md'`), and
 * every one of these surfaces states its locations as a vault-relative
 * `path` field beside the reason.
 *
 * It matters beyond tidiness: `collectExportRows` is reachable from an MCP
 * error path, and the contract at `src/mcp/tools.ts` keeps absolute host
 * paths out of model context. A message composed on one surface and
 * cleaned on another is how a path gets out.
 */

import { sep } from "node:path";

import { BrainParseError } from "./parse-error.ts";

/**
 * The failure text with the host location rewritten out.
 *
 * @param err the thrown value, of any shape.
 * @param vault absolute vault root; any in-vault path mentioned in the
 * message loses this prefix.
 * @param absolutePath the artifact's own absolute path, if the caller has
 * one; it becomes {@link rel} rather than merely losing the vault root.
 * @param rel the artifact's vault-relative path - what {@link absolutePath}
 * is replaced by, and what the caller reports in its own `path` field.
 */
export function hostPathFreeReason(
  err: unknown,
  vault: string,
  absolutePath: string | null,
  rel: string,
): string {
  const raw =
    err instanceof BrainParseError ? err.detail : err instanceof Error ? err.message : String(err);
  const named = absolutePath === null ? raw : raw.split(absolutePath).join(rel);
  // Trailing separator included, so `<vault>/Brain/x.md` becomes
  // `Brain/x.md` rather than `/Brain/x.md`.
  return named.split(`${vault}${sep}`).join("").split(vault).join("");
}
