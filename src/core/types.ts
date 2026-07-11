/**
 * Shared types across the core library and the runtime adapters (CLI, MCP, OpenClaw).
 *
 * Kept in one file because they're plain data shapes — no behavior, no I/O. Splitting
 * per-module would force callers to chase imports across files for what is, in
 * effect, a single domain vocabulary.
 */

/** A configuration discovery result returned by `discoverConfig`. */
export interface ConfigDiscovery {
  readonly path: string;
  readonly exists: boolean;
  readonly data: Readonly<Record<string, string>>;
}

/** A single doctor check outcome. Mirrors Python `CheckResult` dataclass. */
export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
  /**
   * Optional copy-pasteable remediation command for a failing check, turning
   * the doctor from a diagnostic into a self-service repair tool. Present only
   * on failures with a deterministic fix; omitted on passing checks and on
   * failures with no single obvious command.
   */
  readonly fix?: string;
}

/** Outcome pair from `installCli`. */
export interface InstallResult {
  readonly bindir: string;
  readonly outcomes: ReadonlyArray<readonly [string, string]>;
  readonly errors: ReadonlyArray<string>;
}

/** Outcome pair from `uninstallCli`. */
export interface UninstallResult {
  readonly bindir: string;
  readonly outcomes: ReadonlyArray<readonly [string, string]>;
  readonly errors: ReadonlyArray<string>;
}

/** Computed plan for an `o2b uninstall` invocation. */
export interface UninstallPlan {
  readonly configPath: string;
  readonly configExists: boolean;
  readonly configDir: string;
  readonly configDirExists: boolean;
  readonly configDirEntries: ReadonlyArray<string>;
  readonly vaultPath: string | null;
  readonly applyLocal: boolean;
  readonly hermesCommands: ReadonlyArray<string>;
  readonly removedPaths: ReadonlyArray<string>;
  readonly skippedPaths: ReadonlyArray<readonly [string, string]>;
  readonly errors: ReadonlyArray<readonly [string, string]>;
}

/** Hermes-style health report shape (data-only, JSON-serializable). */
export interface HealthCheckEntry {
  readonly ok: boolean;
  readonly path: string;
  readonly message: string;
}

export interface HealthReport {
  readonly name: string;
  readonly ok: boolean;
  readonly checks: Readonly<Record<string, HealthCheckEntry>>;
}

/** Frontmatter values can be strings, numbers, booleans, or arrays of strings. */
export type FrontmatterValue = string | number | boolean | ReadonlyArray<string>;
export type FrontmatterMap = Record<string, FrontmatterValue>;

/** A discovered vault page. */
export interface VaultPage {
  readonly title: string;
  readonly path: string;
  readonly metadata: FrontmatterMap;
}
