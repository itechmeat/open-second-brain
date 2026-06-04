/**
 * Activation kernel math (Time-Aware Recall & Activation Suite,
 * t_2bc79017).
 *
 * Pure ACT-R-style reactivation: every recorded access bumps a
 * per-document strength by a fixed step (capped at 1.0), and the
 * effective activation read at query time decays the stored strength by
 * a content-type half-life. Habitually-recalled memories stay hot;
 * unused ones fade without manual cleanup - and the types that encode
 * durable judgement (preferences, decisions, antipatterns) never decay
 * at all.
 *
 * No I/O and no clock: callers pass days-since-access, so the time
 * source stays injectable at the store/ranker boundary (the same rule
 * `recency.ts` follows).
 */

/** Strength gained per recorded access. */
export const ACTIVATION_STRENGTH_STEP = 0.1;
/** Ceiling for the stored strength. */
export const ACTIVATION_STRENGTH_MAX = 1;
/** Half-life for kinds the table does not name (plain notes). */
export const DEFAULT_HALF_LIFE_DAYS = 60;

/**
 * Content-type half-life table, keyed by the resolved activation kind.
 * `null` means "never decays" - the kinds that encode durable judgement
 * keep their full strength regardless of idle time. Values align with
 * the schema-pack vocabulary rather than inventing a parallel taxonomy.
 */
export const HALF_LIFE_DAYS: ReadonlyMap<string, number | null> = new Map<string, number | null>([
  ["preference", null],
  ["decision", null],
  ["antipattern", null],
  ["project", 120],
  ["handoff", 30],
  ["session", 30],
  ["note", DEFAULT_HALF_LIFE_DAYS],
]);

/** Path prefixes that imply a kind when frontmatter declares none. */
const PATH_KIND_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["Brain/preferences/", "preference"],
  ["Brain/decisions/", "decision"],
];

/**
 * Resolve the activation kind for a document: normalized frontmatter
 * `kind:` first (the framework `brain-` prefix is stripped, so
 * `kind: brain-preference` resolves to `preference`), then framework
 * path prefixes, then `note`.
 */
export function resolveActivationKind(frontmatterKind: string | null, path: string): string {
  const raw = frontmatterKind?.trim().toLowerCase() ?? "";
  const fromFrontmatter = raw.startsWith("brain-") ? raw.slice("brain-".length) : raw;
  if (fromFrontmatter !== "") return fromFrontmatter;
  for (const [prefix, kind] of PATH_KIND_PREFIXES) {
    if (path.startsWith(prefix)) return kind;
  }
  return "note";
}

/** Half-life in days for a kind; unknown kinds use the note default. */
export function halfLifeDays(kind: string): number | null {
  const entry = HALF_LIFE_DAYS.get(kind);
  return entry === undefined ? DEFAULT_HALF_LIFE_DAYS : entry;
}

/** One access: add a step, cap at the maximum. Junk reads as zero. */
export function bumpStrength(prev: number): number {
  const base = Number.isFinite(prev) && prev > 0 ? prev : 0;
  return Math.min(ACTIVATION_STRENGTH_MAX, base + ACTIVATION_STRENGTH_STEP);
}

/**
 * Effective activation at read time: the stored strength decayed by the
 * type half-life. Infinite half-life (null) returns the strength as-is;
 * future access times clamp to age zero; non-finite inputs yield 0.
 */
export function effectiveActivation(
  strength: number,
  daysSinceLastAccess: number,
  halfLife: number | null,
): number {
  if (!Number.isFinite(strength) || strength <= 0) return 0;
  if (halfLife === null) return strength;
  if (!(halfLife > 0)) return 0;
  if (!Number.isFinite(daysSinceLastAccess)) return 0;
  const age = Math.max(0, daysSinceLastAccess);
  return strength * Math.pow(2, -age / halfLife);
}
