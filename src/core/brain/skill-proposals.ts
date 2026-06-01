import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { parseFrontmatter, slugify, writeFrontmatterAtomic } from "../vault.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import {
  BRAIN_SKILL_PROPOSALS_REL,
  procedurePath,
  proposalWatermarkPath,
  skillProposalAcceptedPath,
  skillProposalPendingPath,
  skillProposalRejectedPath,
} from "./paths.ts";
import {
  listContinuityRecords,
  type ContinuityRecord,
} from "./continuity/store.ts";

export type SkillProposalPatternKind =
  | "repeated_action"
  | "structural_similarity"
  | "co_occurrence"
  | "temporal_routine";

export interface SkillProposalLearnOptions {
  readonly now?: Date;
  readonly minSupport?: number;
}

export interface SkillProposalLearnResult {
  readonly watermarkFrom: string | null;
  readonly watermarkTo: string | null;
  readonly scanned: number;
  readonly created: ReadonlyArray<string>;
  readonly suppressed: ReadonlyArray<string>;
}

export interface SkillProposalReviewResult {
  readonly id: string;
  readonly slug: string;
  readonly status: "accepted" | "rejected";
  readonly proposalPath: string;
  readonly procedurePath?: string;
}

interface ProposalCandidate {
  readonly patternKind: SkillProposalPatternKind;
  readonly key: string;
  readonly confidence: number;
  readonly records: ReadonlyArray<ContinuityRecord>;
  readonly suggestedTitle: string;
}

interface WatermarkState {
  readonly lastCreatedAt: string | null;
  readonly lastId: string | null;
}

const DEFAULT_MIN_SUPPORT = 3;

export function learnSkillProposals(
  vault: string,
  opts: SkillProposalLearnOptions = {},
): SkillProposalLearnResult {
  const now = opts.now ?? new Date();
  const minSupport = Math.max(2, opts.minSupport ?? DEFAULT_MIN_SUPPORT);

  const watermark = readWatermark(vault);
  const records = listContinuityRecords(vault)
    .filter((record) => {
      if (watermark.lastCreatedAt === null) return true;
      if (record.createdAt > watermark.lastCreatedAt) return true;
      if (record.createdAt < watermark.lastCreatedAt) return false;
      if (watermark.lastId === null) return true;
      return record.id > watermark.lastId;
    })
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );

  if (records.length === 0) {
    return {
      watermarkFrom: watermark.lastCreatedAt,
      watermarkTo: watermark.lastCreatedAt,
      scanned: 0,
      created: Object.freeze([]),
      suppressed: Object.freeze([]),
    };
  }

  const candidates = detectCandidates(records, minSupport);
  const created: string[] = [];
  const suppressed: string[] = [];

  for (const candidate of candidates) {
    const payloadHash = candidateHash(candidate);
    const slug = proposalSlug(candidate, payloadHash);
    const proposalId = `prop-${slug}`;

    const pendingPath = skillProposalPendingPath(vault, slug);
    const acceptedPath = skillProposalAcceptedPath(vault, slug);
    const rejectedPath = skillProposalRejectedPath(vault, slug);

    if (
      existsSync(pendingPath) ||
      existsSync(acceptedPath) ||
      existsSync(rejectedPath)
    ) {
      suppressed.push(proposalId);
      continue;
    }

    writeFrontmatterAtomic(
      pendingPath,
      {
        schema_version: 1,
        kind: "brain-skill-proposal",
        id: proposalId,
        slug,
        status: "pending",
        pattern_kind: candidate.patternKind,
        confidence: candidate.confidence.toFixed(3),
        payload_hash: payloadHash,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        watermark_from: watermark.lastCreatedAt ?? "",
        watermark_to: records[records.length - 1]!.createdAt,
        evidence_count: String(candidate.records.length),
        source_refs: candidate.records.flatMap((record) => [
          record.id,
          ...record.sourceRefs.map((src) => src.id),
        ]),
      },
      renderProposalBody(candidate),
      {
        overwrite: false,
        existsErrorKind: "skill proposal",
        vaultForRelativePath: vault,
      },
    );
    created.push(proposalId);
  }

  const watermarkRecord = records[records.length - 1]!;
  const watermarkTo = watermarkRecord.createdAt;
  writeWatermark(vault, {
    lastCreatedAt: watermarkTo,
    lastId: watermarkRecord.id,
  });

  return {
    watermarkFrom: watermark.lastCreatedAt,
    watermarkTo,
    scanned: records.length,
    created: Object.freeze(created),
    suppressed: Object.freeze(suppressed),
  };
}

