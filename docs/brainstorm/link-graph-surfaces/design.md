# Link graph surfaces - design

**Status:** draft
**Author:** claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain treats the vault as a connected graph but the
link-graph layer (`src/core/brain/wikilink.ts`,
`src/core/brain/backlinks.ts`) and the search layer
(`src/core/search/*`) throw away or never compute the richer
structure that operators need to act on connections. Anchor and
block suffixes are stripped at parse time; frontmatter `aliases:` are
unknown to the index so every aliased reference becomes a phantom
node; raw-text mentions outside `[[...]]` are invisible; there is no
read-only surface that assembles "this note plus everyone who links
to it" into one structure; per-hub coverage gaps are invisible;
property-aware search has no entry point; and a user-authored
vault-root instruction file has no Brain-side reader.

The v0.10.17 bundle closes those seven gaps as one coherent release.

## Scope

Seven features under one CHANGELOG entry, organised as the
established three-layer DAG (atoms / helpers / consumers):

- A1: Extend `BacklinkRef` with optional `targetAnchor`,
  `targetBlock`, and `aliasSource` fields. Existing consumers stay
  byte-identical (new fields are additive optionals).
- A2: New `WikilinkParse` type for the rich-parse path. `target`,
  `anchor`, `block`, `alias` slots. Existing `parseWikilink` /
  `normaliseWikilinkTarget` keep their string contracts but delegate
  to the rich parser.
- A3: Extend `SearchOptions` with optional `properties` map
  (`ReadonlyMap<string, ReadonlyArray<string>>`). Absent → existing
  search behaviour.
- A4: New `VaultInstructionEntry` type for the `brain_context`
  envelope extension.
- H1: `src/core/brain/link-graph/parse-wikilink.ts` -
  `parseWikilinkRich(value)` returns `{target, anchor, block, alias}`
  with the same case-preserving rules as the existing helpers.
- H2: `src/core/brain/link-graph/alias-index.ts` -
  `buildAliasIndex(vault)` walks all `Brain/` + vault notes, reads
  frontmatter `aliases:` arrays (NFC-normalised, case-folded), and
  returns a frozen `Map<alias, canonical-id>`. Collisions resolved
  first-wins by sort order; a `brain_doctor` lint follows up
  later (out of scope for this release).
- H3: `src/core/brain/link-graph/unlinked-mentions.ts` -
  `findUnlinkedMentions(vault, targetId, opts)` returns a frozen
  `ReadonlyArray<MentionRef>` of `(source, line, contextSnippet)`
  tuples. Skips text inside `[[...]]` spans and code spans. Uses the
  alias index from H2 to expand the search-term set.
- H4: `src/core/brain/link-graph/concept-cluster.ts` -
  `buildConceptCluster(vault, targetId, opts)` returns a deterministic
  envelope: `{target, linkers: [...refs], unlinkedMentions: [...]}`.
  Pure assembler; no LLM call.
- H5: `src/core/brain/link-graph/moc-audit.ts` -
  `auditMoc(vault, hubId, opts)` returns
  `{wellCovered: [...], fragile: [...], candidateMissing: [...],
  suggestedNext: ...}`. Heuristic MOC detection is purely
  structural (outbound link count and link-to-body ratio crossing
  configured thresholds).
- H6: `src/core/search/property-filter.ts` -
  `filterByProperties(results, filters)` is a pure post-FTS phase
  that walks each chunk's source frontmatter and drops rows whose
  scalar values don't match the requested filter set. Multi-value
  filter on the same key acts as logical OR; multiple keys act as
  logical AND.
- H7: `src/core/brain/vault-instruction-file.ts` -
  `readVaultInstructionFile(vault, name)` reads
  `<vault>/<name>` (default `VAULT.md`), returns `{content,
  path, lines}` or null when absent. The filename is configurable
  in `_brain.yaml` under `vault_instruction_file`; absent block
  falls back to the `VAULT.md` default.
- C1: `brain_unlinked_mentions` MCP tool (full scope) +
  `o2b brain unlinked` CLI verb.
- C2: `brain_concept_synthesis` MCP tool (full scope) +
  `o2b brain synthesise` CLI verb.
- C3: `brain_moc_audit` MCP tool (full scope) +
  `o2b brain moc-audit` CLI verb.
- C4: `brain_search` MCP tool extended to accept `properties`
  argument; `o2b brain search` CLI verb extended with repeated
  `--property KEY=VALUE` flag.
- C5: `brain_context` MCP tool extended to optionally include
  vault-instruction-file content under a new
  `vault_instruction` envelope field (additive; absent file →
  field omitted).
- C6: `buildBacklinkIndex` consumer rewrite to populate the new
  `BacklinkRef.targetAnchor` / `targetBlock` / `aliasSource`
  fields. Existing callers (doctor, digest, explorer) keep their
  current behaviour because they read by-target, not by-anchor.

## Out of scope

