/**
 * §18 of the OSB features summary — machine-enforced write protection
 * for the `Brain/` subtree against the two runtimes whose native
 * config supports path-level deny / allow rules.
 *
 * Protected paths (vault-relative):
 *   - `Brain/preferences/**`  — deny Write / Edit
 *   - `Brain/retired/**`      — deny Write / Edit
 *   - `Brain/log/**`          — deny Write / Edit
 *   - `Brain/.snapshots/**`   — deny Write / Edit
 *   - `Brain/_brain.yaml`     — deny Write / Edit
 *   - `Brain/inbox/**`        — explicit allow Write (the agent
 *     legitimately drops signals here through `brain_feedback`)
 *
 * Targets:
 *   - **claudecode** — patches the vault's Claude Code settings file with a
 *     `permissions.deny` / `permissions.allow` array, tracking
 *     OSB-owned entries through a sidecar manifest at
 *     `<vault>/.open-second-brain/protect.lock.json`.
 *   - **codex** — patches `~/.codex/config.toml` with a managed
 *     fence (`# >>> open-second-brain managed >>>` ... `# <<<`)
 *     containing `[permissions.osb_protected.filesystem]` plus
 *     `default_permissions = "osb_protected"`.
 *
 * Both targets are fully idempotent: a second `applyProtect` on the
 * same state is a byte-identical no-op, and `unprotect` removes
 * exactly the entries the matching `applyProtect` added.
 *
 * Guarded-host-write convention (t_b6bcd984): every rewrite of a host
 * settings file - apply and unprotect alike - backs the current content
 * up FIRST (exclusive create, private `0600`, laddered name, never an
 * overwrite), and the CLI verbs above this module run the fail-closed
 * consent ladder before calling it. The unprotect deletion set comes
 * from the in-vault manifest, which an agent can write; the consent
 * step above (the operator saw the diff and said yes) is what makes
 * applying it legitimate.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
  isFileAlreadyExists,
} from "../fs-atomic.ts";
import { escapeRegex } from "../strings.ts";
import { BRAIN_ROOT_REL, brainConfigPath, brainDirs, collisionCandidateName } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** Bumped on any structural change to manifest / fence layout. */
export const PROTECT_SCHEMA_VERSION = 1;

export const PROTECT_TARGETS = ["claudecode", "codex"] as const;
export type ProtectTarget = (typeof PROTECT_TARGETS)[number];

export function isProtectTarget(value: string | undefined): value is ProtectTarget {
  return typeof value === "string" && (PROTECT_TARGETS as readonly string[]).includes(value);
}

export class BrainProtectError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(
    message: string,
    info: { code: string; detail?: unknown } = { code: "BRAIN_PROTECT" },
  ) {
    super(message);
    this.name = "BrainProtectError";
    this.code = info.code;
    if (info.detail !== undefined) this.detail = info.detail;
  }
}

export interface ProtectRule {
  readonly kind: "deny" | "allow";
  readonly action: "Write" | "Edit";
  readonly path: string;
}

export interface RenderedSnippet {
  readonly target: ProtectTarget;
  readonly body: string;
  readonly destination: string;
}

export interface ApplyResult {
  readonly target: ProtectTarget;
  readonly destination: string;
  /** Empty string when no backup was written (no prior content to save). */
  readonly backupPath: string;
  readonly changed: boolean;
}

export interface ApplyOptions {
  readonly target: ProtectTarget;
  readonly vault: string;
  /** Test seam: override `$HOME` when resolving the Codex config path. */
  readonly __homeOverride?: string;
  /**
   * The preview the consent ladder showed (t_b6bcd984). When present, the
   * write must still derive exactly these before/after bytes - the target
   * file or the manifest this change reads having moved since the preview
   * is a typed refusal, never a write of something else. The consent
   * ladder always passes it; it is optional so a caller that has not
   * previewed stays type-correct.
   */
  readonly approved?: ProtectCompute;
}

export interface UnprotectOptions {
  readonly target: ProtectTarget;
  readonly vault: string;
  readonly __homeOverride?: string;
  /** The approved preview, pinned exactly as on {@link ApplyOptions}. */
  readonly approved?: ProtectCompute;
}

// ─── Pure rule set (no IO) ────────────────────────────────────────────

