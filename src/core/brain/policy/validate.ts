/**
 * Turn a parsed `_brain.yaml` object into a typed {@link BrainConfig}.
 *
 * One reason to change: which blocks exist and in what order they are
 * read. Every block's own rules live in `./blocks/`; this module owns
 * only the sequence, the mandatory `schema_version` check, and the
 * forward-compat sweep that must run after every block has registered
 * itself.
 */

import type { BrainConfig } from "../types.ts";
import { BrainConfigError, type BrainConfigLoadWarning } from "./errors.ts";
import {
  KeyIndexCollector,
  type BlockParseContext,
  type BrainConfigKeyIndex,
} from "./key-index.ts";
import { BRAIN_CONFIG_SUPPORTED_VERSIONS, DEFAULT_BRAIN_CONFIG } from "./defaults.ts";
import { parsePrimaryAgent } from "./primary-agent.ts";
import {
  parseConfidenceBlock,
  parseDreamBlock,
  parseRetireBlock,
  parseSnapshotsBlock,
} from "./blocks/lifecycle.ts";
import { parseVaultBlock } from "./blocks/vault-scope.ts";
import { parseActiveBlock } from "./blocks/active.ts";
import { parseLessonsBlock } from "./blocks/lessons.ts";
import { parseMaintenanceBlock } from "./blocks/maintenance.ts";
import { parseDisciplineReportBlock } from "./blocks/discipline-report.ts";
import { parseGuardrailsBlock } from "./blocks/guardrails.ts";
import { parseRollupBlock } from "./blocks/rollup.ts";
import { parseLinkGraphBlock } from "./blocks/link-graph.ts";
import { parseTemporalBlock } from "./blocks/temporal.ts";
import { parseEmbeddingsBlock } from "./blocks/embeddings.ts";
import { parseHealthBlock } from "./blocks/health.ts";
import { parseIntegrityBlock } from "./blocks/integrity.ts";
import { parseNotesBlock } from "./blocks/notes.ts";
import { parseWriteBindingBlock } from "./blocks/write-binding.ts";
import { parseSessionsBlock } from "./blocks/sessions.ts";
import { parseSchemaBlock } from "./blocks/schema.ts";
import {
  parseAnticipatoryBlock,
  parseHygieneBlock,
  parseRecallBlock,
} from "./blocks/continuity-hygiene.ts";
import { parseFeedbackBlock } from "./blocks/feedback.ts";

export interface ValidateResult {
  readonly config: BrainConfig;
  readonly warnings: ReadonlyArray<BrainConfigLoadWarning>;
  /**
   * Every key this validation run branched on, top-level and per-block.
   * Recorded by construction (see `KeyIndexCollector`) rather than from a
   * hand-maintained list, so it can never disagree with what the
   * validator actually understands. Consumed by the configuration-template
   * ratchet.
   */
  readonly knownKeys: BrainConfigKeyIndex;
}

/**
 * Pure validator. Accepts a parsed object (typically from
 * `parseBrainYaml`) and returns a typed {@link BrainConfig}, or
 * throws {@link BrainConfigError} naming the offending field.
 *
 * `source` is rendered into error messages; pass the config file path or
 * a synthetic label like `"<test fixture>"` so the failure points at
 * something useful.
 */
export function validateBrainConfig(parsed: unknown, source: string | null = null): BrainConfig {
  return validateBrainConfigDetailed(parsed, source).config;
}

