# Open Second Brain documentation

The user documentation, grouped by what you are trying to do. Agents that install Open Second Brain start from [`llms.txt`](../llms.txt).

## Get started

- [Installation](../install.md): install the package, run `o2b setup` for your host, verify, uninstall
- [Prerequisites](../install/prerequisites.md): Bun, the `o2b` command line, the agent name and time zone, vault discovery, consent
- [After install](../after-install.md): the dream owner, the dream agent, the readable pages, local cleanup
- [Native Windows](../install/windows.md): paths, launchers and what differs on Windows

## Connect an agent

- [Claude Code](../install/claudecode.md): marketplace plugin with MCP servers and hooks
- [Codex](../install/codex.md): MCP registration, the plugin for hooks, ChatGPT desktop
- [Hermes Agent](../install/hermes.md): plugin and memory provider
- [OpenClaw](../install/openclaw.md): native plugin without MCP
- [opencode](../install/opencode.md): MCP servers and a native plugin
- [Grok Build](../install/grok.md): MCP servers and hooks
- [Cursor](../install/cursor.md): MCP servers
- [kiro](../install/kiro.md): MCP servers
- [GitHub Copilot CLI](../install/copilot-cli.md): MCP servers through `copilot mcp add`
- [Gemini CLI](../install/gemini-cli.md): MCP servers in the Gemini settings
- [ZCode](../install/zcode.md): MCP servers added by hand
- [Aider](../install/aider.md): a managed context file, no MCP
- [Pi](../install/pi.md): a skill over the command line
- [Any other MCP host](../install/generic.md): the printed server entries to merge
- [Project directories outside the vault](cross-project-pointer.md): how an agent in another folder finds the brain

## Understand how it works

- [Features](features.md): what Open Second Brain can do and which page documents each part
- [How it works](how-it-works.md): capture, the brain store, dream, delivery to sessions, the life of a rule
- [Dream](dream.md): the daily pass, its owner, how it starts, the dream agent and drafts
- [Brain store](brain-store.md): where records live, syncing between machines, the readable pages, what the store protects
- [Topics](topics.md): one readable page per area of work, and how to take it back
- [Architecture](architecture.md): the core and the runtime adapters
- [The original idea](idea.md): the historical starting point, kept as written

## Operate

- [CLI reference](cli-reference.md): every `o2b` verb, flag and exit code, and every path by which data leaves the machine
- [MCP reference](mcp.md): the MCP servers, tools, profiles and resources
- [Decision models](decision-models.md): the optional judgment model, its privacy and cost limit
- [Decision-model providers](decision-models/providers.md): every route a decision request can take and what it sends
- Decision-model uses, one page each: [answerable](decision-models/answerable.md), [dedup and tension](decision-models/dedup-tension.md), [extract pre-filter](decision-models/extract-prefilter.md), [labels](decision-models/labels.md), [recall-inject filter](decision-models/recall-inject.md), [skill selection](decision-models/skills.md), [topics and agent context](decision-models/topics-and-agent-context.md)
- [Observability](observability.md): what Open Second Brain records about its own work, and where
- [Metrics](metrics.md): the run-level numbers each pass reports
- [Ingest manifest](ingest-manifest.md): the record of each ingested source
- [Digest delivery for Hermes](hermes-cron.md): an optional schedule that sends the digest

## Upgrade

- [Updating](updating.md): the upgrade from 1.x to 2.0 and the notes of earlier releases
- [Stability policy](stability.md): what a version number promises
- [Changelog](../CHANGELOG.md): every release

## Contribute

- [Agent and contributor guide](../CLAUDE.md): versioning, plugin mirrors, test shards, git hooks
- [Releasing](releasing.md): how a release is published
- [Security policy](../SECURITY.md): how to report a vulnerability
