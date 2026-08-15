/**
 * Ratchet: the `_brain.yaml` bootstrap template must represent every key
 * the resolver understands.
 *
 * The template used to be a hand-written string constant that emitted 7
 * of the 23 top-level keys the validator branches on. Nothing kept the
 * two in sync, so sixteen keys resolved silently from defaults and never
 * appeared in the file an operator reads. This suite closes that loop
 * from BOTH ends:
 *
 *   - the key index is enumerated from the validator itself
 *     (`brainConfigKnownKeys`), never from a hand-maintained list, so a
 *     key added to the resolver shows up here on the next run;
 *   - every enumerated key must either appear in the generated template
 *     or be listed in `BRAIN_CONFIG_TEMPLATE_OMISSIONS` with a written,
 *     non-empty reason.
 *
 * The remaining tests pin the two properties that make the change safe:
 * the LIVE surface of the template is byte-identical to the one shipped
 * before generation (only commentary was added), and a configuration
 * carrying every documented default explicitly resolves to exactly what
 * an empty configuration resolves to.
 */

import { describe, expect, test } from "bun:test";

import {
  BRAIN_CONFIG_TEMPLATE,
  BRAIN_CONFIG_TEMPLATE_OMISSIONS,
  DEFAULT_BRAIN_CONFIG_YAML,
  renderBrainConfigTemplate,
} from "../../../src/core/brain/config-template.ts";
import {
  brainConfigKnownKeys,
  resolveGuardrails,
  resolveHealth,
  resolveIntegrity,
  resolveLinkGraph,
  resolveNotes,
  resolveSessions,
  resolveTemporal,
  validateBrainConfigDetailed,
  INJECT_BUDGET_CHARS_DEFAULT,
  LESSONS_CORROBORATION_MIN_DEFAULT,
  LESSONS_HALF_LIFE_DAYS_DEFAULT,
  LESSONS_LIMIT_DEFAULT,
  MOST_APPLIED_LIMIT_DEFAULT,
  MOST_APPLIED_WINDOW_DAYS_DEFAULT,
  STANDING_RULES_MAX_CHARS_DEFAULT,
} from "../../../src/core/brain/policy.ts";
import { parseBrainYaml } from "../../../src/core/brain/yaml-parse.ts";
import { DEFAULT_VAULT_IGNORE_PATHS } from "../../../src/core/vault-scope/defaults.ts";
import { resolveRollupThresholds } from "../../../src/core/brain/rollup-ladder.ts";
import { resolveSchemaVocabulary } from "../../../src/core/brain/schema-vocab.ts";
import {
  DEFAULT_ANTICIPATORY_MAX_TOKENS,
  DEFAULT_ANTICIPATORY_TTL_SECONDS,
} from "../../../src/core/brain/anticipatory-cache.ts";
import type { BrainConfig } from "../../../src/core/brain/types.ts";

/**
 * The template exactly as it shipped in v1.38.0, before it was
 * generated. Inlined (not imported) on purpose: it is the frozen
 * baseline the LIVE surface must still equal, so importing the live
 * constant would make the assertion vacuous.
 */
const LEGACY_TEMPLATE = `schema_version: 1

# Optional. When set, dream runs from a different agent emit a stderr
# warning and a non_primary_agent payload row. The vault should have a
# single dream-running runtime even when it is shared across devices
# via Syncthing.
primary_agent: null

dream:
  candidate_threshold: 3
  unconfirmed_window_days: 14
  contradiction_window_days: 14

retire:
  stale_evidence_days: 90

confidence:
  # low_max_applied gates the "low-evidence-confirmed" doctor warning
  # and the auto-promotion of unconfirmed preferences to confirmed.
  low_max_applied: 2
  # Band thresholds on the numeric confidence_value (Wilson lower
  # bound times freshness decay). value >= high_min ⇒ high;
  # value >= medium_min ⇒ medium; else low.
  medium_min: 0.40
  high_min: 0.75

snapshots:
  retention_count: 10

# Vault-wide exclusion policy. Single source of truth for every
# vault walker (search indexer, scan-inline, future scanners).
# Entries without a slash match a directory name anywhere in the
# tree; entries with a slash match a vault-relative POSIX path
# exactly. Remove the block to fall back to the built-in defaults;
# set ignore_paths to an empty list to disable exclusions entirely.
vault:
  ignore_paths:
    - .git
    - node_modules
    - .open-second-brain
    - .obsidian
    - .trash
    - .stversions
    - Brain/.snapshots
`;

