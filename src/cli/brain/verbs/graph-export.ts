import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import { exportVaultGraph } from "../../../core/brain/portability/graph.ts";
import {
  isPromptDerivedPage,
  omittedPageReferenceMatcher,
} from "../../../core/brain/provenance/content-class.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_CONTENT_CLASS_INCLUDE_NOTICE,
  EGRESS_REDACTION_NOTICE,
  contentClassOmissionNotice,
  egressContentClassSplit,
  redactForEgress,
} from "../../../core/egress/guard.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * The stderr line counting the kept nodes' structured link and relation
 * targets that named a left-out page and were dropped. A graph the
 * policy shortened without a word is the same silently smaller export
 * the page omission notice exists to prevent.
 */
function referenceOmissionNotice(dropped: number): string {
  return `note: ${dropped} link/relation target(s) to left-out page(s) dropped from kept nodes\n`;
}

/**
 * `o2b brain graph-export [--out <file>] [--include-prompt-derived]` -
 * serialise the user's vault pages (links + typed relations) to a stable
 * graph.json. Prints to stdout, or writes to `--out <file>`. Read-only on
 * the vault.
 *
 * The graph carries no page body, but it does carry every title, path
 * and relation target, so it goes through the shared egress guard
 * (registry entry `brain-graph-export`) like every other export.
 *
 * A page whose `content_class` frontmatter carries the reserved
 * `prompt-derived` value is left out of the graph: its node - title,
 * path, links and typed relations - is absent from the JSON, and the
 * omission is named on stderr. `--include-prompt-derived` is the operator
 * override; it carries the nodes back in and says so.
 *
 * A kept node's links and relation targets are that page's own content,
 * but they are structured references, and one naming a left-out page is
 * the omitted page's name leaving through a node the policy kept - so
 * such targets are dropped from the kept node (counted on stderr), while
 * every other byte of the node, its title and its remaining targets
 * stays exactly as the vault declares them.
 */
export async function cmdBrainGraphExport(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    out: { type: "string" },
    "include-prompt-derived": { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const classPolicy = { contentClass: { include: flags["include-prompt-derived"] === true } };

  let json: string;
  let redacted: boolean;
  let omitted: ReadonlyArray<string> = [];
  let droppedReferences = 0;
  try {
    const graph = exportVaultGraph(vault);
    const split = egressContentClassSplit(graph.nodes, classPolicy, {
      name: (node) => node.path,
      isPromptDerived: (node) => isPromptDerivedPage(vault, node.path),
    });
    omitted = split.omitted;
    // A kept node's structured targets naming a left-out page drop;
    // a relation left with no targets drops with them, matching the
    // exporter's own shape of carrying only non-empty relation fields.
    const namesOmitted = omittedPageReferenceMatcher(omitted);
    const keptNodes = split.kept.map((node) => {
      const links = node.links.filter((target) => !namesOmitted(target));
      const relations: Record<string, ReadonlyArray<string>> = {};
      let dropped = node.links.length - links.length;
      for (const [relation, targets] of Object.entries(node.relations)) {
        const kept = targets.filter((target) => !namesOmitted(target));
        dropped += targets.length - kept.length;
        if (kept.length > 0) relations[relation] = kept;
      }
      droppedReferences += dropped;
      return { ...node, links, relations };
    });
    const verdict = redactForEgress("brain-graph-export", { ...graph, nodes: keptNodes });
    if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);
    json = JSON.stringify(verdict.payload, null, 2) + "\n";
    redacted = verdict.redacted;
  } catch (exc) {
    return fail(`graph-export failed: ${(exc as Error).message ?? exc}`);
  }

  try {
    if (typeof flags["out"] === "string") {
      atomicWriteFileSync(flags["out"], json);
      process.stdout.write(`wrote ${flags["out"]}\n`);
    } else {
      process.stdout.write(json);
    }
  } catch (exc) {
    return fail(`graph-export failed to write output: ${(exc as Error).message ?? exc}`);
  }
  if (flags["include-prompt-derived"] === true) {
    process.stderr.write(EGRESS_CONTENT_CLASS_INCLUDE_NOTICE);
  } else {
    if (omitted.length > 0) process.stderr.write(contentClassOmissionNotice(omitted));
    if (droppedReferences > 0) process.stderr.write(referenceOmissionNotice(droppedReferences));
  }
  if (redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
  return 0;
}
