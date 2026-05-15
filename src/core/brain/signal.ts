/**
 * Signal (`sig-*.md`) parser and writer.
 *
 * Signals are the immutable raw input to the dream algorithm. Each one
 * is a single Markdown file under `Brain/inbox/` (or `processed/` once
 * folded into a preference). The frontmatter shape is fully specified
 * in design doc §5.2 and mirrored on the `BrainSignal` interface in
 * `./types.ts`.
 *
 * This module exposes a parser + writer pair:
 *
 *   - `parseSignal(path)` validates required fields, returns a frozen
 *     `BrainSignal` (mutation throws). Missing required fields surface
 *     as `Error('signal missing field: <name>')` so the caller knows
 *     exactly which field is wrong.
 *
 *   - `writeSignal(vault, input, options)` allocates a free slug under
 *     `Brain/inbox/`, writes the file atomically through `fs-atomic`,
 *     and returns the resulting path + id. Slug collisions are resolved
 *     by `allocateSlug` (suffixes `-2`, `-3`, …).
 *
 * The body shape ("## Raw" section with the optional `raw` text) is
 * deterministic so two writes with identical input produce byte-for-byte
 * identical files — a property exercised by the roundtrip test.
 */

import type { FrontmatterMap } from "../types.ts";
import { writeFrontmatterAtomic, parseFrontmatter } from "../vault.ts";
import { allocateSlug, brainDirs, validateIsoDate } from "./paths.ts";
import {
  BRAIN_SIGNAL_SIGN,
  type BrainSignal,
  type BrainSignalSign,
} from "./types.ts";

/** Filename prefix without the trailing dash, e.g. `sig-2026-05-14`. */
function signalPrefix(date: string): string {
  return `sig-${validateIsoDate(date)}`;
}

/**
 * Input contract for {@link writeSignal}. Mirrors the design-doc §5.2
 * required/optional split. `slug` is the slug stem only (no `sig-` or
 * date prefix); the writer composes the final filename.
 *
 * `created_at` is included so callers can write deterministic
 * fixtures; production callers pass `new Date().toISOString()`.
 */
export interface WriteSignalInput {
  readonly topic: string;
  readonly signal: BrainSignalSign;
  readonly agent: string;
  readonly principle: string;
  readonly created_at: string;
  /** Calendar date (UTC) used in the filename and the `created_at`. */
  readonly date: string;
  /** Slug stem; collision is resolved by `allocateSlug` suffixes. */
  readonly slug: string;
  readonly scope?: string;
  readonly source?: ReadonlyArray<string>;
  /** Free-form body that follows the frontmatter under "## Raw". */
  readonly raw?: string;
  /** Optional extra tags merged after the canonical set. */
  readonly extraTags?: ReadonlyArray<string>;
}

export interface WriteSignalOptions {
  /** Maximum collision suffixes to try; defaults to allocateSlug's cap. */
  readonly maxSlugAttempts?: number;
}

export interface WriteSignalResult {
  readonly path: string;
  readonly id: string;
}

const REQUIRED_INPUT_FIELDS: ReadonlyArray<keyof WriteSignalInput> = [
  "topic",
  "signal",
  "agent",
  "principle",
  "created_at",
  "date",
  "slug",
];

/**
 * Write a signal atomically. Funnels through {@link allocateSlug} so a
 * second call with the same slug receives a `-2` suffix automatically.
 *
 * The body is the canonical "## Raw" section. When `raw` is omitted, the
 * section is rendered with an `_(not provided)_` placeholder so every
 * signal has the same heading structure — consistent with the Pay
 * Memory receipt style.
 */
export function writeSignal(
  vault: string,
  input: WriteSignalInput,
  options: WriteSignalOptions = {},
): WriteSignalResult {
  for (const field of REQUIRED_INPUT_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new Error(`signal missing field: ${String(field)}`);
    }
  }
  if (
    input.signal !== BRAIN_SIGNAL_SIGN.positive &&
    input.signal !== BRAIN_SIGNAL_SIGN.negative
  ) {
    throw new Error(
      `signal field 'signal' must be 'positive' or 'negative'; got ${JSON.stringify(input.signal)}`,
    );
  }

  const dirs = brainDirs(vault);
  const allocated = allocateSlug({
    vault,
    targetDir: dirs.inbox,
    prefix: signalPrefix(input.date),
    slug: input.slug,
    maxAttempts: options.maxSlugAttempts,
  });

  // The on-disk id always equals the filename basename, including any
  // `-2`/`-3` collision suffix. We surface that as the canonical id and
  // duplicate it inside the frontmatter so manual `mv` keeps the link.
  const id = `${signalPrefix(input.date)}-${allocated.slug}`;

  const tags = composeSignalTags(input);
  const metadata: FrontmatterMap = {
    kind: "brain-signal",
    id,
    created_at: input.created_at,
    tags: [...tags],
    topic: input.topic.trim(),
    signal: input.signal,
    agent: input.agent.trim(),
    principle: input.principle.trim(),
  };
  // Optional fields: keep the file lean. The parser tolerates absence and
  // returns `undefined` on the interface — no `_(not provided)_` for
  // metadata.
  if (input.scope && input.scope.trim()) {
    metadata["scope"] = input.scope.trim();
  }
  if (input.source && input.source.length > 0) {
    metadata["source"] = [...input.source];
  }

  const body = renderSignalBody(input);
  writeFrontmatterAtomic(allocated.path, metadata, body, {
    overwrite: false,
    existsErrorKind: "signal",
    vaultForRelativePath: vault,
  });

  return { path: allocated.path, id };
}

