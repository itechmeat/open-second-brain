/**
 * Dead-end registry (t_be62c62d): the Brain's negative-knowledge
 * class. Skill proposals mine positive procedures; nothing recorded
 * what was TRIED and FAILED, so agents kept re-walking pruned
 * branches. A dead-end is one markdown note under `Brain/dead-ends/`
 * (approach + why it failed + context) - markdown-first so FTS
 * indexes it with zero search changes and recall surfaces "avoid X"
 * alongside "prefer Y". The active set is bounded to the most-recent
 * N; overflow archives the oldest into `Brain/dead-ends/archive/`
 * instead of deleting history.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { sanitiseTextField } from "../redactor.ts";
import { parseFrontmatterText, slugify, writeFrontmatterAtomic } from "../vault.ts";
import type { FrontmatterMap } from "../types.ts";
import { allocateSlug } from "./paths.ts";
import { isoDate, isoSecond } from "./time.ts";

/** Active dead-ends kept before overflow archives the oldest. */
export const DEAD_END_MAX_ACTIVE = 100;

const APPROACH_MAX_LEN = 256;
const REASON_MAX_LEN = 1024;
const CONTEXT_MAX_LEN = 1024;

export function deadEndsDir(vault: string): string {
  return join(vault, "Brain", "dead-ends");
}

export interface DeadEndEntry {
  readonly id: string;
  readonly path: string;
  readonly approach: string;
  readonly reason: string;
  readonly context: string | null;
  readonly agent: string;
  readonly created_at: string;
}

export interface RecordDeadEndInput {
  /** What was tried (one line, the note title). */
  readonly approach: string;
  /** Why it failed or was deliberately set aside. */
  readonly reason: string;
  readonly context?: string;
  readonly agent: string;
  readonly now: Date;
  /** Override the active-set cap (tests). */
  readonly maxActive?: number;
}

export interface RecordDeadEndResult {
  readonly entry: DeadEndEntry;
  /** Ids archived by the overflow trim, oldest first. */
  readonly archived: ReadonlyArray<string>;
}

export interface DeadEndParseWarning {
  readonly path: string;
  readonly message: string;
}

export interface ListDeadEndsResult {
  readonly entries: ReadonlyArray<DeadEndEntry>;
  readonly warnings: ReadonlyArray<DeadEndParseWarning>;
}

function renderBody(approach: string, reason: string, context: string | null): string {
  return (
    `## Approach\n\n${approach}\n\n` +
    `## Why it failed\n\n${reason}\n\n` +
    `## Context\n\n${context ?? "_(not provided)_"}\n`
  );
}

/**
 * Record one dead-end note and trim the active set. The id is
 * `de-<date>-<slug-of-approach>` with `allocateSlug` collision
 * suffixes, matching the signal naming discipline.
 */
export function recordDeadEnd(vault: string, input: RecordDeadEndInput): RecordDeadEndResult {
  const approach = sanitiseTextField(input.approach, {
    maxLen: APPROACH_MAX_LEN,
    singleLine: true,
  }).trim();
  const reason = sanitiseTextField(input.reason, { maxLen: REASON_MAX_LEN }).trim();
  const context =
    input.context !== undefined
      ? sanitiseTextField(input.context, { maxLen: CONTEXT_MAX_LEN }).trim() || null
      : null;
  if (approach === "") throw new Error("dead-end missing field: approach");
  if (reason === "") throw new Error("dead-end missing field: reason");
  if (!input.agent || input.agent.trim() === "") throw new Error("dead-end missing field: agent");

  const dir = deadEndsDir(vault);
  mkdirSync(dir, { recursive: true });
  const date = isoDate(input.now);
  const allocated = allocateSlug({
    vault,
    targetDir: dir,
    prefix: `de-${date}`,
    slug: slugify(approach),
  });
  const id = `de-${date}-${allocated.slug}`;
  const createdAt = isoSecond(input.now);

  const metadata: FrontmatterMap = {
    kind: "brain-dead-end",
    id,
    created_at: createdAt,
    agent: input.agent.trim(),
    approach,
    tags: ["brain", "brain/dead-end"],
  };
  writeFrontmatterAtomic(allocated.path, metadata, renderBody(approach, reason, context), {
    overwrite: false,
    existsErrorKind: "dead-end",
    vaultForRelativePath: vault,
  });

  const archived = trimActive(vault, input.maxActive ?? DEAD_END_MAX_ACTIVE);

  return Object.freeze({
    entry: Object.freeze({
      id,
      path: allocated.path,
      approach,
      reason,
      context,
      agent: input.agent.trim(),
      created_at: createdAt,
    }),
    archived: Object.freeze(archived),
  });
}

/** Move the oldest active entries beyond the cap into `archive/`. */
function trimActive(vault: string, maxActive: number): string[] {
  const { entries } = listDeadEnds(vault);
  if (entries.length <= maxActive) return [];
  // `entries` is newest first; everything past the cap archives.
  const overflow = entries.slice(maxActive).toReversed();
  const archiveDir = join(deadEndsDir(vault), "archive");
  mkdirSync(archiveDir, { recursive: true });
  const archived: string[] = [];
  for (const entry of overflow) {
    renameSync(entry.path, join(archiveDir, `${entry.id}.md`));
    archived.push(entry.id);
  }
  return archived;
}

function parseSections(body: string): { reason: string; context: string | null } {
  const reasonMatch = /## Why it failed\n\n([\s\S]*?)(?:\n## |$)/.exec(body);
  const contextMatch = /## Context\n\n([\s\S]*?)(?:\n## |$)/.exec(body);
  const contextRaw = contextMatch?.[1]?.trim() ?? "";
  return {
    reason: reasonMatch?.[1]?.trim() ?? "",
    context: contextRaw === "" || contextRaw === "_(not provided)_" ? null : contextRaw,
  };
}

/**
 * List active dead-ends, newest first. Files that fail to parse (or
 * carry the wrong kind) surface as warnings and never abort the list.
 */
export function listDeadEnds(vault: string): ListDeadEndsResult {
  const dir = deadEndsDir(vault);
  if (!existsSync(dir)) return { entries: [], warnings: [] };

  const entries: DeadEndEntry[] = [];
  const warnings: DeadEndParseWarning[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    let metadata: FrontmatterMap;
    let body: string;
    try {
      [metadata, body] = parseFrontmatterText(readFileSync(path, "utf8"));
    } catch (exc) {
      warnings.push({ path, message: `unparseable dead-end: ${(exc as Error).message ?? exc}` });
      continue;
    }
    if (metadata["kind"] !== "brain-dead-end") {
      warnings.push({ path, message: "missing kind: brain-dead-end" });
      continue;
    }
    const id = typeof metadata["id"] === "string" ? metadata["id"] : name.replace(/\.md$/, "");
    const approach = typeof metadata["approach"] === "string" ? metadata["approach"] : "";
    const agent = typeof metadata["agent"] === "string" ? metadata["agent"] : "";
    const createdAt = typeof metadata["created_at"] === "string" ? metadata["created_at"] : "";
    if (approach === "" || createdAt === "") {
      warnings.push({ path, message: "dead-end missing approach/created_at" });
      continue;
    }
    const sections = parseSections(body);
    entries.push(
      Object.freeze({
        id,
        path,
        approach,
        reason: sections.reason,
        context: sections.context,
        agent,
        created_at: createdAt,
      }),
    );
  }

  entries.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return { entries: Object.freeze(entries), warnings: Object.freeze(warnings) };
}
