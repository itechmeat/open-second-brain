/**
 * The write-ledger tools of the query family (task 3.19):
 * `brain_writes` and `brain_write_destinations`, with the plan-revert
 * preview and the ledger-read wrapper they answer through. Split from
 * `query-tools.ts`; registration happens through that module's registry,
 * which preserves the public QUERY_TOOLS surface.
 */

import {
  NoteRevertError,
  noteRevertDigest,
  planNoteRevert,
  type NoteRevertSelector,
} from "../../core/brain/notes/revert.ts";
import { listNoteWrites, isLegacyPairDevice } from "../../core/brain/notes/write-log.ts";
import { listWriteDestinations } from "../../core/brain/notes/write-destinations.ts";
import { LogWindowBoundError } from "../../core/brain/notes/log-window.ts";
import { NOTE_WRITE_OP, isNoteWriteOp } from "../../core/brain/notes/write-record.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach } from "../tool-contract.ts";
import type { ServerContext } from "../tool-contract.ts";
import { coerceStr, coerceInt, unknownOperationError } from "../coerce.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { pageSlice } from "../../core/brain/offset-cursor.ts";
import { cursorOffsetArg } from "./pagination.ts";

/**
 * The two actions `brain_writes` offers.
 *
 * `plan_revert` READS: it returns the plan an operator would apply and
 * carries no apply path of its own. Applying a revert moves bytes an
 * agent did not ask for on targets it may not have written, and the
 * design puts that decision at the CLI where a human types the digest
 * (`docs/brainstorm/who-wrote-what/design.md`, "No new MCP tool for
 * freeze"). The plan is the half an agent can act on: it names, per
 * target, what would happen and why not.
 */
export const BRAIN_WRITES_ACTION = Object.freeze({
  list: "list",
  planRevert: "plan_revert",
} as const);

export const BRAIN_WRITES_ACTIONS: ReadonlyArray<string> = Object.freeze(
  Object.values(BRAIN_WRITES_ACTION),
);

/** Default and maximum rows one `brain_writes` list returns. */
export const BRAIN_WRITES_DEFAULT_LIMIT = 50;
export const BRAIN_WRITES_MAX_LIMIT = 500;

/**
 * Run one write-ledger read, mapping the shared window parser's named
 * error to `INVALID_PARAMS` blaming the mistyped argument. The readers
 * throw `LogWindowBoundError` for a `since`/`until` in neither accepted
 * spelling; that is client-resolvable input, and an uncaught throw here
 * would surface as a server fault instead of the caller's mistake.
 */
export function ledgerRead<T>(tool: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof LogWindowBoundError) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * One device selector from an argument, shared by `brain_writes`,
 * `brain_write_destinations` and the `plan_revert` selector. The empty
 * (or whitespace-only) string is the legacy un-sharded pair and IS a
 * filter value, so it is read through the shared
 * {@link isLegacyPairDevice} before `coerceStr`, which treats emptiness
 * as absence - both schemas promise `device: ""` selects the un-sharded
 * log, and a coercion-first reading made that unreachable.
 */
export function deviceArg(args: Record<string, unknown>): string | null {
  if (isLegacyPairDevice(args["device"])) return "";
  return coerceStr(args, "device", false);
}

