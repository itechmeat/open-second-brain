/**
 * `o2b brain expire <id> --expires <date|none>` - set, change or clear a
 * memory's expiration after it was written.
 *
 * The sibling half of `o2b brain feedback --expires`, which can only
 * declare a lifetime at creation. This verb is the one that changes one:
 * a migration that slipped, a rule that turned out to be permanent, a
 * date that was simply wrong.
 *
 * One verb for both artifact kinds, addressed by id, because "how long
 * does this memory hold" is one question whether the memory is a signal
 * or a preference. Every value goes through the core's
 * `normalizeExpirationDate`; clearing is the explicit word `none`, never
 * an empty string a broken shell expansion could produce.
 *
 * Deliberately NOT part of `o2b brain note-lifecycle`: that surface runs
 * every path through `resolveNoteTarget`, which refuses the `Brain/`
 * machinery root, and that refusal is what keeps a note-editing verb from
 * rewriting a preference.
 */

import {
  EXPIRATION_CLEAR,
  ExpirationTargetNotFoundError,
  ExpirationValueError,
  InvalidExpirationTargetError,
  setExpiration,
  type SetExpirationResult,
} from "../../../core/brain/expiration-set.ts";
import { CliError } from "../../argparse.ts";
import {
  brainVerbContext,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  resolveBrainAgent,
} from "../helpers.ts";

const USAGE =
  `usage: o2b brain expire <id> --expires <YYYY-MM-DD|ISO-8601|${EXPIRATION_CLEAR}> ` +
  "[--agent <name>] [--vault <path>] [--json]";

/** Refuse by name, exit 2, on whichever stream the caller is reading. */
function refuse(message: string, asJson: boolean): number {
  if (asJson) {
    okJson({ ok: false, message });
    return 2;
  }
  process.stderr.write(`error: ${message}\n`);
  return 2;
}

function renderJson(res: SetExpirationResult): Record<string, unknown> {
  return {
    ok: true,
    id: res.id,
    kind: res.kind,
    path: res.path,
    expiration: res.expiration,
    previous: res.previous,
    changed: res.changed,
  };
}

export async function cmdBrainExpire(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    expires: { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;

  const id = positional[0];
  if (id === undefined || id.trim().length === 0) {
    return refuse(`brain expire requires a signal or preference id. ${USAGE}`, asJson);
  }
  // Required rather than defaulted. There is no sensible default lifetime,
  // and a missing flag reading as "clear it" would be the destructive
  // reading of an omission.
  const expires = normalizeFlagString(flags["expires"]);
  if (expires === null) {
    return refuse(`brain expire requires --expires. ${USAGE}`, asJson);
  }

  let context;
  try {
    context = brainVerbContext(flags);
  } catch (exc) {
    if (exc instanceof CliError) return refuse(exc.message, asJson);
    throw exc;
  }

  try {
    const res = setExpiration(context.vault, id, expires, {
      agent: resolveBrainAgent(flags, context.config),
    });
    if (asJson) okJson(renderJson(res));
    else {
      const what = res.expiration === null ? "cleared" : `expires ${res.expiration}`;
      ok(`${res.id}: ${what}${res.changed ? "" : " (unchanged)"}`);
      ok(`  path: ${res.path}`);
      ok(`  previous: ${res.previous ?? EXPIRATION_CLEAR}`);
    }
    return 0;
  } catch (exc) {
    if (
      exc instanceof ExpirationValueError ||
      exc instanceof ExpirationTargetNotFoundError ||
      exc instanceof InvalidExpirationTargetError
    ) {
      return refuse((exc as Error).message, asJson);
    }
    if (exc instanceof CliError) return refuse(exc.message, asJson);
    throw exc;
  }
}
