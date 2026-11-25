/**
 * Readiness and order of the dream work fold (design D2, spec "Ordered
 * work stays in order and unrelated work proceeds").
 */
import { describe, expect, test } from "bun:test";

import {
  foldDreamWork,
  type DreamWorkTraits,
} from "../../../../src/core/brain/dream-queue/fold.ts";
import type { StoreRecord } from "../../../../src/core/store/envelope.ts";
import {
  answer,
  applied,
  attempt,
  claim,
  closed,
  idOf,
  item,
  lease,
  T0,
  work,
} from "./records-fixture.ts";

const LATER = T0 + 60 * 60_000;

function fold(
  records: ReadonlyArray<StoreRecord>,
  operations?: (op: string) => DreamWorkTraits | undefined,
) {
  const owner = records.filter((r) => r.kind.startsWith("dream-owner-"));
  const rest = records.filter((r) => !r.kind.startsWith("dream-owner-"));
  return foldDreamWork({
    work: work(rest),
    owner,
    now: T0 + 1000,
    ...(operations ? { operations } : {}),
  });
}

function finishAll(of: StoreRecord): StoreRecord[] {
  const l = lease("dev-a", of, 1, LATER);
  const a = answer("dev-a", of, 1);
  return [l, a, applied("dev-a", of, a)];
}

function park(of: StoreRecord): StoreRecord[] {
  const out: StoreRecord[] = [];
  for (let g = 1; g <= 5; g++) {
    out.push(lease("dev-a", of, g, LATER), attempt("dev-a", of, g, "failed", T0));
  }
  return out;
}

