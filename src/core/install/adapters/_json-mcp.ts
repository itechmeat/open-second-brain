/**
 * Shared adapter body for runtimes that consume MCP servers via a JSON
 * config file with a top-level object (default `mcpServers`). Cursor,
 * kiro, Gemini CLI follow the default shape; opencode reuses the same
 * body with a custom top-level key and entry shape.
 *
 * Per-target specifics (config path, top-level key, post-install notes)
 * are injected via `JsonMcpAdapterSpec`. The body itself owns
 * idempotency, drift detection, manifest I/O, and the
 * user-modified-block safety net.
 *
 * What `verify` here can and cannot prove: it compares the on-disk config
 * against the canonical payload. It does not, and cannot from this side,
 * establish that the runtime loaded the entry - see the comment on the
 * `ok` return, where a declared-but-never-implemented MCP probe seam used
 * to make that ambiguity invisible.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import type { InstallTargetId } from "../../runtime/host-facts.ts";
import { handshakeNote, probeHost, probeRefutedVerdict, probeRefutes } from "../host-probe.ts";
import { payloadWithRuntimeIdentity } from "../identity.ts";
import { mergeMcpServers, removeMcpServers, OSB_KEY_FULL, OSB_KEY_WRITER } from "../json-merge.ts";
import { payloadForHost } from "../payload-host.ts";
import { recordEntry, readManifest, removeEntry } from "../manifest.ts";
import { deepJsonEquals, expectedPayloadFromEnv, payloadKeyEquals } from "../payload-equals.ts";
import {
  InstallError,
  type ApplyOpts,
  type ApplyResult,
  type DetectResult,
  type InstallAdapter,
  type InstallEnv,
  type InstallPlan,
  type ManifestEntry,
  type McpPayload,
  type McpServerEntry,
  type SessionPathsResult,
  type UninstallResult,
  type VerifyResult,
} from "../types.ts";
import { sessionPathsFor } from "../session-paths.ts";

export interface JsonMcpAdapterSpec {
  /** The runtime this spec installs into; becomes `InstallAdapter.target`. */
  readonly target: InstallTargetId;
  readonly label: string;
  /** Top-level key under which MCP servers live. Default `mcpServers`. */
  readonly topLevelKey?: string;
  /**
   * Maps the canonical `McpServerEntry` to the runtime's on-disk entry
   * shape. Default emits `{command, args, env?}`. Adapters whose runtime
   * uses a different schema (opencode: `{type, command: [bin, ...args],
   * environment?, enabled}`) inject the mapping here.
   */
  readonly serializeEntry?: (entry: McpServerEntry) => Record<string, unknown>;
  /**
   * Compares an on-disk entry against the canonical payload for
   * idempotency and drift detection. Defaults to `payloadKeyEquals`
   * when `serializeEntry` is absent, and to strict structural equality
   * against `serializeEntry(expected)` when it is present.
   */
  readonly entryEquals?: (
    current: Record<string, unknown> | undefined,
    expected: McpServerEntry,
  ) => boolean;
  /** Resolves the absolute path to the runtime's config file. */
  resolveConfigPath(env: InstallEnv): string;
  /** Extra notes attached to `detect.notes` / plan output. */
  readonly notes?: ReadonlyArray<string>;
  /** Plan-level post-install reminders (e.g. "restart Cursor app"). */
  readonly postNotes?: ReadonlyArray<string>;
  /** Fix-hint text for `verify` when drift detected. */
  readonly fixHintForDrift?: string;
  /**
   * When set, stamp this runtime's own id (`target`) as `VAULT_AGENT_NAME` so
   * its Brain writes attribute to itself rather than inheriting the shared
   * operator name. Opt-in: only real runtime integrations set it; the generic
   * "other MCP host" adapters leave the operator name untouched.
   */
  readonly runtimeIdentity?: boolean;
}

/** Apply the runtime-identity rule to the payload when the spec opted in. */
function identifyPayload(spec: JsonMcpAdapterSpec, payload: McpPayload): McpPayload {
  return spec.runtimeIdentity ? payloadWithRuntimeIdentity(payload, spec.target) : payload;
}

/**
 * The payload as this target's config file must hold it: the host's own
 * dimensions (tool profile, host id) then the runtime-identity rule.
 *
 * Both transforms are pure functions of the spec and the `InstallEnv`,
 * and every path that touches the file - plan, apply, verify - goes
 * through this one function. That is what keeps re-construction honest:
 * a transform applied on apply but not on verify would report drift
 * against bytes this adapter had just written itself.
 */
function payloadForSpec(
  spec: JsonMcpAdapterSpec,
  payload: McpPayload,
  env: InstallEnv,
): McpPayload {
  return identifyPayload(spec, payloadForHost(spec.target, payload, env));
}

