/**
 * The human help surface, rendered FROM the command manifest
 * (no-dead-ends, phase 3, item 1).
 *
 * `o2b help --json` has always serialised {@link CLI_COMMAND_MANIFEST};
 * `o2b help` printed a hand-written constant beside it. Two lists meant
 * two truths, and the manifest repair that added sixty-four entries
 * widened the gap until the human surface named twelve `brain` verbs out
 * of a hundred and thirty. An operator reading the only surface written
 * for them could not reach most of this tool - a discoverability dead end
 * of exactly the kind this release removes.
 *
 * So the human text is derived here rather than maintained. There is no
 * second list to drift: a verb reaches both surfaces by existing in the
 * manifest, and `tests/cli/help-surface-parity.test.ts` parses this
 * output back and requires it to equal the manifest exactly, so a
 * renderer that truncated or wrapped could not pass by claiming shared
 * provenance.
 *
 * Two forms, because they answer different questions:
 *
 *   - {@link renderHelp} is the COMPLETE index - every command at every
 *     level, with the summary and the flags the manifest declares. It is
 *     what `o2b help` and `o2b --help` print.
 *   - {@link renderUsage} is the terse banner for an invocation that named
 *     no command or an unknown one. It lists the top level and names the
 *     complete index, so the short form is a signpost rather than a
 *     truncation.
 *
 * The inherited `--json` flag is stated once in the banner instead of
 * being repeated on two hundred entries; per-command `flags:` lines carry
 * what a command DECLARES. This is a rendering choice, not a claim about
 * the manifest, and the parity test compares against declared flags for
 * that reason.
 *
 * On the forward-pointer ratchet: the strings this module writes name
 * `o2b help` as a usage grammar - the index telling a reader where the
 * rest of the index is - not as a diagnostic's structural exit. Those
 * belong to the advisory rail, which resolves a registered code and never
 * takes text from a caller. The two mechanisms do not overlap.
 */

import {
  manifestForJson,
  type CliCommandManifest,
  type CliFlagManifest,
  type CliRootManifest,
} from "./command-manifest.ts";

/** Indent of an entry line; the parity parser keys on it. */
const ENTRY_INDENT = "  ";
/** Indent of the flags continuation line, deeper so it cannot be an entry. */
const FLAGS_INDENT = "      ";
/** Minimum gutter between a command path and its summary. */
const GUTTER = 2;

const USAGE_LINE = "usage: o2b <command> [args...]";

/** Names the machine surface and the inherited flag, once. */
const BANNER =
  "Every command accepts --json; `o2b help --json` prints this same manifest\n" +
  "as machine-readable JSON, which is what shell completions are built from.";

/** Where the rest of the index is, for the terse form. */
const COMPLETE_INDEX_LINE =
  "Run `o2b help` for every command at every level with its summary and flags.";

/** The declared (non-inherited) flags of `item`, as `--name` tokens. */
function declaredFlags(item: CliCommandManifest): ReadonlyArray<string> {
  return (item.flags ?? [])
    .filter((f: CliFlagManifest) => f.inherited !== true)
    .map((f) => `--${f.name}`);
}

/** One `<heading>:` block listing `items` under the path prefix `prefix`. */
function renderSection(
  heading: string,
  items: ReadonlyArray<CliCommandManifest>,
  prefix: string,
): string {
  const paths = items.map((item) => `${prefix}${item.name}`);
  const width = Math.max(...paths.map((p) => p.length));
  const lines = [`${heading}:`];
  for (const [index, item] of items.entries()) {
    lines.push(`${ENTRY_INDENT}${paths[index]!.padEnd(width)}${" ".repeat(GUTTER)}${item.summary}`);
    const flags = declaredFlags(item);
    if (flags.length > 0) lines.push(`${FLAGS_INDENT}flags: ${flags.join(" ")}`);
  }
  return lines.join("\n");
}

/**
 * Every section, depth first: the parent's own list, then a section per
 * child that has children of its own. Depth-first keeps a group's
 * sub-groups (`brain schema`, `brain pending`) adjacent to it rather than
 * collected at the end, which is the order a reader scans in.
 */
function subSections(items: ReadonlyArray<CliCommandManifest>, prefix: string): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.commands === undefined || item.commands.length === 0) continue;
    const path = `${prefix}${item.name}`;
    out.push(renderSection(`o2b ${path} - ${item.summary}`, item.commands, `${path} `));
    out.push(...subSections(item.commands, `${path} `));
  }
  return out;
}

/** The complete index: every command, at every level, with its summary. */
export function renderHelp(root: CliRootManifest = manifestForJson()): string {
  const blocks = [
    USAGE_LINE,
    BANNER,
    renderSection("Commands", root.commands, ""),
    ...subSections(root.commands, ""),
  ];
  return `${blocks.join("\n\n")}\n`;
}

/**
 * The terse banner: the top-level verbs on one line, plus where the rest
 * of the index is. Used when the caller named no command or an unknown
 * one - cases where the complete two-hundred-line index would bury the
 * error that prompted it.
 */
export function renderUsage(root: CliRootManifest = manifestForJson()): string {
  const names = root.commands.map((item) => item.name).join(", ");
  return `${USAGE_LINE}\n\nCommands: ${names}\n\n${COMPLETE_INDEX_LINE}\n`;
}
