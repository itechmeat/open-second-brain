/**
 * How the census files drive one row of `table.ts` against a copy of the
 * census fixture (`fixture.ts`), and what counts as the gate's refusal.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCli } from "../../../helpers/run-cli.ts";
import type { CensusRun, CensusTemplate, GateCondition, RunOutcome } from "./fixture.ts";

/** The sentence every refusal of the gate carries, whatever run holds it. */
export const REFUSAL_RE = /the write was refused and nothing was written/;

/** A CLI run's exit code and its combined output. */
export interface CliResult {
  readonly code: number;
  readonly output: string;
}

/** Substitute the run's vault and scratch directory into an argv. */
export function argvFor(argv: ReadonlyArray<string>, run: CensusRun): string[] {
  return argv.map((arg) => arg.replace("{vault}", run.vault).replace("{dir}", run.dir));
}

/** The files a few writers read their input from, under the run's scratch directory. */
function scratchInputs(run: CensusRun): void {
  mkdirSync(join(run.dir, "okf"), { recursive: true });
  writeFileSync(join(run.dir, "session.jsonl"), "");
}

/**
 * Run the CLI with `argv` on a fresh copy under `condition`, after the
 * `prepare` calls (made before the gate is taken). `subprocess` runs it as a
 * child process; otherwise in this process, which the reader rows use.
 */
export async function driveCli(
  template: CensusTemplate,
  condition: GateCondition,
  argv: ReadonlyArray<string>,
  options: {
    readonly prepare?: ReadonlyArray<ReadonlyArray<string>>;
    readonly subprocess?: boolean;
    /** The per-call limit of a subprocess (the default one when absent). */
    readonly limitMs?: number;
  } = {},
): Promise<RunOutcome<CliResult>> {
  const subprocess = options.subprocess !== false;
  return template.run(
    condition,
    async (run) => {
      const result = await runCli(argvFor(argv, run), {
        env: { ...run.env },
        subprocess,
        ...(options.limitMs === undefined ? {} : { limitMs: options.limitMs }),
      });
      return { code: result.returncode, output: `${result.stdout}\n${result.stderr}` };
    },
    async (run) => {
      scratchInputs(run);
      for (const step of options.prepare ?? []) {
        // oxlint-disable-next-line no-await-in-loop -- each step builds on the last
        const prepared = await runCli(argvFor(step, run), { env: { ...run.env }, subprocess });
        // A prerequisite that failed would make the case test the wrong thing.
        if (prepared.returncode !== 0) {
          throw new Error(
            `census preparation failed: o2b ${step.join(" ")} exited ${prepared.returncode}\n` +
              `${prepared.stdout}\n${prepared.stderr}`,
          );
        }
      }
    },
  );
}

/** Whether a CLI result is the gate's refusal: a failing exit naming it. */
export function cliRefused(result: CliResult): boolean {
  return result.code !== 0 && REFUSAL_RE.test(result.output);
}
