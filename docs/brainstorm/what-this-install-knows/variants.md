# What this install knows about itself - variants

Audit trail for the phase-0 brainstorm. The consultant was Claude Code,
run once against `cli-output/prompt.md`; it returned three parseable
variants and one recommendation on the first attempt, so the Codex
fallback was not invoked.

The prompt carried the premise verification performed before the
brainstorm - the five cards' anchors opened, the mechanisms they claimed
missing grepped for - so the consultant reasoned against the tree as it
is rather than as the cards describe it.

## Consultant output, verbatim

### Variant 1: Four seams, one refusal
- **Approach**: Ship each card as its own small, independent addition with no shared model. Card 1 hoists the three `package.json` reads into one `src/core/version.ts` constant and adds `o2b version` plus a root `--version` flag on top of it. Card 2 keeps the frozen scope bodies and appends a generated "withheld tools" block rendered from `capabilityReport`. Cards 3 and 4 become two new read-only MCP tools that wrap `linkedProjectsStatus` and the `runCheck` loop directly, emitting absolute paths and always running probes. Card 5 is closed as refused, with the ownership statement and the taken `update` verb cited as the reason, and nothing is built for it.
- **Trade-offs**:
  - Pro: smallest diff, each card reviewable in isolation, no new abstractions.
  - Pro: card 5 handled with zero policy cost and no contract surface to maintain.
  - Con: card 2 is only half truthful. The writer body still names withheld tools in prose, so an agent is still directed to them, and the appended block merely contradicts the paragraph above it.
  - Con: the hosts tool runs up to a dozen 10-second probes sequentially from inside the MCP server, so a single call can block for minutes and spawns host binaries on every read.
  - Con: absolute host paths leave the server with no stated policy, which sits uneasily next to the sibling landscape tool's "vault-relative" charter.
  - Con: the question "is a newer release available" has no answer at all on either surface, so the wave's spine (every self-question answered from live state, unknowns named) is not fully honoured.
- **Complexity**: small
- **Risk**: medium

### Variant 2: One installation report
- **Approach**: Introduce a single read-only core module, `src/core/install/self-report.ts`, that assembles a typed `InstallationReport` with four sections: `version` (from the new shared version constant), `tools` (the existing capability report), `projects` (from `linkedProjectsStatus`, with `pointer` state and a `paths` disclosure flag), and `hosts` (the `VerifyResult[]` aggregate, with probes named `not-run` unless the caller passes `probe: true`, and run concurrently under the existing deadline when they do). The CLI gets `o2b version` and `--version` reading the `version` section, and the MCP server gets one new tool, `brain_mcp_installation`, returning the whole report or one section by argument. Card 2 splits each scope body into a per-tool paragraph map keyed by tool name, and `buildInstructions` renders only paragraphs for `available` tools and appends a withheld list with reasons. Card 5 ships its honest residue as a fifth `release` section whose `state` is a closed vocabulary (`not-checked` today, with `reason: no-update-check-by-policy`), pointing at `docs/updating.md` and the existing `brain upgrade` plan, and the card is recorded as refused-as-specified.
- **Trade-offs**:
  - Pro: one model answers every self-question on both surfaces, and every absent answer is a named vocabulary member, which is the house idiom and the wave's spine.
  - Pro: card 2 becomes fully truthful because withheld tools vanish from prose instead of being contradicted below it.
  - Pro: probes are opt-in and bounded, so the default read is fast and side-effect free, and the "unverified" state is reported by name rather than assumed.
  - Pro: card 5 gets a durable, truthful surface that an agent can query without any network, and the ownership statement stays verbatim.
  - Con: largest diff of the three, touching CLI, MCP, instructions, and a new core module in one PR.
  - Con: the per-tool paragraph map duplicates tool naming already present in the tool registry, so DRY is improved but not perfected.
  - Con: a `release` section that can only ever say `not-checked` risks reading as a placeholder unless the reason text and docs are explicit that the state is deliberate.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Grow the landscape, compare on demand