/**
 * Pure vault-to-rules helper. The protected paths are derived from
 * {@link brainDirs} and {@link brainConfigPath} so the protect rules
 * stay in lockstep with the canonical Brain layout — if the layout
 * ever moves, the rules follow without a parallel edit.
 *
 * The order of returned rules is stable — consumers (renderers,
 * manifest) rely on it to keep output reproducible across runs on
 * the same vault.
 */
export function buildProtectRules(vault: string): ReadonlyArray<ProtectRule> {
  const dirs = brainDirs(vault);
  const denyPaths = [
    `${toPosix(dirs.preferences)}/**`,
    `${toPosix(dirs.retired)}/**`,
    `${toPosix(dirs.log)}/**`,
    `${toPosix(dirs.snapshots)}/**`,
    toPosix(brainConfigPath(vault)),
  ];
  const allowPaths = [`${toPosix(dirs.inbox)}/**`];

  const rules: ProtectRule[] = [];
  for (const path of denyPaths) {
    for (const action of ["Write", "Edit"] as const) {
      rules.push({ kind: "deny", action, path });
    }
  }
  for (const path of allowPaths) {
    rules.push({ kind: "allow", action: "Write", path });
  }
  return Object.freeze(rules);
}

/**
 * Convert native separators to forward slashes. Both Claude Code and
 * Codex permission matchers expect POSIX paths even on Windows;
 * `brainDirs` returns paths joined with the native separator.
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

// ─── Claude Code rendering ────────────────────────────────────────────

export interface ClaudeCodeRender {
  readonly snippet: {
    permissions: { deny: string[]; allow: string[] };
  };
  readonly manifest: ManifestRecordClaudeCode;
}

/**
 * Render rules into the Claude Code shape. The `snippet` shape mirrors
 * the projected permissions block of the vault's Claude Code settings file; the
 * `manifest` is the authoritative record of which entries OSB owns,
 * persisted separately so `unprotect` can remove exactly those without
 * touching user-authored rules.
 */
export function renderClaudeCode(
  rules: ReadonlyArray<ProtectRule>,
  vault: string = inferVault(rules),
  platform: NodeJS.Platform = process.platform,
): ClaudeCodeRender {
  const entry = (r: ProtectRule): string => `${r.action}(${claudeCodeRulePath(r.path, platform)})`;
  const deny = rules.filter((r) => r.kind === "deny").map(entry);
  const allow = rules.filter((r) => r.kind === "allow").map(entry);
  return Object.freeze({
    snippet: { permissions: { deny, allow } },
    manifest: {
      schema_version: PROTECT_SCHEMA_VERSION,
      target: "claudecode" as const,
      vault,
      owned_deny: deny,
      owned_allow: allow,
    },
  });
}

/**
 * Spell an absolute forward-slash path the way a Claude Code
 * Read/Edit/Write permission rule names a filesystem-absolute location.
 * The rule syntax is gitignore-style with its own anchors: `//path` is
 * absolute from the filesystem root, while a single leading `/` anchors
 * at the settings source (the project root for `.claude/settings.json`),
 * so `/home/me/vault/Brain/**` would silently match
 * `<project>/home/me/vault/Brain/**` and protect nothing. On Windows the
 * matcher first normalises the path to POSIX form, `C:\Users\alice`
 * becoming `/c/Users/alice`, so a drive path is written `//c/Users/...`
 * with the letter lower-cased. `platform` is a test seam.
 */
export function claudeCodeRulePath(
  absPosixPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const drive = /^([A-Za-z]):\/(.*)$/.exec(absPosixPath);
    if (drive) return `//${drive[1]!.toLowerCase()}/${drive[2]}`;
  }
  // Already filesystem-absolute (`//x`, a UNC-shaped path): keep as is.
  if (absPosixPath.startsWith("//")) return absPosixPath;
  return absPosixPath.startsWith("/") ? `/${absPosixPath}` : absPosixPath;
}

function inferVault(rules: ReadonlyArray<ProtectRule>): string {
  const first = rules[0];
  if (!first) {
    throw new BrainProtectError("renderClaudeCode requires at least one rule to infer the vault", {
      code: "EMPTY_RULES",
    });
  }
  return first.path.split(`/${BRAIN_ROOT_REL}/`)[0]!;
}

// ─── Codex rendering ──────────────────────────────────────────────────

const FENCE_OPEN = "# >>> open-second-brain managed >>>";
const FENCE_CLOSE = "# <<< open-second-brain managed <<<";

export interface CodexRender {
  readonly body: string;
}