export function listPendingSkillProposals(vault: string): ReadonlyArray<{
  id: string;
  slug: string;
  status: string;
  patternKind: string;
}> {
  const dir = ensureInsideVault(
    join(vault, BRAIN_SKILL_PROPOSALS_REL, "pending"),
    vault,
  );
  if (!existsSync(dir)) return Object.freeze([]);

  const out: Array<{
    id: string;
    slug: string;
    status: string;
    patternKind: string;
  }> = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const path = ensureInsideVault(join(dir, name), vault);
    const [fm] = parseFrontmatter(path);
    if (fm["kind"] !== "brain-skill-proposal") continue;
    if (typeof fm["id"] !== "string") continue;
    out.push({
      id: fm["id"],
      slug:
        typeof fm["slug"] === "string"
          ? fm["slug"]
          : fm["id"].replace(/^prop-/, ""),
      status: typeof fm["status"] === "string" ? fm["status"] : "pending",
      patternKind:
        typeof fm["pattern_kind"] === "string" ? fm["pattern_kind"] : "unknown",
    });
  }
  return Object.freeze(out);
}

export function acceptSkillProposal(
  vault: string,
  slug: string,
  opts: { now?: Date; note?: string } = {},
): SkillProposalReviewResult {
  const now = (opts.now ?? new Date()).toISOString();
  const pendingPath = skillProposalPendingPath(vault, slug);
  if (!existsSync(pendingPath)) {
    throw new Error(`pending skill proposal not found: ${slug}`);
  }

  const [fm, body] = parseFrontmatter(pendingPath);
  if (fm["kind"] !== "brain-skill-proposal") {
    throw new Error(`invalid skill proposal file: ${pendingPath}`);
  }
  const id = typeof fm["id"] === "string" ? fm["id"] : `prop-${slug}`;
  const acceptedPath = skillProposalAcceptedPath(vault, slug);
  const procPath = procedurePath(vault, slug);

  writeFrontmatterAtomic(
    acceptedPath,
    {
      ...fm,
      status: "accepted",
      reviewed_at: now,
      updated_at: now,
      ...(opts.note ? { review_note: opts.note } : {}),
    },
    body,
    {
      overwrite: false,
      existsErrorKind: "accepted skill proposal",
      vaultForRelativePath: vault,
    },
  );

  try {
    writeFrontmatterAtomic(
      procPath,
      {
        schema_version: 1,
        kind: "brain-procedure",
        id: `proc-${slug}`,
        slug,
        source_proposal: id,
        created_at: now,
        updated_at: now,
        status: "active",
      },
      renderAcceptedProcedureBody(id, body),
      {
        overwrite: false,
        existsErrorKind: "procedure",
        vaultForRelativePath: vault,
      },
    );
  } catch (error) {
    if (existsSync(acceptedPath)) unlinkSync(acceptedPath);
    throw error;
  }

  unlinkSync(pendingPath);
  return {
    id,
    slug,
    status: "accepted",
    proposalPath: acceptedPath,
    procedurePath: procPath,
  };
}

