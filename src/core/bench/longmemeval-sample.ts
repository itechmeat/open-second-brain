/**
 * Seeded, question-type-proportional sampling for the LongMemEval suite
 * (wiring-shipped-seams wave, t_4501c662).
 *
 * The LongMemEval lane runs its dataset wholesale, and the full official
 * files carry hundreds of questions per run. This module selects a
 * DETERMINISTIC subset so a bench run can trade coverage for cost
 * without losing the type balance the benchmark's aggregate is computed
 * over: the survivors of abstention exclusion are stratified by their
 * present `question_type` values, a cap is apportioned across strata by
 * largest remainder (ties broken by stratum name), and each stratum
 * contributes its share, chosen by a seeded shuffle.
 *
 * Determinism contract: no Math.random, no wall clock, no fs. The
 * selection is a pure function of (entries, seed, cap). Entries are
 * sorted by question id before the PRNG is touched, so dataset file
 * order cannot change the subset; the PRNG is a mulberry32 stream keyed
 * by the sha256 of the TRIMMED seed string. The seed is normalized in
 * exactly one place - HERE, before the digest - so the same input
 * selects the same subset whatever surface (CLI or API) passed it:
 * callers may refuse a blank seed early to name their own surface, but
 * must not trim or otherwise transform the value. The same options
 * always select the same subset; a different seed or cap selects a
 * different one.
 *
 * The abstention rule lives here rather than in longmemeval.ts because
 * abstention exclusion must happen BEFORE selection, and this module
 * must not import the suite adapter - the adapter imports this module,
 * so the reverse edge would close a cycle. longmemeval.ts re-exports
 * the predicate and its constant, leaving the suite's public API
 * unchanged.
 *
 * An all-abstention (or empty) population, a duplicated question id -
 * which would make the selection depend on dataset file order - and a
 * malformed option raise the named {@link LongMemEvalSampleError},
 * never a silent wholesale run.
 */

import { sha256Hex } from "../integrity/digest.ts";

/**
 * The explicit question type whose entries measure abstention. Shared
 * with the suite adapter, which re-exports it.
 */
export const LONGMEMEVAL_ABSTENTION_TYPE = "abstention";

/** Suffix the official dataset puts on abstention question ids. */
const OFFICIAL_ABSTENTION_SUFFIX = "_abs";

/** The entry shape sampling reads; the suite's full entry satisfies it. */
export interface LongMemEvalSampleEntry {
  readonly q_id: string;
  readonly question_type: string;
}

/**
 * True when an entry measures abstention and is excluded from scoring.
 * The official dataset marks abstention by a question id ending in
 * {@link OFFICIAL_ABSTENTION_SUFFIX}; the legacy sample shape uses the
 * explicit {@link LONGMEMEVAL_ABSTENTION_TYPE} question type. Both
 * paths stay live, and both are excluded before any selection runs.
 */
export function isLongMemEvalAbstention(entry: LongMemEvalSampleEntry): boolean {
  return (
    entry.question_type === LONGMEMEVAL_ABSTENTION_TYPE ||
    entry.q_id.endsWith(OFFICIAL_ABSTENTION_SUFFIX)
  );
}

/** Sampling options: an opaque seed string and a positive integer cap. */
export interface LongMemEvalSampleOptions {
  readonly seed: string;
  readonly cap: number;
}

/** One stratum's population and selected count, for the receipt. */
export interface LongMemEvalSampleStratum {
  readonly question_type: string;
  readonly population: number;
  readonly selected: number;
}

/**
 * What one sampling decision decided, surfaced beside the selected
 * entries so a report can state what a run measured instead of letting
 * a reader assume the whole dataset was scored.
 */
export interface LongMemEvalSampleReceipt {
  /** Entries excluded as abstention before any selection ran. */
  readonly abstention_excluded: number;
  /** Survivors the sampler chose from. */
  readonly population: number;
  /** Entries selected: min(cap, population). */
  readonly selected: number;
  /** One row per present question type, sorted by name ascending. */
  readonly strata: ReadonlyArray<LongMemEvalSampleStratum>;
}

export interface LongMemEvalSampleSelection<E> {
  readonly entries: ReadonlyArray<E>;
  readonly receipt: LongMemEvalSampleReceipt;
}

/**
 * The sampler's named error: a population that is empty once abstention
 * entries are excluded, a duplicated question id, or a malformed
 * option. Callers catch it by name; a sampling failure is never
 * downgraded to a wholesale run.
 */
export class LongMemEvalSampleError extends Error {}

/** Hex characters of the seed digest folded into the PRNG state. */
const SEED_HASH_HEX_CHARS = 8;

/**
 * A mulberry32 PRNG: 32 bits of state, a multiply-shift per draw,
 * identical output for a given state on every platform.
 */
