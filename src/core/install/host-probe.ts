/**
 * Asking a host what it has actually registered.
 *
 * Every JSON-config adapter's `verify()` ended on one sentence -
 * {@link NO_HANDSHAKE_NOTE} - because a config comparison is all it did.
 * That sentence is honest where nothing better is available and a lie of
 * omission where something is: {@link RUNTIME_FACTS} declares a
 * `hostProbe` for the runtimes that can be ASKED, and a target that
 * carries one has no business printing "no handshake attempted" when the
 * handshake is one keyless subprocess away.
 *
 * Three rules this module is written under:
 *
 *   - **Keyless and free.** The probe asks the host which servers it has
 *     registered. It starts no model turn, needs no API key, and writes
 *     nothing. `RUNTIME_FACTS[t].hostProbe.answers` states, per row, what
 *     a successful run establishes.
 *   - **A skip is named.** The absence of an answer is a member of
 *     {@link HOST_PROBE_RESULT} carrying the reason - the binary is not on
 *     PATH, or it exited non-zero with this stderr - never an assumed
 *     `ok`. A probe that reports success when it could not run is the
 *     misleading default this module exists to remove.
 *   - **The subprocess is injectable.** {@link setHostProbeRunner} is the
 *     seam, exactly as `CopilotRunner` already is for that adapter's
 *     mutation commands, so both branches are drivable in a test on a
 *     machine where the host binary does not exist.
 *   - **The host asked is the host being verified.** The probe takes the
 *     adapter's own {@link InstallEnv} and spawns under
 *     {@link hostProbeEnvironment}, never under the ambient process
 *     environment. `codex.ts` declares "the Codex home is injected, never
 *     ambient" for its mutation runner; a probe that ignored the same
 *     injection would let a relocated `CODEX_HOME` verify `ok` against the
 *     operator's real `~/.codex`, which is a wrong answer wearing a live
 *     host's authority.
 *
 * ## Two verdicts for one probe answer
 *
 * "The host answered and does not list our servers" is not one condition,
 * and {@link probeRefutedVerdict} is the one place that splits it:
 *
 *   - the registration is backed by an ARTIFACT this build wrote and that
 *     artifact still matches the canonical payload. The configuration is
 *     right and the host has not loaded it, so the verdict is
 *     `mcp-unreachable` and the repair is a restart. Re-applying would
 *     rewrite bytes that are already correct and change nothing.
 *   - the host's own registry IS the record - `copilot mcp add` leaves no
 *     file, and a Codex config that does not declare the tables has no
 *     artifact to be right - so the host saying "no" means the
 *     registration is gone. The verdict is `drift` and the repair is
 *     `--apply`.
 *
 * Stated here rather than in each adapter because the three probe-bearing
 * bodies reached the same two verdicts by three separate arguments, and a
 * rule argued three times is a rule that will be argued differently once.
 *
 * LEAF module: `RUNTIME_FACTS`, the install types and the two server-key
 * constants, and nothing from `./adapters/`.
 * `src/core/install/adapters/_json-mcp.ts` and `copilot-cli.ts` read it;
 * importing either back into here would close a cycle
 * `tests/core/architecture/import-cycles.test.ts` gates.
 */

import { RUNTIME_FACTS, type HostProbeSpec, type InstallTargetId } from "../runtime/host-facts.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "./json-merge.ts";
import type { InstallEnv, VerifyStatus } from "./types.ts";

/**
 * Stated on every clean `verify` of a target that declares no probe, so
 * an `ok` cannot be read as "the runtime answered". One constant, because
 * the sentence is a property of the whole install surface and every
 * target that cannot be asked must say it the same way.
 */
export const NO_HANDSHAKE_NOTE = "configuration comparison; no MCP handshake attempted";

/** The two server names an Open Second Brain install registers. */
const OSB_SERVER_KEYS: ReadonlyArray<string> = Object.freeze([OSB_KEY_FULL, OSB_KEY_WRITER]);

/**
 * What came back when this build asked a host about its registrations.
 *
 * `not-declared` is a member rather than an absent value: "this runtime
 * publishes no way to ask it" is an answer, and it is the one that earns
 * {@link NO_HANDSHAKE_NOTE}. No guard ships with it - unlike the target
 * ids, these values never arrive from argv or a config file, so there is
 * no raw boundary for a guard to stand on.
 */
export const HOST_PROBE_RESULT = Object.freeze({
  answered: "answered",
  binaryMissing: "binary-missing",
  probeFailed: "probe-failed",
  notDeclared: "not-declared",
} as const);

export type HostProbeResult = (typeof HOST_PROBE_RESULT)[keyof typeof HOST_PROBE_RESULT];

/** The host ran the probe and named its registrations. */
export interface AnsweredProbe {
  readonly kind: typeof HOST_PROBE_RESULT.answered;
  /** `bin` plus `argv`, the way a reader would re-run it. */
  readonly command: string;
  /** OSB server names the host reported. */
  readonly registered: ReadonlyArray<string>;
  /** OSB server names it did not report. Empty is the clean answer. */
  readonly missing: ReadonlyArray<string>;
}

