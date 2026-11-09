/**
 * The classification of every `_brain.yaml` key (design D14 item 3), a
 * leaf module: it imports nothing, so both the migration's settings import
 * (`../../store-migration/brain-settings.ts`, which re-exports it) and the
 * settings reader (`./settings-source.ts`) use one table without an import
 * cycle.
 *
 *  - `shared`: every machine must agree on it, so the migration writes it
 *    as a `setting-set` record in the `settings` stream of `shared`, under
 *    the setting key `brain.<block>.<field>` (`brain.<key>` for a scalar).
 *  - `device`: it is about one machine (its install, its host, its
 *    caches, snapshots and index). It lives in the machine config as
 *    `brain_<block>_<field>: <JSON value>`.
 *  - `drop`: not a setting (the file's own schema version).
 *
 * The classification is by block, with per-field overrides; the census
 * test (`tests/core/store-migration/brain-settings.test.ts`) fails when the
 * validator reads a key this table does not classify, or when the table
 * names a key the validator does not read.
 */

export type BrainKeyHome = "shared" | "device" | "drop";

export interface BrainKeyRule {
  readonly home: BrainKeyHome;
  readonly reason: string;
  /** Per-field homes that differ from the block's. */
  readonly fields?: Readonly<Record<string, BrainKeyHome>>;
}

const SHARED = (reason: string, fields?: BrainKeyRule["fields"]): BrainKeyRule => ({
  home: "shared",
  reason,
  ...(fields !== undefined ? { fields } : {}),
});
const DEVICE = (reason: string): BrainKeyRule => ({ home: "device", reason });

/** Every top-level `_brain.yaml` key, classified. */
export const BRAIN_YAML_KEYS: Readonly<Record<string, BrainKeyRule>> = Object.freeze({
  schema_version: { home: "drop", reason: "the version of the file's own format, not a setting" },
  primary_agent: SHARED("which agent owns the brain is one answer for every machine"),
  dream: SHARED("dream thresholds decide which rules exist, so every machine must agree"),
  retire: SHARED("retirement rules shape the shared preference fold"),
  confidence: SHARED("confidence bands label shared preferences"),
  rollup: SHARED("rollup thresholds decide shared consolidation"),
  cross_topic: SHARED("cross-topic promotion creates shared rules"),
  vault: SHARED("vault-relative ignore and include paths are the same in every copy"),
  active: SHARED("the injected digest budget is the same brain on every machine"),
  lessons: SHARED("the lessons digest is rendered from shared records"),
  guardrails: SHARED("promotion guardrails decide shared rules"),
  link_graph: SHARED("link-graph thresholds audit the shared vault"),
  temporal: SHARED("stale windows and week alignment describe the shared timeline"),
  notes: SHARED("note read paths are vault-relative, the same in every copy"),
  write_binding: SHARED("write binding prefixes are vault-relative, the same in every copy"),
  sessions: SHARED("capture boundaries decide what becomes a shared record"),
  health: SHARED("semantic-health thresholds judge the shared brain"),
  schema: SHARED("the record vocabulary must be one vocabulary"),
  feedback: SHARED("the default feedback scope labels shared signals"),
  recall: SHARED("recall degradation policy is one policy for the brain"),
  recall_inject: SHARED("which slices reach an agent is one policy for the brain"),
  context: SHARED("the context window budget is one budget for the brain"),
  integrity: SHARED("integrity policy guards shared records"),
  // Endpoints, providers, model names and key env names are machine
  // config; a vault only says which uses are enabled (and their
  // thresholds), which every machine must agree on.
  decision_model: {
    home: "device",
    reason: "decision-model endpoints, providers, models and key names belong to one machine",
    fields: { enabled: "shared" },
  },
  discipline_report: SHARED("the discipline report reads the shared timeline", {
    timezone: "device",
  }),
  hygiene: SHARED("deduplication thresholds decide shared records", { resolver_cmd: "device" }),
  install: DEVICE("hook timeouts and the tool profile belong to one machine's install"),
  maintenance: DEVICE("the host-pressure gate measures one machine"),
  snapshots: DEVICE("snapshots are device-local after the migration (design D14 item 9)"),
  storage: DEVICE("storage caps measure one machine's disk"),
  anticipatory: DEVICE("the anticipatory cache lives in one machine's state"),
  embeddings: DEVICE("the embedding index is device-local"),
});

