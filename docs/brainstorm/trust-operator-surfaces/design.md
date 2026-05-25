# Trust and operator surfaces - design

**Status:** draft
**Author:** @claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain agents already capture preferences, run a deterministic dream pass, and surface digest / doctor reports. But the brain reports *what happened* without ever auditing *its own claims*. There is no independent verification step, no aggregate health verdict, no quality gate on incoming preferences, no guardrail against dream auto-promoting its own signals, and no unified operator view. Operators get the answer "all green" or "X warnings" with no consistent line between trustable claims and uncertain ones.

This release adds the missing trust layer: eight related self-reporting features that read existing brain state, compute verdicts, and surface them through one new aggregating tool plus extensions to the existing reporters.

## Scope

Eight features bundled as one release, all named in the kanban task ids:

1. **Verification delta** (`t_e952d03a`) - explicit `confirmed | drift | regression | missing_evidence` verdicts per preference against vault state.
2. **Trust report** (`t_3440fa2c`) - vault-level `clean | watch | investigate` health verdict aggregating doctor warnings, dream warnings, and verification-delta entries.
3. **Operator dashboard** (`t_dd9a602e`) - one MCP tool that aggregates digest + doctor + verification + trust + suggested actions into a single output.
4. **Uncertainty surfacing** (`t_87acf4a2`) - dream pass and doctor pass declare `uncertain` cases explicitly instead of silently dropping them.
5. **Preference rule quality gate** (`t_dec0494f`) - language-agnostic structural quality scorer at `brain_feedback` time, with reject reason.
6. **Instruction file compliance ceiling** (`t_2c01f589`) - doctor warning when tracked instruction files (CLAUDE.md, AGENTS.md, GEMINI.md) exceed a configurable line ceiling.
7. **Dreamer self-approval guardrail** (`t_0a364afc`) - evidence threshold before auto-promotion; signals below threshold land in quarantine.
8. **Role-separated brain permission boundaries** (`t_ae0a2db2`) - explicit per-operation restrictions on what each tool may change.

## Out of scope

- Cross-vault aggregation (one vault per call).
- LLM-driven semantic verification of preferences. Verification delta uses deterministic comparisons (does the artifact exist? does the page status match the dream claim?), not natural-language judgement.
- Per-user audit log persistence. Verdicts are computed on read, not stored.
- Backwards-compatible field migration. Existing preferences and retired pages are not rewritten; readers apply documented defaults when new fields are absent.
- Replacing existing tools. `brain_digest`, `brain_doctor`, `brain_dream`, `brain_feedback` keep their current contract; new fields are additive.

## Chosen approach

Variant 2 from the consultant pass. Introduce a new subsystem directory `src/core/brain/trust/` housing pure helpers that compute the new verdicts and gates. Atoms (new fields on existing summary types) live next to their existing types. The dashboard ships as one new MCP tool `brain_operator_summary` plus a CLI verb `o2b brain summary`. Existing tools (`brain_doctor`, `brain_dream`, `brain_feedback`, `brain_apply_evidence`, `brain_digest`) gain calls into the trust helpers but keep their current public contract.

Three layers, strict downward dependency:

```
atoms        - data-shape additions on existing summary types
                + new BrainGuardrailConfig in policy.ts
                + new BrainRole enum in trust/role.ts
helpers      - src/core/brain/trust/*.ts
                pure functions, no I/O, take atoms and read-only vault paths
consumers    - brain_dream uses self-approval-guardrail
                brain_doctor uses trust-verdict + instruction-file-ceiling + verification-delta
                brain_feedback uses assess-rule-quality
                brain_apply_evidence uses check-role-permission
                new brain_operator_summary tool composes the above
                new o2b brain summary CLI verb
                brain_digest reads trust_verdict / uncertain_count / quarantined_count
```

## Design decisions