/** The probe could not run, and this is why. */
export interface SkippedProbe {
  readonly kind: typeof HOST_PROBE_RESULT.binaryMissing | typeof HOST_PROBE_RESULT.probeFailed;
  readonly command: string;
  /** A sentence naming the obstacle; never empty. */
  readonly reason: string;
}

/** The runtime publishes nothing to ask. */
export interface UndeclaredProbe {
  readonly kind: typeof HOST_PROBE_RESULT.notDeclared;
}

export type HostProbeOutcome = AnsweredProbe | SkippedProbe | UndeclaredProbe;

/** One probe run, as the seam reports it. */
export interface HostProbeRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The machine the probe is asked ABOUT, as a child process environment.
 *
 * `InstallEnv.env` is the environment the adapter writes its artifacts
 * against, and `InstallEnv.home` is the home those artifacts are resolved
 * under - which is not necessarily the ambient `HOME`, because every
 * install surface accepts an injected one. `HOME` is set from it so a host
 * that derives its own configuration directory (`~/.codex`,
 * `~/.config/github-copilot`) derives the SAME one the adapter just wrote,
 * and an explicit `CODEX_HOME` / `XDG_CONFIG_HOME` already in `env.env`
 * rides through untouched.
 */
export type HostProbeEnvironment = Readonly<Record<string, string>>;

export function hostProbeEnvironment(env: InstallEnv): HostProbeEnvironment {
  return { ...env.env, HOME: env.home };
}

/**
 * How long a probe may take before it is a failed probe.
 *
 * `o2b install --check` is a synchronous command an operator runs to find
 * out whether their machine is wired up. A host CLI that blocks on a
 * network call or an interactive authentication prompt would hang it with
 * no way out and no message, which is worse than the named skip a refusal
 * produces - so the wait is bounded and the timeout becomes one more named
 * reason. Generous enough that a cold process start on a loaded machine
 * is not reported as a broken host.
 */
export const HOST_PROBE_TIMEOUT_MS = 10_000;

/**
 * The subprocess seam. `available` answers whether the binary resolves on
 * PATH at all, which is a different failure from a binary that ran and
 * refused - the two produce different named skips, so they cannot share a
 * branch. Both take the {@link HostProbeEnvironment} because both questions
 * are about the injected machine: the PATH that resolves the binary is the
 * one that machine has.
 */
export interface HostProbeRunner {
  available(bin: string, env: HostProbeEnvironment): boolean;
  run(bin: string, argv: ReadonlyArray<string>, env: HostProbeEnvironment): HostProbeRunResult;
}

/**
 * The real subprocess runner, with its wait bounded by `timeoutMs`.
 *
 * A factory rather than a constant so the timeout branch is drivable
 * against a harmless slow binary in a fraction of a second, instead of
 * being the one path in this module that ships untested because exercising
 * it would mean waiting {@link HOST_PROBE_TIMEOUT_MS} for it.
 */
export function createHostProbeRunner(timeoutMs: number): HostProbeRunner {
  return {
    available(bin: string, env: HostProbeEnvironment): boolean {
      try {
        const path = env["PATH"];
        return (path === undefined ? Bun.which(bin) : Bun.which(bin, { PATH: path })) !== null;
      } catch {
        return false;
      }
    },
    run(bin: string, argv: ReadonlyArray<string>, env: HostProbeEnvironment): HostProbeRunResult {
      try {
        const r = Bun.spawnSync({
          cmd: [bin, ...argv],
          env: { ...env },
          stdout: "pipe",
          stderr: "pipe",
          timeout: timeoutMs,
        });
        if (r.signalCode !== null) {
          // A killed child has no answer to report, and its partial stdout
          // must not be parsed as one. The signal is named because the
          // timeout kill and a host that crashed arrive the same way, and
          // guessing between them would be inventing the reason.
          return {
            exitCode: r.exitCode ?? 1,
            stdout: "",
            stderr: `killed by ${r.signalCode}; the probe is capped at ${timeoutMs} ms`,
          };
        }
        return {
          exitCode: r.exitCode ?? 1,
          stdout: r.stdout?.toString() ?? "",
          stderr: r.stderr?.toString() ?? "",
        };
      } catch (e) {
        // The shell's own "command not found" code, so the reason a reader
        // sees is the reason the shell would have printed.
        return { exitCode: 127, stdout: "", stderr: (e as Error).message };
      }
    },
  };
}

const defaultRunner: HostProbeRunner = createHostProbeRunner(HOST_PROBE_TIMEOUT_MS);

let activeRunner: HostProbeRunner = defaultRunner;

export function setHostProbeRunner(runner: HostProbeRunner): void {
  activeRunner = runner;
}

export function resetHostProbeRunner(): void {
  activeRunner = defaultRunner;
}

/** The probe as a reader would re-run it. */
export function hostProbeCommand(spec: HostProbeSpec): string {
  return [spec.bin, ...spec.argv].join(" ");
}