/**
 * The same composition as {@link payloadForSpec}, rebuilt from the
 * `InstallEnv` alone - the verify side of re-construction. It exists so
 * the two sides cannot be assembled in different orders by accident:
 * `verify` once applied the identity rule and not the host rule, which
 * made every runtime-identity adapter report drift against the file it
 * had just written.
 */
function expectedPayloadForSpec(spec: JsonMcpAdapterSpec, env: InstallEnv): McpPayload {
  return identifyPayload(spec, expectedPayloadFromEnv(env, spec.target));
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readMcpBlock(
  root: Record<string, unknown>,
  topKey: string,
): Record<string, unknown> | null {
  const block = root[topKey] ?? {};
  if (block === null || typeof block !== "object" || Array.isArray(block)) return null;
  return block as Record<string, unknown>;
}

function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

interface OnDiskState {
  readonly exists: boolean;
  readonly canonical: boolean;
  readonly full: Record<string, unknown> | undefined;
  readonly writer: Record<string, unknown> | undefined;
  readonly raw: string;
  readonly mtimeMs: number | null;
}

function readOnDisk(spec: JsonMcpAdapterSpec, env: InstallEnv, payload: McpPayload): OnDiskState {
  const path = spec.resolveConfigPath(env);
  if (!existsSync(path)) {
    return {
      exists: false,
      canonical: false,
      full: undefined,
      writer: undefined,
      raw: "",
      mtimeMs: null,
    };
  }
  const raw = readFileOrEmpty(path);
  const topKey = spec.topLevelKey ?? "mcpServers";
  const parsed = parseJsonObject(raw);
  if (parsed === null) {
    return {
      exists: true,
      canonical: false,
      full: undefined,
      writer: undefined,
      raw,
      mtimeMs: fileMtimeMs(path),
    };
  }
  const block = readMcpBlock(parsed, topKey);
  if (block === null) {
    return {
      exists: true,
      canonical: false,
      full: undefined,
      writer: undefined,
      raw,
      mtimeMs: fileMtimeMs(path),
    };
  }
  const full = block[OSB_KEY_FULL] as Record<string, unknown> | undefined;
  const writer = block[OSB_KEY_WRITER] as Record<string, unknown> | undefined;
  const equals = resolveEntryEquals(spec);
  const canonical = equals(full, payload.full) && equals(writer, payload.writer);
  return { exists: true, canonical, full, writer, raw, mtimeMs: fileMtimeMs(path) };
}

/**
 * Resolution order for the entry comparator: explicit `entryEquals`
 * wins; a spec with only `serializeEntry` gets strict structural
 * equality against the re-serialized canonical entry; the default
 * shape keeps the historical `payloadKeyEquals` semantics (extra
 * top-level entry keys tolerated).
 */
function resolveEntryEquals(
  spec: JsonMcpAdapterSpec,
): (current: Record<string, unknown> | undefined, expected: McpServerEntry) => boolean {
  if (spec.entryEquals) return spec.entryEquals;
  const serialize = spec.serializeEntry;
  if (serialize) {
    return (current, expected) =>
      current !== undefined && deepJsonEquals(current, serialize(expected));
  }
  return payloadKeyEquals;
}

export function createJsonMcpAdapter(spec: JsonMcpAdapterSpec): InstallAdapter {
  const topKey = spec.topLevelKey ?? "mcpServers";

  return {
    target: spec.target,
    label: spec.label,

    detect(env: InstallEnv): DetectResult {
      const path = spec.resolveConfigPath(env);
      const baseNotes = [...(spec.notes ?? [])];
      if (!existsSync(path)) {
        return {
          target: spec.target,
          status: "not-installed",
          configPath: path,
          notes: [...baseNotes, "config file missing"],
        };
      }
      const raw = readFileOrEmpty(path);
      const parsed = parseJsonObject(raw);
      if (parsed === null) {
        return {
          target: spec.target,
          status: "drift",
          configPath: path,
          notes: [...baseNotes, "config file is not valid JSON"],
        };
      }
      const block = readMcpBlock(parsed, topKey);
      if (block === null) {
        return {
          target: spec.target,
          status: "drift",
          configPath: path,
          notes: [...baseNotes, `${topKey} is not a JSON object`],
        };
      }
      const hasFull = OSB_KEY_FULL in block;
      const hasWriter = OSB_KEY_WRITER in block;
      if (!hasFull && !hasWriter) {
        return {
          target: spec.target,
          status: "not-installed",
          configPath: path,
          notes: baseNotes,
        };
      }
      if (hasFull && hasWriter) {
        return {
          target: spec.target,
          status: "installed",
          configPath: path,
          notes: [...baseNotes, `both OSB keys present under ${topKey}`],
        };
      }
      return {
        target: spec.target,
        status: "drift",
        configPath: path,
        notes: [
          ...baseNotes,
          `partial OSB install: ${hasFull ? "writer key missing" : "full-server key missing"}`,
        ],
      };
    },

    plan(rawPayload: McpPayload, env: InstallEnv): InstallPlan {
      const path = spec.resolveConfigPath(env);
      // The PREVIEW prints the args that will actually be written, not
      // the un-transformed canonical ones: a plan whose command line
      // differs from the applied one is a plan the operator cannot use
      // to review the change.
      const payload = payloadForSpec(spec, rawPayload, env);
      const preview =
        `json-merge two keys into ${topKey} at ${path}: ` +
        `${OSB_KEY_FULL} → ${payload.full.command} ${payload.full.args.join(" ")}; ` +
        `${OSB_KEY_WRITER} → ${payload.writer.command} ${payload.writer.args.join(" ")}`;
      return {
        target: spec.target,
        steps: [{ kind: "json-merge", path, preview }],
        postNotes: [...(spec.postNotes ?? [])],
      };
    },

    apply(
      _plan: InstallPlan,
      rawPayload: McpPayload,
      env: InstallEnv,
      opts: ApplyOpts,
    ): ApplyResult {
      const path = spec.resolveConfigPath(env);
      const payload = payloadForSpec(spec, rawPayload, env);
      const onDisk = readOnDisk(spec, env, payload);
      const manifestEntry = readManifest(env.vault).installs[spec.target];

      // Safety net: if the on-disk content differs from canonical AND
      // mtime is newer than manifest.applied_at AND user didn't pass
      // --force, refuse. This catches hand-edits.
      if (
        manifestEntry &&
        onDisk.exists &&
        !onDisk.canonical &&
        // Mixed: file exists but OSB keys are not exactly canonical.
        // If at least one OSB key is present, treat as potentially
        // hand-edited.
        (onDisk.full !== undefined || onDisk.writer !== undefined) &&
        !opts.force
      ) {
        const appliedAt = Date.parse(manifestEntry.applied_at);
        const mtime = onDisk.mtimeMs ?? 0;
        if (Number.isFinite(appliedAt) && mtime > appliedAt + 1000) {
          throw new InstallError(
            `${spec.target}: ${path} appears hand-edited after the last install ` +
              `(mtime newer than manifest applied_at). Refusing to overwrite.`,
            spec.target,
            "user-modified-block",
            "re-run with --force to overwrite, or run `o2b uninstall --target " +
              spec.target +
              " --apply` first",
          );
        }
      }

      const merged = mergeMcpServers(onDisk.raw, payload, {
        topLevelKey: topKey,
        ...(spec.serializeEntry ? { serializeEntry: spec.serializeEntry } : {}),
      });
      const contentChanged = merged !== onDisk.raw;
      if (!opts.dryRun && contentChanged) {
        ensureParent(path);
        atomicWriteFileSync(path, merged);
      }

      // Re-apply with byte-identical content: keep the previous
      // `applied_at` so the user-modified-block detector continues to
      // compare disk mtime against the actual install moment, not the
      // current wall clock.
      const existing = readManifest(env.vault).installs[spec.target];
      const appliedAt = !contentChanged && existing ? existing.applied_at : env.now.toISOString();
      const manifest: ManifestEntry = {
        target: spec.target,
        applied_at: appliedAt,
        operation: "json-merge",
        config_path: path,
        owned_keys: [`${topKey}.${OSB_KEY_FULL}`, `${topKey}.${OSB_KEY_WRITER}`],
      };
      if (!opts.dryRun && (contentChanged || !existing)) {
        recordEntry(env.vault, manifest);
      }

      return {
        target: spec.target,
        manifest,
        steps_executed: opts.dryRun || !contentChanged ? 0 : 1,
      };
    },

    uninstall(env: InstallEnv, opts: ApplyOpts & { fromSnippet?: boolean }): UninstallResult {
      const path = spec.resolveConfigPath(env);
      const stored = readManifest(env.vault).installs[spec.target];
      const skipped: Array<readonly [string, string]> = [];
      const removed_keys: string[] = [];
      const removed_paths: string[] = [];

      if (!stored && !opts.fromSnippet) {
        throw new InstallError(
          `${spec.target}: no install manifest entry found. ` +
            `Pass --force-from-snippet to remove based on the canonical payload.`,
          spec.target,
          "manifest-missing",
          "o2b uninstall --target " + spec.target + " --apply --force-from-snippet",
        );
      }

      if (!existsSync(path)) {
        skipped.push([path, "config file no longer present"]);
        if (!opts.dryRun) removeEntry(env.vault, spec.target);
        return { target: spec.target, removed_keys, removed_paths, skipped };
      }

      const raw = readFileOrEmpty(path);
      const next = removeMcpServers(raw, { topLevelKey: topKey });
      if (!opts.dryRun && next !== raw) {
        atomicWriteFileSync(path, next);
      }
      removed_keys.push(`${topKey}.${OSB_KEY_FULL}`, `${topKey}.${OSB_KEY_WRITER}`);
      if (!opts.dryRun) removeEntry(env.vault, spec.target);
      return { target: spec.target, removed_keys, removed_paths, skipped };
    },

    /**
     * Read off `RUNTIME_FACTS`, not off the spec. Every JSON-MCP host's
     * session store is already declared there, and a `sessionRoots` field
     * on {@link JsonMcpAdapterSpec} would be a second place to spell it.
     */
    sessionPaths(env: InstallEnv): SessionPathsResult | null {
      return sessionPathsFor(spec.target, env);
    },

    verify(env: InstallEnv): VerifyResult {
      const path = spec.resolveConfigPath(env);
      const stored = readManifest(env.vault).installs[spec.target];
      if (!stored) {
        return {
          target: spec.target,
          status: "not-installed",
          details: ["no install manifest entry"],
          fix_hint: null,
        };
      }
      if (!existsSync(path)) {
        return {
          target: spec.target,
          status: "drift",
          details: [`config file missing: ${path}`],
          fix_hint: spec.fixHintForDrift ?? `o2b install --target ${spec.target} --apply`,
        };
      }
      const raw = readFileOrEmpty(path);
      const parsed = parseJsonObject(raw);
      if (parsed === null) {
        return {
          target: spec.target,
          status: "drift",
          details: [`config file is not valid JSON: ${path}`],
          fix_hint: spec.fixHintForDrift ?? `o2b install --target ${spec.target} --apply`,
        };
      }
      const block = readMcpBlock(parsed, topKey);
      if (block === null) {
        return {
          target: spec.target,
          status: "drift",
          details: [`${topKey} is not a JSON object: ${path}`],
          fix_hint: spec.fixHintForDrift ?? `o2b install --target ${spec.target} --apply`,
        };
      }
      const hasFull = OSB_KEY_FULL in block;
      const hasWriter = OSB_KEY_WRITER in block;
      if (!hasFull || !hasWriter) {
        return {
          target: spec.target,
          status: "drift",
          details: [
            `${hasFull ? "" : OSB_KEY_FULL + " key missing; "}${hasWriter ? "" : OSB_KEY_WRITER + " key missing"}`.trim(),
          ],
          fix_hint: spec.fixHintForDrift ?? `o2b install --target ${spec.target} --apply`,
        };
      }
      const expected = expectedPayloadForSpec(spec, env);
      const equals = resolveEntryEquals(spec);
      if (
        !equals(block[OSB_KEY_FULL] as Record<string, unknown> | undefined, expected.full) ||
        !equals(block[OSB_KEY_WRITER] as Record<string, unknown> | undefined, expected.writer)
      ) {
        return {
          target: spec.target,
          status: "drift",
          details: [`${path}: OSB keys differ from canonical payload`],
          fix_hint: spec.fixHintForDrift ?? `o2b install --target ${spec.target} --apply`,
        };
      }
      // The config matches. What that is EVIDENCE of depends on the host,
      // and the fact table is what decides: a target whose `RUNTIME_FACTS`
      // row declares a `hostProbe` gets asked, and the answer - or the
      // named reason there is none - replaces the blanket note. Nothing in
      // this body spawns a runtime's own MCP server to speak a handshake
      // to itself: that would prove WE can run `o2b`, not that Cursor
      // loaded the entry. It asks the host's own CLI what it has
      // registered, which is the only question a host can answer about
      // itself, and no row in this body's population declares one today -
      // so they keep the blanket note, and keep it honestly.
      const probe = probeHost(spec.target, env);
      if (probeRefutes(probe)) {
        // The file was just compared and matches, so the shared rule reads
        // this as a host that has not reloaded it - never as a lost
        // registration.
        const verdict = probeRefutedVerdict({
          target: spec.target,
          label: spec.label,
          artifactMatches: true,
        });
        return {
          target: spec.target,
          status: verdict.status,
          details: [`${path}: matches the canonical payload, but ${handshakeNote(probe)}`],
          fix_hint: verdict.fixHint,
        };
      }
      return {
        target: spec.target,
        status: "ok",
        details: [`${path}: both OSB keys match the canonical payload (${handshakeNote(probe)})`],
        fix_hint: null,
      };
    },
  };
}

function ensureParent(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
