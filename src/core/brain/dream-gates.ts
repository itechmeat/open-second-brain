/**
 * The operator-facing vocabulary for {@link DreamGateOverrides}
 * (no-dead-ends, Unit E - operator surface).
 *
 * `DreamOptions.gates` shipped as a TypeScript field with no way to reach
 * it from a shell or from MCP, which is not the capability the unit asked
 * for: the point of a per-run override is that an operator can steer one
 * pass WITHOUT editing `Brain/_brain.yaml` and remembering to revert it.
 * This module is the one place that maps what an operator types onto that
 * field, so the CLI flag and the MCP argument cannot drift apart.
 *
 * ## Why the gate names are spelled in snake case
 *
 * A gate name is not a CLI flag - it is the VALUE of one (`--gate
 * heal_enrich=true`), and it names a key an operator would otherwise edit
 * in `_brain.yaml` (`dream.heal_enrich_enabled`). Spelling it the way the
 * configuration spells it means there is exactly one gate vocabulary
 * across the flag, the MCP argument, the override field and the config
 * key, and no translation table anyone can get wrong. The kebab-cased
 * `heal-enrich` token belongs to {@link DREAM_STEP}, which is a different
 * vocabulary (units of work, not switches).
 *
 * ## Why every malformed entry throws
 *
 * An override that cannot be understood must never resolve to "leave the
 * configured value alone": that is a silent no-op wearing the costume of
 * an applied setting, and the operator would read the run's behaviour as
 * evidence that the gate did nothing. Every rejection names the entry,
 * the reason, and the accepted vocabulary.
 */

import type { DreamGateOverrides } from "./dream.ts";

/**
 * Gate names an operator may override, keyed by the field they set on
 * {@link DreamGateOverrides}. Deliberately closed: a general config
 * overlay would let any resolved key be replaced for one run, which is
 * far more surface than the single boolean switch that motivated this.
 */
export const DREAM_GATE = Object.freeze({
  healEnrich: "heal_enrich",
} as const);

export type DreamGateName = (typeof DREAM_GATE)[keyof typeof DREAM_GATE];

/** Canonical order every refusal lists the known gates in. */
export const DREAM_GATE_NAMES: ReadonlyArray<DreamGateName> = Object.freeze([
  DREAM_GATE.healEnrich,
]);

/**
 * Accepted boolean tokens, in the spelling `_brain.yaml` itself uses.
 * No looser vocabulary (`on`, `yes`, `1`) is accepted: two ways to write
 * one value is two things to keep in step for no gain.
 */
const GATE_TOKENS: Readonly<Record<string, boolean>> = Object.freeze({
  true: true,
  false: false,
});

/** The separator in a `<name>=<value>` command-line entry. */
const ENTRY_SEPARATOR = "=";

/**
 * Raised when a gate override cannot be honoured exactly as written.
 * Carries the offending entry and the known gate names so a caller
 * reading only the error knows what it may ask for instead.
 */
export class DreamGateOverrideError extends Error {
  /** The entry the caller supplied, verbatim. */
  readonly entry: string;
  /** The gate names this build understands. */
  readonly known: ReadonlyArray<DreamGateName>;

  constructor(entry: string, reason: string) {
    super(
      `dream gate override '${entry}' cannot be applied: ${reason}. ` +
        `Known gates: ${DREAM_GATE_NAMES.join(", ")}.`,
    );
    this.name = "DreamGateOverrideError";
    this.entry = entry;
    this.known = DREAM_GATE_NAMES;
  }
}

const isKnownGate = (name: string): name is DreamGateName =>
  (DREAM_GATE_NAMES as ReadonlyArray<string>).includes(name);

/**
 * Validate an already-typed `{ gate: boolean }` record - the shape a JSON
 * caller (MCP) sends - into {@link DreamGateOverrides}.
 *
 * An empty record yields an empty override set, which is meaningful: the
 * caller asked for no override and every gate resolves from the vault
 * configuration, exactly as it does today.
 */
export function validateDreamGateOverrides(
  record: Readonly<Record<string, unknown>>,
): DreamGateOverrides {
  const overrides: { -readonly [K in keyof DreamGateOverrides]: DreamGateOverrides[K] } = {};
  for (const [name, value] of Object.entries(record)) {
    if (!isKnownGate(name)) {
      throw new DreamGateOverrideError(name, "it is not a gate this dream pass resolves");
    }
    if (typeof value !== "boolean") {
      throw new DreamGateOverrideError(
        name,
        `its value must be a boolean, not ${typeof value === "object" ? "an object" : `a ${typeof value}`}`,
      );
    }
    overrides[name] = value;
  }
  return Object.freeze(overrides);
}

/**
 * Parse repeated `<name>=<value>` command-line entries into
 * {@link DreamGateOverrides}.
 *
 * Two entries naming the same gate are a contradiction, not a
 * last-one-wins: an operator who typed both did not mean either, and
 * silently picking one would apply a setting they never asked for.
 */
export function parseDreamGateOverrides(entries: ReadonlyArray<string>): DreamGateOverrides {
  const record: Record<string, boolean> = {};
  for (const entry of entries) {
    const separator = entry.indexOf(ENTRY_SEPARATOR);
    if (separator === -1) {
      throw new DreamGateOverrideError(
        entry,
        `it carries no '${ENTRY_SEPARATOR}' - the form is <name>${ENTRY_SEPARATOR}<${Object.keys(GATE_TOKENS).join("|")}>`,
      );
    }
    const name = entry.slice(0, separator);
    const token = entry.slice(separator + 1);
    if (!isKnownGate(name)) {
      throw new DreamGateOverrideError(entry, `'${name}' is not a gate this dream pass resolves`);
    }
    if (!Object.hasOwn(GATE_TOKENS, token)) {
      throw new DreamGateOverrideError(
        entry,
        `'${token}' is not a boolean - accepted values are ${Object.keys(GATE_TOKENS).join(" and ")}`,
      );
    }
    const value = GATE_TOKENS[token]!;
    if (Object.hasOwn(record, name) && record[name] !== value) {
      throw new DreamGateOverrideError(
        entry,
        `'${name}' was already overridden to ${String(record[name])} in this invocation`,
      );
    }
    record[name] = value;
  }
  return validateDreamGateOverrides(record);
}
