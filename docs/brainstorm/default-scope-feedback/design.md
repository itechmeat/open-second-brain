# Configurable default_scope for feedback signals design

## Problem

Open Second Brain feedback signals can carry an optional `scope` frontmatter field. When an agent or operator records feedback through `brain_feedback` or `o2b brain feedback` without passing `scope`, the resulting signal is intentionally scope-less. That preserves existing behavior, but it means agent-recorded signals can remain uncategorized even when a vault operator wants a consistent default category such as `coding`.

The release needs a small, vault-local default for feedback signal scope. The default must never override an explicit per-call scope, must keep existing output byte-identical when unset, and must not reuse unrelated owner-scope or guardrail settings that control visibility rather than categorization.

## Scope

- Add a vault-configurable default scope for feedback signal writes.
- Apply the default to both MCP `brain_feedback` and CLI `o2b brain feedback` writes.
- Preserve explicit per-call `scope` precedence.
- Preserve current behavior when no default is configured.
- Validate and sanitize the configured value through the same config and signal-field rules used by the rest of the Brain layer.
- Cover the default with focused tests for config parsing, CLI writes, MCP writes, and explicit-scope override.

## Out of scope

- Changing dream promotion logic, recall ranking, or application-scope matching.
- Introducing hardcoded scope category names.
- Migrating existing scope-less signal files.
- Changing `owner_scoped_facts`, vault ignore paths, guardrails, or fact visibility semantics.
- Changing morning-brief, activity-timeline, or generic time-helper behavior; this patch is only feedback signal defaulting.
- Adding a new release workflow, version bump, or deployment in this phase.

## Chosen approach

Use Variant 1: Core write-boundary fallback with policy-validated default.

Add an optional feedback config block in `Brain/_brain.yaml`, shaped as `feedback.default_scope`. The config loader validates that a provided default is a non-empty scalar compatible with the existing signal scope constraints. Signal construction then applies one precedence rule: explicit non-empty per-call scope wins; otherwise the configured default is used; otherwise the `scope` field is omitted exactly as it is today.

I agree with the consultant recommendation. The task is specifically about defaulting feedback signal construction, so placing the fallback at the signal write boundary gives the strongest CLI/MCP parity and avoids relying on each surface to remember a convention. The extra care is that `writeSignal` should remain deterministic and free of hidden global config reads: callers pass a validated default through an additive option or field, while `signal.ts` owns only the final precedence and sanitization rule.

## Design decisions

1. Use a dedicated `feedback.default_scope` config key.
   - The setting belongs to feedback signal categorization, not guardrails or owner-scoped recall.
   - `feedback` is optional; absent block means no default.
   - Use snake_case in `_brain.yaml`, matching existing config style.

2. Keep explicit scope precedence.
   - `brain_feedback({ scope: "docs" })` writes `docs` even when `feedback.default_scope: coding` exists.
   - `o2b brain feedback --scope docs` behaves the same way.
   - Empty or whitespace explicit values should not be treated as valid overrides.

3. Keep unset behavior byte-identical.
   - With no `feedback.default_scope` and no explicit scope, `writeSignal` omits scope frontmatter and scope tags exactly as it does now.
   - Existing parse behavior remains unchanged: files without `scope` parse as `undefined`.

4. Centralize the effective-scope rule at the write boundary.
   - Avoid two separate call-site-only implementations in CLI and MCP.
   - Add an optional `defaultScope` field to the existing signal write options, and have `signal.ts` compute the final scope from explicit input plus that validated default.
   - Do not make `signal.ts` load `_brain.yaml` itself; the writer should stay deterministic from its inputs.

5. Validate through Brain config policy.
   - Add types for `BrainFeedbackConfig` and include it optionally in `BrainConfig`.
   - Extend `validateBrainConfig` / related policy helpers to parse and validate `feedback.default_scope`.
   - Reuse signal `scope` sanitization constraints exactly: non-empty after trim, single-line, and at most the existing 128-character scope cap, so config and write behavior cannot diverge.
   - Surface invalid values through normal config validation and doctor checks rather than silently ignoring them.

6. Preserve language-agnostic behavior.
   - The system accepts an operator-provided slug-like string.
   - It must not infer categories from natural-language topic or principle text.

## File changes

Expected implementation touchpoints:

- `src/core/brain/types.ts` for `BrainFeedbackConfig` and optional `BrainConfig.feedback`.
- `src/core/brain/policy.ts` for config validation/default handling of `feedback.default_scope`.
- `src/core/brain/signal.ts` for the effective-scope write-boundary rule, implemented with an optional `defaultScope` write option rather than a hidden config read.
- `src/mcp/brain/feedback-tools.ts` to pass the validated config default into the signal write path for `brain_feedback` and force-confirmed preference creation if the effective scope is used there too.
- `src/cli/brain/verbs/feedback.ts` to pass the validated config default into the signal write path for `o2b brain feedback`.
- Focused tests under the existing CLI, MCP, core signal, and config test locations.
- `docs/cli-reference.md`, `docs/mcp.md`, and `CHANGELOG.md` for the user-visible config behavior in the implementation phase.

## Risks

- The writer API change can ripple to many tests if done as a required parameter. Mitigation: make the new option additive and optional.
- CLI and MCP can drift if effective scope is resolved only at call sites. Mitigation: keep final precedence in one core helper or write-boundary option.
- Invalid config could be silently ignored if validation is too loose. Mitigation: validate the field in policy and add a doctor/config test for invalid values.
- Force-confirmed preference creation could get a different scope than its source signal. Mitigation: compute one effective scope and reuse it for both signal and preference writes.
