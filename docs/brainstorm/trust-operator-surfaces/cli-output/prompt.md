You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship eight related features as one Open Second Brain release under the
theme "trust the brain's self-reporting". The bundle extends the
existing `brain_doctor`, `brain_digest`, `brain_dream`, and
`brain_feedback` surfaces (and the daily JSONL log) without rewriting
them. The eight kanban tasks:

1. **Verification delta** (`t_e952d03a`) - an independent layer that
   compares dream-pass outcomes (or `brain_apply_evidence` results)
   against actual vault state with explicit verdicts: `confirmed`
   (preference applied correctly), `drift` (preference exists but
   deviates from intent), `regression` (preference was applied but
   later undone), `missing_evidence` (claimed preference has no
   supporting artifact). Today `brain_dream` and `brain_doctor` warn
   on bad state but no independent verification step exists.
   Codegraph hints: `src/core/brain/dream.ts:91`
   (`DreamWarning`), `src/core/brain/dream.ts:191` (`dream` returns
   `DreamRunSummary` with `new_unconfirmed/confirmed/retired/
   suppressed/warnings` arrays but no verification states),
   `src/core/brain/claude-memory-plan.ts:22` (manifest-level
   sha256 verification, file-level only).

2. **Trust report** (`t_3440fa2c`) - a vault-level health verdict:
   `clean` (no contradictions, dream pass clean, no broken pages),
   `watch` (some contradictions, non-primary dream runs, minor
   frontmatter issues), `investigate` (corrupted files, duplicate
   IDs, unresolved contradictions). Compresses many signals into one
   verdict without hiding their breakdown.
   Today `brain_doctor` returns `RunDoctorResult` with severity
   `warning`/`error` but no aggregate verdict.

3. **Operator dashboard** (`t_dd9a602e`) - one unified report
   aggregating dream results, preference status distribution,
   contradiction count, signal quality metrics, recent log events,
   trust verdict (from #2), top-N suggested actions (from v0.10.15
   action-scorer), and basic vault stats. Replaces the current
   pattern of running `brain_digest` + `brain_doctor` separately.
   Codegraph hints: `src/mcp/brain-tools.ts` (each tool is a separate
   handler today), `src/core/brain/digest.ts:236` (`DigestJson`),
   `src/core/brain/doctor.ts:99` (`RunDoctorResult`).

4. **Uncertainty surfacing** (`t_87acf4a2`) - brain operations
   (dream, doctor, digest) must surface "I tried but cannot
   confirm" cases as explicit `uncertain` entries rather than
   silently dropping. Extend `DreamRunSummary` with an `uncertain`
   list; extend `DoctorReport` similarly.

5. **Preference rule quality gate** (`t_dec0494f`) - reject vague,
   non-testable principles at `brain_feedback` time. The detector
   must be language-agnostic - no hardcoded vague-word lists in any
   specific language. Use structural heuristics: principle length,
   absence of imperative verbs (detected by token-shape, not by
   vocabulary), absence of measurable nouns/numbers, ratio of
   modal/hedge tokens, missing observable outcome.
   Codegraph hints: `src/core/brain/sessions/validate-feedback.ts`
   (`validateBrainFeedbackInput` validates structure but not
   semantic quality).