interface CodexFilesystemEntry {
  readonly path: string;
  readonly permission: "none" | "write";
}

/**
 * Render rules into the Codex shape. The body is a self-contained
 * managed block — including the `[permissions.osb_protected.filesystem]`
 * table and `default_permissions = "osb_protected"` — wrapped in the
 * line-comment fence used by `applyCodex` / `unprotectCodex` to locate
 * the block on subsequent runs.
 */
export function renderCodex(rules: ReadonlyArray<ProtectRule>): CodexRender {
  return renderCodexEntries(codexEntriesFromRules(rules));
}

function renderCodexEntries(entries: ReadonlyArray<CodexFilesystemEntry>): CodexRender {
  const lines: string[] = [
    FENCE_OPEN,
    `# schema_version = ${PROTECT_SCHEMA_VERSION}`,
    `default_permissions = "osb_protected"`,
    "",
    "[permissions.osb_protected.filesystem]",
  ];
  for (const entry of entries) {
    lines.push(`${tomlString(entry.path)} = "${entry.permission}"`);
  }
  lines.push(FENCE_CLOSE);
  return Object.freeze({ body: lines.join("\n") + "\n" });
}

function codexEntriesFromRules(
  rules: ReadonlyArray<ProtectRule>,
): ReadonlyArray<CodexFilesystemEntry> {
  const entries: CodexFilesystemEntry[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    entries.push({
      path: r.path,
      permission: r.kind === "deny" ? "none" : "write",
    });
  }
  return Object.freeze(entries);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

// ─── Manifest (sidecar truth for what OSB owns) ───────────────────────

const MANIFEST_DIR = ".open-second-brain";
const MANIFEST_FILE = "protect.lock.json";

interface ManifestRecordClaudeCode {
  readonly schema_version: number;
  readonly target: "claudecode";
  readonly vault: string;
  readonly owned_deny: ReadonlyArray<string>;
  readonly owned_allow: ReadonlyArray<string>;
}

interface ManifestRecordCodex {
  readonly schema_version: number;
  readonly target: "codex";
  readonly vault: string;
  /**
   * Vault-relative POSIX paths OSB owns inside the Codex fence. Kept
   * separately from {@link buildProtectRules} so `unprotect` (and the
   * apply-time stale-purge step) can remove exactly what a prior
   * version added, even if the rule set drifts between releases. A
   * v0.10.4 vault that upgrades to v0.10.5 with renamed sub-paths
   * still finds its old entries via this list instead of leaking
   * stale OSB permissions.
   */
  readonly owned_paths: ReadonlyArray<string>;
}

export type ManifestRecord = ManifestRecordClaudeCode | ManifestRecordCodex;

interface ManifestFile {
  entries: ManifestRecord[];
}

function manifestPath(vault: string): string {
  return join(vault, MANIFEST_DIR, MANIFEST_FILE);
}

function parseManifestFile(raw: string, path: string): ManifestFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BrainProtectError(`malformed manifest at ${path}`, {
      code: "MANIFEST_MALFORMED",
      detail: err,
    });
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new BrainProtectError(`manifest at ${path} missing 'entries' array`, {
      code: "MANIFEST_MALFORMED",
    });
  }
  return parsed as ManifestFile;
}

export function readManifest(vault: string, target: ProtectTarget): ManifestRecord | null {
  const path = manifestPath(vault);
  if (!existsSync(path)) return null;
  const file = parseManifestFile(readFileSync(path, "utf8"), path);
  const entry = file.entries.find((e) => e.target === target);
  if (entry === undefined) return null;
  if (entry.schema_version > PROTECT_SCHEMA_VERSION) {
    throw new BrainProtectError(
      `manifest schema_version ${entry.schema_version} is newer than ` +
        `this binary (${PROTECT_SCHEMA_VERSION}); update o2b first`,
      { code: "MANIFEST_NEWER_SCHEMA" },
    );
  }
  return entry;
}

export function writeManifest(vault: string, entry: ManifestRecord): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const path = manifestPath(vault);
  mkdirSync(join(vault, MANIFEST_DIR), { recursive: true });
  const file: ManifestFile = existsSync(path)
    ? parseManifestFile(readFileSync(path, "utf8"), path)
    : { entries: [] };
  const others = file.entries.filter((e) => e.target !== entry.target);
  const next: ManifestFile = { entries: [...others, entry] };
  atomicWriteFileSync(path, JSON.stringify(next, null, 2) + "\n");
}

