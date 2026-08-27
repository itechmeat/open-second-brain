/**
 * The reach every command in this CLI runs at.
 *
 * `local`, for the same reason the stdio transport mints it
 * (`src/mcp/stdio.ts`): the operator is running this binary in their own
 * shell, against a vault they can already open in an editor. A CLI that
 * withheld the operator's own reserved pages from the operator would be
 * hiding data from the only person entitled to it, while proving nothing
 * to anyone.
 *
 * Named once here rather than spelled at each verb, so the claim each
 * verb makes about its caller is the same claim.
 */

import { TRANSPORT_REACH, type TransportReach } from "../core/graph/transport-reach.ts";

export const CLI_TRANSPORT_REACH: TransportReach = TRANSPORT_REACH.local;