6. **Instruction file compliance ceiling** (`t_2c01f589`) - cap
   `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / vault-root instruction
   files at ~200 lines. Past this, compliance drops sharply.
   Surface as a `brain_doctor` warning when a tracked instruction
   file exceeds the ceiling, with a configurable threshold.
   Codegraph hints: `src/core/brain/sessions/claude.ts:28`
   (`ClaudeBlock`), `src/core/brain/policy.ts:958` (`splitLines`).

7. **Dreamer self-approval guardrail** (`t_0a364afc`) - the dream
   pass must not auto-promote a signal to `confirmed` based on its
   own clustering alone. Require a configurable evidence threshold
   (minimum signal count, cross-agent corroboration, time-weighted
   recurrence) before promotion; signals below threshold land in
   quarantine instead of confirmed.
   Codegraph hints: `src/core/brain/dream.ts:191` (`dream` handles
   both clustering and promotion in one pass), `src/core/brain/
   policy.ts:226` (`loadBrainConfig` already loads brain config -
   add a `promotion_threshold` field).

8. **Role-separated brain permission boundaries** (`t_ae0a2db2`) -
   explicit per-operation restrictions on what each brain tool may
   change. brain_feedback cannot auto-confirm preferences;
   brain_dream cannot delete logs or preferences without
   `retired/` transition; brain_apply_evidence cannot modify
   `confirmed` status without going through retirement.
   Codegraph hints: `src/mcp/brain-tools.ts` (no role barrier),
   `src/core/brain/preference.ts:92` (status field, no permission
   check).

The eight features cluster naturally around three layers:

- **Atoms layer**: data-shape additions on existing summaries
  (`uncertainty` arrays, `verification_delta` entries on dream
  output, `trust_verdict` field on doctor output, `promotion_*`
  config), plus a quality gate helper on the validate-feedback
  path, plus a role-permission helper.
- **Helpers layer**: pure functions that compose atoms into named
  surfaces - `computeTrustVerdict(doctorReport, dreamSummary,
  warnings)`, `computeVerificationDelta(vault, dreamSummary,
  log)`, `assessRuleQuality(principle)` (language-agnostic), and
  `checkRolePermission(tool, operation, currentState)`.
- **Consumers layer**: the operator-facing dashboard tool
  (`brain_operator_summary` or extend `brain_digest`), plus
  any new CLI verbs (`o2b brain summary`, `o2b brain verify`,
  `o2b brain trust`), plus changes to existing tools (the dream
  pass uses the self-approval guardrail; brain_feedback uses the
  quality gate; brain_doctor uses the instruction file ceiling
  check and the trust verdict).

# Project context

**Project**: Open Second Brain, TypeScript on Bun runtime, MIT.
Files under `src/core/brain/` (~50 files, ~25k LOC), `src/mcp/`,
`src/cli/brain/verbs/` (one verb per file), tests under
`tests/core/brain/` with the same shape.

**Recent commits (last 20)**:
```text
a84ddaa chore: bump version to 0.10.15
d045ea1 chore: bump version to 0.10.15 (#31)
5755200 v0.10.15: vault care bundle - metadata, dedup, lint, context-pack, actions (#30)
9d9636b feat: index fastpath, PEM/JWT redaction, vault connection health (v0.10.14) (#29)
7d81f0b feat: codegraph-partner skill + o2b doctor check (v0.10.13) (#28)
0462b91 feat: v0.10.12 operational friction reduction (#27)
9d8af95 v0.10.11: Multi-runtime install orchestrator + Most-applied in digest (#26)
3e297a5 v0.10.10: Pull channels - brain_context tool (#25)
73e85a1 v0.10.9: Vault scope - single ignore policy (#24)
e85523c v0.10.8: Retire event_log_append + JSONL sidecar (#23)
```

**Conventions and constraints** (from CHANGELOG, README, active
Brain preferences, prior PRs):

- Layered DAG: every new feature drops as a peer module in the
  matching layer; never re-cut the schema. Atoms (data-shape) -
  helpers (pure functions) - consumers (CLI / MCP surfaces). New
  modules sit next to existing ones (`src/core/brain/page-meta/`,
  `src/core/brain/maintenance/` are precedents from v0.10.15).
- Tests live in `tests/core/brain/<area>/` mirroring source paths.
  `bun test` is the runner; current tree has 1865+ tests passing.
- Language-agnostic by construction. v0.10.15 explicitly removed a
  CJK / Hangul character class and replaced it with
  `ceil(utf8_bytes / 4)`. Same rule applies to the quality gate
  (#5): the detector must not embed any per-language vocabulary
  list, regex of vague words, or stop-word set. Use structural
  shape (token count, modal-token ratio detected by token-class,
  not by literal match) only.
- No backwards-compat shims. Existing pages are NOT rewritten by
  this release. Add read-side defaults; only new writes opt in.
- One PR = one CHANGELOG version. The bundle ships as v0.10.16
  with one CHANGELOG entry.
- Hermes convention discipline. Do not propose any change that
  diverges from Hermes' kanban schema or expected behaviour.
- No on-chain anchoring, no Solana memo. (Explicitly out of scope
  for this project.)
- Existing surfaces to extend without rewriting:
  - `brain_doctor` returns `RunDoctorResult { warnings, errors,
    suggested_actions }`. Add `trust_verdict`, `uncertain`,
    `verification_delta`, `instruction_file_warnings`.
  - `brain_dream` returns `DreamRunSummary { new_unconfirmed,
    confirmed, retired, suppressed, contradictions, warnings, ... }`.
    Add `uncertain`, `quarantined` (for self-approval guardrail).
  - `brain_digest` returns `DigestJson` (already has `actions`
    field from v0.10.15). Add `trust_verdict`, `uncertain_count`,
    `quarantined_count` summary fields.
  - `brain_feedback` validates payload via
    `validateBrainFeedbackInput`. Add a quality-gate check that
    can reject with a structured reason.
- One new MCP tool is fine; multiple is also fine. Last release
  added one (`brain_context_pack`). Consider whether the
  operator dashboard belongs as a new tool (`brain_operator_summary`)
  or as an extension to `brain_digest`.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

## Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

## Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the
others, considering the project context and constraints above.

Output nothing outside of these sections.
