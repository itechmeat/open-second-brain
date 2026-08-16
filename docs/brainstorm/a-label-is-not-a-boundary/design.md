# A label is not a boundary - put a check behind every declared boundary, or retract the declaration

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Ten tracker items, selected by priority off the board and read against the real
source before anything was designed, turn out to describe one defect seen from
ten sides: the product declares a boundary and puts nothing behind it. An
owner-isolation filter whose field no writer ever emits. A gate that enforces
the scope the caller asked for. A confidence floor compared against a number
that cannot vary with match quality. A shared namespace written twice over with
attribution nobody reads. An egress registry built to stop an unguarded export,
with an unguarded export outside it. A census whose docblock claims to have
closed the mis-parse class that is live inside it.

Reconnaissance corrected most of the ten task bodies. Six of the corrections
changed what the unit is, not merely how it is worded; two findings turned out
to be the opposite of what was filed; one is a live credential leak on a shipped
path and one is a live authorisation defect. The corrected findings, with their
anchors and the measurements that produced them, are in `recon/`.

## Scope

Ten units. Each takes one declared boundary and does exactly one of three
things, chosen by evidence rather than by preference:

- **ENFORCE** - the label names a real boundary and nothing checks it; put the
  check where the data is aggregated, and put a census behind the check so the
  next instance fails the build.
- **RE-MEASURE** - the check exists and measures the wrong quantity; swap in the
  signal that varies with what the label claims, where such a signal is already
  computed and discarded.
- **RETRACT** - the label has no subject in this product; delete it and say so.
  A mechanism that cannot change an outcome is the defect under review, so
  keeping it "for later" is not available.

| # | Unit | Verdict | Tracker |
| --- | --- | --- | --- |
| U1 | Ownership is written, or it is not a boundary | ENFORCE | t_b18551b1 |
| U2 | Identity is resolved, never echoed | ENFORCE | t_b18551b1, t_3ebb6e0e |
| U3 | The scope matrix asserts correctness | ENFORCE | t_b18551b1 |
| U4 | Four thresholds against a pinned number | RE-MEASURE + RETRACT | t_eb94ac35 |
| U5 | The write-only sink gets a reader | ENFORCE | t_a160764a, t_77efc212 |
| U6 | The writer surface states its own name | ENFORCE | t_f2ede668 |
| U7 | The delegation boundary the host already delivers | ENFORCE | t_0c6f31ee |
| U8 | The eighth egress site | ENFORCE | t_09a3752a, t_08f6ffca |
| U9 | One lexer, and the hole in the live one | RE-MEASURE | t_1d4f932f |
| U10 | Retractions, stated with their evidence | RETRACT | t_09a3752a, t_08f6ffca, t_3ebb6e0e, t_77efc212, t_f2ede668 |
| U11 | The contract honoured at three sites of forty-one | ENFORCE | found in recon |
| U12 | The small ones, each with its own failing test | ENFORCE | found in recon |

Two units carry no tracker item. They are here because reconnaissance found
them, the operator's standing rule is that problems seen along the way are
fixed rather than deferred, and U11 in particular is this release's own thesis
on the same surface: a contract stated at one site and honoured at three of
forty-one.

## Out of scope

Deliberately, each with the evidence that decided it:

- **A git-visibility ladder** (asked for by t_09a3752a). There is no git
  transport in the product; every `git` invocation under `src/` is read-only,
  and `src/core/egress/registry.ts:6-8` states in prose that the vault "has no
  git transport and deliberately never will". A fail-closed check needs
  something to guard. U10 records this; U8 retargets the fail-closed shape at
  the destinations that do exist.
- **A staging copy and a history purge** (asked for by t_08f6ffca). There is no
  history to purge, and the export bundle already is the staging copy. Two
  bidirectional bundle formats exist with importers on both sides.
- **An `off` identity mode** (asked for by t_3ebb6e0e). The bottom of the
  identity chain is already the literal string `"agent"`, itself a placeholder;
  `off` has no subject distinct from it.
- **De-normalising the keyword lane.** Measured blast radius: every score in the
  product moves and four thresholds flip at once. U4 gates the floor on a signal
  that is already absolute instead.
- **A per-agent instruction block.** Not reachable over either transport: both
  resolve identity from process env and config, never from the request, so "per
  agent" collapses to "per process", which the installer already provides. There
  is also nowhere to declare a multi-line block - the config reader rejects
  nesting past two levels and has no block-scalar form.
