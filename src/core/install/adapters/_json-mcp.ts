/**
 * Shared adapter body for runtimes that consume MCP servers via a JSON
 * config file with a top-level object (default `mcpServers`). Cursor,
 * opencode, kiro, Gemini CLI — all four follow this pattern.
 *
 * Per-target specifics (config path, top-level key, post-install notes,
 * optional MCP probe) are injected via `JsonMcpAdapterSpec`. The body
 * itself owns idempotency, drift detection, manifest I/O, and the
 * user-modified-block safety net.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import {
  mergeMcpServers,
  removeMcpServers,
  OSB_KEY_FULL,
  OSB_KEY_WRITER,
} from "../json-merge.ts";
import { recordEntry, readManifest, removeEntry } from "../manifest.ts";
import { expectedPayloadFromEnv, payloadKeyEquals } from "../payload-equals.ts";
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
  type UninstallResult,
  type VerifyResult,
} from "../types.ts";

export interface JsonMcpAdapterSpec {
  readonly target: string;
  readonly label: string;
  /** Top-level key under which MCP servers live. Default `mcpServers`. */
  readonly topLevelKey?: string;
  /** Resolves the absolute path to the runtime's config file. */
  resolveConfigPath(env: InstallEnv): string;
  /** Extra notes attached to `detect.notes` / plan output. */
  readonly notes?: ReadonlyArray<string>;
  /** Plan-level post-install reminders (e.g. "restart Cursor app"). */
  readonly postNotes?: ReadonlyArray<string>;
  /**
   * Optional MCP-ping probe. Return `true` if the runtime answers an
   * MCP handshake; `false` on definite failure. `null` means "we
   * cannot probe" (skip — do not penalise).
   */
  probeMcp?(env: InstallEnv): boolean | null;
  /** Fix-hint text for `verify` when drift detected. */
  readonly fixHintForDrift?: string;
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
    return { exists: false, canonical: false, full: undefined, writer: undefined, raw: "", mtimeMs: null };
  }
  const raw = readFileOrEmpty(path);
  const topKey = spec.topLevelKey ?? "mcpServers";
  const parsed = parseJsonObject(raw);
  if (parsed === null) {
    return { exists: true, canonical: false, full: undefined, writer: undefined, raw, mtimeMs: fileMtimeMs(path) };
  }
  const block = readMcpBlock(parsed, topKey);
  if (block === null) {
    return { exists: true, canonical: false, full: undefined, writer: undefined, raw, mtimeMs: fileMtimeMs(path) };
  }
  const full = block[OSB_KEY_FULL] as Record<string, unknown> | undefined;
  const writer = block[OSB_KEY_WRITER] as Record<string, unknown> | undefined;
  const canonical =
    payloadKeyEquals(full, payload.full) && payloadKeyEquals(writer, payload.writer);
  return { exists: true, canonical, full, writer, raw, mtimeMs: fileMtimeMs(path) };
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

    plan(payload: McpPayload, env: InstallEnv): InstallPlan {
      const path = spec.resolveConfigPath(env);
      const preview = `json-merge two keys into ${topKey} at ${path}: ` +
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
      payload: McpPayload,
      env: InstallEnv,
      opts: ApplyOpts,
    ): ApplyResult {
      const path = spec.resolveConfigPath(env);
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

      const merged = mergeMcpServers(onDisk.raw, payload, { topLevelKey: topKey });
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
      const appliedAt = !contentChanged && existing
        ? existing.applied_at
        : env.now.toISOString();
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

    uninstall(
      env: InstallEnv,
      opts: ApplyOpts & { fromSnippet?: boolean },
    ): UninstallResult {
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
      const expected = expectedPayloadFromEnv(env);
      if (
        !payloadKeyEquals(block[OSB_KEY_FULL] as Record<string, unknown> | undefined, expected.full) ||
        !payloadKeyEquals(block[OSB_KEY_WRITER] as Record<string, unknown> | undefined, expected.writer)
      ) {
        return {
          target: spec.target,
          status: "drift",
          details: [`${path}: OSB keys differ from canonical payload`],
          fix_hint: spec.fixHintForDrift ?? `o2b install --target ${spec.target} --apply`,
        };
      }
      // Optional MCP probe — does not penalise when it returns null.
      const probe = spec.probeMcp?.(env);
      if (probe === false) {
        return {
          target: spec.target,
          status: "mcp-unreachable",
          details: ["MCP probe failed"],
          fix_hint: "verify the runtime is running and o2b is on PATH",
        };
      }
      return {
        target: spec.target,
        status: "ok",
        details: [`${path}: both OSB keys present`],
        fix_hint: null,
      };
    },
  };
}

function ensureParent(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
