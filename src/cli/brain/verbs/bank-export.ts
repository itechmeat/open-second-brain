import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import { exportBankBundle } from "../../../core/brain/portability/bundle.ts";
import { isPromptDerivedPage } from "../../../core/brain/provenance/content-class.ts";
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
    const verdict = redactForEgress("brain-bank-export", {
      ...bundle,
      graph: { ...bundle.graph, nodes: nodeSplit.kept },
      pages: pageSplit.kept,
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
  } else if (omitted.length > 0) {
    process.stderr.write(contentClassOmissionNotice(omitted));
  }
  if (redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
  return 0;
}
