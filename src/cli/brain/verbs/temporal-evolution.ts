import { buildTimelineIndex } from "../../../core/brain/temporal/build-index.ts";
import {
  buildBeliefEvolution,
  type BeliefEvolutionTarget,
} from "../../../core/brain/temporal/belief-evolution.ts";
import { CliError, brainVerbContext, parse } from "../helpers.ts";

/**
 * `o2b brain evolution [--vault PATH] (--pref-id ID | --topic SLUG)
 *                      [--json]`
 *
 * Per-preference or per-topic chronological story: status transitions
 * derived from dream summaries, evidence rollup with running counts,
 * and retirement chain.
 */
export async function cmdBrainEvolution(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "pref-id": { type: "string" },
    topic: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  const prefId = trimOrUndefined(flags["pref-id"]);
  const topic = trimOrUndefined(flags["topic"]);
  const target = buildEvolutionTarget(prefId, topic);

  const index = buildTimelineIndex(vault, {});
  const evo = buildBeliefEvolution(index, vault, target);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(evo, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`Belief evolution for ${JSON.stringify(evo.target)}\n`);
  process.stdout.write(`  transitions: ${evo.transitions.length}\n`);
  for (const t of evo.transitions) {
    process.stdout.write(`    ${t.at}  ${t.kind}  ${t.prefId}\n`);
  }
  process.stdout.write(`  evidence: ${evo.evidence.length}\n`);
  for (const e of evo.evidence) {
    process.stdout.write(
      `    ${e.at}  ${e.result}  (applied=${e.runningApplied}, violated=${e.runningViolated})\n`,
    );
  }
  process.stdout.write(`  retirements: ${evo.retirements.length}\n`);
  for (const r of evo.retirements) {
    process.stdout.write(
      `    ${r.retiredAt}  ${r.prefId}  ${r.reason ?? ""}${r.supersededBy ? ` superseded-by ${r.supersededBy}` : ""}\n`,
    );
  }
  return 0;
}

function trimOrUndefined(v: string | boolean | string[] | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Pick exactly one of `--pref-id` / `--topic` and build the typed
 * target shape `buildBeliefEvolution` expects. Throws when both or
 * neither are supplied so we never need a non-null assertion at the
 * call site.
 */
function buildEvolutionTarget(
  prefId: string | undefined,
  topic: string | undefined,
): BeliefEvolutionTarget {
  if (prefId !== undefined && topic !== undefined) {
    throw new CliError("brain evolution: pass exactly one of --pref-id or --topic");
  }
  if (prefId !== undefined) return { prefId };
  if (topic !== undefined) return { topic };
  throw new CliError("brain evolution: pass exactly one of --pref-id or --topic");
}
