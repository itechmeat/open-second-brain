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
import { sanitiseTextField } from "../redactor.ts";
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
  // Sanitise free-form fields BEFORE the required-field check so an
  // input that is purely C0-control characters lands in the
  // "missing-field" branch rather than smuggling itself into YAML.
  // `topic`, `slug`, `agent`, `date`, `signal` are constrained by
  // their own validators (slug rules / ISO date / enum) and are
  // already rejected if they carry junk — don't double-process them.
  const sanitised = sanitiseSignalInput(input);

  for (const field of REQUIRED_INPUT_FIELDS) {
    const value = sanitised[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new Error(`signal missing field: ${String(field)}`);
    }
  }
  if (
    sanitised.signal !== BRAIN_SIGNAL_SIGN.positive &&
    sanitised.signal !== BRAIN_SIGNAL_SIGN.negative
  ) {
    throw new Error(
      `signal field 'signal' must be 'positive' or 'negative'; got ${JSON.stringify(sanitised.signal)}`,
    );
  }

  const dirs = brainDirs(vault);
  const allocated = allocateSlug({
    vault,
    targetDir: dirs.inbox,
    prefix: signalPrefix(sanitised.date),
    slug: sanitised.slug,
    maxAttempts: options.maxSlugAttempts,
  });

  // The on-disk id always equals the filename basename, including any
  // `-2`/`-3` collision suffix. We surface that as the canonical id and
  // duplicate it inside the frontmatter so manual `mv` keeps the link.
  const id = `${signalPrefix(sanitised.date)}-${allocated.slug}`;

  const tags = composeSignalTags(sanitised);
  const metadata: FrontmatterMap = {
    kind: "brain-signal",
    id,
    created_at: sanitised.created_at,
    tags: [...tags],
    topic: sanitised.topic.trim(),
    signal: sanitised.signal,
    agent: sanitised.agent.trim(),
    principle: sanitised.principle.trim(),
  };
  // Optional fields: keep the file lean. The parser tolerates absence and
  // returns `undefined` on the interface — no `_(not provided)_` for
  // metadata.
  if (sanitised.scope && sanitised.scope.trim()) {
    metadata["scope"] = sanitised.scope.trim();
  }
  if (sanitised.source && sanitised.source.length > 0) {
    metadata["source"] = [...sanitised.source];
  }

  const body = renderSignalBody(sanitised);
  writeFrontmatterAtomic(allocated.path, metadata, body, {
    overwrite: false,
    existsErrorKind: "signal",
    vaultForRelativePath: vault,
  });

  return { path: allocated.path, id };
}

// ----- Sanitisation --------------------------------------------------------

/**
 * Hard caps for free-form fields. `principle` is rendered as a
 * single-line YAML scalar in frontmatter; `note`/`raw` shapes can
 * carry paragraphs. `scope` is a short slug-adjacent tag.
 */
const PRINCIPLE_MAX_LEN = 512;
const SCOPE_MAX_LEN = 128;
const RAW_MAX_LEN = 4096;
const SOURCE_ITEM_MAX_LEN = 512;

function sanitiseSignalInput(input: WriteSignalInput): WriteSignalInput {
  const principle = sanitiseTextField(input.principle, {
    maxLen: PRINCIPLE_MAX_LEN,
    singleLine: true,
  });
  const scope = input.scope
    ? sanitiseTextField(input.scope, { maxLen: SCOPE_MAX_LEN, singleLine: true })
    : input.scope;
  const raw = input.raw
    ? sanitiseTextField(input.raw, { maxLen: RAW_MAX_LEN })
    : input.raw;
  const source = input.source
    ? input.source.map((s) =>
        sanitiseTextField(s, { maxLen: SOURCE_ITEM_MAX_LEN, singleLine: true }),
      )
    : input.source;
  return {
    ...input,
    principle,
    ...(scope !== undefined ? { scope } : {}),
    ...(raw !== undefined ? { raw } : {}),
    ...(source !== undefined ? { source } : {}),
  };
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
 * Render the body. The "## Raw" section is emitted **only** when the
 * caller actually provided a verbatim quote. A signal recorded without
 * `raw` (the common case for tests and corner runs) used to ship a
 * `_(not provided)_` placeholder; v0.10.1 drops that placeholder so
 * the file is honest about its contents — no body at all when there is
 * none. Parsers stay tolerant of both shapes (old placeholder and new
 * absent section).
 */
function renderSignalBody(input: WriteSignalInput): string {
  if (!input.raw || !input.raw.trim()) return "";
  // Normalise line endings and trailing whitespace so two callers
  // passing semantically-equal text produce byte-identical output.
  const body = input.raw.replace(/\r\n?/g, "\n").replace(/\s+$/g, "");
  return ["## Raw", "", body].join("\n");
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