- LLM-driven synthesis. The `buildConceptCluster` helper assembles
  a deterministic envelope; an external consumer can feed it to an
  LLM later. The Brain layer never makes LLM calls.
- Backlink collision lint (which alias-collision case escalates
  through `brain_doctor`). Implementable in a follow-up release;
  the first-wins resolution rule in H2 is enough to ship this
  bundle safely.
- Block-id heading auto-resolution (resolving `[[note#^abc]]` to a
  line range inside `note`). H1 records the block id; resolving
  it to a line range needs a chunk-aware reader and lands later.
- New scheduled cron jobs. The vault-instruction file is read on
  demand by `brain_context`, not pushed by a scheduler.
- Two-stage signal review gate. Sibling cluster B from triage; not
  bundled here.

## Chosen approach

Variant 1: one new subsystem `src/core/brain/link-graph/` hosts H1
through H5 (parse, alias-index, unlinked-mentions, concept-cluster,
moc-audit). H6 (property filter) lives in `src/core/search/` because
that is its natural layer. H7 (vault-instruction file) lives at
`src/core/brain/vault-instruction-file.ts` because `brain_context`
consumes it directly and the file does not depend on the link graph.
The decision rationale lives in `variants.md`.

## Design decisions

- **Three-layer DAG repeats the v0.10.16 precedent.** Atoms (A1-A4)
  are additive optional fields on existing types; helpers (H1-H7)
  are pure functions in named files; consumers (C1-C6) are existing
  tools learning to read the helpers' output. Reviewers can map the
  CHANGELOG section back to the file tree in one pass.
- **Language-agnostic by construction.** No detector in this
  release uses a vocabulary list, a stopword set, a per-language
  regex table, or a unit dictionary. The anchor sigil `#` and the
  block-id sigil `#^` are structural artifacts of the Obsidian link
  grammar, not natural language. MOC detection uses link-density
  (a structural metric). Unlinked-mention scanning matches the
  target's literal title and its frontmatter alias strings as
  opaque tokens.
- **Backward compatibility by construction.** `BacklinkRef` gains
  optional fields; existing callers that destructure
  `{source, sourceKind, field, timestamp}` keep working unchanged.
  `parseWikilink` / `normaliseWikilinkTarget` keep their string
  return contracts. `SearchOptions.properties` defaults to absent.
  `brain_context` envelope's `vault_instruction` field is absent
  when the file is missing.
- **Alias index is a single-pass pre-walk.** `buildAliasIndex`
  reads frontmatter from every preference, retired, signal, and
  vault note exactly once. The cost is bounded by vault size and
  amortised by the existing `buildBacklinkIndex` walk, which can
  feed alias data to the second pass without re-reading.
- **Unlinked-mention scanner reuses the existing wikilink-masking
  regex** from `extractWikilinks` (which already strips
  `[[...]]` and code spans before yielding text). The scanner
  inverts the operation: keep only the masked-out positions, then
  match the candidate-term set against the remaining text.
- **MOC heuristic is two thresholds.** A note qualifies as a MOC
  candidate when its outbound link count is at least
  `moc_min_outbound_links` (default 5) AND its body's
  link-to-non-link ratio is at least `moc_min_link_ratio`
  (default 0.3). Both are settable in `_brain.yaml` under
  `link_graph.moc_*`. No vocabulary detection of "this looks like
  a MOC because the title says 'MOC'" - that's a hardcoded-language
  trap.
- **Property filter applies as a post-FTS phase.** FTS5 and the
  semantic ranker return candidate chunks first; the filter then
  loads each candidate chunk's source frontmatter (cached per
  document id within a single search call) and drops rows whose
  scalars don't match. The frontmatter read is bounded by the
  candidate set size (typically `limit * 3`), not the vault.
- **`brain_context` envelope extension is additive.** A new
  optional `vault_instruction?: VaultInstructionEntry` field on
  the existing envelope. Absent block in `_brain.yaml` plus absent
  file on disk = field omitted. Hosts that already strip unknown
  envelope fields stay byte-identical.
- **CLI verbs use the existing `o2b brain <verb>` dispatch.**
  Each new verb is one file under `src/cli/brain/verbs/<name>.ts`,
  wired through `src/cli/brain/verbs/index.ts` and
  `src/cli/brain/help-text.ts`. Same precedent as v0.10.16's
  `summary` verb.
- **MCP tools land in the full scope only.** Three new tools
  (`brain_unlinked_mentions`, `brain_concept_synthesis`,
  `brain_moc_audit`) register in the full scope and never appear
  in the writer scope. The writer-scope tool count stays at four
  (`brain_feedback`, `brain_apply_evidence`, `brain_note`,
  `brain_context`). `brain_context` is additively extended -
  the `vault_instruction` envelope field is omitted when no file
  is present, so writer-scope hosts that strip unknown fields stay
  byte-identical. `brain_search` (registered in
  `src/mcp/search-tools.ts`, full scope) grows an optional
  `properties` argument; the writer scope does not expose
  `brain_search`.

## File changes

