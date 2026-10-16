/**
 * The pending mining-survey store (session-mining-surveys.ts), pinned at
 * its own seam where the commit flow cannot reach: a session id is caller
 * data, so an id that names an Object prototype key must store and read
 * back like any other, and a commit clears only the hashes it answered.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearMiningSurvey,
  readMiningSurvey,
  recordMiningSurvey,
  sessionMiningSurveysPath,
} from "../../../src/core/brain/session-mining-surveys.ts";

const NOW = new Date("2026-10-16T08:00:00Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mining-surveys-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("a __proto__ session id is stored as an own key and reads back", () => {
  recordMiningSurvey(vault, "__proto__", HASH_A, NOW);
  expect(readMiningSurvey(vault, "__proto__")).toEqual([HASH_A]);
  const onDisk = JSON.parse(readFileSync(sessionMiningSurveysPath(vault), "utf8")) as {
    surveys: Record<string, unknown>;
  };
  expect(Object.keys(onDisk.surveys)).toEqual(["__proto__"]);
  // A prototype member is no survey of a session that was never planned.
  expect(readMiningSurvey(vault, "constructor")).toEqual([]);
});

test("clearing removes only the answered hashes, so a racing plan stays pending", () => {
  recordMiningSurvey(vault, "sess", HASH_A, NOW);
  const answered = readMiningSurvey(vault, "sess");
  recordMiningSurvey(vault, "sess", HASH_B, NOW);
  clearMiningSurvey(vault, "sess", answered);
  expect(readMiningSurvey(vault, "sess")).toEqual([HASH_B]);
  clearMiningSurvey(vault, "sess", [HASH_B]);
  expect(readMiningSurvey(vault, "sess")).toEqual([]);
});
