# CodeGraph and MCP operational readability design

## Problem

Open Second Brain has two adjacent graph operations that are hard for agents to inspect precisely. The optional `codegraph` partner check tells an operator whether a code project is indexed, but it does not expose a structured report that answers Rust workspace questions such as which Cargo workspace members were detected and whether crate-level dependency information is available. The Brain cluster surface runs deterministic community detection, but the only tunable control is `min_size`; large-vault operators do not have a documented, option-gated way to run the pass in bounded chunks or inspect partial progress without changing the default behavior.

The release must improve operational readability without turning Graphify into an owned Open Second Brain dependency, without adding natural-language labeling, and without changing existing default reads.

## Scope

- Add a first-class, read-only CodeGraph report surface for CLI and MCP consumers.
- Detect Cargo workspace membership structurally from `Cargo.toml` when a code project is in scope.
- Report partner status honestly: CLI absent, project not indexed, status unavailable, or indexed with known counts.
- Add an option-gated batched cluster run path that keeps the existing default `brain_clusters` behavior byte-identical when no batch option is supplied.
- Document and test the new surfaces through focused unit and CLI or MCP coverage.

## Out of scope

- Installing, initializing, or mutating `codegraph` or Graphify indexes.
- Adding `crate_depends_on` to the Open Second Brain graph schema.
- Introducing LLM-generated community labels.
- Replacing deterministic label propagation with a third-party graph algorithm.
- Changing the default `o2b doctor`, `o2b brain clusters run`, or existing MCP output when no new option is used.

## Chosen approach

Use Variant 2: Dedicated operational-readability reporting layer.

Add a read-only CodeGraph report surface, exposed as `o2b partner codegraph report` and `brain_codegraph_report`, backed by a core reporter module rather than by `doctor` formatting. The CLI work therefore includes a small top-level `partner` dispatcher wired from `src/cli/main.ts`; it is not a `brain` verb because it reports on an external code-project partner, not on vault memory content. The reporter composes existing code-project discovery and status checks with a small Cargo workspace reader that parses only structural manifest fields needed for membership reporting. It returns a schema-versioned object with explicit absent-data reasons instead of guessing or fabricating crate edges.

For community operations, add an explicit batch option to the existing cluster run surface. The default path continues to call `detectCommunities` as it does today. When a batch option is provided, a separate orchestration path chunks cluster-note materialization and accumulates per-batch results or errors without changing the deterministic detection contract or adding LLM-generated labels.

We agree with the consultant recommendation. The two cards are about operational readability, so a discoverable report surface is more useful than burying richer text inside `doctor`, and it avoids the overreach of adding a new graph edge schema.

## Design decisions

1. Keep partner integration optional and read-only.
   - The reporter may inspect local manifests and call existing status helpers.
   - It must not run initialization, extraction, or writes.
   - Missing CLI and missing indexes are normal report states, not unhandled failures.

2. Make Cargo workspace support structural.
   - Parse `Cargo.toml` for `[workspace]` and `members` only.
   - Resolve member globs conservatively under the project root.
   - Report `cargo_workspace: null` with a reason when no workspace is present.
   - Do not infer dependency edges from prose or external command output that is not explicitly structured.

3. Separate report code from doctor checks.
   - Existing `checkCodegraph` remains doctor-grade and compatible.
   - New report code can reuse `findCodeProjects` and status helpers, but should have its own return type and tests.
   - CLI and MCP wrappers should be thin delegations over the core report.

4. Keep cluster batching option-gated.
   - Existing calls without `batch_size` or `--batch-size` must keep the current result shape and deterministic behavior.
   - Batched mode should use typed validation for positive integer limits.
   - Batch failures should be returned as explicit per-batch errors while successful batches remain visible.

5. Preserve language-agnostic behavior.
   - No natural-language keyword lists for project or community classification.
   - Use manifests, graph structure, typed fields, and explicit operator input only.

## Report contracts

The CodeGraph report should be stable enough for MCP consumers to branch on without scraping prose. Required top-level fields: `schema_version`, `projects`, and `generated_at`. Each project entry reports `path`, `is_code_project`, `codegraph` status (`cli_missing`, `not_indexed`, `status_unavailable`, or `indexed` with available count fields), and `cargo_workspace` (`null` plus `reason`, or `{ root, members }`). Do not expose `crate_depends_on` unless a future release adds that graph schema deliberately.

Batched cluster mode should be explicit in both CLI and MCP inputs as `batch_size` / `--batch-size`. In batched mode, return the same community summaries as the default run plus a `batches` array containing `index`, `start`, `end`, `written`, `removed`, and optional `error`. Without `batch_size`, do not include `batches` and keep the existing output shape.

## File changes

Expected implementation touchpoints:

- `src/core/partner/codegraph-report.ts` for structured CodeGraph report types and Cargo workspace inspection, reusing `src/core/partner/codegraph.ts` discovery/status helpers where practical.
- `src/cli/partner.ts`, `src/cli/main.ts`, and `src/cli/command-manifest.ts` for the `o2b partner codegraph report` command, command dispatch, help text, and JSON contract.
- `src/mcp/brain/knowledge-tools.ts` for `brain_codegraph_report`, unless implementation review shows the MCP brain tool table has been split before this card starts.
- `src/core/brain/link-graph/communities.ts`, `src/cli/brain/verbs/clusters.ts`, and `src/mcp/brain/knowledge-tools.ts` for option-gated batching.
- `tests/core/partner/codegraph.test.ts`, `tests/cli/partner-codegraph-report.test.ts`, and/or focused MCP parity coverage for the new report.
- `tests/cli/brain-clusters.test.ts` and `tests/mcp/link-recall-tools.test.ts` for batch validation and default-output regression.
- `docs/cli-reference.md`, `docs/mcp.md`, and `CHANGELOG.md` for user-visible surfaces.

## Risks

- The CodeGraph report can drift into partner ingestion. Mitigation: keep it read-only and explicitly report absent data rather than adding schema edges.
- Cargo manifest parsing can become too broad. Mitigation: parse only workspace membership for this release and cover common missing/malformed cases.
- Cluster batching can accidentally change default results. Mitigation: preserve the existing path when no batch option is supplied and add a regression test proving default output stability.
- New CLI/MCP surface area increases documentation burden. Mitigation: keep wrappers thin and document the structured result once in the CLI and MCP references.
