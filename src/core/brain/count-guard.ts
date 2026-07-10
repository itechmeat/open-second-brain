/**
 * Count guards for mutating operations.
 *
 * Ports the discipline from iwe's mutating markdown ops (not its block-query
 * DSL): an `--expect N` assertion that a mutation will touch exactly N items,
 * and a `--strict` mode that refuses any guardless mutation. On a mismatch the
 * operation aborts BEFORE writing, surfacing the actual match list so the
 * operator sees precisely what would have changed. Both guards default off, so
 * an op that passes neither is byte-identical to before.
 */

export class CountGuardError extends Error {
  readonly code = "COUNT_GUARD";
  readonly matched: number;
  readonly expected: number | null;
  readonly matchList: ReadonlyArray<string>;

  constructor(message: string, matched: number, expected: number | null, matchList: string[]) {
    super(message);
    this.name = "CountGuardError";
    this.matched = matched;
    this.expected = expected;
    this.matchList = matchList;
  }
}

export interface CountGuardOptions {
  /** How many items the operation matched / would touch. */
  readonly matched: number;
  /** `--expect N`: the asserted count. Absent/null means no assertion. */
  readonly expect?: number | null;
  /** `--strict`: refuse a mutation that carries no `--expect` guard. */
  readonly strict?: boolean;
  /** True when this call is about to actually mutate (not a dry-run). */
  readonly willMutate: boolean;
  /** The matched items, surfaced in the error so the operator sees them. */
  readonly matchList?: ReadonlyArray<string>;
}

/** Cap on how many match entries are inlined into the error message. */
const MATCH_LIST_PREVIEW = 20;

/**
 * Assert the guards. Throws {@link CountGuardError} on an `--expect` mismatch
 * or on a guardless mutation under `--strict`; otherwise returns. Call this
 * before performing the write, with the count the operation would touch.
 */
export function assertExpectedCount(opts: CountGuardOptions): void {
  const matchList = [...(opts.matchList ?? [])];
  const expected = opts.expect ?? null;

  if (expected !== null && expected !== opts.matched) {
    throw new CountGuardError(
      `--expect ${expected} but the operation matched ${opts.matched}; aborting without writing.` +
        renderMatchList(matchList),
      opts.matched,
      expected,
      matchList,
    );
  }

  if (opts.strict && expected === null && opts.willMutate) {
    throw new CountGuardError(
      `--strict refuses a guardless mutation: pass --expect ${opts.matched} to confirm the ` +
        `${opts.matched} matched item(s), or drop --strict.` +
        renderMatchList(matchList),
      opts.matched,
      null,
      matchList,
    );
  }
}

function renderMatchList(matchList: ReadonlyArray<string>): string {
  if (matchList.length === 0) return "";
  const shown = matchList.slice(0, MATCH_LIST_PREVIEW);
  const suffix =
    matchList.length > MATCH_LIST_PREVIEW
      ? `\n  ... and ${matchList.length - MATCH_LIST_PREVIEW} more`
      : "";
  return `\nMatched:\n${shown.map((m) => `  - ${m}`).join("\n")}${suffix}`;
}
