/**
 * Shared helpers for JSON memory-store backends (Ingestion & Import Robustness
 * suite, t_ac9d2588).
 *
 * mem0 and the generic catch-all both import ONE JSON export file that holds
 * MANY memory records, unlike the Claude Code backend's one-file-one-entry
 * layout. These helpers centralize the two concerns those backends share:
 * pulling the record array out of an export (a top-level array, or an object
 * keyed by a known collection field), and coercing one record into the
 * feedback/skip {@link MemorySourceParse} the import core already understands.
 *
 * Language-agnostic: field selection is structural (JSON keys), and no
 * natural-language vocabulary is inspected. A record with no usable text is
 * skipped with a reason, never fabricated.
 */

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

import { renderPreferenceFromMemory, slugifyMemoryName } from "../claude-memory-render.ts";
import type { MemoryRenderInput, MemorySourceBackend, MemorySourceParse } from "./types.ts";

/** Cap for a description synthesized from a record's body. */
const DERIVED_DESCRIPTION_MAX = 200;

/**
 * Pull the record array out of a JSON export. Accepts a top-level array or an
 * object whose value at one of `collectionKeys` is an array. Returns the raw
 * items (each still `unknown` - the backend coerces per record) or a structural
 * error string that becomes a single skip entry.
 */
export function readJsonItems(
  text: string,
  collectionKeys: readonly string[],
): { items: readonly unknown[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "not valid JSON" };
  }
  if (Array.isArray(parsed)) return { items: parsed };
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of collectionKeys) {
      const value = obj[key];
      if (Array.isArray(value)) return { items: value };
    }
  }
  return {
    error: `expected a JSON array or an object with an array at one of: ${collectionKeys.join(", ")}`,
  };
}

/** Trimmed string value, or "" for any non-string. */
export function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** First non-empty trimmed string found at `keys` in `record`. */
export function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const s = asTrimmedString(record[key]);
    if (s) return s;
  }
  return "";
}

/** A record's `metadata.<field>` when metadata is an object, else "". */
export function metadataString(record: Record<string, unknown>, field: string): string {
  const meta = record["metadata"];
  if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
    return asTrimmedString((meta as Record<string, unknown>)[field]);
  }
  return "";
}

/** First non-empty line of `body`, capped - a readable description fallback. */
export function deriveDescription(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const base = line ?? body.trim();
  return base.length > DERIVED_DESCRIPTION_MAX
    ? `${base.slice(0, DERIVED_DESCRIPTION_MAX - 1).trimEnd()}…`
    : base;
}

/**
 * Build a feedback (or skip) parse from the three fields every source reduces
 * to. Body is required; a missing name or description falls back to a
 * body-derived value so a minimal record (mem0's `{memory: "..."}`) still
 * imports. The sha256 is over the trimmed body, matching the Claude parser.
 */
export function buildFeedbackEntry(input: {
  name: string;
  description: string;
  body: string;
}): MemorySourceParse {
  const body = input.body.trim();
  if (!body) return { kind: "skip", skipReason: "record has no memory text" };
  const name = input.name.trim() || deriveDescription(body);
  if (!name) return { kind: "skip", skipReason: "record has no derivable name" };
  const description = input.description.trim() || deriveDescription(body);
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  return { kind: "feedback", name, description, body, bodySha256 };
}

/** Config for a JSON memory-store backend built by {@link makeJsonBackend}. */
export interface JsonBackendConfig {
  /** Stable selector for the `memory_backend` config key / `--from`. */
  readonly id: string;
  /** Human-readable name for messages. */
  readonly label: string;
  /** Keys under which the export nests its record array. */
  readonly collectionKeys: readonly string[];
  /** Record keys tried in order for the memory body text. */
  readonly bodyKeys: readonly string[];
  /** Prefix for a whole-file parse error (e.g. `mem0 export`). */
  readonly errorPrefix: string;
  /** Noun for a per-record skip (e.g. `mem0 record`). */
  readonly recordNoun: string;
  /** Message thrown when no `--memory` was given (no default location). */
  readonly noDefaultDirMessage: string;
}

/**
 * Build a JSON memory-store backend from a small config. mem0 and the generic
 * catch-all differ only in their id/label, which keys hold the record array and
 * the body text, and their diagnostic wording - everything else (name/
 * description selection, `.json` discovery, the shared Claude render/slug, and
 * the no-default-location guard) is identical, so it lives here once.
 */
export function makeJsonBackend(cfg: JsonBackendConfig): MemorySourceBackend {
  return Object.freeze({
    id: cfg.id,
    label: cfg.label,
    discoverMemoryDir(_vault: string): string {
      throw new Error(cfg.noDefaultDirMessage);
    },
    discoverMemoryFiles(dir: string): string[] {
      return readdirSync(dir)
        .toSorted()
        .filter((name) => name.toLowerCase().endsWith(".json"));
    },
    parseMemoryEntries(text: string): MemorySourceParse[] {
      const res = readJsonItems(text, cfg.collectionKeys);
      if ("error" in res) return [{ kind: "skip", skipReason: `${cfg.errorPrefix} ${res.error}` }];
      return res.items.map((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          return { kind: "skip", skipReason: `${cfg.recordNoun} is not an object` };
        }
        const rec = item as Record<string, unknown>;
        return buildFeedbackEntry({
          name: firstString(rec, ["name", "title", "id"]),
          description: firstString(rec, ["description"]) || metadataString(rec, "description"),
          body: firstString(rec, cfg.bodyKeys),
        });
      });
    },
    renderPreference(input: MemoryRenderInput): string {
      return renderPreferenceFromMemory(input);
    },
    slugifyName(name: string): string {
      return slugifyMemoryName(name);
    },
  });
}
