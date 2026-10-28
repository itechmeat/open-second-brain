/**
 * `o2b brain dead-letters <list|show|recover>` - the dead-letter surface
 * (one-command recovery, t_50794f57, task C3).
 *
 * A dead letter is the durable record of a multi-artifact write that
 * failed part way (`src/core/brain/dead-letter.ts`). Until now it was a
 * fact without an exit: the file sat in
 * `<vault>/.open-second-brain/dead-letters/` and every reader worked out
 * alone what to do. This verb is the exit. `list` (the default) renders
 * every letter with its classification and the exact copy-paste command
 * that resolves it; `show <id>` prints one letter in full; `recover <id>`
 * re-runs a schema-2 letter's frozen payload through the extraction
 * commit at CURRENT vault state - the capture boundary, the dedup index
 * and the staging lane are re-derived at call time, so already-written
 * items dedup away, an item the session re-delivered by re-extracting is
 * left out (its frozen wording is stale), and nothing stale is ever
 * replayed.
 *
 * The frozen payload is handled per surface: `show --json` carries it
 * (the freeze redacts the free-text fields, and an operator inspecting
 * one letter locally may need the items); `list --json` carries only
 * `has_payload`, because the listing is the surface agents and cron logs
 * read in bulk.
 *
 * The consent ladder is the house one for a write that has a preview:
 * recover is dry-run by default, and `--apply` requires `--yes` under
 * `--json` or a non-TTY stdin (the `brain lint --apply` /
 * `brain doctor --repair --apply` rule). The record id is itself the pin
 * - no second confirmation phrase, exactly as `brain writes revert
 * --apply <digest>`.
 *
 * RETENTION is preserved: nothing here deletes a letter. A successful
 * recovery reports success and names the file the operator may delete BY
 * HAND once the payload is reconciled - the letter is the only surviving
 * evidence of the partial write, and no tool sweeps it.
 *
 * Exit codes: 0 on success (a listing is a report, whatever it says);
 * 1 on an operational failure - a refused apply, a non-recoverable
 * letter asked to recover, a frozen vault, a letter the store refuses to
 * read (corrupt JSON, an unknown schema_version); 2 on usage errors,
 * including a named-but-unknown record id and a `--dry-run` beside an
 * `--apply`.
 */

import { existsSync } from "node:fs";

import {
  type DeadLetterRecord,
  DeadLetterError,
  deadLetterPath,
  listDeadLetters,
  readDeadLetter,
} from "../../../core/brain/dead-letter.ts";
import {
  DEAD_LETTER_ITEM_VERDICT,
  type DeadLetterRecoveryItemVerdict,
  DeadLetterRecoveryError,
  applyRecovery,
  classifyDeadLetter,
  planRecovery,
} from "../../../core/brain/dead-letter-recovery.ts";
import { VaultFrozenError } from "../../../core/brain/freeze-marker.ts";
import { assertVaultIdentityForWrite } from "../../../core/brain/vault-identity.ts";
import {
  brainVerbContext,
  fail,
  ok,
  okJson,
  parse,
  resolveBrainAgent,
  usageError,
} from "../helpers.ts";

const USAGE =
  "usage: o2b brain dead-letters [list] [--vault <path>] [--json]\n" +
  "       o2b brain dead-letters show <id> [--vault <path>] [--json]\n" +
  "       o2b brain dead-letters recover <id> [--dry-run | --apply] [--yes] [--agent <name>]\n" +
  "                        [--vault <path>] [--json]";

/** The three subcommand names, for the usage error. */
const SUBCOMMANDS = "list | show <id> | recover <id>";

export async function cmdBrainDeadLetters(argv: string[]): Promise<number> {
  const first = argv[0];
  // The bare verb IS the listing: a first word that is a flag (`--vault`,
  // `--json`) is the list invocation, not a subcommand. A first word that
  // is neither a known subcommand nor a flag is a usage error rather than
  // a surprise listing of the vault.
  const known = first === "list" || first === "show" || first === "recover";
  const rest = known ? argv.slice(1) : argv;
  if (!known && first !== undefined && !first.startsWith("-")) {
    return usageError(`brain dead-letters requires a subcommand: ${SUBCOMMANDS}`);
  }
  switch (first) {
    case "show":
      return deadLettersShow(rest);
    case "recover":
      return deadLettersRecover(rest);
    default:
      return deadLettersList(rest);
  }
}

// ----- Shared rendering -----------------------------------------------------

