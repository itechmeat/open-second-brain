# Trust and operator surfaces - implementation plan

Atomic units in dependency order (atoms first, helpers second, consumers third). Each task is one conventional commit on `feat/trust-operator-surfaces`. TDD: failing tests first, then implementation, then refactor green.

## Atoms layer

### A1: BrainRole enum + BrainOperation type
- **Files**:
  - `src/core/brain/trust/role.ts` (new)
  - `tests/core/brain/trust/role.test.ts` (new)
- **Acceptance**: enum exports `writer`, `dreamer`, `applier`, `unknown`. `BrainOperation` is a union of `feedback_write`, `preference_create_unconfirmed`, `preference_promote_confirmed`, `preference_retire`, `evidence_record`, `log_append`. Test covers exhaustiveness via `satisfies`.
- **Depends on**: none.
- **Commit**: `feat(trust): add BrainRole enum and BrainOperation type`

### A2: BrainGuardrailConfig in policy.ts
- **Files**:
  - `src/core/brain/policy.ts` (modify - extend `BrainConfig` with optional `guardrails?` block)
  - `tests/core/brain/policy/guardrails.test.ts` (new)
- **Acceptance**: `loadBrainConfig` accepts an optional `guardrails:` YAML block with three fields: `promotion_min_signals` (default 2), `promotion_min_distinct_agents` (default 1), `instruction_file_max_lines` (default 200). When the block is absent, all three return their defaults. Existing fixtures stay byte-identical.
- **Depends on**: none.
- **Commit**: `feat(policy): add BrainGuardrailConfig block with backward-compatible defaults`

### A3: Extend DreamRunSummary with uncertain + quarantined arrays
- **Files**:
  - `src/core/brain/dream.ts` (modify - add `uncertain: ReadonlyArray<UncertainEntry>` and `quarantined: ReadonlyArray<QuarantinedSignal>` to `DreamRunSummary`; emit empty arrays in this commit)
  - `tests/core/brain/dream.test.ts` (modify - assert new fields are present and empty by default)
- **Acceptance**: existing dream snapshot tests still pass after adding the empty arrays. Type-checking confirms readers see both arrays.
- **Depends on**: none.
- **Commit**: `feat(dream): surface uncertain and quarantined arrays on DreamRunSummary`

### A4: Extend RunDoctorResult with trust + verification + instruction-file fields
- **Files**:
  - `src/core/brain/doctor.ts` (modify - add `trust_verdict?`, `verification_delta_summary?`, `instruction_file_warnings?`, `uncertain?` optional fields. Optional so unrelated doctor callers stay green.)
  - `tests/core/brain/doctor.test.ts` (modify - assert new fields default to absent / empty arrays)
- **Acceptance**: doctor snapshot tests pass; new fields are present only when populated by helpers.
- **Depends on**: none.
- **Commit**: `feat(doctor): add trust_verdict and verification_delta to RunDoctorResult`

### A5: Extend DigestJson with derived trust fields
- **Files**:
  - `src/core/brain/digest.ts` (modify - add `trust_verdict?`, `uncertain_count`, `quarantined_count` to `DigestJson`)
  - `tests/core/brain/digest.test.ts` (modify - assert digest renders new fields)
- **Acceptance**: existing digest snapshot tests pass; new fields default to `unknown` / 0 when no trust input is provided.
- **Depends on**: A3, A4 (digest reads from dream and doctor summaries).
- **Commit**: `feat(digest): surface derived trust_verdict and uncertain counts`

## Helpers layer

### H1: assess-rule-quality (language-agnostic)
- **Files**:
  - `src/core/brain/trust/assess-rule-quality.ts` (new)
  - `tests/core/brain/trust/assess-rule-quality.test.ts` (new)
- **Acceptance**: `assessRuleQuality(principle: string): RuleQualityResult { score: number, severity: 'ok' | 'warn' | 'reject', reasons: string[] }`. Score uses **shape-based heuristics only**, no vocabulary lookups in any language:
  - empty / single token -> `reject`.
  - too long (>500 chars or >80 tokens) -> `warn`.
  - **measurable signal absent**: no token contains a digit anywhere, AND no token contains an operator-shape character (`>`, `<`, `=`, `%`, `/` between digits) -> `warn`.
  - **filler signal high**: ratio of single-character alphanumeric tokens to total tokens above 0.4 (after stripping punctuation) -> `warn`.

  No enumerated unit list, no per-language vague-word list, no stopword list. The detector reads bytes and counts tokens by whitespace; "token contains digit" is a `/\d/` test on the codepoint, language-independent.

  Test fixtures cover: empty input, single token, very long input, an imperative with a numeric outcome (`limit retries to 10 per hour`), a numeric outcome in a non-Latin script (`<NON-LATIN>10<NON-LATIN>/<NON-LATIN>` placeholder), a vague rule with no structural signal (`<TOKEN_A> <TOKEN_B> <TOKEN_C>` placeholder).