function mulberry32(state: number): () => number {
  let current = state >>> 0;
  return () => {
    current = (current + 0x6d2b79f5) | 0;
    let t = current;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Key the PRNG state from the seed string through the shared digest. */
function prngState(seed: string): number {
  return Number.parseInt(sha256Hex(seed).slice(0, SEED_HASH_HEX_CHARS), 16) >>> 0;
}

/** Fisher-Yates over a copy; the input array is never mutated. */
function shuffled<E>(items: ReadonlyArray<E>, random: () => number): E[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swapped = out[i]!;
    out[i] = out[j]!;
    out[j] = swapped;
  }
  return out;
}

/**
 * Select a seeded, type-proportional subset of LongMemEval entries.
 *
 * Abstention entries are excluded first (their count rides the
 * receipt), the survivors are stratified by their present
 * `question_type` values, the cap is apportioned across strata by
 * largest remainder with ties broken by stratum name, and each stratum
 * contributes its share chosen by the seeded shuffle. The selected
 * entries come back in canonical question-id order whatever order the
 * dataset carried.
 *
 * Raises {@link LongMemEvalSampleError} for a malformed option, a
 * duplicated question id, or a population that is empty once
 * abstention entries are excluded.
 */
export function sampleLongMemEvalEntries<E extends LongMemEvalSampleEntry>(
  entries: ReadonlyArray<E>,
  opts: LongMemEvalSampleOptions,
): LongMemEvalSampleSelection<E> {
  if (!Number.isInteger(opts.cap) || opts.cap <= 0) {
    throw new LongMemEvalSampleError(
      `LongMemEval sample cap must be a positive integer, got ${opts.cap}`,
    );
  }
  // The seed is normalized in exactly one place - here, before the
  // digest: it is trimmed, so the CLI (which passes the operator's
  // value through untransformed) and the API path hash the same value
  // for the same input. The raw value is echoed in the error so an
  // operator sees what they actually typed.
  const seed = opts.seed.trim();
  if (seed === "") {
    throw new LongMemEvalSampleError(
      `LongMemEval sample seed must be a non-empty string, got '${opts.seed}'`,
    );
  }
  const eligible = entries.filter((entry) => !isLongMemEvalAbstention(entry));
  const abstentionExcluded = entries.length - eligible.length;
  if (eligible.length === 0) {
    throw new LongMemEvalSampleError(
      `LongMemEval dataset: every one of the ${abstentionExcluded} question(s) is an abstention entry and was excluded before sampling; nothing remains to select`,
    );
  }
  // Duplicated question ids would make the selection below depend on
  // dataset file order; the converter refuses duplicates at conversion
  // time, and the sampler refuses them here, before any order-sensitive
  // step runs.
  const seen = new Set<string>();
  for (const entry of eligible) {
    if (seen.has(entry.q_id)) {
      throw new LongMemEvalSampleError(
        `LongMemEval dataset: question id '${entry.q_id}' appears twice; the sampled selection would depend on dataset file order`,
      );
    }
    seen.add(entry.q_id);
  }

  // File order is erased before the PRNG is touched: one canonical
  // order by question id, strata keyed off it.
  const sorted = [...eligible].toSorted((a, b) => (a.q_id < b.q_id ? -1 : a.q_id > b.q_id ? 1 : 0));
  const byStratum = new Map<string, E[]>();
  for (const entry of sorted) {
    const bucket = byStratum.get(entry.question_type);
    if (bucket === undefined) byStratum.set(entry.question_type, [entry]);
    else bucket.push(entry);
  }
  const stratumNames = [...byStratum.keys()].toSorted();
  const populationByStratum = stratumNames.map((name) => byStratum.get(name)!.length);
  const total = sorted.length;
  const effectiveCap = Math.min(opts.cap, total);

  // Largest-remainder apportionment: integer quotas first, then the
  // surplus seats go to the largest remainders, compared as INTEGER
  // remainders ((cap*pop) mod total). Two mathematically equal
  // fractional remainders can differ as doubles (total 6, cap 2: pop 1
  // computes 0.3333333333333333, pop 4 computes 0.33333333333333326),
  // which would silently defeat the documented tie-break. Exact integer
  // ties break to the lexicographically first stratum. With the cap
  // clamped to the population every quota is at most its stratum's
  // size, so a surplus seat never overflows a stratum.
  const base = populationByStratum.map((pop) => Math.floor((effectiveCap * pop) / total));
  const remainderOrder = stratumNames
    .map((name, i) => ({
      name,
      remainder: (effectiveCap * populationByStratum[i]!) % total,
    }))
    .toSorted((a, b) =>
      a.remainder !== b.remainder ? b.remainder - a.remainder : a.name < b.name ? -1 : 1,
    );
  const selectedByStratum = new Map<string, number>(
    stratumNames.map((name, i) => [name, base[i]!]),
  );
  let surplus = effectiveCap - base.reduce((sum, value) => sum + value, 0);
  for (const { name } of remainderOrder) {
    if (surplus === 0) break;
    selectedByStratum.set(name, selectedByStratum.get(name)! + 1);
    surplus -= 1;
  }

  // Every stratum is shuffled in name order, so the PRNG stream's draw
  // count depends only on the populations - never on the cap. The PRNG
  // is keyed by the trimmed seed (the one normalization point above).
  const random = mulberry32(prngState(seed));
  const selected: E[] = [];
  for (const name of stratumNames) {
    const pool = shuffled(byStratum.get(name)!, random);
    selected.push(...pool.slice(0, selectedByStratum.get(name)));
  }
  const canonical = selected.toSorted((a, b) => (a.q_id < b.q_id ? -1 : a.q_id > b.q_id ? 1 : 0));

  return {
    entries: canonical,
    receipt: Object.freeze({
      abstention_excluded: abstentionExcluded,
      population: total,
      selected: canonical.length,
      strata: Object.freeze(
        stratumNames.map((name, i) =>
          Object.freeze({
            question_type: name,
            population: populationByStratum[i]!,
            selected: selectedByStratum.get(name)!,
          }),
        ),
      ),
    }),
  };
}
