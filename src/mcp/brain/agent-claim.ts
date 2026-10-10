/**
 * The caller-supplied `agent` argument a token identity may not override
 * (write-side-trust, Task 7).
 *
 * A credential-minted identity is the one fact a request cannot argue
 * with: the token map names its agent, and every write-side gate answers
 * for that agent. Letting the same request stamp a DIFFERENT name into
 * signals, log rows and evidence would make the credential decorative -
 * a ledger that names the wrong actor. When the request arrived on a
 * token, a mismatching claim is therefore refused outright, in the same
 * shape the owner-write refusal speaks: named, quoting both sides, and
 * telling the caller the one move that fixes it. A shared-key or
 * config-identity request keeps the historical passthrough - the
 * operator master credential has always been allowed to say who it acts
 * for.
 */

import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { RequestIdentity } from "../tool-contract.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { normalizeAgentScope } from "../../core/graph/agent-scope.ts";

export function refuseAgentClaim(
  identity: RequestIdentity | undefined,
  claimed: string | null | undefined,
  tool: string,
): void {
  if (identity === undefined || identity.via !== "token") return;
  if (claimed === null || claimed === undefined || claimed.trim() === "") return;
  // The same normalised token comparison the owner-write gate makes, so
  // a second spelling of "the same agent" is not a second claim rule.
  const claimedToken = normalizeAgentScope(normalizeAgentArgument(claimed) ?? undefined);
  const identityToken = normalizeAgentScope(identity.agent);
  if (claimedToken === null || claimedToken === identityToken) return;
  throw new MCPError(
    INVALID_PARAMS,
    `${tool}: write refused (agent-claim-refused): the caller named agent ` +
      `${JSON.stringify(claimed)}, but the presented token resolves to ` +
      `${JSON.stringify(identity.agent)}; a token caller writes only under its own ` +
      `agent. Drop the 'agent' argument, or present the token minted for ` +
      `${JSON.stringify(claimed)}.`,
  );
}
