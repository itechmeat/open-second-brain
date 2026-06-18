## Variant 1: Core write-boundary fallback with policy-validated default
Approach: Add an optional `feedback.default_scope` field to `BrainConfig`, validated and normalized in `policy.ts` alongside the other resolved config blocks (invalid values surfaced through config validation and `brain_doctor`). The precedence logic lives in exactly one place: `sanitiseSignalInput`/`writeSignal` in `signal.ts` gains the rule "use explicit scope if present and non-empty, else fall back to the configured default, else omit." Both CLI and MCP keep loading config and pass the resolved default into the core write, so the decision rule itself cannot diverge between surfaces.
Trade-offs:
- Structural CLI/MCP parity: precedence and sanitization are defined once at the chokepoint every signal write already funnels through, so the two surfaces cannot drift.
- Byte-identical preservation is trivial and self-evident: the fallback fires only when explicit scope is absent and a default is configured, so absent-default plus absent-explicit leaves the existing omit path untouched.
- Touches a widely-used core signature (`WriteSignalInput`/`writeSignal`), so the change surface reaches core types and every caller, requiring care that the additive field stays optional and defaulted.
Complexity: medium
Risk: medium

## Variant 2: Shared call-site resolver helper
Approach: Leave `signal.ts` completely untouched; it continues to write `scope` only when present. Add one small pure helper, `resolveSignalScope(explicit, configuredDefault)`, that both `feedback-tools.ts` and `feedback.ts` call to compute the effective scope before building `signalInput`, replacing the current `...(scope ? { scope } : {})` spread. The `feedback.default_scope` config field is read at each surface and handed to the helper.
Trade-offs:
- Smallest, most contained change: core write path and its tests are entirely unaffected, and the helper is trivially unit-testable in isolation for all four precedence cases.
- Parity depends on discipline rather than structure: two call sites must each adopt the helper and pass config, and a future third writer could forget it, so consistency is a convention not a guarantee.
- Validation/normalization placement is ambiguous: without a central resolver the helper must either re-sanitize the configured default at each call or trust raw config, risking duplicated logic or an unvalidated default reaching the write.
Complexity: small
Risk: low

## Variant 3: Resolved feedback-policy object in policy.ts
Approach: Extend the existing resolved-defaults pattern in `policy.ts` so `loadBrainConfig` produces a normalized, validated `feedback` policy object (for example a resolved `defaultScope`) exactly as it already does for other feature blocks. Call sites consume only the resolved object, never raw `_brain.yaml` values, and invalid defaults are caught once at load time and reported through validation and `brain_doctor`.
Trade-offs:
- Single source of truth for the resolved default with validation and doctor surfacing centralized, matching how the codebase already treats other config blocks.
- Both surfaces stay thin and read a pre-validated value, but the actual precedence decision still happens at each call site unless paired with a core or helper application point, so it solves validation cleanly without fully solving parity on its own.
- Most plumbing of the three: introduces a resolved feedback block, its type, validation, and defaulting, which is more scaffolding than a strictly additive optional field needs for one scalar.
Complexity: medium
Risk: low

## Recommended: Variant 1
Rationale: It places the default exactly where the task identifies its natural home (signal construction in `signal.ts`, with explicit per-call scope overriding), and it is the only option that makes CLI/MCP parity structural rather than conventional, because the precedence and sanitization rule lives at the single write chokepoint both surfaces already share. The byte-identical guarantee falls out of the design directly: the fallback is reachable only when an explicit scope is absent and a default is configured. It also satisfies the misleading-fallback constraint by validating and normalizing the configured default in `policy.ts` with `brain_doctor` surfacing, borrowing the same resolved-config discipline that makes Variant 3 attractive while avoiding that variant's extra scaffolding for a single scalar. The medium risk is confined to keeping one new field optional and defaulted on the core write signature, which is the codebase's normal additive approach.
