/**
 * `o2b brain architect <project-path>` (Project History Suite,
 * t_929da8a2): deterministic architecture notes for a code project,
 * generated into the vault through the sentinel-region engine so
 * operator edits survive every re-scan.
 *
 * The scan and the render have emitted through the progress spine and
 * accepted a cooperative deadline since U1/U11, and
 * `safeguard_timeout_architect_seconds` has resolved through the ladder
 * since `OPERATION.architect` was added - but this verb built no
 * safeguard and attached no rail, so both were declared surfaces with
 * nothing behind them. This is their consumer.
 */

import { generateArchDocs } from "../../../core/brain/architect/generate.ts";
import { RegionError } from "../../../core/brain/regions.ts";
import {
  createSafeguard,
  OPERATION,
  resolveSafeguardTimeoutMs,
} from "../../../core/brain/safeguard.ts";
import { attachProgress, reportProgressRefusal } from "../../progress-rail.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE = "usage: o2b brain architect <project-path> [--vault V] [--progress] [--json]";

export async function cmdBrainArchitect(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    progress: { type: "boolean" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const target = positional[0];
  if (!target) return fail(USAGE);

  // Progress is opt-in: attaching a sink by default would change the
  // stderr of every existing invocation. The rail decides whether the
  // stream can carry it at all.
  const observation =
    flags["progress"] === true
      ? attachProgress({ command: "brain", argv: ["architect"], jsonRequested: asJson })
      : null;
  // No interrupt handle: `generateRun` is synchronous end to end, so a
  // signal handler cannot run while it does (see `interrupt.ts`). Leaving
  // SIGINT alone keeps the keystroke lethal, and the plan-then-write
  // restructure means a killed scan has written nothing.
  try {
    const { config, vault } = brainVerbContext(flags);
    reportProgressRefusal(observation);
    const res = generateArchDocs(vault, target, {
      safeguard: createSafeguard({
        operation: OPERATION.architect,
        timeoutMs: resolveSafeguardTimeoutMs(OPERATION.architect, config ?? undefined),
      }),
      ...(observation?.sink !== undefined ? { onProgress: observation.sink } : {}),
    });
    if (asJson) {
      okJson({
        ok: true,
        repo_key: res.repoKey,
        dir: res.dir,
        overview_path: res.overviewPath,
        module_paths: res.modulePaths,
        created: res.created,
        updated: res.updated,
        unchanged: res.unchanged,
        // Conditional, so a run whose observer never failed - and every
        // run with no observer at all - emits exactly the payload it
        // emitted before this field had a consumer.
        ...(res.progressFault !== null ? { progress_fault: res.progressFault } : {}),
      });
      return 0;
    }
    ok(
      `architecture notes for ${res.repoKey}: ${res.created} created, ` +
        `${res.updated} updated, ${res.unchanged} unchanged`,
    );
    ok(`overview: ${res.overviewPath}`);
    // The generation succeeded and the caller's stream did not. Carried
    // out rather than swallowed: an observer that died mid-run explains
    // a stream that stops before the last note.
    if (res.progressFault !== null) {
      process.stderr.write(`progress: observer failed (${res.progressFault})\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof RegionError) {
      return fail(
        `${err.message} - repair the sentinel markers (or delete the note to regenerate it)`,
      );
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}