export function rejectSkillProposal(
  vault: string,
  slug: string,
  opts: { now?: Date; note: string },
): SkillProposalReviewResult {
  if (!opts.note.trim()) {
    throw new Error("rejecting skill proposal requires a non-empty note");
  }

  const now = (opts.now ?? new Date()).toISOString();
  const pendingPath = skillProposalPendingPath(vault, slug);
  if (!existsSync(pendingPath)) {
    throw new Error(`pending skill proposal not found: ${slug}`);
  }

  const [fm, body] = parseFrontmatter(pendingPath);
  if (fm["kind"] !== "brain-skill-proposal") {
    throw new Error(`invalid skill proposal file: ${pendingPath}`);
  }
  const id = typeof fm["id"] === "string" ? fm["id"] : `prop-${slug}`;
  const rejectedPath = skillProposalRejectedPath(vault, slug);

  writeFrontmatterAtomic(
    rejectedPath,
    {
      ...fm,
      status: "rejected",
      reviewed_at: now,
      updated_at: now,
      review_note: opts.note,
    },
    body,
    {
      overwrite: false,
      existsErrorKind: "rejected skill proposal",
      vaultForRelativePath: vault,
    },
  );

  unlinkSync(pendingPath);
  return { id, slug, status: "rejected", proposalPath: rejectedPath };
}

function readWatermark(vault: string): WatermarkState {
  const path = watermarkPath(vault);
  if (!existsSync(path)) return { lastCreatedAt: null, lastId: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    return {
      lastCreatedAt:
        typeof parsed["lastCreatedAt"] === "string"
          ? parsed["lastCreatedAt"]
          : null,
      lastId: typeof parsed["lastId"] === "string" ? parsed["lastId"] : null,
    };
  } catch {
    return { lastCreatedAt: null, lastId: null };
  }
}

function writeWatermark(vault: string, state: WatermarkState): void {
  const path = proposalWatermarkPath(vault);
  const root = ensureInsideVault(dirname(path), vault);
  mkdirSync(root, { recursive: true });
  const payload = JSON.stringify(state, null, 2);
  atomicWriteFileSync(path, `${payload}\n`);
}

function watermarkPath(vault: string): string {
  return proposalWatermarkPath(vault);
}

function detectCandidates(
  records: ReadonlyArray<ContinuityRecord>,
  minSupport: number,
): ProposalCandidate[] {
  const out: ProposalCandidate[] = [];

  const actionMap = new Map<string, ContinuityRecord[]>();
  for (const record of records) {
    const action = actionToken(record);
    if (!action) continue;
    const bucket = actionMap.get(action) ?? [];
    bucket.push(record);
    actionMap.set(action, bucket);
  }
  for (const [action, bucket] of actionMap) {
    if (bucket.length < minSupport) continue;
    out.push({
      patternKind: "repeated_action",
      key: action,
      confidence: confidence(bucket.length, minSupport),
      records: Object.freeze(bucket.slice(0, 6)),
      suggestedTitle: `Repeated action: ${action}`,
    });
  }

  const shapeMap = new Map<string, ContinuityRecord[]>();
  for (const record of records) {
    const shape = shapeSignature(record);
    if (!shape) continue;
    const bucket = shapeMap.get(shape) ?? [];
    bucket.push(record);
    shapeMap.set(shape, bucket);
  }
  for (const [shape, bucket] of shapeMap) {
    if (bucket.length < minSupport) continue;
    out.push({
      patternKind: "structural_similarity",
      key: shape,
      confidence: confidence(bucket.length, minSupport),
      records: Object.freeze(bucket.slice(0, 6)),
      suggestedTitle: `Structural routine: ${shape}`,
    });
  }

  const pairMap = new Map<string, ContinuityRecord[]>();
  for (let i = 1; i < records.length; i++) {
    const left = actionToken(records[i - 1]!);
    const right = actionToken(records[i]!);
    if (!left || !right || left === right) continue;
    const pair = `${left} -> ${right}`;
    const bucket = pairMap.get(pair) ?? [];
    bucket.push(records[i - 1]!, records[i]!);
    pairMap.set(pair, bucket);
  }
  for (const [pair, bucket] of pairMap) {
    const support = Math.floor(bucket.length / 2);
    if (support < minSupport) continue;
    out.push({
      patternKind: "co_occurrence",
      key: pair,
      confidence: confidence(support, minSupport),
      records: Object.freeze(bucket.slice(0, 6)),
      suggestedTitle: `Co-occurrence flow: ${pair}`,
    });
  }

  const temporalMap = new Map<string, ContinuityRecord[]>();
  for (const record of records) {
    const action = actionToken(record);
    if (!action) continue;
    const hour = isoHour(record.createdAt);
    if (hour === null) continue;
    const key = `${action}@${hour}`;
    const bucket = temporalMap.get(key) ?? [];
    bucket.push(record);
    temporalMap.set(key, bucket);
  }
  for (const [key, bucket] of temporalMap) {
    const daySet = new Set(
      bucket.map((record) => record.createdAt.slice(0, 10)),
    );
    if (daySet.size < minSupport) continue;
    out.push({
      patternKind: "temporal_routine",
      key,
      confidence: confidence(daySet.size, minSupport),
      records: Object.freeze(bucket.slice(0, 6)),
      suggestedTitle: `Temporal routine: ${key}`,
    });
  }

  return out.toSorted(
    (left, right) =>
      left.patternKind.localeCompare(right.patternKind) ||
      left.key.localeCompare(right.key),
  );
}

