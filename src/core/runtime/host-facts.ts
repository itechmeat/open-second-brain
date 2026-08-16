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

import { SESSION_ADAPTER_ID, type SessionAdapterId } from "../brain/sessions/types.ts";

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

/** No transcripts, no roots: an empty list is the stated answer. */
const NO_SESSION_ROOTS: ReadonlyArray<SessionRootSpec> = Object.freeze([]);

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
    sessionRoots: NO_SESSION_ROOTS,
    hostProbe: null,
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
    sessionRoots: CURSOR_SESSION_ROOTS,
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
    sessionRoots: GROK_SESSION_ROOTS,
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
    sessionRoots: OPENCODE_SESSION_ROOTS,
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
    sessionRoots: NO_SESSION_ROOTS,
    hostProbe: null,
  }),
});

// ---------- Accessors ----------

/** The row for `target`. Total: every member of the vocabulary has one. */
export function runtimeFactsFor(target: InstallTargetId): RuntimeFacts {
  return RUNTIME_FACTS[target];
}

/** `target`'s session roots against one concrete host, in declared order. */
export function resolveSessionRoots(
  target: InstallTargetId,
  ctx: HostContext,
): ReadonlyArray<ResolvedSessionRoot> {
  return RUNTIME_FACTS[target].sessionRoots.map((root) => ({
    id: root.id,
    path: root.resolve(ctx),
    glob: root.glob,
    adapter: root.adapter,
    format: root.format,
  }));
}
