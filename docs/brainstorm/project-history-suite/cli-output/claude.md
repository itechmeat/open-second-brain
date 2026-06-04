### Variant 1: Markdown-native (one note per commit, wikilink edges)
- **Approach**: Every ingested commit becomes a markdown note under `Brain/git/<repo>/commits/<sha>.md` with YAML frontmatter and a body; tags/releases/authors get their own notes; all edges are `[[wikilinks]]` resolved by the existing backlink index and surfaced through FTS5 and context packs with no new query path. The watermark is a small per-repo state note (or frontmatter on a repo index note); the miner reads commit notes back via FTS keyword scan and writes ADR candidates as sibling notes under `Brain/decisions/candidates/`; arch-docs reuses the same note renderer with an HTML-comment region-merge layer on top.
- **Trade-offs**:
  - Pro: zero new query infrastructure — everything is searchable, backlinkable, and context-pack-eligible the day it lands.
  - Pro: edges are first-class graph primitives (wikilinks), matching the existing typed-link/backlink model exactly.
  - Pro: incremental ingest dedup is trivial (note exists at deterministic path = already ingested).
  - Con: thousands of tiny files per active repo bloats the vault, reindex time, and backlink index; FTS noise drowns user notes.
  - Con: file-touch edges (commit↔file) explode wikilink fan-out; a 500-file commit writes 500 links.
  - Con: no compact analytical query (fan-in/out, author rollups) without scanning many notes.
- **Complexity**: medium
- **Risk**: high

### Variant 2: Sidecar store (JSONL/SQLite source of truth, structured edges, thin digest notes)
- **Approach**: Commits, tags, releases, authors, and all edges live as structured records in a per-repo append-only JSONL store (mirroring `Brain/log/` shard conventions), with edges as typed structured fields inside records rather than wikilinks; a dedicated `brain git-history` query path reads the store, and only a thin per-repo digest/summary note is written into the vault so FTS and context packs have a discoverable anchor. The watermark lives in the store header; the miner consumes JSONL records directly (not notes) and emits ADR candidate notes keyed by SHA; arch-docs uses the same scanner→facts→renderer kernel but its facts come from a directory scan rather than git.
- **Trade-offs**:
  - Pro: compact, fast, no vault bloat; analytical queries (fan-in/out, author/release rollups) are cheap and deterministic.
  - Pro: structured edges avoid wikilink explosion and keep the backlink index clean.
  - Pro: clean per-task reuse — one git reader, one record store, one renderer.
  - Con: needs and must maintain a new query surface; commit-level "why did this file change" answers depend on that path, not raw FTS.
  - Con: digest-only notes mean fine-grained commit text is not individually FTS-searchable unless the query path is wired into context packs explicitly.
  - Con: two storage idioms (JSONL records + markdown notes) for operators to understand.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Hybrid kernel (JSONL source of truth + per-repo digest notes + selective decision notes)
- **Approach**: A JSONL/SQLite per-repo store is the canonical source of truth for commits and edges (structured fields), and a shared kernel — sanitized git reader, record store, and fact-to-markdown renderer — is built once and consumed by all of Tasks 1–3; the vault gets per-repo digest notes (FTS-discoverable, context-pack-eligible) plus selective per-commit notes only where a record is promoted (a mined ADR candidate links back to its source commit record). Edges are dual-represented: structured in JSONL for query, and rendered as wikilinks in the digest/candidate notes for graph traversal. Arch-docs and ADR candidates both flow through the shared renderer plus a single region-merge engine using `<!-- @generated:id -->`/`<!-- @user -->` sentinels with stable region ids and preserve-on-conflict behavior. Task 4 stays independent — it only adds a `"query"` mode to the existing telemetry gate.
- **Trade-offs**:
  - Pro: compact storage and cheap analytics from the store, plus FTS/graph discoverability from rendered notes — captures both prior variants' upsides.
  - Pro: maximizes shared infrastructure (one reader, one store, one renderer, one region engine) per the "design shared infra once" constraint; selective promotion avoids file explosion.
  - Pro: ADR candidates and arch-docs naturally inherit the region-merge and renderer, so re-run idempotency and edit preservation are solved once.
  - Con: dual edge representation risks drift between JSONL fields and rendered wikilinks if not generated from one source.
  - Con: largest surface area to build and test in a single PR; most moving parts.
  - Con: still introduces a query path (smaller than Variant 2's, since digests carry common cases).
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 3
**Rationale**: The four tasks explicitly ship as one PR with shared infrastructure designed once, and a hybrid kernel is the only variant where the git reader, record store, fact renderer, and region-merge engine are built a single time and reused across ingest, arch-docs, and the decision miner. It avoids Variant 1's vault/FTS bloat (thousands of commit files, wikilink fan-out) while still answering "why/when a file changed" through FTS-discoverable digests and context packs, and it keeps storage compact and analytics deterministic like Variant 2 — with the dual-edge drift risk contained by always rendering wikilinks from the canonical JSONL records.
