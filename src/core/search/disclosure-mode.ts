/**
 * Result-depth disclosure vocabulary (progressive 3-layer recall), kept in
 * a leaf module with no imports so the search types, the CLI flag and the
 * MCP tool read one list.
 *
 * `full` (default) is the historical flat search: every hit carries its
 * full chunk content. `cards` returns compact layer-1 cards instead -
 * path/title/score/reasons/snippet/pointer, no full content - so recall
 * stays token-cheap and the agent pays for depth only by calling
 * `expandHit` (layer 2 fuller note, layer 3 raw transcript).
 */
export const DISCLOSURE_MODE = Object.freeze({ full: "full", cards: "cards" } as const);
export type DisclosureMode = (typeof DISCLOSURE_MODE)[keyof typeof DISCLOSURE_MODE];

/** Every accepted mode, in declaration order: the MCP enum and every refusal message. */
export const DISCLOSURE_MODES: ReadonlyArray<DisclosureMode> = Object.freeze(
  Object.values(DISCLOSURE_MODE),
);

/** The mode an absent `disclosure` resolves to: full content. */
export const DEFAULT_DISCLOSURE_MODE: DisclosureMode = DISCLOSURE_MODE.full;

/**
 * The one enum check the CLI flag and the MCP argument apply; each layer
 * raises its own error type naming {@link DISCLOSURE_MODES} when it
 * answers false.
 */
export function isDisclosureMode(value: unknown): value is DisclosureMode {
  return typeof value === "string" && (DISCLOSURE_MODES as ReadonlyArray<string>).includes(value);
}
