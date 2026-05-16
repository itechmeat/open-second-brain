import { test, expect } from "bun:test";
import { resolveIndexPath } from "../../../src/core/search/paths.ts";

test("default points under <vault>/.open-second-brain", () => {
  expect(resolveIndexPath("/v", null)).toBe("/v/.open-second-brain/brain.sqlite");
});

test("explicit override wins", () => {
  expect(resolveIndexPath("/v", "/tmp/custom.sqlite")).toBe("/tmp/custom.sqlite");
});

test("blank override falls back to default", () => {
  expect(resolveIndexPath("/v", "")).toBe("/v/.open-second-brain/brain.sqlite");
});
