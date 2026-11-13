/**
 * The request plumbing every `osb://` resource reader shares (task
 * 3.19): the visibility view and the delivery binding built once per
 * read, the URI parser and the not-found error, the markdown reader and
 * the markdown MIME type. Split from `resources.ts`.
 */

import { readFileSync } from "node:fs";
import { BrainNotFoundError } from "../core/brain/query.ts";
import { gatedOwnerScopeView } from "../core/brain/owner-scope-view.ts";
import { everyArtifactRefView, type ArtifactRefView } from "../core/brain/artifact-ref-view.ts";
import { reachView } from "../core/brain/reach-view.ts";
import { resolvedTransportReach, type TransportReach } from "../core/graph/transport-reach.ts";
import { deliveryView } from "./brain/reach-events.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "./protocol.ts";

export interface ResourceContext {
  readonly vault: string;
  /**
   * The identity this server resolved for the caller, threaded from
   * `MCPServer.agentName` exactly as `ServerContext.agentName` is
   * threaded into every tool.
   *
   * `resources/read` carries no arguments beyond the URI, so - like
   * `brain_context` - this surface cannot be TOLD which owner is asking
   * and the server identity is the only scope available. Absent means
   * exactly what it means for a tool: `resolveOwnerScopeDelivery` reads
   * no requested scope, `enforcedScope` is `null`, and nothing is
   * filtered - the same behaviour, from the same resolver, so the two
   * surfaces cannot disagree about what an unidentified caller sees.
   */
  readonly agentName?: string | undefined;
  /**
   * How far the caller of this read reached, minted by the transport
   * (`src/core/graph/transport-reach.ts`) and threaded from
   * `MCPServer.reach` exactly as {@link ResourceContext.agentName} is
   * threaded from `MCPServer.agentName`.
   *
   * Optional on the TYPE and mandatory in EFFECT, on the same terms
   * `ServerContext.reach` is: absent means no transport established
   * anything, which resolves to the narrowest rather than the widest.
   */
  readonly reach?: TransportReach;
}

export interface ResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

export interface ResourceTemplateDescriptor {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

export interface ResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export const MIME_MARKDOWN = "text/markdown";

export function requestView(ctx: ResourceContext): RequestView {
  const owner = gatedOwnerScopeView(ctx.vault, ctx.agentName);
  const reach = reachView(ctx.vault, resolvedTransportReach(ctx.reach));
  return Object.freeze({
    ownerScope: owner.scope,
    reach: reach.reach,
    refs: everyArtifactRefView(owner, reach),
  });
}

/**
 * The two rules this request is answered under.
 *
 * `refs` is the ANDed decision every reference-shaped filter asks.
 * `ownerScope` is separate because two readers push ownership into their
 * SELECTION rather than filtering afterwards - `queryByTopic` and
 * `buildBacklinkIndex` both take a scope - and that argument is the owner
 * rule's alone. The reserved-token rule has no selection-side form; it is
 * asked over the rows those selections return.
 */
export interface RequestView {
  readonly ownerScope: string | null;
  readonly reach: TransportReach;
  readonly refs: ArtifactRefView;
}

/**
 * The error a resource raises for something the caller may not see.
 *
 * Byte-identical to the one a genuinely ABSENT artifact produces
 * (`BrainNotFoundError`, rendered as `INTERNAL_ERROR` above), because a
 * distinguishable refusal is an existence oracle over exactly the
 * population the gate exists to hide - the same convention
 * `preferences-collect.ts` states for counts and `brain_search_expand`
 * already follows for a chunk id.
 */
export function notFound(id: string): MCPError {
  return new MCPError(INTERNAL_ERROR, new BrainNotFoundError(id).message);
}

/**
 * The delivery binding for one resource read (delivery-trust, lane A):
 * the same binding every report-shaped tool shares, bound to the request
 * the resource view already resolved. At local reach `shape` is the
 * identity and no probe runs - the operator's own readers keep the
 * pre-wave bytes; at remote reach the markdown of the readers that
 * deliver stored-record text is fenced through the K1 shaper, the
 * fence's origin naming the governing page's derived provenance. One
 * binding per read: `readResource` dispatches to exactly one reader, so
 * one frontmatter cache serves the whole request.
 */
export function deliveryFor(
  ctx: ResourceContext,
  view: RequestView,
): ReturnType<typeof deliveryView> {
  return deliveryView({ vault: ctx.vault, configPath: null, repoRoot: null, reach: view.reach });
}

// ----- URI parsing ---------------------------------------------------------

export type Parsed =
  | { readonly kind: "active" }
  | { readonly kind: "lessons" }
  | { readonly kind: "digestLatest" }
  | { readonly kind: "status" }
  | { readonly kind: "preference"; readonly id: string }
  | { readonly kind: "topic"; readonly slug: string }
  | { readonly kind: "log"; readonly date: string }
  | { readonly kind: "backlinks"; readonly id: string };

export function parseUri(uri: string): Parsed {
  if (typeof uri !== "string" || !uri.startsWith("osb://")) {
    throw new MCPError(INVALID_PARAMS, `unsupported resource uri: ${uri}`);
  }
  const remainder = uri.slice("osb://".length);
  // Resources have at most one slash for the templated variants
  // (`preference/foo`). We don't accept deeper paths.
  const parts = remainder.split("/");
  const head = parts[0] ?? "";
  if (head === "preferences" && parts[1] === "active" && parts.length === 2) {
    return { kind: "active" };
  }
  if (head === "lessons" && parts.length === 1) {
    return { kind: "lessons" };
  }
  if (head === "digest" && parts[1] === "latest" && parts.length === 2) {
    return { kind: "digestLatest" };
  }
  if (head === "status" && parts.length === 1) {
    return { kind: "status" };
  }
  if (head === "preference" && parts.length === 2) {
    return { kind: "preference", id: parts[1]! };
  }
  if (head === "topic" && parts.length === 2) {
    return { kind: "topic", slug: parts[1]! };
  }
  if (head === "log" && parts.length === 2) {
    return { kind: "log", date: parts[1]! };
  }
  if (head === "backlinks" && parts.length === 2) {
    return { kind: "backlinks", id: parts[1]! };
  }
  throw new MCPError(INVALID_PARAMS, `unsupported resource uri: ${uri}`);
}

// ----- Readers -------------------------------------------------------------

export function readMarkdown(uri: string, path: string): ResourceContent {
  const text = readFileSync(path, "utf8");
  return { uri, mimeType: MIME_MARKDOWN, text };
}
