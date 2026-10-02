/**
 * The scope axes a scoped operator rule file is keyed on
 * (`Brain/standing-rules/<axis>/<key>.md`).
 *
 * A leaf module with no imports: `paths.ts` types `brainScopedRulePath`
 * with it, and `scoped-rules.ts` (which imports `paths.ts`) re-exports it,
 * so the path helpers and the reader do not form an import cycle.
 */

/** The three scope axes a rule file can be keyed on. */
export const SCOPED_RULE_AXIS = Object.freeze({
  project: "project",
  harness: "harness",
  host: "host",
} as const);

export type ScopedRuleAxis = (typeof SCOPED_RULE_AXIS)[keyof typeof SCOPED_RULE_AXIS];

/**
 * The axes in render order, which is also the drop priority under the cap:
 * the index is the priority, so the host file drops first.
 */
export const SCOPED_RULE_AXES: ReadonlyArray<ScopedRuleAxis> = Object.freeze([
  SCOPED_RULE_AXIS.project,
  SCOPED_RULE_AXIS.harness,
  SCOPED_RULE_AXIS.host,
]);

export function isScopedRuleAxis(value: unknown): value is ScopedRuleAxis {
  return typeof value === "string" && (SCOPED_RULE_AXES as ReadonlyArray<string>).includes(value);
}
