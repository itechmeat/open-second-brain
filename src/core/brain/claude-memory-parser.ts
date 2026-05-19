import { createHash } from "node:crypto";

export type ClaudeMemoryParseResult =
  | {
      readonly kind: "feedback";
      readonly name: string;
      readonly description: string;
      readonly body: string;
      readonly bodySha256: string;
    }
  | {
      readonly kind: "skip";
      readonly skipReason: string;
    };

const FM_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/**
 * Minimal two-level YAML parser for Claude MEMORY.md frontmatter.
 *
 * Handles:
 *   - `key: scalar value` at the top level
 *   - `key:` with an indented block of `  subkey: scalar` one level deep
 *   - blank lines and `# comments` are ignored
 *
 * Returns a plain object whose nested blocks are plain objects. Does not
 * use an external YAML library — consistent with the project's design
 * principle of keeping the core dependency-free.
 */
function parseFrontmatterBlock(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i]!;
    i++;

    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;

    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();

    if (rest === "" || rest === null) {
      // Possible block header — collect indented children.
      const child: Record<string, string> = {};
      const indent = detectIndent(lines, i);
      if (indent > 0) {
        while (i < lines.length) {
          const innerRaw = lines[i]!;
          const innerTrimmed = innerRaw.trim();
          if (!innerTrimmed || innerTrimmed.startsWith("#")) {
            i++;
            continue;
          }
          // Stop if this line is at top-level indentation (indent 0) or
          // has less indentation than the detected block indent.
          const lineIndent = innerRaw.length - innerRaw.trimStart().length;
          if (lineIndent < indent) break;

          i++;
          const innerColon = innerTrimmed.indexOf(":");
          if (innerColon === -1) continue;
          const innerKey = innerTrimmed.slice(0, innerColon).trim();
          const innerVal = innerTrimmed.slice(innerColon + 1).trim();
          child[innerKey] = stripYamlQuotes(innerVal);
        }
      }
      out[key] = child;
    } else {
      out[key] = stripYamlQuotes(rest);
    }
  }

  return out;
}

function detectIndent(lines: string[], from: number): number {
  for (let j = from; j < lines.length; j++) {
    const raw = lines[j]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const spaces = raw.length - raw.trimStart().length;
    return spaces;
  }
  return 0;
}

function stripYamlQuotes(val: string): string {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}

export function parseClaudeMemoryFile(text: string): ClaudeMemoryParseResult {
  const m = text.match(FM_RE);
  if (!m) {
    return { kind: "skip", skipReason: "missing or malformed frontmatter" };
  }
  let fm: Record<string, unknown>;
  try {
    fm = parseFrontmatterBlock(m[1]!);
  } catch {
    return { kind: "skip", skipReason: "frontmatter is not valid YAML" };
  }
  const name = typeof fm["name"] === "string" ? fm["name"].trim() : "";
  const description = typeof fm["description"] === "string" ? fm["description"].trim() : "";
  // Claude Code Memory uses two frontmatter shapes for the `type` field:
  // older entries put it at the top level (`type: feedback`), newer ones
  // nest it under `metadata: { type: feedback }`. Accept either — the
  // semantics are identical and 12 of 17 real memory files this code
  // has seen use the older shape.
  const meta = (fm["metadata"] as Record<string, unknown> | undefined) ?? {};
  const nestedType = typeof meta["type"] === "string" ? meta["type"] : "";
  const topLevelType = typeof fm["type"] === "string" ? fm["type"] : "";
  const type = nestedType || topLevelType;
  if (type !== "feedback") {
    return { kind: "skip", skipReason: `type=${type || "<missing>"}; only feedback maps to Brain` };
  }
  if (!name || !description) {
    return { kind: "skip", skipReason: "feedback entry missing required name/description" };
  }
  const body = m[2]!.trim();
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  return { kind: "feedback", name, description, body, bodySha256 };
}
