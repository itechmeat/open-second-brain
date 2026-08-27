/**
 * How far the caller of this process had to reach to get here.
 *
 * A vault page may reserve itself against remote reads (see
 * {@link REMOTE_DENY_VISIBILITY_TOKEN} in `./visibility.ts`). Deciding
 * whether a given read is such a read needs one fact, and the only party
 * that holds it is the TRANSPORT: stdio and the CLI run inside a process
 * the caller already started on this host, while an HTTP request arrives
 * from wherever it arrives from.
 *
 * So the value is MINTED by each transport constructor and never parsed
 * out of a request. A caller-supplied trust claim is not a trust claim -
 * the rule `src/mcp/owner-scope-refusal.ts` states once for owner
 * identity, applied here to reach - which is why a reach-shaped member in
 * a tool's arguments is refused by name rather than read.
 *
 * What each member actually proves, stated plainly rather than
 * overclaimed:
 *
 *   - `local` - the caller already holds filesystem-equivalent access to
 *     this vault (stdio and the CLI run as a child of the caller), or the
 *     request originated on this host (a loopback HTTP bind). It does NOT
 *     prove operator intent: a remote host can spawn a stdio subprocess.
 *     The alternative - no bypass at all - would take an operator's own
 *     private notes away from their own CLI, so the bypass exists and its
 *     limit is written down here.
 *   - `remote` - nothing beyond "a request arrived". This is the default
 *     for every non-loopback bind, and the reach a page reserving itself
 *     against remote reads is reserved against.
 *
 * Naming: `disclosure` was the design's word for this, and it is already
 * taken in this tree - `SearchOptions.disclosure` is the progressive
 * result-DEPTH mode (`full` | `cards`). Two fields called `disclosure` on
 * one options bag, meaning different things, is the "one rule, two
 * spellings" defect this suite exists to remove, so the transport fact is
 * named for what it measures instead.
 */

/** The closed vocabulary. See the module docblock for what each proves. */
export const TRANSPORT_REACH = Object.freeze({
  /** Filesystem-equivalent access, or a request from this host. */
  local: "local",
  /** A request arrived, and nothing further is established. */
  remote: "remote",
} as const);

/** Closed union over {@link TRANSPORT_REACH}. */
export type TransportReach = (typeof TRANSPORT_REACH)[keyof typeof TRANSPORT_REACH];

/** Membership list, widest-access-first. */
export const TRANSPORT_REACHES: ReadonlyArray<TransportReach> = Object.freeze([
  TRANSPORT_REACH.local,
  TRANSPORT_REACH.remote,
]);

/**
 * Narrow a reach read back off a stored envelope or a test fixture.
 *
 * Deliberately NOT used to accept one from a request - see the module
 * docblock for why a reach arriving from a caller is refused instead.
 */
export function isTransportReach(value: unknown): value is TransportReach {
  return typeof value === "string" && (TRANSPORT_REACHES as ReadonlyArray<string>).includes(value);
}
