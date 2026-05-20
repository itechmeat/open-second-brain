/**
 * Shared types for the multi-runtime install orchestrator (v0.10.11).
 *
 * One `InstallAdapter` interface drives `o2b install`, `o2b uninstall`,
 * `o2b install --check`, and `o2b init --interactive`. Per-runtime
 * adapters live in `./adapters/<name>.ts` and each register
 * themselves into the default registry on import.
 *
 * See `docs/plans/2026-05-20-multi-runtime-install-design.md` §2.2 for
 * field semantics.
 */

// ---------- Constant sets (runtime checkable) ----------

export const ADAPTER_STATUSES = new Set([
  "not-installed",
  "installed",
  "drift",
  "unsupported-on-this-platform",
] as const);
export type AdapterStatus = typeof ADAPTER_STATUSES extends Set<infer U> ? U : never;

export const INSTALL_STEP_KINDS = new Set([
  "json-merge",
  "managed-block",
  "subprocess",
  "file-copy",
  "symlink",
  "print",
] as const);
export type InstallStepKind = typeof INSTALL_STEP_KINDS extends Set<infer U> ? U : never;

export const VERIFY_STATUSES = new Set([
  "ok",
  "drift",
  "not-installed",
  "mcp-unreachable",
] as const);
export type VerifyStatus = typeof VERIFY_STATUSES extends Set<infer U> ? U : never;

// ---------- MCP payload (canonical entries that adapters write) ----------

export interface McpServerEntry {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpPayload {
  readonly full: McpServerEntry;
  readonly writer: McpServerEntry;
}

// ---------- Adapter call surface ----------

export interface InstallEnv {
  readonly vault: string;
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly now: Date;
}

export interface DetectResult {
  readonly target: string;
  readonly status: AdapterStatus;
  readonly configPath: string | null;
  readonly notes: ReadonlyArray<string>;
}

export interface InstallStep {
  readonly kind: InstallStepKind;
  readonly path: string | null;
  readonly preview: string;
}

export interface InstallPlan {
  readonly target: string;
  readonly steps: ReadonlyArray<InstallStep>;
  readonly postNotes: ReadonlyArray<string>;
}

export interface ApplyOpts {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly stdout: NodeJS.WriteStream | NodeJS.WritableStream;
  readonly stderr: NodeJS.WriteStream | NodeJS.WritableStream;
  /** Generic adapter: output file path. "-" or undefined → stdout. */
  readonly outPath?: string;
  /** Generic adapter: render format. Default "json". */
  readonly format?: "json" | "yaml";
  /** Pi adapter: override `~/.pi/skills/` location. */
  readonly piSkillDir?: string;
  /** Pi adapter: override the source skill directory used as symlink target. */
  readonly piSkillSource?: string;
  /** Aider adapter: override the generated context file path. */
  readonly aiderContextPath?: string;
}

export interface ManifestEntry {
  readonly target: string;
  readonly applied_at: string;
  readonly operation: InstallStepKind;
  readonly config_path: string | null;
  readonly owned_keys?: ReadonlyArray<string>;
  readonly owned_paths?: ReadonlyArray<string>;
  readonly owned_block_marker?: string;
  readonly fallback_file?: string | null;
  /** SHA-256 of the last applied MCP payload (update orchestrator). */
  readonly payload_hash?: string;
}

export interface ApplyResult {
  readonly target: string;
  readonly manifest: ManifestEntry;
  readonly steps_executed: number;
}

export interface UninstallResult {
  readonly target: string;
  readonly removed_keys: ReadonlyArray<string>;
  readonly removed_paths: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<readonly [string, string]>;
}

export interface VerifyResult {
  readonly target: string;
  readonly status: VerifyStatus;
  readonly details: ReadonlyArray<string>;
  readonly fix_hint: string | null;
}

export interface SessionPathsResult {
  readonly target: string;
  readonly paths: ReadonlyArray<string>;
  readonly format: "claude-jsonl" | "codex-json" | "cursor-sqlite" | "unknown";
}

export interface InstallAdapter {
  readonly target: string;
  readonly label: string;
  detect(env: InstallEnv): DetectResult;
  plan(payload: McpPayload, env: InstallEnv): InstallPlan;
  apply(plan: InstallPlan, payload: McpPayload, env: InstallEnv, opts: ApplyOpts): ApplyResult;
  uninstall(env: InstallEnv, opts: ApplyOpts & { fromSnippet?: boolean }): UninstallResult;
  verify(env: InstallEnv): VerifyResult;
  sessionPaths?(env: InstallEnv): SessionPathsResult | null;
}

// ---------- Errors ----------

export class InstallError extends Error {
  constructor(
    message: string,
    public readonly target: string,
    public readonly kind:
      | "manifest-missing"
      | "user-modified-block"
      | "config-parse"
      | "subprocess-failed"
      | "config-missing"
      | "platform-unsupported"
      | "other",
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "InstallError";
  }
}