/**
 * Idempotent variant of {@link writeManifest}: skips the write when
 * the existing manifest entry is deep-equal to the new one. Avoids a
 * spurious file rewrite on a no-op `applyProtect` call.
 */
function writeManifestIfChanged(vault: string, entry: ManifestRecord): void {
  const existing = readManifest(vault, entry.target);
  if (existing !== null && manifestEntriesEqual(existing, entry)) return;
  writeManifest(vault, entry);
}

function manifestEntriesEqual(a: ManifestRecord, b: ManifestRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Read a file as UTF-8, returning the empty string when it does not
 * exist. Avoids the `existsSync(p) ? readFileSync(p) : ""` TOCTOU
 * pattern — one syscall on the happy path, and a race-free fallback
 * on ENOENT.
 */
function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

// ─── The protect lane's own backup-then-write ─────────────────────────

/**
 * Bound on distinct backup-file names one `Date.now()` stamp tries
 * (`<dest>.bak.<ms>`, `-2`, ... via {@link collisionCandidateName}).
 * Exhaustion is a typed error, never an overwrite.
 */
export const PROTECT_BACKUP_MAX_ATTEMPTS = 128;

/**
 * Back `before` up beside `dest` before a protect/unprotect rewrite
 * lands. Exclusive create, private `0600` (settings backups carry
 * secrets), same-millisecond collisions ladder the name, and an
 * exhausted ladder is a typed refusal rather than a silent overwrite -
 * the same treatment the PreToolUse host-backup executor gives its
 * copies.
 */
function backupHostFile(dest: string, before: string): string {
  const base = `${dest}.bak.${Date.now()}`;
  for (let attempt = 1; attempt <= PROTECT_BACKUP_MAX_ATTEMPTS; attempt++) {
    const candidate = collisionCandidateName(base, attempt);
    try {
      atomicCreateFileSyncExclusive(candidate, before, { mode: 0o600 });
      return candidate;
    } catch (err) {
      if (!isFileAlreadyExists(err)) throw err;
    }
  }
  throw new BrainProtectError(
    `protect backup allocation exhausted for ${dest} ` +
      `(${PROTECT_BACKUP_MAX_ATTEMPTS} candidates taken); refusing to overwrite`,
    { code: "BACKUP_ALLOC_EXHAUSTED" },
  );
}

export function removeManifestEntry(vault: string, target: ProtectTarget): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const path = manifestPath(vault);
  if (!existsSync(path)) return;
  const file = parseManifestFile(readFileSync(path, "utf8"), path);
  const next: ManifestFile = {
    entries: file.entries.filter((e) => e.target !== target),
  };
  atomicWriteFileSync(path, JSON.stringify(next, null, 2) + "\n");
}

// ─── Apply / unprotect ────────────────────────────────────────────────

function ensureVaultBootstrapped(vault: string): void {
  if (!existsSync(join(vault, BRAIN_ROOT_REL))) {
    throw new BrainProtectError(
      `vault at ${vault} has no ${BRAIN_ROOT_REL}/ directory; run \`o2b brain init\` first`,
      { code: "VAULT_NOT_BOOTSTRAPPED" },
    );
  }
}

/**
 * Dispatch entry point. Delegates to the per-target implementation.
 * Single-decision switch on `target` so adding a new target stays a
 * one-place change (open/closed against future targets).
 */
export function applyProtect(opts: ApplyOptions): ApplyResult {
  switch (opts.target) {
    case "claudecode":
      return applyClaudeCode(opts.vault, opts.approved);
    case "codex":
      return applyCodex(opts.vault, opts.__homeOverride, opts.approved);
  }
}

/**
 * What one protect apply would change, computed without writing
 * (t_b6bcd984). The consent flow's preview step: `before` is the exact
 * on-disk content, `after` the merged result the write step would put
 * back, `changed` whether the write would happen at all. Everything the
 * consent ladder needs to show a unified diff and refuse fail-closed
 * before `applyProtect` (the write) is allowed to run.
 */
