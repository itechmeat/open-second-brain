# Consultant variants: release wave structure (five features, one branch, one PR)

### Variant 1: Five independent lanes, conventions on paper
- **Approach**: Implement each of the five cards as a self-contained lane on the shared branch, extracting no shared code. The consent ladder, receipt line, cursor envelope and adapter composition are each written where the lane needs them, and a short design note declares the conventions so a later wave can consolidate. Lane order is arbitrary because nothing depends on anything.
- **Trade-offs**:
  - Fastest to start and zero cross-lane merge friction; each lane reviews in isolation.
  - The two host-settings guards (t_b6bcd984 diff-plus-consent on the three write lanes, t_f4555087 backup hook) will drift toward two receipt formats for one story, because the hook is a standalone stdlib script and will be tempted to inline its own serializer that no test pins to the CLI lanes.
  - Cursor pagination copied per tool from the decisions implementation recreates exactly the optional-versus-required next_cursor inconsistency the validator named as the reason the card exists.
  - The deliberate headless-caller break (doctor repair now requires an explicit yes) lands without a pinned consent-verdict vocabulary, leaving the event log ambiguous between confirmed and automatic writes.
  - A convention note cannot be enforced, only hoped for; there is no shared test to fail when a lane deviates.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Shared infrastructure layer first
- **Approach**: Open the branch with one common layer: a host-config guard module owning the diff render, the consent gate, the backup-folder layout and the receipt line; a global pagination helper over the MCP surface; a formalized adapter seam. All five lanes are then built on top of that layer in strict order, with the PreToolUse hook importing from the layer like every other consumer.
- **Trade-offs**:
  - Maximum uniformity: one receipt format, one cursor shape, one consent vocabulary, enforced by shared tests.
  - Over-abstraction risk: the trigger lane and the Converse adapter have no honest use for the guard module, so the layer either grows speculative knobs or those lanes couple to it anyway.
  - Making the hook import core breaks its stdlib-only, fail-closed property; the hook must survive a broken or absent core install, and a core import turns a failed backup into a failed hook load on every client that ships it.
  - The infra commit gates all five lanes, serializing work that is otherwise parallel; a late correction in the consent lane reopens the shared layer for everyone.
  - A global pagination helper invites rewriting list semantics across the whole MCP surface, well beyond the card's scope.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Cluster-honest sharing with a sequencing contract
- **Approach**: Share machinery only where several real call sites already exist inside one surface, and pin cross-surface agreements as contracts instead of imports. A first commit lands the host-settings conventions (one receipt-line schema with actor, pid and before-hash plus a per-lane tail, consent verdict on the CLI lanes and summary on the hook; one timestamped backup-folder layout; one consent vocabulary covering confirmed, refused and headless-refused) consumed directly by the doctor-repair, protect and install JSON-merge lanes and pinned by a fixture test for the standalone hook; a second commit extracts one pagination helper from the existing decisions and search-expand implementations, standardizing on the required next_cursor precedent. After those two commits all five lanes run in parallel under one ordering rule, the backup-hook lane starting only once the receipt contract is pinned, while the Converse adapter composes the existing transport helpers beside vercel-evaluate and the trigger lane touches only the trigger store.
- **Trade-offs**:
  - Honest sharing only: the guards cluster gets one receipt format and one backup layout, the MCP surface gets one cursor shape, and no other lane shares anything.
  - The hook-to-contract link is a fixture test rather than an import, so the hook stays stdlib-only and fail-closed, at the cost of a second place the receipt schema appears.
  - The shared infrastructure is two small commits, not a layer, so lanes stay parallel and a late correction in one lane reopens nothing for the others.
  - Per-feature risks to record in the design doc:
    - Diff and consent lanes (t_b6bcd984): the headless break is deliberate and must be documented as one unambiguous flag; consent must compose with, never replace, the existing drift guard, so an explicit yes does not silently overwrite drifted host config and the drift refusal still names its remedy; the three lanes keep their distinct no-semantics (abort versus skip per fix) rather than one flattened gate; the receipt verdict must distinguish confirmed from automatic writes for existing receipt readers, and protect's own timestamped settings backup stays untouched beside the new convention.
    - Backup hook (t_f4555087): fail-closed means a failed backup refuses the agent's write, so opt-in default-off is the ship posture and the refusal names the path; path resolution must cover tilde, relative and symlink forms, with the honest limitation stated that a symlinked or temp-then-rename target can see the hook back up one path while the write lands on another, and that matching Bash calls to file targets is heuristic; the never-overwrite-a-same-second-backup rule is kept; hook latency on every Edit and Write, and per-client hook-surface differences, are measured before the flag is recommended in install docs.
    - Cursor pagination (t_5198f0c7): standardize on next_cursor present in every answer with the exhausted case stated explicitly rather than by omission, since an optional field some tools omit recreates the inconsistency; the keyset-or-offset encoding and the ordering it assumes are named per store so shifting rows between calls cannot skip or duplicate; on budgeted tools the paging contract and the preview_truncated plus artifact_id envelope are documented as answering different questions so a caller is never told to follow two continuations at once; any list tool left hard-capped says so.
    - Converse adapter (t_7ff0b101): the preset ships with a declared thresholdProfile and a calibration path, because an unprofiled route runs unenforced and would silently lower decision quality; the adapter covers only the request and response subset the decision model needs and fails loud on the rest rather than half-emulating the protocol family; bearer credentials flow through the existing custody conventions; an unknown adapter name in a stored config fails closed and names itself.
    - Snooze and movement-gated resurrection (t_00e9de6a): snooze is a new open status with a wake instant, waking at window end or next refire whichever comes first, so recordRecurrence must consult snooze state instead of silently incrementing occurrences; movement is defined as changed source artifacts since dismissal, never lastSeenAt alone, so an unchanged re-fire stays quiet; suppress semantics stay untouched as the clockless sibling; effectiveStatus must compose dismissed, snoozed and cooldown without contradictory wake rules on one twin, and the morning brief renders snoozed honestly as neither open nor gone.
  - Slightly less uniform than a global layer: the adapter and trigger lanes share nothing, which is the point.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 3
**Rationale**: It shares machinery exactly where multiple real call sites already exist, one receipt-and-backup convention across the two guard cards and one cursor helper across the MCP list tools, and refuses every other coupling, keeping the standalone hook stdlib-only and fail-closed while the adapter and trigger lanes stay independent. The two convention commits are small enough to land first without gating parallel work, and the trade-off list above is the per-feature risk record the design doc needs, including the deliberate headless break, the drift-guard composition rule, the required next_cursor precedent, the threshold-profile-before-route rule and the movement-not-timer resurrection definition.

## Orchestrator decision

Variant 3 is chosen. Its parallel lanes with pinned conventions match this wave's disjoint file ownership: the trust lane pins the consent, receipt and backup conventions and the pagination lane pins one cursor helper, while the Converse adapter lane and the trigger lane share nothing with the others. Variant 2's shared-infrastructure-first sequencing would serialize all five lanes behind one substrate whose helper code only the trust and pagination lanes honestly consume, and it would force the standalone hook to import core, giving up the stdlib-only fail-closed property the card requires. Variant 1 was rejected because a conventions-on-paper note has no failing test to enforce it, which is exactly where the two guard cards would drift into two receipt formats for one story.
