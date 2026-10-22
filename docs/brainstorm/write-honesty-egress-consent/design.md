# Write-time honesty and egress consent - six-feature release wave

**Status:** draft
**Author:** osb-feature-release run osb-feature-release-1792650839871 (via feature-release-playbook)
**Audience:** implementation lanes

## Problem statement

Four classes of dishonesty survive in the current tree: informal privacy frontmatter
markers (`access: private`, `confidentiality: secret`, `sensitivity: confidential`) resolve to default visibility
because the visibility layer reads only `meta["visibility"]` (src/core/graph/visibility.ts:44-48);
embedding chunks larger than the model input window are silently truncated by the
serving stack while the full text stays searchable (src/core/search/indexer.ts:1184);
person lookups match only exact normalized name-or-alias equality
(src/core/search/entity-alias.ts:58-59); and counts or amounts written without a
date become claims that cannot be placed in time (page-lint.ts runs four detectors,
none checks date presence). On the egress side, shared exports apply credential-shape
redaction only (src/core/egress/guard.ts:141-144) with no content-class policy, and an
explicit provider decline collapses into the same disabled tier as never-configured,
so no surface honors a written operator decision (src/core/doctor-readiness.ts:294-299).

All six premises were re-verified against the live worktree on 2026-10-22 (premise
reports in the wave scratch; anchors below are from that pass). Every premise is
confirmed; two framing corrections were folded in: an undated claim answers as true at
every instant (isValidAt treats absent valid_from as unbounded), and provider consent
today never asks - it is implicit configuration, so the feature is a persisted decline
record plus name-only doctor disclosure, not a per-surface refusal fix.

## Scope

- F1 privacy markers (kanban t_e095afac): detect informal privacy frontmatter
  markers; remote-deny enforcement at the three read roots plus the indexed
  visibility column; preview-first tighten-only restamp verb; doctor finding.
- F2 chunk skip-and-hold (t_f029b413): over-window chunks are held, not embedded;
  persistent hold record excluded from the pending anti-join; bounded held-items
  report on the status wire; doctor check; census warning update; holds release on
  window/model/chunk-size change.
- F3 person-name variants (t_46296794): pure person-variant derivation (initials,
  word order, operator-extensible nickname data); query-side expansion with
  declared-vs-derived tracking; exact-declared-first ranking; registry lookup
  resolves derived variants with ambiguity-throws; doctor collision finding.
- F4 undated-quantity lint (t_fb442a24): fifth page-lint detector flagging
  counts/amounts written without any date, with structural escape hatches;
  diagnostics registration for next_command; advisory receipt stays
  absent-when-clean.
- F5 content-class egress (t_5f545a9b): server-derived creation-time
  `content_class` frontmatter key with reserved value `prompt-derived`, stamped at
  deterministic prompt-derived write paths, excluded by default from shared export
  verbs at the guard seam with per-verb operator override and named omissions;
  no-backfill era boundary; census extension.
- F6 provider-decline consent (t_fa467133): persisted decline resolution distinct
  from unset (fail-closed on unreadable config); honor the decline at provider
  construction before any network call; doctor consent probe naming provider env
  vars by name only; egress consent-stamp primitive with an environment kill
  switch (no destination declared in this release).

## Out of scope

- Backfilling `content_class` onto pre-existing pages (pre-stamp era is documented,
  never migrated).
- Any natural-language date recognizer for F4 (structural ISO shapes only, per
  src/core/search/temporal-intents invariant).
- Hardcoded English nickname word lists for F3 (operator-extensible data only;
  structural rules only).
- Widening the reserved visibility token set beyond `private` (visibility.ts:80-92
  docblock refuses a wider policy); informal markers enforce remote-deny only, not
  caller-scope restriction.
- Declaring a new egress destination for the consent stamp (primitive and kill
  switch only; the absorbed relay sibling stays deferred).
- Any new runtime dependency.

## Chosen approach

