/**
 * Subject diarization (t_28ba3fc4): a deterministic, read-only profile
 * assembler for one registry entity.
 *
 * Given an entity, it collects the subject's document set from the
 * entity registry and the ingested source pages, then computes a
 * stated-vs-evidenced section: STATED claims come from the existing
 * atomic-fact machinery run over the entity's own registered body;
 * EVIDENCED signals are the frequency and recency with which the
 * subject actually appears across ingested sources (behavioral signals,
 * pure counts, no language analysis of the claim text). Each line
 * carries the shared evidence-identity type from deep-synthesis
 * (t_40fa4e8d) and is gated on it, so an identity-less line is a
 * visible loss rather than a silent drop.
 *
 * The module never calls a model. It emits a structured profile note
 * skeleton plus exactly one needs-llm-step envelope describing the
 * prose the caller must generate to finish the profile; the summary
 * prose stays with the calling agent, never inside core.
 */

import { createHash } from "node:crypto";
import { posix, relative } from "node:path";

import { decomposeAtomicFacts, type AtomicEntityLike } from "./atomic-facts.ts";
import { hasEvidenceIdentity, type EvidenceIdentity } from "./deep-synthesis.ts";
import { getEntity } from "./entities/registry.ts";
import type { EntityRef } from "./entities/types.ts";
import { getIngestedSource, listIngestedSources } from "./ingest/sources-registry.ts";

/** Vault-relative directory a fleshed profile note lands in. */
export const PROFILE_DIR_REL = "Brain/profiles";

/** Evidence-identity kind labels this module attributes. */
const EVIDENCE_KIND_ENTITY = "entity";
const EVIDENCE_KIND_CLAIM = "claim";
const EVIDENCE_KIND_SOURCE_PAGE = "source_page";

/** The needs-llm-step step name for the deferred profile prose. */
const PROFILE_PROSE_STEP = "profile-prose";

/** Marker the skeleton carries where the deferred prose must land. */
const PROSE_MARKER = "<!-- o2b:needs-llm-step profile-prose -->";

/** A diarization request failed because the subject does not exist. */
export class DiarizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiarizationError";
  }
}

/**
 * One line of the stated-vs-evidenced section:
 *   - `stated_corroborated` - a stated claim the subject is also evidenced for.
 *   - `stated_unevidenced`  - a stated claim with zero evidence frequency.
 *   - `evidenced_unstated`  - the subject appears in a source but states nothing.
 */
export type DiarizationGapKind =
  | "stated_corroborated"
  | "stated_unevidenced"
  | "evidenced_unstated";

export interface DiarizationGapLine {
  readonly kind: DiarizationGapKind;
  /** The stated claim text, or a structural descriptor of the source. */
  readonly statement: string;
  /** Shared S1 identity of the artifact grounding this line. */
  readonly evidence: EvidenceIdentity;
  /** Number of ingested source pages the subject appears in. */
  readonly evidenceFrequency: number;
  /** Most recent source mention timestamp, or null when unevidenced. */
  readonly lastEvidencedAt: string | null;
}

/**
 * The single deferred generation step. Shape mirrors the write-session
 * `needs-llm-step` envelope grammar (status, step, prompt, schema hints,
 * target path) but stays plain data: diarization is read-only and opens
 * no durable session.
 */
export interface DiarizationLlmStep {
  readonly status: "needs-llm-step";
  readonly step: string;
  readonly prompt: string;
  readonly schema_hints: ReadonlyArray<string>;
  readonly target_path: string;
}

export interface DiarizationReport {
  readonly entityId: string;
  readonly entityName: string;
  readonly category: string;
  readonly generatedAt: string;
  /** Identities of every artifact considered: the entity plus sources. */
  readonly documentSet: ReadonlyArray<EvidenceIdentity>;
  readonly statedVsEvidenced: ReadonlyArray<DiarizationGapLine>;
  /** Lines dropped for lacking an evidence identity (visible loss). */
  readonly excludedLineCount: number;
  readonly skeleton: string;
  readonly llmStep: DiarizationLlmStep;
}

export interface DiarizationOptions {
  readonly now: Date;
}

/** Lowercase hex sha256; ties evidence identity to content. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function toPosixRel(vault: string, abs: string): string {
  return relative(vault, abs).split(/[\\/]/).join(posix.sep);
}

/** One source page and the anchoring metadata diarization needs. */
interface EvidencedSource {
  readonly identity: EvidenceIdentity;
  readonly at: string | null;
}

/**
 * Assemble a subject profile for one registry entity. Deterministic and
 * read-only. Throws {@link DiarizationError} when the entity is unknown.
 */
