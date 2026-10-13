/**
 * opencode adapter — JSON-merge into `~/.config/opencode/opencode.json`.
 *
 * Upstream is `anomalyco/opencode` (formerly hosted under
 * `sst/opencode`). Verified against https://opencode.ai/docs 2026-06-10:
 * MCP servers live in `opencode.json` (global copy under
 * `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/`) beneath the `mcp` key,
 * each entry shaped `{type: "local", command: [bin, ...args],
 * environment?, enabled}`. The V2 docs replace the `enabled` field with
 * `disabled`, so an entry written at the native `mcp.servers` shape
 * carries `disabled: false` and never `enabled`.
 *
 * V2 hosts read the native `mcp.servers` shape and `.jsonc` config
 * files. The choice is a property of the on-disk file, not of the
 * machine: a config that carries an `mcp.servers` object is written at
 * the native path (an existing legacy top-level declaration is never
 * shadowed), everything else keeps the V1 top-level `mcp` key. Apply
 * and verify resolve the shape through the same function, so a fresh
 * install can never report drift against itself. Files bearing JSONC
 * syntax (comments or trailing commas) are edited through the vendored
 * token-offset editor (`../jsonc.ts`) so operator comments survive
 * byte-for-byte; plain JSON at the V1 shape keeps the shared json-merge
 * body exactly as before. When only `opencode.jsonc` exists it is the
 * resolved config path; when both (or neither) exist, `opencode.json`
 * wins, so a fresh install still creates the V1 file both host
 * generations read.
 *
 * An existing healthy top-level registration is NOT migrated when
 * `mcp.servers` appears: V2 hosts keep reading a legacy declaration, so
 * migration would churn every install for zero benefit. The first
 * `--check` after such a shape change reports drift once and the first
 * re-apply is refused through the user-modified-block guard - the
 * operator forces it, and that re-apply cleans our own shadowed legacy
 * copies (never user keys) from the top-level block.
 *
 * Releases up to v1.3.0 wrote `~/.config/opencode/mcp.json` with an
 * `mcpServers` key — a file opencode never reads. `apply` migrates our
 * two keys out of that file (and deletes it when nothing else is left)
 * so stale registrations do not shadow the real one in operator
 * debugging sessions.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { createJsonMcpAdapter } from "./_json-mcp.ts";
import { payloadWithRuntimeIdentity } from "../identity.ts";
import {
  JsoncEditError,
  hasJsoncSyntax,
  parseJsoncObject,
  removeJsoncEntry,
  setJsoncEntry,
} from "../jsonc.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "../json-merge.ts";
import { recordEntry, readManifest, removeEntry } from "../manifest.ts";
import { OPENCODE_PLUGIN_FILENAME, installedPluginContent } from "../opencode-plugin-asset.ts";
import { deepJsonEquals, expectedPayloadFromEnv } from "../payload-equals.ts";
import { payloadForHost } from "../payload-host.ts";
import { handshakeNote, probeHost, probeRefutedVerdict, probeRefutes } from "../host-probe.ts";
import { defaultRegistry } from "../registry.ts";
import {
  InstallError,
  type ApplyOpts,
  type ApplyResult,
  type DetectResult,
  type InstallEnv,
  type InstallPlan,
  type InstallStep,
  type ManifestEntry,
  type McpPayload,
  type McpServerEntry,
  type UninstallResult,
  type VerifyResult,
} from "../types.ts";

const CONFIG_FILENAME = "opencode.json";
const JSONC_FILENAME = "opencode.jsonc";

/** The native V2 registration path: top-level `mcp` with a `servers` object. */
const V2_SHAPE_PATH: ReadonlyArray<string> = Object.freeze(["mcp", "servers"]);
/** The legacy registration path this adapter shipped first. */
const V1_SHAPE_PATH: ReadonlyArray<string> = Object.freeze(["mcp"]);
const FIX_HINT = "o2b install --target opencode --apply";