New files:

- `src/core/brain/link-graph/parse-wikilink.ts`
- `src/core/brain/link-graph/alias-index.ts`
- `src/core/brain/link-graph/unlinked-mentions.ts`
- `src/core/brain/link-graph/concept-cluster.ts`
- `src/core/brain/link-graph/moc-audit.ts`
- `src/core/brain/vault-instruction-file.ts`
- `src/core/search/property-filter.ts`
- `src/cli/brain/verbs/unlinked.ts`
- `src/cli/brain/verbs/synthesise.ts`
- `src/cli/brain/verbs/moc-audit.ts`
- `tests/core/brain/link-graph/parse-wikilink.test.ts`
- `tests/core/brain/link-graph/alias-index.test.ts`
- `tests/core/brain/link-graph/unlinked-mentions.test.ts`
- `tests/core/brain/link-graph/concept-cluster.test.ts`
- `tests/core/brain/link-graph/moc-audit.test.ts`
- `tests/core/brain/vault-instruction-file.test.ts`
- `tests/core/search/property-filter.test.ts`
- `tests/cli/brain-unlinked-cli.test.ts`
- `tests/cli/brain-synthesise-cli.test.ts`
- `tests/cli/brain-moc-audit-cli.test.ts`
- `tests/mcp/link-graph-mcp-fields.test.ts`
- `tests/core/brain/backlinks-anchor-alias.test.ts`
- `docs/brainstorm/link-graph-surfaces/{design.md,plan.md,variants.md,cli-output/}`
- `.ai-notes/images/v0.10.17-link-graph.{excalidraw,png}`

Modified files:

- `src/core/brain/wikilink.ts` - export `parseWikilinkRich`;
  `parseWikilink` / `normaliseWikilinkTarget` delegate.
- `src/core/brain/backlinks.ts` - `BacklinkRef` extended;
  `buildBacklinkIndex` populates new fields and consults
  `buildAliasIndex`.
- `src/core/brain/policy.ts` - add `link_graph` config section
  with `moc_min_outbound_links`, `moc_min_link_ratio`,
  `vault_instruction_file` defaults. `resolveLinkGraphConfig`
  helper next to `resolveGuardrails`.
- `src/core/search/types.ts` - extend `SearchOptions` with
  `properties?`.
- `src/core/search/search.ts` - wire `filterByProperties` post-FTS
  phase when `opts.properties` is set.
- `src/mcp/brain-tools.ts` - register three new full-scope tools
  (`brain_unlinked_mentions`, `brain_concept_synthesis`,
  `brain_moc_audit`); extend `brain_context` envelope.
- `src/mcp/search-tools.ts` - extend `brain_search` schema and
  handler with optional `properties` argument.
- `src/mcp/tools.ts` - add the three tool names to the full-scope
  set (writer scope unchanged).
- `src/mcp/instructions.ts` - inventory bump to 14 tools (11 +
  three new full-scope reads).
- `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`,
  `src/cli/brain/help-text.ts` - dispatch + help for the three
  new verbs and the search property flag.
- `README.md` - capability paragraph plus tool-count bump.
- `CHANGELOG.md` - new `[0.10.17]` entry under a concrete
  version header.
- Version manifests: `package.json`, `pyproject.toml`,
  `plugin.yaml`, `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, `openclaw.plugin.json`,
  `plugins/codex/.codex-plugin/plugin.json`,
  `plugins/hermes/plugin.yaml`.

Expected total: ~60 files (within 50-70 budget).

## Risks and open questions

- **Risk: alias-index walk cost.** `buildAliasIndex` reads
  frontmatter from every preference + retired + signal + vault
  note. For a 10k-page vault this is a one-time
  `readFileSync(frontmatter-only-prefix)` per file. Mitigation:
  the index is built lazily inside `buildBacklinkIndex` and
  passed as an in-memory `Map` to all downstream consumers; no
  caller pays the walk twice. If profiling shows it's the new
  bottleneck, a follow-up release can cache by `mtime`.
- **Risk: unlinked-mention false positives.** The literal-token
  matcher will hit prose mentions of common nouns. Mitigation:
  the matcher requires whole-word boundaries (Unicode-aware
  via `\p{L}\p{N}` codepoint classes), the title-token must be
  at least two codepoints (avoids matching every "a" or "I"), and
  the scanner explicitly skips text inside `[[...]]`. No vocabulary
  filtering, no stopword set - the heuristic is purely structural.
- **Open question: where to draw the MOC link-density threshold.**
  Defaults (`moc_min_outbound_links: 5`,
  `moc_min_link_ratio: 0.3`) are heuristic. The `_brain.yaml`
  config lets operators override per-vault. Documented in README.
- **Open question: how the `brain_context` envelope grows.**
  The new `vault_instruction` field is opt-in via file presence,
  but downstream hosts may need a CHANGELOG callout. Mitigation:
  the field is absent when the file is missing, so existing hosts
  that strip unknown fields stay byte-identical.
