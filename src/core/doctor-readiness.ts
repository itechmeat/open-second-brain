/**
 * Fail-fast doctor readiness probes (t_cc234ff5).
 *
 * The base `doctor()` in `doctor.ts` checks static invariants (vault
 * writeability, manifest shapes). These probes go one step further and
 * check that the moving parts an operator depends on are actually wired:
 * the model-inference credential resolves, the embedding provider loads
 * and reports a model and dimension, and the runtime-adapter registry can
 * build the canonical MCP payload.
 *
 * They are opt-in (the `--readiness` CLI flag) so plain `doctor` output
 * stays byte-identical. Each probe reports exactly one of three outcomes -
 * `pass`, `fail` (always with a reason), or `skipped` (not configured) -
 * so an unconfigured surface is never mistaken for a passing one. Every
 * probe runs under a per-check timeout: a probe that would hang becomes a
 * `fail` with a "timed out" reason instead of blocking the operator.
 *
 * Determinism note: the deterministic Brain core has no in-repo chat-LLM
 * client (write-time model steps are handed back to the host as
 * `needs-llm-step` envelopes). The only model-inference credential the
 * system itself resolves is the embedding provider's API key, so the
 * "LLM key" probe resolves that.
 */

import { discoverConfig } from "./config.ts";
import { makeProvider } from "./search/embeddings/provider.ts";
import { resolveSearchConfig } from "./search/index.ts";
import { buildPayload } from "./install/payload.ts";
import { defaultRegistry } from "./install/registry.ts";
import { registerAllAdapters } from "./install/adapters/all.ts";
import type { InstallEnv } from "./install/types.ts";

// ----- Constants ------------------------------------------------------------

/** Default per-check timeout budget for a single readiness probe. */
export const DEFAULT_READINESS_TIMEOUT_MS = 5_000;

/** Stable probe identifiers (also the machine keys in JSON output). */
export const READINESS_PROBE = {
  llmKey: "llm_key",
  embeddingProvider: "embedding_provider",
  runtimeAdapterWiring: "runtime_adapter_wiring",
} as const;

/**
 * Embedding providers that authenticate with an API key. `local` and
 * `disabled` need none, so the key probe reports `skipped` for them.
 */
const PROVIDERS_REQUIRING_API_KEY: ReadonlySet<string> = new Set(["openai-compat", "zeroentropy"]);

// ----- Errors ---------------------------------------------------------------

/** Raised when a probe exceeds its per-check timeout budget. */
export class ReadinessTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`readiness probe '${label}' timed out after ${timeoutMs}ms`);
    this.name = "ReadinessTimeoutError";
  }
}

// ----- Types ----------------------------------------------------------------

export type ReadinessStatus = "pass" | "fail" | "skipped";

/** The bare outcome a probe body returns, before timing is attached. */
export interface ReadinessVerdict {
  readonly status: ReadinessStatus;
  readonly detail: string;
}

/** A completed probe: its verdict plus the name and wall-clock duration. */
export interface ReadinessProbeResult extends ReadinessVerdict {
  readonly name: string;
  readonly durationMs: number;
}

export interface ReadinessReport {
  readonly probes: ReadonlyArray<ReadinessProbeResult>;
  /** Count of probes whose status is `fail`. Drives the non-zero exit code. */
  readonly failed: number;
}

export interface ReadinessOptions {
  readonly vault: string;
  readonly config?: string | null;
  readonly cwd?: string;
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Per-check timeout budget; defaults to {@link DEFAULT_READINESS_TIMEOUT_MS}. */
  readonly perCheckTimeoutMs?: number;
}

// ----- Timeout wrapper ------------------------------------------------------

/**
 * Run `fn` and reject with {@link ReadinessTimeoutError} if it does not
 * settle within `timeoutMs`. The timer is always cleared so a fast
 * resolution never leaves a dangling handle.
 */
export function withReadinessTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ReadinessTimeoutError(label, timeoutMs));
    }, timeoutMs);
    fn().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

// ----- Probes ---------------------------------------------------------------

function resolveConfigPath(opts: ReadinessOptions): string | undefined {
  if (opts.config) return opts.config;
  try {
    return discoverConfig().path;
  } catch {
    return undefined;
  }
}

/**
 * The model-inference credential resolves. See the module note: this is
 * the embedding provider's API key, the only model credential the
 * deterministic core resolves itself.
 */
export async function probeLlmKey(opts: ReadinessOptions): Promise<ReadinessVerdict> {
  const configPath = resolveConfigPath(opts);
  const { semantic } = resolveSearchConfig({ vault: opts.vault, configPath });
  if (!semantic.enabled || semantic.provider === "disabled") {
    return { status: "skipped", detail: "semantic search disabled; no model API key required" };
  }
  if (!PROVIDERS_REQUIRING_API_KEY.has(semantic.provider)) {
    return {
      status: "skipped",
      detail: `provider '${semantic.provider}' needs no API key`,
    };
  }
  const keyCount = semantic.apiKeys?.length ?? (semantic.apiKey ? 1 : 0);
  if (keyCount > 0) {
    return {
      status: "pass",
      detail: `resolved ${keyCount} candidate key(s) for provider '${semantic.provider}'`,
    };
  }
  return {
    status: "fail",
    detail:
      `provider '${semantic.provider}' requires an API key but none resolves ` +
      "from config or env (embedding_api_key / OPEN_SECOND_BRAIN_EMBEDDING_KEY)",
  };
}

