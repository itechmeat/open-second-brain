# Link graph surfaces - implementation plan

## DAG

```
A2 (rich wikilink parse)  ──┐
A1 (BacklinkRef +fields)  ──┤
                            ├──> Unit 1 (parse + atom)
                            │
H2 (alias-index)          ──> Unit 2
H1 + alias wiring         ──> Unit 3 (BacklinkRef populated)
H3 (unlinked-mentions)    ──> Unit 4
H4 (concept-cluster)      ──> Unit 5
H5 (moc-audit)            ──> Unit 6
H6 (property-filter)      ──> Unit 7
A4 + H7 (vault-instr)     ──> Unit 8
```

Units 1-3 land sequentially (later units depend on earlier shape).
Units 4-8 are siblings and can land in any internal order.

## Tasks

### Unit 1: Rich wikilink parse + `BacklinkRef` atom extension

- **Files**:
  - `src/core/brain/wikilink.ts` (modify) - export `parseWikilinkRich`
  - `src/core/brain/link-graph/parse-wikilink.ts` (new) - canonical home of the rich-parse logic
  - `src/core/brain/backlinks.ts` (modify) - `BacklinkRef` gains optional `targetAnchor?: string`, `targetBlock?: string`, `aliasSource?: string`
  - `tests/core/brain/link-graph/parse-wikilink.test.ts` (new) - covers heading anchor, block anchor, alias, folder, `.md` suffix, and combination cases
  - `tests/core/brain/backlinks-anchor-alias.test.ts` (new) - covers existing-consumer compatibility (legacy shape destructure still works) plus new-field populated cases
- **Acceptance**: `parseWikilinkRich("[[Note#Heading]]")` returns `{target: "Note", anchor: "Heading", block: undefined, alias: undefined}`; `parseWikilinkRich("[[Note#^abc]]")` returns `{..., block: "abc"}`; `parseWikilink("[[Note#Heading]]")` still returns `"Note"`. `BacklinkRef` instances retain backward compat: code reading only `{source, sourceKind, field, timestamp}` continues to work.
- **Depends on**: none

### Unit 2: Alias index helper

- **Files**:
  - `src/core/brain/link-graph/alias-index.ts` (new) - `buildAliasIndex(vault)` returning frozen `Map<aliasLower, canonicalId>`
  - `tests/core/brain/link-graph/alias-index.test.ts` (new) - frontmatter scanned across `preferences/`, `retired/`, `inbox/`, `processed/`; collisions resolved first-wins; case-insensitive; NFC normalised
- **Acceptance**: Three notes, two declaring overlapping `aliases: [foo]`, the alphabetically-first wins; lookup is case-insensitive; result is `Object.isFrozen`.
- **Depends on**: none

### Unit 3: `buildBacklinkIndex` populates anchor + alias-source

- **Files**:
  - `src/core/brain/backlinks.ts` (modify) - rewrite collectors to push the rich parse and consult the alias index
  - `tests/core/brain/backlinks-anchor-alias.test.ts` (extend) - new cases assert `targetAnchor`, `targetBlock`, `aliasSource` are populated when applicable
- **Acceptance**: A signal referencing `[[FullName#Section]]` produces a `BacklinkRef` with `targetAnchor: "Section"`. A signal referencing `[[fooAlias]]` where note `bar.md` declares `aliases: [fooAlias]` produces a ref keyed on `"bar"` with `aliasSource: "fooAlias"`.
- **Depends on**: Unit 1, Unit 2

### Unit 4: Unlinked-mentions helper + MCP + CLI

- **Files**:
  - `src/core/brain/link-graph/unlinked-mentions.ts` (new) - `findUnlinkedMentions(vault, targetId, opts)` returning frozen `ReadonlyArray<MentionRef>`
  - `src/mcp/brain-tools.ts` (modify) - register `brain_unlinked_mentions` in full scope
  - `src/cli/brain/verbs/unlinked.ts` (new) - `runUnlinked(args)`
  - `src/cli/brain/verbs/index.ts` + `src/cli/brain/help-text.ts` + `src/cli/brain.ts` (modify) - dispatch + help
  - `tests/core/brain/link-graph/unlinked-mentions.test.ts` (new) - confirms `[[...]]` exclusion, alias expansion, multi-line context, codepoint-aware word boundaries
  - `tests/cli/brain-unlinked-cli.test.ts` (new)
  - `tests/mcp/link-graph-mcp-fields.test.ts` (new) - covers tool registration, JSON-RPC round trip, `INVALID_PARAMS` for malformed input
- **Acceptance**: Given a target `Note` with frontmatter `aliases: [downstream]`, and a sibling note containing the prose `"the downstream effect of Note here"`, the scanner yields two `MentionRef` rows (one per match). A reference `[[Note]]` in the same sibling does NOT produce a mention. Tool registered in `full` scope only.
- **Depends on**: Unit 2

### Unit 5: Concept-cluster helper + MCP + CLI

- **Files**:
  - `src/core/brain/link-graph/concept-cluster.ts` (new) - `buildConceptCluster(vault, targetId, opts)` returning a frozen envelope `{target, linkers, unlinkedMentions, generatedAt}`
  - `src/mcp/brain-tools.ts` (modify) - register `brain_concept_synthesis` in full scope
  - `src/cli/brain/verbs/synthesise.ts` (new)
  - `src/cli/brain.ts` + `src/cli/brain/verbs/index.ts` + `src/cli/brain/help-text.ts` (modify)
  - `tests/core/brain/link-graph/concept-cluster.test.ts` (new) - envelope shape, frozen guarantees, `include_unlinked` flag toggles inclusion
  - `tests/cli/brain-synthesise-cli.test.ts` (new)
  - `tests/mcp/link-graph-mcp-fields.test.ts` (extend) - covers concept-synthesis registration + JSON-RPC