Six implementation lanes on disjoint file sets, one feature per lane, each lane a
red-first TDD sequence of 4-6 tasks committing per task. The lane split follows the
module ownership the premise reports verified: visibility roots (F1), the embedding
phase (F2), entity resolution (F3), page lint (F4), the egress seam (F5), provider
construction and doctor readiness (F6). Two shared files get single primary owners
with append-with-poll for the second writer: `src/core/brain/diagnostics.ts`
(primary F4, F1 appends its doctor signal in its final task after polling for F4's
commit) and `docs/cli-reference.md` (primary F5, F1 and F2 append their CLI doc
lines in their final tasks). `src/core/search/indexer.ts` is owned outright by F2;
F6's decline is resolved by `resolveProviderConsent` and handed to
`makeProvider(config.semantic, consent)`: the indexer's embed phase and its
embedding probe call the resolver directly (a coordinated edit with F2) and the
probe reports a decline as skipped. Integration is one integrator pass: census recounts, full local gates, the
docs and version bump land in the osb-pr-prepare sub-playbook.

## Design decisions

- F1 enforces remote-deny only, at the read roots (`isPathReadableAtReach`,
  `applyReachFilter`, `listVaultPages`) plus the indexed visibility stamp - not
  inside `pageVisibility` - so informal markers never become caller-scope-liftable
  tokens. Derived-page stamping is not untouched in the shipped tree: the derived
  drafters (tensions, pledges, the dream lane) union an informal marker's
  reservation into the `strictestVisibility` fold, and the counterparty brief's
  entity and preference gates read the same union, so a marker page's
  reservation reaches the pages derived from it. The restamp
  is additive-only: it unions the reserved token into `visibility:`, never removes
  keys or tokens, follows the dry-run-by-default repair-verb family contract, and
  rewrites through `writeFrontmatterAtomic` behind `assertVaultIdentityForWrite`.
- F2 holds decide on the conservative side of the token estimator: only
  provably-over-window chunks are held; the undecided band stays reported, never
  silently resolved. Held chunks leave the pending anti-join (a persistent hold
  marker keyed by model/window/signature), so vector-backfill neither re-embeds nor
  recommends forever, and a config change releases holds back into pending. The
  batch 1:1 invariant survives because holding filters before batching.
- F3 variant derivation is a leaf module (import-cycles ratchet) emitting frozen,
  bit-stable forms for person-category entities only, with a minimum-form-length
  floor and no variants for unspaced scripts. Ranking keeps the never-retrieval
  invariant: declared-form matches keep the existing boost lane, derived variants
  get a strictly smaller capped lane, both omitted when zero. Registry lookup
  consults derived variants only after an exact name/alias miss and throws
  `EntityAmbiguityError` on multi-match; write-target resolution never follows
  quarantined namesakes' variants.
- F4 reuses the existing detector skeleton (code constant, `finding()` factory,
  warning severity, 25-finding cap, absent-key-when-clean) and the structural date
  recognizers (`DATE_ONLY_RE`, `ISO_INSTANT_RE`) as escape hatches. Trigger
  classes are high-precision only: currency, percent, number-with-unit,
  thousands-separated counts; versions, list markers, table cells and code spans
  are excluded. Findings quote the matched lexeme and offset, never the line.
- F5 stamps `content_class` server-side at creation on the write paths that are
  definitionally prompt-derived (session import, MCP note writes, in-process
  generation pipelines that bypass createNote), reserves the key against caller
  updates beside `visibility`/`origin_channel`, and enforces the default exclusion
  once at the shared guard so every `shared_redactor` site inherits it. Spelling
  avoids every origin-channel census spelling. Override is per-verb, names every
  omission in output, and the transcript export refuses-or-names rather than
  silently emptying.
- F6 resolves decline through one resolver consumed by provider construction;
  an unreadable or unparseable consent record resolves to declined (fail-closed).
  The doctor probe extends the readiness probe registry and prints env var NAMES
  only - tests assert absence of values. The consent-stamp primitive ships with an
  environment kill switch that no env value can re-enable, and declares no
  destination.

