# PR #247 review: write-side trust (v1.79.0)

- **PR**: https://github.com/itechmeat/open-second-brain/pull/247
- **Branch**: `feat/write-side-trust` @ `aca2f2f6`, merge base `66f9d847`
- **Size**: 119 files, +13896 / -338; 61 reviewable source files (OCR delegation, range mode)
- **Reviewer model**: Claude Opus 5.5
- **Scope cards** (`.reviews/current-tasks.md`): t_6ff73d61, t_29798f41, t_8913c934, t_85059d6d, t_89e1f601, t_107cac80, t_af5e252f

## Verdict

**Not ready to merge.** The building blocks are solid: a strict fail-closed permissions loader, a single resolver, a locked and sharded ledger, hash-at-rest tokens with constant-time compare, strict pending-id encoding, and staged pages kept out of the index. The PR's central trust claim does not hold end to end, though. The identity the credential mints never reaches any write-side decision, the signal lane ignores the permissions document, and revoking the last token on a keyless network bind re-opens the endpoint to anonymous traffic. CI is red on one Windows shard because of a test this PR adds. Every card is delivered only in part.

Counts: **5 High, 11 Medium, 9 Low.**

## Gates

1. Local, on the worktree with Bun 1.4.2:
   1. `bun run typecheck`: ok.
   2. `sync-version --check`: ok.
   3. `sync-plugin-mirrors:check`: ok.
2. Changed test files (46 files, 984 tests): 982 pass, 1 skip, **1 fail**. The failure is `tests/mcp/owner-scope-refusal.test.ts:397`, which is not hermetic (see L1). It passes with an isolated `HOME`.
3. CI: everything green except **`windows (4/10)`**:
   1. `tests/core/brain/ingest/ingest.test.ts:565-567` (added by this PR) builds the expected path with `join()`, which gives backslashes on win32, and compares it against a list normalized to `/`. This is a real PR defect (M11).
   2. `tests/core/brain/portability/okf.test.ts:153` is a pre-existing second-boundary flake in a file this PR does not touch.
4. The PR body and commits carry no AI attribution markers.

## Card verdicts

| Card | Topic | Verdict | Gap |
|---|---|---|---|
| t_85059d6d | Per-agent MCP tokens, identity from the credential | **Partial** | The token authenticates the request, and read-side owner-scope delivery uses it. No write-side gate, permission subject, owner gate or ledger actor ever uses it (H1). |
| t_89e1f601 | One-command headless bootstrap | **Partial** | Apply, receipt, `--check` and a shown-once mint exist. Missing: `--remove`, mint→verify→revoke rotation, and tool pre-approval. The registered server is stdio, which ignores the minted token (H3). |
| t_29798f41 | Permissions document, approval door, decision ledger | **Partial** | The document gates only note creates and ingest. Signals ignore it (H2); update, append, session and batch-update ignore it (M3). Targets match exact paths only (M5). Apply/reject leave no ledger resolution row (M6). The doctor "denies the local agent" check from the design is missing (L7). |
| t_6ff73d61 | Operator review gate before generated notes reach recall | **Partial** | Note creates and the ingest summary page stage, invisible to recall. Ingest entity pages and the manifest publish before review (M4). |
| t_107cac80 | Cross-owner / global write gate | **Partial** | The gate exists (off/warn/fail) on the preference, note and batch lanes. It compares against the server's config identity, so a token caller can still write as another owner (H1). Dropping the "global scope" half is declared in the design. |
| t_8913c934 | Durable open-decision record | **Partial** | The lifecycle, dedup, minting into `decision-<slug>`, deterministic read-back and brief resurfacing work. Missing and undeclared: the multi-select flag, the free-text "Other" escape, and the "use your own judgment" resolution. Resolve can wedge permanently (H5). |
| t_af5e252f | Ambient writeback consent + TTL | **Partial (reshaping declared)** | Consent switch, TTL stamp, fail-closed config and the withheld event are delivered. The Stop-hook backstop and the managed-block installer are deferred in `design.md` but not in the CHANGELOG. Audience-aware consent is missing and mentioned nowhere. The default stays ON (declared in the design). The TTL is honored by recall only (M10). |

## High

### H1. The token identity never reaches the permissions document, the owner-write gate or write attribution

Anchors:
1. `src/core/brain/notes/create-note.ts:778`
2. `src/mcp/brain/feedback-tools.ts:167`
3. `src/core/brain/ingest/ingest.ts:231`
4. `src/core/brain/preference.ts:624`

