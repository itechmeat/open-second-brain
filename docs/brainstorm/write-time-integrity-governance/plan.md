# Write-Time Integrity & Governance Suite - implementation plan

Feature branch: `feat/write-time-integrity-governance`. TDD per task, one atomic conventional commit per task, formatter + linter green before every commit.

## Tasks

### Task 1: Schema pack ontology fields (foundation)
- **Files**: `src/core/brain/schema-pack.ts`, `src/core/brain/schema-mutate.ts`, `tests/core/brain/schema-pack-ontology.test.ts` (new), existing schema-pack/mutate tests extended
- **What**: additive parsing + rendering + freezing for `frontmatter_tiers` (kind -> field -> tier), `labels` (dimension -> enum values), `link_constraints` (link_type -> list of `source->target` pairs), `attributes` (type -> field -> description). Mutation ops `add_label_dimension`, `remove_label_dimension`, `add_link_constraint`, `remove_link_constraint`, `set_attribute_field`, `remove_attribute_field`, `set_frontmatter_tier`, `remove_frontmatter_tier`. Round-trip property: parse(render(pack)) deep-equals pack for all new fields; empty fields render nothing (neutral default pinned).
- **Acceptance**: round-trip test green; a config without new fields parses to empty frozen structures; invalid tokens/tiers/pairs fail closed with path-qualified errors.
- **Depends on**: none

### Task 2: Controlled-vocabulary labels (t_7a41f42d)
- **Files**: `src/core/brain/labels.ts` (new), `src/core/search/search.ts` (label filter), `src/core/brain/entities/registry.ts` (canonical label entities), `src/cli/brain/verbs/label.ts` (new), `tests/core/brain/labels.test.ts`, `tests/cli/brain-label.test.ts`
- **What**: `validateLabelAssignment(pack, dimension, value)` fail-closed with allowed-list errors; `assignLabel(vault, path, dimension, value)` writes frontmatter `labels` map + `label:<dim>:<value>` registry entity; `o2b brain label <path> <dim>=<value>` + `--remove`; deterministic `label:<dim>=<value>` search filter.
- **Acceptance**: unknown dimension/value rejected with vocabulary in message; assignment idempotent; search filter returns only labeled notes; vault without `labels` config behaves bit-identically (pinned).
- **Depends on**: Task 1

### Task 3: Link-type endpoint constraints (t_15453235)
- **Files**: `src/core/search/relation-polarity.ts`, schema-lint integration (`src/core/brain/schema-lint.ts` or existing lint module), `tests/core/search/link-constraints.test.ts`
- **What**: typed-relation materialization consults `link_constraints`; a violating relation falls back to an untyped link (never dropped) and `schema_lint` reports each violation with the declared pairs. No constraints declared = exact current behavior.
- **Acceptance**: violating edge is untyped + linted; conforming edge typed as today; empty-constraints snapshot test byte-identical.
- **Depends on**: Task 1

### Task 4: Per-type attribute fields (t_f5633190)
- **Files**: `src/core/brain/fact-extract.ts` (attr validation helper only), schema explain surface (`src/mcp/` schema_explain_type handler), capture verb attr support, `tests/core/brain/attributes.test.ts`
- **What**: `validateAttributes(pack, type, attrs)` fail-closed (unknown field lists declared fields + descriptions); `--attr field=value` on the capture path stores a structured `attributes` map; `schema_explain_type` renders descriptors so agents see the vocabulary.
- **Acceptance**: undeclared field rejected with guidance; declared attrs persist and round-trip; no `attributes` config = no behavior change.
- **Depends on**: Task 1

### Task 5: Frontmatter tier model + merge guard (t_3f92d3f1, part 1)
- **Files**: `src/core/brain/frontmatter-tiers.ts` (new: `TIER_LEVELS`, `DEFAULT_TIER_MAP`, `resolveFieldTier`, `mergeFrontmatterTiered`), `tests/core/brain/frontmatter-tiers.test.ts`
- **What**: tier resolution (pack override > built-in default > L4); `mergeFrontmatterTiered(existing, incoming, {kind, pack})` - framework writes preserve L4 fields they do not own and refuse to overwrite L1 with changed values unless `acceptIdentity: true`; pure function, exhaustive unit tests.
- **Acceptance**: L4 user field survives framework rewrite; L1 hand-edit is not silently re-accepted by a framework write; unknown kind = everything L4 = current merge semantics.
- **Depends on**: Task 1

### Task 6: Tier drift check + repair verb (t_3f92d3f1, part 2)
- **Files**: `src/cli/brain/verbs/tiers.ts` (new), indexer baseline additions if needed (`src/core/search/store.ts`), doctor integration, `tests/cli/brain-tiers.test.ts`
- **What**: `o2b brain tiers check` compares each indexed file's L1/L2 fields against the last-indexed baseline; mismatches stage findings (`ask_user`) listing field/expected/actual; `o2b brain tiers restore <path> [--field f] --apply` restores from baseline; `brain_doctor` surfaces count. Framework writers (preference, dead-end, truth ingest writers) switch to `mergeFrontmatterTiered`.
- **Acceptance**: hand-edited `id` detected with expected/actual; restore round-trips; clean vault = zero findings; doctor neutral when no drift.
- **Depends on**: Task 5

