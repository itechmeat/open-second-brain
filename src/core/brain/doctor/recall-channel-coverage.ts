/**
 * Which silence is this (C1, t_e5f447c1).
 *
 * "Recall never fires" is the report, and until this check existed it was
 * undiagnosable: a channel that was never installed and a channel that
 * runs and stays quiet leave exactly the same trace, which is none. The
 * repair is not more telemetry - it is CROSSING two facts that were never
 * read together:
 *
 *   - the INSTALL state: is this transport configured to deliver at all?
 *   - the DELIVERY count: did anything actually arrive on it recently?
 *
 * | install      | deliveries | outcome                                  |
 * |--------------|------------|------------------------------------------|
 * | expected     | 0          | warning, `recall-channel-silent`         |
 * | expected     | >0         | nothing                                  |
 * | expected     | unreadable | uncertain, `recall-channel-unmeasured`   |
 * | not expected | any        | nothing                                  |
 * | unknown      | any        | uncertain, `recall-channel-unmeasured`   |
 *
 * The expected/unknown split is the whole unit. Collapsing "not
 * configured" into "could not tell" is the failure mode this wave is
 * named for, so an install side that could not be READ goes to the
 * uncertainty stream naming why, never to nothing and never to a warning
 * about a channel whose configuration the check never saw.
 *
 * BOTH sides get that treatment, which the first version got right for
 * the install side only. The delivery rollup ran unguarded ahead of the
 * loop, and this check is registered `failSoft`, so a continuity store
 * the pass could not open threw away every finding - the check reported
 * nothing about any channel, which is precisely the undiagnosable
 * silence above. A delivery count that could not be read is now an
 * uncertain entry naming why, and it never suppresses the install-side
 * reporting.
 *
 * {@link installState} is a `switch` over {@link RecallChannel} with NO
 * default arm. That is where the closed vocabulary becomes a COMPILE-TIME
 * guarantee: a fourth channel added to the frozen array fails this file
 * to build rather than falling through a runtime guard into a silent
 * "unknown" that would look exactly like an unreadable install.
 *
 * `configPath` arrives on the check context rather than being discovered
 * here, which is what makes every row above reachable in a unit test
 * without mutating process environment.
 */

import { readdirSync } from "node:fs";

import { resolveRecallInjectEnabled } from "../../config.ts";
import { hookAuditDir } from "../paths.ts";
import {
  RECALL_CHANNEL,
  RECALL_CHANNELS,
  summarizeRecallTelemetry,
  type RecallChannel,
} from "../recall-telemetry.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { pushUncertain } from "./uncertain-stream.ts";
import { sweptFailureReason } from "./unreadable-path.ts";

/** An enabled channel with nothing delivered inside the window. */
export const RECALL_CHANNEL_SILENT_CODE = "recall-channel-silent";
/** A channel whose install side could not be read at all. */
export const RECALL_CHANNEL_UNMEASURED_CODE = "recall-channel-unmeasured";

/**
 * How far back a delivery counts as coverage.
 *
 * Wide enough that an operator who used the vault at all in the last
 * month is not told a working channel is silent, narrow enough that a
 * channel which stopped working is reported while the change that broke
 * it is still recent. The continuity log has no retention policy, so an
 * unbounded window would make every channel that ever delivered look
 * healthy forever.
 */
export const RECALL_CHANNEL_COVERAGE_WINDOW_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whether a transport is configured to deliver, or unreadable. */
type ChannelInstallState =
  /** Configured to deliver; silence here is a finding. */
  | { readonly kind: "expected"; readonly evidence: string }
  /** Nothing claims it should deliver; silence here means nothing. */
  | { readonly kind: "not_expected"; readonly evidence: string }
  /** The install side could not be read; no claim either way. */
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * What testifies that a transport is installed.
 *
 * No default arm, deliberately - see the module docblock.
 */
function installState(channel: RecallChannel, ctx: DoctorCheckContext): ChannelInstallState {
  switch (channel) {
    case RECALL_CHANNEL.hook:
      return hookInstallState(ctx);
    case RECALL_CHANNEL.mcp:
    case RECALL_CHANNEL.cli:
      // Stated honestly rather than guessed. Neither surface has a
      // persisted install fact: both emit only when the caller passes
      // `telemetry` on the individual request, so silence on them means
      // nobody asked for a record - which is not a defect, has no
      // repair, and must not be reported as one. A registered MCP client
      // or an installed binary would testify to reachability, not to
      // anyone having opted in.
      return {
        kind: "not_expected",
        evidence:
          "recall telemetry on this transport is a per-call opt-in with no persisted install " +
          "state, so an absence of records means nobody requested one",
      };
  }
}