describe("dream work readiness", () => {
  test("an item waits for its predecessors and is ready once they are finished", () => {
    const c = claim("dev-a");
    const first = item("dev-a", { subject: "first" });
    const second = item("dev-a", { subject: "second", after: [idOf(first)] });
    const waiting = fold([c, first, second]);
    expect(waiting.items.get(idOf(second))!.ready).toBe(false);
    expect(waiting.items.get(idOf(second))!.blocked_by).toEqual([idOf(first)]);
    expect(waiting.items.get(idOf(first))!.ready).toBe(true);
    const done = fold([c, first, second, ...finishAll(first)]);
    expect(done.items.get(idOf(second))!.ready).toBe(true);
  });

  test("a later item that touches the resource of a parked head is not offered", () => {
    const c = claim("dev-a");
    const head = item("dev-a", { subject: "head", resources: ["topic:t1"] });
    const later = item("dev-a", { subject: "later", resources: ["topic:t1", "topic:t2"] });
    const state = fold([c, head, later, ...park(head)]);
    expect(state.items.get(idOf(head))!.state).toBe("parked");
    expect(state.items.get(idOf(later))!.ready).toBe(false);
    expect(state.items.get(idOf(later))!.blocked_by).toEqual([idOf(head)]);
  });

  test("unrelated work behind a parked item is offered", () => {
    const c = claim("dev-a");
    const head = item("dev-a", { subject: "head", resources: ["topic:t1"] });
    const other = item("dev-a", { subject: "other", resources: ["topic:t9"] });
    const state = fold([c, head, other, ...park(head)]);
    expect(state.items.get(idOf(other))!.ready).toBe(true);
  });

  test("a finished or closed holder frees its resource", () => {
    const c = claim("dev-a");
    const head = item("dev-a", { subject: "head", resources: ["rung:fact"] });
    const next = item("dev-a", { subject: "next", resources: ["rung:fact"] });
    expect(fold([c, head, next]).items.get(idOf(next))!.ready).toBe(false);
    expect(fold([c, head, next, ...finishAll(head)]).items.get(idOf(next))!.ready).toBe(true);
    expect(
      fold([c, head, next, closed("dev-a", head, "cancelled")]).items.get(idOf(next))!.ready,
    ).toBe(true);
  });

  test("order is by occurrence, then by the item's place in the fold", () => {
    const c = claim("dev-a");
    const late = item("dev-a", { subject: "x", occurrence: "2026-11-21/1" });
    const early = item("dev-a", { subject: "y", occurrence: "2026-11-20/1" });
    const tieA = item("dev-a", { subject: "z1", occurrence: "2026-11-20/2" });
    const tieB = item("dev-a", { subject: "z2", occurrence: "2026-11-20/2" });
    const state = fold([c, late, early, tieA, tieB]);
    expect(state.order).toEqual([idOf(early), idOf(tieA), idOf(tieB), idOf(late)]);
    // The earlier occurrence holds the resource even though its record came later.
    const r1 = item("dev-a", { subject: "r1", occurrence: "2026-11-22/1", resources: ["rung:a"] });
    const r0 = item("dev-a", { subject: "r0", occurrence: "2026-11-19/1", resources: ["rung:a"] });
    const held = fold([c, r1, r0]);
    expect(held.items.get(idOf(r0))!.ready).toBe(true);
    expect(held.items.get(idOf(r1))!.ready).toBe(false);
  });

  test("a closed predecessor under `cancel` marks the dependant; under `release` drops the edge", () => {
    const c = claim("dev-a");
    const pred = item("dev-a", { subject: "pred", operation: "op-cancel" });
    const depCancel = item("dev-a", { subject: "dc", operation: "op-cancel", after: [idOf(pred)] });
    const depRelease = item("dev-a", {
      subject: "dr",
      operation: "op-release",
      after: [idOf(pred)],
    });
    const traits = (op: string): DreamWorkTraits | undefined =>
      op === "op-release"
        ? { closedPredecessor: "release" }
        : op === "op-cancel"
          ? { closedPredecessor: "cancel" }
          : undefined;
    const state = fold(
      [c, pred, depCancel, depRelease, closed("dev-a", pred, "cancelled")],
      traits,
    );
    const cancelled = state.items.get(idOf(depCancel))!;
    expect(cancelled.ready).toBe(false);
    expect(cancelled.closed_predecessors).toEqual([idOf(pred)]);
    const released = state.items.get(idOf(depRelease))!;
    expect(released.ready).toBe(true);
    expect(released.closed_predecessors).toEqual([]);
  });

  test("an operation this build does not know is waiting and never ready", () => {
    const c = claim("dev-a");
    const it = item("dev-a", { operation: "from-a-newer-release" });
    const state = fold([c, it], () => undefined);
    const folded = state.items.get(idOf(it))!;
    expect(folded.state).toBe("waiting");
    expect(folded.ready).toBe(false);
    expect(folded.unknown_operation).toBe(true);
  });

  test("a dependant that named a superseded id follows to its successor", () => {
    const c = claim("dev-a");
    const old = item("dev-a", { subject: "s", input: "v1" });
    const successor = item("dev-a", { subject: "s", input: "v2" });
    const dep = item("dev-a", { subject: "dep", after: [idOf(old)] });
    const superseded = closed("dev-a", old, "superseded", idOf(successor));
    const before = fold([c, old, successor, dep, superseded]);
    expect(before.items.get(idOf(dep))!.blocked_by).toEqual([idOf(successor)]);
    expect(before.items.get(idOf(dep))!.closed_predecessors).toEqual([]);
    const after = fold([c, old, successor, dep, superseded, ...finishAll(successor)]);
    expect(after.items.get(idOf(dep))!.ready).toBe(true);
  });

  test("combined predecessor and resource waits stay acyclic", () => {
    const c = claim("dev-a", T0 + 1);
    const cc = item("dev-a", { subject: "c", occurrence: "03", resources: ["y"] }, T0 + 2);
    const b = item("dev-a", { subject: "b", occurrence: "02", resources: ["x", "y"] }, T0 + 3);
    const a = item(
      "dev-a",
      { subject: "a", occurrence: "01", after: [idOf(cc)], resources: ["x"] },
      T0 + 4,
    );
    const state = fold([c, cc, b, a]);
    expect(state.order.some((id) => state.items.get(id)!.ready)).toBe(true);
  });

  test("seeded acyclic queues always have a ready item and drain", () => {
    for (let seed = 1; seed <= 80; seed++) {
      let randomState = seed;
      const random = (limit: number) => {
        randomState = (randomState * 48271) % 2147483647;
        return randomState % limit;
      };
      const records: StoreRecord[] = [claim("dev-a", T0 + 1)];
      const effective: StoreRecord[] = [];
      const count = 3 + random(6);
      for (let i = 0; i < count; i++) {
        const after = Array.from({ length: i }, (_, predecessor) => predecessor)
          .filter(() => random(4) === 0)
          .map((predecessor) => idOf(effective[predecessor]!));
        const resources = ["x", "y", "z"].filter(() => random(2) === 0);
        const spec = {
          subject: `seed-${seed}-item-${i}`,
          occurrence: String(random(4)).padStart(2, "0"),
          after,
          resources,
        };
        const original = item("dev-a", spec, T0 + 10 + i);
        records.push(original);
        if (random(4) === 0) {
          const successor = item(
            "dev-a",
            {
              ...spec,
              input: `successor-${seed}-${i}`,
            },
            T0 + 100 + i,
          );
          records.push(
            successor,
            closed("dev-a", original, "superseded", idOf(successor), T0 + 200 + i),
          );
          effective.push(successor);
        } else {
          effective.push(original);
        }
      }
      let state = fold(records);
      for (let step = 0; step < effective.length; step++) {
        const open = effective.filter((it) => state.items.get(idOf(it))!.state !== "closed");
        if (open.length === 0) break;
        const ready = open.filter((it) => state.items.get(idOf(it))!.ready);
        expect(ready.length > 0, `seed ${seed}, step ${step}`).toBe(true);
        records.push(...finishAll(ready[0]!));
        state = fold(records);
      }
      expect(
        effective.every((it) => state.items.get(idOf(it))!.state === "finished"),
        `seed ${seed}`,
      ).toBe(true);
    }
  });
});

describe("a large queue", () => {
  test("is ordered in about linear time: 60,000 waiting items sharing resources", () => {
    const c = claim("dev-a");
    const items: StoreRecord[] = [];
    for (let i = 0; i < 60_000; i++) {
      items.push(
        item("dev-a", {
          subject: `s${i}`,
          occurrence: `2026-11-20/${String(i).padStart(6, "0")}`,
          resources: [`topic:t${i % 50}`],
          ...(i > 0 && i % 7 === 0 ? { after: [idOf(items[i - 1]!)] } : {}),
        }),
      );
    }
    const started = performance.now();
    const state = fold([c, ...items]);
    const ms = performance.now() - started;
    // The first item of each resource holds it; the rest wait behind it.
    expect(state.items.get(idOf(items[0]!))!.ready).toBe(true);
    expect(state.items.get(idOf(items[50]!))!.blocked_by).toEqual([idOf(items[0]!)]);
    expect(state.items.get(idOf(items[7]!))!.blocked_by).toEqual([idOf(items[6]!)]);
    // Ordering by a scan from the head for every placed item took about 29 s here.
    expect(ms).toBeLessThan(4_000);
  }, 120_000);
});
