/**
 * Skill auto-attach (Agent Surface Suite, t_10b86707).
 *
 * Deterministic per-turn skill relevance: score discovered skills
 * against the current turn text with the shared lexical scorer and
 * render a small Markdown block of the top matches. No LLM in the
 * loop; the same query and skill set always produce the same block.
 * The char budget drops whole trailing entries - a half-rendered
 * skill line would read as a different skill.
 */

import { skillDescriptors } from "./descriptor.ts";
import { scoreDescriptors } from "./lexical-score.ts";
import type { SkillEntry } from "./skills.ts";

export interface SkillAttachItem {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly score: number;
}

export interface SkillAttachment {
  /** Markdown block ("## Relevant skills" + bullets), "" when empty. */
  readonly block: string;
  readonly items: ReadonlyArray<SkillAttachItem>;
}

export interface BuildSkillAttachmentOptions {
  /** Current turn text to score against. */
  readonly query: string;
  readonly skills: ReadonlyArray<SkillEntry>;
  /** Maximum skills to attach. Default 3. */
  readonly maxSkills?: number;
  /** Char budget for the rendered block. Default 1200. */
  readonly maxChars?: number;
  /**
   * When set, the `triggers` field from each skill's frontmatter is
   * included in the lexical scorer as a 2x-BM25 tag signal. Default
   * false (name 3x + description 1x only).
   */
  readonly includeTriggers?: boolean;
}

const DEFAULT_MAX_SKILLS = 3;
const DEFAULT_MAX_CHARS = 1200;
const BLOCK_HEADER = "## Relevant skills";

function renderLine(item: SkillAttachItem): string {
  return `- ${item.name} - ${item.description} (load with get_skill: ${item.name})`;
}

export function buildSkillAttachment(opts: BuildSkillAttachmentOptions): SkillAttachment {
  const maxSkills = opts.maxSkills ?? DEFAULT_MAX_SKILLS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const byName = new Map(opts.skills.map((s) => [s.name, s]));
  const ranked = scoreDescriptors(
    opts.query,
    skillDescriptors(opts.skills, opts.includeTriggers),
  ).slice(0, maxSkills);

  const items: SkillAttachItem[] = [];
  const lines: string[] = [];
  let used = BLOCK_HEADER.length + 2; // header + blank line
  for (const { descriptor, score } of ranked) {
    const skill = byName.get(descriptor.name);
    if (skill === undefined) continue;
    const item: SkillAttachItem = Object.freeze({
      name: skill.name,
      description: skill.description,
      path: skill.path,
      score,
    });
    const line = renderLine(item);
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    items.push(item);
    lines.push(line);
  }

  if (items.length === 0) return Object.freeze({ block: "", items: Object.freeze([]) });
  return Object.freeze({
    block: `${BLOCK_HEADER}\n\n${lines.join("\n")}`,
    items: Object.freeze(items),
  });
}
