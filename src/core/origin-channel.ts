/**
 * The origin channel — which kind of process put a record in the vault.
 *
 * ## Server-derived, and that is the whole design
 *
 * The channel is claimed ONCE per process by the entry point that knows
 * what the process is: the MCP server transport, the CLI dispatcher, and
 * the import verbs' dispatch. It is never a tool argument and never a
 * CLI flag, and `tests/core/architecture/origin-channel-census.test.ts`
 * asserts that rather than trusting this paragraph.
 *
 * The reason is measured, not stylistic. Agent identity in this codebase
 * resolves to a caller-supplied `agent` string that 25 MCP tool schemas
 * accept verbatim (the write binding's docblock documents the recount and
 * the command to redo it). A channel a caller could name would be the
 * same unverifiable claim wearing a schema — a record saying `cli` would
 * mean "someone typed cli", which is not provenance. So the value comes
 * from the process, or it comes back as {@link ORIGIN_CHANNEL_UNSET}.
 *
 * ## Why an `unset` literal rather than a guessed default
 *
 * {@link resolveOriginChannel} FAILS LOUD when nothing claimed the
 * process: reading a channel that no entry point set is a programming
 * error and the refusal names itself and the setter. The record writers
 * do not use that read. They use {@link originChannelStamp}, which
 * absorbs the unclaimed state into the explicit `unset` literal and
 * stamps THAT.
 *
 * This mirrors a decision already made one layer down, deliberately.
 * `appendLogEvent` absorbs a `resolveDeviceId` failure into the empty
 * shard id (`AppendLogEventOptions.deviceId`) because appending is the
 * always-on write path behind every hook, and failing it turns one bad
 * file mode into a dead session. The same argument holds here for all
 * four stamped families, and the absorbed value obeys the same rule the
 * device-id fallback does: it is a DOCUMENTED value with its own
 * meaning, not a neutral-looking invention. `unset` serializes as
 * `unset`, is outside {@link ORIGIN_CHANNELS}, and reads on disk as
 * exactly what it is — no entry point claimed this process. A guessed
 * `cli` would have been the lie this unit exists to remove.
 *
 * ## No backfill
 *
 * Records written before this shipped carry no channel and are NOT
 * rewritten to add one. Rewriting history to add provenance is the
 * opposite of provenance: the value stamped on a backfill pass would
 * describe the backfill process, not the process that wrote the record.
 * Absence of the key means "written before the stamp existed", and every
 * reader treats it that way.
 *
 * ## Three adjacent axes this is NOT
 *
 *   - `ProvenanceLevel` (`brain/provenance/provenance.ts`) is a TRUST
 *     band — `stated` > `deduced` > `inferred` — about how a claim was
 *     arrived at. A channel is not a trust band: an `mcp-tool` record can
 *     be `inferred` and a `cli` record can be `stated`.
 *   - `classifySourceOrigin` (`brain/intake/source-trust.ts`) is an
 *     INBOUND-SOURCE axis about the file an intake read. A channel says
 *     nothing about the source and everything about the writer.
 *   - `RECALL_CHANNEL` (`brain/recall-telemetry.ts`) is the nearest one
 *     and the one most worth being explicit about, because its members
 *     (`mcp` / `cli` / `hook`) nearly rhyme with these. It measures the
 *     transport a recall was DELIVERED over — the read direction — and it
 *     is caller-supplied by design, being a property of a delivery the
 *     caller performed. This is the WRITE direction and is derived rather
 *     than supplied. Two records can disagree on them honestly: a hook
 *     delivers a recall (`recall_channel: hook`) inside a process that
 *     writes its telemetry over `origin_channel: cli`. Folding either
 *     into the other would make one of those two facts unrecordable.
 *
 * None may be folded into this one, and none may absorb it.
 */

/**
 * The closed vocabulary. Three members because three process shapes can
 * put a record in the vault, and each one is a different answer to "who
 * would I ask about this record":
 *
 *   - `mcp-tool` — an agent called a tool over the MCP transport.
 *   - `cli`      — an operator (or a script) ran `o2b`.
 *   - `import`   — a bulk replay of records authored somewhere else.
 *
 * Spellings are on-disk values and are load-bearing; the hyphen in
 * `mcp-tool` matches the `apply-evidence` shape the log-event vocabulary
 * already uses.
 */
export const ORIGIN_CHANNEL = Object.freeze({
  mcpTool: "mcp-tool",
  cli: "cli",
  import: "import",
} as const);

export type OriginChannel = (typeof ORIGIN_CHANNEL)[keyof typeof ORIGIN_CHANNEL];

