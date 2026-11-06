/**
 * Test helper: verified store records built in memory, and a seeded
 * random generator so property tests are reproducible from their seed.
 */
import type { Authority } from "../../../../src/core/store/constants.ts";
import {
  buildRecord,
  type RecordBody,
  type StoreRecord,
} from "../../../../src/core/store/envelope.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** mulberry32: a small seeded generator returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rng: () => number, items: ReadonlyArray<T>): T =>
  items[Math.floor(rng() * items.length)]!;

/** Fisher-Yates shuffle into a new array. */
export function shuffled<T>(rng: () => number, items: ReadonlyArray<T>): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A valid ULID for `ms` whose random part comes from `rng`. */
export function seededUlid(rng: () => number, ms: number): string {
  let time = "";
  let rest = ms;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[rest % 32]! + time;
    rest = Math.floor(rest / 32);
  }
  let random = "";
  for (let i = 0; i < 16; i++) random += pick(rng, [...ALPHABET]);
  return time + random;
}

const fallbackRng = seededRandom(7);

export interface RecSpec {
  readonly device?: string;
  readonly physical: number;
  readonly counter?: number;
  readonly kind: string;
  readonly body: RecordBody;
  readonly agent?: string;
  readonly id?: string;
  readonly rng?: () => number;
}

/** Build one verified record. */
export function rec(spec: RecSpec): StoreRecord {
  return buildRecord({
    hlc: { physical: spec.physical, counter: spec.counter ?? 0 },
    device: spec.device ?? "dev-a",
    agent: spec.agent ?? "agent-1",
    kind: spec.kind,
    body: spec.body,
    id: spec.id ?? seededUlid(spec.rng ?? fallbackRng, spec.physical),
  });
}

/** Body of a mutable-entity record with its authority. */
export const authored = (authority: Authority, body: RecordBody): RecordBody => ({
  authority,
  ...body,
});
