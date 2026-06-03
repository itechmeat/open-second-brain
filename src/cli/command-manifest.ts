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
      "brain",
      "Brain memory verbs",
      [],
      [
        command("init", "Bootstrap Brain skeleton"),
        command("feedback", "Record a taste signal"),
        command("dream", "Run deterministic consolidation"),
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
        command("watchdog", "Probe Brain recovery status"),
        command("health", "Render semantic Brain health"),
        command("history", "Render preference edit history"),
        command("audit", "Render mutation audit trail"),
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
        command("import-session", "Replay registered agent sessions"),
        command("handoff", "Write an operator-readable session handoff note"),
        command("intention", "Manage scoped current-intention chains"),
        command("project", "Link project directories to their owning vault"),
        command("source", "Manage read-only recall sources of the active vault"),
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
    command("init-pay-memory", "Bootstrap Pay Memory folders"),
    command("append-payment-receipt", "Save a payment receipt"),
    command("capture-asset", "Save an asset note"),
    command("payment-report", "Aggregate payment receipts"),
    command("check-payment-policy", "Evaluate paid-call policy"),
    command("request-payment-approval", "Create payment approval request"),
    command("approve-payment-request", "Approve payment request"),
    command("reject-payment-request", "Reject payment request"),
    command("consume-payment-request", "Consume approved payment request"),
    command("list-pending-payments", "List payment requests"),
    command("payment-digest", "Render payment digest"),
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