/**
 * Read a signal file from disk and validate its frontmatter against the
 * `BrainSignal` contract. Returns a frozen object — the parsed shape is
 * immutable at runtime to match the `readonly` declarations on the type.
 *
 * Throws `Error('signal missing field: <name>')` for any absent required
 * field. `signal` value mismatch (anything outside positive/negative)
 * surfaces as a separate, distinguishable error.
 */
export function parseSignal(path: string): BrainSignal {
  const [meta, body] = parseFrontmatter(path);

  requireField(meta, "kind");
  if (meta["kind"] !== "brain-signal") {
    throw new Error(
      `signal kind must be 'brain-signal'; got ${JSON.stringify(meta["kind"])} (${path})`,
    );
  }
  const id = requireString(meta, "id");
  const created_at = requireString(meta, "created_at");
  const tags = requireStringArray(meta, "tags");
  const topic = requireString(meta, "topic");
  const signalValue = requireString(meta, "signal");
  if (
    signalValue !== BRAIN_SIGNAL_SIGN.positive &&
    signalValue !== BRAIN_SIGNAL_SIGN.negative
  ) {
    throw new Error(
      `signal field 'signal' must be 'positive' or 'negative'; got ${JSON.stringify(signalValue)} (${path})`,
    );
  }
  const agent = requireString(meta, "agent");
  const principle = requireString(meta, "principle");

  // Optional fields. `scope` is a plain scalar; `source` is an inline
  // array of wikilink strings. `raw` is extracted from the body if the
  // canonical heading is present.
  let scope: string | undefined;
  if (meta["scope"] !== undefined) {
    const s = meta["scope"];
    if (typeof s !== "string") {
      throw new Error(`signal field 'scope' must be a string (${path})`);
    }
    if (s.trim()) scope = s.trim();
  }

  let source: ReadonlyArray<string> | undefined;
  if (meta["source"] !== undefined) {
    if (!Array.isArray(meta["source"])) {
      throw new Error(`signal field 'source' must be an array (${path})`);
    }
    for (const item of meta["source"]) {
      if (typeof item !== "string") {
        throw new Error(
          `signal field 'source' must be an array of strings (${path})`,
        );
      }
    }
    source = [...(meta["source"] as ReadonlyArray<string>)];
  }

  const raw = extractRawSection(body);

  const result: BrainSignal = {
    kind: "brain-signal",
    id,
    created_at,
    tags,
    topic,
    signal: signalValue as BrainSignalSign,
    agent,
    principle,
    ...(scope !== undefined ? { scope } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(raw !== undefined ? { raw } : {}),
  };
  return Object.freeze(result);
}

// ----- Helpers --------------------------------------------------------------

/**
 * Build the canonical tag set: `brain`, `brain/signal`, plus per-topic
 * and (optionally) per-scope tags. Any `extraTags` supplied by the
 * caller are appended after dedup. We preserve insertion order so the
 * file is byte-stable across writes with identical input.
 */
function composeSignalTags(input: WriteSignalInput): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string): void => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  push("brain");
  push("brain/signal");
  push(`brain/topic/${input.topic.trim()}`);
  if (input.scope && input.scope.trim()) {
    push(`brain/scope/${input.scope.trim()}`);
  }
  for (const t of input.extraTags ?? []) {
    if (t.trim()) push(t.trim());
  }
  return out;
}

/**
 * Render the body. The "## Raw" section is always present so the file
 * shape is identical regardless of whether `raw` was provided —
 * deterministic write is part of the contract.
 */
function renderSignalBody(input: WriteSignalInput): string {
  const lines: string[] = ["## Raw", ""];
  if (input.raw && input.raw.trim()) {
    // Normalise line endings and trailing whitespace so two callers
    // passing semantically-equal text produce byte-identical output.
    lines.push(input.raw.replace(/\r\n?/g, "\n").replace(/\s+$/g, ""));
  } else {
    lines.push("_(not provided)_");
  }
  return lines.join("\n");
}

function extractRawSection(body: string): string | undefined {
  // The signal body is exactly one "## Raw" section. Capture everything
  // after it until EOF (no further headings in this schema). Returning
  // `undefined` for the placeholder keeps the type shape clean.
  //
  // No `m` flag: with multiline mode `$` matches end-of-line, which
  // truncates the lazy `[\s\S]*?` capture at the first newline instead
  // of running to EOF. We anchor the heading at start-of-string with an
  // explicit `(?:^|\n)` and let `$` mean end-of-string only.
  const match = /(?:^|\n)##\s+Raw\s*\n+([\s\S]*?)\s*$/.exec(body);
  if (!match) return undefined;
  const raw = match[1]?.trim();
  if (!raw || raw === "_(not provided)_") return undefined;
  return raw;
}

function requireField(meta: Record<string, unknown>, field: string): void {
  if (!(field in meta) || meta[field] === undefined || meta[field] === null) {
    throw new Error(`signal missing field: ${field}`);
  }
  if (typeof meta[field] === "string" && (meta[field] as string).trim() === "") {
    throw new Error(`signal missing field: ${field}`);
  }
}

function requireString(meta: Record<string, unknown>, field: string): string {
  requireField(meta, field);
  const v = meta[field];
  if (typeof v !== "string") {
    throw new Error(`signal field '${field}' must be a string`);
  }
  return v;
}

function requireStringArray(
  meta: Record<string, unknown>,
  field: string,
): ReadonlyArray<string> {
  requireField(meta, field);
  const v = meta[field];
  if (!Array.isArray(v)) {
    throw new Error(`signal field '${field}' must be an array`);
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new Error(
        `signal field '${field}' must be an array of strings`,
      );
    }
  }
  return [...(v as ReadonlyArray<string>)];
}