- **Acceptance**: For a target `Note` with two linkers (`pref-a` body contains `[[Note]]`, `pref-b` evidenced_by `[[Note]]`), envelope reports both linkers with their `sourceKind` + `field`. When `include_unlinked: true`, envelope also contains the unlinked-mention rows. Helper does NOT make an LLM call.
- **Depends on**: Unit 3, Unit 4

### Unit 6: Per-MOC audit helper + MCP + CLI

- **Files**:
  - `src/core/brain/link-graph/moc-audit.ts` (new) - `auditMoc(vault, hubId, opts)` returning `{wellCovered, fragile, candidateMissing, suggestedNext}`
  - `src/core/brain/policy.ts` (modify) - add `link_graph.moc_min_outbound_links` (default 5) and `link_graph.moc_min_link_ratio` (default 0.3) config slots
  - `src/mcp/brain-tools.ts` (modify) - register `brain_moc_audit` in full scope
  - `src/cli/brain/verbs/moc-audit.ts` (new)
  - `src/cli/brain.ts` + `src/cli/brain/verbs/index.ts` + `src/cli/brain/help-text.ts` (modify)
  - `tests/core/brain/link-graph/moc-audit.test.ts` (new) - heuristic threshold behaviour, bucket assignment, suggestedNext deterministic ordering
  - `tests/cli/brain-moc-audit-cli.test.ts` (new)
  - `tests/mcp/link-graph-mcp-fields.test.ts` (extend) - covers moc-audit registration + JSON-RPC
- **Acceptance**: A hub note with 6 outbound links and link-ratio 0.5 qualifies as MOC; one linker with body-length above the well-covered floor + 3 inbound backlinks → `wellCovered`; one linker with 1 backlink and short body → `fragile`. MOC detection rejects a note with 4 outbound links (below the default threshold) regardless of title.
- **Depends on**: Unit 1 (rich parse for outbound-link enumeration)

### Unit 7: Property-filter helper + search wiring + MCP + CLI flag

- **Files**:
  - `src/core/search/property-filter.ts` (new) - `filterByProperties(results, filters, frontmatterReader)`; multi-value within a key = OR, multiple keys = AND
  - `src/core/search/types.ts` (modify) - `SearchOptions.properties?: ReadonlyMap<string, ReadonlyArray<string>>` (or equivalent shape)
  - `src/core/search/search.ts` (modify) - wire post-FTS phase when `opts.properties` set
  - `src/mcp/search-tools.ts` (modify) - extend `brain_search` schema + handler to accept a `properties` argument
  - `src/cli/search.ts` (modify) - repeated `--property KEY=VALUE` flag on `o2b search "<query>"`
  - `tests/core/search/property-filter.test.ts` (new) - covers AND/OR logic, missing-key behaviour, malformed-filter rejection
  - `tests/cli/search-property-cli.test.ts` (new)
- **Acceptance**: `search({query: "foo", properties: new Map([["type", ["decision"]]]))` returns only chunks whose source frontmatter has `type: decision`. Multi-value filter on `tags` includes any chunk whose `tags` array intersects the requested set. Absent `properties` → identical to existing `search()` output (verified by snapshot).
- **Depends on**: none (parallel to other units)

### Unit 8: Vault-root instruction file reader + `brain_context` envelope extension

- **Files**:
  - `src/core/brain/vault-instruction-file.ts` (new) - `readVaultInstructionFile(vault, name)`
  - `src/core/brain/policy.ts` (modify) - add `vault_instruction_file` config (default `VAULT.md`)
  - `src/mcp/brain-tools.ts` (modify) - extend `brain_context` envelope with optional `vault_instruction` field
  - `tests/core/brain/vault-instruction-file.test.ts` (new) - reads default name, configurable name, absent file → null, oversized file warning, vault-relative path emission
  - `tests/mcp/brain-context-vault-instruction.test.ts` (new) - covers envelope extension + absent-file = field omitted
- **Acceptance**: `<vault>/VAULT.md` containing `# My vault` → `readVaultInstructionFile` returns `{content: "# My vault", path: "VAULT.md", lines: 1}`. Configurable rename via `_brain.yaml` → `vault_instruction_file: GUIDE.md` reads `<vault>/GUIDE.md`. Absent file → returns `null`; envelope omits the field.
- **Depends on**: none (parallel to other units)

## Cross-cutting items (land alongside the final unit)

- `src/mcp/instructions.ts` - inventory bump.
- `src/mcp/tools.ts` - add the three full-scope tool names to the table.
- `README.md` - one new capability paragraph + tool-count bump.
- `CHANGELOG.md` - one new `[0.10.17]` entry under a concrete header.
- Version manifests bump (one commit in Phase 6, not during implementation).
- `.ai-notes/images/v0.10.17-link-graph.{excalidraw,png}` - release diagram.

## Verification artifacts

- Each unit's tests must pass in isolation (`bun test tests/core/brain/link-graph/<file>.test.ts`).
- Full suite must pass at the end of every unit's commit (`bun test`).
- `bun run typecheck` clean at every commit boundary.
- `bun run sync-version:check` runs only after Phase 6 version bump.
