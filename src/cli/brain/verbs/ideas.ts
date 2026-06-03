/**
 * `o2b brain ideas` (Workspace Insight Suite, t_8722a62a): ranked
 * next-direction candidates from open loops. `--triggers` enqueues
 * them into the trigger queue.
 */

import { defaultConfigPath, resolveTriggerCooldownDays } from "../../../core/config.ts";
import { discoverIdeas, ideaCandidates } from "../../../core/brain/idea-discovery.ts";
import { createTriggers } from "../../../core/brain/triggers/store.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainIdeas(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    cap: { type: "string" },
    triggers: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const json = flags["json"] === true;

  const capRaw = flags["cap"];
  const cap = typeof capRaw === "string" && capRaw.trim() !== "" ? Number(capRaw) : 5;
  if (!Number.isInteger(cap) || cap < 1 || cap > 50) {
    return fail("--cap must be an integer in 1..50");
  }

  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
    const now = new Date();
    const ideas = discoverIdeas(vault, { now, cap });

    let enqueued = 0;
    if (flags["triggers"] === true) {
      const result = createTriggers(vault, ideaCandidates(ideas), {
        now,
        cooldownDays: resolveTriggerCooldownDays(config),
      });
      enqueued = result.created.length;
    }

    if (json) {
      okJson({
        ok: true,
        ideas: ideas.map((idea) => ({
          kind: idea.kind,
          title: idea.title,
          reason: idea.reason,
          score: idea.score,
          source_artifacts: idea.sourceArtifacts,
        })),
        ...(flags["triggers"] === true ? { triggers_created: enqueued } : {}),
      });
      return 0;
    }
    if (ideas.length === 0) {
      ok("no next-direction candidates");
      return 0;
    }
    ideas.forEach((idea, index) => {
      ok(`[${index + 1}] (${idea.kind}) ${idea.title}: ${idea.reason}`);
    });
    if (flags["triggers"] === true) ok(`triggers created: ${enqueued}`);
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
