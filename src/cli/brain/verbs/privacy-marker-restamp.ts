import { planPrivacyMarkerRestamp } from "../../../core/brain/privacy-marker-restamp.ts";
import { emitNextStep } from "../../advisory-rail.ts";
import { brainVerbContext, info, ok, okJson, parse } from "../helpers.ts";

/**
 * `o2b brain privacy-marker-restamp` (write-honesty, F1).
 *
 * Make an informal privacy marker (`access: private`, `confidentiality:
 * secret`, `sensitivity: confidential`) formal by unioning the reserved
 * token into `visibility:`. Dry-run by DEFAULT (report only); `--apply`
 * writes. Additive only, idempotent, and never re-embeds - it edits
 * frontmatter and nothing else.
 */
export async function cmdBrainPrivacyMarkerRestamp(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const apply = flags["apply"] === true;
  const jsonRequested = flags["json"] === true;

  const result = planPrivacyMarkerRestamp(vault, { apply });

  if (flags["json"]) {
    okJson({
      dry_run: !apply,
      scanned: result.scanned,
      updated: result.updated,
      // The refusals travel with the result: a candidate the apply pass
      // refused (a frontmatter the writer cannot round-trip, a page that
      // could not be re-read) is reported by name with its reason, never
      // folded into a lower `updated` count.
      skipped: result.skipped.map((s) => ({ path: s.path, reason: s.reason })),
      candidates: result.candidates.map((c) => ({
        path: c.path,
        visibility: [...c.visibility],
        visibility_line: c.visibilityLine,
      })),
    });
    return 0;
  }

  if (apply) {
    ok(
      `privacy-marker-restamp: updated ${result.updated} of ${result.candidates.length} candidate(s)`,
    );
    for (const s of result.skipped) process.stderr.write(`  refused ${s.path}: ${s.reason}\n`);
  } else {
    ok(
      `privacy-marker-restamp dry-run: ${result.candidates.length} candidate(s) ` +
        `(scanned ${result.scanned})`,
    );
    info("re-run with --apply to union the reserved token into visibility:");
  }
  // The consequence of the stamp, for the pages this run would touch: the
  // formal token dominates the scope rule, so a page found by default-scope
  // local search before the stamp is found by neither scope after it. The
  // sentence states what happens; the how-to travels through the advisory
  // rail (`restamp-local-visibility`), the one mechanism that names a
  // forward command.
  if (result.candidates.length > 0) {
    info(
      apply
        ? "note: each stamped page is now also excluded from default-scope local search"
        : "note: after --apply each stamped page is also excluded from default-scope local search",
    );
    emitNextStep("restamp-local-visibility", { command: "brain", argv, jsonRequested });
  }
  for (const c of result.candidates) info(`  ${c.path}: ${c.visibilityLine}`);
  return 0;
}
