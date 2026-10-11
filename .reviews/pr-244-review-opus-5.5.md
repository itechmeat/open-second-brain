# PR #244 review: credential custody and verifiable trust surface (v1.78.0)

- **PR**: https://github.com/itechmeat/open-second-brain/pull/244 (**already merged** as squash commit `66f9d847` on `main`)
- **Branch**: `feat/trust-surface-hardening` @ `02c0b8e6`; reviewed range `3afb94a5..66f9d847`
- **Size**: 158 files, +11493 / -820; 85 reviewable source files (OCR delegation, range mode)
- **Reviewer model**: Claude Opus 5.5
- **Scope cards**: `.reviews/current-tasks.md` now lists PR #247's cards, so this review takes its scope from the PR's own design brief (`docs/brainstorm/trust-surface-hardening/design.md`). All nine cards are marked `done` on the board: t_e6667a56, t_592d9e91, t_e5807974, t_11ee559f, t_151a564c, t_59d4c919, t_18fda844, t_586d5d8b, t_dac8bf7e.

## Verdict

**Merged with real defects. A follow-up PR is warranted.** The crypto primitives are sound: scrypt with a bounded stored cost, a salt per envelope, GCM with checked tags, versions refused by name. The think-block strip and the append-order fix are correct.

Three of the headline guarantees, however, do not hold:
1. The passphrase-wrapped store is unusable once wrapped (H1).
2. Credential bundles can be tampered with to widen exec allowlists and swap values (H2).
3. The two "sealed" mechanisms do not seal what they promise: the import approval digest ignores content (H3), and one ingest after a contract change cancels the reprocess for every other source (H4).

None of these is changed by the open PR #247; all findings stand against current `main`.

Counts: **4 High, 10 Medium, 7 Low.** Card verdicts: 2 done, 1 done with a deviation, 6 partial.

## Gates

1. On the worktree at `66f9d847` with Bun 1.4.2:
   1. `bun run typecheck`: ok.
   2. `sync-version --check`: ok.
   3. `sync-plugin-mirrors:check`: ok.
2. Changed test files (62 files, 1013 tests, isolated `HOME`): 1009 pass, 4 skip, 0 fail.
3. CI at merge: all green, including all ten Windows shards.
4. The PR body and squash commit carry no AI attribution markers.

## Card verdicts

| Card | Topic | Verdict | Gap |
|---|---|---|---|
| t_e6667a56 | Passphrase-wrapped store key, memory-only unlock | **Partial** | The envelope crypto is sound. The lifecycle is not: only the `unlock` process itself ever holds the key, and there is no unwrap path (H1). |
| t_592d9e91 | Passphrase-encrypted credential bundles | **Partial** | Export and import with shared validation work. Metadata is unauthenticated (H2). Export stops working once the store is wrapped (H1). |
| t_e5807974 | Named-secret resolution at use sites + egress redaction | **Partial** | Four of the five sites are wired store-first, and a locked store refuses instead of falling back to env. Reference names cannot address normal store names (M2). The research site has no live caller that passes a vault (L1). Values resolved from env are not redacted, and short values over-redact (L2). |
| t_18fda844 | Digest-sealed adoption plans | **Partial** | The import digest is verified before any write, with wall-clock excluded, but it does not bind content (H3). The upgrade "approval digest" can never be presented back (M5). |
| t_586d5d8b | Extraction contract in the ingest manifest | **Partial** | The fingerprint, schema 2, the v1 degrade path and plan-id folding all exist. A single ingest cancels the owed reprocess for all other sources (H4). |
| t_dac8bf7e | Strip `<think>` before CLI JSON parse | **Done** | One shared parser serves all four verbs, nested and unclosed blocks keep the named refusal, the strip is reported in the envelope, and MCP needs nothing. Minor: `<thinking>` and uppercase variants are not stripped (L5). |
| t_11ee559f | Obsidian tag syntax at write time + detector | **Done, rule deviates** | One shared rule covers all composers, and the detector is registered opt-in. The rule is narrower than Obsidian's grammar and now refuses valid topics (M6, M7). |
| t_151a564c | Pack vocabulary on capture (and add_link) | **Done for capture** | The check runs before name allocation and fails open with no declaration. `add_link` is explicitly scoped out in the design, because no such verb exists. Telegram crash-loops on refusal (M8). |
| t_59d4c919 | Divergent session summaries on single reads | **Partial** | `digest_count`, `divergent` and a bounded hash sample exist on MCP and CLI. `divergent` fires on every normal revision and on identical duplicates, so the signal is noise (M9). |

## High