export interface ProtectCompute {
  readonly destination: string;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

/**
 * The compute half of {@link applyProtect}: same derivation, no backup,
 * no write, no manifest. Pure with respect to the target file - it
 * reads it, never mutates anything.
 */
export function computeProtect(opts: ApplyOptions): ProtectCompute {
  switch (opts.target) {
    case "claudecode":
      return computeClaudeCode(opts.vault);
    case "codex":
      return computeCodex(opts.vault, opts.__homeOverride);
  }
}

/**
 * Enforce the pin the consent ladder's approval carries (t_b6bcd984): the
 * write may land only the before/after pair the preview showed. Both
 * halves matter - a `before` that no longer matches means the target file
 * moved under the approved diff; an `after` that no longer matches means
 * the inputs this change derives from (the OSB manifest among them) moved.
 * Either way the approval no longer describes the write, so nothing is
 * written and the refusal names the re-preview remedy - the
 * `brain upgrade --approval-digest` convention, one level down.
 */
function assertApprovedUnchanged(approved: ProtectCompute, derived: ProtectCompute): void {
  if (approved.before === derived.before && approved.after === derived.after) return;
  throw new BrainProtectError(
    `refused: ${approved.destination} (or the manifest this change reads) moved since ` +
      "the consent preview; nothing was written. Re-run the verb to preview the current " +
      "change, then apply again.",
    { code: "PREVIEW_DRIFT" },
  );
}

/**
 * Land the previewed content. The compare-before-write option re-reads
 * the target right before the rename, so an edit landing after the
 * derivation above is refused rather than overwritten; an absent target
 * skips the comparison, since there is no prior content to protect
 * (`expectBefore: ""` would describe an existing empty file, not an
 * absent one).
 */
function writePreviewedHostFile(compute: ProtectCompute): void {
  if (compute.before === "" && !existsSync(compute.destination)) {
    atomicWriteFileSync(compute.destination, compute.after);
    return;
  }
  atomicWriteFileSync(compute.destination, compute.after, { expectBefore: compute.before });
}

export function unprotect(opts: UnprotectOptions): UnprotectResult {
  switch (opts.target) {
    case "claudecode":
      return unprotectClaudeCode(opts.vault, opts.approved);
    case "codex":
      return unprotectCodex(opts.vault, opts.__homeOverride, opts.approved);
  }
}

/**
 * What one unprotect did: the host file it touched, the pre-write
 * backup it took (empty when nothing changed), and whether the host
 * file moved at all. The receipt the CLI's consent ladder reports.
 */
export interface UnprotectResult {
  readonly target: ProtectTarget;
  readonly destination: string;
  /** Empty string when no backup was written (nothing changed). */
  readonly backupPath: string;
  readonly changed: boolean;
}

/**
 * What one unprotect WOULD change, computed without writing - the
 * consent preview half of {@link unprotect}, derived exactly as the
 * write derives it so the diff an operator approves is the write that
 * runs. The deletion set comes from the in-vault manifest (or the
 * current rules when no manifest exists); showing it as a before/after
 * of the host file is the trust answer to that manifest being
 * agent-writable: nothing is removed until an operator approved this
 * exact diff.
 */
export function computeUnprotect(opts: UnprotectOptions): ProtectCompute {
  switch (opts.target) {
    case "claudecode":
      return computeClaudeCodeUnprotect(opts.vault);
    case "codex":
      return computeCodexUnprotect(opts.vault, opts.__homeOverride);
  }
}

interface ClaudeSettings {
  permissions?: {
    deny?: string[];
    allow?: string[];
  };
  [k: string]: unknown;
}

function readSettingsJson(path: string): { raw: string; parsed: ClaudeSettings } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { raw: "", parsed: {} };
    }
    throw err;
  }
  let parsed: ClaudeSettings;
  try {
    parsed = raw.trim() === "" ? {} : (JSON.parse(raw) as ClaudeSettings);
  } catch (err) {
    throw new BrainProtectError(`malformed settings.json at ${path}`, {
      code: "SETTINGS_MALFORMED",
      detail: err,
    });
  }
  return { raw, parsed };
}

/**
 * One claudecode derivation: the file-level compute plus the manifest
 * record the write step stamps. One derivation so the consent preview
 * and the write cannot disagree.
 */
