/**
 * The estimate of a full index build, held against the build it was
 * measured on and the one that checked it: a real-size brain store of
 * 399,632 records (201,320 documents, 652 of them notes) rebuilt into
 * 517,427,200 bytes in 73 to 84 s (the background heal after the update,
 * with searches running beside it).
 */

import { expect, test } from "bun:test";

import {
  describeIndexEstimate,
  estimateIndexBuild,
  formatEstimateBytes,
  formatEstimateSeconds,
} from "../../../src/core/search/index-estimate.ts";

test("the estimate lands within a few percent of a measured real-size build", () => {
  const estimate = estimateIndexBuild({
    storeRecords: 399_632,
    documents: 201_320,
    noteFiles: 652,
  });
  expect(Math.abs(estimate.bytes - 517_427_200) / 517_427_200).toBeLessThan(0.02);
  expect(estimate.seconds).toBeGreaterThan(60);
  expect(estimate.seconds).toBeLessThan(90);
});

test("an empty index estimates nothing, and negative counts are not trusted", () => {
  expect(estimateIndexBuild({ storeRecords: 0, documents: 0, noteFiles: 0 })).toEqual({
    bytes: 0,
    seconds: 0,
  });
  expect(estimateIndexBuild({ storeRecords: -5, documents: -1, noteFiles: null }).bytes).toBe(0);
});

test("sizes and times read as a person reads them", () => {
  expect(formatEstimateBytes(517_427_200)).toBe("517 MB");
  expect(formatEstimateBytes(1_083_002_880)).toBe("1.08 GB");
  expect(formatEstimateBytes(3_200_000)).toBe("3.2 MB");
  expect(formatEstimateBytes(800)).toBe("1 KB");
  expect(formatEstimateSeconds(0.2)).toBe("under a second");
  expect(formatEstimateSeconds(8.4)).toBe("about 8 s");
  expect(formatEstimateSeconds(73)).toBe("about 1 min 13 s");
  expect(formatEstimateSeconds(120)).toBe("about 2 min");
});

test("the line says what the estimate rests on, and when the notes are not counted", () => {
  expect(describeIndexEstimate({ storeRecords: 10, documents: 4, noteFiles: 2 })).toBe(
    "about 11 KB, built in under a second (10 brain store record(s), 4 document(s), 2 note file(s))",
  );
  expect(describeIndexEstimate({ storeRecords: 10, documents: 4, noteFiles: null })).toContain(
    "the vault's notes not counted and coming on top",
  );
});
