/**
 * ULID record ids for the brain store (design D3).
 *
 * A ULID is 26 Crockford base32 characters: 48 bits of millisecond time
 * followed by 80 random bits, so ids sort by creation time as text and
 * never need coordination between machines. Ids issued by one process
 * within the same millisecond are made strictly increasing by adding one
 * to the previous random part (the monotonic variant of the spec). Record
 * order never rests on ids alone: they only break ties after the clock
 * and the device id.
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MAX_TIME = 2 ** 48 - 1;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = "";
  let rest = time;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET[rest % 32]! + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(RANDOM_CHARS);
  return Array.from(bytes, (byte) => byte % 32);
}

/** Add one to a base32 digit array; `false` when it overflowed. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i]! < 31) {
      digits[i]! += 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/** A new ULID for time `nowMs` (default: the wall clock). */
export function newUlid(nowMs: number = Date.now()): string {
  const time = Math.min(MAX_TIME, Math.max(0, Math.floor(nowMs)));
  if (time === lastTime) {
    // Same millisecond: step the random part, so ids stay unique and
    // ordered within this process. An overflow (2^80 ids in one
    // millisecond) moves to the next millisecond.
    if (!increment(lastRandom)) {
      lastTime += 1;
      lastRandom = freshRandom();
    }
  } else {
    // A new (or an earlier) millisecond starts afresh; 80 random bits keep
    // ids unique when the clock steps back.
    lastTime = time;
    lastRandom = freshRandom();
  }
  return encodeTime(lastTime) + lastRandom.map((d) => ALPHABET[d]).join("");
}

/** Whether `value` is a canonical (uppercase) ULID. */
export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}

/** The millisecond time encoded in a ULID. */
export function ulidTime(id: string): number {
  let time = 0;
  for (const ch of id.slice(0, TIME_CHARS)) time = time * 32 + ALPHABET.indexOf(ch);
  return time;
}
