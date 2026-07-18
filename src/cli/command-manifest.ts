export interface CliFlagManifest {
  readonly name: string;
  readonly type: "boolean" | "string" | "string-array";
  readonly inherited?: boolean;
}

export interface CliCommandManifest {
  readonly name: string;
  readonly summary: string;
  readonly flags?: ReadonlyArray<CliFlagManifest>;
  readonly commands?: ReadonlyArray<CliCommandManifest>;
}

export interface CliRootManifest {
  readonly command: "o2b";
  readonly flags: ReadonlyArray<CliFlagManifest>;
  readonly commands: ReadonlyArray<CliCommandManifest>;
}

export const INHERITED_JSON_FLAG: CliFlagManifest = Object.freeze({
  name: "json",
  type: "boolean",
  inherited: true,
});

export const CLI_COMMAND_MANIFEST: CliRootManifest = Object.freeze({
  command: "o2b",
  flags: [INHERITED_JSON_FLAG],
  commands: [
    command("status", "Show Open Second Brain configuration status", [
      flag("config", "string"),
      flag("vault", "string"),
    ]),
    command("init", "Initialize a vault profile", [
      flag("vault", "string"),
      flag("name", "string"),
      flag("agent-name", "string"),
      flag("timezone", "string"),
      flag("force", "boolean"),
      flag("interactive", "boolean"),
    ]),
    command("doctor", "Run health checks on vault, config, and plugins", [
      flag("vault", "string"),
      flag("config", "string"),
      flag("repo", "string"),
    ]),
    command("onboarding", "Show the guided first-run setup checklist", [
      flag("vault", "string"),
      flag("config", "string"),
    ]),
    command("export-config", "Write a redacted config snapshot", [
      flag("config", "string"),
      flag("output", "string"),
    ]),
    command("index", "Regenerate the vault index from discovered pages", [flag("vault", "string")]),
    command("mcp", "Run the optional MCP tool server", [
      flag("vault", "string"),
      flag("config", "string"),
      flag("repo", "string"),
      flag("scope", "string"),
      flag("writer-only", "boolean"),
      flag("tool-profile", "string"),
      flag("probe", "boolean"),
      flag("allow-tool", "string-array"),
      flag("disable-tool", "string-array"),
      flag("max-tools", "string"),
    ]),
    command("help", "Print command help or the command manifest"),
    command("completions", "Print shell completion script for o2b", [flag("shell", "string")]),
    command("install-cli", "Create symlinks for o2b and vault-log"),
    command("install", "Multi-runtime install orchestrator"),
    command("update", "Update Open Second Brain across detected runtimes", [
      flag("target", "string"),
      flag("dry-run", "boolean"),
      flag("force", "boolean"),
    ]),
    command("uninstall", "Print or apply an uninstall plan", [
      flag("config", "string"),
      flag("apply-local", "boolean"),
      flag("remove-cli", "boolean"),
      flag("target", "string"),
    ]),
    command("tool-call", "Invoke an MCP tool handler from the CLI", [
      flag("vault", "string"),
      flag("tool-arg", "string-array"),
    ]),
    command(
      "aider",
      "Session-bracketing memory wrapper for Aider",
      [],
      [
        command("wrap", "Run Aider bracketed with live memory load + write-back", [
          flag("session-id", "string"),
          flag("aider-bin", "string"),
          flag("chat-history", "string"),
          flag("vault", "string"),
          flag("config", "string"),
        ]),
      ],
    ),
    command(
      "brain",
      "Brain memory verbs",
      [],
      [
        command("init", "Bootstrap Brain skeleton"),
        command("feedback", "Record a taste signal"),
        command(
          "dream",
          "Run deterministic consolidation; staged lifecycle via stage/validate/apply",
        ),
        command("apply-evidence", "Record preference evidence"),
        command("note", "Append a narrative milestone"),
        command("digest", "Render recent Brain transitions"),
        command("intent-review", "Review signal clusters before dream"),
        command("retention", "Review retired preference retention"),
        command("monthly", "Render month-level Brain synthesis"),
        command("query", "Read preferences, topics, and logs"),
        command("agent-query", "Read source-agent provenance"),
        command("agent-diff", "Compare source-agent coverage"),
        command("reject", "Retire a preference"),
        command("merge", "Merge duplicate preferences"),
        command("pin", "Pin a preference"),
        command("unpin", "Unpin a preference"),
        command("set-primary", "Set primary Brain agent"),
        command("protect", "Emit runtime deny rules for Brain"),
        command("unprotect", "Remove managed runtime deny rules"),
        command("snapshot", "Inspect Brain snapshots"),
        command("rollback", "Restore Brain from a snapshot"),
        command("upgrade", "Migrate release-owned Brain files"),
        command("export", "Export active preferences"),
        command("explorer", "Open or export Brain graph explorer"),
        command("doctor", "Check Brain invariants"),
        command("status", "Unified operator status snapshot with next-command hints", [
          flag("vault", "string"),
          flag("json", "boolean"),
        ]),
        command("hygiene", "Hygiene pipeline: scan findings, apply remediation plan"),
        command("refresh", "Targeted recompile of stale derived pages"),
        command("anticipate", "Inspect or refresh the anticipatory context cache"),
        command("watchdog", "Probe Brain recovery status"),
        command("health", "Render semantic Brain health"),
        command("history", "Render preference edit history"),
        command("activation", "Activation event store: status and sweep"),
        command("truth", "Claim ledger: slots, conflicts, aggregate, collisions"),
        command("facts", "Decompose text into atomic assertions"),
        command("dead-end", "Record or list failed approaches"),
        command("foresight", "Render forward-looking projection"),
        command("label", "Assign, remove, or show controlled-vocabulary labels"),
        command("attr", "Assign, remove, or show typed-page attribute fields"),
        command("tiers", "Check, restore, or accept identity-field drift"),
        command("secret", "Capability-gated secret custody: set, list, rm, run"),
        command("maintenance", "Quiet-window, lease-guarded heavy maintenance lane"),
        command("audit", "Render mutation audit trail"),
        command(
          "generation-reports",
          "Record/list/summarize opt-in inbound LLM generation traces",
          [],
          [
            command("record", "Record one gated inbound generation report"),
            command("list", "List generation report records"),
            command("summary", "Summarize generation usage with memory linkage"),
            command("show", "Show one generation report record"),
          ],
        ),
        command("morning-brief", "Render session-start summary"),
        command("codec", "Compress or expand session prose"),
        command("sources", "Show signal source dashboard"),
        command(
          "schema",
          "Inspect Brain schema vocabulary",
          [flag("vault", "string")],
          [
            command("report", "Inspect Brain schema vocabulary", [flag("vault", "string")]),
            command("stats", "Summarise Brain schema vocabulary", [flag("vault", "string")]),
            command("lint", "Lint Brain schema vocabulary", [flag("vault", "string")]),
            command("graph", "Render Brain schema graph", [flag("vault", "string")]),
            command("explain", "Explain a Brain schema token", [flag("vault", "string")]),
            command("orphans", "Review unused Brain schema declarations", [
              flag("vault", "string"),
            ]),
            command("apply", "Apply audited Brain schema mutations", [
              flag("vault", "string"),
              flag("mutation", "string-array"),
              flag("actor", "string"),
              flag("reason", "string"),
            ]),
            command("sync", "Preview Brain schema sync", [
              flag("vault", "string"),
              flag("dry-run", "boolean"),
              flag("batch-size", "string"),
            ]),
          ],
        ),
        command("graph-export", "Export vault graph"),
        command("graph-import", "Import vault graph stubs"),
        command("backlinks", "List inbound Brain references"),
        command("semantics-backfill", "Preview Brain semantics backfill"),
        command("mcp-landscape", "List MCP servers configured across the vault"),
        command("scan-inline", "Capture inline @osb markers"),
        command("scan-citations", "Promote inline [Source: ...] citations to dated events", [
          flag("vault", "string"),
          flag("dry-run", "boolean"),
          flag("strict", "boolean"),
          flag("path", "string-array"),
          flag("exclude", "string-array"),
          flag("agent", "string"),
          flag("json", "boolean"),
        ]),
        command("import-session", "Replay registered agent sessions"),
        command("handoff", "Write an operator-readable session handoff note"),
        command("intention", "Manage scoped current-intention chains"),
        command("project", "Link project directories to their owning vault"),
        command("source", "Manage read-only recall sources of the active vault"),
        command(
          "forget-source",
          "Find and delete entries derived from an exact source file (dry-run by default)",
          [
            flag("vault", "string"),
            flag("confirm", "boolean"),
            flag("include-originals", "boolean"),
            flag("json", "boolean"),
          ],
        ),
        command(
          "batch-plan",
          "Plan a large-folder ingest into bounded parallel batches (skips unchanged sources)",
          [
            flag("vault", "string"),
            flag("max-bytes", "string"),
            flag("max-files", "string"),
            flag("reconcile", "boolean"),
            flag("json", "boolean"),
          ],
        ),
        command(
          "pre-extract",
          "Extract deterministic code structure (classes/functions/imports/inheritance) from a source file as JSON seeds",
          [flag("json", "boolean")],
        ),
        command("links", "Normalize wikilink path format across Brain notes"),
        command("bridges", "Propose, accept, or dismiss embedding-near bridge links"),
        command("clusters", "Detect link-graph communities and materialize cluster notes"),
        command(
          "co-occurrence",
          "Suggest edges between entities co-referenced from the same notes",
        ),
        command("file-context", "Surface prior vault work that mentions a file path"),
        command("benchmark", "Score recall quality against a fixed query dataset"),
        command("tune", "Grid-evaluate and persist self-tuning recall parameters"),
        command("profile", "Materialize the compact Brain/profile.md digest"),
        command("sgrep", "Grep-shaped semantic Brain search (path:line: output)"),
        command("continuity", "Export continuity records as ATOF/ATIF trajectories"),
        command("bench", "Memory quality benchmark over a disposable fixture vault"),
        command("git", "Git history as project memory: ingest, status, find, mine"),
        command("architect", "Deterministic architecture notes for a code project"),
        command(
          "session",
          "Agent write sessions: open, submit, approve, abandon, status, list, sweep",
        ),
        command("panel", "Multi-persona decision panel riding the write-session kernel"),
        command("trigger", "Grounded proactive trigger queue (scan/list/ack/dismiss/act/history)"),
        command("deep-synthesis", "Topic dossier: agreements, contradictions, stale claims, gaps"),
        command("ideas", "Ranked next-direction candidates from open loops"),
        command("entity", "Canonical entity registry: set, get, list, relate, archive"),
        command("session-hook", "Capture runtime lifecycle hook payloads"),
        command("import-claude-memory", "Import Claude memory feedback"),
      ],
    ),
    command(
      "search",
      "Search the vault index",
      [],
      [
        command("query", "Search the vault index"),
        command("index", "Incrementally update the search index"),
        command("reindex", "Rebuild the search index"),
        command("watch", "Watch the vault and incrementally sync the index on .md edits"),
        command("status", "Print search index status"),
        command("check", "Run search pre-flight diagnostics"),
        command("provider", "Manage embedding provider profiles"),
      ],
    ),
    command(
      "vault",
      "Vault scope and profile verbs",
      [],
      [
        command("status", "Show vault policy walk summary"),
        command("inspect", "Inspect one vault-relative path"),
        command("profile", "Manage named vault profiles"),
        command("map", "Print vault-map role tokens"),
      ],
    ),
    command(
      "discipline",
      "Daily logging discipline verbs",
      [],
      [
        command("report", "Render discipline report"),
        command("install", "Install discipline cron"),
        command("uninstall", "Remove discipline cron"),
      ],
    ),
  ],
});