function deriveClaudeCode(vault: string): {
  compute: ProtectCompute;
  manifest: ReturnType<typeof renderClaudeCode>["manifest"];
} {
  ensureVaultBootstrapped(vault);
  const rules = buildProtectRules(vault);
  const rendered = renderClaudeCode(rules, vault);
  const settingsDir = join(vault, ".claude");
  const dest = join(settingsDir, "settings.json");

  const prev = readManifest(vault, "claudecode") as ManifestRecordClaudeCode | null;
  const { raw: before, parsed: settings } = readSettingsJson(dest);

  settings.permissions ??= {};
  settings.permissions.deny ??= [];
  settings.permissions.allow ??= [];

  // Remove prior OSB-owned entries so the result is independent of
  // history (idempotency under repeated `--apply`).
  const priorDeny = prev?.owned_deny ?? [];
  const priorAllow = prev?.owned_allow ?? [];
  settings.permissions.deny = settings.permissions.deny.filter((e) => !priorDeny.includes(e));
  settings.permissions.allow = settings.permissions.allow.filter((e) => !priorAllow.includes(e));

  for (const e of rendered.snippet.permissions.deny) {
    if (!settings.permissions.deny.includes(e)) {
      settings.permissions.deny.push(e);
    }
  }
  for (const e of rendered.snippet.permissions.allow) {
    if (!settings.permissions.allow.includes(e)) {
      settings.permissions.allow.push(e);
    }
  }

  const after = JSON.stringify(settings, null, 2) + "\n";
  return {
    compute: Object.freeze({
      destination: dest,
      before,
      after,
      changed: after !== before,
    }),
    manifest: rendered.manifest,
  };
}

/** The merged settings content one claudecode apply would write. */
function computeClaudeCode(vault: string): ProtectCompute {
  return deriveClaudeCode(vault).compute;
}

function applyClaudeCode(vault: string, approved?: ProtectCompute): ApplyResult {
  // Compute first (the exact derivation the consent preview showed), then
  // the write: the approved pin, backup, settings write, manifest - in
  // that order, unchanged.
  const { compute, manifest } = deriveClaudeCode(vault);
  if (approved !== undefined) assertApprovedUnchanged(approved, compute);
  const { destination: dest, before, changed } = compute;
  let backupPath = "";
  if (changed && before !== "") backupPath = backupHostFile(dest, before);
  if (changed) {
    mkdirSync(join(vault, ".claude"), { recursive: true });
    writePreviewedHostFile(compute);
  }
  writeManifestIfChanged(vault, manifest);
  return Object.freeze({
    target: "claudecode" as const,
    destination: dest,
    backupPath,
    changed,
  });
}

/**
 * One claudecode unprotect derivation, shared by the consent preview
 * and the write so the two cannot disagree.
 */
function deriveClaudeCodeUnprotect(vault: string): ProtectCompute {
  const dest = join(vault, ".claude", "settings.json");
  const prev = readManifest(vault, "claudecode") as ManifestRecordClaudeCode | null;
  const before = readFileOrEmpty(dest);
  if (prev === null || !existsSync(dest)) {
    // Nothing names an OSB-owned entry, or the file is already gone:
    // the host file is not ours to touch (the manifest bookkeeping
    // below is all that is left).
    return Object.freeze({ destination: dest, before, after: before, changed: false });
  }
  const { parsed: settings } = readSettingsJson(dest);
  if (settings.permissions?.deny !== undefined) {
    settings.permissions.deny = settings.permissions.deny.filter(
      (e) => !prev.owned_deny.includes(e),
    );
  }
  if (settings.permissions?.allow !== undefined) {
    settings.permissions.allow = settings.permissions.allow.filter(
      (e) => !prev.owned_allow.includes(e),
    );
  }
  const after = JSON.stringify(settings, null, 2) + "\n";
  return Object.freeze({ destination: dest, before, after, changed: after !== before });
}

/** The settings content one claudecode unprotect would write. */
function computeClaudeCodeUnprotect(vault: string): ProtectCompute {
  return deriveClaudeCodeUnprotect(vault);
}

function unprotectClaudeCode(vault: string, approved?: ProtectCompute): UnprotectResult {
  // The exact derivation the consent preview showed, then the approved
  // pin, backup, settings write, manifest retirement - in that order.
  const compute = deriveClaudeCodeUnprotect(vault);
  if (approved !== undefined) assertApprovedUnchanged(approved, compute);
  if (!compute.changed) {
    removeManifestEntry(vault, "claudecode");
    return Object.freeze({
      target: "claudecode" as const,
      destination: compute.destination,
      backupPath: "",
      changed: false,
    });
  }
  const backupPath = backupHostFile(compute.destination, compute.before);
  writePreviewedHostFile(compute);
  removeManifestEntry(vault, "claudecode");
  return Object.freeze({
    target: "claudecode" as const,
    destination: compute.destination,
    backupPath,
    changed: true,
  });
}

// ─── Codex apply / unprotect ──────────────────────────────────────────