/**
 * Shared settings that hold a safety or privacy boundary, so only the
 * operator (human authority, `o2b brain settings`) sets or unsets them; an
 * agent-authority write (`brain_settings`) is refused whether or not the
 * operator ever set the key, in both modes. Each named field lowers a
 * boundary when an agent could change it; the other fields of these
 * blocks (`guardrails.derived_fact_synthesis`, a field a later release
 * adds) stay agent-writable unless listed here. Only the `integrity`
 * block is operator-only as a whole (`OPERATOR_ONLY_BLOCKS`), so a field
 * it gains later fails closed; its fields are still listed for the census.
 *
 *  - `integrity.*`: the owner-scope delivery and write gates, the
 *    embedding ABI gate and the pack staleness window.
 *  - `notes.read_paths`: which user folders the agent may read.
 *  - `vault.ignore_paths` / `vault.include_paths`: what is indexed and so
 *    reaches search and recall.
 *  - `write_binding.path_prefixes`: where a caller-named write may land.
 *  - `sessions.*_patterns`: which sessions and messages the capture
 *    boundary keeps out of the brain.
 *  - `guardrails.*` (the seven named): the dream pass self-approval
 *    thresholds, the instruction-file ceiling and the trust and
 *    owner-scope toggles.
 *  - `decision_model.enabled`: the operator's opt-out of decision-model
 *    calls, a safety switch an agent must not turn back on.
 *
 * The census in `tests/core/brain/settings-operator-only.test.ts` names
 * the same list.
 */
export const OPERATOR_ONLY_SETTINGS: ReadonlySet<string> = new Set([
  "integrity.owner_scope_delivery",
  "integrity.owner_scope_writes",
  "integrity.embedding_abi",
  "integrity.pack_validity_seconds",
  "notes.read_paths",
  "vault.ignore_paths",
  "vault.include_paths",
  "write_binding.path_prefixes",
  "sessions.ignore_patterns",
  "sessions.stateless_patterns",
  "sessions.ignore_message_patterns",
  "guardrails.promotion_min_signals",
  "guardrails.promotion_min_distinct_agents",
  "guardrails.promotion_min_age_days",
  "guardrails.instruction_file_max_lines",
  "guardrails.untrusted_source_delimiting",
  "guardrails.provenance_trust_ordering",
  "guardrails.owner_scoped_facts",
  "decision_model.enabled",
]);

/** Blocks every field of which is operator-only, including fields a later release adds. */
const OPERATOR_ONLY_BLOCKS: ReadonlySet<string> = new Set(["integrity"]);

/** Whether `<block>.<field>` (or the scalar `block`) is operator-only. */
export function isOperatorOnlySetting(block: string, field?: string): boolean {
  if (OPERATOR_ONLY_BLOCKS.has(block)) return true;
  return OPERATOR_ONLY_SETTINGS.has(field === undefined ? block : `${block}.${field}`);
}

/** The setting key a shared field becomes. */
export function brainSettingKey(block: string, field?: string): string {
  return field === undefined ? `brain.${block}` : `brain.${block}.${field}`;
}

/** The machine-config key a device field maps to. */
export function brainConfigKey(block: string, field?: string): string {
  return field === undefined ? `brain_${block}` : `brain_${block}_${field}`;
}

/**
 * Where `block` (and `field` of it, when given) lives, or `undefined` for a
 * key the table does not classify. The settings reader
 * (`brain/policy/settings-source.ts`) asks the same question when it reads
 * these records back.
 */
export function brainKeyHome(block: string, field?: string): BrainKeyHome | undefined {
  if (!Object.hasOwn(BRAIN_YAML_KEYS, block)) return undefined;
  const rule = BRAIN_YAML_KEYS[block]!;
  return field !== undefined ? (rule.fields?.[field] ?? rule.home) : rule.home;
}