`http.ts:514` mints `{ agent, via: "token" }`, and `ServerContext` carries `agentName`. Every write-side subject, however, comes from somewhere else:
1. `resolveAgentName(configPath)` with `via: "config"` (create-note, the owner gate subject at `create-note.ts:170` / `:625`).
2. The caller-supplied `agent` argument (`ingest-tools.ts:85-88` → `ingest.ts:231`; `feedback-tools.ts:167` for the `force_confirmed` check).

Nothing in `src` builds a permission subject with `via: "token"`.

Concrete failures, confirmed with probes by the sub-reviewers:
1. The document has `agents: { bob: { write: deny } }`. Bob, authenticated with his own token, calls `brain_create_note`. The call is judged as the server's config agent and allowed, and the ledger names the wrong actor.
2. The document has `default_action: deny` and `agents.operator.write: allow`. Any caller sends `brain_feedback { force_confirmed: true, agent: "operator" }` and creates a confirmed preference.
3. The config has `owner_scope_writes: fail`. Token caller `bob` names `owner: claude`, the config agent, and the cross-owner check passes. This is exactly the write t_107cac80 exists to stop.

This contradicts `docs/brainstorm/write-side-trust/design.md:15` ("Identity comes from the credential, never from a caller-supplied argument") and `:38` ("identity feeds authorization").

**Fix**:
1. Carry `{ agent, via }` on `ServerContext`.
2. In every writer tool, pass it explicitly into `createNote`, `ingestSource`, `writePreference`, `writeSignal` and the feedback check as the permission subject and the owner gate's resolved identity.
3. When `via === "token"`, refuse an `agent` argument that differs from the token identity.
4. Keep `resolveAgentName` only as the stdio and CLI fallback.
5. Add HTTP tests: a deny rule on the token's agent refuses the write, and a cross-owner claim by a token caller is refused under `fail`.

### H2. Signal writes never consult the permissions document

Anchor: `src/core/brain/signal.ts:379`

`writeSignal` decides staging only through `resolveWriteApprovalLane(REVIEW_LANE.signals)`, which reads the `write_approval.*` keys. Two consequences:
1. With `Brain/_permissions.yaml` set to `default_action: deny`, `brain_feedback` still writes `Brain/inbox/sig-*.md` (`staged: false`) and no ledger row is written.
2. An unreadable document does not fail closed on this lane, although the doctor message says "every gate fails closed".

The design says a present document is the only disposition source. Signals are the busiest writer lane: MCP and CLI feedback, inline scan, session import and checkpoints all go through it.

**Fix**: when `targetDir` is undefined, resolve through `resolveWriteDisposition(vault, REVIEW_LANE.signals, subject, { target })`. Deny throws, ask stages, and the decision is recorded. Thread the subject from H1.

### H3. Revoking the last token on a keyless network bind opens the endpoint to anonymous access

Anchor: `src/mcp/http.ts:470`

```ts
const enforced = (configTokensRequired && mapNonEmpty) || (networkBare && mapNonEmpty);
```

`hasAnyAgentToken` counts active tokens only. With a non-loopback host and no `--api-key`, startup demands tokens. At request time, though, enforcement depends on the map being non-empty. Reproduced:
1. Mint a token.
2. `startHttp({ host: "0.0.0.0" })` with no key.
3. A keyless `ping` returns 401.
4. `revokeAgentToken`.
5. The same keyless `ping` returns **200**.

Deleting `mcp-tokens.json` has the same effect.

**Fix**: `const enforced = networkBare || (configTokensRequired && mapNonEmpty);`. A keyless network bind never serves anonymous traffic. Add a regression test for revoking the last token.

### H4. Bootstrap mints a token that the registration it writes never presents

Anchors:
1. `src/cli/bootstrap/run.ts:323`: mint.
2. `:388`: `adapter.apply`.

`buildPayload` registers `o2b mcp --vault …`, a **stdio** server (`src/core/install/payload.ts:87-95`). The design keeps stdio identity config-derived (`design.md:32`). The `--agent` and the token therefore change nothing about who the bootstrapped harness writes as. The card asked for a token-authenticated HTTP registration for headless agents.

**Fix**: when a token is minted, register an HTTP MCP entry whose bearer comes from an env reference. Otherwise, state in the command output and `docs/mcp.md` that the token only serves HTTP clients configured by hand.

### H5. An open decision can become permanently unresolvable

