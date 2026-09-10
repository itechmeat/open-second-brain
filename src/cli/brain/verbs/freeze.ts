import { freezeVault, unfreezeVault } from "../../../core/brain/freeze.ts";
import { resolveAgentName } from "../../../core/config.ts";
import { brainVerbContext, fail, normalizeFlagString, ok, okJson, parse } from "../helpers.ts";
import { emitNextStep, type AdvisoryStream } from "../../advisory-rail.ts";

/**
 * `o2b brain freeze` / `o2b brain unfreeze` (who-wrote-what, Task C) -
 * the operator's stop for every content writer on every device that
 * syncs this vault.
 *
 * CLI-only by design. Agents receive the refusal by name and can read the
 * frozen state off `brain_status`, but lifting a freeze is an act of
 * judgement about a fleet an agent cannot see, so no MCP tool sets or
 * clears the marker.
 *
 * Both verbs are idempotent and say which of the two things happened: a
 * second `freeze` reports the freeze already standing (and whose it is,
 * because the first operator's reason is the one that holds), and an
 * `unfreeze` on an open vault reports that it was already open. Neither
 * is an error - the operator asked for a state and got it - so both exit
 * zero.
 */
export async function cmdBrainFreeze(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    reason: { type: "string" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);
  const reason = normalizeFlagString(flags["reason"]);
  const agent = resolveAgentName(config);

  try {
    const out = freezeVault(vault, {
      agent,
      ...(reason !== null ? { reason } : {}),
    });
    if (flags["json"]) {
      okJson({
        changed: out.changed,
        frozen: true,
        frozen_at: out.marker.frozen_at,
        by: out.marker.by,
        device_id: out.marker.device_id,
        reason: out.marker.reason,
        marker: out.path,
      });
    } else if (out.changed) {
      ok(`frozen: ${describe(out.marker.frozen_at, out.marker.by, out.marker.reason)}`);
      ok("every content write is refused until the freeze is lifted");
      // The lift is a forward pointer, and forward pointers ride the rail:
      // the `vault-frozen` signal already names the command, so the verb
      // does not spell it a second time.
      const stream: AdvisoryStream = { command: "brain", argv, jsonRequested: false };
      emitNextStep("vault-frozen", stream);
    } else {
      ok(`already frozen: ${describe(out.marker.frozen_at, out.marker.by, out.marker.reason)}`);
    }
    return 0;
  } catch (exc) {
    return fail(`freeze failed: ${(exc as Error).message ?? exc}`);
  }
}

export async function cmdBrainUnfreeze(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);
  const agent = resolveAgentName(config);

  try {
    const out = unfreezeVault(vault, { agent });
    if (flags["json"]) {
      okJson({
        changed: out.changed,
        frozen: false,
        frozen_at: out.marker?.frozen_at ?? null,
        by: out.marker?.by ?? null,
        reason: out.marker?.reason ?? null,
      });
    } else if (out.changed) {
      // The marker is gone, so this line is the last place its contents
      // are shown to a human; the `unfreeze` log event is where they last.
      ok(
        `unfrozen: ${describe(out.marker?.frozen_at ?? "", out.marker?.by ?? "", out.marker?.reason ?? "")}`,
      );
    } else {
      ok("not frozen: nothing to lift");
    }
    return 0;
  } catch (exc) {
    return fail(`unfreeze failed: ${(exc as Error).message ?? exc}`);
  }
}

/** One line naming when the freeze was set, by whom, and why. */
function describe(frozenAt: string, by: string, reason: string): string {
  const who = by === "" ? "an unnamed agent" : by;
  const when = frozenAt === "" ? "an unrecorded time" : frozenAt;
  const why = reason === "" ? "no reason given" : reason;
  return `set at ${when} by ${who} (${why})`;
}
