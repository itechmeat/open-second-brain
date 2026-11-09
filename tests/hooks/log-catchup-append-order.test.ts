/**
 * The catch-up line of a store log event is its index among its device's
 * events of the day in append order (the record clock), so an event
 * recorded later with an earlier timestamp takes the next index and the
 * marks already stored keep naming the same events.
 */
import { expect, test } from "bun:test";

import { appendOrderLines } from "../../hooks/lib/log-cursor-state.ts";

test("lines follow each device's record clock, not the merge order", () => {
  // Merge order (by timestamp): a's late-recorded event sorts first.
  const devices = ["dev-a", "dev-b", "dev-a", "dev-a"];
  const hlcs = ["300.0", "100.0", "100.0", "200.0"];
  expect(appendOrderLines(devices, hlcs)).toEqual([2, 0, 0, 1]);
});

test("an entry with no readable clock keeps its merge position among its device's", () => {
  expect(appendOrderLines(["dev-a", "dev-a"], ["", ""])).toEqual([0, 1]);
});

test("an entry with no readable clock sorts after its device's clocked ones, in one total order", () => {
  // Index alone would put the unclocked entry between two clocked ones
  // whose clocks run the other way: no consistent order.
  expect(appendOrderLines(["dev-a", "dev-a", "dev-a"], ["300.0", "", "100.0"])).toEqual([1, 2, 0]);
});
