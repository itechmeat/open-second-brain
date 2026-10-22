import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import { exportBankBundle } from "../../../core/brain/portability/bundle.ts";
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
 * The stderr line counting the kept pages' structured references (graph
 * links and relation targets, page-contract citations) that named a
 * left-out page and were dropped. A bundle the policy shortened without
 * a word is the same silently smaller export the page omission notice
 * exists to prevent.
 */
function referenceOmissionNotice(dropped: number): string {
  return (
    `note: ${dropped} link/relation/citation target(s) to left-out page(s) dropped from ` +
    "kept pages' structured references\n"
  );
}

/**
 * `o2b brain bank-export [--out <file>] [--include-prompt-derived]` -
 * serialise a whole-vault bank bundle (preferences + page graph + page
 * contracts + sources dashboard) to a schema-versioned JSON. Prints to
 * stdout, or writes to `--out <file>`. Read-only on the vault.
 *
 * Every byte goes through the shared egress guard first (registry entry
 * `brain-bank-export`). The guard runs over the bundle TREE and the JSON
 * is serialised afterwards, so redaction can never disturb the
 * document's own quoting.
 *
 * A page whose `content_class` frontmatter carries the reserved
 * `prompt-derived` value is left out of BOTH page sections - its graph
 * node and its page contract - and every omission is named once on
 * stderr. `--include-prompt-derived` is the operator override; it
 * carries the pages back in and says so. The sources dashboard is an
 * aggregate over signal records, not pages, and carries no page text, so
 * the class policy does not reach it.
 *
 * A kept page can still name a left-out one in its structured
 * references - graph links and relation targets, contract citations -
 * and such a reference is the omitted page's name leaving through a page
 * the policy kept, so those targets drop from the bundle (counted on
 * stderr). Everything else about the kept records, their remaining
 * targets included, stays exactly as the exporters derived it.
 */
export async function cmdBrainBankExport(argv: string[]): Promise<number> {
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
    const bundle = exportBankBundle(vault);
    const nodeSplit = egressContentClassSplit(bundle.graph.nodes, classPolicy, {
      name: (node) => node.path,
      isPromptDerived: (node) => isPromptDerivedPage(vault, node.path),
    });
    const pageSplit = egressContentClassSplit(bundle.pages, classPolicy, {
      name: (page) => page.path,
      isPromptDerived: (page) => isPromptDerivedPage(vault, page.path),
    });
    // One page can appear in both sections; an omission is named once.
    omitted = [...new Set([...nodeSplit.omitted, ...pageSplit.omitted])];
    // The structured references of the kept records: a graph link, a
    // relation target or a contract citation naming a left-out page drops,
    // counted; a relation left with no targets drops with it, matching the
    // graph exporter's own shape of carrying only non-empty fields.
    const namesOmitted = omittedPageReferenceMatcher(omitted);
    const keptNodes = nodeSplit.kept.map((node) => {
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
    const keptPages = pageSplit.kept.map((page) => {
      const citations = page.citations.filter((target) => !namesOmitted(target));
      droppedReferences += page.citations.length - citations.length;
      return { ...page, citations };
    });
    const verdict = redactForEgress("brain-bank-export", {
      ...bundle,
      graph: { ...bundle.graph, nodes: keptNodes },
      pages: keptPages,
    });
    if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);
    json = JSON.stringify(verdict.payload, null, 2) + "\n";
    redacted = verdict.redacted;
  } catch (exc) {
    return fail(`bank-export failed: ${(exc as Error).message ?? exc}`);
  }

  try {
    if (typeof flags["out"] === "string") {
      atomicWriteFileSync(flags["out"], json);
      process.stdout.write(`wrote ${flags["out"]}\n`);
    } else {
      process.stdout.write(json);
    }
  } catch (exc) {
    return fail(`bank-export failed to write output: ${(exc as Error).message ?? exc}`);
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
