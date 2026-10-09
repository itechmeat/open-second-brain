You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one release of Open Second Brain whose argument is "trust-surface hardening": every surface an operator or agent has to trust - the credential store, the write path, the read path and the resumability artifacts - states what it verified, refuses what it cannot, and names what it did. Nine tracker cards feed it. Reconnaissance against the live source has already been done and is recorded in four files that are the shared context for this brainstorm; treat their findings as fact, not conjecture, and do not re-litigate them:

- ~/.cache/osb-run.Dc0T/recon-secrets.md (cards 1-3)
- ~/.cache/osb-run.Dc0T/recon-validation.md (cards 4, 6, 7)
- ~/.cache/osb-run.Dc0T/recon-sessions.md (cards 5, 8)
- ~/.cache/osb-run.Dc0T/recon-ingest.md (card 9)

**Card 1 (t_e6667a56) - passphrase-wrapped secret-store key.** The secret store under `src/core/brain/secrets/` encrypts values with per-value AES-256-GCM around a raw 32-byte 0600 keyfile (`crypto.ts:86-142`). The card adds an opt-in envelope: a scrypt-derived key wraps the file key, the passphrase-derived key lives only in process memory (the repo has no daemon, so every CLI invocation and the MCP server unlock separately), and `lock`/`unlock` ops join the verb switch in `src/cli/brain/verbs/secret.ts`. There is no TTY password infrastructure anywhere, so passphrases arrive via stdin or `--passphrase-from-env` following the `set` pattern; MCP keeps `brain_secrets` to `list|run` only, and the admin-tools refusal of set/get (:295-299) is the precedent for refusing unlock there too.

**Card 2 (t_e5807974) - route credential consumers through the named-secret resolver.** The `$secret:NAME` syntax layer (`src/core/secret-ref.ts`) is complete but nearly inert: `resolveSecretReference` and `redactKnownSecretValues` have zero production callers while real credentials still flow from bare env vars at five sites (embeddings registry, decision-model config, research fetch, Telegram token, installation secret). The provider parameter on the resolver is the seam for a custody-store-backed provider with env fallback; the caveat is that `resolveSecretForExec` is read-shaped but a writer (last_used_at stamp plus audit), so config paths may want a read-only decrypt. Redaction wiring points at `EGRESS_REDACTION_OPTIONS`/`redactForEgress` (`src/core/egress/guard.ts`) and `redactConfigMapping`, and the egress census asserts declarations against source.

**Card 3 (t_592d9e91) - passphrase-encrypted credential bundles.** Export/import credentials as a single passphrase-encrypted JSON envelope, modeled on the bank bundle (`src/core/brain/portability/bundle.ts`, schema-versioned) with knowledge-pack-style integrity, sharing the KDF and envelope format with card 1 by card statement. Declaring `--out` pulls the verb into the egress census population, so an honest `EGRESS_SITES` entry is a deliberate choice: the payload is ciphertext by construction, which defeats both the `sharedRedactor` and `noVaultContent` statuses as-is.