- **Approach**: Reuse the existing sibling inventory tool instead of adding tools. `brain_mcp_landscape` gains two additive sections, `projects` and `hosts`, backed by the same pure readers, so no new tool name enters `tools/list`. Card 1 adds the shared version constant and `o2b version`, and card 2 uses the same per-tool paragraph filtering as Variant 2. Card 5's residue becomes a pure comparator: `o2b version --compare <semver>` answers `newer | same | older | invalid` for a latest version the operator or harness obtained by their own means, then prints the upgrade plan pointer, so Open Second Brain never fetches, caches, or auto-installs anything.
- **Trade-offs**:
  - Pro: zero new MCP tool names, and existing clients discover the new facts through a tool they already call.
  - Pro: the comparator is deterministic, network-free, and gives scripts the "is newer available" bit once they supply the input.
  - Con: it breaks the landscape module's own written charter. Its header promises that environment values are never read and discovery is vault-relative, while host verification reads host config paths, reports absolute project paths, and may spawn host binaries. Growing that tool makes its rationale false.
  - Con: the comparator answers a question only after the caller has already answered it elsewhere, so its utility is marginal and it adds a flag surface the reference docs must carry forever.
  - Con: loading unrelated host and project data into every landscape call widens a tool whose consumers today expect a small vault inventory.
- **Complexity**: medium
- **Risk**: high

### Recommended: Variant 2
**Rationale**: Variant 2 is the only one where every card lands as a named, closed-vocabulary answer on both the CLI and MCP surfaces, which is the wave's stated spine and the tree's house style, and it is the only one that makes card 2 fully truthful rather than self-contradicting. Its extra size is contained in one new read-only core module and one new tool, and it keeps the ownership statement, the existing `update` verb, and the landscape tool's charter untouched, whereas Variant 3 would falsify a module's own rationale and Variant 1 leaves the release question unanswered on every surface.

## Orchestrator decision

**Variant 2 adopted, with three overrides.**

The spine is right and is the only one of the three that both surfaces
can carry: one coherent model over live state, every absent answer a
named member of a closed vocabulary. Variant 1 was rejected on its own
admitted defect - appending a withheld-tools block beneath prose that
still instructs the agent to call those tools leaves the first text every
agent reads self-contradicting, which is a smaller version of the bug the
card is about. Variant 3 was rejected because growing `brain_mcp_landscape`
falsifies that module's written charter, and because a comparator that
answers "is a newer version available" only after the caller has
already established it adds a permanent flag surface for a marginal
answer.

Three overrides, each from project context the consultant did not have:

1. **No `version` or `tools` section in the new MCP tool.** Variant 2
   proposed a four-section installation report. Two of those sections are
   already answered on the MCP surface: `serverInfo.version` carries the
   version in the handshake (`src/mcp/protocol.ts:14`) and
   `second_brain_capabilities` returns the whole capability report and is
   never withheld (`src/mcp/tools.ts:453-461`). Shipping them again would
   be two new copies of two shipped answers. The tool carries the two
   views that are genuinely missing.

2. **No `release` section for t_c64b7cab.** Variant 2 proposed a fifth
   section whose state could only ever read `not-checked`, and named the
   risk itself in its own trade-offs. A field with no producer, whose
   single possible value is the absence of an answer, is a stub: it costs
   a permanent output contract, a schema, documentation and a test, and
   returns nothing the documentation does not already say. The card is
   recorded as refused with its reason in `design.md` instead, which is a
   deliverable in this project. The residue is an operator policy
   decision about network behaviour, and taking it inside an
   implementation PR would be taking it on the operator's behalf.

3. **Tool-tagged segments, not a per-tool paragraph map.** The map fits
   the writer body, whose five bullets are already one per tool, and not
   the full body, which is prose naming nine tools across three
   paragraphs. Segments that declare the tool names their text depends on
   cover both shapes with one model, and the full body's semicolon-joined
   memory-contract clauses decompose into one segment per writer tool
   without being rewritten.

One further refinement inside Variant 2's own terms: the consultant
proposed making host probes opt-in behind a `probe: true` argument.
Adapters have no non-probing `verify()` path, so building one means
touching every adapter for a flag - a large change to avoid a bounded
cost that two of ten targets can incur
(`src/core/runtime/host-facts.ts:509`, `:530`). The view reuses `verify()`
as it is and states the cost in the tool description instead.
