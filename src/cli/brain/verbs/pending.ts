/**
 * `o2b brain pending <list|apply|reject>` - the write-approval queue surface
 * (A3, t_e540b093). Thin CLI wrapper over `src/core/brain/pending.ts`.
 *
 * When `write_approval.enabled` is on, extracted signals are staged into
 * `Brain/pending/`; these verbs let an operator review the queue: `list` shows
 * the staged signals, `apply <id>` moves one into `Brain/inbox/` unchanged, and
 * `reject <id> --reason <text>` moves it to `Brain/retired/`. A missing id is a
 * typed error surfaced as exit 2 (not a silent no-op).
 */

import {
  applyPending,
  listPending,
  PendingSignalNotFoundError,
  rejectPending,
} from "../../../core/brain/pending.ts";
import { brainVerbContext, fail, normalizeFlagString, ok, okJson, parse } from "../helpers.ts";

export async function cmdBrainPending(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "list":
      return pendingList(rest);
    case "apply":
      return pendingApply(rest);
    case "reject":
      return pendingReject(rest);
    default:
      return fail(
        "brain pending requires a subcommand: list | apply <id> | reject <id> --reason <text>",
      );
  }
}

function pendingList(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  try {
    const entries = listPending(vault);
    if (flags["json"]) {
      okJson({
        pending: entries.map((e) => ({
          id: e.id,
          topic: e.signal.topic,
          principle: e.signal.principle,
          created_at: e.signal.created_at,
          path: e.path,
        })),
        total: entries.length,
      });
    } else if (entries.length === 0) {
      ok("no pending signals");
    } else {
      for (const e of entries) ok(`${e.id}  ${e.signal.topic}  ${e.signal.principle}`);
    }
    return 0;
  } catch (exc) {
    return fail(`brain pending list failed: ${(exc as Error).message}`);
  }
}

function pendingApply(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) return fail("brain pending apply requires an <id> argument");
  const { vault } = brainVerbContext(flags);
  try {
    const res = applyPending(vault, positional[0]!);
    if (flags["json"]) {
      okJson({ id: res.id, path: res.path, status: "applied" });
    } else {
      ok(`applied: ${res.id}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof PendingSignalNotFoundError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    return fail(`brain pending apply failed: ${(exc as Error).message}`);
  }
}

function pendingReject(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    reason: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) return fail("brain pending reject requires an <id> argument");
  const reason = normalizeFlagString(flags["reason"]);
  if (reason === null) return fail("brain pending reject requires --reason <text>");
  const { vault } = brainVerbContext(flags);
  try {
    const res = rejectPending(vault, positional[0]!, reason, { now: new Date() });
    if (flags["json"]) {
      okJson({ id: res.id, path: res.path, status: "rejected", reason });
    } else {
      ok(`rejected: ${res.id}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof PendingSignalNotFoundError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    return fail(`brain pending reject failed: ${(exc as Error).message}`);
  }
}