/** Drop comment-only and blank lines: what is left is the LIVE surface. */
function liveSurface(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .join("\n");
}

function loadFrom(yaml: string): BrainConfig {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<ratchet>").config;
}

/**
 * The fully-resolved configuration: every block passed through its
 * resolver (or its consumer-side `?? DEFAULT`), so "block absent" and
 * "block present at its default" collapse to the same value iff the
 * template's documented defaults really are the resolver's defaults.
 */
function resolvedView(cfg: BrainConfig): Record<string, unknown> {
  return {
    schema_version: cfg.schema_version,
    primary_agent: cfg.primary_agent,
    dream: cfg.dream,
    retire: cfg.retire,
    confidence: cfg.confidence,
    snapshots: cfg.snapshots,
    vault_ignore_paths: cfg.vault?.ignore_paths ?? DEFAULT_VAULT_IGNORE_PATHS,
    // `?? null` mirrors the resolver: no allowlist declared is null, and
    // an all-defaults-live rendering that wrote one would prove the
    // template had changed behaviour for every existing vault.
    vault_include_paths: cfg.vault?.include_paths ?? null,
    active_most_applied: cfg.active?.most_applied ?? {
      window_days: MOST_APPLIED_WINDOW_DAYS_DEFAULT,
      limit: MOST_APPLIED_LIMIT_DEFAULT,
    },
    active_inject_budget_chars: cfg.active?.inject_budget_chars ?? INJECT_BUDGET_CHARS_DEFAULT,
    active_standing_rules_max_chars:
      cfg.active?.standing_rules_max_chars ?? STANDING_RULES_MAX_CHARS_DEFAULT,
    lessons: {
      half_life_days: cfg.lessons?.half_life_days ?? LESSONS_HALF_LIFE_DAYS_DEFAULT,
      corroboration_min: cfg.lessons?.corroboration_min ?? LESSONS_CORROBORATION_MIN_DEFAULT,
      limit: cfg.lessons?.limit ?? LESSONS_LIMIT_DEFAULT,
    },
    guardrails: resolveGuardrails(cfg),
    link_graph: resolveLinkGraph(cfg),
    temporal: resolveTemporal(cfg),
    health: resolveHealth(cfg),
    integrity: resolveIntegrity(cfg),
    notes: resolveNotes(cfg),
    sessions: resolveSessions(cfg),
    rollup: resolveRollupThresholds(cfg),
    schema: resolveSchemaVocabulary(cfg.schema),
    // `?? []` mirrors every consumer of these lists (`declarations[x] ?? []`
    // in schema-report), so "block absent" and "declared empty" collapse to
    // the same resolved vocabulary — which is exactly the claim under test.
    schema_meta: {
      aliases: cfg.schema?.aliases ?? [],
      prefixes: cfg.schema?.prefixes ?? [],
      link_types: cfg.schema?.link_types ?? [],
      extractable: cfg.schema?.extractable ?? [],
      expert_routing: cfg.schema?.expert_routing ?? [],
    },
    anticipatory: {
      ttl_seconds: cfg.anticipatory?.ttl_seconds ?? DEFAULT_ANTICIPATORY_TTL_SECONDS,
      max_tokens: cfg.anticipatory?.max_tokens ?? DEFAULT_ANTICIPATORY_MAX_TOKENS,
    },
    recall_degradation: cfg.recall?.degradation ?? "hard-cut",
    hygiene_resolver_cmd: cfg.hygiene?.resolver_cmd,
    feedback_default_scope: cfg.feedback?.default_scope,
    discipline_report: cfg.discipline_report,
  };
}

