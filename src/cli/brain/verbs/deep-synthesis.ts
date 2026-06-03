/**
 * `o2b brain deep-synthesis <topic>` (Workspace Insight Suite,
 * t_04e94382): deterministic topic dossier - matched notes,
 * agreements, contradictions, stale claims, knowledge gaps. With
 * `--triggers` the contradiction/gap findings enqueue into the
 * trigger queue.
 */

import { defaultConfigPath, resolveTriggerCooldownDays } from "../../../core/config.ts";
import { deepSynthesis, synthesisCandidates } from "../../../core/brain/deep-synthesis.ts";
import { createTriggers } from "../../../core/brain/triggers/store.ts";
import { resolveSearchConfig, SearchError } from "../../../core/search/index.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainDeepSynthesis(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    limit: { type: "string" },
    triggers: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const json = flags["json"] === true;

  const topic = positional[0];
  if (!topic || topic.trim() === "") {
    return fail("usage: o2b brain deep-synthesis <topic> [--limit N] [--triggers] [--json]");
  }
  const limitRaw = flags["limit"];
  const limit = typeof limitRaw === "string" && limitRaw.trim() !== "" ? Number(limitRaw) : 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return fail("--limit must be an integer in 1..100");
  }

  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
    const searchConfig = resolveSearchConfig({ vault, configPath: config });
    const now = new Date();
    const report = await deepSynthesis(searchConfig, topic, { now, limit });

    let enqueued = 0;
    if (flags["triggers"] === true) {
      const result = createTriggers(vault, synthesisCandidates(report), {
        now,
        cooldownDays: resolveTriggerCooldownDays(config),
      });
      enqueued = result.created.length;
    }

    if (json) {
      okJson({
        ok: true,
        topic: report.topic,
        generated_at: report.generatedAt,
        checked: report.checked,
        notes: report.notes,
        agreements: report.agreements,
        contradictions: report.contradictions,
        stale_claims: report.staleClaims.map((s) => ({
          path: s.path,
          age_days: s.ageDays,
          superseded_by: s.supersededBy,
        })),
        gaps: report.gaps,
        ...(flags["triggers"] === true ? { triggers_created: enqueued } : {}),
      });
      return 0;
    }
    ok(`topic: ${report.topic} (checked: ${report.checked.join(", ")})`);
    ok(`notes: ${report.notes.length}`);
    for (const a of report.agreements) ok(`[agreement] ${a.path} ${a.relation} ${a.target}`);
    for (const c of report.contradictions) ok(`[contradiction] ${c.path} contradicts ${c.target}`);
    for (const s of report.staleClaims) {
      ok(
        `[stale] ${s.path} (${s.ageDays}d${s.supersededBy !== null ? `, superseded by ${s.supersededBy}` : ""})`,
      );
    }
    for (const g of report.gaps) ok(`[gap] ${g.target} <- ${g.sources.join(", ")}`);
    if (flags["triggers"] === true) ok(`triggers created: ${enqueued}`);
    return 0;
  } catch (err) {
    if (err instanceof SearchError) return fail(`${err.message} [${err.code}]`);
    return fail((err as Error).message ?? String(err));
  }
}
