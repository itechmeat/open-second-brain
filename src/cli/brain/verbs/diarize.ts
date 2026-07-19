/**
 * `o2b brain diarize <entity>` (t_28ba3fc4): assemble a subject profile
 * for one registry entity - the document set, a deterministic
 * stated-vs-evidenced section, a profile note skeleton, and one
 * needs-llm-step envelope for the deferred prose. Read-only; no model is
 * ever called.
 */

import { diarize, DiarizationError } from "../../../core/brain/diarization.ts";
import {
  brainVerbContext,
  fail,
  ok,
  okJson,
  normalizeFlagString,
  parse,
  usageError,
} from "../helpers.ts";

export async function cmdBrainDiarize(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    category: { type: "string" },
    json: { type: "boolean" },
  });
  const query = positional[0];
  if (!query || query.trim() === "") {
    return usageError("usage: o2b brain diarize <entity> [--category C] [--vault <path>] [--json]");
  }
  const { vault } = brainVerbContext(flags);
  const category = normalizeFlagString(flags["category"]);
  try {
    const report = diarize(
      vault,
      { query, ...(category !== null ? { category } : {}) },
      { now: new Date() },
    );
    if (flags["json"] === true) {
      okJson({
        ok: true,
        entity_id: report.entityId,
        entity_name: report.entityName,
        category: report.category,
        generated_at: report.generatedAt,
        document_set: report.documentSet,
        stated_vs_evidenced: report.statedVsEvidenced.map((l) => ({
          kind: l.kind,
          statement: l.statement,
          evidence: l.evidence,
          evidence_frequency: l.evidenceFrequency,
          last_evidenced_at: l.lastEvidencedAt,
        })),
        excluded_line_count: report.excludedLineCount,
        skeleton: report.skeleton,
        llm_step: report.llmStep,
      });
      return 0;
    }
    ok(`profile: ${report.entityName} (${report.entityId})`);
    ok(`document set: ${report.documentSet.length}`);
    for (const l of report.statedVsEvidenced) {
      ok(
        `[${l.kind}] ${l.statement} (frequency: ${l.evidenceFrequency}, ` +
          `last_evidenced: ${l.lastEvidencedAt ?? "none"})`,
      );
    }
    if (report.excludedLineCount > 0) ok(`excluded lines: ${report.excludedLineCount}`);
    ok(`needs-llm-step: ${report.llmStep.step} -> ${report.llmStep.target_path}`);
    return 0;
  } catch (err) {
    const message =
      err instanceof DiarizationError ? err.message : ((err as Error).message ?? String(err));
    if (flags["json"] === true) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
