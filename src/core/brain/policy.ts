/**
 * Brain configuration loader and validator (`Brain/_brain.yaml`).
 *
 * The Brain config is nested two levels deep (top-level keys, each
 * containing a flat `key: number` block) — too rich for the
 * `parseSimpleYaml` flat parser used by the plugin config, but a far cry
 * from needing a real YAML library. We ship a tiny indent-aware parser
 * limited to:
 *
 *   - `# comments` and blank lines
 *   - `key: <scalar>` (numbers parsed; quoted strings stripped)
 *   - `key:` followed by an indented block of the same form (one level)
 *
 * Anything else is treated as invalid and surfaces through
 * `validateBrainConfig` with a field-named error. No external
 * dependency, no eval, no surprise.
 *
 * Anchored in design doc §10.
 */

import { existsSync, readFileSync } from "node:fs";

import type { BrainConfig, DisciplineReportConfig } from "./types.ts";
import { brainConfigPath } from "./paths.ts";

/** Schema versions this build understands. Bump on incompatible changes. */
export const BRAIN_CONFIG_SUPPORTED_VERSIONS: ReadonlyArray<number> = [1];

/**
 * Default `_brain.yaml` content. Mirrors §10 of the design doc. Used by
 * `brain init` and as the fallback inside `loadBrainConfig` when callers
 * opt into permissive mode (the current API is strict — absent file
 * throws).
 */
export const DEFAULT_BRAIN_CONFIG: BrainConfig = Object.freeze({
  schema_version: 1,
  primary_agent: null,
  dream: Object.freeze({
    candidate_threshold: 3,
    unconfirmed_window_days: 14,
    contradiction_window_days: 14,
  }),
  retire: Object.freeze({
    stale_evidence_days: 90,
  }),
  confidence: Object.freeze({
    low_max_applied: 2,
    high_min_applied: 10,
    high_freshness_factor: 0.8,
    medium_min: 0.40,
    high_min: 0.75,
  }),
  snapshots: Object.freeze({
    retention_count: 10,
  }),
}) as BrainConfig;

/**
 * Serialised default `_brain.yaml`. Hand-formatted to match the design
 * doc verbatim — `brain init` writes this byte string so the file the
 * user sees is the file the docs describe.
 */
export const DEFAULT_BRAIN_CONFIG_YAML = `schema_version: 1

# Optional. When set, dream runs from a different agent emit a stderr
# warning and a non_primary_agent payload row. The vault should have a
# single dream-running runtime even when it is shared across devices
# via Syncthing.
primary_agent: null

dream:
  candidate_threshold: 3
  unconfirmed_window_days: 14
  contradiction_window_days: 14

retire:
  stale_evidence_days: 90

confidence:
  low_max_applied: 2
  high_min_applied: 10
  high_freshness_factor: 0.8
  # Derived-band thresholds on the numeric confidence_value (Wilson
  # lower bound × freshness decay). The count-based hard floors
  # above still take precedence: low_max_applied / violated >=
  # applied / missing-fresh keep a rule at low / medium regardless
  # of the numeric value.
  medium_min: 0.40
  high_min: 0.75

snapshots:
  retention_count: 10
`;

const YAML_STRING_REJECTED_CHARS = ['"', "\\", "\n", "\r"] as const;

/**
 * Format a `primary_agent` value for the small `_brain.yaml` subset.
 *
 * We quote non-null values so spaces / `#` / `:` round-trip as data
 * instead of being interpreted as comments or YAML structure. Since the
 * parser intentionally does not implement escape sequences, reject bytes
 * that would require escaping rather than writing a value that cannot
 * be read back exactly.
 */
export function formatPrimaryAgentYamlValue(
  value: string | null,
  source: string | null = null,
): string {
  if (value === null) return "null";
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BrainConfigError(
      "must be either null or a non-empty string",
      "primary_agent",
      source,
    );
  }
  for (const bad of YAML_STRING_REJECTED_CHARS) {
    if (trimmed.includes(bad)) {
      throw new BrainConfigError(
        `contains a disallowed character ${JSON.stringify(bad)}; ` +
          "use a simple one-line agent id",
        "primary_agent",
        source,
      );
    }
  }
  return `"${trimmed}"`;
}

