import {
  resolveLogEventTraces,
  type AttachedTrace,
  type LogEventTrace,
} from "../../../core/brain/event-trace.ts";
import { BRAIN_LOG_EVENT_KIND_SET, type BrainLogEventKind } from "../../../core/brain/types.ts";
import { brainVerbContext, parse, usageError } from "../helpers.ts";

/**
 * `o2b brain event-trace` — given one or more logged Brain events,
 * resolve and display the continuity records (recall telemetry, context
 * receipts, generation reports, …) attached to each via shared
 * correlation ids. The integrated "why did the agent do this?" reader:
 * one surface joining the event log to the served-context trace.
 */
export async function cmdBrainEventTrace(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    date: { type: "string" },
    at: { type: "string" },
    kind: { type: "string" },
    "session-id": { type: "string" },
    limit: { type: "string" },
    "keep-private": { type: "boolean" },
  });

  const kindRaw = trimOrUndefined(flags["kind"]);
  if (kindRaw !== undefined && !BRAIN_LOG_EVENT_KIND_SET.has(kindRaw)) {
    // Bad flag value is a usage error (exit 2, plain stderr), not a runtime
    // failure (exit 1). Same for --limit and the resolver's selector checks.
    return usageError(`brain event-trace: unknown event kind '${kindRaw}'`);
  }
  const limitRaw = trimOrUndefined(flags["limit"]);
  if (limitRaw !== undefined && (!/^[0-9]+$/.test(limitRaw) || Number.parseInt(limitRaw, 10) < 1)) {
    return usageError(`brain event-trace: --limit must be a positive integer`);
  }
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
  const vault = brainVerbContext(flags).vault;

  let results: ReadonlyArray<LogEventTrace>;
  try {
    results = resolveLogEventTraces(vault, {
      ...(trimOrUndefined(flags["date"]) !== undefined
        ? { date: trimOrUndefined(flags["date"])! }
        : {}),
      ...(trimOrUndefined(flags["at"]) !== undefined ? { at: trimOrUndefined(flags["at"])! } : {}),
      ...(kindRaw !== undefined ? { kind: kindRaw as BrainLogEventKind } : {}),
      ...(trimOrUndefined(flags["session-id"]) !== undefined
        ? { sessionId: trimOrUndefined(flags["session-id"])! }
        : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(flags["keep-private"] === true ? { keepPrivate: true } : {}),
    });
  } catch (err) {
    // The resolver validates selectors (--date, --at, --kind) before any IO
    // and a missing log day reads as empty rather than throwing, so a throw
    // here is a selector usage error: exit 2, not the runtime exit-1 path.
    return usageError(`brain event-trace: ${(err as Error).message}`);
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ total: results.length, events: results }, null, 2) + "\n",
    );
    return 0;
  }

  const totalTraces = results.reduce((sum, r) => sum + r.traceCount, 0);
  process.stdout.write(
    `${results.length} logged event(s), ${totalTraces} attached context trace(s):\n`,
  );
  for (const result of results) {
    const e = result.event;
    const stamp = e.timestamp.slice(11, 19);
    const tags = [
      e.sessionId ? `session=${e.sessionId}` : null,
      e.turnId ? `turn=${e.turnId}` : null,
      e.agent ? `agent=${e.agent}` : null,
    ].filter(Boolean);
    process.stdout.write(
      `\n${stamp}  ${e.eventType}${tags.length > 0 ? "  " + tags.join("  ") : ""}\n`,
    );
    if (result.traceCount === 0) {
      process.stdout.write("    (no attached context trace)\n");
      continue;
    }
    for (const trace of result.traces) {
      process.stdout.write(`    ${formatTrace(trace)}\n`);
    }
  }
  return 0;
}

function formatTrace(trace: AttachedTrace): string {
  const flags: string[] = [`via ${trace.joinedBy.join("+")}`];
  if (trace.handoffRef) flags.push(`handoff=${trace.handoffKind ?? "?"}:${trace.handoffRef}`);
  if (trace.sourceCount > 0) flags.push(`sources=${trace.sourceCount}`);
  if (trace.private) flags.push("private");
  if (trace.redacted) flags.push("redacted");
  return `${trace.createdAt}  ${trace.kind}  ${trace.id}  [${flags.join(", ")}]`;
}

function trimOrUndefined(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