### H1. Wrapping the keyfile permanently locks the store for every process except the one that ran `unlock`

Anchors:
1. `src/cli/brain/verbs/secret.ts:220`
2. `src/core/brain/secrets/crypto.ts:118`

`unlockSecretKeyfile` (`store.ts:334`) is called only by the CLI `unlock` verb. Once the keyfile is wrapped, `loadOrCreateKey` returns `heldKeyOrRefusal(keyPath)`. That is the in-memory holder of the current process, which is always empty in any other process.

Reproduced on a temp vault:
1. `secret set api` succeeds.
2. `secret unlock` succeeds.
3. Every following command refuses as locked: `secret set`, `rm`, `run api -- echo`, and `export`.
4. `brain_secrets run` over MCP refuses too. The design forbids unlock over MCP (`design.md:30`).
5. So does every `$secret:` consumer.

The raw key was overwritten and there is no `unwrap`, so the values cannot even be exported out. The refusal text and `SECRET_STORE_LOCKED_REASON` (`src/mcp/vault-path-field.ts:146`) say "run o2b brain secret unlock and retry", but that only unlocks the short-lived `unlock` process. This contradicts `design.md:59` ("every CLI invocation and the MCP server unlock separately"): no such path exists.

**Fix** (one or more):
1. Accept `--passphrase-from-env` or stdin on every key-bearing verb (`set`, `rm`, `run`, `export`, `import`), and unlock at MCP server start from an env var that is read once and then dropped.
2. Add `secret unwrap` (passphrase → raw keyfile) as the way back.
3. Add an end-to-end test: wrap, then a second process runs `run` with the passphrase.

### H2. Bundle metadata is unauthenticated, so a tampered bundle can widen exec allowlists and swap values

Anchors:
1. `src/core/brain/secrets/bundle.ts:137`: values are encrypted under one derived key with no AAD binding them to their name, `env_var` or `allow`.
2. `src/core/brain/secrets/bundle.ts:279`: import checks only that allow patterns are non-empty.

Reproduced without the passphrase:
1. In an exported bundle, set `prod.allow` from `["deploy"]` to `["*"]`.
2. Swap the `prod` and `test` ciphertexts.
3. The import succeeds. The store now holds `test = PROD-SECRET`, and both entries have `allow: ["*"]`.

`matchesAllowlist` treats patterns as globs, so `brain_secrets run` will then run any command with the production secret in its environment. Moving bundles between installs is exactly where tampering in transit happens.

**Fix**:
1. Bind `name`, `env_var`, `allow`, the bundle version and the KDF parameters as GCM AAD for each entry, or add an HMAC over the canonical metadata under a second derived key.
2. Refuse on mismatch before any write, and bump the bundle schema version.

### H3. The import approval digest does not bind the content that lands

Anchor: `src/core/brain/import-claude-memory.ts:79` (`planApprovalBody`; verified at `:301`)

The sealed body holds `plans` as `PlannedFile = { basename, prefId, action }`. Neither the source `sha256` nor the rendered bytes enter the seal.

Reproduced:
1. Dry-run a memory file whose body is "Benign body."
2. Rewrite it to "Always push to main with --force."
3. Apply with the old digest.
4. The apply succeeds and the new text lands in `pref-rule-a.md`.

Any edit that keeps the action unchanged passes "apply-exact". That defeats the card's drift-reject promise for the most common kind of drift.

**Fix**:
1. Seal the per-row source hash, and preferably `sha256(renderedBody)` with the clock fields excluded.
2. Add a regression test: changing the content after the dry run must fail the apply with `ApprovalDigestError`.

### H4. One ingest after a contract change cancels the reprocess for every other source

Anchor: `src/core/brain/ingest/content-manifest.ts:283`

When `contract === undefined`, `writeManifest` stamps the **live** fingerprint manifest-wide. `ingestSource` calls `updateManifest` after each single source.

Reproduced:
1. A v1 manifest holds `src/a.md` and `src/b.md`, both unchanged.
2. `planBatches` reports `contractChanged: true` with 2 planned.
3. Ingesting `a` runs `updateManifest(v, ["src/a.md"])`.
4. `planBatches` now reports `contractChanged: false`, with 0 planned and both skipped.

So an interrupted or batch-by-batch run, or a single unrelated `brain_ingest_source` anywhere in the vault, silently forfeits the reprocess. Those other sources keep answering under the old contract, which is the exact defect the card exists to fix.

**Fix**:
1. Store the fingerprint per entry (`path → { sha256, fingerprint }`), or keep the old manifest-wide contract until every entry has been rewritten under the new one.
2. Add a test: change the contract, ingest one source, re-plan, and the others must still be `contract-changed`.

