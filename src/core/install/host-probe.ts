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
 *
 * LEAF module: `RUNTIME_FACTS` plus the two server-key constants, and
 * nothing from `./adapters/`. `src/core/install/adapters/_json-mcp.ts`
 * and `copilot-cli.ts` read it; importing either back into here would
 * close a cycle `tests/core/architecture/import-cycles.test.ts` gates.
 */

import { RUNTIME_FACTS, type HostProbeSpec, type InstallTargetId } from "../runtime/host-facts.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "./json-merge.ts";

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

/** The probe results, most informative first. */
export const HOST_PROBE_RESULTS: ReadonlyArray<HostProbeResult> = Object.freeze([
  HOST_PROBE_RESULT.answered,
  HOST_PROBE_RESULT.binaryMissing,
  HOST_PROBE_RESULT.probeFailed,
  HOST_PROBE_RESULT.notDeclared,
]);

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
 * The subprocess seam. `available` answers whether the binary resolves on
 * PATH at all, which is a different failure from a binary that ran and
 * refused - the two produce different named skips, so they cannot share a
 * branch.
 */
export interface HostProbeRunner {
  available(bin: string): boolean;
  run(bin: string, argv: ReadonlyArray<string>): HostProbeRunResult;
}

const defaultRunner: HostProbeRunner = {
  available(bin: string): boolean {
    try {
      return Bun.which(bin) !== null;
    } catch {
      return false;
    }
  },
  run(bin: string, argv: ReadonlyArray<string>): HostProbeRunResult {
    try {
      const r = Bun.spawnSync({ cmd: [bin, ...argv], stdout: "pipe", stderr: "pipe" });
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
export function probeHost(target: InstallTargetId): HostProbeOutcome {
  const spec = RUNTIME_FACTS[target].hostProbe;
  if (spec === null) return { kind: HOST_PROBE_RESULT.notDeclared };
  const command = hostProbeCommand(spec);
  if (!activeRunner.available(spec.bin)) {
    return {
      kind: HOST_PROBE_RESULT.binaryMissing,
      command,
      reason: `\`${spec.bin}\` is not on PATH`,
    };
  }
  const run = activeRunner.run(spec.bin, spec.argv);
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

/** How the operator gets the host to load a configuration it already has. */
export function probeRefutedFixHint(label: string): string {
  return `restart ${label} so it reloads its MCP configuration`;
}
