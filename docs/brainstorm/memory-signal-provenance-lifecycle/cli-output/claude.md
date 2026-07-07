### Variant 1 — Shared-substrate first
Approach: Land the three cross-cutting primitives as standalone modules before any consumer: a `manifest` module (content-hash cache + classify), an `idempotency` key→content-hash ledger under `Brain/`, and a single `dryRun` gate that wraps every continuity-append surface. All 13 cards then reduce to thin verticals that call into settled infrastructure.
Trade-offs:
- Maximal reuse and one canonical answer for each concern (one hashing path, one dedup notion, one preview switch) — no divergent re-implementations.
- Couples the p4 anchors (A1) and the shared ledger to the p2 capstones (A3, C4) through APIs designed before their only consumers exist, so the primitive shape is guessed, not validated; a wrong guess forces a rewrite that ripples across cards.
- A global dry-run wrapper contradicts the existing per-surface `opts.dryRun` idiom in `import.ts` and risks a leaky abstraction that must special-case dream/retire triggers anyway.
Complexity: large
Risk: high

### Variant 2 — Self-contained verticals
Approach: Treat every card as an independent vertical driven by priority then dependency, with no shared modules beyond the existing `sourceIdentityHash`/SHA-256 primitive. A1 grows its manifest inside ingest; C1 grows its ledger inside feedback-tools; C4 and A3 reach directly into whatever their parents left behind rather than a shared API.
Trade-offs:
- Lowest coupling and simplest per-card review; each commit is atomic and byte-identical-when-off is trivial to verify in isolation.
- The two hard composition edges (A1→A3, C1→C4) still force reuse, so "no shared module" is a fiction — A3 and C4 either duplicate parent logic or depend on internal shapes, producing drift (two idempotency notions, two hash-manifest readers) that the next release must reconcile.
- No structural place for the dry-run concern shared by C2 and any future preview, so C2's short-circuit logic is bespoke and hard to prove faithful to the real extraction path.
Complexity: medium
Risk: medium

### Variant 3 — Topological hybrid: shared seams only at composition edges
Approach: Extract shared infrastructure only where a hard dependency already mandates it — A1 ships the manifest as a real module because A3 consumes it, C1 ships the key→content-hash ledger as a real module because C4 consumes it — and keep everything else a self-contained vertical, mirroring `import.ts`'s existing `opts.dryRun` as a per-surface parameter rather than a global wrapper. Drive in a topological order that serializes every shared-file collision: A1 → C1 → A2 → D2 → D1 → C2 → C3 → C5 → C6 → A3 → C4 → D3.
Trade-offs:
- Each shared module is designed against a concrete consumer (A3, C4) landed shortly after, so the API is validated by use, not guessed; the p4 anchors never wait on the p2 capstones.
- File collisions resolve by ordering, not merging: A1 before A3 on `ingest.ts`; A2 before C2 on `import.ts` (event-time settles the emit path, then dry-run gates it); D2 before D3 on `contradiction.ts`; D1 owns `truth/{fold,conflicts}.ts` alone as a pure projection over the append-only ledger.
- Two genuine modules (manifest, ledger) plus disciplined ordering is more upfront design than pure verticals, and the capstones (A3, C4, D3) landing last means the longest-pole cards gate branch completion.
Complexity: medium
Risk: low

### Recommended: Variant 3
The release's own constraints already dictate the answer: two hard composition edges (A1→A3, C1→C4) mean the manifest and idempotency ledger *must* be reusable, but nothing else composes, so building the full shared substrate of Variant 1 pays coupling and speculative-API cost for reuse the cards do not ask for. Variant 2's refusal to extract even those two modules is a false economy — the edges force reuse regardless, and doing it implicitly produces exactly the duplicate-hash / dual-idempotency drift this release exists to eliminate. Variant 3 extracts shared code precisely at the mandated seams and validates each module against a consumer landed immediately after, while a single topological drive order serializes all five shared-file collisions and honors all three parent→child edges without coupling the p4 anchors to the p2 capstones. Keeping dry-run as a per-surface parameter that mirrors the existing `import.ts` idiom preserves the byte-identical-when-off invariant and keeps preview faithful to real extraction, which a global wrapper cannot guarantee.
