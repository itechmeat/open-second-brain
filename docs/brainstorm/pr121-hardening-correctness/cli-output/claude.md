## Variant 1 — Card-sequential single minor (1.24.0), risk-ordered

**Approach:** Ship all 13 fixes as one minor on the shared branch, committed one card at a time in risk order: land t_f27d80fe first (rebase `ec3bad27` in as-is, then extend it with the `INDEX_UNREADABLE`→self-heal change as a follow-on commit), then the low-risk correctness cluster (B.1–B.4 + the Han-bigram tokenizer), then the contract-neutral perf items (C.1, C.3–C.6), and finally C.2 as the release-defining commit carrying the `LATEST_SCHEMA_VERSION` bump, the `basename` column, and the version/CHANGELOG bump. One reindex at release absorbs both C.2 and the tokenizer's re-tokenization.

**Trade-offs:**
- Each card stays a contiguous, independently-revertable commit cluster — matches the "one card at a time / each unit revertable" convention exactly.
- Data-loss fix reaches `main` first and stays green through every later commit; perf work rebases on a stabilized base, not vice-versa.
- Self-heal expansion rides with t_f27d80fe (its natural home) and stays decoupled from the reindex-forcing schema bump — two independent safety/contract surfaces reviewed separately.
- The whole minor is gated behind one reindex because of C.2, so even pure-correctness fixes only take effect post-reindex for users — acceptable for a minor, but not a fast path for the P4 data-loss fix.
- Longest single branch lifetime; later cards carry the most rebase surface.

**Complexity:** medium
**Risk:** low

## Variant 2 — Two-release split: correctness patch (1.23.1) then perf+schema minor (1.24.0)

**Approach:** Cut two releases from the shared branch. First a patch: t_f27d80fe (data-loss) + the contract-neutral parts of t_2ba5f0c9 (B.2 surrogate, B.3 precision, B.4 audit redaction) — no schema change, no reindex, ships immediately. Then a minor stacked on the patch: all of t_1224c740, C.2's schema bump, the Han-bigram tokenizer, and B.1's `created_at` tightening, all gated behind a single reindex.

**Trade-offs:**
- Gets the highest-priority silent-data-loss fix to users fastest, with zero reindex burden.
- Two version bumps + two CHANGELOG headings + two PRs on a protected `main` — doubles the release ceremony that CLAUDE.md mandates per PR.
- Forces splitting t_2ba5f0c9 across releases: B.1 is a contract *tightening* (previously-accepted garbage → `INVALID_PARAMS`) that belongs behind a minor, so the card can't land atomically — violates card atomicity.
- Two reviewable surfaces are each smaller, but the stacked-PR dependency and cross-release version reconciliation add coordination risk.
- Best operational safety for the data-loss class; worst fit for the "drive cards one at a time, atomically" framing.

**Complexity:** large
**Risk:** medium

## Variant 3 — Contract-surface-partitioned single minor (1.24.0)

**Approach:** Regroup the 13 fixes by whether they touch a frozen contract or require reindex, ignoring card boundaries for commit shaping. Land every contract-neutral fix first (t_f27d80fe lock, B.2/B.3/B.4, C.1/C.3–C.6), then a single terminal "contract + schema" commit that bumps `LATEST_SCHEMA_VERSION`, adds the `basename` column, tightens `created_at` (B.1), folds in the tokenizer reindex, expands the self-heal set, and carries the version bump — one reindex, one concentrated contract-review target.

**Trade-offs:**
- Concentrates the entire frozen-contract blast radius into one clearly-labeled commit — ideal review focus for a frozen-contract project.
- Fuses unrelated fixes (schema column, timestamp validation, tokenizer, self-heal) into one fat commit: sacrifices per-fix revertability and violates "each unit independently revertable / atomic conventional commits."
- Couples the `INDEX_UNREADABLE` self-heal safety change to the reindex-forcing schema bump — a rollback of one drags the other.
- Cross-cutting commit ordering diverges from the "one card at a time" driving model, complicating per-card TDD attribution and merge-conflict reasoning against siblings.

**Complexity:** medium
**Risk:** high

**Recommended: Variant 1** — it is the only shaping that honors every stated convention simultaneously: cards land one at a time as contiguous, independently-revertable commit clusters with per-fix TDD, the P4 data-loss fix stabilizes the base before perf work rebases onto it, and the single unavoidable reindex is anchored to C.2 as its own auditable schema commit — keeping V3's contract-review clarity (schema bump is isolated) without fusing unrelated fixes or coupling the self-heal safety change to the reindex. The split in V2 buys faster data-loss delivery at the cost of doubled release ceremony on a protected `main` and a non-atomic t_2ba5f0c9, neither of which this repo's bump-in-PR discipline and card-atomic framing tolerate cleanly.