export function manifestForJson(): CliRootManifest {
  return addInheritedFlags(CLI_COMMAND_MANIFEST);
}

export function commandNames(manifest: CliRootManifest = CLI_COMMAND_MANIFEST): string[] {
  return manifest.commands.map((item) => item.name);
}

export function nestedCommandNames(parent: string): string[] {
  const node = CLI_COMMAND_MANIFEST.commands.find((item) => item.name === parent);
  return node?.commands?.map((item) => item.name) ?? [];
}

export function allFlagNames(manifest: CliRootManifest = manifestForJson()): string[] {
  const names = new Set<string>();
  for (const flagSpec of manifest.flags) names.add(flagSpec.name);
  const visit = (items: ReadonlyArray<CliCommandManifest>): void => {
    for (const item of items) {
      for (const flagSpec of item.flags ?? []) names.add(flagSpec.name);
      if (item.commands) visit(item.commands);
    }
  };
  visit(manifest.commands);
  return [...names].toSorted();
}

function command(
  name: string,
  summary: string,
  flags: ReadonlyArray<CliFlagManifest> = [],
  commands: ReadonlyArray<CliCommandManifest> = [],
): CliCommandManifest {
  return Object.freeze({
    name,
    summary,
    ...(flags.length > 0 ? { flags } : {}),
    ...(commands.length > 0 ? { commands } : {}),
  });
}

function flag(name: string, type: CliFlagManifest["type"]): CliFlagManifest {
  return Object.freeze({ name, type });
}

function addInheritedFlags(root: CliRootManifest): CliRootManifest {
  return {
    ...root,
    commands: root.commands.map((item) => addInheritedFlagsToCommand(item)),
  };
}

function addInheritedFlagsToCommand(commandSpec: CliCommandManifest): CliCommandManifest {
  const ownFlags = commandSpec.flags ?? [];
  const hasJson = ownFlags.some((item) => item.name === INHERITED_JSON_FLAG.name);
  return {
    ...commandSpec,
    flags: hasJson ? ownFlags : [...ownFlags, INHERITED_JSON_FLAG],
    ...(commandSpec.commands
      ? {
          commands: commandSpec.commands.map((item) => addInheritedFlagsToCommand(item)),
        }
      : {}),
  };
}
