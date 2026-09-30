/**
 * The FTS match-mode vocabulary (t_c5326ece), kept in a leaf module with no
 * imports so the search request types, the CLI and the MCP tool can name
 * the modes without importing the FTS query builder and its store graph.
 */

/**
 * The caller-selectable match breadth (t_c5326ece). `all` (default) keeps
 * the implicit AND the bag-of-tokens query always had; `any` OR-joins the
 * same cleaned tokens so a document matching any one term is a hit. Both
 * modes drop caller-typed FTS5 operator tokens first.
 */
export const FTS_MATCH_MODE = Object.freeze({ all: "all", any: "any" } as const);
export type FtsMatchMode = (typeof FTS_MATCH_MODE)[keyof typeof FTS_MATCH_MODE];

/** Every accepted mode, in declaration order: the MCP enum and every refusal message. */
export const FTS_MATCH_MODES: ReadonlyArray<FtsMatchMode> = Object.freeze(
  Object.values(FTS_MATCH_MODE),
);

/** The mode an absent `matchMode` resolves to: today's implicit AND. */
export const DEFAULT_FTS_MATCH_MODE: FtsMatchMode = FTS_MATCH_MODE.all;

/**
 * The one enum check every entry point (CLI flag, MCP argument, request
 * resolution) applies; each layer raises its own error type naming
 * {@link FTS_MATCH_MODES} when it answers false.
 */
export function isFtsMatchMode(value: unknown): value is FtsMatchMode {
  return typeof value === "string" && (FTS_MATCH_MODES as ReadonlyArray<string>).includes(value);
}