### Task 7: Secret custody store + crypto (t_0b134404, part 1)
- **Files**: `src/core/brain/secrets/crypto.ts`, `src/core/brain/secrets/store.ts`, `src/core/brain/secrets/audit.ts` (new), `tests/core/brain/secrets/store.test.ts`
- **What**: AES-256-GCM per-value ciphertext (node:crypto, random IV per value, auth tag verified), keyfile 0600 auto-created under the vault-local state dir; store file with per-secret metadata `{name, env_var, allow (exec patterns), created_at, last_used_at}`; `setSecret`/`listSecrets` (names+metadata only)/`removeSecret`; no API returns plaintext; audit appender writes no-values events to the daily log + JSONL sidecar.
- **Acceptance**: set/list/rm round-trip without plaintext exposure in any return value or thrown error; tampered ciphertext fails closed; keyfile created 0600; audit lines contain name + event, never value.
- **Depends on**: none

### Task 8: Secret exec + CLI + redaction (t_0b134404, part 2)
- **Files**: `src/core/brain/secrets/exec.ts`, `src/cli/brain/verbs/secret.ts` (new), `src/core/redactor.ts` (runtime value-set extension), `tests/core/brain/secrets/exec.test.ts`, `tests/cli/brain-secret.test.ts`
- **What**: `runWithSecret(vault, name, argv)` - allowlist match (glob on the joined command), spawn with `{...env, [env_var]: value}`, stdout/stderr passed through `redactRawOutput` extended with the resolved value, exit code propagated; `o2b brain secret set|list|rm|run` (value via stdin or `--from-env`, never argv); denial audited as `secret_exec_denied`.
- **Acceptance**: allowlisted command sees the env var; non-matching command refused + audited; output containing the value reaches the caller redacted; value absent from o2b's own argv/env after run.
- **Depends on**: Task 7

### Task 9: Maintenance lease + gates (t_166d1226, part 1)
- **Files**: `src/core/brain/maintenance/lease.ts`, `src/core/brain/maintenance/lane.ts` (new), `src/core/discipline/window.ts` (generalized daily window helper), `tests/core/brain/maintenance/lease.test.ts`, `tests/core/brain/maintenance/lane.test.ts`
- **What**: SQLite expiring lease (`acquireLease(db, worker, ttl)` via INSERT ON CONFLICT, reclaim on expiry, `releaseLease`); `dailyWindowContains(now, {startHour, endHour, tz})`; query-rate gate over existing recall-telemetry counters (`interactive queries in last N min < threshold`); `evaluateGates()` returns `run | skipped:window | skipped:busy | skipped:lease`.
- **Acceptance**: second worker cannot acquire a live lease but can reclaim an expired one; window math correct across tz/midnight-wrap; busy vault skips; no telemetry = rate 0.
- **Depends on**: none

### Task 10: Maintenance journal + verb (t_166d1226, part 2)
- **Files**: `src/core/brain/maintenance/journal.ts`, `src/cli/brain/verbs/maintenance.ts` (new), `tests/cli/brain-maintenance.test.ts`
- **What**: bounded JSONL journal (newest-N sweep) recording every attempt incl. gate-refusals; `o2b brain maintenance run [--force]` (force bypasses window+busy, never the lease) executing registered heavy tasks stale-first (initially: dream, reindex), `maintenance status` (lease holder, last runs, next window).
- **Acceptance**: every attempt journaled with gate verdict; `--force` honors lease; status renders journal + lease.
- **Depends on**: Task 9

### Task 11: MCP tools + registry pins
- **Files**: `src/mcp/brain-tools.ts`, `tests/mcp/mcp.test.ts`, `tests/mcp/brain-governance.test.ts` (new)
- **What**: `brain_labels` (assign/remove/list ops), `brain_tiers` (check/restore), `brain_secrets` (list/run - no set/get over MCP), `brain_maintenance` (run/status); previewBudget on each; pinned sorted tool list + stdio count 69 -> 73 updated.
- **Acceptance**: MCP suite green incl. updated pins; INVALID_PARAMS guards mirror CLI usage errors.
- **Depends on**: Tasks 2, 6, 8, 10

### Task 12: E2E integration + docs
- **Files**: `tests/e2e/write-time-governance.integration.test.ts` (new), `README.md`, `CHANGELOG.md` (`[0.44.0]`), `docs/cli-reference.md`, `docs/how-it-works.md`
- **What**: one vault exercising: declare ontology -> assign labels -> constraint-violating link linted -> attr validation -> hand-edit L1 -> tiers check finds + restores -> secret set/run with redacted output -> maintenance run inside/outside window. Docs per phase-5 conventions.
- **Acceptance**: e2e green; docs build; CHANGELOG entry complete with compare link.
- **Depends on**: all

## Implementation deviations (documented during phase 2)

- **Task 4 host surface**: attribute assignment ships as its own verb
  `o2b brain attr <path> <field>=<value>` mirroring `label`, not as a
  `--attr` flag on a capture verb - no single capture verb writes
  typed pages today, and the note's own frontmatter `type` selecting
  the descriptor set is the cleaner contract.
- **Task 6 baseline**: the drift baseline is an index-time
  `tier_snapshot` per document (seeded on first index, identity
  fields never absorbed on later runs) rather than comparing against
  fields "already stored in SQLite" - the index never persisted
  frontmatter values before v6. Only identity-tier changes stage
  findings; system-tier fields mutate legitimately on every
  framework write and would false-positive on each dream run.
- **Task 9 window math**: the daily window helper lives in
  `maintenance/lane.ts` (Intl-based local hour); `discipline/window.ts`
  stays untouched - its yesterday-interval contract is unrelated to
  an hour-window predicate.
- **Task 10/CLI**: the window is configured per invocation
  (`--window H-H --tz ZONE` on the cron command line), not via a new
  config key - explicit at the call site, neutral default preserved.
- **Task 11**: no `brain_attr` MCP tool - descriptors already reach
  agents through schema explain output, and attribute writes stay on
  the CLI alongside `label`'s MCP counterpart covering the
  classification use case.
