/**
 * Unit C — the origin channel is server-derived, and that is measured.
 *
 * The cardinal rule of this unit is a negative, so it is asserted as one.
 * Agent identity resolves to a caller-supplied `agent` string on 25 MCP
 * tool schemas, taken verbatim after a placeholder check; the write
 * binding's own docblock says so and tells you to recount it. A channel
 * that a caller could name would be exactly that again - an unverifiable
 * claim with a schema in front of it. So no schema property, no CLI flag,
 * and no writer input field may spell the channel, and this census is
 * what proves it rather than a sentence in a docblock.
 *
 * Claims pinned here:
 *  1. No MCP tool schema declares a property spelling the channel, in
 *     any of its spellings, anywhere under `src/mcp/` - except the one
 *     recall-telemetry read filter excused by name below.
 *  2. No CLI flag or command-manifest entry names it, with the same one
 *     exception on the CLI side of that filter.
 *  3. The caller-facing input types of the four stamped writers declare
 *     no channel field, so TypeScript cannot be talked past either.
 *  4. The `agent` recount that motivates the rule is still what this
 *     wave measured - an equality, so this fails when the unverifiable
 *     surface grows AND when it shrinks. Growth is the event worth
 *     learning about, and a floor could not report it.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { ORIGIN_CHANNELS } from "../../../src/core/origin-channel.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function readTree(rel: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) {
        files.push({
          path: relative(REPO_ROOT, abs).split("\\").join("/"),
          text: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  walk(join(REPO_ROOT, rel));
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Every spelling the channel could arrive under. `channel` alone is in
 * the set because the field does not have to carry the full name to be
 * the same lie - a tool taking `channel: "cli"` is the refused design
 * wearing a shorter word.
 */
const CHANNEL_SPELLINGS: ReadonlyArray<string> = Object.freeze([
  "origin_channel",
  "originChannel",
  "origin-channel",
  "channel",
]);

/**
 * The one caller-supplied `channel` in the tree, excused by name.
 *
 * `RECALL_CHANNEL` (`brain/recall-telemetry.ts`) is a DIFFERENT axis that
 * shipped first: the transport a recall was DELIVERED over, whose members
 * (`mcp` / `cli` / `hook`) rhyme with the origin channel's closely enough
 * that a bare `channel` grep cannot tell them apart. Both surfaces below
 * take it as a read-side FILTER over telemetry the caller itself
 * recorded, which is a query parameter and not a provenance claim.
 *
 * Excused rather than dropped from {@link CHANNEL_SPELLINGS}: the bare
 * word is exactly how the refused design would arrive - a tool taking
 * `channel: "cli"` is the same lie in fewer letters - so the grep keeps
 * it and this list keeps the two apart by name. A THIRD `channel`
 * property fails here and has to argue its way in.
 */
const RECALL_CHANNEL_FILTER_SITES: ReadonlyArray<string> = Object.freeze([
  "src/cli/brain/verbs/recall-telemetry.ts: channel x1",
  "src/mcp/brain/recall-tools.ts: channel x1",
]);

/**
 * A JSON-schema property declaration, in the shape the write binding's
 * own `agent` recount uses (`grep -rn '^\s*agent:\s*{' src/mcp/`). The
 * schemas in this tree declare one property per line with the key at the
 * start of it, so the anchor is what distinguishes a DECLARATION from a
 * mention in prose or a local variable.
 */
function propertyDeclarationRe(key: string): RegExp {
  return new RegExp(`^\\s*(?:"${key}"|'${key}'|${key})\\s*:\\s*\\{`, "gm");
}

/**
 * A `parseFlags` spec entry or a command-manifest `flag(...)` entry. Both
 * shapes, because the CLI declares a flag in two places and a rule that
 * reads one of them is a rule about that one: `parseFlags` takes an
 * object whose keys are the flag names (quoted or bare), and the manifest
 * takes `flag("name", …)`.
 */
function flagDeclarationRe(key: string): RegExp {
  return new RegExp(
    `^\\s*(?:"${key}"|'${key}'|${key})\\s*:\\s*\\{|flag\\(\\s*["']${key}["']`,
    "gm",
  );
}