function opencodeDir(env: InstallEnv): string {
  const xdg = env.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(env.home, ".config");
  return join(base, "opencode");
}

function configPath(env: InstallEnv): string {
  const dir = opencodeDir(env);
  const jsonc = join(dir, JSONC_FILENAME);
  // `.jsonc` is the config only when it is the only file present; with
  // both (or neither) the `.json` file keeps today's behavior.
  if (existsSync(jsonc) && !existsSync(join(dir, CONFIG_FILENAME))) return jsonc;
  return join(dir, CONFIG_FILENAME);
}

function legacyConfigPath(env: InstallEnv): string {
  return join(opencodeDir(env), "mcp.json");
}

/**
 * Canonical `McpServerEntry` → opencode `mcp` entry, V1 shape. opencode
 * takes the full argv as one `command` array and calls the env map
 * `environment`; `enabled: true` is explicit so an operator toggling the
 * server off shows up as drift instead of silently staying off after
 * re-apply.
 */
export function serializeOpencodeEntry(entry: McpServerEntry): Record<string, unknown> {
  return {
    type: "local",
    command: [entry.command, ...entry.args],
    ...(entry.env && Object.keys(entry.env).length > 0 ? { environment: { ...entry.env } } : {}),
    enabled: true,
  };
}

/**
 * The same entry at the native V2 shape. The V2 field list replaces V1's
 * `enabled` with `disabled` ("Use `disabled`, not an `enabled` field"),
 * so a V2 entry never carries `enabled`; `disabled: false` is written
 * explicitly so an operator toggling the server off shows up as drift
 * instead of silently staying off after re-apply.
 */
export function serializeOpencodeEntryV2(entry: McpServerEntry): Record<string, unknown> {
  return {
    type: "local",
    command: [entry.command, ...entry.args],
    ...(entry.env && Object.keys(entry.env).length > 0 ? { environment: { ...entry.env } } : {}),
    disabled: false,
  };
}

/** The entry serializer the resolved config shape takes. */
function serializerFor(v2: boolean): (entry: McpServerEntry) => Record<string, unknown> {
  return v2 ? serializeOpencodeEntryV2 : serializeOpencodeEntry;
}

/**
 * What the resolved config file looks like to this adapter. `parsed` is
 * null when neither the plain-JSON nor the JSONC parse accepts the
 * text; callers decide per verb whether that is drift (verify, detect)
 * or a named refusal (apply, uninstall).
 */
interface ConfigState {
  readonly exists: boolean;
  readonly raw: string;
  /** The text carries comments or trailing commas: only the editor may rewrite it. */
  readonly jsonc: boolean;
  /** The file carries an `mcp.servers` object: the native V2 shape is the target. */
  readonly v2: boolean;
  readonly parsed: Record<string, unknown> | null;
}

const ABSENT_CONFIG: ConfigState = Object.freeze({
  exists: false,
  raw: "",
  jsonc: false,
  v2: false,
  parsed: null,
});

function resolveConfigState(env: InstallEnv): ConfigState {
  const path = configPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return ABSENT_CONFIG;
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = parseJsoncObject(raw);
  } catch {
    parsed = null;
  }
  return {
    exists: true,
    raw,
    jsonc: hasJsoncSyntax(raw),
    v2: shapeIsV2(parsed),
    parsed,
  };
}

/**
 * Whether a value looks like a server entry: an object naming a type, a
 * command or a url. Exported so the doctor's registered-commands probe
 * asks this module's shape question instead of its own: the probe scans
 * `mcp.servers` alone only when this predicate calls the block the
 * native map, so one file resolves to one shape in both readers.
 */
export function looksLikeServerEntry(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.hasOwn(record, "type") ||
    Object.hasOwn(record, "command") ||
    Object.hasOwn(record, "url")
  );
}

