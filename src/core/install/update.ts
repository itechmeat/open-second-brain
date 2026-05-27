import { createHash } from "node:crypto";

import type { Registry } from "./registry.ts";
import { buildPayload } from "./payload.ts";
import { InstallError } from "./types.ts";
import type {
  ApplyOpts,
  InstallAdapter,
  InstallEnv,
  InstallStepKind,
  McpPayload,
  VerifyResult,
} from "./types.ts";
import { readManifest, recordEntry } from "./manifest.ts";

export interface UpdateTargetResult {
  readonly target: string;
  readonly status: "applied" | "up-to-date" | "skipped" | "would-apply" | "error";
  readonly reason?: string;
  readonly postNotes?: ReadonlyArray<string>;
  readonly error?: string;
  readonly hint?: string;
  readonly kind?: InstallStepKind | "user-modified-block";
}

export interface UpdateResult {
  readonly targets: ReadonlyArray<UpdateTargetResult>;
}

export interface UpdateOptions {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly target: string | null;
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      out[key] = (value as Record<string, unknown>)[key];
    }
    return out;
  }
  return value;
}

function computePayloadHash(payload: McpPayload): string {
  return createHash("sha256").update(JSON.stringify(payload, sortedReplacer)).digest("hex");
}

function targetList(registry: Registry, target: string | null): ReadonlyArray<InstallAdapter> {
  if (target) {
    const adapter = registry.get(target);
    return adapter ? [adapter] : [];
  }
  return registry.list();
}

export function runUpdate(registry: Registry, env: InstallEnv, opts: UpdateOptions): UpdateResult {
  const manifest = readManifest(env.vault);
  const results: UpdateTargetResult[] = [];

  for (const adapter of targetList(registry, opts.target)) {
    const detect = adapter.detect(env);

    if (detect.status === "not-installed" || detect.status === "unsupported-on-this-platform") {
      results.push({
        target: adapter.target,
        status: "skipped",
        reason: `${adapter.label} is ${detect.status}`,
        postNotes: detect.notes.length > 0 ? detect.notes : undefined,
      });
      continue;
    }

    let payload: McpPayload;
    try {
      payload = buildPayload({
        vault: env.vault,
        agent_name: env.env["VAULT_AGENT_NAME"] ?? null,
        timezone: env.env["VAULT_TIMEZONE"] ?? null,
      });
    } catch (exc) {
      results.push({
        target: adapter.target,
        status: "error",
        error: `Failed to build payload: ${(exc as Error).message}`,
      });
      continue;
    }

    const currentHash = computePayloadHash(payload);
    const previous = manifest.installs[adapter.target];
    if (previous?.payload_hash === currentHash && !opts.force) {
      results.push({ target: adapter.target, status: "up-to-date", reason: "payload unchanged" });
      continue;
    }

    const plan = adapter.plan(payload, env);

    if (opts.dryRun) {
      results.push({ target: adapter.target, status: "would-apply", postNotes: plan.postNotes });
      continue;
    }

    const applyOpts: ApplyOpts = {
      dryRun: false,
      force: opts.force,
      stdout: process.stdout,
      stderr: process.stderr,
    };

    try {
      const applyResult = adapter.apply(plan, payload, env, applyOpts);
      recordEntry(env.vault, { ...applyResult.manifest, payload_hash: currentHash });
    } catch (exc) {
      if (exc instanceof InstallError) {
        results.push({
          target: adapter.target,
          status: "error",
          error: exc.message,
          hint: exc.hint,
          kind: exc.kind === "user-modified-block" ? "user-modified-block" : undefined,
        });
      } else {
        results.push({ target: adapter.target, status: "error", error: (exc as Error).message });
      }
      continue;
    }

    results.push({ target: adapter.target, status: "applied", postNotes: plan.postNotes });
  }

  return { targets: results };
}

export type { VerifyResult };
