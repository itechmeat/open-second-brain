/**
 * `o2b brain label <path> <dimension>=<value> | --remove <dimension> | --show`
 * (t_7a41f42d): controlled-vocabulary classification. Assignments are
 * validated fail-closed against the schema pack's `labels` field -
 * unknown dimensions and values are rejected with the declared
 * vocabulary - and stored as a sorted `labels` frontmatter array plus
 * a canonical `label` entity.
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
import { loadSchemaPack } from "../../../core/brain/schema-pack.ts";
import { resolveNotePath } from "../../../core/brain/note-path.ts";
import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { parseFrontmatter } from "../../../core/vault.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE =
  "usage: o2b brain label <path> <dimension>=<value> | " +
  "o2b brain label <path> --remove <dimension> | " +
  "o2b brain label <path> --show  [--agent N] [--vault <path>] [--json]";

export async function cmdBrainLabel(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    remove: { type: "string" },
    show: { type: "boolean" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const relPath = positional[0];
  const assignment = positional[1];
  const remove = flags["remove"] as string | undefined;
  const show = flags["show"] === true;
  const modes = [assignment !== undefined, remove !== undefined, show].filter(Boolean).length;
  if (!relPath || modes !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

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
    if (exc instanceof LabelVocabularyError) {
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