/**
 * The hook's install fact: the config gate that arms it, plus the audit
 * directory that proves it has somewhere to write.
 *
 * The gate alone would be enough to say "expected", but reading the audit
 * root is what separates "enabled and quiet" from "enabled and the
 * evidence side is unreadable" - and an unreadable audit root also means
 * the delivery count below rests on a store this pass could not check
 * against. An ABSENT directory is not unreadable: it is exactly the
 * shape of a hook that was armed and has never run, which is the finding.
 */
function hookInstallState(ctx: DoctorCheckContext): ChannelInstallState {
  let enabled: boolean;
  try {
    enabled = resolveRecallInjectEnabled(ctx.configPath);
  } catch (err) {
    return {
      kind: "unknown",
      reason: `the recall-inject config gate could not be resolved: ${describe(err)}`,
    };
  }
  if (!enabled) {
    return {
      kind: "not_expected",
      evidence: "recall_inject_enabled is off, so the prompt-time hook is a deliberate no-op",
    };
  }
  const audit = hookAuditDir(ctx.vault);
  try {
    readdirSync(audit);
  } catch (err) {
    const reason = sweptFailureReason(err);
    // `null` means the directory is simply not there, which is exactly
    // what an armed hook that has never run looks like - the finding,
    // not an obstacle to it. Anything else is a denial, and a denial
    // here also covers the evidence the finding would rest on.
    if (reason !== null) {
      return { kind: "unknown", reason: `${audit} could not be read: ${reason}` };
    }
  }
  return { kind: "expected", evidence: "recall_inject_enabled is on" };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Deliveries per transport, or why the count could not be read. */
type DeliveryCounts =
  /** The window was read; a channel absent from the map delivered nothing. */
  | { readonly kind: "counted"; readonly byChannel: Partial<Record<RecallChannel, number>> }
  /** The continuity store could not be opened; no count either way. */
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * ONE rollup for every channel: the by-channel summary exists so this
 * check costs one pass over the window rather than one per transport.
 *
 * Guarded rather than left to the `failSoft` registration, because
 * failing soft here means the whole check disappears - install side
 * included - and a check that reports nothing is indistinguishable from
 * a vault with nothing wrong.
 */
function deliveryCounts(vault: string, since: string): DeliveryCounts {
  try {
    return { kind: "counted", byChannel: summarizeRecallTelemetry(vault, { since }).by_channel };
  } catch (err) {
    return { kind: "unreadable", reason: describe(err) };
  }
}

/**
 * What the delivery side adds to an entry whose INSTALL side is already
 * unknown. Stated rather than assumed: the original sentence claimed the
 * delivery count was readable, which was true only because nothing had
 * checked.
 */
function deliverySideClause(delivered: DeliveryCounts): string {
  return delivered.kind === "counted"
    ? "Its delivery count is readable, but with the install side unknown a silent channel " +
        "cannot be told from one nothing asked to run"
    : `Its delivery count could not be read either (${delivered.reason}), so neither half of ` +
        "the cross is available";
}

export const recallChannelCoverageCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const since = new Date(
      ctx.now.getTime() - RECALL_CHANNEL_COVERAGE_WINDOW_DAYS * MS_PER_DAY,
    ).toISOString();
    const delivered = deliveryCounts(ctx.vault, since);

    for (const channel of RECALL_CHANNELS) {
      const state = installState(channel, ctx);
      if (state.kind === "unknown") {
        pushUncertain(out.uncertain, {
          code: RECALL_CHANNEL_UNMEASURED_CODE,
          path: ctx.vault,
          message:
            `the ${channel} recall channel could not be measured: ${state.reason}. ` +
            deliverySideClause(delivered),
        });
        continue;
      }
      if (state.kind === "not_expected") continue;
      if (delivered.kind === "unreadable") {
        pushUncertain(out.uncertain, {
          code: RECALL_CHANNEL_UNMEASURED_CODE,
          path: ctx.vault,
          message:
            `the ${channel} recall channel could not be measured: its delivery count could not ` +
            `be read (${delivered.reason}). Its install side says it is expected to deliver ` +
            `(${state.evidence}), so an installed and quiet channel cannot be told from a ` +
            "working one whose records this pass could not open",
        });
        continue;
      }
      if ((delivered.byChannel[channel] ?? 0) > 0) continue;
      out.issues.push({
        severity: "warning",
        code: RECALL_CHANNEL_SILENT_CODE,
        path: ctx.vault,
        target: channel,
        message:
          `the ${channel} recall channel is expected to deliver (${state.evidence}) but recorded ` +
          `no recall in the last ${RECALL_CHANNEL_COVERAGE_WINDOW_DAYS} days. It is installed and ` +
          "quiet, which is a different condition from never having been installed",
      } satisfies DoctorIssue);
    }
  },
};
