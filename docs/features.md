# Features

What Open Second Brain does, which clients it works with, and where each
part is documented. Installation is in [`install.md`](../install.md); the
mechanics are in [`how-it-works.md`](how-it-works.md).

## The core loop

1. **Capture.** Agents record taste signals (`brain_feedback`), notes,
   decisions and evidence (`brain_apply_evidence`) through the MCP tools,
   the lifecycle hooks, the CLI and `@osb` markers in notes. Every record
   names the agent that wrote it.
2. **Keep.** Records live in the brain store, append-only files outside
   the vault, in a `shared` and a `private` partition. Several machines
   can share one brain when you sync the partitions with a sync tool you
   choose: [brain store](brain-store.md#syncing).
3. **Consolidate.** The dream pass promotes repeated signals to rules,
   confirms, quarantines and retires them by their evidence, keeps topics,
   and replays missed days after a silence. It runs on the dream owner's
   machine and starts by itself at the first session of the day; Aider,
   Pi and OpenClaw start no session there, so a machine with only these
   hosts runs it with `o2b dream run`: [dream](dream.md).
4. **Deliver.** A session starts with a digest of the confirmed rules
   (scope and confidence), recent retirements, the heads of the project's
   live topics and the pinned context; hosts without a session hook read
   the same through `brain_context`: [active preferences injection](how-it-works.md#active-preferences-injection).
5. **Read and correct.** The human view renders plain Markdown pages
   (`about-me.md`, weekly history, decisions, topics) into a folder you
   choose. Editing a rule there records a human correction; deleting its
   line retires the rule: [the human view](brain-store.md#the-human-view).

## Dream and models

1. **One owner per brain.** Live passes run on one agent installation on
   one device; other machines preview: [the dream owner](dream.md#the-dream-owner).
2. **Model work waits for a model.** Closed questions go to an optional
   decision model, wording and summaries to your own agent in a short,
   isolated session. Nothing is decided by a fixed rule in their place:
   [who answers](dream.md#who-answers), [decision models](decision-models.md).
3. **Drafts with their author.** Model-written text records the agent and
   the model, and can be held for review (`dream.apply_drafts`):
   [drafts](dream.md#drafts).
4. **The dream agent is yours to set.** No preset commands ship; set the
   command and verify it with `o2b dream agent check`:
   [setting the agent](dream.md#setting-the-agent).

## Supported clients

On a fresh machine, `o2b setup --target <host> ... --apply --yes` configures
the machine and the brain, then runs the same install and verifies it
([`install.md`](../install.md#install-from-the-registry)).

| Client             | Integration                                                              | Guide                                              |
| ------------------ | ------------------------------------------------------------------------ | -------------------------------------------------- |
| Claude Code        | Marketplace plugin: MCP servers and hooks                                | [`install/claudecode.md`](../install/claudecode.md)   |
| OpenAI Codex       | Marketplace plugin, then `o2b install --target codex --apply`            | [`install/codex.md`](../install/codex.md)             |
| ChatGPT desktop    | Reads the shared Codex config: `o2b install --target codex --apply`      | [`install/codex.md`](../install/codex.md)             |
| Hermes Agent       | Plugin and memory provider                                               | [`install/hermes.md`](../install/hermes.md)           |
| OpenClaw           | Native plugin, no MCP                                                    | [`install/openclaw.md`](../install/openclaw.md)       |
| opencode           | `o2b install --target opencode --apply`: MCP servers and a native plugin | [`install/opencode.md`](../install/opencode.md)       |
| Grok Build         | `o2b install --target grok --apply`: MCP servers and hooks               | [`install/grok.md`](../install/grok.md)               |
| Cursor             | `o2b install --target cursor --apply`                                    | [`install/cursor.md`](../install/cursor.md)           |
| kiro               | `o2b install --target kiro --apply`                                      | [`install/kiro.md`](../install/kiro.md)               |
| GitHub Copilot CLI | `o2b install --target copilot-cli --apply`                               | [`install/copilot-cli.md`](../install/copilot-cli.md) |
| Gemini CLI         | `o2b install --target gemini-cli --apply`                                | [`install/gemini-cli.md`](../install/gemini-cli.md)   |
| ZCode              | MCP servers added to its config by hand                                  | [`install/zcode.md`](../install/zcode.md)             |
| Aider              | `o2b install --target aider --apply`: context file, no MCP               | [`install/aider.md`](../install/aider.md)             |
| Pi                 | `o2b install --target pi --apply`: skill over the CLI                    | [`install/pi.md`](../install/pi.md)                   |
| Any other MCP host | `o2b install --target generic --apply --out -` prints the server entries | [`install/generic.md`](../install/generic.md)         |

`o2b uninstall --target <name> --apply` removes what `o2b install` wrote; the vault is never touched ([`install.md`](../install.md#uninstall)).

## Capabilities

- **Preferences that learn and expire.** Signals, a deterministic dream pass, confidence and retirement: [how it works](how-it-works.md#a-preferences-lifecycle).
- **Reversible changes.** On the legacy `Brain/` layout, brain mutations take a snapshot first and `o2b brain rollback` restores it: [snapshots](how-it-works.md#snapshots-and-rollback). On a machine switched to the brain store, snapshots hold only device-local state and rollback refuses; recovery there is described in [the brain store guide](brain-store.md#standing-rules-and-other-brain-pages-after-the-switch).
- **Attributed writes.** `o2b brain writes` lists every note write by agent and device, `writes revert` plans a restore, `o2b brain freeze` stops all writers, and `o2b brain log verify` checks the hash-chained log: [Brain CLI](cli-reference.md#brain-observing-memory).
- **Search.** Keyword search with an optional semantic lane, result explanations, recall profiles and compact cards; an opt-in iterative loop (`search_iterative_recall_enabled`, default off) keeps querying when coverage gaps survive, pausing with a plan the caller answers through `brain_search`'s round trip; and an opt-in per-source-session cap (`search_pool_max_per_session`, default off) keeps one long imported session from filling the candidate window, so diversity spreads across sessions: [search CLI](cli-reference.md#search), [iterative recall](cli-reference.md#iterative-recall-since-v1820), [pool cap](cli-reference.md#the-per-source-session-pool-cap-since-v1830), [ranking](how-it-works.md#full-text-search).
- **Session recall.** Import agent transcripts already on disk, search them, or select whole-thread coverage under a character budget (`o2b brain session-grep --operation coverage --char-budget <n>`, with `--entity-key` seeding the fan-out from mined entity mentions): [session logs](cli-reference.md#session-logs-this-machine-already-has-since-v1500), [coverage](cli-reference.md#coverage-first-session-recall-since-v1820).
- **Hygiene.** `o2b brain hygiene scan` finds contested, duplicate, stale and unused memories; `apply` runs only the findings you pick: [maintenance](cli-reference.md#maintenance-and-operator-surfaces).
- **Claim ledger.** `o2b brain truth ingest` records an entity claim with an optional validity window (`--valid-from`/`--valid-until`; with the flags absent, a window on the source record's frontmatter is adopted and frozen at ingest), `truth events` recalls a windowed slice of the ledger, and `truth state` grounds an agent-stated claim with an anchoring verdict - committed, or reported back with reason codes. `truth state` accepts an optional opaque `--sample-id` naming the context-pack sample the claim drew on, and claim reads report the receipt and outcome provenance behind it at the caller's reach - "receipt known, outcome unknown", never an invented verdict: [entity truth CLI](cli-reference.md#entity-truth-and-self-improving-dream-since-v0430).
- **Corrections.** `o2b brain lifecycle correct <target>` reports a correction's blast radius and retires the affected records - validity-closed by default, tombstoned with `--flatly-wrong`, dry run by default and `--apply` to write. A retired record that recall can still serve is served only beside its correction, never alone: [belief lifecycle CLI](cli-reference.md#belief-lifecycle-and-decision-memory-since-v1330).
- **Sharing and backup.** Knowledge packs export a chosen subset; `o2b brain bank-export` writes a one-file bundle, redacted, without prompt-derived pages unless `--include-prompt-derived` is passed and without privacy-marked preferences, so it is a partial export, not a full backup: [knowledge packs](cli-reference.md#knowledge-packs).
- **Secret custody.** Credentials live encrypted in the vault's state dir behind a capability-gated store; `$secret:NAME` references resolve at the use sites, `o2b brain secret unlock` wraps the keyfile under a passphrase, and `secret export`/`import` move the store between installs as one passphrase-encrypted bundle: [custody CLI](cli-reference.md#write-time-integrity-and-governance-since-v0440).
- **Today view and note markers.** `o2b brain today`, `@osb loop` and `@osb set` markers: [Brain CLI](cli-reference.md#brain-observing-memory).
- **Self-inspection.** `o2b version`, `o2b install --friction` and `o2b state status` report what is installed and where state lives: [CLI reference](cli-reference.md#core).
- **MCP surface.** Tools, tool profiles for hosts with tool limits, and the always-loaded writer server: [`docs/mcp.md`](mcp.md).

## Optional features

- **Semantic search:** an embedding provider plus `sqlite-vec`; the `embeddings-setup` skill walks through it: [`skills/embeddings-setup/SKILL.md`](../skills/embeddings-setup/SKILL.md).
- **Decision models:** a typed judgment model that can rerank search and filter candidates, off by default per use: [`docs/decision-models.md`](decision-models.md).
- **Deep relational recall:** a fourth search arm over typed links, off by default. Its traversal runs under width budgets - 8 seeds, 4 edges per node, 16 nodes in total, and a hub above 12 walked edges is reached but not expanded - each overridable through an `OPEN_SECOND_BRAIN_SEARCH_TRAVERSAL_*` environment variable or a `search_traversal_*` config key; entity co-occurrence bridges join the walk by default and switch off separately (`OPEN_SECOND_BRAIN_SEARCH_ENTITY_BRIDGES`): [retrieval quality](cli-reference.md#retrieval-quality-and-context-delivery-since-v1370).
- **Staged review for agent writes, off by default.** With no key set every write publishes exactly as before. `write_approval.notes` / `OPEN_SECOND_BRAIN_WRITE_APPROVAL_NOTES_ENABLED` and `write_approval.ingest` / `OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED` (each falling back to the `write_approval.enabled` master, default off) stage note creates and ingest summary pages into `Brain/pending/` beside the staged signals, where they stay out of the search index until an operator runs `o2b brain pending list` and applies or rejects them; [write-path integrity](cli-reference.md#write-path-integrity-and-store-safety-since-v1320).
- **A permissions document, absent by default.** The operator-only shared setting `permissions.document`, set with `o2b brain settings set permissions.document "<yaml>"` (on a machine not yet switched to the brain store with the setting unset, the vault file `Brain/_permissions.yaml`, which the migration imports), resolves `allow`/`ask`/`deny` per agent, role and target for the write, ingest and owner-write actions; with no document every check behaves exactly as today. `ask` stages the write, `deny` refuses with the `write-refused` token and the next command `o2b brain permissions show`, and every ask/deny verdict lands in a queryable decision ledger under `Brain/logs/decisions/`; `o2b brain permissions show` dry-runs the decision table, `ledger` reads the rows; [Brain CLI](cli-reference.md#brain-observing-memory).
- **The owner-write gate, off by default.** The operator-only shared setting `integrity.owner_scope_writes` (`off` | `warn` | `fail`, default `off`), set with `o2b brain settings set integrity.owner_scope_writes <mode>` (in `Brain/_brain.yaml` only on a machine not yet switched to the brain store), refuses a caller-named owner that differs from the caller's resolved identity on the preference and note lanes (`warn` allows and records one decision-ledger row); a document `owner_write` verdict composes most-restrictive-wins with the gate; [write-time integrity](cli-reference.md#write-time-integrity-and-governance-since-v0440).
- **Named MCP tokens, optional.** `o2b mcp token mint|rotate|revoke|list` keeps a hash-at-rest token per agent (`.open-second-brain/secrets/mcp-tokens.json`; material shown exactly once). Over HTTP a valid token authenticates as its agent per request, the shared `--api-key` stays valid as the operator master credential, and `mcp_tokens_required` / `OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED` (default `false`) makes a non-empty token map refuse credential-less requests. `o2b bootstrap --target <harness> [--token] [--rotate] [--check]` provisions MCP registration, token and receipt in one idempotent command, and `o2b bootstrap --remove <harness>` tears a provision down again; the minted token authenticates HTTP clients configured by hand, while the registered stdio harness presents no credential and keeps its config-derived identity; [core CLI](cli-reference.md#core).
- **Ambient capture consent, opt-out.** `guardrails.ambient_writeback: false` suppresses the ambient extraction lane with a counted `ambient-withheld` event (absent keeps today's behavior), and `guardrails.ambient_ttl_days` stamps an `expiration_date` on ambient-extracted signals so reads drop them after the window (absent stamps nothing); a TTL-stamped signal still stages when the review gate is on and survives apply verbatim.
- **Open decisions.** `o2b brain decision open --title <t> --question <q> --option <o> [...]` parks a question with enumerated options at `Brain/decisions/open-<slug>.md`; `resolve` mints the real `type: decision` page, `discard` closes without deciding, and the morning brief renders up to five open questions: [belief lifecycle](cli-reference.md#belief-lifecycle-and-decision-memory-since-v1330).

## Release history

Every release is described in the [CHANGELOG](../CHANGELOG.md); upgrade
notes are in [`updating.md`](updating.md).
