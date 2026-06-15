# CodeGraph and MCP operational readability implementation plan

Branch: `feat/codegraph-mcp-operational-readability`
Design: `docs/brainstorm/codegraph-mcp-operational-readability/design.md`

## t_a1e76788 - [upstream:graphify] Cargo workspace dependency extraction for Rust projects

### Files

- `src/core/partner/codegraph.ts` or `src/core/partner/codegraph-report.ts`
- `src/cli/...` for the `o2b partner codegraph report` command and help text
- `src/mcp/brain/knowledge-tools.ts` or the current MCP registration module for `brain_codegraph_report`
- `tests/core/partner/codegraph.test.ts`
- Focused CLI or MCP tests for the report wrapper
- `docs/cli-reference.md`
- `docs/mcp.md`
- `CHANGELOG.md`

### Acceptance

A focused test suite passes that proves:

- A Rust project with a structural `Cargo.toml` workspace reports workspace members.
- A non-Rust project reports `cargo_workspace: null` with an explicit reason.
- Missing `codegraph` CLI and missing `.codegraph/` are represented as honest report states rather than thrown failures.
- The CLI and MCP wrappers return the core report shape without mutating the project or vault.

Suggested verification command for the worker:

```bash
bun test tests/core/partner/codegraph.test.ts <new focused CLI or MCP test file>
bun run typecheck
```

### Depends on

No sibling task needs to land first. Build this as the first card if possible, because it establishes the dedicated report surface and naming conventions that the release docs can reuse.

## t_a286135c - [upstream:graphify] Multi-batch community labeling for large graphs

### Files

- `src/core/brain/link-graph/communities.ts`
- `src/cli/brain/verbs/clusters.ts`
- `src/mcp/brain/knowledge-tools.ts`
- `tests/cli/brain-clusters.test.ts`
- `tests/mcp/link-recall-tools.test.ts` or the current MCP cluster test file
- `docs/cli-reference.md`
- `docs/mcp.md`
- `CHANGELOG.md`

### Acceptance

A focused test suite passes that proves:

- Existing `brain_clusters` and `o2b brain clusters run` output remains unchanged when no batch option is supplied.
- Invalid batch sizes fail with typed validation or usage errors.
- Batched mode processes cluster note materialization in bounded chunks and reports per-batch successes and failures explicitly.
- The implementation does not introduce LLM labeling, natural-language classification, or a Graphify dependency.

Suggested verification command for the worker:

```bash
bun test tests/cli/brain-clusters.test.ts <new focused MCP test if added>
bun run typecheck
```

### Depends on

Prefer running after `t_a1e76788` on the same branch so shared release documentation and changelog entries can build on the CodeGraph report wording. The implementation itself should not depend on the CodeGraph report code.