**Card 4 (t_11ee559f) - reject or flag tags Obsidian cannot parse.** Canonical tags are composed in exactly three places with no syntax check (`composeSignalTags` signal.ts:797, `composePreferenceTags` preference.ts:808, hand-rendered import frontmatter claude-memory-render.ts:80); a topic like `foo bar` lands as `brain/topic/foo bar`, which Obsidian cannot parse. The repo already holds one index rule (`TAG_RE`, `src/core/tags.ts:29`, whose docblock reserves itself as this card's seam - validate against the rule defined there, never a copy) and one Obsidian-compatible detector rule (`hygiene/detectors/tags.ts:62`); the schema-vocab token rule rejects slashes and must not be reused. The doctor half is a frontmatter-tags hygiene detector registered via `HYGIENE_DETECTOR_IDS`/`DETECTORS`, where `tags` is registered but opt-in today.

**Card 5 (t_59d4c919) - surface divergent session summaries on single-session reads.** `getSessionSummary` (`src/core/brain/session-summary.ts:173-180`) filters append-only continuity records and returns the sorted-last one silently; Syncthing replication legitimately produces content-differing records for one session. Exactly two callers exist: MCP `brain_session_summary` get (synthesis-tools.ts:125-129) and CLI `o2b brain session-summary` get. The MCP tool declares no outputSchema, so additive keys cannot trip the envelope contract; the named-reason grammar (`payload_mismatch`, `coverage-divergent`, `sync-conflict-log`) is the established vocabulary; `MCP_PREVIEW_BUDGET` applies to the serialized content, so id/hash lists beat full echoes.

**Card 6 (t_151a564c) - enforce pack vocabulary on capture writes.** `writeCaptureNote` and `writeIdeaNote` stamp fixed kinds (`brain-capture`, `captured-idea`) with no vocabulary consult, while page-type enforcement exists only in the write-session/note-strict path and the signal-side `schemaVocabulary` option is dormant (no caller passes it). Absent config substitutes a default pack (`schema-pack.ts:56`) - the established fail-open - and the merged vocabulary always contains `note`, so "pack active" means declarations non-empty. Rejection must precede `allocateAndCreate` so a refused capture never consumes a name; the `kind`-vs-`type` frontmatter key mismatch is an open decision, and Telegram capture is the live lane most exposed to a compatibility break.

**Card 7 (t_18fda844) - digest-sealed content adoption plans.** `sealManifest`/`manifestVerifies` (`src/core/state/migrate.ts:186-194`) seal the state-migration manifest and verify at apply and rollback; neither content-adoption surface has a binding. The Claude-memory import re-plans at apply with nothing tying the approved dry-run to what lands; brain upgrade refuses byte-level drift but trusts a caller-supplied plan object (the self-heal worker uses that seam). Generalize the seal to both plans, carry the digest through CLI output, refuse drift before the snapshot/write loop, and keep wall-clock fields out of the sealed body (migrate.ts injects `now` for this reason).

**Card 8 (t_dac8bf7e) - strip reasoning think blocks before CLI JSON parse.** The MCP path is immune (protocol-parsed objects go straight into commit functions), but four CLI verbs bare-`JSON.parse` agent-authored payloads before `assertResponseShape` can run: extract-signals (:129-140), design-note (:105-113), skill-proposals (:120-125), distill (:89-102). A reasoning preamble kills them with the generic "payload must be valid JSON". A shared strip-and-note parser tries a plain parse, strips a leading think block, retries, and names the strip on the `{ ok: true }` envelope; a still-invalid payload keeps today's named exit-1 refusal. The fenced-unwrap precedent is `llm-emulation.ts:221`.

**Card 9 (t_586d5d8b) - record the extraction contract in the ingest manifest.** The ingest content manifest (`src/core/brain/ingest/content-manifest.ts`, schema_version 1, path-to-sha256 entries, unknown version hard-refused) gates reprocessing in `planBatches` by content hash only, so changed extraction settings leave `unchanged` sources answering with extraction shaped by the old contract. The card persists a manifest-wide contract fingerprint (the vault's `extractable` allowlist plus a hand-bumped code constant, mirroring the `CHUNKER_VERSION` convention), compares it right after `readManifest`, folds it into `computePlanId` (the `computeSessionImportId` pattern), and reprocesses rather than mark-stale, with a typed reason token so reporting stays honest; the schema bump follows the `SUPPORTED_SCHEMA_VERSIONS` pattern so a v1 manifest degrades to one conservative reprocess instead of a hard error.

Wave constraints (non-negotiable):

- TypeScript on Bun; no new native or ML dependencies; node:crypto is available (scrypt, subtle). The repo pins a single runtime dependency (proper-lockfile) and treats even optional native packages cautiously, so scrypt with explicit parameters recorded in a versioned envelope is the settled KDF choice.
- No hardcoded natural-language phrases; all strings English, other languages handled abstractly.
- Errors surface explicitly by name; no silent fallbacks; fail-closed posture on writes; opt-in flags for behavior changes.
- SOLID, KISS, DRY; hoist repeated literals; match surrounding idiom.
- The kernel never calls a model.

# Project context

Open Second Brain is a local-first memory system for AI agents: TypeScript on Bun, surfaces are an MCP server plus an `o2b` CLI, agent state lives in SQLite via bun:sqlite, and the knowledge corpus is a markdown vault under `Brain/` with machine artifacts under `.open-second-brain/`. Recent releases shipped visibility windows, a truth layer and context delivery, and the tree now carries architecture census tests (egress census, write-site census, manifest completeness, vault-guard census) that any new verb, write site or egress destination must satisfy. The four recon files listed above are the shared context: they name the real files, line anchors, precedents and open decisions, and variants should build on them rather than re-derive them.

# Required output format

Produce exactly 3 distinct architectural variants. The variants must take genuinely different positions on the real architectural questions of this wave, at minimum:

- (a) whether cards 1, 2 and 3 share one crypto/envelope substrate module built first, or ship as three independent slices;
- (b) how aggressive the fail-closed posture is for cards 4 and 6: reject the write, or flag-and-continue with doctor detectors;
- (c) how cards 5 and 8 expose new information: extend the existing response envelopes additively, or add new dedicated surfaces.

For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