- **An eleventh census over "declared boundaries" in general.** The population is
  semantic, not structural; deriving it would need a declaration surface and a
  mandatory-reason field beside the four-piece vocabulary idiom, which is the
  parallel-idiom this repository forbids. Each unit lands its assertion inside
  the census that already owns its class.
- **A fleet view with three metrics.** Open task count has no referent in this
  product; there is no `open_tasks` anywhere in `src/`. U5 ships the two metrics
  that are computable and says the third does not exist.

## Chosen approach

Variant 3 of three, with one correction and one graft.

### Agreement with the recommendation

The consultant recommended disposition triage on the strength of its empty
critical path, and that holds against the source: the ten units touch largely
disjoint files, each has a definition of done anchored at a specific
`file:line`, and only the lexer extraction has a shared owner. Variant 1 defers
scope to whatever the repaired instruments turn red, which is not a scope at all
for a single branch. Variant 2's eleventh census is the parallel idiom the
operator's constraints forbid, and its own trade-offs predict the failure: "a
registry whose membership check is weaker than what it claims to enforce is
precisely the defect under review".

### The correction

Variant 3 lists "no single new mechanism guards the eleventh instance" as an
accepted cost, and this repository's own doctrine says a fix without a census is
not durable. The cost is not accepted here. Finding 1 already names the missing
mechanism precisely: `tests/mcp/agent-scope-matrix.test.ts` asserts that every
one of 110 tools is classified exactly once and never that a classification is
correct. Turning `NON_CONTENT: string[]` into `{name, args, reason}[]` and
driving every entry against a two-owner fixture is a structurally-derived
enforcement census - and it is an extension of the test that already owns the
class, not an eleventh registry. That is U3, and it is what makes U1 durable.

### The graft

Variant 2's principle survives inside U3 and U8: a bucket without a per-surface
assertion is another label with nothing under it, so every ENFORCE unit ships
its assertion in the same commit as its check. U8 additionally widens the
existing egress census's destination derivation, because the census missed the
eighth site through a hardcoded name list - which is the same defect class the
census exists to catch, one level up.

### Why RETRACT is a first-class outcome here

The operator's constraint is that a fallback which quietly does nothing is
forbidden and an error must be shown explicitly. A knob that cannot change an
outcome is the silent-fallback defect in configuration form: an operator sets
it, reads no error, and believes a boundary exists. Deleting it is the honest
disposition, and U10 records each deletion with the measurement that justified
it rather than performing it quietly.

One exception is written into the tracker and is honoured: t_eb94ac35 states
that `below_floor` must not be closed by deleting the vocabulary member, because
the member describes a state the system should be able to reach. U4 therefore
re-measures rather than retracts - after the change the floor fires when the
match is genuinely weak, which is what the member always claimed.

## Design decisions

- **Owner is the writing agent identity, resolved server-side.**
  `src/core/graph/agent-scope.ts:23-24` already rules that owner tokens are
  agent names. The alternative - a human owner distinct from the agent - has no
  representation anywhere in the vault and would be an invention.
- **Emission of `owner:` is conditioned on the gate, not unconditional.** A
  vault that has not enabled owner-scope delivery must stay byte-identical, so
  the writer stamps ownership only where the boundary is switched on. Measured
  with the vault-digest helper over the whole tree, not asserted per file.
- **A conflicting caller-supplied identity is an error, not a silent
  narrowing.** With the gate on, a caller naming an owner other than the
  resolved identity receives a typed refusal that names the conflict. Silently
  substituting the correct scope would leave the caller believing it read what
  it asked for.
- **The recall floor is gated on IDF-weighted coverage**, which is absolute,
  pool-independent, in `[0,1]`, and already computed today in evidence-pack mode
  before being discarded. No score moves; the floor starts measuring match
  quality instead of pool position.
- **An unreachable origin is reported, never dropped.** The sibling module one
  layer down already documents this rule; `origins.ts` undoes it. The verdict is
  a four-piece closed vocabulary registered in the vocabulary census.
- **The shared namespace becomes enumerable as a read origin**, which produces
  the reader that a named shared scope has now failed twice for lack of, and
  gives `origin_vault` its first consumer.
- **One lexer under `tests/helpers/`, taken verbatim from the more general of
  the two identical copies**, with the backtick newline-guard hole closed. The
  helper gets its own tests, which no helper in that directory has today; the
  populations each census enumerates are run and compared before and after, not
  read from a comment, because no census asserts an exact count.
- **The embedding endpoint is declared as an egress site.** It is the largest
  continuous egress in the product and is currently outside the registry
  entirely. Declaring it with its mandatory reason is what the registry is for;
  whether it is scanned is a separate, stated decision.
