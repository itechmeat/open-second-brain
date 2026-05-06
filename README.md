# open-second-brain

Open Second Brain is an open-source, plugin-first second brain package for AI agents and humans.

It is designed to give Hermes Agent, Claude Code, OpenAI Codex, and other agentic runtimes a shared, portable way to remember durable project knowledge, append operational event logs, query an Obsidian-compatible vault, and carry the same workflow across machines without locking knowledge into one agent runtime.

Status: experimental v0 design. The first release target is documentation, CLI foundations, skills, and plugin manifests. Deeper runtime integrations and MCP support are planned for later versions.

## Goals

- Provide a filesystem-first second brain that works with Obsidian-compatible Markdown vaults.
- Keep mutable user data and configuration separate from immutable plugin/package code.
- Support multiple agent runtimes through adapters instead of a single runtime-specific implementation.
- Treat daily logs as one backend for an append-only agent event log.
- Make setup, status checks, redacted config export, and future migrations deterministic through CLI tools.
- Avoid storing secrets, tokens, credentials, or private connection strings in the vault.

## Non-goals for v0

- No always-on daemon.
- No mandatory MCP server.
- No automatic self-rewriting maintenance jobs.
- No replacement of an existing personal vault.
- No hidden background writes outside the configured agent-owned area.

## Planned v0 shape

```text
open-second-brain/
  docs/
    idea.md
    architecture.md
    roadmap.md
  skills/
    open-second-brain/
      SKILL.md
    agent-event-log/
      SKILL.md
  scripts/
    asb
    vault-log
  plugins/
    hermes/
      plugin.yaml
      __init__.py
  .claude-plugin/
    plugin.json
  .codex-plugin/
    plugin.json
```

## Runtime strategy

Open Second Brain is plugin-first, but not plugin-only.

- Plugins provide installation, discovery, lifecycle integration, and runtime adapters.
- Skills teach agentic runtimes the protocol and safety rules.
- CLI tools provide deterministic operations that should not depend on model reasoning.
- MCP can be added later as a shared tool API over the same core.

## License

MIT. See `LICENSE`.
