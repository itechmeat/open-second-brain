/**
 * The view writer fold is order independent: every delivery order of the
 * same claim, request and release records names the same writer.
 */
import { describe, expect, test } from "bun:test";

import { buildRecord, type StoreRecord } from "../../../src/core/store/envelope.ts";
import { foldViewWriter } from "../../../src/core/view/writer-fold.ts";

let ms = 1_000;
function rec(device: string, kind: string, body: Record<string, unknown>): StoreRecord {
  ms += 10;
  return buildRecord({ hlc: { physical: ms, counter: 0 }, device, agent: "t", kind, body });
}

function shuffled<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const out = [...items];
  // Park-Miller: the product stays below 2^47, exact in a double, so every
  // seed gives its own order (a 32-bit LCG product overflows 2^53 and
  // rounds the low bits away).
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 48271) % 2147483647;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("foldViewWriter", () => {
  test("claims, a request, its release and a later forced move fold the same in any order", () => {
    const claimB = rec("dev-b", "view-writer-claim", { authority: "human", device: "dev-b" });
    const claimA = rec("dev-a", "view-writer-claim", { authority: "human", device: "dev-a" });
    const ask = rec("dev-c", "view-writer-request", {
      authority: "human",
      device: "dev-c",
      force: false,
    });
    const release = rec("dev-b", "view-writer-released", {
      request: ask.id,
      device: "dev-b",
      to: "dev-c",
    });
    const staleRelease = rec("dev-a", "view-writer-released", {
      request: ask.id,
      device: "dev-a",
      to: "dev-c",
    });
    const force = rec("dev-a", "view-writer-request", {
      authority: "human",
      device: "dev-a",
      force: true,
    });
    const records = [claimB, claimA, ask, release, staleRelease, force];
    for (let seed = 1; seed <= 20; seed++) {
      const state = foldViewWriter([...shuffled(records, seed), ...shuffled(records, seed + 99)]);
      expect(state.writer).toBe("dev-a");
      expect(state.via).toBe("force");
      expect(state.claims.map((c) => c.id)).toEqual([claimB.id, claimA.id]);
    }
    const beforeForce = foldViewWriter([claimB, claimA, ask, release, staleRelease]);
    expect(beforeForce).toMatchObject({ writer: "dev-c", via: "release", pending: null });
    const beforeRelease = foldViewWriter([claimB, claimA, ask]);
    expect(beforeRelease.writer).toBe("dev-b");
    expect(beforeRelease.pending?.id).toBe(ask.id);
  });
});
