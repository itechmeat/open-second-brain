### Variant 1: The observation spine
- **Approach**: One new closed-vocabulary seam — an operation-lifecycle event (started / advanced / refused / stopped / finished) carrying the existing `SafeguardOperation` id — emitted synchronously from the `checkpoint()` boundaries that already exist, delivered through an optional sink on the same `opts` object that already carries `safeguard`, and modelled on the indexer's proven `onFile?` callback rather than a new abstraction. Core only emits; every edge decides whether it can carry the event (a stderr writer for commands that are not stdout-owning or buffer-patched, a stated non-carrier for the stdio and HTTP MCP transports and for the twelve JSON-owning commands, since `progressToken` cannot be honoured without a notification channel). Durability is a census test that enumerates every `SafeguardOperation` and every long entry point and fails when one runs without either an emitter or a declared reason it cannot carry one.
- **Trade-offs**:
  - Pro: units 1, 3 and 4 are the same seam — the dead `signal?`/`SafeguardAbortError` pair becomes the `stopped` event's producer, and the detached-reindex herd becomes a `refused` event with the losing child's `INDEX_LOCKED` surfaced instead of discarded into an ignored stderr.
  - Pro: exactly matches the mechanical conventions (four-piece vocabulary, census enforcement, layering test satisfied by construction) and adds no daemon, scheduler or network.
  - Pro: the `refused` member gives units 7 and 8 a native home — "cannot classify environment", "cannot name a vendor from a transport kind", "load average is not answerable here" become the same typed refusal rather than three ad-hoc strings.
  - Con: the spine does not itself fix the honesty half of the thesis; units 5, 6, 8 and 9 still need their own edge-local work and only borrow the refusal vocabulary.
  - Con: a sink threaded through every long operation touches many call sites at once, and the "declared non-carrier" list is a place future work can quietly park things.
  - Con: MCP gets no progress at all in this release, which will read as a gap even though it is the honest outcome of having no SDK and a single-response transport.
- **Complexity**: large
- **Risk**: medium

### Variant 2: The claim census
- **Approach**: Take the second half of the thesis as the organising principle: no user-facing assertion may ship unless it is a registered claim with a resolver that checks it, or a registered refusal that names why it cannot be checked. The release adds a frozen id-keyed claim registry plus a census test enumerating the assertion sites across install output, doctor checks, the four install result shapes, environment reporting, provider health and the conformance metrics — and reclassifies each of the nine units as either "claim now backed" or "claim replaced by a named refusal". Progress and cancellation enter as claims too: "this pass is running", "this pass was stopped on purpose", "this reindex lost the lock".
- **Trade-offs**:
  - Pro: it is the sharpest possible answer to "prints claims it never checked" — the install data-ownership line, the environment class, the decommission warning, the exact-token count and the zero-leakage gate are all the same defect and get the same mechanism.
  - Pro: the mechanism generalises past the release; every future claim has to declare, matching the previous release's own stated argument about hand-called mechanisms.
  - Pro: forces the disagreements to the surface early — the install vault-resolution chain, the vault identity keyed by a machine-local secret, the settings that default off — because a claim with no honest resolver cannot be registered.
  - Con: blast radius across 110 MCP tools and every CLI surface is the largest of the three; the census is only as good as its enumeration and mis-scoping it either strangles ordinary output or under-covers.
  - Con: units 1 through 4 fit awkwardly — progress and cancellation are behaviour, not assertion, and framing them as claims is a stretch that will show in the code.
  - Con: high chance the release ships a registry with more refusals than resolvers, which is honest but reads thin.
- **Complexity**: large
- **Risk**: high

### Variant 3: Wire what is dead, refuse what is unanswerable, delete what was wrong
- **Approach**: Ship no new subsystem and no new vocabulary; instead pair each of the nine with the mechanism that already exists and either connect it or state by name that it cannot be connected. Concretely: pass a real signal into the declared `signal?`; share the embedding semaphore per process instead of per call; route the reindex spawn through the maintenance lane's existing pressure signal, TTL lease and typed journal verdicts rather than inventing host-load gating; replace the frozen adapter array with the registry pattern already present under another name; put the decommission check on the doctor that has the injected clock and severity ladder and point the operator at the catalog-listing verb; correct the scanner's walk (dot-directories, `.gitignore`, one traversal, locale-independent tie-break) and drop the concurrency ask that targets 2% of the run; fix the watchdog ceiling to match the declared hook timeout. Durability comes from extending the existing census tests — doctor exit codes, write sites, vocabularies, help parity — rather than adding a new enforcement layer.
- **Trade-offs**:
  - Pro: every fix lands inside an idiom the repo already enforces, which is the strictest reading of "maximally native integration, no crutches".
  - Pro: lowest risk per unit and each unit is independently revertable; the corrected reconnaissance framing is honoured exactly, including the units where the original ask was wrong.
  - Pro: naturally accommodates the honest refusals — no environment classifier, no load average, no exact token count — because refusal by name is already the established answer.
  - Con: no single durable mechanism comes out of it; nine local fixes with nine local guards, and the next long operation added still emits nothing because nothing forces it to.
  - Con: unit 1 degrades to "the indexer callback, copied" — progress for `dream` becomes a bespoke callback rather than a shared contract, which is the parallel-idiom the operator's constraint warns against.
  - Con: the through-line is the weakest of the three and repeats the previous release's thesis almost verbatim, which makes the release hard to state in one line.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 1
**Rationale**: The spine is the only option where the largest and most entangled units — the silent `dream`, the dead `SafeguardAbortError`, and the herd of detached reindexes dying into an ignored stderr — collapse into one seam that the codebase has already carved out for it, at the checkpoint boundaries and on the same `opts` object, with a working precedent in the indexer's per-file callback. Its `refused` member gives the honesty units a native home for the answers that must be refusals rather than plausible numbers, so it carries both halves of the thesis without the blast radius of retrofitting a claim registry across 110 tools. Variant 3 is safer per unit but leaves nothing that forces the next long operation to speak, which is precisely the failure the previous release argued against.