/**
 * Whether `mcp.servers` is the native V2 map of servers, and not a
 * legacy user server that happens to be named `servers`. The honest
 * minimal test: the native shape maps NAMES to entries, so a block that
 * is itself an entry - `type`, `command` or `url` sitting directly on
 * it - is that user's server, and the file keeps the legacy shape. An
 * empty block is the native shape before any server is declared.
 */
function shapeIsV2(parsed: Record<string, unknown> | null): boolean {
  if (parsed === null) return false;
  const servers = blockAtPath(parsed, V2_SHAPE_PATH);
  if (servers === null) return false;
  return !looksLikeServerEntry(servers);
}

/** Walk a dotted shape path through parsed objects; null when any segment is missing or not an object. */
function blockAtPath(
  parsed: Record<string, unknown>,
  shapePath: ReadonlyArray<string>,
): Record<string, unknown> | null {
  let current: unknown = parsed;
  for (const segment of shapePath) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) return null;
  return current as Record<string, unknown>;
}

/**
 * Whether the shape path's FIRST missing segment makes it absent, as
 * opposed to present but not an object. Detect reads this distinction
 * the way the shared body's `readMcpBlock` does: a config that simply
 * does not carry the key has never heard of us (not-installed), while a
 * key holding the wrong shape is a modification of our registration
 * site (drift). `blockAtPath` deliberately collapses the two, so this is
 * the second half of its answer.
 */
function blockIsAbsent(parsed: Record<string, unknown>, shapePath: ReadonlyArray<string>): boolean {
  let current: unknown = parsed;
  for (const segment of shapePath) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return false;
    const next = (current as Record<string, unknown>)[segment];
    if (next === undefined) return true;
    current = next;
  }
  return false;
}

/**
 * The editor route owns every write whose file carries JSONC syntax or
 * whose shape is the native V2 key. Plain JSON at the V1 shape keeps
 * the shared json-merge body byte-for-byte.
 */
function routesThroughEditor(state: ConfigState): boolean {
  return state.jsonc || state.v2;
}

function hasOsbKeyIn(block: Record<string, unknown> | null): boolean {
  // Own-property checks: whether the file carries our keys is a question
  // about the block itself, and an `in` test would read a prototype
  // chain a crafted document could have forged.
  return (
    block !== null && (Object.hasOwn(block, OSB_KEY_FULL) || Object.hasOwn(block, OSB_KEY_WRITER))
  );
}

/** Our keys under either shape: a shape change on an install we own is still a modification of it. */
function hasOsbKeyAnywhere(parsed: Record<string, unknown>): boolean {
  return (
    hasOsbKeyIn(blockAtPath(parsed, V2_SHAPE_PATH)) ||
    hasOsbKeyIn(blockAtPath(parsed, V1_SHAPE_PATH))
  );
}

function canonicalUnderShape(
  parsed: Record<string, unknown>,
  shapePath: ReadonlyArray<string>,
  payload: McpPayload,
): boolean {
  const block = blockAtPath(parsed, shapePath);
  if (block === null) return false;
  const serialize = serializerFor(shapePath === V2_SHAPE_PATH);
  if (!Object.hasOwn(block, OSB_KEY_FULL) || !Object.hasOwn(block, OSB_KEY_WRITER)) return false;
  return (
    deepJsonEquals(block[OSB_KEY_FULL], serialize(payload.full)) &&
    deepJsonEquals(block[OSB_KEY_WRITER], serialize(payload.writer))
  );
}

/** Canonical for the guard means the target shape matches AND, on V2, no shadowed legacy copies of ours remain. */
function canonicalForGuard(
  parsed: Record<string, unknown>,
  v2: boolean,
  payload: McpPayload,
): boolean {
  if (!canonicalUnderShape(parsed, v2 ? V2_SHAPE_PATH : V1_SHAPE_PATH, payload)) return false;
  if (v2 && hasOsbKeyIn(blockAtPath(parsed, V1_SHAPE_PATH))) return false;
  return true;
}