## File changes

Lane ownership (new files marked +):

- F1: `src/core/graph/privacy-markers.ts` (+), `src/core/graph/visibility.ts`,
  `src/core/search/result-filters.ts`, `src/core/vault.ts`,
  `src/core/search/indexer.ts` (visibility stamp only, coordinated with F2),
  `src/core/brain/privacy-marker-restamp.ts` (+), `src/core/brain/doctor/privacy-marker-check.ts` (+),
  `src/core/brain/doctor.ts`, `src/core/brain/applier-capability.ts`,
  `src/core/brain/doctor-exits.ts`, `tests/core/graph/`, `tests/core/search/`,
  `tests/core/brain/`.
- F2 (owns `src/core/search/indexer.ts`): `src/core/search/indexer.ts`,
  `src/core/search/schema.ts` (migration), `src/core/search/store/chunks.ts`,
  `src/core/search/store/counts.ts`, `src/core/search/embedding-spend.ts`,
  `src/core/search/serialize.ts`, `src/core/search/types.ts`,
  `src/core/brain/doctor/` (held-sources check), `tests/core/search/`.
- F3: `src/core/brain/entities/person-variants.ts` (+),
  `src/core/search/entity-alias.ts`, `src/core/search/pipeline/candidate-signals.ts`,
  `src/core/search/ranker.ts`, `src/core/brain/entities/registry.ts`,
  `src/core/brain/doctor/entity-checks.ts`, `tests/core/search/`, `tests/core/brain/`.
- F4: `src/core/brain/undated-quantity.ts` (+), `src/core/brain/page-lint.ts`,
  `src/core/brain/diagnostics.ts` (primary owner), `src/cli/brain/help-text.ts`,
  `tests/core/brain/`, `tests/mcp/`.
- F5: `src/core/brain/provenance/content-class.ts` (+),
  `src/core/egress/guard.ts`, `src/core/egress/registry.ts`,
  `src/core/brain/write-batch.ts`, `src/core/brain/notes/create-note.ts`,
  `src/core/brain/sessions/import.ts`, `src/core/brain/research/research.ts`,
  `src/core/brain/portability/knowledge-pack.ts`, the CLI export verbs,
  `tests/core/architecture/egress-census.test.ts` (extension),
  `docs/cli-reference.md` (primary owner), `SECURITY.md`.
- F6: `src/core/search/provider-consent.ts` (+),
  `src/core/egress/consent-stamp.ts` (+), `src/core/search/embeddings/provider.ts`,
  `src/core/search/semantic-phase.ts`, `src/core/brain/config-template.ts`,
  `src/core/doctor-readiness.ts`, `src/core/state/surfaces.ts` (only if a durable
  file appears), `tests/core/search/`, `tests/core/`.

## Risks and open questions

- Census coupling is the integration risk: a lane that ships detection without its
  census/registry rows does not build green (doctor-exit census, applier-capability,
  egress census population, state-surface counts, visibility-surface pins). Every
  lane brief carries its census checklist; the integrator recounts.
- F1 behavior change on import-heavy vaults: pages using `access:` for non-privacy
  purposes vanish from remote readers after upgrade. The marker set and value
  matching are pinned by tests; the doctor finding is the operator's discovery path.
- F2 recall drops for held sources (semantic lane skips them, FTS still matches);
  the held list must stay visible on status and doctor or one silence replaces
  another.
- F3 false-positive person matches (initials, shared nicknames): mitigated by
  exact-declared-first ordering, ambiguity-throws-over-guessing, person-folder
  scoping, and the doctor collision finding.
- F5 transcript export has a contract to export session material; the class
  default must refuse-or-name there, never quietly empty.
- The consent decline record must not become a third parallel "off" spelling beside
  the capability tier; the resolver extends the tier ladder rather than duplicating
  it (import-cycle ratchet limits the home).
