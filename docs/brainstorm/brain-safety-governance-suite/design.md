# Brain Safety & Governance Suite - deterministic surfaced-context guard and governance previews

**Status:** draft
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain stores operator-authored and agent-authored Markdown, then automatically surfaces selected snippets through MCP tools, context packs, pre-compress packs, exports, and session-derived recall. The existing private-region and secret redactors protect sensitive values, but they do not distinguish factual memory content from instructions aimed at the consuming agent. This release adds a deterministic safety spine for surfaced Brain context and establishes preview-first governance contracts for larger destructive workflows.

## Scope

- Ship a deterministic prompt-injection guard for automatically surfaced Brain snippets in context packs, pre-compress packs, and MCP preview paths.
- Preserve existing private-region and secret redaction behavior while adding inspectable safety reasons for filtered content.
- Allow explicitly trusted instruction surfaces without disabling the default guard for ordinary Brain notes.
- Add agent-blind secret references using `$secret:NAME` with local-process resolution, redacted status/list output, known-value redaction, and explicit missing-secret failures.
- Add preview/foundation surfaces for source-scoped forget plans, privacy-scanned knowledge packs, and oversized payload externalization so destructive apply paths can land in later releases behind tested manifests.
- Update docs and version metadata for a single bundled release.

## Out of scope

- LLM-based safety classification.
- Automatic rewriting, deletion, or quarantine of source vault files.
- Full destructive hard-forget apply across all derived artifacts.
- Full knowledge-pack install/uninstall mutation.
- Payload registry eviction or media lifecycle management beyond explicit retrieval and doctor/reporting foundations.
- Remote secret managers; this release resolves `$secret:NAME` from trusted local environment boundaries.

## Chosen approach

Use Variant 3: Security Spine Deep, Governance Foundation Preview-Only. The prompt-injection guard and secret-reference boundary ship as fully enforced safety features because they protect existing automatic surfacing and configuration paths. The hard-forget, portable pack, and payload registry tasks ship as deterministic preview/foundation slices so later destructive or mutating workflows build on stable manifests rather than guessing at scope.

## Design decisions

- Add a small shared `core/brain/safety` contract rather than a broad security kernel. Shared reason IDs, placeholders, and report shapes prevent output drift without forcing every governance feature into one abstraction.
- Run the context guard at read/surfacing boundaries, not at write time. Source Markdown remains unchanged, while automatically injected outputs become safe by default.
- Treat allowlisting as explicit source trust, not text-pattern trust. Trusted instruction files should carry a clear metadata signal or tool-controlled source classification; ordinary notes remain guarded even if their wording looks official.
- Keep redaction order conservative: private-region stripping and secret-value redaction remain intact, and the prompt-injection guard operates on the content that would otherwise be surfaced.
- Resolve `$secret:NAME` only inside trusted local process code. Agent-facing outputs report the reference name and provider state, never the resolved value.
- Use preview manifests for forget, pack, and payload features. Each preview returns counts, provenance, hashes, warnings, and reason IDs; mutating apply operations are deferred.
- Keep public APIs additive. Existing CLI/MCP commands retain their current basic outputs while gaining safety fields where automatic surfacing already returns snippet content.

## File changes

- New: `src/core/brain/safety/context-guard.ts` for deterministic prompt-injection classification, sanitization, allowlist metadata handling, and reason reports.
- New: `src/core/brain/safety/secret-ref.ts` for `$secret:NAME` parsing, local env resolution, missing-provider errors, and known-value redaction helpers.
- New: `src/core/brain/governance/forget-plan.ts` for dry-run source-closure manifests without deletion.
- New: `src/core/brain/packs/pack.ts` for privacy-scanned pack export and preview manifests.
- New: `src/core/brain/payload-registry.ts` for oversized payload detection, placeholder metadata, bounded retrieval, and doctor checks.
- Modified: `src/core/brain/context-pack.ts`, `src/core/brain/pre-compress-pack.ts`, `src/mcp/brain-tools.ts`, `src/mcp/server.ts`, and `src/mcp/artifact-store.ts` to apply safety reports where content is surfaced.
- Modified: `src/core/config.ts`, `src/cli/main.ts`, and CLI brain verb dispatch for secret status/list and governance preview commands.
- Tests: add focused unit and CLI/MCP integration tests under `tests/core/brain/`, `tests/core/`, `tests/cli/`, and `tests/mcp/`.
- Docs: update `README.md`, `docs/cli-reference.md`, `docs/mcp.md`, and `CHANGELOG.md`.

## Risks and open questions

- Pattern-based prompt-injection detection can over-filter. Tests must include ordinary notes with imperative language so the guard stays false-positive-safe.
- Unicode-obfuscated variants are bounded by deterministic normalization, not exhaustive adversarial detection. The goal is robust default surfacing, not a complete malware scanner.
- Secret-reference support starts with environment-backed local resolution. Future connector-specific providers should reuse the same resolver interface rather than exposing values to agents.
- Forget, pack, and payload preview schemas may need expansion when apply phases ship. Keep schemas versioned and include enough provenance to avoid migration pain.
