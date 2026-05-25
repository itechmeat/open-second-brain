/**
 * Concept-cluster assembler.
 *
 * Given a target Brain artifact id, gather every preference / retired
 * note that wikilinks to it (depth-1) and emit a deterministic
 * envelope. Optionally also include unlinked-mention rows so
 * downstream consumers see latent connections as well as formalised
 * ones.
 *
 * The helper is pure: no LLM call, no network I/O. The envelope is
 * stable enough to commit to a JSON schema; an external LLM consumer
 * can feed it through a synthesis prompt later without re-prompting
 * the structure.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { buildBacklinkIndex, type BacklinkRef } from "../backlinks.ts";
import { brainDirs } from "../paths.ts";
import { isoSecond } from "../time.ts";
import { normaliseWikilinkTarget } from "../wikilink.ts";
import {
  findUnlinkedMentions,
  type MentionRef,
} from "./unlinked-mentions.ts";

/** One linker pointing at the target. */
export interface ConceptLinker {
  readonly source: string;
  readonly sourceKind: BacklinkRef["sourceKind"];
  readonly field: string;
  readonly timestamp?: string;
  readonly targetAnchor?: string;
  readonly targetBlock?: string;
  readonly aliasSource?: string;
}

/** Concept-cluster envelope returned by {@link buildConceptCluster}. */
export interface ConceptClusterEnvelope {
  readonly targetId: string;
  readonly targetTitle: string;
  readonly linkers: ReadonlyArray<ConceptLinker>;
  readonly unlinkedMentions: ReadonlyArray<MentionRef>;
  readonly generatedAt: string;
}

export interface BuildConceptClusterOptions {
  /** When true, populate `unlinkedMentions[]`. Default `false`. */
  readonly includeUnlinked?: boolean;
  /** Cap on unlinked-mention rows when included. Default `100`. */
  readonly unlinkedLimit?: number;
}

/**
 * Assemble the concept-cluster envelope for `targetId`.
 *
 * Linkers are sorted by `(source asc, field asc)` so the output is
 * deterministic across filesystems that don't enumerate in a stable
 * order. Returns a frozen object.
 */
export function buildConceptCluster(
  vault: string,
  targetId: string,
  opts: BuildConceptClusterOptions = {},
): ConceptClusterEnvelope {
  const normalised = normaliseWikilinkTarget(targetId);
  const targetTitle = resolveTitle(vault, normalised);

  const index = buildBacklinkIndex(vault);
  const refs = index.get(normalised) ?? [];
  const linkers: ConceptLinker[] = refs
    .map((r) =>
      Object.freeze({
        source: r.source,
        sourceKind: r.sourceKind,
        field: r.field,
        ...(r.timestamp !== undefined ? { timestamp: r.timestamp } : {}),
        ...(r.targetAnchor !== undefined ? { targetAnchor: r.targetAnchor } : {}),
        ...(r.targetBlock !== undefined ? { targetBlock: r.targetBlock } : {}),
        ...(r.aliasSource !== undefined ? { aliasSource: r.aliasSource } : {}),
      }),
    )
    .sort((a, b) => {
      const sa = a.source.localeCompare(b.source);
      if (sa !== 0) return sa;
      return a.field.localeCompare(b.field);
    });

  const unlinkedMentions = opts.includeUnlinked
    ? findUnlinkedMentions(vault, normalised, {
        ...(opts.unlinkedLimit !== undefined
          ? { limit: opts.unlinkedLimit }
          : {}),
      })
    : Object.freeze([] as MentionRef[]);

  return Object.freeze({
    targetId: normalised,
    targetTitle,
    linkers: Object.freeze(linkers) as ReadonlyArray<ConceptLinker>,
    unlinkedMentions,
    generatedAt: isoSecond(),
  });
}

function resolveTitle(vault: string, targetId: string): string {
  const dirs = brainDirs(vault);
  const candidates = [
    join(dirs.preferences, `${targetId}.md`),
    join(dirs.retired, `${targetId}.md`),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const [meta] = parseFrontmatter(c);
      const titleRaw = (meta as Record<string, unknown>)["title"];
      if (typeof titleRaw === "string" && titleRaw.trim().length > 0) {
        return titleRaw.trim();
      }
    } catch {
      continue;
    }
  }
  return targetId;
}