function actionToken(record: ContinuityRecord): string | null {
  const payload = record.payload as Record<string, unknown>;
  for (const field of ["action", "command", "tool", "verb", "event"]) {
    const value = payload[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim().toLowerCase();
    }
  }
  return null;
}

function shapeSignature(record: ContinuityRecord): string | null {
  const keys = Object.keys(record.payload).toSorted();
  if (keys.length === 0) return null;
  return `${record.kind}:${keys.join(",")}`;
}

function isoHour(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return String(date.getUTCHours()).padStart(2, "0");
}

function confidence(support: number, minSupport: number): number {
  const raw = Math.min(0.99, 0.55 + (support - minSupport) * 0.1);
  return Math.max(0.55, Math.round(raw * 1000) / 1000);
}

function renderProposalBody(candidate: ProposalCandidate): string {
  const evidence = candidate.records
    .map((record) => {
      const snippet = evidenceSnippet(record);
      return `- ${record.createdAt} :: ${record.kind} :: ${record.id}${snippet ? ` :: ${snippet}` : ""}`;
    })
    .join("\n");

  return [
    `# ${candidate.suggestedTitle}`,
    "",
    "## Pattern",
    `- kind: ${candidate.patternKind}`,
    `- key: ${candidate.key}`,
    "",
    "## Suggested skill body",
    `When pattern \`${candidate.key}\` appears, follow the observed repeatable workflow.`,
    "Capture inputs first, execute steps in stable order, and emit audit-friendly outputs.",
    "",
    "## Evidence",
    evidence,
  ].join("\n");
}

function evidenceSnippet(record: ContinuityRecord): string {
  const payload = record.payload as Record<string, unknown>;
  for (const field of ["query", "summary", "note", "text"]) {
    const value = payload[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 120);
    }
  }
  return "";
}

function proposalSlug(
  candidate: ProposalCandidate,
  payloadHash: string,
): string {
  const keySlug = slugify(candidate.key).slice(0, 40);
  return `${candidate.patternKind}-${keySlug}-${payloadHash.slice(0, 8)}`;
}

function candidateHash(candidate: ProposalCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        patternKind: candidate.patternKind,
        key: candidate.key,
        records: candidate.records.map((record) => record.id),
      }),
      "utf8",
    )
    .digest("hex");
}

function renderAcceptedProcedureBody(
  proposalId: string,
  proposalBody: string,
): string {
  const marker = "## Suggested skill body";
  const idx = proposalBody.indexOf(marker);
  const suggested =
    idx >= 0
      ? proposalBody.slice(idx + marker.length).trim()
      : proposalBody.trim();
  return [
    "# Procedure",
    "",
    `Accepted from proposal: [[${proposalId}]]`,
    "",
    suggested || "No suggested body was captured.",
  ].join("\n");
}

export function skillProposalSlugFromPath(path: string): string | null {
  const name = basename(path);
  if (!name.startsWith("prop-") || !name.endsWith(".md")) return null;
  return name.slice("prop-".length, -".md".length);
}
