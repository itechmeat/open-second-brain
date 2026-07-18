/**
 * `o2b brain signal <retire>` - the fact signal lifecycle surface
 * (A5, t_66c12a67). Thin CLI wrapper over `src/core/brain/signal-retire.ts`.
 *
 * `retire <id> --reason <text> [--superseded-by <id>]` moves an extracted
 * fact signal from `Brain/inbox/` into `Brain/retired/` with retire
 * frontmatter, excluding it from the dream pass while keeping it readable.
 * A missing / already-retired / non-signal id is a typed error surfaced as
 * exit 2 (not a silent no-op).
 */

import {
  InvalidSignalIdError,
  retireSignal,
  SignalAlreadyRetiredError,
  SignalNotFoundError,
} from "../../../core/brain/signal-retire.ts";
import {
  brainVerbContext,
  fail,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  resolveBrainAgent,
} from "../helpers.ts";

export async function cmdBrainSignal(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "retire":
      return signalRetire(rest);
    default:
      return fail("brain signal requires a subcommand: retire <id> --reason <text>");
  }
}

function signalRetire(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    reason: { type: "string" },
    "superseded-by": { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) return fail("brain signal retire requires an <id> argument");
  const reason = normalizeFlagString(flags["reason"]);
  if (reason === null) return fail("brain signal retire requires --reason <text>");
  const supersededBy = normalizeFlagString(flags["superseded-by"]);
  const { config, vault } = brainVerbContext(flags);
  const agent = resolveBrainAgent(flags, config);
  try {
    const res = retireSignal(vault, positional[0]!, {
      reason,
      agent,
      now: new Date(),
      ...(supersededBy !== null ? { superseded_by: supersededBy } : {}),
    });
    if (flags["json"]) {
      okJson({
        id: res.id,
        path: res.path,
        status: "retired",
        reason,
        ...(supersededBy !== null ? { superseded_by: supersededBy } : {}),
      });
    } else {
      ok(`retired: ${res.id}`);
    }
    return 0;
  } catch (exc) {
    if (
      exc instanceof SignalNotFoundError ||
      exc instanceof SignalAlreadyRetiredError ||
      exc instanceof InvalidSignalIdError
    ) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    return fail(`brain signal retire failed: ${(exc as Error).message}`);
  }
}