export async function toolBrainWrites(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = coerceStr(args, "action", false) ?? BRAIN_WRITES_ACTION.list;
  if (action === BRAIN_WRITES_ACTION.planRevert) {
    return planRevert(ctx, args);
  }
  if (action !== BRAIN_WRITES_ACTION.list) {
    throw unknownOperationError(
      `brain_writes: 'action' must be one of ${BRAIN_WRITES_ACTIONS.join(", ")}`,
    );
  }
  const rawOp = coerceStr(args, "op", false);
  if (rawOp !== null && !isNoteWriteOp(rawOp)) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_writes: 'op' must be one of ${Object.values(NOTE_WRITE_OP).join(", ")}`,
    );
  }
  const agent = coerceStr(args, "agent", false);
  const device = deviceArg(args);
  const path = coerceStr(args, "path", false);
  const since = coerceStr(args, "since", false);
  const until = coerceStr(args, "until", false);
  const limit = coerceInt(args, "limit", BRAIN_WRITES_DEFAULT_LIMIT, 1, BRAIN_WRITES_MAX_LIMIT);
  const offset = cursorOffsetArg("brain_writes", args);

  // The log never opens the notes it names, so the reach rule is asked
  // per target here: at remote reach a write to a page reserved against
  // remote reads (or one whose file is gone - an unreadable claim fails
  // closed) is dropped before counting, so neither its path nor the
  // total betrays it. At local reach the view is the shared no-op.
  const view = reachView(ctx.vault, contextReach(ctx));
  const result = ledgerRead("brain_writes", () =>
    listNoteWrites(ctx.vault, {
      ...(agent !== null ? { agent } : {}),
      ...(device !== null ? { device } : {}),
      ...(path !== null ? { path } : {}),
      ...(since !== null ? { since } : {}),
      ...(until !== null ? { until } : {}),
      ...(rawOp !== null ? { op: rawOp } : {}),
      withholdsPrivate: view.withholdsPrivate === true,
    }),
  );
  const writes = view.filtersNothing
    ? result.writes
    : result.writes.filter((w) => view.visible(w.target));
  // `total_matched` beside `returned` so a truncated answer is legible as
  // one: a list capped at the limit and a list that IS the whole history
  // are otherwise the same shape. `next_cursor` continues the walk.
  const page = pageSlice(writes, offset, limit);
  return {
    action: BRAIN_WRITES_ACTION.list,
    total_matched: page.total,
    returned: page.items.length,
    writes: page.items.map((w) => ({ ...w })),
    warnings: result.warnings.map((w) => ({
      path: w.path,
      line: w.lineNumber,
      message: w.message,
    })),
    next_cursor: page.next_cursor,
  };
}

/**
 * The read-only half of the per-agent revert: what undoing the selected
 * writes WOULD do, sealed by the digest `o2b brain writes revert --apply`
 * takes.
 *
 * Every refusal the planner raises for the whole call - the unbounded
 * selector, today the only one - comes back as `INVALID_PARAMS` carrying
 * the CODE, so an agent narrows on a token rather than on a sentence.
 * Nothing here writes; the digest is the only thing that crosses to the
 * operator's terminal.
 */
export function planRevert(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // The device rides the same empty-aware selector as the list action:
  // `device: ""` names the legacy un-sharded pair, and a selector that
  // dropped the empty string beside a path would revert that path's
  // writes from EVERY device while looking device-scoped.
  const device = deviceArg(args);
  const selector: NoteRevertSelector = {
    ...selectorArg(args, "agent"),
    ...(device !== null ? { device } : {}),
    ...selectorArg(args, "path"),
    ...selectorArg(args, "since"),
    ...selectorArg(args, "until"),
  };
  const view = reachView(ctx.vault, contextReach(ctx));
  let plan;
  try {
    plan = planNoteRevert(ctx.vault, selector, {
      withholdsPrivate: view.withholdsPrivate === true,
    });
  } catch (err) {
    if (err instanceof NoteRevertError) {
      throw new MCPError(INVALID_PARAMS, `brain_writes: ${err.code}: ${err.message}`);
    }
    // The planner reads the same window bounds as the list surface, so a
    // malformed since / until is the same client-resolvable mistake here.
    if (err instanceof LogWindowBoundError) {
      throw new MCPError(INVALID_PARAMS, `brain_writes: ${err.message}`);
    }
    throw err;
  }
  // Same reach rule as `list`. When an entry is withheld, the digest
  // seals only the entries shown: the full plan's digest covers each
  // hidden entry's current-bytes hash, so it would differ between a
  // withheld page, a deleted one and a path never written, and change
  // whenever the withheld page did. The CLI apply re-plans in full and
  // refuses this digest with `digest_mismatch`, the safe outcome for a
  // plan the caller could not fully see.
  const entries = view.filtersNothing
    ? plan.entries
    : plan.entries.filter((entry) => view.visible(entry.target));
  const digest =
    entries.length === plan.entries.length ? plan.digest : noteRevertDigest(plan.selector, entries);
  return {
    action: BRAIN_WRITES_ACTION.planRevert,
    selector: { ...plan.selector },
    entries: entries.map((entry) => ({ ...entry })),
    digest,
    planned_at: plan.planned_at,
    next_command: `o2b brain writes revert --apply ${digest}`,
    warnings: plan.warnings.map((w) => ({
      path: w.path,
      line: w.lineNumber,
      message: w.message,
    })),
  };
}

/**
 * Default and maximum rows one `brain_write_destinations` call returns.
 */
export const BRAIN_WRITE_DESTINATIONS_DEFAULT_LIMIT = 50;
export const BRAIN_WRITE_DESTINATIONS_MAX_LIMIT = 500;

/**
 * The destination-keyed aggregate over the write ledger (actionable-now
 * batch, A4): one row per vault-relative target the recorded write
 * events name, across BOTH the note-write and the write-session kinds,
 * with the kinds coverage field stating honestly which kinds spoke. The
 * log never opens the pages it names, so the reach rule is asked per row
 * here exactly as `brain_writes` asks it: at remote reach a destination
 * whose page is reserved against remote reads - or unreadable, which
 * fails closed - is dropped from the rows AND from `total_matched`, so a
 * withheld page moves no count. Read-only.
 */
export async function toolBrainWriteDestinations(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agent = coerceStr(args, "agent", false);
  const device = deviceArg(args);
  const path = coerceStr(args, "path", false);
  const since = coerceStr(args, "since", false);
  const until = coerceStr(args, "until", false);
  const limit = coerceInt(
    args,
    "limit",
    BRAIN_WRITE_DESTINATIONS_DEFAULT_LIMIT,
    1,
    BRAIN_WRITE_DESTINATIONS_MAX_LIMIT,
  );
  const offset = cursorOffsetArg("brain_write_destinations", args);

  const view = reachView(ctx.vault, contextReach(ctx));
  const result = ledgerRead("brain_write_destinations", () =>
    listWriteDestinations(ctx.vault, {
      ...(agent !== null ? { agent } : {}),
      ...(device !== null ? { device } : {}),
      ...(path !== null ? { path } : {}),
      ...(since !== null ? { since } : {}),
      ...(until !== null ? { until } : {}),
      withholdsPrivate: view.withholdsPrivate === true,
    }),
  );
  const rows = view.filtersNothing
    ? result.destinations
    : result.destinations.filter((d) => view.visible(d.target));
  // `total_matched` beside `returned`, and `next_cursor` continuing the
  // walk, so a truncated answer is legible as one.
  const page = pageSlice(rows, offset, limit);
  return {
    total_matched: page.total,
    returned: page.items.length,
    destinations: page.items.map((d) => ({
      ...d,
      kinds: [...d.kinds],
      agents: [...d.agents],
      devices: [...d.devices],
    })),
    coverage_note: result.coverage_note,
    // The window the walk actually covered, both ends completed to
    // timestamps: the default lower bound is computed, not sent, so a
    // caller reading only its own arguments would misread the coverage.
    window: { since: result.window.since, until: result.window.until },
    warnings: result.warnings.map((w) => ({
      path: w.path,
      line: w.lineNumber,
      message: w.message,
    })),
    next_cursor: page.next_cursor,
  };
}

/** One selector field, present only when the caller supplied it. The
 *  device is NOT read here: it goes through {@link deviceArg}, whose
 *  empty string is the legacy un-sharded pair, not absence. */
export function selectorArg(
  args: Record<string, unknown>,
  key: "agent" | "path" | "since" | "until",
): Partial<Record<typeof key, string>> {
  const value = coerceStr(args, key, false);
  return value === null ? {} : { [key]: value };
}
