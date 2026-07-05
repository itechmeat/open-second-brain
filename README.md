# Open Second Brain

![Open Second Brain - your knowledge, amplified by AI](docs/images/readme-poster.jpg)

> An [Obsidian](https://obsidian.md)-native memory layer for your AI agent. Plain Markdown you own, in the same vault you already use.

Open Second Brain plugs into [Hermes Agent](https://github.com/NousResearch/hermes-agent) and turns your Obsidian vault into a memory layer the agent reads and writes through deterministic CLI / MCP tools. Preferences, signals, evidence, and audit trails are real `.md` files under `Brain/` in the vault you already open in Obsidian every day. You can grep them, version them with git, search them in Obsidian, edit them by hand. No daemon, no vector black box, no hidden state outside the vault.

## What is new

Open Second Brain 1.22.0 closes the retrieval quality loop on four surfaces. Packed and recalled items now carry a structural epistemic status (observed, derived, hypothesis, plan, or unknown) plus evidence refs, derived from existing graph metadata so a consuming model can tell a source-backed fact from a conjecture (always on, fields absent when unknown). A thin recall adequacy verdict classifies each recall as sufficient, weak, or insufficient with a recommended action (proceed, re-recall, abstain) and an optional escalate flag, surfaced in recall gate output and context receipts when the caller passes scores (thresholds configurable). A persisted cross-query demand log records each recall and an aggregation reader ranks recurring queries the vault answers poorly, exposed as the brain_knowledge_gaps tool and o2b brain knowledge-gaps (the log is written only when recall gate telemetry is opt-in, queries normalized before append). A unified lessons digest folds positive knowledge and dead-ends into one signed, recency-scored, corroboration-tiered corpus under Brain/lessons.md, regenerated every dream pass and loaded on session start. Every new field is optional and absent by default, so callers that do not opt in see byte-identical output, and the kernel still calls no LLM.

## Why

- **Lives in your Obsidian vault.** Open `Brain/preferences/pref-no-internal-abbrev.md` in Obsidian and you literally see what your agent learned about you - title, status, evidence count, confidence band, body text. Wikilinks, backlinks, graph view all work.
- **You own the data.** Plain Markdown on your filesystem. No service to cancel, no cloud account, no schema migration when a vendor pivots. Syncthing to your other machines if you want.
- **Memory that learns deterministically.** A `dream` pass turns repeat signals into rules and retires the ones nothing applies any more. Counters and atomic file moves - no LLM inside the algorithm, no surprise hallucinations in your memory.
- **One vault, every agent.** Hermes Agent is the primary integration. Claude Code, OpenAI Codex, Cursor, Aider, OpenClaw, opencode, Grok Build, kiro, Copilot CLI, Gemini CLI, and Pi all plug into the same Brain through MCP.

## One vault, many runtimes

```mermaid
flowchart LR
    Vault[("Your vault<br/>Brain/ - plain Markdown")]
    Hermes["**Hermes Agent**<br/>(primary)"]
    CC[Claude Code]
    Codex[OpenAI Codex]
    Others["Cursor · Aider · OpenClaw<br/>opencode · Grok Build · kiro · Copilot CLI<br/>Gemini CLI · Pi · any MCP host"]

    Hermes <==> Vault
    CC <--> Vault
    Codex <--> Vault
    Others <--> Vault

    style Hermes fill:#1e3a5f,stroke:#90caf9,color:#fff
    style Vault fill:#5d3a9b,stroke:#ce93d8,color:#fff
```

Hermes Agent owns the schedule (dream cron, daily digests, Telegram delivery). Other runtimes participate as readers and writers of the same Brain through MCP - no per-runtime fork of the memory.

## Quick start with Hermes Agent

**The simplest path - let your agent set it up.** Paste this into Hermes (or whichever AI agent already has shell access on the target machine):

> Install Open Second Brain for me by following the steps at <https://github.com/itechmeat/open-second-brain/blob/main/install/hermes.md>. My vault is at `/path/to/your-vault`.

The agent reads the install doc, runs every command, and verifies the result. That's it.

If you prefer running the steps yourself:

```bash
# 1. Install the plugin
hermes plugins install itechmeat/open-second-brain --enable
hermes gateway restart

# 2. Put `o2b` on PATH
~/.hermes/plugins/open-second-brain/scripts/o2b install-cli

# 3. Bootstrap the vault
o2b init       --vault /path/to/your-vault --name "My Second Brain"
o2b brain init --vault /path/to/your-vault --primary-agent <agent-name>

# 4. Verify
o2b doctor --vault /path/to/your-vault
```

Enable Open Second Brain as the memory provider in `~/.hermes/config.yaml` (`memory.provider: open-second-brain`) and restart the gateway one more time - the agent now injects `Brain/active.md` into its system prompt, recalls context before each turn, and writes signals through `brain_feedback`, all through the one native provider. Full step-by-step: [`install/hermes.md`](install/hermes.md).

## Other runtimes

| Runtime                                                          | Install                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Claude Code                                                      | Marketplace plugin (bundled `.mcp.json` + hooks) - [`install/claudecode.md`](install/claudecode.md) |
| OpenAI Codex                                                     | `codex plugin marketplace add ...` - [`install/codex.md`](install/codex.md)                         |
| OpenClaw                                                         | Native JS plugin, no MCP needed - [`install/openclaw.md`](install/openclaw.md)                      |
| opencode                                                         | `o2b install --target opencode --apply` (MCP servers + native plugin) - [`install/opencode.md`](install/opencode.md) |
| Grok Build                                                       | `o2b install --target grok --apply` (MCP in `config.toml` + native hooks) - [`install/grok.md`](install/grok.md) |
| Cursor · Aider · kiro · Copilot CLI · Gemini CLI · Pi            | `o2b install --target <name> --apply` - see [`install/`](install/)                                  |
| Any other MCP host                                               | `o2b install --target generic --apply` - [`install/generic.md`](install/generic.md)                 |

Each non-Hermes target writes a sidecar manifest under `<vault>/.open-second-brain/install.lock.json` so `o2b uninstall --target <name> --apply` removes exactly what it added.

## What you get

- **Your memory as Markdown.** Every rule the agent learns about you is a file under `Brain/` you can open, edit, grep, and version. Obsidian wikilinks, backlinks, and the graph view just work - there is no separate UI to learn.
- **Memory that learns, and forgets, on its own.** A nightly `dream` pass turns repeated corrections into rules and retires the ones nothing uses any more. Deterministic by design: counters and atomic file moves, no LLM guessing inside your memory.
- **One brain, every agent.** Teach a rule in one agent and the next one already knows it - Hermes, Claude Code, Codex, Cursor, and the rest read and write the same vault.
- **You stay in control.** Pin, merge, retire, or roll back any rule from the `o2b` CLI. Every Brain mutation takes a verified snapshot first, so a bad change is one `o2b brain rollback` away.
- **Search that explains itself.** Keyword plus an optional semantic layer over your vault, with results that show why they surfaced and what was missing - not a black box. Opt into a structured per-result score breakdown (`explain`), inline trust metadata (age, superseded, conflict), a relevance threshold that returns nothing rather than weak noise, and reinforcement that lifts memories you have marked useful. Track retrieval quality over time with `brain_eval` and the recall benchmark (hit@k, MRR, answer-containment@k).
- **Conversations survive compaction.** When the host compresses context and rotates the session id, capture and recall stitch the segments back into one conversation - any segment id returns the whole lineage.
- **Memory that cleans itself, on your terms.** `o2b brain hygiene scan` surfaces contested facts, near-duplicate rules, stale derived pages, and never-recalled memories; `apply` executes only the findings you select, and stale pages recompile from their recorded sources with a dry-run preview.
- **A vault that stays fresh, consistent, and scoped.** `o2b search watch` keeps the index live as you edit, debounced and incremental; note identity is Unicode-normalized so the same file is one entry across macOS and Linux devices instead of a phantom cross-device duplicate; and recall accepts an opt-in `agent_scope` so a page marked with an `owner:` is reachable only to its owner while shared pages stay open to all.
- **Knowledge that knows where it came from.** Drop a source document and the agent's extraction becomes cross-referenced entity and concept pages plus a summary page that backlinks the source and lists its connections; N sources become one dated report whose every finding cites the source that flagged it; a derived fact carries a `deduced`/`inferred` provenance level and links back to its premises, and recall trusts an operator-stated rule above a machine-derived one. A fact can declare an `owner:` so multi-agent brains keep separate truth spaces, and a standing-query attention flow surfaces the open loops you declare. The plugin never runs a model itself - the agent owns generation, the vault owns the durable, provenanced record - and every behaviour is opt-in.
- **An index that survives interruption.** Stopping `o2b search watch` mid-sync finishes the in-flight pass at a file boundary before exiting (within `search_shutdown_grace_seconds`) instead of killing it mid-write; an incremental run is already resumable through the unchanged-file fastpath, and `search_resume_reindex` extends that to a full rebuild - an interrupted reindex resumes its staging build instead of starting over, guarded by a signature so a drifted build is discarded rather than trusted. Both default off, so behaviour is unchanged unless you ask for it.
- **A brain you can carry, hand off, and write to in process.** `o2b brain bank-export` serialises a whole vault - preferences, the page graph, a per-page interchange contract (path, kind, advisory confidence/provenance, citations, aliases, freshness), and the sources dashboard - into one deterministic, schema-versioned bundle for backup, migration, or downstream-tool ingest; `bank-import` reconstructs the page graph and reports the rest as carried-not-restored rather than faking a full restore. A `brain_create_note` MCP tool writes an actual vault note (path + frontmatter + content) atomically, refusing traversal, the Brain root, and clobbering. And `createBrain(vault)` is a thin in-process SDK over the same core functions - bank/graph export-import, preference export, source ingest plus list/get/delete, and note creation - so scripts and agents manage brain content without the CLI or MCP layer.
- **Recall you can tune, and a working set that prunes itself.** `o2b search --profile fast|balanced|thorough` (and the `brain_search` `profile` field) pick a recall preset over the same bounded knobs the self-tuner uses - an explicit profile wins over a learned grid point, and no profile leaves ranking bit-for-bit unchanged. `o2b brain file-context <path>` surfaces prior vault work that mentions a file before you read it; `o2b brain co-occurrence` proposes relationship edges between entities repeatedly co-referenced from the same notes, scored structurally over the wikilink graph with no natural-language word list in any language; and `o2b brain continuity rank` weights working-memory records by a usage-driven decay derived only from real recall telemetry, so stale decisions fade while actively-recalled ones stay prominent. All deterministic, all read-only or suggestion-only.
- **Session knowledge you can query, trace, and walk.** `o2b brain session-summary` (and `brain_session_summary`) stores a session-scoped digest over four categories - request, decisions, learnings, next_steps - that the agent extracts and the kernel only stores, so you can ask what a session decided as one unit. `o2b brain idea-lineage <id>` traces how a derived artifact was reached as an observation to synthesis to conclusion graph over the edges already recorded (continuity `sourceRefs`, or a preference's belief-evolution), cycle-guarded and depth-bounded. `o2b brain note-history <path>` splits a note's git history into episodic phases on a deterministic commit-time gap - language-agnostic, no commit-message parsing. The kernel never calls a model; absent inputs report honestly rather than fabricating.
- **Operational readability for code partners and large vaults.** Open Second Brain now exposes a read-only CodeGraph report (`o2b partner codegraph report`, `brain_codegraph_report`) that resolves the in-scope code project, reports the codegraph index state with node and edge counts, and structurally parses Cargo.toml for Rust workspace members. The report is honest about missing CLIs, missing indexes, and non-Rust projects. For large vaults, community materialization can run in fixed-size batches (`o2b brain clusters run --batch-size N`, `brain_clusters` `batch_size`) with per-batch success or isolated failure reporting, while the default run stays byte-identical.
- **Consistent feedback categorization.** A vault-local `feedback.default_scope` in `Brain/_brain.yaml` gives agent-recorded signals a consistent category (for example `coding`) when no explicit scope is provided, with the same precedence across the inbox signal, its shared-namespace mirror, and any force-confirmed preference. The effective scope is computed once at the signal write boundary and byte-identical output is preserved when the setting is absent or no explicit scope is given.
- **Path-safe vault writes.** The write-session commit chokepoint now re-resolves every target through `ensureInsideVault` before any directory creation, read, or write, catching symlinked ancestors that point outside the vault root. The backstop fails closed: a target resolving outside the configured vault is rejected and nothing is written. All other caller-derived vault paths already funnel through guarded constructors; regression tests pin both invariants.
- **Recall that pays for depth only on demand.** General vault search now offers the same progressive 3-layer disclosure session-recall already had. `o2b search "<q>" --disclosure cards` (and the `brain_search` `disclosure: "cards"` field) returns compact layer-1 cards - path, title, score, reasons, a bounded snippet, and a `path:Lstart-Lend` pointer - instead of full content per hit, so recall stays token-cheap. Drill a hit with `o2b search expand --chunk <id>` (or `brain_search_expand`) to get layer 2 (the fuller note) and layer 3 (the raw chunk transcript, paginated by cursor). It reuses the existing index read - no new index, no model - and the default `full` mode is byte-identical to before. Cards compose with cross-vault recall too: `--global --disclosure cards` returns the token-cheap layer-1 cards merged across every origin (each labelled by its origin), not an empty result set.

That is the day-to-day picture. The full capability surface, every CLI verb, and the mental model live in the [documentation](#documentation) below.

## Safety

- Plain Markdown on your filesystem. No daemon, no background writes. The MCP server is a stdio subprocess that exits with the parent runtime.
- Your vault is the only source of truth - no hidden state, no cloud copy.
- Brain mutations (`dream`, `merge`, `upgrade`) take a pre-run snapshot with a SHA-256 sidecar; `o2b brain rollback` aborts on drift unless `--force-rollback`.
- Secrets are not supposed to live in the vault. Daily logs and config exports run through a best-effort redactor, `$secret:NAME` references resolve from the local environment and are never stored, and Brain redaction strips `<private>...</private>` regions before storage.
- Automatically surfaced Brain context passes through a deterministic prompt-injection guard; filtered output returns a placeholder with a reason code and the source Markdown is never rewritten. Opt into `untrusted_source_delimiting` for language-agnostic structural containment instead: an untrusted span is wrapped in a provenance-carrying `<untrusted_source path sha256>` delimiter and neutralized by structure (invisible/control characters, delimiter breakouts) rather than a per-language word list, losslessly and identically for every language.
- Context receipts and recall telemetry are opt-in and store redacted metadata, hashes, and counters rather than raw prompt text.

## Updating

```bash
o2b update                    # detect runtimes, skip unchanged, apply, verify
o2b doctor                    # confirm the new manifest validates
```

Updates need no manual symlink surgery: hooks resolve the active plugin version
on their own and the `~/.local/bin` CLI symlinks self-heal on the next session
start. Per-runtime upgrade paths and the canonical version source live in
[`install.md`](install.md); the update-safety contract (and the invariants any
change to hooks/launcher/install must keep) lives in
[`docs/updating.md`](docs/updating.md).

## Documentation

| Topic                                              | Doc                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Mental model, vault layout, dream mechanics        | [`docs/how-it-works.md`](docs/how-it-works.md)                   |
| MCP protocol, tools, lifecycle, writer split       | [`docs/mcp.md`](docs/mcp.md)                                     |
| Full CLI reference (every verb, every flag)        | [`docs/cli-reference.md`](docs/cli-reference.md)                 |
| Update safety contract + hook/launcher invariants  | [`docs/updating.md`](docs/updating.md)                           |
| Hermes cron jobs (daily digest, discipline report) | [`docs/hermes-cron.md`](docs/hermes-cron.md)                     |
| Cross-project pointer (multi-host vaults)          | [`docs/cross-project-pointer.md`](docs/cross-project-pointer.md) |
| Architecture                                       | [`docs/architecture.md`](docs/architecture.md)                   |
| Origin idea                                        | [`docs/idea.md`](docs/idea.md)                                   |

## Uninstalling

```bash
o2b uninstall                       # print plan (read-only)
o2b uninstall --apply-local --remove-cli   # remove local state and symlinks
```

Your vault is never touched by the uninstall flow. Delete it yourself with normal filesystem tools if you want to.

## License

MIT. Source: <https://github.com/itechmeat/open-second-brain>.
