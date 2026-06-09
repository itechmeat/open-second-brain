/**
 * `o2b brain attr <path> <field>=<value> | --remove <field> | --show`
 * (t_f5633190): per-type attribute fields. The note's own frontmatter
 * `type` selects the schema pack's declared descriptor set; assigning
 * an undeclared field is rejected with the declared fields AND their
 * natural-language descriptions, so the vocabulary teaches itself.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import {
  assignNoteAttribute,
  AttributeVocabularyError,
  readAttributes,
  removeNoteAttribute,
} from "../../../core/brain/attributes.ts";
import { loadSchemaPack } from "../../../core/brain/schema-pack.ts";
import { resolveNotePath } from "../../../core/brain/note-path.ts";
import { parseFrontmatter } from "../../../core/vault.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain attr <path> <field>=<value> | " +
  "o2b brain attr <path> --remove <field> | " +
  "o2b brain attr <path> --show  [--vault <path>] [--json]";

export async function cmdBrainAttr(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    remove: { type: "string" },
    show: { type: "boolean" },
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

  const { vault } = brainVerbContext(flags);

  try {
    if (show) {
      const [metadata] = parseFrontmatter(resolveNotePath(vault, relPath));
      const attributes = readAttributes(metadata);
      if (asJson) okJson({ path: relPath, attributes });
      else {
        const entries = Object.entries(attributes);
        ok(
          `attributes: ${entries.length === 0 ? "(none)" : entries.map(([f, v]) => `${f}=${v}`).join(", ")}`,
        );
      }
      return 0;
    }

    const pack = loadSchemaPack(vault);
    if (remove !== undefined) {
      const result = removeNoteAttribute(vault, relPath, { field: remove });
      if (asJson) okJson({ ...result });
      else if (result.removed) ok(`attribute removed: ${remove}`);
      else ok(`attribute not present: ${remove}`);
      return 0;
    }

    const eq = assignment!.indexOf("=");
    if (eq <= 0 || eq === assignment!.length - 1) {
      process.stderr.write(`brain attr: assignment must be <field>=<value>\n${USAGE}\n`);
      return 2;
    }
    const result = assignNoteAttribute(vault, relPath, {
      field: assignment!.slice(0, eq),
      value: assignment!.slice(eq + 1),
      pack,
    });
    if (asJson) okJson({ ...result });
    else {
      ok(`attributes: ${result.attributes.join(", ")}${result.changed ? "" : " (unchanged)"}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof AttributeVocabularyError) {
      process.stderr.write(`brain attr: ${exc.message}\n`);
      return 2;
    }
    const message = `attr failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