- **Depends on**: none.
- **Commit**: `feat(trust): add language-agnostic assess-rule-quality helper`

### H2: check-role-permission
- **Files**:
  - `src/core/brain/trust/check-role-permission.ts` (new)
  - `tests/core/brain/trust/check-role-permission.test.ts` (new)
- **Acceptance**: `checkRolePermission(role: BrainRole, op: BrainOperation, currentStatus?: BrainStatus): { allowed: boolean; reason?: string }`. Static allow-list per role: `writer` may only `feedback_write` and `preference_create_unconfirmed`; `dreamer` may only `preference_promote_confirmed` (from `unconfirmed`) and `preference_retire`; `applier` may only `evidence_record` and `log_append`. Crossing a boundary (e.g. applier trying to mutate `confirmed` status) returns `{ allowed: false, reason: ... }` with structured reason.
- **Depends on**: A1.
- **Commit**: `feat(trust): add check-role-permission helper`

### H3: self-approval-guardrail
- **Files**:
  - `src/core/brain/trust/self-approval-guardrail.ts` (new)
  - `tests/core/brain/trust/self-approval-guardrail.test.ts` (new)
- **Acceptance**: `applySelfApprovalGuardrail({signal_count, distinct_agents, age_days}, config): { decision: 'promote' | 'quarantine'; reason?: string }`. Promotes only when all three thresholds met. Defaults from `BrainGuardrailConfig` make current behaviour bit-identical (min_signals=2, min_distinct_agents=1, min_age_days=0).
- **Depends on**: A2.
- **Commit**: `feat(trust): add self-approval-guardrail helper`

### H4: compute-verification-delta
- **Files**:
  - `src/core/brain/trust/compute-verification-delta.ts` (new)
  - `tests/core/brain/trust/compute-verification-delta.test.ts` (new)
- **Acceptance**: `computeVerificationDelta(vault: string, dream: DreamRunSummary): VerificationDeltaResult`. For each preference id mentioned in `dream.confirmed | dream.retired | dream.new_unconfirmed`, classifies into one of `confirmed | drift | regression | missing_evidence`. Pure file-system reads through existing path helpers; no network, no LLM.
- **Depends on**: A3.
- **Commit**: `feat(trust): add compute-verification-delta helper`

### H5: instruction-file-ceiling
- **Files**:
  - `src/core/brain/trust/instruction-file-ceiling.ts` (new)
  - `tests/core/brain/trust/instruction-file-ceiling.test.ts` (new)
- **Acceptance**: `checkInstructionFileCeiling(vault, { maxLines })`: returns warnings for each vault-root file in the tracked set `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` that exceeds `maxLines`. Returns the actual line count in the warning payload so the operator can see by how much.
- **Depends on**: A2.
- **Commit**: `feat(trust): add instruction-file-ceiling helper`

### H6: compute-trust-verdict
- **Files**:
  - `src/core/brain/trust/compute-trust-verdict.ts` (new)
  - `tests/core/brain/trust/compute-trust-verdict.test.ts` (new)
- **Acceptance**: `computeTrustVerdict({doctor, dream, verification}): 'clean' | 'watch' | 'investigate'`. Thresholds per design-doc. Pure aggregation, no side effects.
- **Depends on**: A3, A4, H4.
- **Commit**: `feat(trust): add compute-trust-verdict helper`

### H7: operator-summary composer
- **Files**:
  - `src/core/brain/trust/operator-summary.ts` (new)
  - `tests/core/brain/trust/operator-summary.test.ts` (new)
- **Acceptance**: `buildOperatorSummary(vault, opts): OperatorSummary` returns `{ trust_verdict, digest_summary, doctor_summary, dream_summary, verification_delta, top_actions, instruction_file_warnings }`. Pulls digest, doctor (read-only), most-recent dream, and runs verification + trust helpers. Markdown renderer included in same file.
- **Depends on**: H1-H6, A5.
- **Commit**: `feat(trust): add operator-summary composer`

## Consumers layer

### C1: brain_dream uses self-approval-guardrail + uncertain
- **Files**:
  - `src/core/brain/dream.ts` (modify - call `applySelfApprovalGuardrail` before promoting; route below-threshold candidates to `quarantined`; populate `uncertain` for cases where verification cannot run)
  - `tests/core/brain/dream-guardrail.test.ts` (new)
- **Acceptance**: a dream run with one signal below threshold lands in `quarantined`, not `confirmed`. Default config keeps existing tests green.
- **Depends on**: H3.
- **Commit**: `feat(dream): wire self-approval guardrail and quarantine path`

### C2: brain_feedback uses assess-rule-quality
- **Files**:
  - `src/core/brain/sessions/validate-feedback.ts` (modify - call `assessRuleQuality`; on `severity: 'reject'` return structured error)
  - `tests/core/brain/sessions/validate-feedback-quality.test.ts` (new)
