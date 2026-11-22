/**
 * The dream work fold (design D1, spec "Work that needs a model is a
 * durable item", "One live lease per item", "Accepted is not finished"):
 * hand-built records fold to one state per item, the same in any order.
 */
import { describe, expect, test } from "bun:test";

import { foldDreamWork } from "../../../../src/core/brain/dream-queue/fold.ts";
import { dreamWorkReceipt } from "../../../../src/core/brain/dream-queue/records.ts";
import { DREAM_WORK_RECORD_KINDS } from "../../../../src/core/brain/dream-queue/constants.ts";
import { shippedFormatDoc } from "../../../../src/core/store/format-doc.ts";
import {
  answer,
  applied,
  attempt,
  claim,
  closed,
  forceClaim,
  idOf,
  item,
  lease,
  nextAt,
  rec,
  retry,
  shuffled,
  T0,
  work,
} from "./records-fixture.ts";

const LATER = T0 + 60 * 60_000;

function fold(records: Parameters<typeof work>[0], now = T0 + 1000) {
  const owner = records.filter((r) => r.kind.startsWith("dream-owner-"));
  const rest = records.filter((r) => !r.kind.startsWith("dream-owner-"));
  return foldDreamWork({ work: work(rest), owner, now });
}

describe("foldDreamWork", () => {
  test("each of the six states", () => {
    const c = claim("dev-a");
    const waiting = item("dev-a", { subject: "w" });
    const leased = item("dev-a", { subject: "l" });
    const accepted = item("dev-a", { subject: "a" });
    const finished = item("dev-a", { subject: "f" });
    const parked = item("dev-a", { subject: "p" });
    const shut = item("dev-a", { subject: "c" });
    const records = [c, waiting, leased, accepted, finished, parked, shut];
    records.push(lease("dev-a", leased, 1, LATER));
    records.push(lease("dev-a", accepted, 1, LATER));
    records.push(answer("dev-a", accepted, 1));
    records.push(lease("dev-a", finished, 1, LATER));
    const ans = answer("dev-a", finished, 1);
    records.push(ans, applied("dev-a", finished, ans));
    for (let g = 1; g <= 5; g++) {
      records.push(lease("dev-a", parked, g, LATER), attempt("dev-a", parked, g, "failed", T0));
    }
    records.push(closed("dev-a", shut, "cancelled"));
    const state = fold(records);
    expect(state.rejected).toEqual([]);
    const s = (r: typeof waiting) => state.items.get(idOf(r))!.state;
    expect(s(waiting)).toBe("waiting");
    expect(s(leased)).toBe("leased");
    expect(s(accepted)).toBe("accepted");
    expect(s(finished)).toBe("finished");
    expect(s(parked)).toBe("parked");
    expect(s(shut)).toBe("closed");
  });

  test("a second item record with an id already folded is ignored", () => {
    const c = claim("dev-a");
    const first = item("dev-a");
    const again = item("dev-a");
    const state = fold([c, first, again]);
    expect(state.items.size).toBe(1);
    expect(state.items.get(idOf(first))!.record.id).toBe(first.id);
    expect(state.rejected).toEqual([]);
  });

  test("the newest generation wins and an answer for an older one is rejected and listed", () => {
    const c = claim("dev-a");
    const it = item("dev-a");
    const l1 = lease("dev-a", it, 1, T0 + 500);
    const l2 = lease("dev-a", it, 2, LATER);
    const late = answer("dev-a", it, 1);
    const state = fold([c, it, l1, l2, late]);
    const folded = state.items.get(idOf(it))!;
    expect(folded.state).toBe("leased");
    expect(folded.generation).toBe(2);
    expect(state.rejected.map((r) => r.id)).toEqual([late.id]);
    expect(state.rejected[0]!.kind).toBe("dream-work-answer");
  });

  test("a lease that does not raise the generation is rejected", () => {
    const c = claim("dev-a");
    const it = item("dev-a");
    const l1 = lease("dev-a", it, 1, LATER);
    const again = lease("dev-a", it, 1, LATER);
    const state = fold([c, it, l1, again]);
    expect(state.rejected.map((r) => r.id)).toEqual([again.id]);
  });

  test("one token wins a duplicated generation and the other worker's answer is rejected", () => {
    const c = claim("dev-a");
    const it = item("dev-a");
    const winner = lease("dev-a", it, 1, LATER);
    const loser = rec("dev-a", "dream-work-lease", {
      item: idOf(it),
      generation: 1,
      lease_token: "stale",
      run: "run-2",
      owner_revision: "r",
      expires_at: new Date(LATER).toISOString(),
    });
    const staleBody = {
      item: idOf(it),
      generation: 1,
      lease_token: "stale",
      input_hash: it.body["input_hash"] as string,
      value: "yes",
      agent: "claude",
      model: "m",
    };
    const staleAttempt = rec("dev-a", "dream-work-attempt", {
      item: idOf(it),
      generation: 1,
      lease_token: "stale",
      outcome: "released",
      reason: "stale release",
      retry_at: null,
    });
    const staleAnswer = rec("dev-a", "dream-work-answer", {
      ...staleBody,
      receipt: dreamWorkReceipt(staleBody),
    });
    const state = fold([c, it, winner, loser, staleAttempt, staleAnswer]);
    const folded = state.items.get(idOf(it))!;
    expect(folded.lease_token).toBe("lease-1");
    expect(folded.state).toBe("leased");
    expect(state.rejected.map((r) => r.id)).toEqual([loser.id, staleAttempt.id, staleAnswer.id]);
  });

  test("a lease past its expiry at a later now frees the item and is named", () => {
    const c = claim("dev-a");
    const it = item("dev-a");
    const l1 = lease("dev-a", it, 1, T0 + 5_000);
    const before = fold([c, it, l1], T0 + 1_000).items.get(idOf(it))!;
    expect(before.state).toBe("leased");
    const after = fold([c, it, l1], T0 + 10_000).items.get(idOf(it))!;
    expect(after.state).toBe("waiting");
    expect(after.expired).toEqual({ generation: 1, lease_token: "lease-1" });
  });

  test("five failed attempts park; a retry offers the item again with the count from zero", () => {
    const c = claim("dev-a");
    const it = item("dev-a");
    const records = [c, it];
    for (let g = 1; g <= 4; g++) {
      records.push(lease("dev-a", it, g, LATER), attempt("dev-a", it, g, "failed", T0 + g));
    }
    const four = fold(records).items.get(idOf(it))!;
    expect(four.state).toBe("waiting");
    expect(four.attempts).toBe(4);
    expect(four.retry_at).toBe(new Date(T0 + 4).toISOString());
    records.push(lease("dev-a", it, 5, LATER), attempt("dev-a", it, 5, "failed", T0 + 5));
    const five = fold(records).items.get(idOf(it))!;
    expect(five.state).toBe("parked");
    expect(five.last_reason).toBe("failed for a test");
    records.push(retry("dev-a", it));
    const again = fold(records).items.get(idOf(it))!;
    expect(again.state).toBe("waiting");
    expect(again.attempts).toBe(0);
    expect(again.retry_at).toBeNull();
  });

  test("released and refused attempts do not count toward parking", () => {
    const c = claim("dev-a");
    const it = item("dev-a");
    const records = [c, it];
    for (let g = 1; g <= 6; g++) {
      records.push(lease("dev-a", it, g, LATER), attempt("dev-a", it, g, "released"));
    }
    records.push(attempt("dev-a", it, 2, "refused"));
    const folded = fold(records).items.get(idOf(it))!;
    expect(folded.state).toBe("waiting");
    expect(folded.attempts).toBe(0);
  });

  test("a lease by a device that is not the owner at its place in the order is rejected", () => {
    const c = claim("dev-a");
    const it = item("dev-a");
    const foreign = lease("dev-b", it, 1, LATER);
    const state = fold([c, it, foreign]);
    expect(state.rejected.map((r) => r.id)).toEqual([foreign.id]);
    expect(state.items.get(idOf(it))!.state).toBe("waiting");
    // After a forced transfer the new owner's lease counts, the old owner's does not.
    const moved = forceClaim("dev-b");
    const byB = lease("dev-b", it, 1, LATER);
    const byA = lease("dev-a", it, 2, LATER);
    const after = fold([c, it, moved, byB, byA]);
    expect(after.rejected.map((r) => r.id)).toEqual([byA.id]);
    expect(after.items.get(idOf(it))!.generation).toBe(1);
  });

  test("with no owner every queue record is rejected", () => {
    const it = item("dev-a");
    const state = fold([it]);
    expect(state.items.size).toBe(0);
    expect(state.rejected.map((r) => r.id)).toEqual([it.id]);
  });

  test("an applied record without its answer is rejected", () => {
    const c = claim("dev-a");
    const it = item("dev-a");
    const l1 = lease("dev-a", it, 1, LATER);
    const ans = answer("dev-a", it, 1);
    const orphan = applied("dev-a", it, ans);
    const state = fold([c, it, l1, orphan]);
    expect(state.rejected.map((r) => r.id)).toEqual([orphan.id]);
    expect(state.items.get(idOf(it))!.state).toBe("leased");
  });

  test("an applied record after cancellation is rejected while replay stays idempotent", () => {
    const c = claim("dev-a");
    const it = item("dev-a");
    const l1 = lease("dev-a", it, 1, LATER);
    const ans = answer("dev-a", it, 1);
    const shut = closed("dev-a", it, "cancelled");
    const late = applied("dev-a", it, ans);
    const cancelled = fold([c, it, l1, ans, shut, late]);
    expect(cancelled.items.get(idOf(it))!.state).toBe("closed");
    expect(cancelled.items.get(idOf(it))!.applied).toBeNull();
    expect(cancelled.rejected.map((record) => record.id)).toEqual([late.id]);

    const done = applied("dev-a", it, ans);
    const replay = fold([c, it, l1, ans, done, applied("dev-a", it, ans)]);
    expect(replay.items.get(idOf(it))!.state).toBe("finished");
    expect(replay.rejected).toEqual([]);
  });

  test("an accepted item is never offered as finished, and a closed one stays closed", () => {
    const c = claim("dev-a");
    const it = item("dev-a");
    const l1 = lease("dev-a", it, 1, LATER);
    const ans = answer("dev-a", it, 1);
    const folded = fold([c, it, l1, ans]).items.get(idOf(it))!;
    expect(folded.state).toBe("accepted");
    expect(folded.answer?.receipt).toBe(ans.body["receipt"] as string);
    expect(folded.ready).toBe(false);
  });

  test("the same records in any input order fold to the same result", () => {
    const c = claim("dev-a");
    const a = item("dev-a", { subject: "a", resources: ["topic:1"] });
    const b = item("dev-a", { subject: "b", resources: ["topic:1"] });
    const d = item("dev-a", { subject: "d", after: [idOf(a)] });
    const records = [
      c,
      a,
      b,
      d,
      lease("dev-a", a, 1, LATER),
      attempt("dev-a", a, 1, "failed", T0),
      lease("dev-a", a, 2, LATER),
      answer("dev-a", a, 2),
      lease("dev-b", b, 1, LATER),
      closed("dev-a", b, "cancelled"),
    ];
    const reference = JSON.stringify(summarise(fold(records)));
    for (let seed = 1; seed <= 25; seed++) {
      expect(JSON.stringify(summarise(fold(shuffled(records, seed))))).toBe(reference);
    }
    nextAt();
  });

  test("a dependant sharing a resource does not hold it ahead of a superseding successor", () => {
    const c = claim("dev-a", T0 + 1);
    const predecessor = item(
      "dev-a",
      { subject: "h", occurrence: "same", resources: ["r"] },
      T0 + 2,
    );
    const dependant = item(
      "dev-a",
      { subject: "d", occurrence: "same", resources: ["r"], after: [idOf(predecessor)] },
      T0 + 3,
    );
    const unrelated = item(
      "dev-a",
      { subject: "u", occurrence: "same", resources: ["free"] },
      T0 + 3,
    );
    const successor = item(
      "dev-a",
      { subject: "h", occurrence: "same", input: "changed", resources: ["r"] },
      T0 + 4,
    );
    const state = fold([
      c,
      predecessor,
      dependant,
      unrelated,
      successor,
      closed("dev-a", predecessor, "superseded", idOf(successor)),
    ]);
    expect(state.items.get(idOf(successor))!.ready).toBe(true);
    expect(state.items.get(idOf(dependant))!.blocked_by).toContain(idOf(successor));
    expect(state.items.get(idOf(unrelated))!.ready).toBe(true);
  });

  test("resource holders follow transitive predecessors", () => {
    const c = claim("dev-a", T0 + 1);
    const h = item("dev-a", { subject: "h", occurrence: "01", resources: ["r"] }, T0 + 2);
    const m = item("dev-a", { subject: "m", occurrence: "02", after: [idOf(h)] }, T0 + 3);
    const d = item(
      "dev-a",
      { subject: "d", occurrence: "03", after: [idOf(m)], resources: ["r"] },
      T0 + 4,
    );
    const s = item("dev-a", { subject: "s", occurrence: "04", resources: ["r"] }, T0 + 5);
    const state = fold([c, h, m, d, s, closed("dev-a", h, "superseded", idOf(s))]);
    expect(state.items.get(idOf(s))!.ready).toBe(true);
    expect(state.items.get(idOf(d))!.blocked_by).toContain(idOf(m));
  });

  test.each([...DREAM_WORK_RECORD_KINDS])("FORMAT.md documents the kind %s", (kind) => {
    expect(shippedFormatDoc()).toMatch(new RegExp(`^- \`${kind}\`:`, "m"));
  });
});

function summarise(state: ReturnType<typeof foldDreamWork>) {
  return {
    order: state.order,
    items: state.order.map((id) => {
      const i = state.items.get(id)!;
      return [id, i.state, i.ready, i.generation, i.attempts, i.blocked_by];
    }),
    rejected: state.rejected,
  };
}
