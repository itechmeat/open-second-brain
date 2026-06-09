import { runDoctor } from "../../../core/brain/doctor.ts";
import { brainVerbContext, fail, ok, parse } from "../helpers.ts";

/**
 * `o2b brain health` - print the semantic-health report (contradictory
 * preferences, recurring uncovered concepts, stale claims) plus the
 * clean/watch/investigate verdict. Read-only.
 */
export async function cmdBrainHealth(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  let result;
  try {
    result = runDoctor(vault);
  } catch (exc) {
    return fail(`health failed: ${(exc as Error).message ?? exc}`);
  }

  // Structural errors mean the tree is not trustworthy enough to report
  // a semantic verdict on - surface them and fail rather than print a
  // misleading "clean".
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      process.stdout.write(`[ERROR] ${e.code}: ${e.message}${e.path ? ` (${e.path})` : ""}\n`);
    }
    return 1;
  }

  const sh = result.semantic_health ?? {
    verdict: "clean" as const,
    contradictions: [],
    conceptGaps: [],
    staleClaims: [],
  };

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(sh, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`verdict: ${sh.verdict}\n`);
  for (const c of sh.contradictions) {
    process.stdout.write(
      `[contradiction] ${c.aId} (${c.aSign}) vs ${c.bId} (${c.bSign})` +
        `${c.scope ? ` scope=${c.scope}` : ""} jaccard=${c.jaccard.toFixed(2)}\n`,
    );
  }
  for (const g of sh.conceptGaps) {
    process.stdout.write(`[concept-gap] ${g.term} (x${g.frequency})\n`);
  }
  for (const s of sh.staleClaims) {
    process.stdout.write(`[stale-claim] ${s.id} (${s.ageDays}d since ${s.lastEvidenceAt})\n`);
  }
  if (
    sh.contradictions.length === 0 &&
    sh.conceptGaps.length === 0 &&
    sh.staleClaims.length === 0
  ) {
    ok("brain health: clean");
  }
  return 0;
}