/** The classification and exit of one letter, read against current vault state. */
interface RowView {
  readonly record: DeadLetterRecord;
  readonly category: string;
  readonly reason: string;
  readonly command: string | null;
}

function rowView(vault: string, record: DeadLetterRecord): RowView {
  const c = classifyDeadLetter(vault, record);
  return {
    record,
    category: c.category,
    reason: c.reason,
    command: c.command,
  };
}

/**
 * One row's JSON. The frozen payload rides only when `includePayload` is
 * set: `list --json` is the machine-read bulk surface - agents and cron
 * logs read it - so the payload never rides on a listing, not even
 * redacted (`has_payload` still says the letter carries one). `show
 * --json` keeps it: an operator inspecting ONE letter locally may need
 * the frozen items - they are the only record of what the failed commit
 * was writing - and the freeze redacts the free-text fields at write
 * time, so what show prints is the redacted form for every letter this
 * build recorded.
 */
function rowJson(
  view: RowView,
  opts: { readonly includePayload: boolean },
): Record<string, unknown> {
  const r = view.record;
  return {
    id: r.id,
    schema_version: r.schema_version,
    lane: r.lane,
    step: r.step,
    reference: r.reference,
    target: r.target,
    attempted: r.attempted,
    found: r.found,
    missing: [...r.missing],
    ...(opts.includePayload && r.payload !== undefined ? { payload: r.payload } : {}),
    has_payload: r.payload !== undefined,
    outcome: r.outcome,
    first_error: r.first_error,
    recorded_at: r.recorded_at,
    category: view.category,
    reason: view.reason,
    command: view.command,
  };
}

// ----- list ------------------------------------------------------------------

function deadLettersList(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const asJson = flags["json"] === true;

  // A letter on disk this build cannot read is a hard error by the
  // store's own contract (`listDeadLetters` refuses rather than skips) -
  // a listing that under-reports is the failure this surface exists to
  // prevent. Refused like `show` and `recover` refuse the same fault:
  // a typed exit 1, never an uncaught crash.
  let views: ReturnType<typeof rowView>[];
  try {
    views = listDeadLetters(vault).map((record) => rowView(vault, record));
  } catch (err) {
    if (err instanceof DeadLetterError) return refused(err.message, asJson);
    throw err;
  }

  if (asJson) {
    okJson({
      ok: true,
      total: views.length,
      letters: views.map((v) => rowJson(v, { includePayload: false })),
    });
    return 0;
  }
  if (views.length === 0) {
    ok("no dead letters in this vault");
    return 0;
  }
  for (const view of views) {
    const r = view.record;
    ok(`${r.id}  [${r.lane}]  ${view.category}`);
    ok(
      `  session ${r.reference} -> ${r.target}, attempted ${r.attempted}, ` +
        `found ${r.found}, missing ${r.missing.length}`,
    );
    if (r.missing.length > 0) ok(`  missing: ${r.missing.join(", ")}`);
    ok(`  reason: ${view.reason}`);
    if (view.command !== null) ok(`  next: ${view.command}`);
  }
  return 0;
}

// ----- show ------------------------------------------------------------------

function deadLettersShow(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) {
    return usageError(`brain dead-letters show requires an <id> argument\n${USAGE}`);
  }
  const { vault } = brainVerbContext(flags);
  const asJson = flags["json"] === true;
  const id = positional[0]!;

  let record: DeadLetterRecord | null;
  try {
    record = readDeadLetterQuietly(vault, id);
  } catch (err) {
    // The store refused to read the letter (corrupt JSON, an unknown
    // schema_version): the named error at exit 1, never the unknown-id
    // usage shape at exit 2 - a letter this build cannot read exists,
    // and saying otherwise under-reports it.
    if (err instanceof DeadLetterError) return refused(err.message, asJson);
    throw err;
  }
  if (record === null) {
    return unknownId(id);
  }
  const view = rowView(vault, record);

  if (asJson) {
    okJson({ ok: true, letter: rowJson(view, { includePayload: true }) });
    return 0;
  }
  const r = view.record;
  ok(`${r.id}  [${r.lane}]  ${view.category}`);
  ok(`  schema: ${r.schema_version}${r.payload !== undefined ? " (payload frozen)" : ""}`);
  ok(`  step: ${r.step}`);
  ok(`  session: ${r.reference}`);
  ok(`  target: ${r.target}`);
  ok(`  attempted: ${r.attempted}, found: ${r.found}, missing: ${r.missing.length}`);
  for (const key of r.missing) ok(`  missing: ${key}`);
  if (r.payload !== undefined) {
    const items = r.payload["items"];
    if (Array.isArray(items)) {
      for (const item of items) {
        const topic = (item as { topic?: unknown })["topic"];
        if (typeof topic === "string") ok(`  payload item: ${topic}`);
      }
    }
  }
  ok(`  outcome: ${r.outcome}`);
  ok(`  first error: ${r.first_error}`);
  ok(`  recorded: ${r.recorded_at}`);
  ok(`  reason: ${view.reason}`);
  if (view.command !== null) ok(`  next: ${view.command}`);
  return 0;
}