- **`SubagentStop` is registered and the session turn carries both ids.** The
  additive-field path is the one `docs/observability.md:73` already commits to.

## File changes

New:

- `tests/helpers/source-lexer.ts`, `tests/helpers/source-lexer.test.ts`
- a reachability vocabulary module beside `src/core/brain/portability/origins.ts`
- an owner-conflict refusal vocabulary beside the scope coercion it guards
- recon notes and this design set under `docs/brainstorm/a-label-is-not-a-boundary/`

Modified, by unit (paths verified against the tree at `f02c1fd3`, after a spec
review corrected nine of them): `src/core/brain/preference.ts` and the five
writers that omit `owner`; `src/mcp/coerce.ts`,
`src/core/brain/preferences-collect.ts`; `tests/mcp/agent-scope-matrix.test.ts`,
`src/core/search/store/links.ts`, `src/core/brain/backlinks.ts`,
`src/core/brain/notes/scaffold-stub.ts`,
`src/core/brain/link-graph/moc-audit.ts`,
`src/core/brain/link-graph/unlinked-mentions.ts`;
`src/core/brain/recall-inject.ts`, `src/core/brain/recall-adequacy.ts`,
`src/core/search/coverage.ts`, `src/core/brain/gaps/gap-loop.ts`,
`src/core/bench/failure-modes.ts`, `src/core/search/ranker.ts`,
`src/core/search/pipeline/assemble.ts`, `src/core/brain/page-meta/tier.ts`;
`src/core/brain/portability/origins.ts`, `src/core/search/cross-vault.ts`,
`src/core/brain/shared-namespace.ts`, `src/core/brain/agent-source/*`;
`src/mcp/instructions.ts`, `src/mcp/tool-contract.ts`, `src/mcp/http.ts`;
`hooks/hooks.json`, `src/core/brain/session-lifecycle.ts`,
`src/core/brain/sessions/*`; `src/cli/brain/verbs/explorer.ts`,
`src/core/brain/explorer.ts`, `src/core/egress/registry.ts`,
`tests/core/architecture/egress-census.test.ts`,
`src/core/brain/portability/okf.ts`, `src/core/brain/export.ts`,
`src/core/redactor.ts`, `src/core/search/embeddings/openai-compat.ts`;
`src/mcp/tools.ts` and the ten tool modules emitting `vault_path`; the four
census tests that hand-roll a lexer, plus the layering and reader censuses.

Docs: `docs/observability.md`, `docs/architecture.md`, `docs/mcp.md`,
`docs/cli-reference.md`, `docs/how-it-works.md`, `README.md`, `CHANGELOG.md`.

## Risks and open questions

Three of the five risks this document first listed were open questions with two
possible answers. A spec review against the source closed them; they are
recorded here as decisions, because an implementing agent must not have to ask.

- **The scope matrix probe is the highest-variance unit, and stays open.**
  Driving the classified tools against a two-owner fixture may surface leaks
  beyond the ten already named. The unit's budget must absorb that. All ten
  named leaks must close; an additional one is either fixed or moved to the
  unscoped bucket with a reason of the specificity the existing entries carry.
- **The digest cannot reach another branch.** `tests/helpers/vault-digest.ts`
  hashes a tree in the current process, so "byte-identical to `main`" is not
  writable. The measurement is between two vaults written by one fixture script
  under a pinned clock and vault id, with owner stamping on and off, compared by
  `digestVaultTree` and `changedPaths`.
- **The tier multiplier is wired, not retracted.** `src/core/brain/page-meta/tier.ts:38-45`
  documents `tier` as a multiplicative ranker weight and `:8-9` justifies the
  default value by ranker bit-identity, so the label has a subject in shipped
  source and the missing half is the producer. The untagged fixture corpus
  cannot move, because the default multiplier is 1.0.
- **`private: true` in frontmatter is retracted, not enforced.** The
  `<private>` region marker is the product's only content-derived privacy
  primitive; nothing under `portability/` reads the frontmatter key, and the
  export composers are content composers rather than visibility filters. A test
  asserts the page exports in full, so the label cannot be re-read as a
  boundary, and the registry reason strings say which primitive is the real one.
- **The lexer migration can produce a false clean.** Routing an import-specifier
  read through the wrong view drops a census from 64 rows to zero with an empty
  failure list. A test that pins the specifier-preserving view is mandatory.
- **The egress census cannot express a network destination.** Its population is
  derived from a file-destination parameter plus a raw file write, so declaring
  the embedding endpoint under the existing rule fails the
  declaration-outlives-module assertion. U8 adds a second population rule and
  proves it with a synthetic network-destination module.