/**
 * Warnings collected during validation. Forward-compat tolerates unknown
 * top-level keys but surfaces them so a typo doesn't go unnoticed.
 */
export interface BrainConfigLoadWarning {
  readonly path: string;
  readonly message: string;
}

export class BrainConfigError extends Error {
  /**
   * Dotted field path that caused the failure (`dream.candidate_threshold`,
   * `schema_version`, …). `null` for top-level type errors.
   */
  readonly field: string | null;
  readonly source: string | null;

  constructor(message: string, field: string | null, source: string | null) {
    super(field ? `${source ?? "<config>"}: ${field}: ${message}` : `${source ?? "<config>"}: ${message}`);
    this.name = "BrainConfigError";
    this.field = field;
    this.source = source;
  }
}

// ----- Public API -----------------------------------------------------------

export interface LoadBrainConfigResult {
  readonly config: BrainConfig;
  readonly warnings: ReadonlyArray<BrainConfigLoadWarning>;
  readonly path: string;
}

/**
 * Read and validate `<vault>/Brain/_brain.yaml`.
 *
 * Throws {@link BrainConfigError} on:
 *   - missing file
 *   - YAML shape errors
 *   - unsupported `schema_version`
 *   - non-integer / out-of-range thresholds
 *   - `high_freshness_factor` outside `(0, 1]`
 *   - non-integer / non-positive `snapshots.retention_count`
 *
 * Unknown top-level keys are reported as warnings, not errors.
 */
export function loadBrainConfig(vault: string): BrainConfig {
  return loadBrainConfigDetailed(vault).config;
}

/**
 * Same as {@link loadBrainConfig} but also returns parser warnings (for
 * the future `o2b brain doctor` integration).
 */