export function validateBrainConfigDetailed(
  parsed: unknown,
  source: string | null = null,
): ValidateResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BrainConfigError("config root must be a map of keys", null, source);
  }
  const ctx: BlockParseContext = {
    obj: parsed as Record<string, unknown>,
    source,
    warnings: [],
    keys: new KeyIndexCollector(),
  };
  // `schema_version` is seeded directly because `readSchemaVersion`
  // checks its presence with an inverted `in` test rather than through
  // `hasBlock`, so nothing else would register it.
  ctx.keys.addTop("schema_version");
  const schemaVersion = readSchemaVersion(ctx);
  const primaryAgent = parsePrimaryAgent(ctx);

  // Each block is optional; a missing block inherits its default. The
  // lifecycle blocks merge field-by-field so a user can override one
  // threshold without having to re-state the rest.
  const dream = parseDreamBlock(ctx);
  const retire = parseRetireBlock(ctx);
  const confidence = parseConfidenceBlock(ctx);
  const snapshots = parseSnapshotsBlock(ctx);

  const vault = parseVaultBlock(ctx);
  const active = parseActiveBlock(ctx);
  const lessons = parseLessonsBlock(ctx);
  const maintenance = parseMaintenanceBlock(ctx);
  const disciplineReport = parseDisciplineReportBlock(ctx);
  const guardrails = parseGuardrailsBlock(ctx);
  const rollup = parseRollupBlock(ctx);
  const linkGraph = parseLinkGraphBlock(ctx);
  const temporal = parseTemporalBlock(ctx);
  const health = parseHealthBlock(ctx);
  const embeddings = parseEmbeddingsBlock(ctx);
  const integrity = parseIntegrityBlock(ctx);
  const notes = parseNotesBlock(ctx);
  const writeBinding = parseWriteBindingBlock(ctx);
  const sessions = parseSessionsBlock(ctx);
  const schema = parseSchemaBlock(ctx);
  const hygiene = parseHygieneBlock(ctx);
  const anticipatory = parseAnticipatoryBlock(ctx);
  const recall = parseRecallBlock(ctx);
  const feedback = parseFeedbackBlock(ctx);

  warnUnknownTopLevelKeys(ctx);

  const config: BrainConfig = {
    schema_version: schemaVersion,
    primary_agent: primaryAgent,
    dream,
    retire,
    confidence,
    snapshots,
    ...(vault !== undefined ? { vault } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(lessons !== undefined ? { lessons } : {}),
    ...(maintenance !== undefined ? { maintenance } : {}),
    ...(disciplineReport !== undefined ? { discipline_report: disciplineReport } : {}),
    ...(rollup !== undefined ? { rollup } : {}),
    ...(guardrails !== undefined ? { guardrails } : {}),
    ...(linkGraph !== undefined ? { link_graph: linkGraph } : {}),
    ...(temporal !== undefined ? { temporal } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(writeBinding !== undefined ? { write_binding: writeBinding } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(embeddings !== undefined ? { embeddings } : {}),
    ...(integrity !== undefined ? { integrity } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(hygiene !== undefined ? { hygiene } : {}),
    ...(anticipatory !== undefined ? { anticipatory } : {}),
    ...(recall !== undefined ? { recall } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
  };

  return { config, warnings: ctx.warnings, knownKeys: ctx.keys };
}

/** Mandatory, and must be in the supported set. */
function readSchemaVersion(ctx: BlockParseContext): number {
  if (!("schema_version" in ctx.obj)) {
    throw new BrainConfigError(
      "missing required field; expected a positive integer in the supported set " +
        `(${BRAIN_CONFIG_SUPPORTED_VERSIONS.join(", ")})`,
      "schema_version",
      ctx.source,
    );
  }
  const value = ctx.obj["schema_version"];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !BRAIN_CONFIG_SUPPORTED_VERSIONS.includes(value)
  ) {
    throw new BrainConfigError(
      `unsupported value ${JSON.stringify(value)}; expected one of ` +
        BRAIN_CONFIG_SUPPORTED_VERSIONS.join(", "),
      "schema_version",
      ctx.source,
    );
  }
  return value;
}

/**
 * Forward-compat: unknown top-level keys → warning, not error. Runs after
 * every block has had a chance to register itself, so a block can never be
 * parsed-but-not-yet-known at the point this check reads the set. Uses its
 * own message format (distinct from `warnUnknownKeys`'s `block.key: …`
 * shape), pinned by an existing test.
 */
function warnUnknownTopLevelKeys(ctx: BlockParseContext): void {
  for (const key of Object.keys(ctx.obj)) {
    if (!ctx.keys.topLevel.has(key)) {
      ctx.warnings.push({
        path: ctx.source ?? "<config>",
        message: `unknown top-level field '${key}' ignored (forward-compat)`,
      });
    }
  }
}

/**
 * Probe source label used by {@link brainConfigKnownKeys}. Never reaches
 * a user-visible surface: the probe discards its warnings.
 */
const KEY_INDEX_PROBE_SOURCE = "<brain-config-key-index>";

/**
 * Every configuration key {@link validateBrainConfigDetailed} branches
 * on, enumerated by running the validator rather than by reading a list.
 *
 * Two passes are needed because a block's sub-key vocabulary is only
 * declared inside the branch that parses the block: pass one discovers
 * the top-level keys against a minimal config, pass two re-runs with
 * every discovered block present but empty so each block's sub-key
 * registration executes. Scalar top-level keys keep their default value
 * in pass two - handing `primary_agent` an empty map would (correctly)
 * be rejected.
 */
export function brainConfigKnownKeys(): BrainConfigKeyIndex {
  const minimal: Record<string, unknown> = {
    schema_version: BRAIN_CONFIG_SUPPORTED_VERSIONS[0],
  };
  const firstPass = validateBrainConfigDetailed(minimal, KEY_INDEX_PROBE_SOURCE).knownKeys;
  const defaults = DEFAULT_BRAIN_CONFIG as unknown as Record<string, unknown>;
  const probe: Record<string, unknown> = { ...minimal };
  for (const key of firstPass.topLevel) {
    if (key in minimal) continue;
    const fallback = defaults[key];
    const isScalar = key in defaults && (fallback === null || typeof fallback !== "object");
    probe[key] = isScalar ? fallback : {};
  }
  return validateBrainConfigDetailed(probe, KEY_INDEX_PROBE_SOURCE).knownKeys;
}
