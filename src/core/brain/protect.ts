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
 *   - **claudecode** — patches `<vault>/.claude/settings.json` with a
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
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { escapeRegex } from "../strings.ts";
import { brainConfigPath, brainDirs } from "./paths.ts";

/** Bumped on any structural change to manifest / fence layout. */
export const PROTECT_SCHEMA_VERSION = 1;

export const PROTECT_TARGETS = ["claudecode", "codex"] as const;
export type ProtectTarget = (typeof PROTECT_TARGETS)[number];

export function isProtectTarget(value: string | undefined): value is ProtectTarget {
  return (
    typeof value === "string"
    && (PROTECT_TARGETS as readonly string[]).includes(value)
  );
}

export class BrainProtectError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(message: string, info: { code: string; detail?: unknown } = { code: "BRAIN_PROTECT" }) {
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
}

export interface UnprotectOptions {
  readonly target: ProtectTarget;
  readonly vault: string;
  readonly __homeOverride?: string;
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
 * the projected `<vault>/.claude/settings.json` permissions block; the
 * `manifest` is the authoritative record of which entries OSB owns,
 * persisted separately so `unprotect` can remove exactly those without
 * touching user-authored rules.
 */
export function renderClaudeCode(
  rules: ReadonlyArray<ProtectRule>,
  vault: string = inferVault(rules),
): ClaudeCodeRender {
  const deny = rules
    .filter((r) => r.kind === "deny")
    .map((r) => `${r.action}(${r.path})`);
  const allow = rules
    .filter((r) => r.kind === "allow")
    .map((r) => `${r.action}(${r.path})`);
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

function inferVault(rules: ReadonlyArray<ProtectRule>): string {
  const first = rules[0];
  if (!first) {
    throw new BrainProtectError(
      "renderClaudeCode requires at least one rule to infer the vault",
      { code: "EMPTY_RULES" },
    );
  }
  return first.path.split("/Brain/")[0]!;
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

function renderCodexEntries(
  entries: ReadonlyArray<CodexFilesystemEntry>,
): CodexRender {
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
    parsed === null
    || typeof parsed !== "object"
    || !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new BrainProtectError(
      `manifest at ${path} missing 'entries' array`,
      { code: "MANIFEST_MALFORMED" },
    );
  }
  return parsed as ManifestFile;
}

export function readManifest(
  vault: string,
  target: ProtectTarget,
): ManifestRecord | null {
  const path = manifestPath(vault);
  if (!existsSync(path)) return null;
  const file = parseManifestFile(readFileSync(path, "utf8"), path);
  const entry = file.entries.find((e) => e.target === target);
  if (entry === undefined) return null;
  if (entry.schema_version > PROTECT_SCHEMA_VERSION) {
    throw new BrainProtectError(
      `manifest schema_version ${entry.schema_version} is newer than `
        + `this binary (${PROTECT_SCHEMA_VERSION}); update o2b first`,
      { code: "MANIFEST_NEWER_SCHEMA" },
    );
  }
  return entry;
}

export function writeManifest(vault: string, entry: ManifestRecord): void {
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

export function removeManifestEntry(
  vault: string,
  target: ProtectTarget,
): void {
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
  if (!existsSync(join(vault, "Brain"))) {
    throw new BrainProtectError(
      `vault at ${vault} has no Brain/ directory; run \`o2b brain init\` first`,
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
      return applyClaudeCode(opts.vault);
    case "codex":
      return applyCodex(opts.vault, opts.__homeOverride);
  }
}

export function unprotect(opts: UnprotectOptions): void {
  switch (opts.target) {
    case "claudecode":
      return unprotectClaudeCode(opts.vault);
    case "codex":
      return unprotectCodex(opts.vault, opts.__homeOverride);
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

function applyClaudeCode(vault: string): ApplyResult {
  ensureVaultBootstrapped(vault);
  const rules = buildProtectRules(vault);
  const rendered = renderClaudeCode(rules, vault);
  const settingsDir = join(vault, ".claude");
  const dest = join(settingsDir, "settings.json");
  mkdirSync(settingsDir, { recursive: true });

  const prev = readManifest(vault, "claudecode") as
    | ManifestRecordClaudeCode
    | null;
  const { raw: before, parsed: settings } = readSettingsJson(dest);

  settings.permissions ??= {};
  settings.permissions.deny ??= [];
  settings.permissions.allow ??= [];

  // Remove prior OSB-owned entries so the result is independent of
  // history (idempotency under repeated `--apply`).
  const priorDeny = prev?.owned_deny ?? [];
  const priorAllow = prev?.owned_allow ?? [];
  settings.permissions.deny = settings.permissions.deny.filter(
    (e) => !priorDeny.includes(e),
  );
  settings.permissions.allow = settings.permissions.allow.filter(
    (e) => !priorAllow.includes(e),
  );

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
  const changed = after !== before;
  let backupPath = "";
  if (changed && before !== "") {
    backupPath = `${dest}.bak.${Date.now()}`;
    atomicWriteFileSync(backupPath, before);
  }
  if (changed) atomicWriteFileSync(dest, after);
  writeManifestIfChanged(vault, rendered.manifest);
  return Object.freeze({
    target: "claudecode" as const,
    destination: dest,
    backupPath,
    changed,
  });
}

function unprotectClaudeCode(vault: string): void {
  const dest = join(vault, ".claude", "settings.json");
  const prev = readManifest(vault, "claudecode") as
    | ManifestRecordClaudeCode
    | null;
  if (prev === null || !existsSync(dest)) {
    removeManifestEntry(vault, "claudecode");
    return;
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
  atomicWriteFileSync(dest, JSON.stringify(settings, null, 2) + "\n");
  removeManifestEntry(vault, "claudecode");
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
        `codex managed block schema_version ${version} is newer than `
          + `this binary (${PROTECT_SCHEMA_VERSION}); update o2b first`,
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
    throw new BrainProtectError(
      "codex managed block contains an invalid quoted filesystem path",
      { code: "CODEX_FENCE_MALFORMED" },
    );
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

function applyCodex(vault: string, homeOverride?: string): ApplyResult {
  ensureVaultBootstrapped(vault);
  const dest = codexConfigPath(homeOverride);
  mkdirSync(join(dest, ".."), { recursive: true });

  const before = readFileOrEmpty(dest);
  const rules = buildProtectRules(vault);
  const currentEntries = codexEntriesFromRules(rules);
  const currentPaths = new Set(currentEntries.map((e) => e.path));
  const keptEntries = parseCodexFence(before).filter(
    (e) => !currentPaths.has(e.path),
  );
  const fence = renderCodexEntries([...keptEntries, ...currentEntries]).body;
  const after = replaceCodexFence(before, fence);
  const changed = after !== before;
  let backupPath = "";
  if (changed && before !== "") {
    backupPath = `${dest}.bak.${Date.now()}`;
    atomicWriteFileSync(backupPath, before);
  }
  if (changed) atomicWriteFileSync(dest, after);
  writeManifestIfChanged(vault, {
    schema_version: PROTECT_SCHEMA_VERSION,
    target: "codex",
    vault,
  });
  return Object.freeze({
    target: "codex" as const,
    destination: dest,
    backupPath,
    changed,
  });
}

function unprotectCodex(vault: string, homeOverride?: string): void {
  const dest = codexConfigPath(homeOverride);
  if (existsSync(dest)) {
    const raw = readFileSync(dest, "utf8");
    const currentPaths = new Set(
      codexEntriesFromRules(buildProtectRules(vault)).map((e) => e.path),
    );
    const remaining = parseCodexFence(raw).filter(
      (e) => !currentPaths.has(e.path),
    );
    const after = replaceCodexFence(
      raw,
      remaining.length > 0 ? renderCodexEntries(remaining).body : null,
    );
    if (after !== raw) atomicWriteFileSync(dest, after);
  }
  removeManifestEntry(vault, "codex");
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
