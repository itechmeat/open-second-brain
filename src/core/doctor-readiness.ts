/**
 * Fail-fast doctor readiness probes (t_cc234ff5).
 *
 * The base `doctor()` in `doctor.ts` checks static invariants (vault
 * writeability, manifest shapes). These probes go one step further and
 * check that the moving parts an operator depends on are actually wired:
 * the model-inference credential resolves, the embedding provider loads
 * and reports a model and dimension, the runtime-adapter registry can
 * build the canonical MCP payload, and the runtimes recorded as installed
 * still verify against what is on disk.
 *
 * They are opt-in (the `--readiness` CLI flag) so plain `doctor` output
 * stays byte-identical. Each probe reports exactly one member of
 * {@link READINESS_STATUS} so an unconfigured surface is never mistaken
 * for a passing one. Every probe runs under a per-check timeout: a probe
 * that would hang becomes an `unknown` with a "timed out" reason instead
 * of blocking the operator.
 *
 * That reason used to be a `fail`, and the correction is unit U12 of
 * nothing-runs-unwatched. A probe whose budget elapsed has not found the
 * surface broken; it has found out nothing at all, which is what `unknown`
 * says and what `fail` cannot. The consequence was measurable rather than
 * theoretical: on a loaded machine `o2b doctor --readiness` exited 1 -
 * "this installation is broken" - for the same system that exited 0 when
 * the box was idle, so the verdict was a property of the load average.
 * `search/provider-probe.ts` had already drawn the line one release
 * earlier for the embedding provider: only a surface that ANSWERED with a
 * refusal is a fault, and a budget that elapsed is one of the ways of
 * saying "I could not find out". The same rule now holds here, and an
 * exception escaping a probe body is classified the same way for the same
 * reason - it is evidence about the probe, not about the surface.
 *
 * That timeout covers a probe that AWAITS. It cannot cover one that blocks
 * the event loop, because the timer that would fire is queued behind the
 * work it is meant to interrupt. {@link probeInstalledRuntimes} is the one
 * probe that can: an adapter's `verify` is synchronous, and one of them
 * shells out with a synchronous spawn. The limit is stated here rather than
 * left for an operator to discover, and it is stated rather than papered
 * over with an `await` that would move the call off the stack without
 * making it interruptible.
 *
 * The `unknown` member arrived with evidence-at-the-boundary (B5), and it
 * arrived because this docblock's own claim was false. `probeRuntimeAdapterWiring`
 * reported `pass` from in-process construction alone - it never touched
 * disk - so a machine with nothing installed read as "N runtime adapter(s)
 * wired". The repair is two probes, not one: that one keeps its name and
 * now says out loud that it read no disk state, and
 * {@link probeInstalledRuntimes} answers the install question by calling
 * each registered adapter's own `verify`. A probe that could not MEASURE -
 * an install manifest that exists but will not parse - had nowhere honest
 * to go among three members and had to pick one of three wrong answers;
 * it now returns `unknown` with the reason, which is never empty.
 *
 * Determinism note: the deterministic Brain core has no in-repo chat-LLM
 * client (write-time model steps are handed back to the host as
 * `needs-llm-step` envelopes). The only model-inference credential the
 * system itself resolves is the embedding provider's API key, so the
 * "LLM key" probe resolves that.
 */

import { discoverConfig } from "./config.ts";
import {
  resolveSemanticCapability,
  SEMANTIC_CAPABILITY_CODE,
  semanticCapabilityIsBlocked,
  semanticCapabilityLabel,
} from "./search/capability-tier.ts";
import { providerProducesVectors } from "./search/embeddings/contract.ts";
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
  installedRuntimes: "installed_runtimes",
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

/**
 * The four answers a readiness probe can honestly give. None of them is a
 * softer way of saying `pass`: `skipped` is "this surface is not
 * configured, so there is nothing to measure", and `unknown` is "this
 * surface IS configured and the measurement failed", which is a fact
 * about the probe's own reach, never a guess about the surface. Both
 * carry a non-empty detail - see {@link runReadinessProbes}, which
 * enforces it rather than trusting each probe to remember.
 *
 * A budget that elapsed is `unknown`, not a fifth member. `PROVIDER_PROBE`
 * in `search/provider-probe.ts` does spell `timed-out` separately, and the
 * shapes look alike enough to invite copying it - but that vocabulary has
 * no "could not measure" member for it to collapse into, so `timed-out`
 * IS its way of saying that. Here the member already exists, and its
 * meaning - "the probe could not measure; the detail says what stopped
 * it" - is exactly what an elapsed budget reports. A `timed-out` member
 * beside it would be a second spelling of one fact, split by the
 * particular way the measurement was cut short, which every caller would
 * then have to remember to treat identically. The cause is not lost: it is
 * in the detail, which is never empty and which names the budget.
 */