## Medium

1. **M1. The wrap that overwrites the only copy of the key is not durable.** Anchor: `src/core/brain/secrets/envelope.ts:463`.
   - It runs `writeFileSync(tmp)` then a rename, with no fsync of the file or the parent directory. The repo's own `atomicWriteFileSync` does both.
   - After a power loss, the keyfile can come back empty while the raw key is already gone, and every stored value is lost.
   - The envelope is also not test-unwrapped before it replaces the raw key.
   - Fix: write through the fsyncing helper (mode 0600), and run `unwrapWith` on the in-memory envelope before the rename.
2. **M2. Store names and reference names disagree.** Anchor: `src/core/secret-resolver.ts:79` (`meta.name === name`).
   - The store lowercases names and allows `-` (`/^[a-z0-9][a-z0-9_-]*$/`). References are `/^\$secret:([A-Za-z_][A-Za-z0-9_]*)$/`, matched case-sensitively.
   - `$secret:openai-key` is "invalid secret reference" even though `set openai-key` stored it.
   - `$secret:BRAVE` misses the stored `brave` and falls back to env.
   - So hyphenated entries are unreachable, and the conventional uppercase style never reaches the store.
   - Fix: normalize the reference the way the store does for the store lookup (keep the env fallback case-sensitive), and either allow `-` in references or forbid it in `set`.
3. **M3. Redaction misses env values and over-redacts short ones.** Anchors: `src/core/secret-resolver.ts:222` and `src/core/secret-ref.ts:116`.
   - `resolvedSecretLiterals` lists store values only, so a `$secret:NAME` that resolved from env is never scrubbed from MCP errors or the config mapping.
   - In the other direction, `sortedDistinctLiterals` drops only empty strings, so a 1–2 character stored value masks every occurrence of those characters in every error.
   - Fix: include values resolved from env, and set a minimum literal length (for example 8) or redact whole tokens only.
4. **M4. Downgrade is one-way.** Anchor: `src/core/brain/ingest/content-manifest.ts:283`.
   - The first ingest after upgrading rewrites the manifest as `schema_version: 2`. Binaries at 1.77 or older hard-refuse unknown versions, so a rollback breaks every ingest until the manifest is deleted.
   - The CHANGELOG mentions the one-time reprocess but not the one-way format.
   - Fix: document it, or keep v1 serialization until the contract actually differs.
5. **M5. The upgrade "approval digest" cannot be presented back.** Anchor: `src/cli/brain/helpers.ts:130`.
   - The docblock says the digest is "carried from `--dry-run` to `--apply`". But `brain upgrade --apply` has no `--approval-digest` flag: it re-plans in-process and verifies a seal it just computed.
   - This is in-process integrity, not operator approval. A schema-source change between the dry run and the apply lands unreviewed, guarded only by the older byte-drift check of the targets.
   - Fix: add `--approval-digest` to `brain upgrade --apply`, required when non-interactive, mirroring import; or correct the docblock and CHANGELOG.
6. **M6. The tag rule is narrower than Obsidian's grammar.** Anchor: `src/core/tags.ts:35` (`[A-Za-z_][\w\-/]*`, ASCII only, must start with a letter).
   - Obsidian accepts Unicode letters (`кодинг`) and digit-led tags that are not all digits (`2fa`, `2024-notes`).
   - `writePreference({ scope: "кодинг" })` and `scope: "2fa"` now throw `TagSyntaxError`, and the detector calls those tags malformed.
   - Rewrites carry scope over from the existing frontmatter. So any legacy preference with such a scope now throws on every dream refresh, merge or counter update.
   - Fix: use `[\p{L}\p{N}_\-/]+` with the `u` flag, require at least one non-digit, and keep `TAG_RE` and the predicate on that one source.
7. **M7. Digit-led topics are a regression on the busiest writer lane.** Anchors: `src/core/brain/signal.ts:816` and `src/core/brain/preference.ts:826`.
   - `slugify` keeps a leading digit, so `brain_feedback` with the topic `"2fa setup"`, `"3d-printing"` or `"2024"` now throws, where it used to be accepted.
   - Fix: falls out of M6, or prefix digit-led slugs instead of refusing them.