export function diarize(
  vault: string,
  ref: EntityRef,
  opts: DiarizationOptions,
): DiarizationReport {
  const entity = getEntity(vault, ref);
  if (entity === null) {
    throw new DiarizationError(`unknown entity: ${ref.query}`);
  }

  const entityLike: AtomicEntityLike = {
    id: entity.id,
    name: entity.name,
    aliases: entity.aliases,
    status: entity.status,
  };
  const entityRel = toPosixRel(vault, entity.path);
  const entityIdentity: EvidenceIdentity = Object.freeze({
    path: entityRel,
    kind: EVIDENCE_KIND_ENTITY,
    contentHash: sha256Hex(entity.body),
  });

  // STATED claims: atomic assertions decomposed from the subject's own
  // registered body that anchor the subject. No claim-text matching
  // against evidence - that would be language analysis.
  const statedClaims: string[] = [];
  for (const assertion of decomposeAtomicFacts(entity.body, { entities: [entityLike] })) {
    if (assertion.entities.includes(entity.id)) statedClaims.push(assertion.text);
  }

  // EVIDENCED signals: ingested source pages the subject appears in,
  // detected through the same anchoring machinery. Frequency and recency
  // are the behavioral signals; both are pure counts over structure.
  const evidencedSources: EvidencedSource[] = [];
  for (const listed of listIngestedSources(vault)) {
    const detail = getIngestedSource(vault, listed.path);
    if (detail === null) continue;
    const anchored = decomposeAtomicFacts(detail.body, { entities: [entityLike] }).some((a) =>
      a.entities.includes(entity.id),
    );
    if (!anchored) continue;
    evidencedSources.push({
      identity: Object.freeze({
        path: listed.path,
        kind: EVIDENCE_KIND_SOURCE_PAGE,
        contentHash: sha256Hex(detail.body),
      }),
      at: detail.updatedAt ?? detail.createdAt,
    });
  }

  const evidenceFrequency = evidencedSources.length;
  const lastEvidencedAt = evidencedSources.reduce<string | null>((latest, source) => {
    if (source.at === null) return latest;
    if (latest === null || source.at > latest) return source.at;
    return latest;
  }, null);

  // Build the stated-vs-evidenced lines, gating each on evidence
  // identity so an identity-less line is reported as a visible loss.
  const lines: DiarizationGapLine[] = [];
  let excludedLineCount = 0;
  const push = (line: DiarizationGapLine): void => {
    // Defensive gate: every line constructed below carries a non-empty path,
    // kind, and content hash, so this check is currently unreachable. It is
    // kept deliberately so that if the evidence construction ever changes, an
    // identity-less line is reported as a visible loss rather than emitted.
    if (hasEvidenceIdentity(line.evidence)) lines.push(line);
    else excludedLineCount += 1;
  };

  for (const statement of statedClaims) {
    const evidence: EvidenceIdentity = Object.freeze({
      path: entityRel,
      kind: EVIDENCE_KIND_CLAIM,
      contentHash: sha256Hex(statement),
    });
    push({
      kind: evidenceFrequency > 0 ? "stated_corroborated" : "stated_unevidenced",
      statement,
      evidence,
      evidenceFrequency,
      lastEvidencedAt,
    });
  }

  // When the subject states nothing but the sources evidence it, the gap
  // is the evidence itself: one line per corroborating source page.
  if (statedClaims.length === 0) {
    for (const source of evidencedSources) {
      push({
        kind: "evidenced_unstated",
        statement: `subject appears in ${source.identity.path}`,
        evidence: source.identity,
        evidenceFrequency,
        lastEvidencedAt,
      });
    }
  }

  const documentSet: EvidenceIdentity[] = [
    entityIdentity,
    ...evidencedSources.map((s) => s.identity),
  ];

  const targetPath = posix.join(PROFILE_DIR_REL, `${entity.id}.md`);
  const generatedAt = opts.now.toISOString();
  const skeleton = renderSkeleton({
    entity: { id: entity.id, name: entity.name, category: entity.category },
    generatedAt,
    lines,
    documentSet,
  });
  const llmStep: DiarizationLlmStep = Object.freeze({
    status: "needs-llm-step" as const,
    step: PROFILE_PROSE_STEP,
    prompt:
      `Write the summary prose for the profile of ${entity.name} (${entity.id}). ` +
      "Ground every statement in the stated-vs-evidenced section and the document set below; " +
      `replace the ${PROSE_MARKER} marker with the prose and submit the full note.`,
    schema_hints: Object.freeze([
      "frontmatter: preserve the skeleton block verbatim",
      "body: replace only the prose marker; keep the structured sections intact",
    ]),
    target_path: targetPath,
  });

  return Object.freeze({
    entityId: entity.id,
    entityName: entity.name,
    category: entity.category,
    generatedAt,
    documentSet: Object.freeze(documentSet),
    statedVsEvidenced: Object.freeze(lines),
    excludedLineCount,
    skeleton,
    llmStep,
  });
}

function renderSkeleton(params: {
  readonly entity: { id: string; name: string; category: string };
  readonly generatedAt: string;
  readonly lines: ReadonlyArray<DiarizationGapLine>;
  readonly documentSet: ReadonlyArray<EvidenceIdentity>;
}): string {
  const { entity, generatedAt, lines, documentSet } = params;
  const out: string[] = [
    "---",
    "kind: brain-profile",
    `entity_id: ${entity.id}`,
    `category: ${entity.category}`,
    `generated_at: ${generatedAt}`,
    "---",
    "",
    `# Profile: ${entity.name}`,
    "",
    "## Summary",
    "",
    PROSE_MARKER,
    "",
    "## Stated vs evidenced",
    "",
  ];
  if (lines.length === 0) {
    out.push("(no stated claims and no evidenced signals)");
  } else {
    for (const line of lines) {
      const recency = line.lastEvidencedAt ?? "none";
      out.push(
        `- [${line.kind}] ${line.statement} ` +
          `(evidence: ${line.evidence.path}, frequency: ${line.evidenceFrequency}, ` +
          `last_evidenced: ${recency})`,
      );
    }
  }
  out.push("", "## Document set", "");
  for (const doc of documentSet) out.push(`- ${doc.kind}: ${doc.path}`);
  out.push("");
  return out.join("\n");
}