describe("config template ratchet — coverage", () => {
  const known = brainConfigKnownKeys();
  const templated = new Set(BRAIN_CONFIG_TEMPLATE.map((b) => b.key));
  const omitted = new Map(BRAIN_CONFIG_TEMPLATE_OMISSIONS.map((o) => [o.key, o.reason]));

  test("every top-level key the resolver understands is templated or justified", () => {
    const unrepresented = [...known.topLevel]
      .filter((key) => !templated.has(key) && !omitted.has(key))
      .toSorted();
    expect(unrepresented).toEqual([]);
  });

  test("every sub-key the resolver understands is templated or justified", () => {
    const unrepresented: string[] = [];
    for (const [block, subKeys] of known.subKeys) {
      const entry = BRAIN_CONFIG_TEMPLATE.find((b) => b.key === block);
      const present = new Set(entry?.keys.map((k) => k.key) ?? []);
      for (const sub of subKeys) {
        const dotted = `${block}.${sub}`;
        if (present.has(sub)) continue;
        if (omitted.has(dotted) || omitted.has(block)) continue;
        unrepresented.push(dotted);
      }
    }
    expect(unrepresented.toSorted()).toEqual([]);
  });

  test("the template names no key the resolver does not understand", () => {
    const stray: string[] = [];
    for (const block of BRAIN_CONFIG_TEMPLATE) {
      if (!known.topLevel.has(block.key)) {
        stray.push(block.key);
        continue;
      }
      const subKeys = known.subKeys.get(block.key) ?? new Set<string>();
      for (const k of block.keys) {
        if (!subKeys.has(k.key)) stray.push(`${block.key}.${k.key}`);
      }
    }
    expect(stray.toSorted()).toEqual([]);
  });

  test("every omission carries a written reason and is not also templated", () => {
    for (const { key, reason } of BRAIN_CONFIG_TEMPLATE_OMISSIONS) {
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(templated.has(key)).toBe(false);
    }
  });
});

describe("config template ratchet — generated text", () => {
  test("round-trips through the hand-rolled parser without warnings", () => {
    const { warnings } = validateBrainConfigDetailed(
      parseBrainYaml(DEFAULT_BRAIN_CONFIG_YAML),
      "<ratchet>",
    );
    expect(warnings).toEqual([]);
  });

  test("the live surface is byte-identical to the pre-generation template", () => {
    expect(liveSurface(DEFAULT_BRAIN_CONFIG_YAML)).toBe(liveSurface(LEGACY_TEMPLATE));
  });

  test("newly exposed keys are emitted commented, never live", () => {
    const lines = DEFAULT_BRAIN_CONFIG_YAML.split("\n");
    for (const block of BRAIN_CONFIG_TEMPLATE) {
      for (const k of block.keys) {
        if (k.emit === "live") continue;
        const live = lines.some((l) => new RegExp(`^\\s*${k.key}\\s*:`).test(l));
        expect(`${block.key}.${k.key} live=${live}`).toBe(`${block.key}.${k.key} live=false`);
      }
    }
  });
});

describe("config template ratchet — resolved-behaviour identity", () => {
  test("a config with every documented default resolves like an empty one", () => {
    const allDefaults = loadFrom(renderBrainConfigTemplate({ allDefaultsLive: true }));
    const empty = loadFrom("schema_version: 1\n");
    expect(resolvedView(allDefaults)).toEqual(resolvedView(empty));
  });

  test("an existing vault written by the pre-generation template resolves unchanged", () => {
    const legacy = loadFrom(LEGACY_TEMPLATE);
    const generated = loadFrom(DEFAULT_BRAIN_CONFIG_YAML);
    expect(resolvedView(generated)).toEqual(resolvedView(legacy));
  });
});