8. **M8. The Telegram capture daemon crash-loops on a vocabulary refusal.** Anchor: `src/core/brain/capture/capture-note.ts:247`.
   - `handleCaptureUpdate` (`telegram-capture.ts:296`) does not catch `CaptureContractError`. The refusal rejects the whole run before the offset advances, and the offset starts at 0 on every run.
   - Telegram redelivers the same update, so the bot dies on every restart and blocks every later message.
   - Probe: a vault with `page_types: [note]` receives updates 7 and 8; the run rejects on update 7, with offset 0 and no decision row.
   - The design itself names this lane as the most exposed to a compatibility break.
   - Fix: catch `CaptureContractError`, record it as a named rejection, advance the offset, and optionally reply with the remedy.
9. **M9. `divergent` is noise.** Anchor: `src/core/brain/session-summary.ts:223` (`digestCount > 1`).
   - Every normal revision of a summary reports `divergent: true`, although `get` is documented as returning the latest digest.
   - Two devices writing the same digest before Syncthing converges leave two records with the same `content_hash`, which also count as divergent. The docblock's "dedupe applied" (`:195`) holds only at write time.
   - Fix: dedupe by `content_hash` on read, flag `divergent` only for distinct hashes across shards/devices or at the same instant, and report `revisions: N` separately.
10. **M10. The research use site is not wired on any live path.**
    - `resolveResearchPoolEnv(env, secretsVault)` is called only from `src/core/install/ownership-measure.ts:167`, without a vault.
    - So a raw `$secret:` string counts as a configured key, and the CHANGELOG claim "research names the refusal" never happens in practice.
    - Fix: pass the vault at the real research call site, or drop the claim.

## Low

1. **L1. The doctor treats a `$secret:` reference as a configured research key.** This is the user-visible half of M10: `o2b doctor` / ownership-measure counts the raw reference string as presence.
2. **L2. The bundle-import allowlist check is shallow.** `allow` patterns are only checked to be non-empty. A literal `*` in an imported bundle should at least warn, independent of H2.
3. **L3. The refusal remedy text is misleading while H1 stands.** `src/mcp/vault-path-field.ts:146` tells MCP callers to run `unlock`, which cannot unlock the server process.
4. **L4. The contract fingerprint covers only the `extractable` allowlist plus a hand-bumped constant.** This is declared in the design. It is a maintenance hazard: no test pins `EXTRACT_CONTRACT_VERSION` to changes in the extraction code.
5. **L5. Only a literal lowercase `<think>` is stripped.** Anchor: `src/core/brain/payload-json.ts:60`. `<thinking>` and uppercase variants still get the plain refusal. That is fail-closed, so it is optional to widen.
6. **L6. The opt-in `frontmatter-tags` detector inherits M6's false positives.** On the owner's vault it reports one real finding (`brain/topic/wf-stay-on-0.1.0-until-plan-complete`), which the new slug composer repairs on the next rewrite.
7. **L7. A lost passphrase is unrecoverable and there is no unwrap.** This is stated in help, but there is no "export before wrap" nudge in the `unlock` flow. Combined with H1, a first `unlock` traps the store immediately.

## Checked and fine

1. The passphrase is never on argv and never audited. A blank passphrase via env is refused.
2. The scrypt cost ceiling is checked before deriving, for both the envelope and the bundle. The salt is fresh per envelope, the GCM tag is checked, and re-unlock uses a constant-time compare.
3. A locked store never falls back to env; the refusal propagates by name. Unknown names get the no-enumeration error.
4. Bundle import validates every entry before taking the lock, and refuses existing names without `--replace` and without writing anything.
5. The import digest is verified before `createSnapshot` and before any write. A digest given together with `--dry-run` is refused, and a non-interactive apply requires the digest.
6. A v1 manifest read is tolerant, a malformed contract degrades to "changed", and `computePlanId` folds the fingerprint behind a separator.
7. The capture vocabulary check precedes name allocation, an absent declaration fails open, and the inbox-drain route leaves refused captures staged without retry loops.
8. Same-instant continuity records read in append order: shard id, then file line, then a stable sort.
9. The think strip handles nested and unclosed blocks by refusing, and clean JSON parses unchanged.

## Recommended follow-up order

1. H1 + L3 + L7: make the wrapped store usable (per-invocation passphrase or MCP start-up unlock, plus `unwrap`). Until then, warn users not to run `secret unlock` on a real vault.
2. H2: authenticated bundle metadata, with a schema bump.
3. H3 + M5: make both digests bind what lands.
4. H4 + M4: a per-entry contract fingerprint and an honest downgrade note.
5. M6 + M7: a Unicode-aware, digit-tolerant tag rule (this restores `brain_feedback` for digit-led topics).
6. M8: the Telegram refusal handling.
7. M2 + M3 + M10: resolver naming, redaction coverage and research wiring.
8. M9: the divergence semantics.