- **Acceptance**: empty principle or single token -> rejected with structured reason. Valid principles pass.
- **Depends on**: H1.
- **Commit**: `feat(feedback): reject structurally-vague principles via quality gate`

### C3: brain_apply_evidence uses check-role-permission
- **Files**:
  - `src/core/brain/apply-evidence.ts` (modify - call `checkRolePermission(BrainRole.applier, 'evidence_record', currentStatus)`)
  - `tests/core/brain/apply-evidence-role.test.ts` (new)
- **Acceptance**: applier role cannot mutate confirmed preference status; helper returns rejection that surfaces as a structured error.
- **Depends on**: H2.
- **Commit**: `feat(evidence): enforce role-permission boundary on apply-evidence`

### C4: brain_doctor uses instruction-file-ceiling + verification-delta + trust-verdict
- **Files**:
  - `src/core/brain/doctor.ts` (modify - populate `trust_verdict`, `verification_delta_summary` (counts only, not full entries), `instruction_file_warnings`)
  - `tests/core/brain/doctor-trust.test.ts` (new)
- **Acceptance**: doctor on a clean vault returns `trust_verdict: 'clean'`; doctor on a vault with one long CLAUDE.md emits a warning entry referencing the line count.
- **Depends on**: H4, H5, H6.
- **Commit**: `feat(doctor): integrate trust verdict, ceiling, and verification delta`

### C5: brain_digest reads trust fields
- **Files**:
  - `src/core/brain/digest.ts` (modify - read `trust_verdict` from doctor input and `uncertain_count` / `quarantined_count` from dream input; surface in JSON + markdown)
  - `tests/core/brain/digest-trust.test.ts` (new)
- **Acceptance**: `brain_digest` output includes the new fields; markdown section `## Trust` shows the verdict and counts.
- **Depends on**: A5, C1, C4.
- **Commit**: `feat(digest): surface trust verdict and uncertainty counts in digest`

### C6: brain_operator_summary MCP tool
- **Files**:
  - `src/mcp/brain-tools.ts` (modify - register `brain_operator_summary` tool in the full scope; handler delegates to `buildOperatorSummary`)
  - `tests/mcp/operator-summary-tool.test.ts` (new)
  - `tests/mcp/mcp.test.ts` (modify - registry includes the new tool name)
- **Acceptance**: MCP tool listed in full scope (not writer scope); JSON-RPC call returns the structured envelope.
- **Depends on**: H7.
- **Commit**: `feat(mcp): add brain_operator_summary tool in full scope`

### C7: o2b brain summary CLI verb
- **Files**:
  - `src/cli/brain/verbs/summary.ts` (new)
  - `src/cli/brain.ts` (modify - dispatch case)
  - `src/cli/brain/help-text.ts` (modify - BRAIN_HELP entry + VERB_HELP[summary])
  - `tests/cli/brain/summary.test.ts` (new)
  - `tests/cli/help-text.test.ts` (modify - assert new verb is listed)
- **Acceptance**: `o2b brain summary` prints markdown by default, `--json` prints JSON, both match the `buildOperatorSummary` envelope.
- **Depends on**: H7.
- **Commit**: `feat(cli): add o2b brain summary verb`

## Phase 5 (docs)

### D1: CHANGELOG + README + how-it-works
- **Files**:
  - `CHANGELOG.md` (one `[0.10.16]` entry per playbook rule "one PR = one CHANGELOG version")
  - `README.md` (add trust + operator dashboard line under features list)
  - `docs/how-it-works.md` (one paragraph describing the trust layer)
- **Acceptance**: docs reference the new tool and verb; no `[Unreleased]` section anywhere.
- **Depends on**: all of C1-C7 merged conceptually (this is the last code commit in the implementation phase).
- **Commit**: `docs: v0.10.16 trust and operator surfaces`

## Phase 5b (version bump)

### V1: bump 0.10.15 to 0.10.16 across all 8 manifests
- **Files**:
  - `package.json`
  - `.claude-plugin/plugin.json`
  - `.codex-plugin/plugin.json`
  - `openclaw.plugin.json`
  - `plugin.yaml`
  - `plugins/codex/.codex-plugin/plugin.json`
  - `plugins/hermes/plugin.yaml`
  - `pyproject.toml`
- **Acceptance**: `bun run sync-version:check` returns ok.
- **Depends on**: D1.
- **Commit**: `chore: bump version to 0.10.16`

## Notes on TDD discipline

- Every helper module ships its test in the same commit. Tests fail first, then pass after implementation lands.
- The dream and doctor changes (C1, C4) update existing tests with extended assertions plus add new tests for the new behaviour. Existing snapshot tests get regenerated to include the new fields.
- The assess-rule-quality test fixture must NOT include any specific-language vague-word string as a target case to reject. All reject cases must hinge on structure (empty, single token, no operator-shape).
- No new dependencies added. All helpers use Node.js built-ins and existing OSB path helpers.
