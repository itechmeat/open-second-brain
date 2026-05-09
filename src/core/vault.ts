/**
 * Vault operations: frontmatter parse/write, slugify, wikilink extraction,
 * Markdown page listing.
 *
 * Mirrors `src/open_second_brain/vault.py`. Designed dependency-free; the small
 * YAML-like emitter handles only the scalar/inline-array shapes that round-trip
 * through Obsidian and the simple parser.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { FrontmatterMap, FrontmatterValue, VaultPage } from "./types.ts";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const KEY_VALUE_RE = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/;
const PLAIN_SCALAR_RE = /^[A-Za-z0-9_./-](?:[A-Za-z0-9_./ -]*[A-Za-z0-9_./-])?$/;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`]+`/g;
const SLUG_INVALID_RE = /[^a-z0-9]+/g;
const SLUG_MAX_LEN = 64;

const MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".tiff", ".avif",
  ".mp4", ".webm", ".ogv", ".mov", ".mkv", ".avi",
  ".mp3", ".wav", ".ogg", ".flac", ".m4a",
  ".pdf",
]);

const DEFAULT_SKIP_DIRS = [".git", ".obsidian", ".trash", ".stversions"] as const;
const DEFAULT_SKIP_FILES = ["index.md", "log.md"] as const;

/**
 * Parse YAML-like frontmatter from a Markdown file. Returns `[metadata, body]`.
 * Only simple `key: value` lines are recognized — values are returned as strings,
 * with surrounding quotes stripped. Inline arrays `[a, b]` are parsed into arrays
 * of strings. Lines that don't match are silently skipped.
 */
export function parseFrontmatter(path: string): readonly [FrontmatterMap, string] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [{}, ""];
  }

  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return [{}, text.trim()];
  }

  const fmBlock = match[1]!;
  const body = text.slice(match[0].length).trim();
  const metadata: FrontmatterMap = {};

  for (const rawLine of fmBlock.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = KEY_VALUE_RE.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2]!.trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      metadata[key] = inner ? splitInlineArray(inner) : [];
      continue;
    }
    metadata[key] = stripQuotes(value);
  }

  return [metadata, body];
}

/**
 * Write a Markdown file with YAML-like frontmatter. Lists are serialized as
 * inline arrays. Scalars that would break the simple parser are quoted and
 * standard control chars are escaped.
 */
export function writeFrontmatter(path: string, metadata: FrontmatterMap, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(metadata)) {
    lines.push(`${key}: ${formatYamlValue(value)}`);
  }
  lines.push("---");
  if (body) {
    lines.push("");
    lines.push(body);
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

/**
 * Convert a free-form title to a URL-safe slug. Lowercase, alphanumeric
 * runs joined by `-`, trimmed to 64 chars. Empty / non-ASCII inputs fall
 * back to "note".
 */
export function slugify(value: string): string {
  const lowered = value.trim().toLowerCase();
  let slug = lowered.replace(SLUG_INVALID_RE, "-").replace(/^-+|-+$/g, "");
  if (!slug) slug = "note";
  slug = slug.slice(0, SLUG_MAX_LEN).replace(/-+$/, "");
  return slug || "note";
}

/**
 * Extract unique `[[wikilink]]` targets from Markdown content. Skips media
 * file extensions and links inside fenced or inline code blocks.
 */
export function extractWikilinks(content: string): string[] {
  const masked = content.replace(CODE_BLOCK_RE, " ");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const target = m[1]!;
    const dot = target.lastIndexOf(".");
    const ext = dot >= 0 ? target.slice(dot).toLowerCase() : "";
    if (MEDIA_EXTENSIONS.has(ext)) continue;
    if (!seen.has(target)) {
      seen.add(target);
      result.push(target);
    }
  }
  return result;
}

export interface ListVaultPagesOptions {
  readonly skipDirs?: ReadonlyArray<string>;
  readonly skipFiles?: ReadonlyArray<string>;
}

/**
 * Walk the vault and return every Markdown page with parsed frontmatter
 * metadata. Pages are sorted by title (case-insensitive). Excluded dirs/files
 * mirror the Python defaults.
 */
export function listVaultPages(vaultDir: string, opts: ListVaultPagesOptions = {}): VaultPage[] {
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);
  const skipFiles = new Set((opts.skipFiles ?? DEFAULT_SKIP_FILES).map((f) => f.toLowerCase()));

  const pages: VaultPage[] = [];
  walk(vaultDir, vaultDir, skipDirs, skipFiles, pages);
  pages.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  return pages;
}

function walk(
  root: string,
  dir: string,
  skipDirs: Set<string>,
  skipFiles: Set<string>,
  out: VaultPage[],
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walk(root, full, skipDirs, skipFiles, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    if (skipFiles.has(entry.name.toLowerCase())) continue;
    const rel = relative(root, full);
    const parts = rel.split(/[\\/]/);
    if (parts.some((p) => skipDirs.has(p))) continue;
    let meta: FrontmatterMap;
    try {
      [meta] = parseFrontmatter(full);
    } catch {
      continue;
    }
    const titleVal = meta["title"];
    const title = typeof titleVal === "string" && titleVal ? titleVal : stem(entry.name);
    out.push({ title, path: full, metadata: meta });
  }
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Split the body of an inline YAML array on commas, but only on commas that
 * appear outside quoted runs. Without this, `[plain, "needs, comma"]` would
 * be split into three tokens (`plain`, `"needs`, `comma"`) — breaking the
 * round-trip with `formatYamlValue`, which already quotes any element that
 * contains a comma.
 */
function splitInlineArray(inner: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar: '"' | "'" | "" = "";

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (inQuote) {
      current += ch;
      if (ch === quoteChar && inner[i - 1] !== "\\") {
        inQuote = false;
        quoteChar = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      out.push(stripQuotes(current.trim()));
      current = "";
      continue;
    }
    current += ch;
  }
  // Trailing element (no trailing comma case).
  if (current.trim() !== "") {
    out.push(stripQuotes(current.trim()));
  }
  return out;
}

function formatYamlScalar(value: FrontmatterValue): string {
  const text = typeof value === "string" ? value : String(value);
  if (
    text &&
    PLAIN_SCALAR_RE.test(text) &&
    !text.includes(": ") &&
    !text.includes(" #")
  ) {
    return text;
  }
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function formatYamlValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => formatYamlScalar(item)).join(", ") + "]";
  }
  return formatYamlScalar(value);
}

/** Re-exported for callers that want the same exclusion lists in JS plugins. */
export const EXCLUDED_DIRS = DEFAULT_SKIP_DIRS;
export const EXCLUDED_FILES = DEFAULT_SKIP_FILES;

export function _internalIsDir(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
