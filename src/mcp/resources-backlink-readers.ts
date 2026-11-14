/**
 * The backlinks reader of the `osb://` surface (task 3.19), with the
 * markdown renderer it answers through. Split from `resources.ts`;
 * dispatch happens through that module's `readResource`.
 */

import { buildBacklinkIndex } from "../core/brain/backlinks.ts";
import type { BacklinkRef } from "../core/brain/backlinks.ts";
import { normaliseWikilinkTarget } from "../core/brain/wikilink.ts";
import { recordRefs } from "../core/brain/log-events-at-reach.ts";
import { deliveryRelForBrainArtifact, UNPROBED_DELIVERY_REL } from "./brain/reach-events.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { RequestView, ResourceContent, ResourceContext } from "./resources-shared.ts";
import { MIME_MARKDOWN, deliveryFor } from "./resources-shared.ts";

export function readBacklinks(
  ctx: ResourceContext,
  uri: string,
  rawId: string,
  view: RequestView,
): ResourceContent {
  if (!rawId.trim()) {
    throw new MCPError(INVALID_PARAMS, `backlinks target must not be empty: ${uri}`);
  }
  // Normalise to the same form the index keys use so `[[pref-foo]]`,
  // `pref-foo`, and `Brain/preferences/pref-foo.md` all resolve.
  const target = normaliseWikilinkTarget(rawId);
  // The last unscoped `buildBacklinkIndex` call in the product. Every
  // ref it yields names its SOURCE artifact by id, so an unscoped index
  // here published the same list `brain_backlinks` had already learned
  // to withhold.
  //
  // A hidden TARGET answers exactly as an ABSENT one does - the empty
  // backlink document - rather than refusing: this reader has no
  // not-found path at all (an unknown target is a legitimate zero), so a
  // refusal here would be the one response shape that proves the page
  // exists. The echoed target is the caller's own argument.
  const index = buildBacklinkIndex(ctx.vault, view.ownerScope, {
    withholdsPrivate: view.refs.withholdsPrivate === true,
  });
  // Every spelling the target answers to across its retirement: a
  // retired reserved record is otherwise asked as `pref-x`, which names
  // no page once `ret-x` is the one on disk.
  const targetVisible = view.refs.row(...recordRefs(target));
  const refs = targetVisible
    ? (index.get(target) ?? []).filter((ref) => view.refs.visible(ref.source))
    : [];
  return {
    uri,
    mimeType: MIME_MARKDOWN,
    // The rendered document is derived from stored pages (delivery-trust,
    // lane A): fenced at remote reach, named for the TARGET page's own
    // derived provenance; local keeps the bytes. A withheld target probes
    // the guaranteed-absent page instead: reading a hidden target's real
    // stamps would name its existence and its channel through the fence's
    // origin label, while an absent one reads as unverified - the two
    // answers must stay identical.
    text: deliveryFor(ctx, view).shape(
      renderBacklinksMarkdown(target, refs),
      targetVisible ? deliveryRelForBrainArtifact(ctx.vault, target) : UNPROBED_DELIVERY_REL,
    ),
  };
}

export function renderBacklinksMarkdown(target: string, refs: ReadonlyArray<BacklinkRef>): string {
  const lines: string[] = [];
  lines.push(`# Backlinks to \`${target}\``);
  lines.push("");
  lines.push(`Total inbound references: ${refs.length}`);
  lines.push("");
  if (refs.length === 0) {
    lines.push("_No inbound references found._");
    return lines.join("\n") + "\n";
  }
  // Group by source-kind so the reader sees structure rather than a
  // flat list — the same source kind (e.g. multiple log apply-evidence
  // events) clusters together.
  const byKind = new Map<string, BacklinkRef[]>();
  for (const r of refs) {
    const arr = byKind.get(r.sourceKind) ?? [];
    arr.push(r);
    byKind.set(r.sourceKind, arr);
  }
  for (const [kind, group] of byKind) {
    lines.push(`## ${kind} (${group.length})`);
    lines.push("");
    for (const r of group) {
      const suffix = r.timestamp ? ` — ${r.timestamp}` : "";
      lines.push(`- \`${r.source}\` (field: \`${r.field}\`)${suffix}`);
    }
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}
