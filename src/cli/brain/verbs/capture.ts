/**
 * `o2b brain capture <body>` - stage one inbound capture from a terminal.
 *
 * The capture contract shipped with exactly one writer: the inbound
 * Telegram bot. Everything downstream of it - the staging area, the
 * inbox drain, the `/catchup` watermark - was therefore reachable only by
 * an install that had configured a chat channel, and an operator sitting
 * in front of the vault had no way in at all.
 *
 * This verb is that door and nothing more. It builds a
 * {@link WriteCaptureInput} and hands it to the same
 * {@link writeCaptureNote} the bot calls, so the id hash, the frontmatter,
 * the guidance section and the collision ladder are the contract's and
 * cannot drift into a second set of rules.
 *
 * The body may be an argument or arrive on stdin - a captured thought is
 * as often the output of another command as it is something typed - and
 * the two paths produce the same page. `--sender` names who is capturing
 * and defaults to the configured agent, because a capture with no
 * attributable sender is a record whose provenance nobody can reconstruct.
 */

import {
  CaptureContractError,
  writeCaptureNote,
  type CaptureNote,
} from "../../../core/brain/capture/capture-note.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { CliError } from "../../argparse.ts";
import {
  brainVerbContext,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  parseOptionalIsoDate,
  resolveBrainAgent,
} from "../helpers.ts";

const USAGE =
  "usage: o2b brain capture [<body>] [--source <channel>] [--sender <who>] " +
  "[--guidance <text>] [--at <ISO>] [--vault <path>] [--json]";

/** Channel recorded when the caller names none: this verb itself. */
const DEFAULT_SOURCE = "cli";

/**
 * Refuse a request this verb understood and declined. Exit 2, with the
 * reason on stderr for a human and inside the payload for a machine - the
 * `dream` verb's shape, so a caller parsing one parses both.
 */
function refuse(message: string, asJson: boolean): number {
  if (asJson) {
    okJson({ ok: false, message });
    return 2;
  }
  process.stderr.write(`error: ${message}\n`);
  return 2;
}

function renderJson(note: CaptureNote): Record<string, unknown> {
  return {
    ok: true,
    id: note.id,
    path: note.path,
    body: note.body,
    guidance: note.guidance,
    source: note.provenance.source,
    sender: note.provenance.sender,
    captured_at: note.provenance.capturedAt,
    staged: note.staged,
  };
}

export async function cmdBrainCapture(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    source: { type: "string" },
    sender: { type: "string" },
    guidance: { type: "string" },
    agent: { type: "string" },
    at: { type: "string" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;

  // The argument wins over stdin. Reading both and concatenating would
  // silently merge two authors' text into one capture; reading stdin when
  // an argument was given would discard what the caller typed.
  let body = positional.join(" ").trim();
  if (body.length === 0) {
    try {
      body = (await Bun.stdin.text()).trim();
    } catch (exc) {
      return refuse(
        `capture could not read the body from stdin: ${(exc as Error).message ?? String(exc)}`,
        asJson,
      );
    }
  }
  if (body.length === 0) {
    return refuse(`capture body is empty; pass it as an argument or on stdin. ${USAGE}`, asJson);
  }

  // An explicit `--at` keeps a backfilled capture on its own instant
  // rather than the wall clock of the shell that replayed it.
  const at = parseOptionalIsoDate(flags, "at");
  if (at.error !== null) return refuse(at.error, asJson);
  const capturedAt = isoSecond(at.value ?? new Date());

  let context;
  try {
    context = brainVerbContext(flags);
  } catch (exc) {
    if (exc instanceof CliError) return refuse(exc.message, asJson);
    throw exc;
  }

  const guidance = normalizeFlagString(flags["guidance"]);
  // A `--guidance` that was passed and normalises away is whitespace the
  // caller meant as an instruction. The contract refuses it by name; this
  // check exists so the refusal names the FLAG rather than the field.
  if (flags["guidance"] !== undefined && guidance === null) {
    return refuse(
      "capture --guidance was passed with no text; drop the flag or say something",
      asJson,
    );
  }

  try {
    const note = writeCaptureNote(context.vault, {
      body,
      provenance: {
        source: normalizeFlagString(flags["source"]) ?? DEFAULT_SOURCE,
        sender: normalizeFlagString(flags["sender"]) ?? resolveBrainAgent(flags, context.config),
        capturedAt,
      },
      ...(guidance === null ? {} : { guidance }),
    });
    if (asJson) okJson(renderJson(note));
    else {
      ok(`captured: ${note.id}`);
      ok(`  path: ${note.path}`);
      ok(`  source: ${note.provenance.source} / sender: ${note.provenance.sender}`);
      if (note.guidance !== null) ok(`  guidance: ${note.guidance}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof CaptureContractError) return refuse(exc.message, asJson);
    if (exc instanceof CliError) return refuse(exc.message, asJson);
    throw exc;
  }
}
