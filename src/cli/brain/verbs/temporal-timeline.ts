import { isBrainLogEventKind, type BrainLogEventKind } from "../../../core/brain/types.ts";
import { buildTimelineIndex } from "../../../core/brain/temporal/build-index.ts";
import { selectEvents } from "../../../core/brain/temporal/select-events.ts";
import { CliError, brainVerbContext, localTimeFields, parse } from "../helpers.ts";

/**
 * `o2b brain timeline [--vault PATH] [--pref-id ID] [--topic SLUG]
 *                     [--kind KIND] [--since ISO] [--until ISO]
 *                     [--limit N] [--json]`
 *
 * Chronological event list filtered by any combination of pref-id /
 * topic / kind / since / until / limit. Reads `Brain/log/<date>.jsonl`
 * via the canonical TimelineIndex builder.
 */
export async function cmdBrainTimeline(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "pref-id": { type: "string" },
    topic: { type: "string" },
    kind: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);

  const prefId = trimOrUndefined(flags["pref-id"]);
  const topic = trimOrUndefined(flags["topic"]);
  const kindRaw = trimOrUndefined(flags["kind"]);
  const since = trimOrUndefined(flags["since"]);
  const until = trimOrUndefined(flags["until"]);
  const limitRaw = trimOrUndefined(flags["limit"]);

  let kind: BrainLogEventKind | undefined;
  if (kindRaw !== undefined) {
    if (!isBrainLogEventKind(kindRaw)) {
      throw new CliError(`brain timeline: unknown kind '${kindRaw}'`);
    }
    kind = kindRaw;
  }

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    if (!/^[0-9]+$/.test(limitRaw)) {
      throw new CliError(`brain timeline: --limit must be a positive integer`);
    }
    const parsed = Number.parseInt(limitRaw, 10);
    if (parsed < 1) {
      throw new CliError(`brain timeline: --limit must be a positive integer`);
    }
    limit = parsed;
  }

  const index = buildTimelineIndex(vault, {
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  });
  const events = selectEvents(index, {
    ...(prefId !== undefined ? { prefId } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  });
  const sliced = limit !== undefined ? events.slice(0, limit) : events;

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        { window: index.window, total: events.length, events: sliced, ...localTimeFields(config) },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(`Timeline window ${index.window.since} .. ${index.window.until}\n`);
  process.stdout.write(`${sliced.length} of ${events.length} event(s):\n`);
  for (const ev of sliced) {
    const slug = ev.prefId ?? ev.topic ?? "-";
    process.stdout.write(`  ${ev.at}  ${ev.kind}  ${slug}${ev.result ? `  [${ev.result}]` : ""}\n`);
  }
  return 0;
}

function trimOrUndefined(v: string | boolean | string[] | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}