function codexConfigPath(homeOverride: string | undefined): string {
  const home = homeOverride ?? homedir();
  return join(home, ".codex", "config.toml");
}

// The fence ends with its own trailing newline (renderCodex emits one),
// so we consume it inside the match. We deliberately do NOT consume the
// newline immediately before `FENCE_OPEN`: that one was either part of
// the user's content or the synthetic separator `applyCodex` inserted
// to keep the user's last line readable. Either way it belongs to the
// non-managed half of the file.
const CODEX_FENCE_RE = new RegExp(
  `${escapeRegex(FENCE_OPEN)}[\\s\\S]*?${escapeRegex(FENCE_CLOSE)}\\n?`,
  "m",
);

const CODEX_SCHEMA_RE = /#\s*schema_version\s*=\s*(\d+)/;
const CODEX_ENTRY_RE = /^\s*"((?:\\.|[^"\\])*)"\s*=\s*"(none|write)"\s*$/;

function parseCodexFence(raw: string): ReadonlyArray<CodexFilesystemEntry> {
  const match = CODEX_FENCE_RE.exec(raw);
  if (match === null) return [];
  const block = match[0];
  const schema = CODEX_SCHEMA_RE.exec(block);
  if (schema !== null) {
    const version = Number(schema[1]);
    if (Number.isFinite(version) && version > PROTECT_SCHEMA_VERSION) {
      throw new BrainProtectError(
        `codex managed block schema_version ${version} is newer than ` +
          `this binary (${PROTECT_SCHEMA_VERSION}); update o2b first`,
        { code: "CODEX_FENCE_NEWER_SCHEMA" },
      );
    }
  }

  const entries: CodexFilesystemEntry[] = [];
  const seen = new Set<string>();
  for (const line of block.split(/\r?\n/)) {
    const m = CODEX_ENTRY_RE.exec(line);
    if (m === null) continue;
    const path = parseTomlStringLiteral(m[1]!);
    if (seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, permission: m[2] as "none" | "write" });
  }
  return Object.freeze(entries);
}

function parseTomlStringLiteral(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    throw new BrainProtectError("codex managed block contains an invalid quoted filesystem path", {
      code: "CODEX_FENCE_MALFORMED",
    });
  }
}

function replaceCodexFence(raw: string, fence: string | null): string {
  const stripped = raw.replace(CODEX_FENCE_RE, "");
  if (fence === null) return stripped;
  return insertCodexFence(stripped, fence);
}

function insertCodexFence(raw: string, fence: string): string {
  const firstTable = /^[ \t]*\[[^\]\r\n]+]\s*$/m.exec(raw);
  if (firstTable === null) {
    const sep = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
    return raw + sep + fence;
  }

  const before = raw.slice(0, firstTable.index);
  const after = raw.slice(firstTable.index);
  const sep = before.length === 0 || before.endsWith("\n") ? "" : "\n";
  return before + sep + fence + after;
}

/**
 * One codex derivation: the file-level compute plus the owned paths the
 * write step stamps into the manifest. One derivation so the consent
 * preview and the write cannot disagree.
 */
function deriveCodex(
  vault: string,
  homeOverride: string | undefined,
): { compute: ProtectCompute; ownedPaths: ReadonlyArray<string> } {
  ensureVaultBootstrapped(vault);
  const dest = codexConfigPath(homeOverride);

  const before = readFileOrEmpty(dest);
  const rules = buildProtectRules(vault);
  const currentEntries = codexEntriesFromRules(rules);
  const currentPaths = new Set(currentEntries.map((e) => e.path));
  // Drop prior OSB-owned paths so an upgrade that renames or removes
  // a protected glob does not leak stale managed entries. Falls back
  // to current rules when no manifest exists yet (first apply, or a
  // pre-v0.10.4 install bootstrapped without the `owned_paths` field).
  const prev = readManifest(vault, "codex") as ManifestRecordCodex | null;
  const ownedByPrior = new Set<string>(prev?.owned_paths ?? currentPaths);
  const keptEntries = parseCodexFence(before).filter(
    (e) => !ownedByPrior.has(e.path) && !currentPaths.has(e.path),
  );
  const fence = renderCodexEntries([...keptEntries, ...currentEntries]).body;
  const after = replaceCodexFence(before, fence);
  return {
    compute: Object.freeze({
      destination: dest,
      before,
      after,
      changed: after !== before,
    }),
    ownedPaths: currentEntries.map((e) => e.path),
  };
}

