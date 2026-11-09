/**
 * One retirement rule (design D11a): the digest roster, the device list and
 * the removal gate read a device as retired until it writes after its latest
 * human retirement, and they agree on every case.
 */
import { describe, expect, test } from "bun:test";

import { returnedAfterRetirement } from "../../../src/core/store/device-retirement.ts";
import { computeRoster } from "../../../src/core/store/state-digest-compare.ts";
import { authored, rec } from "./fixtures/fold-records.ts";

const NOW = Date.UTC(2026, 10, 7);
const T = NOW - 86_400_000;

describe("the retirement rule", () => {
  test("the digest roster and the returned-device rule agree", () => {
    const write = (device: string, physical: number) =>
      rec({ device, physical, kind: "note", body: { n: physical } });
    const retire = (device: string, physical: number) =>
      rec({
        device: "dev-a",
        physical,
        kind: "device-retire",
        body: authored("human", { device }),
      });
    const records = [
      write("dev-b", T), // retired after, never back
      retire("dev-b", T + 10),
      write("dev-c", T), // retired, then wrote again
      retire("dev-c", T + 10),
      write("dev-c", T + 20),
      retire("Bad Id", T + 10), // an invalid id retires nothing
    ];
    const roster = computeRoster(records, records, NOW);
    expect(roster.retired).toEqual(["dev-b"]);
    expect(roster.devices.map((d) => d.device)).toContain("dev-c");
    expect(returnedAfterRetirement(records).map((r) => r.device)).toEqual(["dev-c"]);
  });
});
