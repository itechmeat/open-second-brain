### Variant 1: Two kinds on the existing grammar, existing entry points only

- **Approach**: Extend `MarkerKind` with `fact` and `skill`, add their rows to `KNOWN_KINDS` and `REQUIRED_FIELDS` (`fact`: topic + principle + premises; `skill`: name + trigger + procedure), and add two narrowing type guards beside `isFeedbackMarker`. Routing reuses stores that already carry a review gate: a `fact` marker lands as an unconfirmed preference via the `derive-fact` path (premise validation stays fail-closed, so an unresolvable premise is an explicit error, not a silent drop), a `skill` marker lands in the **pending** skill-proposal store with a marker-sourced pattern kind, never in accepted. Answer to the open question is "no": `o2b brain scan-inline --path <dir>` already lets an operator point the scan at a chosen subtree, and the source bundle stays inside the vault.
- **Trade-offs**:
  - Pro: no second grammar, no new entry point, no new trust boundary — the fence-awareness, sentinel idempotence, dedup-hash and rewrite machinery apply to the new kinds for free.
  - Pro: absent markers, behaviour is byte-identical; the two kinds are purely additive to a table.
  - Pro: reviewability comes from the destination stores (unconfirmed preference, pending proposal), not from new gating code.
  - Pro: `skill` proposals seeded by marker need a `SkillProposalPatternKind` value; adding a marker-provenance kind touches the verifier's assumptions about pattern evidence.
  - Con: does not satisfy the article's literal "arbitrary source bundle" — plain text living outside the vault must first be copied in.
  - Con: `fact` and `skill` payloads are richer than `topic=…`-style scalars; multi-line procedures effectively force the block shape, so the inline shape is second-class for `skill`.
- **Complexity**: small
- **Risk**: low

### Variant 2: Two kinds plus a read-only external source-bundle verb

- **Approach**: Variant 1, plus a new deterministic verb (`o2b brain scan-source <file>`) that runs `discoverMarkersDetailed` over an operator-supplied path outside the vault and reports every marker with its parse verdict. Default is report-only: no signal write, no source rewrite, because the file is outside the replicated tree and `ensureInsideVault` cannot cover it; an explicit `--import` flag copies the discovered markers into `Brain/inbox/` while leaving the external file untouched (idempotence then rests on the dedup hash alone, not on the consumed sentinel).
- **Trade-offs**:
  - Pro: matches the article's workflow exactly — a bundle authored by another tool is exercised end to end with zero model calls.
  - Pro: strong fixture and demo surface: one file, one command, structured per-marker verdicts suitable for golden tests.
  - Pro: gives cross-tool authoring a real seam without a Model Context Protocol round trip.
  - Con: introduces the first read path outside the vault root, which is a genuine new trust boundary against the path-safety invariant, and needs its own size/symlink/encoding limits.
  - Con: without in-file rewrite, re-running `--import` over the same bundle relies entirely on dedup hashing; any hash-relevant field change silently re-imports as new.
  - Con: a new verb means a new registered diagnostic code family for its failures and a new command-line surface to keep stable.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: New kinds route into the staged dream proposal bundle

- **Approach**: Add the two kinds as in Variant 1, but do not let them write to their final stores. Marker discovery becomes an input to `dream stage`: `fact` and `skill` markers flatten into `proposals.jsonl` as new proposal types (`create_derived_fact`, `create_skill_proposal`) alongside the existing `create_preference` rows, and are only materialised when the operator applies the bundle. The staged report renders them in their own sections, and discard drops them with the rest of the bundle.
- **Trade-offs**:
  - Pro: closest to the article's actual thesis — reviewable self-improvement, with a single uniform review point rather than one per destination store.
  - Pro: one place to validate premises and skill shape, so the skill verifier is never handed a marker-seeded candidate it has no pattern evidence for.
  - Pro: the persisted bundle is already the deterministic artifact tests assert against, so fixtures get stronger with no new file format.
  - Con: widens `planToProposals` and the plan type beyond preference/signal lifecycle, which is the largest conceptual change of the three.
  - Con: markers now have two different fates depending on kind (feedback writes a signal immediately, fact/skill waits for an apply), which is a real asymmetry operators must learn.
  - Con: plan-drift detection between stage and apply must be extended to cover the new rows, or a bundle can be applied against source files that have since changed.
- **Complexity**: medium to large
- **Risk**: medium

### Recommended: Variant 1

**Rationale**: The open question resolves to "no" — `scan-inline --path` and `apply-markers --path` already give an operator marker discovery over a chosen subtree, and reading source files outside the vault would breach the path-safety invariant for a convenience the operator can get by placing the bundle in the vault, so Variant 2's cost buys little. Variant 3 solves a review problem that is already solved by the destination stores: a marker-seeded fact becomes an *unconfirmed* preference that the dream pass gates, and a marker-seeded skill lands in the *pending* proposal store that already has accept/reject, so routing them through the stage bundle duplicates gating rather than adding it. Variant 1 keeps the change to two rows in `REQUIRED_FIELDS`, two type guards and their routing, which is byte-identical when the markers are absent and is exactly the narrow delta the re-verification identified.
