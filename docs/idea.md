# Open Second Brain Idea

Open Second Brain is a portable second brain system for agentic work. It packages a shared vault protocol, event log, configuration model, CLI tools, skills, and runtime adapters so different AI agents can participate in the same knowledge system.

The initial local instance that motivated this project is Hermes Second Brain: a Hermes-first setup on a VPS where agents develop small projects, operate infrastructure, and write durable operational notes into an Obsidian-compatible vault. The open-source package should not be Hermes-specific. Hermes is one adapter.

## Core idea

Agents need two different memory layers:

1. Runtime memory: short, compact facts injected into future conversations by a specific agent runtime.
2. Vault memory: durable, inspectable, portable Markdown knowledge owned by the user.

Runtime memory is useful but not portable. Vault memory is portable but needs clear write policies, schemas, and tooling so agents do not turn it into an unstructured dump.

Open Second Brain defines the vault layer and provides adapters for runtimes.

## Why plugin-first

A standalone skill can describe a workflow, but it is a weak owner of operational state. A plugin package can provide a stronger lifecycle:

- installation;
- discovery;
- config schema;
- status checks;
- redacted config export;
- migrations;
- runtime hooks where supported;
- shared scripts;
- bundled skills;
- optional MCP configuration later.

The project should still include skills. Skills remain the best way to teach agents when and how to use the system. The plugin/package is the distribution and lifecycle layer; skills are protocol and reasoning guidance.

## Name

The public project name is `open-second-brain`.

Local instances may use names such as:

- Hermes Second Brain;
- Claude Second Brain;
- Team Second Brain;
- Project Second Brain.

The project should avoid naming that implies it is only for one agent runtime.

## Event log and daily log

The existing `daily-log` idea should become part of this project as an event log component.

Recommended terminology:

- component: event log;
- compatibility command: `vault-log`;
- possible skill name: `agent-event-log`;
- default backend: daily Markdown notes.

A daily note is one storage backend, not the whole concept. Other possible backends include JSONL, SQLite, or a hybrid mode.

The event log is append-only operational evidence. The wiki/second-brain layer is synthesized knowledge. These must remain separate:

- event log: what happened, when, by whom;
- second brain wiki: what we learned, what remains true, what should guide future work.

## v0 decision

v0 should be CLI + docs + skills + plugin manifests.

Do not start with a daemon or full MCP server. The early goal is a portable, understandable, installable package that can be used by Hermes, Claude Code, Codex, and future agent runtimes.

Future versions may add:

- an MCP server;
- deeper Hermes hooks;
- Claude/Codex hook integrations;
- automated capture workflows;
- richer query/indexing support;
- local UI or documentation site.
