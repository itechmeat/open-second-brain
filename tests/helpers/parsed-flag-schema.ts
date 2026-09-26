/**
 * Reads the flag schema a CLI verb hands to its argv parser, straight from
 * the verb's source.
 *
 * The flag-manifest ratchets enumerate what the VERB parses and ask the
 * manifest to account for each key, never the reverse: a manifest cannot
 * vouch for its own completeness. The schemas are inline object literals,
 * not exported values, so the source is the only place they can be read.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";

/** `<name>: { type: "<type>"` — one entry of a parser schema literal. */
const SCHEMA_ENTRY_RE = /(?:"([^"]+)"|([A-Za-z][\w-]*)):\s*\{\s*type:\s*"([^"]+)"/g;

export interface ParsedSchemaSource {
  /** Absolute path of the verb's module. */
  readonly file: string;
  /** Function declaration the schema is read from, so sibling verbs in the
   * same module cannot leak into each other's census. */
  readonly marker: string;
  /** The opening of the parser call, e.g. `parseFlags(argv, {`. */
  readonly callOpen: string;
  /** Spread expressions resolved to the real constant they pull in. */
  readonly spreads?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** The parser schema the named function declares, as `name -> type`. */
export function parsedFlagSchema(source: ParsedSchemaSource): ReadonlyMap<string, string> {
  const text = readFileSync(source.file, "utf8");
  const fn = text.indexOf(source.marker);
  expect(`${source.file} declares ${source.marker}: ${fn >= 0}`).toBe(
    `${source.file} declares ${source.marker}: true`,
  );
  const start = text.indexOf(source.callOpen, fn);
  expect(`${source.marker} calls ${source.callOpen}: ${start >= 0}`).toBe(
    `${source.marker} calls ${source.callOpen}: true`,
  );
  const end = text.indexOf("});", start);
  expect(`the ${source.marker} parser call is terminated: ${end > start}`).toBe(
    `the ${source.marker} parser call is terminated: true`,
  );
  const literal = text.slice(start, end);

  const out = new Map<string, string>();
  for (const [spread, constant] of Object.entries(source.spreads ?? {})) {
    if (!literal.includes(spread)) continue;
    for (const [name, spec] of Object.entries(constant)) {
      out.set(name, (spec as { type: string }).type);
    }
  }
  for (const match of literal.matchAll(SCHEMA_ENTRY_RE)) {
    out.set(match[1] ?? match[2]!, match[3]!);
  }
  return out;
}