- **Subsystem name `trust/`** rather than `governance/` or `gates/`. It matches the release theme "trust the brain's self-reporting" and is short enough for daily use. v0.10.15 set the precedent (`page-meta/`, `maintenance/`).
- **No new persistence**. All four new verdicts (`trust_verdict`, `verification_delta`, `uncertain`, `quarantined`) are computed on read from existing vault state. No new files, no new directories under `Brain/`.
- **Quality gate is language-agnostic, shape-based only**. The detector uses three structural heuristics:
  1. **length and token count** - empty or single-token principles are rejected; very long ones (over a fixed byte / token threshold) are warned.
  2. **measurable-signal presence** - any token containing a digit (`/\d/` codepoint test), or any token containing an operator-shape character (`>`, `<`, `=`, `%`). If neither is found anywhere in the principle, the principle is warned as non-testable.
  3. **filler ratio** - the proportion of single-character alphanumeric tokens to total tokens, after stripping punctuation. Above a fixed threshold, the principle is warned.

  The detector never matches against language-specific vocabulary, never imports any locale data, never enumerates unit or stopword lists. Tokenisation is whitespace-based and operates on raw codepoints.
- **Self-approval guardrail uses `BrainGuardrailConfig`**, a new section of `brain.config.yaml`, with three configurable thresholds: `min_signals` (default 2), `min_distinct_agents` (default 1), `min_age_days` (default 0, i.e. disabled). Backwards-compatible defaults keep current behaviour bit-identical when the config is absent.
- **Role permission model**. Three roles: `writer` (brain_feedback), `dreamer` (brain_dream), `applier` (brain_apply_evidence). Each role gets a static allow-list of `(target_status, transition)` pairs. The helper rejects attempts to cross a role boundary with a structured error; tools surface this error rather than silently failing.
- **Instruction file ceiling** is configurable via `BrainGuardrailConfig.instruction_file_max_lines` (default 200). Files discovered: vault-root `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`. Discovery is by existence, not by pattern - if the file is not there, no warning is emitted.
- **Verification delta states**:
  - `confirmed` - preference page exists, status matches dream claim, evidence count above zero.
  - `drift` - preference page exists, status matches, but evidence count is zero (claimed applied but no artifact ever recorded).
  - `regression` - preference page exists with status `retired` although dream most-recently claimed `confirmed`.
  - `missing_evidence` - dream summary references a `pref-*` id with no corresponding file under `Brain/preferences/` or `Brain/retired/`.
- **Trust verdict thresholds**:
  - `clean` - zero doctor errors, zero dream warnings, zero verification-delta entries with state `drift` / `regression` / `missing_evidence`.
  - `watch` - any doctor warnings or dream warnings or up to N verification-delta entries (configurable, default 3) where N counts only `drift`.
  - `investigate` - any doctor errors, or more than N drift entries, or any `regression` or `missing_evidence` entries.
- **brain_operator_summary tool**. New MCP tool registered in the full scope only (writer scope keeps its four-tool surface per v0.10.10). Returns a structured JSON envelope: `trust_verdict`, `digest_summary`, `doctor_summary`, `dream_summary` (most recent), `verification_delta`, `top_actions` (from action-scorer), `instruction_file_warnings`. Markdown rendering for the CLI verb derives from the same JSON.

## File changes

### New files (~24)

```
src/core/brain/trust/
  role.ts                          (BrainRole enum, BrainOperation type)
  check-role-permission.ts         (helper)
  assess-rule-quality.ts           (language-agnostic structural scorer)
  compute-verification-delta.ts    (vault scanner -> VerificationDeltaEntry[])
  compute-trust-verdict.ts         (aggregator -> TrustVerdict)
  instruction-file-ceiling.ts      (read tracked files, return warnings)
  self-approval-guardrail.ts       (signal threshold check)
  operator-summary.ts              (top-level composer; JSON + markdown renderer)
tests/core/brain/trust/
  role.test.ts
  check-role-permission.test.ts
  assess-rule-quality.test.ts
  compute-verification-delta.test.ts
  compute-trust-verdict.test.ts
  instruction-file-ceiling.test.ts
  self-approval-guardrail.test.ts
  operator-summary.test.ts
src/cli/brain/verbs/
  summary.ts                       (o2b brain summary verb)
tests/cli/brain/
  summary.test.ts
tests/mcp/
  operator-summary-tool.test.ts
docs/brainstorm/trust-operator-surfaces/
  design.md
  plan.md
  variants.md
  cli-output/prompt.md
  cli-output/claude.md
.ai-notes/images/
  v0.10.16-trust.excalidraw        (release-time)
  v0.10.16-trust.png               (release-time)
```