Anchor: `src/core/brain/decisions/open-store.ts:703` (`title: record.title` passed to `recordDecision`)

`openDecision` deduplicates ids by suffixing (`open-pick-db`, `open-pick-db-2`), but resolve mints from the bare title, and `recordDecision` refuses an existing slug. Reproduced:
1. Two questions are titled "Pick DB".
2. The first resolves into `decision-pick-db`.
3. The second fails with `DecisionError: decision already exists: pick-db` and stays `open` forever. No surface can retitle it.

A crash between minting the page (`:702`) and stamping the record (`:720`) wedges it the same way.

**Fix**:
1. Mint from the open record's unique slug, or a suffixed title.
2. Make resolve idempotent: if `decision-<slug>` already exists and references `[[open-…]]`, stamp the record instead of failing.

## Medium

1. **M1. A token minted before the adapter apply is lost if the apply fails.** Anchor: `src/cli/bootstrap/run.ts:390`.
   1. On `InstallError` (exit 4, user-modified block) the command returns without printing the material.
   2. A re-run with `--force` finds the token existing, mints nothing and shows nothing.
   3. Recovery is `--rotate`, which the output never mentions.
   - Fix: plan and verify the apply before minting, or print or revoke the token on failure.
2. **M2. The bootstrap default identity is a placeholder.** Anchor: `src/cli/bootstrap/run.ts:185` (`args.agent ?? target`).
   - `codex` and `claude-code` are in `PLACEHOLDER_AGENT_VALUES`. `mintAgentToken` only checks for an empty agent, so the token carries a name the identity layer treats as absent.
   - Fix: require `--agent`, or reject placeholder names at mint.
3. **M3. Deny does not survive mutation.**
   - The only `resolveWriteDisposition` callers are `create-note.ts:775` and `ingest.ts:228`.
   - `update_note`, `append_note`, `write_session`, batch updates, `delete_by_source` and the schema mutations never consult the document. An agent denied `write` can still rewrite or append to any existing note.
   - The card says explicitly that "deny/hide must survive mutation".
   - Fix: consult the document for a deny verdict in every mutating writer, even if "ask" stays entry-only; or document the limitation.
4. **M4. Ingest stages only the summary page.** Anchor: `src/core/brain/ingest/ingest.ts:314`.
   - Entity pages (`Brain/entities/concept/…`) and the manifest row publish before review; the Windows CI log of the staged-ingest test shows them.
   - Unreviewed source content reaches recall and the graph, which defeats t_6ff73d61 for bulk ingest.
   - Fix: defer or stage intake writes with the page, or document that entity extraction is outside the gate.
5. **M5. Target rules match exact, unnormalized paths only.** Anchors: `src/core/brain/permissions/resolve.ts:73` and `document.ts:424`.
   - `notes/a.md`, `./Notes/a.md` or `Notes\a.md` never match `Notes/a.md`, and there is no subtree form. A target-scoped deny can be dead without warning.
   - Fix: canonicalize at load, warn on targets that cannot be canonicalized, and consider a directory-prefix form.
6. **M6. The approval door leaves no audit trail.** Anchor: `src/core/brain/pending/pending-lanes.ts:791`.
   - Apply moves the bytes but records no note write and no ledger resolution row. The ledger shows an `ask` with no outcome, and the published note has no who-wrote-it record.
   - Fix: append a resolution row on apply and reject, and record the note write with the actor stamped at staging.
7. **M7. Rotation is not mint→verify→revoke, and `--remove` is absent.** Anchor: `src/core/brain/secrets/token-store.ts:160`.
   - The hash is overwritten in place, so the harness holding the old material fails on its next request until the new material is placed.
   - Fix: add a grace window (keep the previous hash until first use of the new one or a TTL), and add a receipt-driven `bootstrap --remove`.
8. **M8. A resolved or discarded question can never be parked again with the same wording.** Anchor: `src/core/brain/decisions/open-store.ts:573`.
   - Dedup scans every status, while the MCP schema says "Dedup key across open records" (`decisions-tools.ts:480`). Recurring questions ("deploy now or wait?") get refused.
   - Fix: dedup only against `status === open`, or align the schema and docs.
9. **M9. Heading lines in the question or context corrupt the record on read-back.** Anchor: `src/core/brain/decisions/open-store.ts:399` (first `^## <heading>$` match wins).
   - The question "Pick one\n## Options\n- evil" with options `["good"]` reads back with options `["evil"]`, and `resolve --choice good` is refused.
   - Fix: escape or indent `#`-leading lines on write, or parse sections by fixed order.