// ----- recover ---------------------------------------------------------------

function deadLettersRecover(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) {
    return usageError(`brain dead-letters recover requires an <id> argument\n${USAGE}`);
  }
  const asJson = flags["json"] === true;
  const apply = flags["apply"] === true;
  // The two flags name opposite modes - an explicit `--dry-run` beside an
  // explicit `--apply` is a caller mistake, refused as a usage error
  // rather than resolved in favor of whichever the verb felt like: a
  // write that ignored the caller's dry-run request would be exactly the
  // dishonesty this verb exists to prevent.
  if (flags["dry-run"] === true && apply) {
    return usageError(
      "brain dead-letters recover: --dry-run and --apply are mutually exclusive " +
        "(dry-run is the default; drop one of the two flags)",
    );
  }
  // Dry-run is the default; --apply is the write. The headless consent
  // rule is the `brain lint --apply` one: no prompts under --json or a
  // non-TTY stdin, so --yes is the only consent that can be given there.
  if (apply && flags["yes"] !== true && (asJson || !process.stdin.isTTY)) {
    const message =
      "brain dead-letters recover --apply requires --yes in non-interactive mode " +
      "(dry-run is the default; --apply re-runs the recorded payload)";
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
  const { config, vault } = brainVerbContext(flags);
  const id = positional[0]!;

  let record: DeadLetterRecord | null;
  try {
    record = readDeadLetterQuietly(vault, id);
  } catch (err) {
    // The store refused to read the letter: the named error at exit 1,
    // never the unknown-id usage shape - same contract as `show`.
    if (err instanceof DeadLetterError) return refused(err.message, asJson);
    throw err;
  }
  if (record === null) {
    return unknownId(id);
  }

  try {
    if (!apply) {
      const plan = planRecovery(vault, record);
      if (asJson) {
        okJson({
          ok: true,
          id: record.id,
          mode: "dry-run",
          category: plan.classification.category,
          reason: plan.classification.reason,
          items: plan.items.map((i) => ({
            topic: i.topic,
            verdict: i.verdict,
            ...(i.reason !== undefined ? { reason: i.reason } : {}),
          })),
        });
      } else {
        ok(`dry-run recovery plan for ${record.id} (${plan.classification.category})`);
        ok(`  reason: ${plan.classification.reason}`);
        for (const i of plan.items) {
          ok(
            `  ${i.topic}: ${verdictText(i.verdict)}${i.reason !== undefined ? ` (${i.reason})` : ""}`,
          );
        }
        ok("nothing written; re-run with --apply --yes to write");
      }
      return 0;
    }

    // The apply is a content write: the same vault guards every content
    // writer passes - the freeze and the vault identity - refuse here
    // FIRST, before anything is written (the freeze names `o2b brain
    // unfreeze` as its exit).
    assertVaultIdentityForWrite(vault);
    const res = applyRecovery(vault, record, {
      agent: resolveBrainAgent(flags, config),
      now: new Date(),
    });
    const letterPath = deadLetterPath(vault, record.id);
    // The module's own promise: never report success over a re-run that
    // delivered nothing. The classifier refuses the states it can see
    // (every undelivered item gate-refused, every missing item already
    // delivered); an apply that still comes back with zero writes and
    // zero staging - the vault changing between the classification and
    // the commit is the shape this catches - is refused here with the
    // accounting named, instead of printed as a green `wrote 0
    // signal(s)`.
    if (res.written.length + res.staged === 0) {
      const refusedItems = res.rejected.map((r) => `${r.topic}: ${r.reason}`).join("; ");
      const message =
        `nothing was delivered while recovering ${record.id}: wrote 0 signal(s) and staged 0 ` +
        `(deduped ${res.deduped}, durability-rejected ${res.durabilityRejected}` +
        (refusedItems !== "" ? `; ${refusedItems}` : "") +
        `); the letter is retained at ${letterPath}`;
      return refused(message, asJson);
    }
    if (asJson) {
      okJson({
        ok: true,
        id: record.id,
        mode: "apply",
        written: res.written.map((w) => ({ id: w.id, path: w.path, topic: w.topic })),
        staged: res.staged,
        deduped: res.deduped,
        durability_rejected: res.durabilityRejected,
        rejected: res.rejected.map((r) => ({ topic: r.topic, reason: r.reason })),
        letter_retained: true,
        letter_path: letterPath,
        // The commit result's contract: the failure rides here by name,
        // absent when the mining record landed.
        ...(res.miningLedgerFailure !== undefined
          ? { mining_ledger_failure: res.miningLedgerFailure }
          : {}),
      });
    } else {
      ok(
        `recovered ${record.id}: wrote ${res.written.length} signal(s), ` +
          `deduped ${res.deduped}, durability-rejected ${res.durabilityRejected}` +
          (res.staged > 0 ? `, staged ${res.staged} for approval` : ""),
      );
      for (const r of res.rejected) ok(`  rejected: ${r.topic} (${r.reason})`);
      if (res.miningLedgerFailure !== undefined) {
        ok(`mining ledger not updated: ${res.miningLedgerFailure}`);
      }
      ok(
        `the dead letter is retained at ${letterPath}; ` +
          "delete it by hand once the payload is reconciled",
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof VaultFrozenError) {
      return refused(err.message, asJson);
    }
    if (err instanceof DeadLetterRecoveryError) {
      return refused(err.message, asJson);
    }
    const message = `brain dead-letters recover failed: ${(err as Error).message ?? String(err)}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}

/**
 * The dry-run verdict text, in the operator's words, enumerated per known
 * verdict: the table's exhaustive key type makes a verdict joining
 * `DEAD_LETTER_ITEM_VERDICT` a compile error until it is given its own
 * words here, so a future verdict can never silently render as another
 * verdict's - "quarantined" reading as "refused" would tell the operator
 * the wrong thing.
 */
const VERDICT_TEXT: Readonly<Record<DeadLetterRecoveryItemVerdict, string>> = Object.freeze({
  [DEAD_LETTER_ITEM_VERDICT.write]: "will write",
  [DEAD_LETTER_ITEM_VERDICT.staged]: "will stage for approval",
  [DEAD_LETTER_ITEM_VERDICT.dedup]: "already on disk (dedup)",
  [DEAD_LETTER_ITEM_VERDICT.refused]: "refused",
});

/**
 * The text for one verdict, refusing an unknown one by name. Unreachable
 * through the typed plan in this build; the named refusal is the guard
 * for a verdict that reaches this surface unrendered.
 */
export function verdictText(verdict: string): string {
  const text = VERDICT_TEXT[verdict as DeadLetterRecoveryItemVerdict];
  if (text === undefined) {
    throw new Error(`dead-letters: unknown recovery item verdict ${JSON.stringify(verdict)}`);
  }
  return text;
}

/** An operational refusal: the message on the error channel, exit 1. */
function refused(message: string, asJson: boolean): number {
  if (asJson) {
    okJson({ ok: false, message });
    return 1;
  }
  return fail(message);
}

// ----- Shared refusal paths --------------------------------------------------

/**
 * The unknown-id refusal. The id was NAMED by the caller, so this is a
 * usage error (exit 2) rather than an empty report - a silent no-op would
 * read as "nothing to do" for a letter the caller misquoted. A usage
 * error is plain text on stderr in both modes: the `{ ok: false }`
 * envelope is reserved for operational refusals (exit 1).
 */
function unknownId(id: string): number {
  return usageError(`brain dead-letters: no dead letter with id ${JSON.stringify(id)}`);
}

/**
 * Read one letter for the `show`/`recover` reads, mapping a malformed id
 * to the unknown-id refusal shape: `deadLetterPath` throws on an id that
 * does not match the `<lane>-<digest>` shape, and a malformed id is one
 * nothing was ever written under.
 *
 * EVERY other store refusal propagates: a corrupt file or an unknown
 * `schema_version` is a hard error by the store's own contract
 * (`dead-letter.ts`: reading refuses rather than skips), and a caller
 * hearing "no dead letter with id" for an unreadable record would be
 * told the partial write does not exist - the under-report this surface
 * exists to prevent. The store's error reaches the operator at exit 1
 * through the shared refusal path each subcommand renders it with.
 */
function readDeadLetterQuietly(vault: string, id: string): DeadLetterRecord | null {
  let path: string;
  try {
    path = deadLetterPath(vault, id);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  return readDeadLetter(vault, id);
}