### Modified files (~24)

```
src/core/brain/dream.ts            (uncertain[], quarantined[] in DreamRunSummary;
                                    invoke self-approval-guardrail)
src/core/brain/doctor.ts           (trust_verdict, verification_delta_summary,
                                    instruction_file_warnings, uncertain in
                                    RunDoctorResult; invoke trust helpers)
src/core/brain/digest.ts           (trust_verdict, uncertain_count,
                                    quarantined_count derived fields in DigestJson)
src/core/brain/sessions/validate-feedback.ts
                                   (invoke assess-rule-quality; structured reject reason)
src/core/brain/apply-evidence.ts   (invoke check-role-permission for confirmed transitions)
src/core/brain/policy.ts           (BrainGuardrailConfig section)
src/mcp/brain-tools.ts             (register brain_operator_summary;
                                    new fields surface through brain_digest / doctor)
src/cli/brain.ts                   (dispatch case for summary verb)
src/cli/brain/help-text.ts         (BRAIN_HELP entry; VERB_HELP[summary])
README.md                          (features paragraph mentions trust + dashboard)
CHANGELOG.md                       (one [0.10.16] entry)
docs/how-it-works.md               (trust layer paragraph)
package.json                       (version 0.10.16; phase 5b)
.claude-plugin/plugin.json         (version 0.10.16; phase 5b)
.codex-plugin/plugin.json          (version 0.10.16; phase 5b)
openclaw.plugin.json               (version 0.10.16; phase 5b)
plugin.yaml                        (version 0.10.16; phase 5b)
plugins/codex/.codex-plugin/plugin.json (version 0.10.16; phase 5b)
plugins/hermes/plugin.yaml         (version 0.10.16; phase 5b)
pyproject.toml                     (version 0.10.16; phase 5b)
tests/core/brain/dream.test.ts     (expectations for new fields)
tests/core/brain/doctor.test.ts    (expectations for trust verdict, ceiling)
tests/core/brain/digest.test.ts    (snapshot extends for new fields)
tests/mcp/mcp.test.ts              (registry includes brain_operator_summary)
tests/cli/help-text.test.ts        (BRAIN_HELP includes summary verb)
```

Expected total: ~48-52 file changes.

## Risks and open questions

- **Quality gate false positives**. A truly terse but valid principle (e.g., a single imperative followed by a measurable outcome in a non-Latin script) must not be rejected. Mitigation: structural heuristics use lower bounds (too short OR no measurable structure) not vocabulary, and the gate emits a warning rather than a hard reject below a low threshold; only outright shape failures (empty, single token, no verb-like structure detectable via token-position only) become hard rejects.
- **Trust verdict noise floor**. If `watch` is too easy to trigger, operators ignore it. Mitigation: thresholds are conservative (one doctor warning alone does not trigger `watch`; only verification-delta entries or doctor warnings combined with other signals do).
- **Self-approval guardrail backwards compatibility**. Adding even one signal-count gate could prevent legitimate promotions on vaults with low signal volume. Mitigation: `min_signals` defaults to 2 (same as the existing dream behaviour after v0.10.5), so the guardrail is currently a documented codification, not a regression. Explicit opt-in to stricter thresholds via config.
- **Instruction file discovery**. Files outside the vault root (e.g. project-level `CLAUDE.md`) are not in scope - this release only checks the vault root. Future scope can extend discovery without changing the ceiling logic.
- **brain_operator_summary overlap with brain_digest**. Both can answer "what's going on in this vault". Mitigation: digest is preference-and-signal-focused (what's accumulating, what's most-applied); operator summary is trust-and-state-focused (is the vault healthy, what should I do next). Both reference each other in their help text.
- **Open question deferred to implementation**: whether `verification_delta` runs on every doctor call (cheap but does extra I/O) or only on `brain_operator_summary` (saves I/O on the hot path). Default during implementation: lazy - doctor reports a count, operator summary reports the full list.
