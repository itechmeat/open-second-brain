/**
 * The vault a record-lane tool hands its lane module (task 2.10 WP6): the
 * server's vault, or, on a server with no vault, the no-vault root of the
 * lane page store (`core/store/lane-pages.ts`). With no vault the machine
 * is store-only, so a lane module never touches a file below that root:
 * its pages are store records, and the tool works without a vault.
 */

import { laneVaultRoot } from "../../core/store/lane-pages.ts";
import { toolPath } from "./device-path.ts";
import { vaultRelativeSafe } from "./shared.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import {
  contextVault,
  type ServerContext,
  VAULT_REQUIRED_CODE,
  vaultRequiredToolMessage,
} from "../tool-contract.ts";

export function laneVault(ctx: ServerContext): string {
  return laneVaultRoot(contextVault(ctx));
}

/**
 * A path a lane module answered, as a tool result names it. With no vault
 * the path sits under the no-vault root, where no file exists (the page is
 * a store record): it is named vault-relative, `Brain/<lane>/<page>`, the
 * name the same page has on a machine with a vault. Otherwise the
 * device-path rule (`toolPath`) names it.
 */
export function lanePath(ctx: ServerContext, path: string): string {
  if (contextVault(ctx) !== null) return toolPath(ctx, path);
  return vaultRelativeSafe(laneVault(ctx), path);
}

/**
 * The vault an action that reads the user's own notes needs (tension
 * detect, pledge and entity intake): the server's vault, or, with none, the
 * `vault_required` refusal naming the action rather than the whole tool.
 */
export function vaultForNoteAction(ctx: ServerContext, action: string): string {
  const vault = contextVault(ctx);
  if (vault !== null) return vault;
  throw new MCPError(INVALID_PARAMS, vaultRequiredToolMessage(action), {
    code: VAULT_REQUIRED_CODE,
  });
}
