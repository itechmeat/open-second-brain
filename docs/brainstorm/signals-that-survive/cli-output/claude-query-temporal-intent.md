### Variant 1: Temporal intent at the query-plan seam, modulating `recencyMul` only
- **Approach**: Extend `src/core/search/query-plan.ts` with a new structural `temporal` intent, detected only from signals that survive the language-agnostic invariant — ISO tokens in the query text (reusing `extractTemporalConstraints`) and the existing `<field>:<value>` grammar (`since:`/`until:`). The plan resolves a target window and, when that window's midpoint is materially older than `now`, emits a `WeightProfile` with `recencyMul` below 1 (down to 0 for an explicitly historical query); a near-now window amplifies it. Nothing in `ranker.ts` changes — `recency * recMul` at ranker.ts:416 is already the modulation point.
- **Trade-offs**:
  - Smallest possible diff: one detector, one profile row, zero new scoring layers, zero new `ScoreBreakdown` fields, no MCP surface change.
  - `planHash` already feeds the query cache, so cache correctness comes for free.
  - Bounded by construction — the existing `[0.7, 1.4]` profile discipline means a misdetection can only re-weight, never float an unrelated document.
  - Only suppresses or amplifies; it cannot *promote* documents inside the target window, so "what did I decide back in spring?" stops being actively hurt but is not actively helped.
  - Overloads a single scalar with two distinct meanings (freshness prior strength vs. temporal-intent direction), which makes the `reasons` output harder to read: a suppressed recency layer just silently disappears.
  - `WeightProfile` is currently a per-intent constant table; a window-derived continuous `recencyMul` breaks that table's "fixed structural-feature → profile" property.
- **Complexity**: small
- **Risk**: low

### Variant 2: Anchor-shifted Weibull — recency measured from the query window, not from `now`
- **Approach**: Keep one recency layer but make its reference instant query-derived: the plan resolves a target window and `search.ts` threads an optional `recencyAnchorMs` (or the resolved window) into `RankerOptions`, so `recencyBoost` computes age as distance from the *window edge* rather than from `now`. Absent an anchor the age is `now - mtime` exactly as today, so ranking stays byte-identical; with an anchor, the same Weibull curve becomes a soft two-sided band centred on the queried period.
- **Trade-offs**:
  - Conceptually the most faithful reading of "window-shift the recency layer": one curve, one tuning surface, `recencyShape`/`recencyScale`/`recencyAmplitude` keep their meaning, and `recencyAmplitude: 0` remains the documented global off switch.
  - No new score component, no new breakdown field, no growth in the explain payload.
  - Changes the semantics of `weibullDecay`'s only input from "age" to "distance", which currently has a documented one-sided contract (`ageDays <= 0`, including future timestamps, returns full amplitude). Making it two-sided touches the most-depended-upon and most-tested primitive in the ranking stack.
  - The `recency: 0.041` reason string silently changes meaning per query, and downstream consumers (`feedback.ts`, MCP `explain`, tuning/eval gates, the semantic-health baseline watermark) compare recency across queries — a shifted anchor makes those series non-comparable without a marker field.
  - Fights the existing tie-break, which sorts by `mtime` descending: an older in-window document can win on score and then lose the tie-break to a newer out-of-window one.
- **Complexity**: medium
- **Risk**: high

### Variant 3: Detection at the plan seam + a separate capped `temporal_match` layer
- **Approach**: Same detection front half as Variant 1 (ISO tokens plus structured field tokens, resolved through `time-range.ts` into a `ResolvedTimeRange`), but the ranker consumes it as its own bounded additive layer rather than as a recency multiplier: reuse the already-pure `temporalProximity` from `temporal-bridge.ts` over a per-candidate event time (validity start, else `mtime`) to produce a capped boost, alongside a modest `recencyMul` damping when the window is historical. It follows the exact shape every other layer in `rankResults` uses — optional input map, absent map contributes zero, one `reasons` entry, one `ScoreBreakdown` field.
- **Trade-offs**:
  - Handles both halves of the problem: suppresses the wrong-direction freshness prior *and* promotes documents that actually sit in the queried window, which is the whole point of the upstream signal.
  - Reuses two already-written, already-tested pure functions (`temporalProximity`, `parseTimePoint`) and the existing event-time resolver `search.ts` already builds for the temporal bridge — very little genuinely new math.
  - Freshness prior and temporal intent stay separately observable in `reasons`/`breakdown`, so tuning, eval gates, and the `explain` projection can attribute a ranking change to the right layer.
  - Soft window match complements — rather than duplicates — the existing hard `since`/`until` filter: a query-text-derived window biases without excluding, which is the safer default for an inferred signal.
  - Widest blast radius of the three: a new `ScoreBreakdown` key (additive, but it is an MCP-visible shape), new plumbing through `search.ts`, and a new capped constant that must be calibrated against the link/entity/activation/reuse caps so the layers stay in proportion.
  - Requires an event-time map for the full candidate pool, not just link expansions — more store work per query than either alternative.
  - Two knobs move at once (new boost plus recency damping), so an A/B on retrieval quality needs both isolated.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 3
**Rationale**: It is the only variant that delivers the actual upstream capability — biasing *toward* the queried window — rather than merely stopping the freshness prior from hurting, and it does so in the exact idiom the ranker already uses (optional input map, capped additive boost, absent map ⇒ byte-identical ranking), so the "every new key leaves behaviour byte-identical when absent" constraint is satisfied structurally rather than by care. Variant 2 buys elegance by mutating `weibullDecay`'s contract and silently redefining the `recency` component that tuning, feedback, and eval gates already track across queries, which is a disproportionate regression surface for an enhancement-priority item. Variant 1 is the cheapest and is a legitimate fallback if scope must shrink, but it leaves the motivating "what did I decide back in spring?" case only half-served; note that under this repo's language-agnostic rule, *all three* variants must detect intent from ISO tokens and structured field tokens only — the "last week"/"recently" natural-language detection Signet performs is not portable here and should not be attempted.
