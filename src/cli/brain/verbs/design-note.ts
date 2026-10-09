/**
 * `o2b brain design-note <topic>` (t_c87644b4): the one-shot sibling of
 * `o2b brain panel`.
 *
 * Without a payload the verb is read-only: it grounds the topic in the
 * vault's tensions, decisions and truth projections and prints the single
 * needs-llm-step envelope the calling agent answers. With `--payload` /
 * `--payload-file` it validates that answer - shape, then the
 * exactly-one-recommended rule - and commits the note under
 * `Brain/decisions/`. No model is ever called.
 *
 * Exit codes: 0 on success, 1 on an operational failure or a refused
 * payload, 2 on usage errors.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { canonicalNotePath } from "../../../core/path-safety.ts";

import {
  commitDesignNote,
  DesignNoteError,
  planDesignNote,
} from "../../../core/brain/design-note.ts";
import { gatedOwnerScopeView } from "../../../core/brain/owner-scope-view.ts";
import {
  parsePayloadJson,
  PayloadJsonError,
  payloadStripNote,
  type PayloadStrip,
} from "../../../core/brain/payload-json.ts";
import { ResponseCheckError } from "../../../core/brain/response-checks.ts";
import { ResponseShapeError } from "../../../core/brain/response-shape.ts";
import {
  brainVerbContext,
  fail,
  ok,
  okJson,
  parse,
  resolveBrainAgent,
  usageError,
} from "../helpers.ts";

const USAGE =
  "usage: o2b brain design-note <topic> [--payload <json> | --payload-file <path>] " +
  "[--agent <name>] [--vault <path>] [--json]";

/** Refusals the caller caused, reported without a stack. */
const NAMED_REFUSALS = [DesignNoteError, ResponseShapeError, ResponseCheckError] as const;

function isNamedRefusal(err: unknown): err is Error {
  return NAMED_REFUSALS.some((type) => err instanceof type);
}

export async function cmdBrainDesignNote(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    payload: { type: "string" },
    "payload-file": { type: "string" },
    json: { type: "boolean" },
  });
  const topic = positional.join(" ").trim();
  if (topic === "") return usageError(USAGE);
  const asJson = flags["json"] === true;

  try {
    const { config, vault } = brainVerbContext(flags);
    const rawPayload =
      typeof flags["payload"] === "string"
        ? (flags["payload"] as string)
        : typeof flags["payload-file"] === "string"
          ? readFileSync(flags["payload-file"] as string, "utf8")
          : null;

    if (rawPayload === null) {
      const report = planDesignNote(vault, topic, {
        now: new Date(),
        ownerScope: gatedOwnerScopeView(vault, resolveBrainAgent(flags, config)).scope,
      });
      const g = report.grounding;
      if (asJson) {
        okJson({
          ok: true,
          topic: report.topic,
          slug: report.slug,
          generated_at: report.generatedAt,
          target_path: report.targetPath,
          grounding: {
            tensions: g.tensions,
            decisions: g.decisions,
            truth_slots: g.truthSlots,
            conflicts: g.conflicts,
            counts: g.counts,
            empty_stores: g.emptyStores,
          },
          llm_step: report.llmStep,
        });
        return 0;
      }
      ok(`design note: ${report.topic}`);
      ok(
        `grounding: ${g.counts.tensions} tension(s), ${g.counts.decisions} decision(s), ` +
          `${g.counts.truthSlots} claim(s), ${g.counts.conflicts} conflict(s)`,
      );
      // Named rather than implied: an empty store and a store that matched
      // nothing are different facts about this vault.
      if (g.emptyStores.length > 0) ok(`empty stores: ${g.emptyStores.join(", ")}`);
      ok(`needs-llm-step: ${report.llmStep.step} -> ${report.llmStep.target_path}`);
      return 0;
    }

    let payload: unknown;
    let strip: PayloadStrip | undefined;
    try {
      const parsed = parsePayloadJson(rawPayload);
      payload = parsed.payload;
      strip = parsed.strip;
    } catch (error) {
      // Reported here rather than by the ingress: at this point the mistake
      // is the JSON the operator typed, and a path inside a payload the CLI
      // never parsed would not tell them what to fix. A refusal after a
      // strip attempt names the attempt (t_dac8bf7e).
      if (error instanceof PayloadJsonError) {
        if (!asJson) return fail(error.message);
        okJson({ ok: false, message: error.message });
        return 1;
      }
      throw error;
    }
    const res = commitDesignNote(vault, topic, payload, {
      agent: resolveBrainAgent(flags, config),
      now: new Date(),
    });
    if (asJson) {
      okJson({
        ok: true,
        topic: res.topic,
        slug: res.slug,
        // Vault-relative, like the distill surface and the MCP twin: the
        // absolute host path is the operator-supplied vault prefix composed
        // with a machine-derived subtree, and this output lands in model
        // context.
        path: canonicalNotePath(relative(vault, res.path)),
        recommended: res.recommended,
        alternative_count: res.alternativeCount,
        // Present only when a leading <think> block was stripped (t_dac8bf7e).
        ...(strip !== undefined ? { note: payloadStripNote(strip) } : {}),
      });
      return 0;
    }
    ok(`wrote ${canonicalNotePath(relative(vault, res.path))}`);
    ok(`recommended: ${res.recommended} (of ${res.alternativeCount} alternative(s))`);
    if (strip !== undefined) ok(payloadStripNote(strip));
    return 0;
  } catch (err) {
    const message = isNamedRefusal(err)
      ? err.message
      : `design-note failed: ${(err as Error).message ?? String(err)}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