10. **M10. The ambient TTL is honored by recall only.** Anchor: `src/core/brain/fact-extract.ts:508`.
    - `expiration_date` is filtered in `query.ts`, but not in `scanBrain` or in dream topic and promotion planning. An expired transient fact can still be consolidated into a non-expiring preference.
    - The read gap predates the PR; the new TTL relies on it.
    - Fix: drop expired signals before dream clustering, or carry the expiration onto any promoted preference.
11. **M11. The Windows CI failure is a test bug.** Anchor: `tests/core/brain/ingest/ingest.test.ts:566`.
    - Fix: expect the literal `` `Brain/pending/ingest/${res.pendingId}.md` ``.

## Low

1. **L1. A non-hermetic test.** Anchor: `tests/mcp/owner-scope-refusal.test.ts:397`.
   - "no identity on the request falls back to the config-derived context" picks up the host's `$HOME` o2b config. On a machine with `agent_name` set it fails, receiving `foreign-owner` with "claude-devbox-agent" instead of `unresolved-identity`.
   - Fix: pin `HOME`/`XDG_CONFIG_HOME` to a temp dir in the fixture.
2. **L2. A corrupt `mcp-tokens.json` locks out the shared operator key.** Anchor: `src/mcp/http.ts:473`.
   - The token map is consulted first and its read throws for any presented credential.
   - Fix: on a token-store read error, log it and fall through to the shared-key compare.
3. **L3. Failed ledger appends are silently discarded.** Anchor: `src/core/brain/pending/pending-lanes.ts:445`.
   - `recordDispositionRow` drops the result of `appendDecisionLedger`, so a failed deny or ask row vanishes despite the "comes back as an audit reason" comment.
4. **L4. Staging the same target collides.** Anchor: `src/core/brain/pending/pending-lanes.ts:555`.
   - The pending id embeds the date. The same target staged on two days creates two entries, and the second apply hits `PendingApplyConflictError`. Two creates of one path on the same day silently replace each other's staged bytes, even across agents.
5. **L5. The final log mirror in resolve is unguarded.** Anchor: `open-store.ts:722-732`.
   - The `decision-resolved` `appendLogEvent` has no try/catch, unlike the other mirrors. A throw after the page is minted and the record stamped reports failure and skips the receipt.
6. **L6. MCP `resolve` and `discard` skip the reach predicate.** Anchors: `decisions-tools.ts:366-386`.
   - `rate` and `outcome` pass `reads`, but `resolve` and `discard` do not. A below-reach caller can act on a record it cannot list.
7. **L7. The doctor check is narrower than designed.** `doctor/permissions-check.ts` reports only an unreadable document. The design's "document denies the locally configured agent" finding (`design.md:73`) is missing.
8. **L8. `ambientWithheld` is returned but never surfaced.** Anchor: `fact-extract.ts:394`.
   - `sessions import` with consent off reports 0 facts and no withheld count.
9. **L9. Non-Latin titles produce opaque ids.** A Cyrillic title becomes `open-unnamed-<hash>`, which is unreadable in the brief.

## Checked and fine

1. Token material never reaches argv, receipts, the audit log or error messages.
2. Hashes are compared with `timingSafeEqual` on fixed-length digests. Revoked and unknown tokens get identical 401s.
3. The store file is 0600, and writes serialize under the secrets lock.
4. Identity is threaded per request as a parameter, not held as server state, so concurrent requests are safe.
5. Pending ids are strictly encoded and decoded, with `ensureInsideVault` on apply, a 255-byte bound, and an exclusive-create race gate on apply.
6. `Brain/pending` is excluded from index admission by a proper path-prefix check.
7. `Brain/_permissions.yaml` cannot be overwritten through note tools, because the `Brain/` root is refused.
8. The document loader fails closed with field-named errors, and resolver precedence (deny > ask > allow at equal specificity) matches the design.
9. Ambient consent is fail-closed on an unreadable config, and `ambient-withheld` fires once per capture.

## Recommended order of fixes

1. H1, then H2 and M3. Together these make the permissions document the real single chokepoint, keyed on the credential identity.
2. H3: a one-line change plus a test.
3. M11 and L1: CI green and hermetic tests.
4. H5, M8, M9: open-decision robustness.
5. H4, M1, M2, M7: bootstrap fidelity, or narrow the card and say so in the CHANGELOG.
6. M4, M6, M10: review-gate completeness.