/** The payload as this target's config must hold it: host dimensions, then the runtime-identity rule. */
function payloadForOpencode(payload: McpPayload, env: InstallEnv): McpPayload {
  return payloadWithRuntimeIdentity(payloadForHost("opencode", payload, env), "opencode");
}

/** The verify-side reconstruction, rebuilt from the `InstallEnv` alone. */
function expectedPayloadForOpencode(env: InstallEnv): McpPayload {
  return payloadWithRuntimeIdentity(expectedPayloadFromEnv(env, "opencode"), "opencode");
}

function ownedKeysFor(shapePath: ReadonlyArray<string>): ReadonlyArray<string> {
  const prefix = shapePath.join(".");
  return [`${prefix}.${OSB_KEY_FULL}`, `${prefix}.${OSB_KEY_WRITER}`];
}

function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readFileConfig(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function refusable(e: unknown, path: string): Error {
  if (e instanceof JsoncEditError) return new JsoncEditError(`${path}: ${e.message}`);
  return e instanceof Error ? e : new JsoncEditError(`${path}: ${String(e)}`);
}

function applyViaEditor(
  env: InstallEnv,
  rawPayload: McpPayload,
  opts: ApplyOpts,
  state: ConfigState,
): ApplyResult {
  const path = configPath(env);
  if (state.parsed === null) {
    // Ambiguous or malformed config: refused unchanged, named, no
    // partial write.
    throw new JsoncEditError(`${path}: config file is not parseable as JSON or JSONC`);
  }
  const payload = payloadForOpencode(rawPayload, env);
  const manifestEntry = readManifest(env.vault).installs["opencode"];
  // Safety net, editor route: if the on-disk content differs from
  // canonical AND mtime is newer than manifest.applied_at AND the user
  // didn't pass --force, refuse. Key presence is checked across BOTH
  // shapes so a host-side shape change on an install we own counts as a
  // modification - the one-time drift the docs describe.
  if (
    manifestEntry &&
    !canonicalForGuard(state.parsed, state.v2, payload) &&
    hasOsbKeyAnywhere(state.parsed) &&
    !opts.force
  ) {
    const appliedAt = Date.parse(manifestEntry.applied_at);
    const mtime = fileMtimeMs(path) ?? 0;
    if (Number.isFinite(appliedAt) && mtime > appliedAt + 1000) {
      throw new InstallError(
        `opencode: ${path} appears hand-edited after the last install ` +
          `(mtime newer than manifest applied_at). Refusing to overwrite.`,
        "opencode",
        "user-modified-block",
        "re-run with --force to overwrite, or run `o2b uninstall --target opencode --apply` first",
      );
    }
  }
  const shapePath = state.v2 ? V2_SHAPE_PATH : V1_SHAPE_PATH;
  const serialize = serializerFor(state.v2);
  let next = state.raw;
  try {
    next = setJsoncEntry(next, shapePath, OSB_KEY_FULL, serialize(payload.full));
    next = setJsoncEntry(next, shapePath, OSB_KEY_WRITER, serialize(payload.writer));
    if (state.v2) {
      // Our own shadowed copies under the legacy top-level key would
      // outlive the write; they are ours to clean, user keys stay.
      next = removeJsoncEntry(next, V1_SHAPE_PATH, OSB_KEY_FULL);
      next = removeJsoncEntry(next, V1_SHAPE_PATH, OSB_KEY_WRITER);
    }
  } catch (e) {
    throw refusable(e, path);
  }
  const contentChanged = next !== state.raw;
  if (!opts.dryRun && contentChanged) {
    atomicWriteFileSync(path, next);
  }

  // Re-apply with byte-identical content: keep the previous
  // `applied_at` so the user-modified-block detector continues to
  // compare disk mtime against the actual install moment.
  const existing = readManifest(env.vault).installs["opencode"];
  const appliedAt = !contentChanged && existing ? existing.applied_at : env.now.toISOString();
  const manifest: ManifestEntry = {
    target: "opencode",
    applied_at: appliedAt,
    operation: "json-merge",
    config_path: path,
    owned_keys: ownedKeysFor(shapePath),
  };
  if (!opts.dryRun && (contentChanged || !existing)) {
    recordEntry(env.vault, manifest);
  }
  return {
    target: "opencode",
    manifest,
    steps_executed: opts.dryRun || !contentChanged ? 0 : 1,
  };
}

function verifyViaEditor(env: InstallEnv): VerifyResult {
  const path = configPath(env);
  const stored = readManifest(env.vault).installs["opencode"];
  if (!stored) {
    return {
      target: "opencode",
      status: "not-installed",
      details: ["no install manifest entry"],
      fix_hint: null,
    };
  }
  if (!existsSync(path)) {
    return {
      target: "opencode",
      status: "drift",
      details: [`config file missing: ${path}`],
      fix_hint: FIX_HINT,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsoncObject(readFileConfig(path));
  } catch {
    return {
      target: "opencode",
      status: "drift",
      details: [`config file is not parseable as JSON or JSONC: ${path}`],
      fix_hint: FIX_HINT,
    };
  }
  const v2 = shapeIsV2(parsed);
  const serialize = serializerFor(v2);
  const shapeKey = (v2 ? V2_SHAPE_PATH : V1_SHAPE_PATH).join(".");
  const block = blockAtPath(parsed, v2 ? V2_SHAPE_PATH : V1_SHAPE_PATH);
  if (block === null) {
    return {
      target: "opencode",
      status: "drift",
      details: [`${shapeKey} is not a JSON object: ${path}`],
      fix_hint: FIX_HINT,
    };
  }
  const hasFull = Object.hasOwn(block, OSB_KEY_FULL);
  const hasWriter = Object.hasOwn(block, OSB_KEY_WRITER);
  if (!hasFull || !hasWriter) {
    return {
      target: "opencode",
      status: "drift",
      details: [
        `${hasFull ? "" : OSB_KEY_FULL + " key missing; "}${hasWriter ? "" : OSB_KEY_WRITER + " key missing"}`.trim(),
      ],
      fix_hint: FIX_HINT,
    };
  }
  const expected = expectedPayloadForOpencode(env);
  if (
    !deepJsonEquals(block[OSB_KEY_FULL], serialize(expected.full)) ||
    !deepJsonEquals(block[OSB_KEY_WRITER], serialize(expected.writer))
  ) {
    return {
      target: "opencode",
      status: "drift",
      details: [`${path}: OSB keys differ from canonical payload`],
      fix_hint: FIX_HINT,
    };
  }
  // Apply treats our leftover copies under the legacy top-level key as
  // non-canonical in a V2 file (the guard refuses to count them clean,
  // and re-apply removes them), so verify must not call the same state
  // ok: the file an operator would get from re-apply is not the file on
  // disk.
  if (v2) {
    const legacy = blockAtPath(parsed, V1_SHAPE_PATH);
    const shadowed =
      legacy === null
        ? []
        : [OSB_KEY_FULL, OSB_KEY_WRITER].filter((key) => Object.hasOwn(legacy, key));
    if (shadowed.length > 0) {
      return {
        target: "opencode",
        status: "drift",
        details: [
          `${path}: legacy top-level copies of ${shadowed.join(", ")} remain beside the native mcp.servers entries`,
        ],
        fix_hint: FIX_HINT,
      };
    }
  }
  // The same host-probe composition the shared body applies: the file
  // was compared and matches, so a refuting probe reads as a host that
  // has not reloaded the config - never as a lost registration.
  const probe = probeHost("opencode", env);
  if (probeRefutes(probe)) {
    const verdict = probeRefutedVerdict({
      target: "opencode",
      label: "opencode",
      artifactMatches: true,
    });
    return {
      target: "opencode",
      status: verdict.status,
      details: [`${path}: matches the canonical payload, but ${handshakeNote(probe)}`],
      fix_hint: verdict.fixHint,
    };
  }
  return {
    target: "opencode",
    status: "ok",
    details: [`${path}: both OSB keys match the canonical payload (${handshakeNote(probe)})`],
    fix_hint: null,
  };
}

function uninstallViaEditor(
  env: InstallEnv,
  opts: ApplyOpts & { fromSnippet?: boolean },
): UninstallResult {
  const path = configPath(env);
  const stored = readManifest(env.vault).installs["opencode"];
  const skipped: Array<readonly [string, string]> = [];
  const removed_keys: string[] = [];
  const removed_paths: string[] = [];
  if (!stored && !opts.fromSnippet) {
    throw new InstallError(
      "opencode: no install manifest entry found. " +
        `Pass --force-from-snippet to remove based on the canonical payload.`,
      "opencode",
      "manifest-missing",
      "o2b uninstall --target opencode --apply --force-from-snippet",
    );
  }
  if (!existsSync(path)) {
    skipped.push([path, "config file no longer present"]);
    if (!opts.dryRun) removeEntry(env.vault, "opencode");
    return { target: "opencode", removed_keys, removed_paths, skipped };
  }
  const raw = readFileConfig(path);
  if (parseJsoncObjectSafe(raw) === null) {
    throw new JsoncEditError(`${path}: config file is not parseable as JSON or JSONC`);
  }
  // Remove what is ours under either shape, exactly: user keys are
  // never touched, and an absent key is a byte-identical no-op.
  let next = raw;
  try {
    for (const shapePath of [V2_SHAPE_PATH, V1_SHAPE_PATH]) {
      for (const key of [OSB_KEY_FULL, OSB_KEY_WRITER]) {
        const after = removeJsoncEntry(next, shapePath, key);
        if (after !== next) {
          removed_keys.push(`${shapePath.join(".")}.${key}`);
          next = after;
        }
      }
    }
  } catch (e) {
    throw refusable(e, path);
  }
  if (!opts.dryRun && next !== raw) {
    atomicWriteFileSync(path, next);
  }
  if (!opts.dryRun) removeEntry(env.vault, "opencode");
  return { target: "opencode", removed_keys, removed_paths, skipped };
}

function parseJsoncObjectSafe(raw: string): Record<string, unknown> | null {
  try {
    return parseJsoncObject(raw);
  } catch {
    return null;
  }
}

function detectViaEditor(env: InstallEnv, state: ConfigState): DetectResult {
  const path = configPath(env);
  if (!state.exists) {
    return {
      target: "opencode",
      status: "not-installed",
      configPath: path,
      notes: ["config file missing"],
    };
  }
  if (state.parsed === null) {
    return {
      target: "opencode",
      status: "drift",
      configPath: path,
      notes: ["config file is not parseable as JSON or JSONC"],
    };
  }
  const shapePath = state.v2 ? V2_SHAPE_PATH : V1_SHAPE_PATH;
  const shapeKey = shapePath.join(".");
  const block = blockAtPath(state.parsed, shapePath);
  if (block === null) {
    // An ABSENT key is a config that has never heard of us - the same
    // verdict base.detect reaches for identical plain-JSON content
    // (readMcpBlock's `?? {}`). Reporting drift here would make
    // `o2b update`, which skips only not-installed targets, perform a
    // full install into an opencode that was never installed. Only a
    // PRESENT-but-non-object block is drift.
    if (blockIsAbsent(state.parsed, shapePath)) {
      return { target: "opencode", status: "not-installed", configPath: path, notes: [] };
    }
    return {
      target: "opencode",
      status: "drift",
      configPath: path,
      notes: [`${shapeKey} is not a JSON object`],
    };
  }
  const hasFull = Object.hasOwn(block, OSB_KEY_FULL);
  const hasWriter = Object.hasOwn(block, OSB_KEY_WRITER);
  if (!hasFull && !hasWriter) {
    // Our keys under the OTHER shape are an owned install at a site the
    // resolved shape does not read, not an absent one: verify names that
    // state drift, re-apply removes the shadowed copies, and a
    // not-installed verdict here would make `o2b update`, which skips
    // only not-installed targets, skip the repair. Neither block
    // holding our keys stays the "never heard of us" verdict.
    if (hasOsbKeyAnywhere(state.parsed)) {
      return {
        target: "opencode",
        status: "drift",
        configPath: path,
        notes: [
          `our keys sit under ${(state.v2 ? V1_SHAPE_PATH : V2_SHAPE_PATH).join(".")}; ${shapeKey} lacks them`,
        ],
      };
    }
    return { target: "opencode", status: "not-installed", configPath: path, notes: [] };
  }
  if (hasFull && hasWriter) {
    return {
      target: "opencode",
      status: "installed",
      configPath: path,
      notes: [`both OSB keys present under ${shapeKey}`],
    };
  }
  return {
    target: "opencode",
    status: "drift",
    configPath: path,
    notes: [`partial OSB install: ${hasFull ? "writer key missing" : "full-server key missing"}`],
  };
}

function editorPlanStep(state: ConfigState, rawPayload: McpPayload, env: InstallEnv): InstallStep {
  const path = configPath(env);
  const shapeKey = (state.v2 ? V2_SHAPE_PATH : V1_SHAPE_PATH).join(".");
  const preserved = state.jsonc ? " (JSONC comments preserved)" : "";
  // The PREVIEW prints the args that will actually be written, the same
  // contract the shared body's plan states.
  const payload = payloadForOpencode(rawPayload, env);
  return {
    kind: "json-merge",
    path,
    preview:
      `json-merge two keys into ${shapeKey} at ${path}${preserved}: ` +
      `${OSB_KEY_FULL} → ${payload.full.command} ${payload.full.args.join(" ")}; ` +
      `${OSB_KEY_WRITER} → ${payload.writer.command} ${payload.writer.args.join(" ")}`,
  };
}

/**
 * Best-effort removal of our keys from the legacy `mcp.json`. Never
 * throws: a malformed or absent file is left as-is — migration is an
 * opportunistic cleanup, not a gate on the real install.
 */
function migrateLegacyMcpJson(env: InstallEnv, opts: ApplyOpts): void {
  const path = legacyConfigPath(env);
  if (opts.dryRun || !existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const root = parsed as Record<string, unknown>;
    const servers = root["mcpServers"];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return;
    const block = servers as Record<string, unknown>;
    if (!(OSB_KEY_FULL in block) && !(OSB_KEY_WRITER in block)) return;
    delete block[OSB_KEY_FULL];
    delete block[OSB_KEY_WRITER];
    const fileIsEmpty = Object.keys(block).length === 0 && Object.keys(root).length === 1;
    if (fileIsEmpty) {
      rmSync(path);
      return;
    }
    atomicWriteFileSync(path, JSON.stringify(root, null, 2) + "\n");
  } catch {
    // Unreadable or unparseable legacy file: not ours to interpret.
  }
}

function pluginPath(env: InstallEnv): string {
  return join(opencodeDir(env), "plugins", OPENCODE_PLUGIN_FILENAME);
}

/**
 * Reads the installed plugin copy, or null when the path is absent,
 * not a regular file, or unreadable. Callers treat null as "needs
 * (re)install" / drift instead of letting a stray directory or a
 * permissions problem abort the whole install flow.
 */
function readPluginCopy(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const base = createJsonMcpAdapter({
  target: "opencode",
  label: "opencode",
  topLevelKey: "mcp",
  resolveConfigPath: configPath,
  // The shared body serves only the plain-JSON V1 route (the editor
  // route owns every JSONC or V2-shaped file), so the V1 entry shape is
  // the right serialization here.
  serializeEntry: serializeOpencodeEntry,
  runtimeIdentity: true,
  postNotes: ["Restart opencode to load the new MCP servers and the Open Second Brain plugin."],
});

export const opencodeAdapter = {
  ...base,

  detect(env: InstallEnv): DetectResult {
    const state = resolveConfigState(env);
    return routesThroughEditor(state) ? detectViaEditor(env, state) : base.detect(env);
  },

  plan(payload: McpPayload, env: InstallEnv): InstallPlan {
    const basePlan = base.plan(payload, env);
    const state = resolveConfigState(env);
    const steps = routesThroughEditor(state)
      ? [editorPlanStep(state, payload, env), ...basePlan.steps.slice(1)]
      : [...basePlan.steps];
    steps.push({
      kind: "file-copy",
      path: pluginPath(env),
      preview: `copy the bundled Open Second Brain plugin to ${pluginPath(env)}`,
    });
    const legacy = legacyConfigPath(env);
    if (existsSync(legacy)) {
      steps.push({
        kind: "json-merge",
        path: legacy,
        preview: `remove Open Second Brain keys from the legacy ${legacy} (delete when empty)`,
      });
    }
    return { ...basePlan, steps };
  },

  apply(plan: InstallPlan, payload: McpPayload, env: InstallEnv, opts: ApplyOpts): ApplyResult {
    const state = resolveConfigState(env);
    const result = routesThroughEditor(state)
      ? applyViaEditor(env, payload, opts, state)
      : base.apply(plan, payload, env, opts);
    migrateLegacyMcpJson(env, opts);

    const plugin = pluginPath(env);
    let pluginWritten = 0;
    if (!opts.dryRun) {
      const expected = installedPluginContent();
      const current = readPluginCopy(plugin);
      if (current !== expected) {
        // A stray directory or special file at the plugin path must not
        // abort the install; clear it before the atomic write.
        if (current === null && existsSync(plugin)) {
          rmSync(plugin, { recursive: true, force: true });
        }
        const dir = dirname(plugin);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        atomicWriteFileSync(plugin, expected);
        pluginWritten = 1;
      }
      // The write path records ownership of the two JSON keys; extend
      // the entry with the plugin file so verify and uninstall track it
      // too.
      const stored = readManifest(env.vault).installs[result.manifest.target] ?? result.manifest;
      const manifest = { ...stored, owned_paths: [plugin] };
      recordEntry(env.vault, manifest);
      return {
        ...result,
        manifest,
        steps_executed: result.steps_executed + pluginWritten,
      };
    }
    return result;
  },

  verify(env: InstallEnv): VerifyResult {
    const state = resolveConfigState(env);
    const baseResult = routesThroughEditor(state) ? verifyViaEditor(env) : base.verify(env);
    if (baseResult.status !== "ok") return baseResult;
    const plugin = pluginPath(env);
    const fixHint = "o2b install --target opencode --apply";
    const current = readPluginCopy(plugin);
    if (current === null) {
      return {
        target: base.target,
        status: "drift",
        details: [`plugin file missing, unreadable, or not a regular file: ${plugin}`],
        fix_hint: fixHint,
      };
    }
    if (current !== installedPluginContent()) {
      return {
        target: base.target,
        status: "drift",
        details: [`plugin file differs from the bundled version: ${plugin}`],
        fix_hint: fixHint,
      };
    }
    return baseResult;
  },

  uninstall(env: InstallEnv, opts: ApplyOpts & { fromSnippet?: boolean }): UninstallResult {
    const state = resolveConfigState(env);
    const result = routesThroughEditor(state)
      ? uninstallViaEditor(env, opts)
      : base.uninstall(env, opts);
    const plugin = pluginPath(env);
    if (existsSync(plugin)) {
      try {
        if (!opts.dryRun) rmSync(plugin, { recursive: true, force: true });
        return { ...result, removed_paths: [...result.removed_paths, plugin] };
      } catch (e) {
        return {
          ...result,
          skipped: [...result.skipped, [plugin, `could not remove: ${(e as Error).message}`]],
        };
      }
    }
    return result;
  },
};

defaultRegistry.register(opencodeAdapter);