/**
 * The membership list, exported so a refusal can NAME the vocabulary
 * instead of restating it — the same rule `BRAIN_SIGNAL_SOURCE_TYPES`
 * follows, and for the same reason: a hand-written list in a message
 * goes stale on the first new member and teaches the wrong contract.
 */
export const ORIGIN_CHANNELS: ReadonlyArray<OriginChannel> = Object.freeze(
  Object.values(ORIGIN_CHANNEL),
);

/**
 * What a record carries when no entry point claimed the process.
 * Deliberately OUTSIDE {@link ORIGIN_CHANNELS} so a reader can tell it
 * apart from every real answer without knowing this module.
 */
export const ORIGIN_CHANNEL_UNSET = "unset";

/** What a stamped record actually holds: a channel, or the unset literal. */
export type OriginChannelStamp = OriginChannel | typeof ORIGIN_CHANNEL_UNSET;

/**
 * The on-disk key. One constant because three of the four stamped
 * families spell it in a text surface — a log bullet, a signal
 * frontmatter line, a note frontmatter line — and a key that drifts
 * between them is a key no reader can query on. The continuity record is
 * the exception and uses `originChannel`, because its record shape is
 * camelCase JSON throughout (`createdAt`, `sourceRefs`) and a lone
 * snake_case field there would be the drift, not the consistency.
 */
export const ORIGIN_CHANNEL_FIELD = "origin_channel";

export function isOriginChannel(value: unknown): value is OriginChannel {
  return typeof value === "string" && (ORIGIN_CHANNELS as ReadonlyArray<string>).includes(value);
}

export function isOriginChannelStamp(value: unknown): value is OriginChannelStamp {
  return value === ORIGIN_CHANNEL_UNSET || isOriginChannel(value);
}

/** Raised by {@link resolveOriginChannel} when nothing claimed the process. */
export class OriginChannelUnsetError extends Error {
  constructor() {
    super(
      "resolveOriginChannel: no entry point claimed an origin channel for this process; " +
        "the MCP transport, the CLI dispatcher and the import verbs each call " +
        `setOriginChannel(...) with one of ${ORIGIN_CHANNELS.join(", ")}. Record writers ` +
        `must call originChannelStamp() instead, which stamps '${ORIGIN_CHANNEL_UNSET}'.`,
    );
    this.name = "OriginChannelUnsetError";
  }
}

/** Process-scoped, module-private. `null` until an entry point claims it. */
let claimed: OriginChannel | null = null;

/**
 * Claim the channel for this process. Called by the entry point, before
 * any dispatch.
 *
 * Re-claiming is allowed and the LAST claim wins. This is not laxity: a
 * single OS process re-enters the entry point routinely — the CLI test
 * harness calls `main()` many times, and an embedded host can start the
 * MCP transport inside a process that already ran a command. Refusing
 * the second claim would fail those runs over a value that is correct;
 * refusing to let a MID-FLIGHT caller set it is what actually matters,
 * and that is enforced by there being no argument and no flag that
 * reaches this function, which the origin-channel census asserts.
 */
export function setOriginChannel(channel: OriginChannel): void {
  if (!isOriginChannel(channel)) {
    throw new Error(
      `setOriginChannel: ${JSON.stringify(channel)} is not an origin channel; ` +
        `expected one of ${ORIGIN_CHANNELS.join(", ")}`,
    );
  }
  claimed = channel;
}

/**
 * Return the process to unclaimed. The counterpart of
 * {@link setOriginChannel} for a harness that hands the process back
 * between runs; production entry points claim and never release.
 */
export function clearOriginChannel(): void {
  claimed = null;
}

/**
 * The strict read: the channel this process claimed, or a refusal.
 *
 * Use it where a wrong answer is worse than no answer. Record writers
 * want {@link originChannelStamp} instead — see the module docblock for
 * why the always-on write path absorbs this condition rather than
 * propagating it.
 */
export function resolveOriginChannel(): OriginChannel {
  if (claimed === null) throw new OriginChannelUnsetError();
  return claimed;
}

/**
 * The record-writer read: the claimed channel, or the explicit
 * {@link ORIGIN_CHANNEL_UNSET} literal. Never throws, never guesses.
 */
export function originChannelStamp(): OriginChannelStamp {
  try {
    return resolveOriginChannel();
  } catch {
    // The documented absorb. See the module docblock: a write path that
    // fails over its own provenance stamp costs the record it was
    // stamping, and `unset` loses nothing that was ever known.
    return ORIGIN_CHANNEL_UNSET;
  }
}