export const READINESS_STATUS = Object.freeze({
  /** The probe ran and the surface answered correctly. */
  pass: "pass",
  /** The probe ran and the surface is broken; the detail names how. */
  fail: "fail",
  /** Nothing to measure: the surface is deliberately not configured. */
  skipped: "skipped",
  /** The probe could not measure; the detail says what stopped it. */
  unknown: "unknown",
} as const);

/** Closed union over {@link READINESS_STATUS}. */
export type ReadinessStatus = (typeof READINESS_STATUS)[keyof typeof READINESS_STATUS];

/** Membership list, in reporting order from best-known to least-known. */
export const READINESS_STATUSES: ReadonlyArray<ReadinessStatus> = Object.freeze([
  READINESS_STATUS.pass,
  READINESS_STATUS.fail,
  READINESS_STATUS.skipped,
  READINESS_STATUS.unknown,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isReadinessStatus(value: unknown): value is ReadinessStatus {
  return typeof value === "string" && (READINESS_STATUSES as ReadonlyArray<string>).includes(value);
}

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
  /**
   * Count of probes that could not measure - an unreadable install
   * manifest, an elapsed budget, a probe body that threw. Deliberately NOT
   * folded into `failed`: an unmeasured surface is not a broken one, and a
   * caller must never read "0 failed" as "everything was checked". It is
   * not folded into a silent 0 either - the CLI spends a distinct exit
   * code on it (`DOCTOR_EXIT.probeIncomplete` in `cli/main.ts`), because
   * both silences say something this run did not establish.
   */
  readonly unknown: number;
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
    return {
      status: READINESS_STATUS.skipped,
      detail: "semantic search disabled; no model API key required",
    };
  }
  if (!PROVIDERS_REQUIRING_API_KEY.has(semantic.provider)) {
    return {
      status: READINESS_STATUS.skipped,
      detail: `provider '${semantic.provider}' needs no API key`,
    };
  }
  const keyCount = semantic.apiKeys?.length ?? (semantic.apiKey ? 1 : 0);
  if (keyCount > 0) {
    return {
      status: READINESS_STATUS.pass,
      detail: `resolved ${keyCount} candidate key(s) for provider '${semantic.provider}'`,
    };
  }
  return {
    status: READINESS_STATUS.fail,
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
 *
 * A configuration the operator has not finished is `skipped`, not
 * `failed`, and WHICH configuration it is comes from the shared
 * capability tier (provenance-at-the-boundary, F1). Two consequences,
 * both deliberate: the sentinel provider is now recognised by the
 * contract predicate rather than by the literal name it happens to
 * carry, and a key-less remote provider is refused HERE instead of
 * making a credential-free outbound request whose only possible outcome
 * is an auth error. `probeLlmKey` above is the probe that reports the
 * missing key as a failure, so nothing is lost by skipping here.
 */
export async function probeEmbeddingProvider(opts: ReadinessOptions): Promise<ReadinessVerdict> {
  const configPath = resolveConfigPath(opts);
  let semantic;
  try {
    semantic = resolveSearchConfig({ vault: opts.vault, configPath }).semantic;
  } catch (err) {
    return {
      status: READINESS_STATUS.fail,
      detail: `config failed to resolve: ${(err as Error).message}`,
    };
  }
  // The tier is read BEFORE the provider is constructed: a provider whose
  // credential is missing refuses at construction, and reporting that as
  // "failed to load" described the wrong thing entirely.
  const capability = resolveSemanticCapability(semantic);
  if (semanticCapabilityIsBlocked(capability)) {
    return {
      status: READINESS_STATUS.skipped,
      detail: await semanticCapabilityLabel(capability.code),
    };
  }
  let provider;
  try {
    provider = makeProvider(semantic);
  } catch (err) {
    return {
      status: READINESS_STATUS.fail,
      detail: `provider failed to load: ${(err as Error).message}`,
    };
  }
  // A provider that embeds nothing IS the `disabled` capability, whatever
  // the rest of the configuration says, so it names that code rather than
  // the tier's - the two agree for every provider in the tree and this
  // keeps them agreeing for one that is added later.
  if (!providerProducesVectors(provider)) {
    return {
      status: READINESS_STATUS.skipped,
      detail: await semanticCapabilityLabel(SEMANTIC_CAPABILITY_CODE.disabled),
    };
  }
  const pong = await provider.ping();
  if (!pong.ok) {
    return {
      status: READINESS_STATUS.fail,
      detail: `provider '${provider.name}' did not respond: ${pong.reason}`,
    };
  }
  if (provider.model === "" || pong.dimension <= 0) {
    return {
      status: READINESS_STATUS.fail,
      detail: `provider '${provider.name}' responded but reported an empty model or non-positive dimension`,
    };
  }
  return {
    status: READINESS_STATUS.pass,
    detail: `provider '${provider.name}' model '${provider.model}' responded with ${pong.dimension} dims`,
  };
}

/**
 * The `InstallEnv` both install-facing probes hand to the adapters. One
 * builder so the construction probe and the installed-state probe cannot
 * disagree about which HOME, cwd or environment a runtime is judged
 * against - a disagreement there would make the two verdicts describe two
 * different machines.
 */
function installEnvFor(opts: ReadinessOptions): InstallEnv {
  // InstallEnv.env is a defined-only string map; drop any undefined values
  // that a raw `process.env` snapshot may carry.
  const rawEnv = opts.env ?? process.env;
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof v === "string") cleanEnv[k] = v;
  }
  return {
    vault: opts.vault,
    home: opts.home ?? process.env["HOME"] ?? opts.vault,
    cwd: opts.cwd ?? process.cwd(),
    env: cleanEnv,
    now: new Date(),
  };
}

