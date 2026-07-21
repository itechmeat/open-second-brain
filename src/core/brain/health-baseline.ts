/**
 * Acknowledge-before health baseline (`health.silence_before`).
 *
 * The semantic-health pass emits advisory `concept-gap` and
 * `batch-concept-inflation` findings that have no time component, so a
 * bulk-seeded vault pins the verdict at `watch` forever. This module is
 * the operator-facing lane for the watermark that clears them: read the
 * current value, and overwrite (or remove) the `silence_before` line
 * inside the `_brain.yaml` `health:` block without hand-editing the file.
 *
 * Detection and storage are untouched - the watermark only changes what
 * the reconcile surface shows. Parsing/validation of the instant lives in
 * `health/iso-time.ts`, the single source shared with the detectors.
 */

import { existsSync, readFileSync } from "node:fs";

import { atomicWriteText } from "../fs-atomic.ts";
import { withFileLock } from "../reliability/lock.ts";
import { brainConfigPath } from "./paths.ts";
import { loadBrainConfig, resolveHealth } from "./policy.ts";
import { isValidIsoInstant } from "./health/iso-time.ts";

/** Operational failure surfacing a bad value or an unwritable config. */
export class HealthBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthBaselineError";
  }
}

/** The resolved watermark, or `null` when the feature is off. */
export function readHealthBaseline(vault: string): string | null {
  return resolveHealth(loadBrainConfig(vault)).silence_before;
}

/**
 * Overwrite (non-null) or remove (`null`) the `health.silence_before`
 * line in `_brain.yaml`. Rejects an unparseable value loudly rather than
 * writing a watermark the loader would later refuse.
 *
 * Locked with the same `withFileLock` + `atomicWriteText` convention
 * schema-mutate.ts uses for `_brain.yaml`: read-modify-write under an
 * exclusive lock so a concurrent writer (another `health-baseline set`,
 * or a schema mutation) can't race this read-modify-write and lose an
 * update to a last-writer-wins overwrite.
 */
export async function writeHealthBaseline(vault: string, value: string | null): Promise<void> {
  if (value !== null && !isValidIsoInstant(value)) {
    throw new HealthBaselineError(
      `not an ISO-8601 date (YYYY-MM-DD) or timestamp: ${JSON.stringify(value)}`,
    );
  }
  const path = brainConfigPath(vault);
  await withFileLock(path, { staleMs: 30_000, retries: 3 }, () => {
    if (!existsSync(path)) {
      throw new HealthBaselineError("_brain.yaml is missing; run `o2b brain init` to bootstrap it");
    }
    const before = readFileSync(path, "utf8");
    // Temp-file + rename, matching how schema-mutate.ts writes _brain.yaml:
    // a crash mid-write must never truncate the vault config.
    atomicWriteText(path, applyHealthSilenceBeforeToYaml(before, value));
  });
}

/** ISO instants contain no YAML-hazardous bytes, so a plain quote round-trips. */
function formatSilenceBeforeYamlValue(value: string): string {
  return `"${value}"`;
}

/**
 * Pure `_brain.yaml` transform: set or clear the `silence_before` line
 * inside the `health:` block. A non-null value upserts the line (creating
 * the block when absent); `null` removes it (and the block header when it
 * leaves the block empty). Other health keys and unrelated blocks are
 * preserved byte-for-byte.
 */
export function applyHealthSilenceBeforeToYaml(configText: string, value: string | null): string {
  // CRLF `_brain.yaml` files split into lines that keep a trailing `\r` (the
  // split is on `\n` only), so untouched lines round-trip byte-for-byte
  // through `lines.join("\n")` automatically. Only text this function
  // generates - a fresh header, a replaced/inserted `silence_before` line -
  // needs to carry that trailing `\r` explicitly to match.
  const eol = configText.includes("\r\n") ? "\r\n" : "\n";
  const hadContent = configText.length > 0;
  const normalized = !hadContent || configText.endsWith("\n") ? configText : `${configText}${eol}`;
  const lines = normalized.split("\n");
  const headerIdx = lines.findIndex((line) => /^health:[ \t]*\r?$/.test(line));

  if (value !== null) {
    const quoted = formatSilenceBeforeYamlValue(value);
    if (headerIdx < 0) {
      const base = normalized.replace(/[\r\n]+$/, "") + eol;
      const separator = hadContent ? eol : "";
      return `${base}${separator}health:${eol}  silence_before: ${quoted}${eol}`;
    }
    const childIdx = findHealthChild(lines, headerIdx, /^[ \t]+silence_before[ \t]*:/);
    if (childIdx >= 0) {
      // Replace in place: keep the line's own indent and line ending rather
      // than forcing two spaces, so an existing wider (or narrower) block
      // indent - which parseBrainYaml requires siblings to share - survives.
      const existing = lines[childIdx]!;
      const trailingCr = existing.endsWith("\r") ? "\r" : "";
      const indent = /^[ \t]+/.exec(existing)?.[0] ?? "  ";
      lines[childIdx] = `${indent}silence_before: ${quoted}${trailingCr}`;
    } else {
      // New key in an existing block: match a sibling's indent so the
      // inserted line doesn't clash with the block's established width.
      // Fall back to two spaces only when the block has no siblings yet.
      const indent = detectHealthSiblingIndent(lines, headerIdx) ?? "  ";
      const trailingCr = eol === "\r\n" ? "\r" : "";
      lines.splice(headerIdx + 1, 0, `${indent}silence_before: ${quoted}${trailingCr}`);
    }
    return lines.join("\n");
  }

  if (headerIdx < 0) return normalized;
  const childIdx = findHealthChild(lines, headerIdx, /^[ \t]+silence_before[ \t]*:/);
  if (childIdx < 0) return normalized;
  lines.splice(childIdx, 1);
  // Drop a now-empty `health:` header (plus the blank lines it left behind)
  // so clearing a CLI-created block returns the file to its prior shape.
  if (findHealthChild(lines, headerIdx, /^[ \t]+\S/) < 0) {
    let removeTo = headerIdx + 1;
    while (removeTo < lines.length && lines[removeTo]!.trim() === "") removeTo++;
    lines.splice(headerIdx, removeTo - headerIdx);
  }
  return lines.join("\n");
}

/**
 * Leading whitespace of the first child line inside the `health:` block
 * (headerIdx), or `null` when the block has no children yet (empty or
 * about to be populated for the first time). `parseBrainYaml` requires all
 * siblings in a block to share one indent, so any inserted key must match
 * whatever indent the block already established.
 */
function detectHealthSiblingIndent(lines: ReadonlyArray<string>, headerIdx: number): string | null {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (!/^[ \t]/.test(line)) break;
    return /^[ \t]+/.exec(line)![0];
  }
  return null;
}

/**
 * First line inside the `health:` block (headerIdx) matching `re`. Blank
 * lines are skipped; the first unindented non-empty line ends the block.
 */
function findHealthChild(lines: ReadonlyArray<string>, headerIdx: number, re: RegExp): number {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (!/^[ \t]/.test(line)) break;
    if (re.test(line)) return i;
  }
  return -1;
}
