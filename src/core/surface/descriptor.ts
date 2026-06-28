/**
 * Surface descriptor kernel (Agent Surface Suite).
 *
 * One uniform record describes anything an agent can discover at
 * runtime - MCP tools and repository skills alike. The two-pass tool
 * catalog, the skill tools, skill auto-attach, and the tool-surface
 * profiles all consume this shape, so name/description/group semantics
 * cannot drift between features.
 */

export type SurfaceKind = "tool" | "skill";

export interface SurfaceDescriptor {
  readonly kind: SurfaceKind;
  /** Stable identifier - MCP tool name or skill directory name. */
  readonly name: string;
  /** One-line description (first non-empty line of the source text). */
  readonly description: string;
  /** Coarse grouping: tool-name prefix family, or "skill". */
  readonly group: string;
  readonly tags: ReadonlyArray<string>;
}

/** Minimal structural slice of an MCP ToolDefinition we depend on. */
export interface DescribableTool {
  readonly name: string;
  readonly description: string;
}

/** Minimal structural slice of a discovered skill entry. */
export interface DescribableSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  /** Flattened trigger keywords from frontmatter `triggers` field. */
  readonly triggers?: string;
}

/** First non-empty line, trimmed. Empty input stays empty. */
export function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

const GROUP_PREFIXES: ReadonlyArray<string> = Object.freeze(["brain", "schema"]);

/**
 * Derive a coarse group from a tool name. Prefix families map to their
 * prefix ("brain_*" -> "brain"); everything else is "core". The special
 * "second_brain_*" diagnostics deliberately land in "core" - they are
 * server-level, not Brain-domain.
 */
export function surfaceGroup(toolName: string): string {
  if (toolName.startsWith("second_brain_")) return "core";
  const head = toolName.split("_", 1)[0] ?? "";
  return GROUP_PREFIXES.includes(head) ? head : "core";
}

function freezeDescriptor(d: SurfaceDescriptor): SurfaceDescriptor {
  return Object.freeze({ ...d, tags: Object.freeze([...d.tags]) });
}

/** Build sorted, frozen descriptors for a tool table. */
export function toolDescriptors(
  tools: ReadonlyArray<DescribableTool>,
): ReadonlyArray<SurfaceDescriptor> {
  const out = tools.map((t) =>
    freezeDescriptor({
      kind: "tool",
      name: t.name,
      description: firstLine(t.description),
      group: surfaceGroup(t.name),
      tags: [],
    }),
  );
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze(out);
}

/** Build sorted, frozen descriptors for discovered skills. */
export function skillDescriptors(
  skills: ReadonlyArray<DescribableSkill>,
  includeTriggers?: boolean,
): ReadonlyArray<SurfaceDescriptor> {
  const out = skills.map((s) => {
    const tags: string[] = s.triggers && includeTriggers ? [s.triggers] : [];
    return freezeDescriptor({
      kind: "skill",
      name: s.name,
      description: firstLine(s.description),
      group: "skill",
      tags,
    });
  });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze(out);
}