/**
 * The OSB server names `stdout` reports.
 *
 * The first whitespace-delimited token of each line is the name column of
 * every `mcp list` output this build has seen; anything else on the line
 * (a state, a transport, a command) is not compared. Only the two names
 * this tool registers are returned, so a host with fifty other servers
 * answers the same question as a host with none.
 *
 * The HEADER row of a padded table (`Name  Command  Args …`, which is what
 * real `codex mcp list` prints - see
 * `tests/fixtures/install/codex-mcp-list.txt`) therefore contributes the
 * token `Name`, and that is left in rather than stripped. Stripping it
 * would mean recognising each host's header, which is a per-host grammar
 * this build would then have to keep up with; leaving it in is safe by
 * CONSTRUCTION rather than by luck, because the return value is an
 * intersection with two fixed names and no host can print a column header
 * called `open-second-brain`. `tests/core/install/host-probe.test.ts`
 * drives the real capture and holds that property.
 */
function registeredNames(stdout: string): ReadonlyArray<string> {
  const tokens = new Set(
    stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((token) => token.length > 0),
  );
  return OSB_SERVER_KEYS.filter((key) => tokens.has(key));
}

/** The first non-empty line of `text`, trimmed; `""` when there is none. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

/**
 * Ask `target`'s host what it has registered.
 *
 * Total: a target with no declared probe gets {@link UndeclaredProbe}
 * rather than a thrown error, because "nothing to ask" is the answer the
 * majority of rows legitimately have.
 */
export function probeHost(target: InstallTargetId, env: InstallEnv): HostProbeOutcome {
  const spec = RUNTIME_FACTS[target].hostProbe;
  if (spec === null) return { kind: HOST_PROBE_RESULT.notDeclared };
  const command = hostProbeCommand(spec);
  const probeEnv = hostProbeEnvironment(env);
  if (!activeRunner.available(spec.bin, probeEnv)) {
    return {
      kind: HOST_PROBE_RESULT.binaryMissing,
      command,
      reason: `\`${spec.bin}\` is not on PATH`,
    };
  }
  const run = activeRunner.run(spec.bin, spec.argv, probeEnv);
  if (run.exitCode !== 0) {
    const stderr = firstLine(run.stderr);
    return {
      kind: HOST_PROBE_RESULT.probeFailed,
      command,
      reason:
        `\`${command}\` exited ${run.exitCode}` +
        (stderr.length > 0 ? `: ${stderr}` : " with no output"),
    };
  }
  const registered = registeredNames(run.stdout);
  return {
    kind: HOST_PROBE_RESULT.answered,
    command,
    registered,
    missing: OSB_SERVER_KEYS.filter((key) => !registered.includes(key)),
  };
}

/**
 * The clause a `verify` detail carries about host confirmation.
 *
 * One function so the JSON-config adapter body and the Copilot adapter
 * cannot word the same four outcomes differently - the drift that let one
 * of them print a blanket claim while the other asked a real question.
 */
export function handshakeNote(outcome: HostProbeOutcome): string {
  switch (outcome.kind) {
    case HOST_PROBE_RESULT.answered:
      return outcome.missing.length === 0
        ? `\`${outcome.command}\` reports both OSB servers registered`
        : `\`${outcome.command}\` does not report: ${outcome.missing.join(", ")}`;
    case HOST_PROBE_RESULT.binaryMissing:
    case HOST_PROBE_RESULT.probeFailed:
      return `host probe skipped: ${outcome.reason}`;
    case HOST_PROBE_RESULT.notDeclared:
      return NO_HANDSHAKE_NOTE;
  }
}

/**
 * Whether the host CONTRADICTED a configuration that otherwise verified.
 *
 * True only for an answer: a probe that could not run refutes nothing,
 * and demoting a correct install because a binary was absent would be the
 * same over-claim as the blanket `ok`, pointed the other way.
 */
export function probeRefutes(outcome: HostProbeOutcome): boolean {
  return outcome.kind === HOST_PROBE_RESULT.answered && outcome.missing.length > 0;
}

/** The verdict a refuting probe earns, and the repair that matches it. */
export interface ProbeRefutedVerdict {
  readonly status: VerifyStatus;
  readonly fixHint: string;
}

/**
 * What a refuting probe MEANS, decided once for every probe-bearing
 * adapter. See "Two verdicts for one probe answer" at the top of this
 * module for why the same answer earns two different verdicts.
 *
 * `artifactMatches` is the caller's own comparison: true when this build
 * wrote a registration artifact and that artifact still equals the
 * canonical payload, false when the host's registry is the only record or
 * when the artifact does not carry the registration at all.
 */
export function probeRefutedVerdict(args: {
  readonly target: InstallTargetId;
  readonly label: string;
  readonly artifactMatches: boolean;
}): ProbeRefutedVerdict {
  if (args.artifactMatches) {
    return {
      status: "mcp-unreachable",
      fixHint: `restart ${args.label} so it reloads its MCP configuration`,
    };
  }
  return { status: "drift", fixHint: `o2b install --target ${args.target} --apply` };
}
