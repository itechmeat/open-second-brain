/**
 * One declaration per fact about an agent runtime this build installs into.
 *
 * Before this module the same host was described in four places that never
 * met: the adapter knew its config path, `src/mcp/profiles.ts` knew which
 * tool surfaces exist, `src/core/brain/sessions/` knew how to parse a
 * transcript, and `src/core/discipline/transcripts/` knew where the
 * transcripts were. Nothing joined them, so "which runtime, with which
 * ceiling, storing sessions where, in a format we can read" had no answer
 * that was not four greps.
 *
 * Three rules the rows are written under:
 *
 *   - **`unknown` is not `unbounded`.** A host whose per-workspace tool
 *     limit nobody has published gets {@link TOOL_CEILING_KIND.unknown}
 *     and a reason. It never gets a number, and it never gets read as
 *     "no limit" - that collapse is a misleading default one layer above
 *     the fail-open profile selection this substrate exists to inform.
 *   - **A fact carries its citation.** `source` says where a limit is
 *     published; `reason` says why there is no answer. A row nobody can
 *     source does not get written.
 *   - **Nothing here reads the machine.** Roots are pure functions of an
 *     injected {@link HostContext}, exactly as `InstallEnv` already
 *     supplies home and environment, so one row answers for the machine
 *     this process runs on and for one it does not.
 *
 * This is a LEAF module: it imports the session-adapter vocabulary and
 * nothing else. `src/core/install/` reads it; importing anything from
 * there back into here would close a cycle
 * `tests/core/architecture/import-cycles.test.ts` gates.
 */

import { join } from "node:path";

import {
  SESSION_ADAPTER_ID,
  SESSION_FILE_EXTENSION,
  type SessionAdapterId,
} from "../brain/sessions/types.ts";

// ---------- The target vocabulary ----------

/**
 * The runtimes `o2b install --target` can name.
 *
 * Closed, because it is what a raw argv value is validated against: a
 * target that arrives as a string is either one of these or a typo, and
 * {@link isInstallTargetId} is the boundary between the two. Membership
 * is one adapter registration each - `tests/core/architecture/
 * host-facts-census.test.ts` derives the live population from the
 * registry and requires the two sets to be equal in both directions, so
 * a member here with no adapter fails as loudly as an adapter with no
 * member.
 */
export const INSTALL_TARGET_ID = Object.freeze({
  aider: "aider",
  codex: "codex",
  copilotCli: "copilot-cli",
  cursor: "cursor",
  geminiCli: "gemini-cli",
  generic: "generic",
  grok: "grok",
  kiro: "kiro",
  opencode: "opencode",
  pi: "pi",
} as const);

export type InstallTargetId = (typeof INSTALL_TARGET_ID)[keyof typeof INSTALL_TARGET_ID];

/** The installable targets, in registration order. */
export const INSTALL_TARGET_IDS: ReadonlyArray<InstallTargetId> = Object.freeze([
  INSTALL_TARGET_ID.aider,
  INSTALL_TARGET_ID.codex,
  INSTALL_TARGET_ID.copilotCli,
  INSTALL_TARGET_ID.cursor,
  INSTALL_TARGET_ID.geminiCli,
  INSTALL_TARGET_ID.generic,
  INSTALL_TARGET_ID.grok,
  INSTALL_TARGET_ID.kiro,
  INSTALL_TARGET_ID.opencode,
  INSTALL_TARGET_ID.pi,
]);

export function isInstallTargetId(value: unknown): value is InstallTargetId {
  return typeof value === "string" && (INSTALL_TARGET_IDS as ReadonlyArray<string>).includes(value);
}

// ---------- The tool ceiling ----------

/**
 * What this build can say about one host's per-workspace MCP tool limit.
 *
 * `unbounded` is the member no row uses today, and it is not speculative
 * padding: without it, a host that documents "no limit" would have to be
 * recorded as unchecked, which is the same lie in the other direction.
 */
export const TOOL_CEILING_KIND = Object.freeze({
  declared: "declared",
  unbounded: "unbounded",
  unknown: "unknown",
} as const);

