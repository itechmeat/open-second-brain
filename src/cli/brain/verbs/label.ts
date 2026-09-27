/**
 * `o2b brain label <path> <dimension>=<value> | --remove <dimension> | --show
 *  | --suggest [--dimensions a,b]`
 * (t_7a41f42d): controlled-vocabulary classification. Assignments are
 * validated fail-closed against the schema pack's `labels` field -
 * unknown dimensions and values are rejected with the declared
 * vocabulary - and stored as a sorted `labels` frontmatter array plus
 * a canonical `label` entity.
 *
 * `--suggest` is read-only and never assigns: an advisory decision-model
 * suggestion per dimension when the optional `labels` use is configured
 * (issue #213, Part 6), otherwise `available: false`.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import {
  assignNoteLabel,
  LabelVocabularyError,
  readLabels,
  removeNoteLabel,
} from "../../../core/brain/labels.ts";
import {
  LabelSuggestPrivateNoteError,
  suggestNoteLabels,
} from "../../../core/brain/label-suggest.ts";
import { loadSchemaPack } from "../../../core/brain/schema-pack.ts";
import { resolveNotePath } from "../../../core/brain/note-path.ts";
import { resolveAgentName } from "../../../core/config.ts";
import { parseFrontmatter } from "../../../core/vault.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain label <path> <dimension>=<value> | " +
  "o2b brain label <path> --remove <dimension> | " +
  "o2b brain label <path> --show | " +
  "o2b brain label <path> --suggest [--dimensions a,b]  [--agent N] [--vault <path>] [--json]";

export async function cmdBrainLabel(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    remove: { type: "string" },
    show: { type: "boolean" },
    suggest: { type: "boolean" },
    dimensions: { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const relPath = positional[0];
  const assignment = positional[1];
  const remove = flags["remove"] as string | undefined;
  const show = flags["show"] === true;
  const suggest = flags["suggest"] === true;
  const modes = [assignment !== undefined, remove !== undefined, show, suggest].filter(
    Boolean,
  ).length;
  if (!relPath || modes !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const { config, vault } = brainVerbContext(flags);

  try {
    if (show) {
      const [metadata] = parseFrontmatter(resolveNotePath(vault, relPath));
      const labels = readLabels(metadata);
      if (asJson) okJson({ path: relPath, labels });
      else {
        ok(`labels: ${labels.length === 0 ? "(none)" : labels.join(", ")}`);
      }
      return 0;
    }

    const pack = loadSchemaPack(vault);
    if (suggest) {
      const dimensions = ((flags["dimensions"] as string | undefined) ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
      const result = await suggestNoteLabels(vault, relPath, {
        pack,
        ...(dimensions.length > 0 ? { dimensions } : {}),
        configPath: config,
      });
      if (asJson) okJson({ ...result });
      else if (!result.available) ok(`label suggestions not available: ${result.reason}`);
      else {
        if (result.mode === "shadow") ok("decision model: shadow (suggestions recorded only)");
        for (const d of result.dimensions) {
          const conf = d.confidence === null ? "" : ` (confidence ${d.confidence.toFixed(3)})`;
          ok(
            `${d.dimension}: ${d.suggestion ?? "(no suggestion)"}${conf}; current ${d.current ?? "(none)"}`,
          );
        }
        for (const s of result.skipped) ok(`${s.dimension}: skipped (${s.reason})`);
      }
      return 0;
    }
    if (remove !== undefined) {
      const result = removeNoteLabel(vault, relPath, { dimension: remove, pack });
      if (asJson) okJson({ ...result });
      else if (result.removed) ok(`label removed: ${remove} (now: ${renderSet(result.labels)})`);
      else ok(`label not present: ${remove}`);
      return 0;
    }

    const eq = assignment!.indexOf("=");
    if (eq <= 0 || eq === assignment!.length - 1) {
      process.stderr.write(`brain label: assignment must be <dimension>=<value>\n${USAGE}\n`);
      return 2;
    }
    const result = assignNoteLabel(vault, relPath, {
      dimension: assignment!.slice(0, eq),
      value: assignment!.slice(eq + 1),
      pack,
      agent: (flags["agent"] as string | undefined)?.trim() || resolveAgentName(config),
      now: new Date(),
    });
    if (asJson) okJson({ ...result });
    else ok(`labels: ${renderSet(result.labels)}${result.changed ? "" : " (unchanged)"}`);
    return 0;
  } catch (exc) {
    if (exc instanceof LabelVocabularyError || exc instanceof LabelSuggestPrivateNoteError) {
      process.stderr.write(`brain label: ${exc.message}\n`);
      return 2;
    }
    const message = `label failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}

function renderSet(labels: ReadonlyArray<string>): string {
  return labels.length === 0 ? "(none)" : labels.join(", ");
}
