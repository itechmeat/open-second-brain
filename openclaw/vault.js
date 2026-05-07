/**
 * Pure JavaScript vault operations for Open Second Brain.
 *
 * All filesystem operations use `node:fs/promises` and `node:path`.
 * No native process module, no subprocess calls — passes the OpenClaw security scanner.
 *
 * Logic mirrors the Python implementation in `src/open_second_brain/vault.py`.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative, sep, extname, basename, dirname, resolve, posix } from "node:path";
import { existsSync } from "node:fs";

// ── Constants ──────────────────────────────────────────────────────────────

export const EXCLUDED_DIRS = new Set([
  ".git",
  ".obsidian",
  ".trash",
  ".stversions",
  "node_modules",
  "__pycache__",
  ".venv",
  "build",
  "dist",
  ".claude-plugin",
  ".codex-plugin",
]);

export const EXCLUDED_FILES = new Set([".DS_Store", ".gitkeep"]);

const SKIP_FILE_NAMES = new Set(["index.md", "log.md"]);

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const KEY_VALUE_RE = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/;
const PLAIN_SCALAR_RE = /^[A-Za-z0-9_./-](?:[A-Za-z0-9_./ -]*[A-Za-z0-9_./-])?$/;

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`]+`/g;

const MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".tiff", ".avif",
  ".mp4", ".webm", ".ogv", ".mov", ".mkv", ".avi",
  ".mp3", ".wav", ".ogg", ".flac", ".m4a",
  ".pdf",
]);

const SLUG_INVALID_RE = /[^a-z0-9]+/g;
const SLUG_MAX_LEN = 64;

// ── Frontmatter ────────────────────────────────────────────────────────────

/**
 * Parse YAML-like frontmatter from markdown content.
 * Returns { frontmatter: {...}, body: "..." } or null if no frontmatter found.
 */
export function parseFrontmatter(content) {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return null;
  }

  const fmBlock = match[1];
  const body = content.slice(match[0].length).trim();
  const frontmatter = {};

  for (const rawLine of fmBlock.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const kv = KEY_VALUE_RE.exec(line);
    if (kv) {
      const key = kv[1];
      let value = kv[2].trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Parse inline YAML arrays: [a, b, c]
      if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim();
        if (inner) {
          frontmatter[key] = inner.split(",").map((s) => {
            s = s.trim();
            if (
              (s.startsWith('"') && s.endsWith('"')) ||
              (s.startsWith("'") && s.endsWith("'"))
            ) {
              s = s.slice(1, -1);
            }
            return s;
          });
        } else {
          frontmatter[key] = [];
        }
      } else {
        frontmatter[key] = value;
      }
    }
  }

  return { frontmatter, body };
}

/**
 * Format a YAML scalar value, quoting if necessary.
 */
function formatYamlScalar(value) {
  const text = String(value);
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

/**
 * Format a YAML value (scalar or array).
 */
function formatYamlValue(value) {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => formatYamlScalar(item)).join(", ") + "]";
  }
  return formatYamlScalar(value);
}

/**
 * Write a markdown file with YAML frontmatter and body.
 * Creates parent directories if needed.
 */
export async function writeFrontmatter(filePath, frontmatter, body) {
  await mkdir(dirname(filePath), { recursive: true });

  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${formatYamlValue(value)}`);
  }
  lines.push("---");

  if (body) {
    lines.push("");
    lines.push(body);
  }

  await writeFile(filePath, lines.join("\n") + "\n", "utf8");
}

// ── Slugify ────────────────────────────────────────────────────────────────

/**
 * Convert title to URL-safe slug.
 * Lowercase, replace non-alphanumeric with dashes, trim to max length.
 */
export function slugify(title) {
  const lowered = title.trim().toLowerCase();
  let slug = lowered.replace(SLUG_INVALID_RE, "-").replace(/^-+|-+$/g, "");
  if (!slug) slug = "note";
  slug = slug.slice(0, SLUG_MAX_LEN).replace(/-+$/, "");
  return slug || "note";
}

// ── Wikilinks ──────────────────────────────────────────────────────────────

/**
 * Extract [[wikilinks]] from markdown content.
 * Skips links inside code blocks and media file targets.
 * Returns unique targets in order of appearance.
 */
export function extractWikilinks(content) {
  // Mask code blocks
  const masked = content.replace(CODE_BLOCK_RE, " ");

  const seen = new Set();
  const result = [];

  // Reset the global regex
  WIKILINK_RE.lastIndex = 0;
  let match;
  while ((match = WIKILINK_RE.exec(masked)) !== null) {
    const target = match[1];
    const ext = extname(target).toLowerCase();
    if (MEDIA_EXTENSIONS.has(ext)) continue;
    if (!seen.has(target)) {
      seen.add(target);
      result.push(target);
    }
  }

  return result;
}

// ── Vault page listing ─────────────────────────────────────────────────────

/**
 * Recursively list all markdown pages in a vault directory.
 * Returns [{ title, path, relativePath, metadata }].
 * Sorted alphabetically by title (case-insensitive).
 */
export async function listVaultPages(vaultPath, pattern = null, limit = 50) {
  const pages = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (EXCLUDED_FILES.has(entry.name)) continue;
        if (SKIP_FILE_NAMES.has(entry.name.toLowerCase())) continue;

        const fullPath = join(dir, entry.name);
        const relPath = relative(vaultPath, fullPath);
        // Skip if any directory component is excluded
        const parts = relPath.split(sep);
        if (parts.some((p) => EXCLUDED_DIRS.has(p))) continue;

        let content;
        try {
          content = await readFile(fullPath, "utf8");
        } catch {
          continue;
        }

        const parsed = parseFrontmatter(content);
        const metadata = parsed ? parsed.frontmatter : {};
        const title =
          metadata && metadata.title ? metadata.title : basename(entry.name, ".md");

        pages.push({
          title,
          path: fullPath,
          relativePath: relPath,
          metadata: metadata || {},
        });
      }
    }
  }

  await walk(vaultPath);

  // Sort by title case-insensitive
  pages.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  // Apply pattern filter
  let matched = pages;
  if (pattern) {
    const needle = pattern.toLowerCase();
    matched = pages.filter((p) => p.title.toLowerCase().includes(needle));
  }

  // Apply limit
  if (limit && matched.length > limit) {
    matched = matched.slice(0, limit);
  }

  return { allPages: pages, matched };
}