export type ToolCeilingKind = (typeof TOOL_CEILING_KIND)[keyof typeof TOOL_CEILING_KIND];

/** The ceiling kinds, most specific first. */
export const TOOL_CEILING_KINDS: ReadonlyArray<ToolCeilingKind> = Object.freeze([
  TOOL_CEILING_KIND.declared,
  TOOL_CEILING_KIND.unbounded,
  TOOL_CEILING_KIND.unknown,
]);

export function isToolCeilingKind(value: unknown): value is ToolCeilingKind {
  return typeof value === "string" && (TOOL_CEILING_KINDS as ReadonlyArray<string>).includes(value);
}

/** The host publishes a limit, and this is it. */
export interface DeclaredToolCeiling {
  readonly kind: typeof TOOL_CEILING_KIND.declared;
  /** Tools the host will hand the model. A positive integer. */
  readonly maxTools: number;
  /** Where that number is published. */
  readonly source: string;
}

/** The host publishes that there is no limit. */
export interface UnboundedToolCeiling {
  readonly kind: typeof TOOL_CEILING_KIND.unbounded;
  /** Where the absence of a limit is published. */
  readonly source: string;
}

/** Nobody has established a limit for this host. Never read as a number. */
export interface UnknownToolCeiling {
  readonly kind: typeof TOOL_CEILING_KIND.unknown;
  /** Why there is no answer, specific to this host. */
  readonly reason: string;
}

export type ToolCeiling = DeclaredToolCeiling | UnboundedToolCeiling | UnknownToolCeiling;

// ---------- Session roots ----------

/**
 * The machine a question is being asked about.
 *
 * Both fields are supplied by the caller for the same reason `InstallEnv`
 * supplies them: a root derived from the ambient process is a root only
 * this process can compute, and the install, doctor and discovery
 * surfaces all already carry an injected home and environment.
 */
