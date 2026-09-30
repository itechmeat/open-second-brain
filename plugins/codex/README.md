# Open Second Brain

![Open Second Brain - your knowledge, amplified by AI](https://github.com/itechmeat/open-second-brain/raw/main/docs/images/readme-poster.jpg)

Open Second Brain is a memory layer for AI agents that lives in an [Obsidian](https://obsidian.md) vault. Agents read and write it through MCP servers, lifecycle hooks and the `o2b` CLI. Everything the agent learns is a Markdown file under `Brain/`, so you can open, edit, grep and version it like any other note. A deterministic `dream` pass turns repeated signals into rules and retires the ones nothing uses; no model runs inside that algorithm.

## How it fits

```mermaid
flowchart LR
    subgraph Clients["Agent clients"]
        Plug["Plugins: Claude Code, Codex,<br/>Hermes, opencode, Grok Build"]
        Mcp["MCP config: Cursor, kiro, Copilot CLI,<br/>Gemini CLI, ZCode, any MCP host"]
        Claw["OpenClaw<br/>in-process plugin"]
        Cliu["Aider, Pi<br/>CLI and context file"]
    end
    subgraph Product["Open Second Brain"]
        Srv["MCP servers<br/>open-second-brain, open-second-brain-writer"]
        Hooks["Lifecycle hooks<br/>o2b-hook"]
        Cli["CLI<br/>o2b"]
        Core["Core"]
    end
    subgraph Vault["Your vault"]
        Brain["Brain/<br/>Markdown the agent writes"]
        Notes["Your notes"]
        Index[(".open-second-brain/brain.sqlite<br/>rebuildable search index")]
    end
    Plug --> Srv
    Plug --> Hooks
    Mcp --> Srv
    Claw --> Core
    Cliu --> Cli
    Srv --> Core
    Hooks --> Core
    Cli --> Core
    Core --> Brain
    Core --> Index
    Core -. reads, writes a named note on request .-> Notes
```

Each client reaches the same core through a plugin, an MCP registration or the CLI. The core keeps its own records under `Brain/` and a generated search index under `.open-second-brain/` that it can rebuild from the files. Your notes are read; the note tools write one only at a path the caller names.

```mermaid
flowchart LR
    Agent["Agent"] -->|brain_feedback| Inbox["Brain/inbox/<br/>signal"]
    Inbox -->|dream pass| Pref["Brain/preferences/<br/>rule"]
    Pref -->|rendered into| Active["Brain/active.md"]
    Active -->|read at session start| Agent
    Agent -->|brain_apply_evidence| Log["Brain/log/"]
    Log -->|next dream pass| Pref
```

The learning loop: signals become rules, rules reach the next session through `Brain/active.md`, and applied or violated evidence confirms, quarantines or retires them. Details: [`docs/how-it-works.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/how-it-works.md#a-preferences-lifecycle).

## Install

1. Install [Bun](https://bun.sh/) 1.1 or later: [`install/prerequisites.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/prerequisites.md).
2. Install the plugin for your client (guides below), or get the `o2b` CLI: [`install/prerequisites.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/prerequisites.md#get-the-o2b-cli).
3. Create the vault files:

   ```bash
   o2b init       --vault /path/to/vault --name "My Second Brain"
   o2b brain init --vault /path/to/vault
   ```

4. Connect the client (table below), then check the result:

   ```bash
   o2b doctor --vault /path/to/vault
   o2b install --check
   ```

The full router with readiness criteria is [`install.md`](https://github.com/itechmeat/open-second-brain/blob/main/install.md); native Windows is covered in [`install/windows.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/windows.md).

## Supported clients

| Client | Integration | Guide |
| --- | --- | --- |
| Claude Code | Marketplace plugin: MCP servers and hooks | [`install/claudecode.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/claudecode.md) |
| OpenAI Codex | Marketplace plugin, then `o2b install --target codex --apply` | [`install/codex.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/codex.md) |
| Hermes Agent | Plugin and memory provider | [`install/hermes.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/hermes.md) |
| OpenClaw | Native plugin, no MCP | [`install/openclaw.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/openclaw.md) |
| opencode | `o2b install --target opencode --apply`: MCP servers and a native plugin | [`install/opencode.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/opencode.md) |
| Grok Build | `o2b install --target grok --apply`: MCP servers and hooks | [`install/grok.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/grok.md) |
| Cursor | `o2b install --target cursor --apply` | [`install/cursor.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/cursor.md) |
| kiro | `o2b install --target kiro --apply` | [`install/kiro.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/kiro.md) |
| GitHub Copilot CLI | `o2b install --target copilot-cli --apply` | [`install/copilot-cli.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/copilot-cli.md) |
| Gemini CLI | `o2b install --target gemini-cli --apply` | [`install/gemini-cli.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/gemini-cli.md) |
| ZCode | MCP servers added to its config by hand | [`install/zcode.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/zcode.md) |
| Aider | `o2b install --target aider --apply`: context file, no MCP | [`install/aider.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/aider.md) |
| Pi | `o2b install --target pi --apply`: skill over the CLI | [`install/pi.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/pi.md) |
| Any other MCP host | `o2b install --target generic --apply --out -` prints the server entries | [`install/generic.md`](https://github.com/itechmeat/open-second-brain/blob/main/install/generic.md) |

`o2b uninstall --target <name> --apply` removes what `o2b install` wrote; the vault is never touched ([`install.md`](https://github.com/itechmeat/open-second-brain/blob/main/install.md#uninstall)).

## Capabilities

- **Preferences that learn and expire.** Signals, a deterministic dream pass, confidence and retirement: [how it works](https://github.com/itechmeat/open-second-brain/blob/main/docs/how-it-works.md#a-preferences-lifecycle).
- **Reversible changes.** Brain mutations take a snapshot first; `o2b brain rollback` restores it: [snapshots](https://github.com/itechmeat/open-second-brain/blob/main/docs/how-it-works.md#snapshots-and-rollback).
- **Attributed writes.** `o2b brain writes` lists every note write by agent and device, `writes revert` plans a restore, `o2b brain freeze` stops all writers, and `o2b brain log verify` checks the hash-chained log: [Brain CLI](https://github.com/itechmeat/open-second-brain/blob/main/docs/cli-reference.md#brain-observing-memory).
- **Search.** Keyword search with an optional semantic lane, result explanations, recall profiles and compact cards: [search CLI](https://github.com/itechmeat/open-second-brain/blob/main/docs/cli-reference.md#search), [ranking](https://github.com/itechmeat/open-second-brain/blob/main/docs/how-it-works.md#full-text-search).
- **Session recall.** Import agent transcripts already on disk and search them: [session logs](https://github.com/itechmeat/open-second-brain/blob/main/docs/cli-reference.md#session-logs-this-machine-already-has-since-v1500).
- **Hygiene.** `o2b brain hygiene scan` finds contested, duplicate, stale and unused memories; `apply` runs only the findings you pick: [maintenance](https://github.com/itechmeat/open-second-brain/blob/main/docs/cli-reference.md#maintenance-and-operator-surfaces).
- **Sharing and backup.** Knowledge packs export a chosen subset; `o2b brain bank-export` writes a one-file backup bundle: [knowledge packs](https://github.com/itechmeat/open-second-brain/blob/main/docs/cli-reference.md#knowledge-packs).
- **Today view and note markers.** `o2b brain today`, `@osb loop` and `@osb set` markers: [Brain CLI](https://github.com/itechmeat/open-second-brain/blob/main/docs/cli-reference.md#brain-observing-memory).
- **Self-inspection.** `o2b version`, `o2b install --friction` and `o2b state status` report what is installed and where state lives: [CLI reference](https://github.com/itechmeat/open-second-brain/blob/main/docs/cli-reference.md#core).
- **MCP surface.** Tools, tool profiles for hosts with tool limits, and the always-loaded writer server: [`docs/mcp.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/mcp.md).

## Optional features

- **Semantic search:** an embedding provider plus `sqlite-vec`; the `embeddings-setup` skill walks through it: [`skills/embeddings-setup/SKILL.md`](https://github.com/itechmeat/open-second-brain/blob/main/skills/embeddings-setup/SKILL.md).
- **Decision models:** a typed judgment model that can rerank search and filter candidates, off by default per use: [`docs/decision-models.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/decision-models.md).

## What is new

1.63.0 binds a prose mention to a page only when exactly one page carries the term, turns relative imports and JSX component usage into code-structure edges, lets a `brain_write_batch` retry apply once through a request ID, adds a keyword match breadth to search, and gives every append-only Brain ledger one file per synced device. Every release is described in the [CHANGELOG](https://github.com/itechmeat/open-second-brain/blob/main/CHANGELOG.md).

## Documentation

| Topic | Page |
| --- | --- |
| Mental model, vault layout, dream pass, safety properties | [`docs/how-it-works.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/how-it-works.md) |
| Every CLI verb and flag | [`docs/cli-reference.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/cli-reference.md) |
| MCP protocol, tools, writer split | [`docs/mcp.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/mcp.md) |
| Architecture and configuration model | [`docs/architecture.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/architecture.md) |
| Updating (`o2b update`) and upgrade notes | [`docs/updating.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/updating.md) |
| Observability events | [`docs/observability.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/observability.md) |
| Metrics data contract | [`docs/metrics.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/metrics.md) |
| Cross-project pointer | [`docs/cross-project-pointer.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/cross-project-pointer.md) |
| Scheduled Brain digest (Hermes cron) | [`docs/hermes-cron.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/hermes-cron.md) |
| Stability policy | [`docs/stability.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/stability.md) |
| Origin of the idea | [`docs/idea.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/idea.md) |

## Project

[CHANGELOG](https://github.com/itechmeat/open-second-brain/blob/main/CHANGELOG.md) · [Security policy](https://github.com/itechmeat/open-second-brain/blob/main/SECURITY.md) · [Source on GitHub](https://github.com/itechmeat/open-second-brain) · [MIT License](https://github.com/itechmeat/open-second-brain/blob/main/LICENSE)
