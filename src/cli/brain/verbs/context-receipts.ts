import {
  getContextReceipt,
  isContextReceiptTrigger,
  listContextReceipts,
  lookupReceiptReplyPresence,
  summarizeContextReceipt,
  type ReceiptReplyPresenceJoin,
} from "../../../core/brain/context-receipts.ts";
import { CliError, brainVerbContext, parse } from "../helpers.ts";

export async function cmdBrainContextReceipts(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === "list") return listReceipts(rest);
  if (subcommand === "show") return showReceipt(rest);
  throw new CliError("brain context-receipts: expected list or show");
}

function listReceipts(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    trigger: { type: "string" },
    host: { type: "string" },
    "session-id": { type: "string" },
    limit: { type: "string" },
  });
  const vault = brainVerbContext(flags).vault;
  const triggerRaw = trimOrUndefined(flags["trigger"]);
  if (triggerRaw !== undefined && !isContextReceiptTrigger(triggerRaw)) {
    throw new CliError(`brain context-receipts list: unknown trigger '${triggerRaw}'`);
  }
  const limit = parsePositiveInteger(trimOrUndefined(flags["limit"]), "--limit");
  const receipts = listContextReceipts(vault, {
    ...(triggerRaw !== undefined ? { trigger: triggerRaw } : {}),
    ...(trimOrUndefined(flags["host"]) !== undefined
      ? { host: trimOrUndefined(flags["host"]) }
      : {}),
    ...(trimOrUndefined(flags["session-id"]) !== undefined
      ? { sessionId: trimOrUndefined(flags["session-id"]) }
      : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  // Arrow, not point-free: summarizeContextReceipt's second parameter is
  // the optional reply-presence join, which a point-free map would feed
  // each row's array index into.
  const summaries = receipts.map((receipt) => summarizeContextReceipt(receipt));

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ total: summaries.length, receipts: summaries }, null, 2) + "\n",
    );
    return 0;
  }

  process.stdout.write(`${summaries.length} context receipt(s):\n`);
  for (const receipt of summaries) {
    process.stdout.write(
      `  ${receipt.created_at}  ${receipt.id}  ${receipt.trigger ?? "unknown"}  ${receipt.host ?? "-"}  items=${receipt.item_count ?? "?"}\n`,
    );
  }
  return 0;
}

function showReceipt(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const id = trimOrUndefined(positional[0]);
  if (id === undefined) throw new CliError("brain context-receipts show: receipt id is required");
  const vault = brainVerbContext(flags).vault;
  const receipt = getContextReceipt(vault, id);
  if (receipt === null) throw new CliError(`brain context-receipts show: receipt not found: ${id}`);
  // The receipt's session reply-presence join (t_f8510c55): the per-note
  // verdicts of the session's latest reply_presence record, or the named
  // unjoined outcome - a receipt whose session checked no turn, or that
  // names no session at all, says so instead of reading as silently
  // absent. Both output shapes carry it; the list stays a summary.
  const replyPresence = lookupReceiptReplyPresence(vault, receipt);

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ ...receipt, reply_presence: replyPresence }, null, 2) + "\n",
    );
    return 0;
  }

  const summary = summarizeContextReceipt(receipt, replyPresence);
  process.stdout.write(`id: ${summary.id}\n`);
  process.stdout.write(`created_at: ${summary.created_at}\n`);
  process.stdout.write(`trigger: ${summary.trigger ?? "unknown"}\n`);
  process.stdout.write(`host: ${summary.host ?? "-"}\n`);
  if (summary.session_id) process.stdout.write(`session_id: ${summary.session_id}\n`);
  if (summary.turn_id) process.stdout.write(`turn_id: ${summary.turn_id}\n`);
  process.stdout.write(`item_count: ${summary.item_count ?? "?"}\n`);
  process.stdout.write(`source_count: ${summary.source_count}\n`);
  if (summary.adequacy) {
    const { level, action, escalate } = summary.adequacy;
    process.stdout.write(`adequacy: ${level} -> ${action}${escalate ? " (escalate)" : ""}\n`);
  }
  if (summary.reply_presence) printReplyPresence(summary.reply_presence);
  return 0;
}

/** Render the reply-presence join; the unjoined outcome names why, never a blank. */
function printReplyPresence(join: ReceiptReplyPresenceJoin): void {
  if (join.joined) {
    const { presence } = join;
    const checked = presence.checked === null ? "" : `, checked=${presence.checked}`;
    process.stdout.write(
      `reply_presence: joined (record ${presence.record_id} @ ${presence.created_at}${checked})\n`,
    );
    for (const note of presence.per_note) {
      const range =
        note.start_line !== undefined && note.end_line !== undefined
          ? `#L${note.start_line}-L${note.end_line}`
          : "";
      process.stdout.write(`  ${note.path}${range}: ${note.verdict}\n`);
    }
    return;
  }
  const why =
    join.session_id !== undefined
      ? `no reply_presence record for session ${join.session_id}`
      : "receipt names no session";
  process.stdout.write(`reply_presence: unjoined (${why})\n`);
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new CliError(`brain context-receipts list: ${label} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    throw new CliError(`brain context-receipts list: ${label} must be a positive integer`);
  }
  return parsed;
}

function trimOrUndefined(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