/**
 * The runtime-adapter registry is populated, every adapter can build a
 * plan, and the canonical MCP payload builds - the wiring every install
 * target depends on.
 *
 * What this probe deliberately does NOT answer: whether any runtime is
 * actually installed. It reads no disk state, calls neither `detect` nor
 * `verify`, and would report `pass` on a machine where nothing has ever
 * been installed - which is exactly what it used to claim with the words
 * "N runtime adapter(s) wired", and exactly why that wording is gone.
 * {@link probeInstalledRuntimes} is the probe that answers the install
 * question, and the detail below names it so an operator reading one
 * verdict knows where the other lives.
 */
export async function probeRuntimeAdapterWiring(opts: ReadinessOptions): Promise<ReadinessVerdict> {
  registerAllAdapters();
  const targets = defaultRegistry.targets();
  if (targets.length === 0) {
    return { status: READINESS_STATUS.fail, detail: "no runtime adapters registered" };
  }
  const env = installEnvFor(opts);
  let payload;
  try {
    payload = buildPayload({ vault: opts.vault, agent_name: null, timezone: null });
  } catch (err) {
    return {
      status: READINESS_STATUS.fail,
      detail: `MCP payload failed to build: ${(err as Error).message}`,
    };
  }
  for (const target of targets) {
    const adapter = defaultRegistry.get(target);
    if (!adapter) {
      return { status: READINESS_STATUS.fail, detail: `registry lost adapter '${target}'` };
    }
    try {
      adapter.plan(payload, env);
    } catch (err) {
      return {
        status: READINESS_STATUS.fail,
        detail: `adapter '${target}' failed to plan: ${(err as Error).message}`,
      };
    }
  }
  return {
    status: READINESS_STATUS.pass,
    detail:
      `${targets.length} runtime adapter(s) construct a plan and the MCP payload builds; ` +
      `no disk state read - '${READINESS_PROBE.installedRuntimes}' answers whether any ` +
      "runtime is installed",
  };
}

/**
 * What is actually installed on this machine, read off disk through each
 * registered adapter's OWN `verify(env)`.
 *
 * Delegating to `verify` rather than re-reading the runtime config files
 * here is the whole point: the adapter already knows where its config
 * lives, what the canonical payload looks like for it, and - for the
 * runtimes that have a CLI to ask (`copilot-cli`, `codex`) - how to
 * consult the runtime itself. Re-implementing any of that in a doctor
 * probe would
 * produce a second, quietly divergent opinion about the same disk.
 *
 * The closed `VerifyStatus` vocabulary maps onto readiness with no
 * default arm, so a fifth verify status fails the typecheck here instead
 * of silently landing in whichever bucket a `default:` happened to name.
 * A `verify` that THROWS - the sidecar install manifest exists but will
 * not parse, or a runtime CLI that cannot be spawned - is `unknown` for
 * that target with the thrown reason. It is emphatically not a skip: a
 * manifest we cannot read is not a machine with nothing installed.
 */
/**
 * NOTE ON THE TIMEOUT: every `verify` here is synchronous, and both
 * `copilot-cli` and `codex` verify by spawning their own CLI
 * synchronously. While that spawn runs, the event loop is blocked and the
 * runner's timeout timer
 * cannot fire, so this probe is the one the module-level timeout promise
 * does not cover. Making it interruptible means an async adapter contract,
 * which is a change to every adapter and belongs in its own unit.
 */
