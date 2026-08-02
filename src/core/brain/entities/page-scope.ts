/**
 * The status scope applied to a vault PAGE rather than to a parsed record.
 *
 * `Brain/entities/**` are ordinary Markdown pages, so every reader that
 * walks the vault - not only the ones that go through the registry - sees
 * them. A quarantined entity page carries a title, a body and wikilinks
 * that were authored by whatever untrusted source the intake quarantined,
 * and a link-graph walker that reads pages by path never touches
 * `buildEntityIndex`, so `status-scope.ts` alone cannot reach it.
 *
 * This is that reach: the same {@link entityStatusInScope} decision, taken
 * over the frontmatter `listVaultPages` already parsed, so a walker pays no
 * extra read.
 *
 * A page that does not declare the entity kind is not an entity record and
 * is admitted unchanged - this predicate narrows nothing outside
 * `Brain/entities/`. A page that DOES declare the kind but carries a status
 * outside the vocabulary is admitted by no scope, exactly as
 * {@link entityStatusInScope} answers for a value that never parsed: an
 * unrecognised status is not a reason to show the record.
 */

import {
  ENTITY_STATUS_SCOPE,
  entityStatusInScope,
  type EntityStatusScope,
} from "./status-scope.ts";
import { BRAIN_ENTITY_KIND } from "./types.ts";

export { ENTITY_STATUS_SCOPE };

/**
 * May a read at `scope` see the page whose frontmatter is `metadata`?
 *
 * Pages that are not entity records answer `true`. See the module docblock
 * for why an unparseable status on an entity page answers `false`.
 */
export function vaultPageInStatusScope(
  metadata: Readonly<Record<string, unknown>>,
  scope: EntityStatusScope,
): boolean {
  if (metadata["kind"] !== BRAIN_ENTITY_KIND) return true;
  const status = metadata["status"];
  return typeof status === "string" && entityStatusInScope(status, scope);
}