export function loadBrainConfigDetailed(vault: string): LoadBrainConfigResult {
  const path = brainConfigPath(vault);
  if (!existsSync(path)) {
    throw new BrainConfigError(
      "config file does not exist; run `o2b brain init` first",
      null,
      path,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new BrainConfigError(
      `failed to read: ${(err as Error).message ?? String(err)}`,
      null,
      path,
    );
  }

  let parsed: ParsedBlock;
  try {
    parsed = parseBrainYaml(text);
  } catch (err) {
    throw new BrainConfigError(
      (err as Error).message,
      null,
      path,
    );
  }

  const { config, warnings } = validateBrainConfigDetailed(parsed, path);
  return { config, warnings, path };
}

/**
 * Pure validator. Accepts a parsed object (typically from
 * {@link parseBrainYaml}) and returns a typed {@link BrainConfig}, or
 * throws {@link BrainConfigError} naming the offending field.
 *
 * `source` is rendered into error messages; pass the config file path or
 * a synthetic label like `"<test fixture>"` so the failure points at
 * something useful.
 */
export function validateBrainConfig(
  parsed: unknown,
  source: string | null = null,
): BrainConfig {
  return validateBrainConfigDetailed(parsed, source).config;
}

export interface ValidateResult {
  readonly config: BrainConfig;
  readonly warnings: ReadonlyArray<BrainConfigLoadWarning>;
}

export function validateBrainConfigDetailed(
  parsed: unknown,
  source: string | null = null,
): ValidateResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BrainConfigError("config root must be a map of keys", null, source);
  }
  const obj = parsed as Record<string, unknown>;
  const warnings: BrainConfigLoadWarning[] = [];

  // schema_version is mandatory and must be in the supported set.
  if (!("schema_version" in obj)) {
    throw new BrainConfigError(
      "missing required field; expected a positive integer in the supported set " +
        `(${BRAIN_CONFIG_SUPPORTED_VERSIONS.join(", ")})`,
      "schema_version",
      source,
    );
  }
  const schemaVersion = obj["schema_version"];
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    !BRAIN_CONFIG_SUPPORTED_VERSIONS.includes(schemaVersion)
  ) {
    throw new BrainConfigError(
      `unsupported value ${JSON.stringify(schemaVersion)}; expected one of ` +
        BRAIN_CONFIG_SUPPORTED_VERSIONS.join(", "),
      "schema_version",
      source,
    );
  }

  // `primary_agent` — optional scalar (null or non-empty string).
  // Defaults to null when absent so existing vaults are unaffected.
  // Loader enforces the same character constraints as the writer
  // (`formatPrimaryAgentYamlValue`) so a hand-edited file that the
  // writer would later refuse to emit fails fast at load time
  // instead of round-tripping into a state we cannot persist.
  let primaryAgent: string | null = DEFAULT_BRAIN_CONFIG.primary_agent;
  if ("primary_agent" in obj) {
    const v = obj["primary_agent"];
    if (v === null || v === undefined) {
      primaryAgent = null;
    } else if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length === 0) {
        throw new BrainConfigError(
          "must be either null or a non-empty string",
          "primary_agent",
          source,
        );
      }
      for (const bad of YAML_STRING_REJECTED_CHARS) {
        if (trimmed.includes(bad)) {
          throw new BrainConfigError(
            `contains a disallowed character ${JSON.stringify(bad)}; ` +
              "use a simple one-line agent id",
            "primary_agent",
            source,
          );
        }
      }
      primaryAgent = trimmed;
    } else {
      throw new BrainConfigError(
        `must be either null or a non-empty string; got ${describe(v)}`,
        "primary_agent",
        source,
      );
    }
  }

  // Each block is optional; missing blocks inherit the default. We
  // merge field-by-field so a user can override one threshold without
  // having to re-state the rest.
  const dream = mergeBlock(
    "dream",
    obj["dream"],
    DEFAULT_BRAIN_CONFIG.dream as unknown as Readonly<Record<string, number>>,
    source,
  );
  requirePositiveInteger("dream.candidate_threshold", dream.candidate_threshold, source);
  requirePositiveInteger("dream.unconfirmed_window_days", dream.unconfirmed_window_days, source);
  requirePositiveInteger("dream.contradiction_window_days", dream.contradiction_window_days, source);

  const retire = mergeBlock(
    "retire",
    obj["retire"],
    DEFAULT_BRAIN_CONFIG.retire as unknown as Readonly<Record<string, number>>,
    source,
  );
  requirePositiveInteger("retire.stale_evidence_days", retire.stale_evidence_days, source);

  const confidence = mergeBlock(
    "confidence",
    obj["confidence"],
    DEFAULT_BRAIN_CONFIG.confidence as unknown as Readonly<Record<string, number>>,
    source,
  );
  requireNonNegativeInteger(
    "confidence.low_max_applied",
    confidence.low_max_applied,
    source,
  );
  requirePositiveInteger(
    "confidence.high_min_applied",
    confidence.high_min_applied,
    source,
  );
  if (
    typeof confidence.high_freshness_factor !== "number" ||
    !Number.isFinite(confidence.high_freshness_factor) ||
    confidence.high_freshness_factor <= 0 ||
    confidence.high_freshness_factor > 1
  ) {
    throw new BrainConfigError(
      `must be a number in (0, 1]; got ${JSON.stringify(confidence.high_freshness_factor)}`,
      "confidence.high_freshness_factor",
      source,
    );
  }
  requireUnitInterval(
    "confidence.medium_min",
    confidence.medium_min,
    source,
  );
  requireUnitInterval(
    "confidence.high_min",
    confidence.high_min,
    source,
  );
  if (
    (confidence.medium_min as number) >= (confidence.high_min as number)
  ) {
    throw new BrainConfigError(
      `medium_min must be strictly less than high_min; got ` +
        `medium_min=${confidence.medium_min}, high_min=${confidence.high_min}`,
      "confidence.medium_min",
      source,
    );
  }

  const snapshots = mergeBlock(
    "snapshots",
    obj["snapshots"],
    DEFAULT_BRAIN_CONFIG.snapshots as unknown as Readonly<Record<string, number>>,
    source,
  );
  requirePositiveInteger("snapshots.retention_count", snapshots.retention_count, source);

  // Optional `discipline_report` section. On any type mismatch, emit a
  // warning and drop the section (return undefined) rather than throwing —
  // the rest of the CLI surface must keep working.
  let disciplineReport: DisciplineReportConfig | undefined;
  if ("discipline_report" in obj) {
    const dr = obj["discipline_report"];
    if (typeof dr !== "object" || dr === null || Array.isArray(dr)) {
      warnings.push({
        path: source ?? "<config>",
        message: `discipline_report: must be a map of keys; got ${describe(dr)} — section ignored`,
      });
    } else {
      const drObj = dr as Record<string, unknown>;
      let ok = true;

      // enabled: boolean
      if (typeof drObj["enabled"] !== "boolean") {
        warnings.push({
          path: source ?? "<config>",
          message: `discipline_report.enabled: must be a boolean; got ${describe(drObj["enabled"])} — section ignored`,
        });
        ok = false;
      }

      // timezone: string
      if (typeof drObj["timezone"] !== "string") {
        warnings.push({
          path: source ?? "<config>",
          message: `discipline_report.timezone: must be a string; got ${describe(drObj["timezone"])} — section ignored`,
        });
        ok = false;
      }

      // watched_paths: array of strings
      if (!Array.isArray(drObj["watched_paths"])) {
        warnings.push({
          path: source ?? "<config>",
          message: `discipline_report.watched_paths: must be an array; got ${describe(drObj["watched_paths"])} — section ignored`,
        });
        ok = false;
      } else {
        const badIdx = (drObj["watched_paths"] as unknown[]).findIndex(
          (v) => typeof v !== "string",
        );
        if (badIdx >= 0) {
          warnings.push({
            path: source ?? "<config>",
            message: `discipline_report.watched_paths[${badIdx}]: must be a string; got ${describe((drObj["watched_paths"] as unknown[])[badIdx])} — section ignored`,
          });
          ok = false;
        }
      }

      // known_agents: array of strings
      if (!Array.isArray(drObj["known_agents"])) {
        warnings.push({
          path: source ?? "<config>",
          message: `discipline_report.known_agents: must be an array; got ${describe(drObj["known_agents"])} — section ignored`,
        });
        ok = false;
      } else {
        const badIdx = (drObj["known_agents"] as unknown[]).findIndex(
          (v) => typeof v !== "string",
        );
        if (badIdx >= 0) {
          warnings.push({
            path: source ?? "<config>",
            message: `discipline_report.known_agents[${badIdx}]: must be a string; got ${describe((drObj["known_agents"] as unknown[])[badIdx])} — section ignored`,
          });
          ok = false;
        }
      }

      if (ok) {
        disciplineReport = {
          enabled: drObj["enabled"] as boolean,
          timezone: drObj["timezone"] as string,
          watched_paths: drObj["watched_paths"] as ReadonlyArray<string>,
          known_agents: drObj["known_agents"] as ReadonlyArray<string>,
        };
      }
    }
  }

  // Forward-compat: unknown top-level keys → warning, not error.
  const known = new Set([
    "schema_version",
    "primary_agent",
    "dream",
    "retire",
    "confidence",
    "snapshots",
    "discipline_report",
  ]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      warnings.push({
        path: source ?? "<config>",
        message: `unknown top-level field '${key}' ignored (forward-compat)`,
      });
    }
  }

  const config: BrainConfig = {
    schema_version: schemaVersion,
    primary_agent: primaryAgent,
    dream: {
      candidate_threshold: dream.candidate_threshold as number,
      unconfirmed_window_days: dream.unconfirmed_window_days as number,
      contradiction_window_days: dream.contradiction_window_days as number,
    },
    retire: {
      stale_evidence_days: retire.stale_evidence_days as number,
    },
    confidence: {
      low_max_applied: confidence.low_max_applied as number,
      high_min_applied: confidence.high_min_applied as number,
      high_freshness_factor: confidence.high_freshness_factor as number,
      medium_min: confidence.medium_min as number,
      high_min: confidence.high_min as number,
    },
    snapshots: {
      retention_count: snapshots.retention_count as number,
    },
    ...(disciplineReport !== undefined ? { discipline_report: disciplineReport } : {}),
  };

  return { config, warnings };
}