export interface HostContext {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The runtimes whose session logs this build can LOCATE.
 *
 * Deliberately not {@link InstallTargetId} and deliberately not
 * {@link SessionAdapterId}, because it is neither set:
 *
 *   - Claude Code is here and is not an install target. Open Second Brain
 *     reaches it as a plugin rather than through `o2b install --target`,
 *     yet `~/.claude/projects` is the largest transcript store on a
 *     typical machine, and a discovery sweep that skipped it would miss
 *     most of what it exists to find.
 *   - Cursor is here and has no session adapter. Its `state.vscdb` is
 *     locatable and unreadable by anything in `src/core/brain/sessions/`,
 *     which is a coverage answer worth printing rather than a runtime
 *     worth omitting.
 *   - Hermes is a {@link SessionAdapterId} and is NOT here: this build
 *     ships a parser for its format and knows no path at which that
 *     format is written, so a root would be an invention.
 *
 * Closed and guarded because the value round-trips through disk: the
 * import ledger records which runtime each imported log came from, and a
 * ledger written by another release is a string until the guard says
 * otherwise.
 */
export const SESSION_RUNTIME_ID = Object.freeze({
  claudeCode: "claude-code",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
} as const);

export type SessionRuntimeId = (typeof SESSION_RUNTIME_ID)[keyof typeof SESSION_RUNTIME_ID];

/** The session runtimes, in the order a coverage report prints them. */
export const SESSION_RUNTIME_IDS: ReadonlyArray<SessionRuntimeId> = Object.freeze([
  SESSION_RUNTIME_ID.claudeCode,
  SESSION_RUNTIME_ID.codex,
  SESSION_RUNTIME_ID.cursor,
  SESSION_RUNTIME_ID.grok,
  SESSION_RUNTIME_ID.opencode,
]);

export function isSessionRuntimeId(value: unknown): value is SessionRuntimeId {
  return (
    typeof value === "string" && (SESSION_RUNTIME_IDS as ReadonlyArray<string>).includes(value)
  );
}

/** Where one runtime keeps session logs, and what they are. */
export interface SessionRootSpec {
  /** Stable slug, unique within its row; the handle a report prints. */
  readonly id: string;
  /** Absolute root, derived from the injected home and environment. */
  resolve(ctx: HostContext): string;
  /** Which files under the root are session logs, relative to it. */
  readonly glob: string;
  /**
   * The adapter that parses them, or `null` when none ships. `null` is a
   * stated answer: Cursor's transcripts are readable, just not by
   * anything in `src/core/brain/sessions/`.
   */
  readonly adapter: SessionAdapterId | null;
  /** The on-disk format, named even where no adapter reads it. */
  readonly format: string;
}

/** One {@link SessionRootSpec} against a concrete host. */
export interface ResolvedSessionRoot {
  readonly id: string;
  readonly path: string;
  readonly glob: string;
  readonly adapter: SessionAdapterId | null;
  readonly format: string;
}

// ---------- Host probes ----------

/**
 * A command that can be asked about this runtime's own registration.
 *
 * Declared rather than performed: what is MEASURED and what is DECLARED
 * stay separate columns, so a caller that cannot spawn a subprocess
 * reports a named skip instead of an assumed answer.
 */
export interface HostProbeSpec {
  /** Binary name, resolved on PATH by whoever runs it. */
  readonly bin: string;
  /** Argv after the binary. */
  readonly argv: ReadonlyArray<string>;
  /** What a successful run establishes. */
  readonly answers: string;
}

// ---------- The rows ----------

/** Everything this build knows about one agent runtime. */
export interface RuntimeFacts {
  readonly target: InstallTargetId;
  /** Human-readable name, matching the adapter's own label. */
  readonly label: string;
  readonly toolCeiling: ToolCeiling;
  /**
   * A `TOOL_SURFACE_PROFILES` key, or `null` where no profile is declared.
   *
   * Typed `string` rather than a key type on purpose. This module is a
   * leaf and `TOOL_SURFACE_PROFILES` lives in `src/mcp/`, so importing it
   * would risk the cycle the docblock names - and it buys nothing anyway:
   * that table is annotated `Readonly<Record<string, ToolSurfaceProfile>>`,
   * so its `keyof` IS `string`. `tests/core/runtime/host-facts.test.ts`
   * is what holds the reference, by resolving every value against the
   * real table.
   */
  readonly toolProfile: string | null;
  /** The adapter that parses this runtime's transcripts, or `null`. */
  readonly sessionAdapter: SessionAdapterId | null;
  /**
   * Which {@link SESSION_ROOTS} entry this target's logs are, or `null`
   * where it writes none.
   *
   * Declared rather than derived from the target id. Four of the five
   * session runtimes happen to spell their id the same as their install
   * target, and a join built on that coincidence would silently break the
   * first time one of them did not - the two vocabularies are different
   * sets on purpose, and Claude Code is already a member of one and not
   * the other.
   */
  readonly sessionRuntime: SessionRuntimeId | null;
  readonly sessionRoots: ReadonlyArray<SessionRootSpec>;
  readonly hostProbe: HostProbeSpec | null;
}

/** `env[key]` when it holds something, else `fallback`. */
function envOr(ctx: HostContext, key: string, fallback: string): string {
  const value = ctx.env[key];
  return value !== undefined && value.length > 0 ? value : fallback;
}

/** Cursor keeps per-workspace chat state in a SQLite file, not a log. */
const CURSOR_STATE_FORMAT = "cursor-state-vscdb";
/** One `state.vscdb` per workspace hash directory under the root. */
const CURSOR_STATE_GLOB = "*/state.vscdb";

/**
 * The three layouts Cursor builds have used, already probed by
 * `src/core/discipline/transcripts/cursor.ts`. Declared here so the two
 * subsystems stop knowing different halves of one fact.
 */
const CURSOR_SESSION_ROOTS: ReadonlyArray<SessionRootSpec> = Object.freeze([
  Object.freeze({
    id: "cursor-workspace-storage-linux",
    resolve: (ctx: HostContext) => join(ctx.home, ".config", "Cursor", "User", "workspaceStorage"),
    glob: CURSOR_STATE_GLOB,
    adapter: null,
    format: CURSOR_STATE_FORMAT,
  }),
  Object.freeze({
    id: "cursor-workspace-storage-macos",
    resolve: (ctx: HostContext) =>
      join(ctx.home, "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
    glob: CURSOR_STATE_GLOB,
    adapter: null,
    format: CURSOR_STATE_FORMAT,
  }),
  Object.freeze({
    id: "cursor-workspace-storage-dot-cursor",
    resolve: (ctx: HostContext) => join(ctx.home, ".cursor", "workspaceStorage"),
    glob: CURSOR_STATE_GLOB,
    adapter: null,
    format: CURSOR_STATE_FORMAT,
  }),
]);

/**
 * The subdirectories of the Codex home that have held session files.
 *
 * Not invented here: `src/core/discipline/transcripts/codex.ts` already
 * walks exactly these four, three levels deep, because the Codex CLI has
 * moved its transcripts between releases. Declaring the same four keeps
 * the two subsystems from knowing different halves of one fact.
 */
const CODEX_SESSION_SUBDIRS: ReadonlyArray<string> = Object.freeze([
  "sessions",
  "session",
  "history",
  ".tmp",
]);

/**
 * What a Codex transcript file is called, stated with its uncertainty.
 *
 * The two consumers disagree and nothing on the machine this row was
 * written on could settle it: the discipline scanner counts `*.json`,
 * while `src/core/brain/sessions/codex.ts` parses the `.jsonl` rollout
 * line schema, and no session directory existed under the Codex home to
 * measure. The glob used to cover both extensions rather than pick the
 * one that would silently find nothing - but "find" was the wrong word
 * for what covering both bought. A `.json` this build enrols is one no
 * shipped adapter can read, so it is discovered as a GAP, fails
 * `DETECT_FAIL` on import, and drives `--discover --all` to exit 1; and
 * `sessionFilesUnder` never accepted it, so `import-session <dir>` and
 * `export --transcripts <dir>` skipped every one of them in silence.
 * Three definitions of "what a session log is", of which only
 * {@link SESSION_FILE_EXTENSION} matched what the adapters parse. The
 * format label keeps its name: the uncertainty about what Codex writes is
 * real, and it is this build's READER that is narrow.
 */
const CODEX_SESSION_FORMAT = "codex-rollout-json-or-jsonl";
const CODEX_SESSION_GLOB = `**/*${SESSION_FILE_EXTENSION}`;

/** Codex keeps per-session files under `$CODEX_HOME` (default `~/.codex`). */
const CODEX_SESSION_ROOTS: ReadonlyArray<SessionRootSpec> = Object.freeze(
  CODEX_SESSION_SUBDIRS.map((sub) =>
    Object.freeze({
      // `.tmp` would give an id starting with a dot; strip it so the
      // handle a report prints reads as a slug.
      id: `codex-${sub.replace(/^\./, "")}`,
      resolve: (ctx: HostContext) => join(codexHome(ctx), sub),
      glob: CODEX_SESSION_GLOB,
      adapter: SESSION_ADAPTER_ID.codex,
      format: CODEX_SESSION_FORMAT,
    }),
  ),
);

/**
 * `$CODEX_HOME` when the operator set one, else `~/.codex`.
 *
 * Exported because the Codex adapter resolves the same directory for its
 * `config.toml` and for the `CODEX_HOME` it injects into the CLI. It had
 * its own copy, in a module pair whose whole thesis is that a fact about a
 * host has one home - so a relocation rule fixed in one and not the other
 * would put the session roots and the configuration on different disks.
 */
export function codexHome(ctx: HostContext): string {
  return envOr(ctx, "CODEX_HOME", join(ctx.home, ".codex"));
}

/** Grok persists one ACP update stream per session, per encoded cwd. */
const GROK_SESSION_ROOTS: ReadonlyArray<SessionRootSpec> = Object.freeze([
  Object.freeze({
    id: "grok-sessions",
    resolve: (ctx: HostContext) =>
      join(envOr(ctx, "GROK_HOME", join(ctx.home, ".grok")), "sessions"),
    glob: "*/*/updates.jsonl",
    adapter: SESSION_ADAPTER_ID.grok,
    format: "grok-acp-session-update-jsonl",
  }),
]);

/** The spool the bundled opencode plugin writes; a format this tool owns. */
const OPENCODE_SESSION_ROOTS: ReadonlyArray<SessionRootSpec> = Object.freeze([
  Object.freeze({
    id: "opencode-session-spool",
    resolve: (ctx: HostContext) =>
      envOr(
        ctx,
        "OSB_OPENCODE_SPOOL_DIR",
        join(
          envOr(ctx, "XDG_DATA_HOME", join(ctx.home, ".local", "share")),
          "open-second-brain",
          "opencode",
        ),
      ),
    glob: "*.jsonl",
    adapter: SESSION_ADAPTER_ID.opencode,
    format: "open-second-brain-opencode-spool-jsonl",
  }),
]);

/**
 * Claude Code keeps one `.jsonl` per session under a per-project
 * directory whose name is the encoded working directory.
 *
 * Already walked by `src/core/discipline/transcripts/claude-code.ts` and
 * by `src/core/brain/claude-memory-paths.ts`; declared here so the two
 * subsystems stop knowing different halves of one fact.
 */
const CLAUDE_CODE_SESSION_ROOTS: ReadonlyArray<SessionRootSpec> = Object.freeze([
  Object.freeze({
    id: "claude-code-projects",
    resolve: (ctx: HostContext) => join(ctx.home, ".claude", "projects"),
    glob: "*/*.jsonl",
    adapter: SESSION_ADAPTER_ID.claude,
    format: "claude-code-transcript-jsonl",
  }),
]);

/** No transcripts, no roots: an empty list is the stated answer. */
const NO_SESSION_ROOTS: ReadonlyArray<SessionRootSpec> = Object.freeze([]);

/**
 * Where every runtime this build can locate keeps its session logs.
 *
 * The ONE declaration. Both consumers read it: the discovery sweep
 * (`src/core/brain/sessions/discover.ts`), which asks whether a file was
 * ever imported, and the discipline transcript scanner
 * (`src/core/discipline/transcripts/`), which asks whether a file was
 * touched inside a day window. Two questions, one input, and before this
 * table each carried its own copy of where that input lives - so
 * relocating a runtime moved one consumer and not the other.
 */
export const SESSION_ROOTS: Readonly<Record<SessionRuntimeId, ReadonlyArray<SessionRootSpec>>> =
  Object.freeze({
    [SESSION_RUNTIME_ID.claudeCode]: CLAUDE_CODE_SESSION_ROOTS,
    [SESSION_RUNTIME_ID.codex]: CODEX_SESSION_ROOTS,
    [SESSION_RUNTIME_ID.cursor]: CURSOR_SESSION_ROOTS,
    [SESSION_RUNTIME_ID.grok]: GROK_SESSION_ROOTS,
    [SESSION_RUNTIME_ID.opencode]: OPENCODE_SESSION_ROOTS,
  });

/**
 * What this build knows about each runtime it installs into.
 *
 * Total over {@link InstallTargetId}, and the census next to it is what
 * keeps it total: a new adapter without a row here fails before it ships.
 */
export const RUNTIME_FACTS: Readonly<Record<InstallTargetId, RuntimeFacts>> = Object.freeze({
  [INSTALL_TARGET_ID.aider]: Object.freeze({
    target: INSTALL_TARGET_ID.aider,
    label: "Aider",
    toolCeiling: Object.freeze({
      kind: TOOL_CEILING_KIND.unknown,
      reason:
        "Aider is wired through a managed block in its YAML config and a sidecar context file, " +
        "not an MCP server, so there is no per-workspace tool surface whose limit could be cited.",
    }),
    toolProfile: null,
    sessionAdapter: null,
    sessionRuntime: null,
    sessionRoots: NO_SESSION_ROOTS,
    hostProbe: null,
  }),
  [INSTALL_TARGET_ID.codex]: Object.freeze({
    target: INSTALL_TARGET_ID.codex,
    label: "Codex CLI",
    toolCeiling: Object.freeze({
      kind: TOOL_CEILING_KIND.unknown,
      reason:
        "Codex publishes no per-workspace MCP tool limit; `codex mcp list --json` reports each " +
        "server's transport, startup and tool TIMEOUTS and auth status, and nothing in that " +
        "record - or in this tree - is a tool-count cap.",
    }),
    toolProfile: null,
    sessionAdapter: SESSION_ADAPTER_ID.codex,
    sessionRuntime: SESSION_RUNTIME_ID.codex,
    sessionRoots: SESSION_ROOTS[SESSION_RUNTIME_ID.codex],
    // `mcp list` and NOT `mcp list --json`: the shared probe reads the
    // first column of each output line, which is the name column here.
    // Under `--json` the name arrives as `"name": "open-second-brain"`,
    // whose first token is `"name":`, so a JSON probe would report every
    // host as having nothing registered - a false negative dressed as an
    // answer, which is the exact failure `host-probe.ts` exists to refuse.
    hostProbe: Object.freeze({
      bin: "codex",
      argv: Object.freeze(["mcp", "list"]),
      answers:
        "whether this host has the Open Second Brain servers registered, read from the host " +
        "itself rather than from the `config.toml` section the adapter writes.",
    }),
  }),
  [INSTALL_TARGET_ID.copilotCli]: Object.freeze({
    target: INSTALL_TARGET_ID.copilotCli,
    label: "GitHub Copilot CLI",
    toolCeiling: Object.freeze({
      kind: TOOL_CEILING_KIND.unknown,
      reason:
        "GitHub Copilot CLI publishes no per-workspace MCP tool limit; `copilot mcp list` " +
        "reports which servers are registered, which is a different question.",
    }),
    toolProfile: null,
    sessionAdapter: null,
    sessionRuntime: null,
    sessionRoots: NO_SESSION_ROOTS,
    hostProbe: Object.freeze({
      bin: "copilot",
      argv: Object.freeze(["mcp", "list"]),
      answers:
        "whether this host has the Open Second Brain servers registered, read from the host " +
        "itself rather than inferred from the config file the adapter writes.",
    }),
  }),
  [INSTALL_TARGET_ID.cursor]: Object.freeze({
    target: INSTALL_TARGET_ID.cursor,
    label: "Cursor",
    toolCeiling: Object.freeze({
      kind: TOOL_CEILING_KIND.declared,
      maxTools: 40,
      source:
        "Cursor's published MCP limit: a workspace sends at most the first 40 tools across all " +
        "enabled MCP servers to the model, and the rest are unreachable.",
    }),
    // The two-pass surface advertises 7 tools and keeps every registered
    // verb reachable through `tool_hydrate`, so the ceiling is respected
    // without any verb being withheld.
    toolProfile: "catalog",
    sessionAdapter: null,
    sessionRuntime: SESSION_RUNTIME_ID.cursor,
    sessionRoots: SESSION_ROOTS[SESSION_RUNTIME_ID.cursor],
    hostProbe: null,
  }),
  [INSTALL_TARGET_ID.geminiCli]: Object.freeze({
    target: INSTALL_TARGET_ID.geminiCli,
    label: "Google Gemini CLI",
    toolCeiling: Object.freeze({
      kind: TOOL_CEILING_KIND.unknown,
      reason:
        "Google Gemini CLI publishes no per-workspace MCP tool limit; nothing in this tree has " +
        "measured one either.",
    }),
    toolProfile: null,
    sessionAdapter: null,
    sessionRuntime: null,
    sessionRoots: NO_SESSION_ROOTS,
    hostProbe: null,
  }),
  [INSTALL_TARGET_ID.generic]: Object.freeze({
    target: INSTALL_TARGET_ID.generic,
    label: "Generic (printout)",
    toolCeiling: Object.freeze({
      kind: TOOL_CEILING_KIND.unknown,
      reason:
        "the generic target prints a payload for a host it was never told the name of, so there " +
        "is no host whose published limit could be cited.",
    }),
    toolProfile: null,
    sessionAdapter: null,
    sessionRuntime: null,
    sessionRoots: NO_SESSION_ROOTS,
    hostProbe: null,
  }),
  [INSTALL_TARGET_ID.grok]: Object.freeze({
    target: INSTALL_TARGET_ID.grok,
    label: "Grok Build",
    toolCeiling: Object.freeze({
      kind: TOOL_CEILING_KIND.unknown,
      reason:
        "Grok Build publishes no per-session MCP tool limit; nothing in this tree has measured " +
        "one either.",
    }),
    toolProfile: null,
    sessionAdapter: SESSION_ADAPTER_ID.grok,
    sessionRuntime: SESSION_RUNTIME_ID.grok,
    sessionRoots: SESSION_ROOTS[SESSION_RUNTIME_ID.grok],
    hostProbe: null,
  }),
  [INSTALL_TARGET_ID.kiro]: Object.freeze({
    target: INSTALL_TARGET_ID.kiro,
    label: "kiro",
    toolCeiling: Object.freeze({
      kind: TOOL_CEILING_KIND.unknown,
      reason:
        "Kiro publishes no per-workspace MCP tool limit; nothing in this tree has measured one " +
        "either.",
    }),
    toolProfile: null,
    sessionAdapter: null,
    sessionRuntime: null,
    sessionRoots: NO_SESSION_ROOTS,
    hostProbe: null,
  }),
  [INSTALL_TARGET_ID.opencode]: Object.freeze({
    target: INSTALL_TARGET_ID.opencode,
    label: "opencode",
    toolCeiling: Object.freeze({
      kind: TOOL_CEILING_KIND.unknown,
      reason:
        "opencode publishes no per-session MCP tool limit; nothing in this tree has measured one " +
        "either.",
    }),
    toolProfile: null,
    sessionAdapter: SESSION_ADAPTER_ID.opencode,
    sessionRuntime: SESSION_RUNTIME_ID.opencode,
    sessionRoots: SESSION_ROOTS[SESSION_RUNTIME_ID.opencode],
    hostProbe: null,
  }),
  [INSTALL_TARGET_ID.pi]: Object.freeze({
    target: INSTALL_TARGET_ID.pi,
    label: "Pi (pi.dev)",
    toolCeiling: Object.freeze({
      kind: TOOL_CEILING_KIND.unknown,
      reason:
        "Pi is installed as a skill symlink rather than an MCP server, so there is no tool " +
        "surface on this host whose limit could be cited.",
    }),
    toolProfile: null,
    sessionAdapter: null,
    sessionRuntime: null,
    sessionRoots: NO_SESSION_ROOTS,
    hostProbe: null,
  }),
});

// ---------- Accessors ----------

/** The row for `target`. Total: every member of the vocabulary has one. */
export function runtimeFactsFor(target: InstallTargetId): RuntimeFacts {
  return RUNTIME_FACTS[target];
}

/** One declared root against one concrete host. */
function resolveRoot(root: SessionRootSpec, ctx: HostContext): ResolvedSessionRoot {
  return {
    id: root.id,
    path: root.resolve(ctx),
    glob: root.glob,
    adapter: root.adapter,
    format: root.format,
  };
}

/** `target`'s session roots against one concrete host, in declared order. */
export function resolveSessionRoots(
  target: InstallTargetId,
  ctx: HostContext,
): ReadonlyArray<ResolvedSessionRoot> {
  return RUNTIME_FACTS[target].sessionRoots.map((root) => resolveRoot(root, ctx));
}

/**
 * `runtime`'s session roots against one concrete host, in declared order.
 *
 * The runtime-keyed sibling of {@link resolveSessionRoots}, and the one
 * the two sweeps use: neither of them starts from an install target, and
 * Claude Code has no install target to start from.
 */
export function resolveSessionRootsFor(
  runtime: SessionRuntimeId,
  ctx: HostContext,
): ReadonlyArray<ResolvedSessionRoot> {
  return SESSION_ROOTS[runtime].map((root) => resolveRoot(root, ctx));
}