function hits(files: ReadonlyArray<SourceFile>, re: (key: string) => RegExp): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const spelling of CHANNEL_SPELLINGS) {
      const matches = file.text.match(re(spelling));
      if (matches !== null) found.push(`${file.path}: ${spelling} x${matches.length}`);
    }
  }
  return found.toSorted();
}

const MCP_FILES = readTree("src/mcp");
const CLI_FILES = readTree("src/cli");

describe("no caller can name the origin channel", () => {
  test("no MCP tool schema declares a channel property", () => {
    // Named, not counted: a failure has to say which schema reopened it.
    expect(hits(MCP_FILES, propertyDeclarationRe)).toEqual(
      RECALL_CHANNEL_FILTER_SITES.filter((site) => site.startsWith("src/mcp/")),
    );
  });

  test("no CLI flag or command-manifest entry names it", () => {
    expect(hits(CLI_FILES, flagDeclarationRe)).toEqual(
      RECALL_CHANNEL_FILTER_SITES.filter((site) => site.startsWith("src/cli/")),
    );
  });

  test("the vocabulary values are not reachable as caller input either", () => {
    // The complement of the two greps above: a schema could take the
    // channel under some other key and still be the refused design, so
    // the enum members themselves must not appear in a schema `enum`.
    const enumHits: string[] = [];
    for (const file of MCP_FILES) {
      for (const channel of ORIGIN_CHANNELS) {
        const re = new RegExp(`enum\\s*:\\s*\\[[^\\]]*["']${channel}["']`, "g");
        if (re.test(file.text)) enumHits.push(`${file.path}: ${channel}`);
      }
    }
    expect(enumHits.toSorted()).toEqual([]);
  });

  test("the four stamped writers declare no caller-facing channel field", () => {
    // The type-level half. Each of these is the one input interface a
    // caller fills in for that family; a field here would let an
    // in-process caller assert what the process alone may derive.
    const WRITER_INPUT_TYPES: ReadonlyArray<readonly [string, string]> = Object.freeze([
      ["src/core/brain/log.ts", "AppendLogEventOptions"],
      ["src/core/brain/signal.ts", "WriteSignalInput"],
      ["src/core/brain/continuity/types.ts", "AppendContinuityRecordInput"],
      ["src/core/brain/notes/create-note.ts", "CreateNoteInput"],
    ]);
    const offenders: string[] = [];
    for (const [path, typeName] of WRITER_INPUT_TYPES) {
      const text = readFileSync(join(REPO_ROOT, path), "utf8");
      const start = text.indexOf(`interface ${typeName} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = text.indexOf("\n}", start);
      const block = text.slice(start, end);
      for (const spelling of CHANNEL_SPELLINGS) {
        if (new RegExp(`readonly\\s+${spelling}\\??\\s*:`).test(block)) {
          offenders.push(`${path}: ${typeName}.${spelling}`);
        }
      }
    }
    expect(offenders.toSorted()).toEqual([]);
  });
});

describe("the unverifiable surface this rule exists for", () => {
  /**
   * The caller-supplied `agent` property count, MEASURED and pinned as an
   * equality - the convention the write-site census states for its own
   * row counts: a moved number is a finding to name in the commit that
   * moves it, not a re-measurement chore.
   *
   * It was a floor, and a floor could not fail on the event both its
   * comments said it watched for. `>= 25` passes at 35, so ten new
   * schemas taking `agent` verbatim would have widened the unverifiable
   * surface this whole rule is argued from and reported nothing. An
   * equality fails in both directions; when it does, recount with the
   * regex below, update this constant, and say in the commit which
   * schemas moved it.
   */
  const CALLER_SUPPLIED_AGENT_PROPERTIES = 25;

  test("is exactly what the rule was argued from, in both directions", () => {
    let count = 0;
    for (const file of MCP_FILES) {
      count += (file.text.match(/^\s*agent:\s*\{/gm) ?? []).length;
    }
    expect(count).toBe(CALLER_SUPPLIED_AGENT_PROPERTIES);
  });
});