// ----- Helpers --------------------------------------------------------------

/**
 * Merge a parsed block (or `undefined`) with its default, returning a
 * plain object whose value types are validated downstream. A non-object
 * block (string, number, array) is a hard error — the user probably
 * miswrote the YAML.
 */
function mergeBlock(
  blockKey: string,
  raw: unknown,
  fallback: Readonly<Record<string, number>>,
  source: string | null,
): Record<string, unknown> {
  if (raw === undefined) {
    return { ...fallback };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BrainConfigError(
      `block must be a map of keys; got ${describe(raw)}`,
      blockKey,
      source,
    );
  }
  const merged: Record<string, unknown> = { ...fallback };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    merged[k] = v;
  }
  return merged;
}

function requirePositiveInteger(
  field: string,
  value: unknown,
  source: string | null,
): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new BrainConfigError(
      `must be a positive integer; got ${describe(value)}`,
      field,
      source,
    );
  }
}

function requireNonNegativeInteger(
  field: string,
  value: unknown,
  source: string | null,
): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new BrainConfigError(
      `must be a non-negative integer; got ${describe(value)}`,
      field,
      source,
    );
  }
}

function requireUnitInterval(
  field: string,
  value: unknown,
  source: string | null,
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new BrainConfigError(
      `must be a number in [0, 1]; got ${describe(value)}`,
      field,
      source,
    );
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  return `${typeof value}(${JSON.stringify(value)})`;
}