/** The merged config.toml content one codex apply would write. */
function computeCodex(vault: string, homeOverride: string | undefined): ProtectCompute {
  return deriveCodex(vault, homeOverride).compute;
}

function applyCodex(vault: string, homeOverride?: string, approved?: ProtectCompute): ApplyResult {
  // Compute first (the exact derivation the consent preview showed), then
  // the write: the approved pin, backup, config write, manifest - in that
  // order, unchanged.
  const { compute, ownedPaths } = deriveCodex(vault, homeOverride);
  if (approved !== undefined) assertApprovedUnchanged(approved, compute);
  const { destination: dest, before, changed } = compute;
  let backupPath = "";
  if (changed && before !== "") backupPath = backupHostFile(dest, before);
  if (changed) {
    mkdirSync(join(dest, ".."), { recursive: true });
    writePreviewedHostFile(compute);
  }
  writeManifestIfChanged(vault, {
    schema_version: PROTECT_SCHEMA_VERSION,
    target: "codex",
    vault,
    owned_paths: ownedPaths,
  });
  return Object.freeze({
    target: "codex" as const,
    destination: dest,
    backupPath,
    changed,
  });
}

/**
 * One codex unprotect derivation, shared by the consent preview and the
 * write so the two cannot disagree.
 */
function deriveCodexUnprotect(vault: string, homeOverride: string | undefined): ProtectCompute {
  const dest = codexConfigPath(homeOverride);
  const before = readFileOrEmpty(dest);
  if (!existsSync(dest)) {
    return Object.freeze({ destination: dest, before, after: before, changed: false });
  }
  // Prefer the manifest's record of OSB-owned paths. Fall back to
  // current rules only when no manifest is on disk — that handles
  // a hand-edited fence whose manifest was deleted out-of-band.
  const prev = readManifest(vault, "codex") as ManifestRecordCodex | null;
  const ownedPaths = new Set<string>(
    prev?.owned_paths ?? codexEntriesFromRules(buildProtectRules(vault)).map((e) => e.path),
  );
  const remaining = parseCodexFence(before).filter((e) => !ownedPaths.has(e.path));
  const after = replaceCodexFence(
    before,
    remaining.length > 0 ? renderCodexEntries(remaining).body : null,
  );
  return Object.freeze({ destination: dest, before, after, changed: after !== before });
}

/** The config content one codex unprotect would write. */
function computeCodexUnprotect(vault: string, homeOverride: string | undefined): ProtectCompute {
  return deriveCodexUnprotect(vault, homeOverride);
}

function unprotectCodex(
  vault: string,
  homeOverride?: string,
  approved?: ProtectCompute,
): UnprotectResult {
  // The exact derivation the consent preview showed, then the approved
  // pin, backup and config write - in that order.
  const compute = deriveCodexUnprotect(vault, homeOverride);
  if (approved !== undefined) assertApprovedUnchanged(approved, compute);
  if (!compute.changed) {
    removeManifestEntry(vault, "codex");
    return Object.freeze({
      target: "codex" as const,
      destination: compute.destination,
      backupPath: "",
      changed: false,
    });
  }
  const backupPath = backupHostFile(compute.destination, compute.before);
  writePreviewedHostFile(compute);
  removeManifestEntry(vault, "codex");
  return Object.freeze({
    target: "codex" as const,
    destination: compute.destination,
    backupPath,
    changed: true,
  });
}

// ─── Print mode (no IO mutation) ──────────────────────────────────────

/**
 * Render a snippet for stdout. Same content as `applyProtect` would
 * inject, minus the user's existing config — so users can preview
 * before committing.
 */
export function printSnippet(opts: {
  readonly target: ProtectTarget;
  readonly vault: string;
  readonly __homeOverride?: string;
}): RenderedSnippet {
  const rules = buildProtectRules(opts.vault);
  switch (opts.target) {
    case "claudecode": {
      const r = renderClaudeCode(rules, opts.vault);
      return Object.freeze({
        target: "claudecode" as const,
        body: JSON.stringify(r.snippet, null, 2) + "\n",
        destination: join(opts.vault, ".claude", "settings.json"),
      });
    }
    case "codex": {
      const r = renderCodex(rules);
      return Object.freeze({
        target: "codex" as const,
        body: r.body,
        destination: codexConfigPath(opts.__homeOverride),
      });
    }
  }
}