/**
 * The embedding provider loads and reports a model and a positive
 * dimension. The provider's `ping()` is the authoritative source of the
 * dimension (a cloud provider learns it from the first response), so the
 * probe pings under the per-check timeout rather than trusting config.
 */
export async function probeEmbeddingProvider(opts: ReadinessOptions): Promise<ReadinessVerdict> {
  const configPath = resolveConfigPath(opts);
  let provider;
  try {
    const { semantic } = resolveSearchConfig({ vault: opts.vault, configPath });
    provider = makeProvider(semantic);
  } catch (err) {
    return { status: "fail", detail: `provider failed to load: ${(err as Error).message}` };
  }
  if (provider.name === "null") {
    return { status: "skipped", detail: "semantic search disabled; no embedding provider" };
  }
  const pong = await provider.ping();
  if (!pong.ok) {
    return {
      status: "fail",
      detail: `provider '${provider.name}' did not respond: ${pong.reason}`,
    };
  }
  if (provider.model === "" || pong.dimension <= 0) {
    return {
      status: "fail",
      detail: `provider '${provider.name}' responded but reported an empty model or non-positive dimension`,
    };
  }
  return {
    status: "pass",
    detail: `provider '${provider.name}' model '${provider.model}' responded with ${pong.dimension} dims`,
  };
}

/**
 * The runtime-adapter registry is populated and the canonical MCP payload
 * builds - the wiring every install target depends on. This is a
 * construction check, not a per-runtime detection: it confirms the seam
 * that turns a vault into installable MCP server entries is intact.
 */
export async function probeRuntimeAdapterWiring(opts: ReadinessOptions): Promise<ReadinessVerdict> {
  registerAllAdapters();
  const targets = defaultRegistry.targets();
  if (targets.length === 0) {
    return { status: "fail", detail: "no runtime adapters registered" };
  }
  const now = new Date();
  // InstallEnv.env is a defined-only string map; drop any undefined values
  // that a raw `process.env` snapshot may carry.
  const rawEnv = opts.env ?? process.env;
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof v === "string") cleanEnv[k] = v;
  }
  const env: InstallEnv = {
    vault: opts.vault,
    home: opts.home ?? process.env["HOME"] ?? opts.vault,
    cwd: opts.cwd ?? process.cwd(),
    env: cleanEnv,
    now,
  };
  let payload;
  try {
    payload = buildPayload({ vault: opts.vault, agent_name: null, timezone: null });
  } catch (err) {
    return { status: "fail", detail: `MCP payload failed to build: ${(err as Error).message}` };
  }
  for (const target of targets) {
    const adapter = defaultRegistry.get(target);
    if (!adapter) {
      return { status: "fail", detail: `registry lost adapter '${target}'` };
    }
    try {
      adapter.plan(payload, env);
    } catch (err) {
      return {
        status: "fail",
        detail: `adapter '${target}' failed to plan: ${(err as Error).message}`,
      };
    }
  }
  return {
    status: "pass",
    detail: `${targets.length} runtime adapter(s) wired; MCP payload builds`,
  };
}

// ----- Runner ---------------------------------------------------------------

export interface NamedProbe {
  readonly name: string;
  readonly fn: (opts: ReadinessOptions) => Promise<ReadinessVerdict>;
}

/** The default probe set, in stable output order. */
export const DEFAULT_PROBES: ReadonlyArray<NamedProbe> = [
  { name: READINESS_PROBE.llmKey, fn: probeLlmKey },
  { name: READINESS_PROBE.embeddingProvider, fn: probeEmbeddingProvider },
  { name: READINESS_PROBE.runtimeAdapterWiring, fn: probeRuntimeAdapterWiring },
];

/**
 * Run every readiness probe under its per-check timeout and aggregate the
 * outcomes. A probe that throws or times out becomes a `fail` with a
 * reason rather than aborting the run, so one broken surface never hides
 * the others. `probes` is injectable for testing the timeout and
 * aggregation paths deterministically; it defaults to {@link DEFAULT_PROBES}.
 */
export async function runReadinessProbes(
  opts: ReadinessOptions,
  probes: ReadonlyArray<NamedProbe> = DEFAULT_PROBES,
): Promise<ReadinessReport> {
  const timeoutMs = opts.perCheckTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  // Probes are independent, so run them together; the mapped array preserves
  // input order regardless of which settles first.
  const results = await Promise.all(
    probes.map(async (probe): Promise<ReadinessProbeResult> => {
      const startedAt = Date.now();
      let verdict: ReadinessVerdict;
      try {
        verdict = await withReadinessTimeout(() => probe.fn(opts), timeoutMs, probe.name);
      } catch (err) {
        const detail =
          err instanceof ReadinessTimeoutError
            ? `timed out after ${timeoutMs}ms`
            : `probe error: ${(err as Error).message}`;
        verdict = { status: "fail", detail };
      }
      return { name: probe.name, ...verdict, durationMs: Date.now() - startedAt };
    }),
  );
  const failed = results.filter((p) => p.status === "fail").length;
  return { probes: results, failed };
}