// ----- Minimal indent-aware YAML parser ------------------------------------
//
// The parser handles only the shape used by `_brain.yaml`:
//
//   - `# comment` lines and blanks
//   - top-level `key: <scalar>`
//   - top-level `key:` followed by an indented block of one indent level
//   - block-level `<indent>key: <scalar>`
//
// Scalars are parsed as:
//   - plain integers / floats (no exponents, no leading +)
//   - quoted strings ('..' or "..") — the quotes are stripped and the
//     content is taken as-is (no escape sequences)
//   - the bare words `true`, `false`, `null`
//   - otherwise: the literal string
//
// This intentionally rejects nested mappings deeper than two levels,
// inline arrays, anchors, and aliases — none of which the schema needs.

type ParsedScalar = number | string | boolean | null;
type ParsedBlockValue = ParsedScalar | Record<string, ParsedScalar | ParsedScalar[]> | ParsedScalar[];
type ParsedBlock = Record<string, ParsedBlockValue>;

interface Line {
  readonly raw: string;
  readonly indent: number;
  readonly content: string;
  readonly lineNumber: number;
}

export function parseBrainYaml(text: string): ParsedBlock {
  const lines = splitLines(text);
  const out: ParsedBlock = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent !== 0) {
      throw new Error(
        `line ${line.lineNumber}: unexpected indentation at top level`,
      );
    }
    const kv = splitKeyValue(line);
    if (kv.value === "") {
      // Block header: collect indented children.
      // Each child may be a scalar value (`key: val`) or a list (`key:` followed
      // by deeper-indented `- item` lines). Lists-within-blocks are the only
      // third-level nesting we support — they are required for `discipline_report`.
      const child: Record<string, ParsedScalar | ParsedScalar[]> = {};
      i++;
      const blockIndent = detectBlockIndent(lines, i);
      while (i < lines.length && lines[i]!.indent >= blockIndent && blockIndent > 0) {
        const inner = lines[i]!;
        if (inner.indent !== blockIndent) {
          throw new Error(
            `line ${inner.lineNumber}: inconsistent indentation in block '${kv.key}' ` +
              `(expected ${blockIndent} spaces, got ${inner.indent})`,
          );
        }
        const innerKv = splitKeyValue(inner);
        if (innerKv.value === "") {
          // Child key with no value — expect a list of `- item` lines at a
          // deeper indent level.
          i++;
          const listIndent = detectBlockIndent(lines, i);
          if (listIndent <= blockIndent) {
            // Empty list (next line is at the same or shallower indent).
            if (innerKv.key in child) {
              throw new Error(
                `line ${inner.lineNumber}: duplicate key '${innerKv.key}' in block '${kv.key}'`,
              );
            }
            child[innerKv.key] = [];
            continue;
          }
          const items: ParsedScalar[] = [];
          while (i < lines.length && lines[i]!.indent >= listIndent) {
            const listLine = lines[i]!;
            if (listLine.indent !== listIndent) {
              throw new Error(
                `line ${listLine.lineNumber}: inconsistent indentation in list '${innerKv.key}' ` +
                  `(expected ${listIndent} spaces, got ${listLine.indent})`,
              );
            }
            if (!listLine.content.startsWith("- ") && listLine.content !== "-") {
              // If it looks like a `key: value` pair, it's a deeper block — not
              // supported. Preserve the original error message so existing tests
              // that assert on the wording keep passing.
              if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(listLine.content)) {
                throw new Error(
                  `line ${listLine.lineNumber}: nested blocks deeper than one level are not supported`,
                );
              }
              throw new Error(
                `line ${listLine.lineNumber}: expected list item starting with '- ' ` +
                  `in '${kv.key}.${innerKv.key}'`,
              );
            }
            const itemText = listLine.content.startsWith("- ")
              ? listLine.content.slice(2).trim()
              : "";
            items.push(parseScalar(itemText, listLine.lineNumber));
            i++;
          }
          if (innerKv.key in child) {
            throw new Error(
              `line ${inner.lineNumber}: duplicate key '${innerKv.key}' in block '${kv.key}'`,
            );
          }
          child[innerKv.key] = items;
          continue;
        }
        if (innerKv.key in child) {
          throw new Error(
            `line ${inner.lineNumber}: duplicate key '${innerKv.key}' in block '${kv.key}'`,
          );
        }
        child[innerKv.key] = parseScalar(innerKv.value, inner.lineNumber);
        i++;
      }
      if (kv.key in out) {
        throw new Error(`duplicate top-level key '${kv.key}'`);
      }
      out[kv.key] = child;
      continue;
    }
    if (kv.key in out) {
      throw new Error(`duplicate top-level key '${kv.key}'`);
    }
    out[kv.key] = parseScalar(kv.value, line.lineNumber);
    i++;
  }
  return out;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let lineNumber = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNumber++;
    // Strip trailing whitespace; leave leading intact for indent detection.
    const stripped = raw.replace(/\s+$/, "");
    // Skip blanks and comment-only lines.
    if (stripped.trim() === "") continue;
    if (stripped.trimStart().startsWith("#")) continue;
    // Strip inline comments only when they are clearly outside a quoted
    // value. Keep this simple: only honour ` #` (space then hash) on
    // unquoted lines. Quoted values keep their content verbatim.
    let content = stripped;
    if (!/['"]/.test(stripped)) {
      const hashIdx = stripped.indexOf(" #");
      if (hashIdx >= 0) content = stripped.slice(0, hashIdx).replace(/\s+$/, "");
    }
    const indent = content.length - content.trimStart().length;
    out.push({
      raw,
      indent,
      content: content.slice(indent),
      lineNumber,
    });
  }
  return out;
}