export async function probeInstalledRuntimes(opts: ReadinessOptions): Promise<ReadinessVerdict> {
  registerAllAdapters();
  const adapters = defaultRegistry.list();
  if (adapters.length === 0) {
    return { status: READINESS_STATUS.fail, detail: "no runtime adapters registered" };
  }
  const env = installEnvFor(opts);
  const broken: string[] = [];
  const unmeasured: string[] = [];
  const installed: string[] = [];
  const absent: string[] = [];

  for (const adapter of adapters) {
    let result;
    try {
      result = adapter.verify(env);
    } catch (err) {
      unmeasured.push(`${adapter.target}: ${flattenReason((err as Error).message)}`);
      continue;
    }
    const reason = `${adapter.target}: ${result.details.join("; ")}`;
    switch (result.status) {
      case "ok":
        installed.push(adapter.target);
        break;
      case "drift":
      case "mcp-unreachable":
        broken.push(result.fix_hint === null ? reason : `${reason} - fix: ${result.fix_hint}`);
        break;
      case "not-installed":
        absent.push(adapter.target);
        break;
      default: {
        // Exhaustiveness over the closed `VerifyStatus` set: a fifth
        // member stops compiling here rather than being folded into
        // whichever bucket a permissive default happened to name. Should
        // one ever arrive from a JavaScript caller at runtime, it lands in
        // `unmeasured` - the only bucket that claims nothing.
        const unmapped: never = result.status;
        unmeasured.push(`${adapter.target}: unmapped verify status '${String(unmapped)}'`);
        break;
      }
    }
  }

  // Precedence, worst-known first: a runtime PROVED broken outranks one we
  // could not measure, which outranks a verified install, which outranks a
  // machine where nothing is installed at all. The counts below travel with
  // every verdict so the winning bucket never hides the others.
  const census =
    `(${installed.length} ok, ${broken.length} broken, ` +
    `${unmeasured.length} unmeasured, ${absent.length} not-installed)`;
  if (broken.length > 0) {
    return {
      status: READINESS_STATUS.fail,
      detail: `${broken.length} runtime(s) verified broken ${census}: ${broken.join("; ")}`,
    };
  }
  if (unmeasured.length > 0) {
    return {
      status: READINESS_STATUS.unknown,
      detail: `could not verify ${unmeasured.length} runtime(s) ${census}: ${unmeasured.join("; ")}`,
    };
  }
  if (installed.length > 0) {
    return {
      status: READINESS_STATUS.pass,
      detail: `${installed.length} runtime(s) verified installed ${census}: ${installed.join(", ")}`,
    };
  }
  return {
    status: READINESS_STATUS.skipped,
    detail: `no runtime installed: all ${absent.length} registered target(s) report not-installed`,
  };
}

/** One-line an error message so a multi-line reason stays one probe detail. */
function flattenReason(message: string): string {
  return message.replace(/\s+/g, " ").trim();
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
  { name: READINESS_PROBE.installedRuntimes, fn: probeInstalledRuntimes },
];

/**
 * Run every readiness probe under its per-check timeout and aggregate the
 * outcomes. A probe that throws or times out becomes an `unknown` with a
 * reason rather than aborting the run, so one unreadable surface never
 * hides the others and none of them is reported as broken on the strength
 * of a measurement that never completed. `probes` is injectable for
 * testing the timeout and aggregation paths deterministically; it defaults
 * to {@link DEFAULT_PROBES}.
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
        // Neither arm has heard from the surface: one budget elapsed, one
        // probe body threw. Both are reported as what they are - a
        // measurement that did not complete - with the cause in the detail.
        const detail =
          err instanceof ReadinessTimeoutError
            ? `timed out after ${timeoutMs}ms, so nothing was established about this surface`
            : `probe error, so nothing was established about this surface: ${(err as Error).message}`;
        verdict = { status: READINESS_STATUS.unknown, detail };
      }
      return {
        name: probe.name,
        ...withNonEmptyDetail(probe.name, verdict),
        durationMs: Date.now() - startedAt,
      };
    }),
  );
  const failed = results.filter((p) => p.status === READINESS_STATUS.fail).length;
  const unknown = results.filter((p) => p.status === READINESS_STATUS.unknown).length;
  return { probes: results, failed, unknown };
}

/**
 * A verdict whose detail is blank claims a status and gives no evidence
 * for it, which is precisely the shape this module exists to refuse. The
 * rule is enforced HERE, once, rather than asserted in each probe's
 * docblock and trusted: a detail-less verdict becomes `unknown` naming
 * the probe and the status it could not substantiate. Rejected
 * alternative: throwing, which would turn a probe's sloppiness into a
 * `fail` and so report a working surface as broken.
 */
function withNonEmptyDetail(name: string, verdict: ReadinessVerdict): ReadinessVerdict {
  if (verdict.detail.trim().length > 0) return verdict;
  return {
    status: READINESS_STATUS.unknown,
    detail: `probe '${name}' claimed '${verdict.status}' with no detail, so the claim is unverified`,
  };
}