interface KeyValue {
  readonly key: string;
  readonly value: string;
}

function splitKeyValue(line: Line): KeyValue {
  const idx = line.content.indexOf(":");
  if (idx <= 0) {
    throw new Error(
      `line ${line.lineNumber}: expected 'key: value', got: ${JSON.stringify(line.raw)}`,
    );
  }
  const key = line.content.slice(0, idx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
    throw new Error(
      `line ${line.lineNumber}: invalid key name: ${JSON.stringify(key)}`,
    );
  }
  const value = line.content.slice(idx + 1).trim();
  return { key, value };
}

function detectBlockIndent(lines: Line[], cursor: number): number {
  if (cursor >= lines.length) return 0;
  const first = lines[cursor]!;
  if (first.indent === 0) return 0; // empty block (next top-level key)
  return first.indent;
}

function parseScalar(text: string, lineNumber: number): ParsedScalar {
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  // Number: integer or finite decimal. Anything else → literal string.
  if (/^-?\d+$/.test(text)) {
    const n = parseInt(text, 10);
    return n;
  }
  if (/^-?\d+\.\d+$/.test(text)) {
    const n = parseFloat(text);
    if (!Number.isFinite(n)) {
      throw new Error(`line ${lineNumber}: non-finite number: ${text}`);
    }
    return n;
  }
  return text;
}
