/**
 * Shell-native Brain profile (Workspace Insight Suite, t_323a9a83):
 * a materialized `Brain/profile.md` digest plus a `.o2bfs` marker so
 * shell wrappers can detect a Brain root without MCP.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProfileDoc,
  isProfileStale,
  O2BFS_MARKER_FILE,
  PROFILE_DOC_REL,
  writeProfileDoc,
} from "../../../src/core/brain/profile-doc.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";

let vault: string;
const NOW = new Date("2026-06-03T10:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-profile-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writePreference(vault, {
    slug: "no-shouting",
    topic: "no-shouting",
    principle: "Do not use exclamation marks in docs.",
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: ["[[sig-2026-05-01-no-shouting]]"],
    confidence_value: 0.9,
  });
  writeFileSync(join(vault, "Brain", "inbox", "sig-sample.md"), "---\ntopic: sample\n---\n");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("buildProfileDoc assembles facts, preferences, and a generated_at stamp", () => {
  const doc = buildProfileDoc(vault, { now: NOW });
  expect(doc.text).toContain("# Brain profile");
  expect(doc.text).toContain("generated_at: 2026-06-03T10:00:00.000Z");
  expect(doc.text).toContain("Do not use exclamation marks in docs.");
  expect(doc.text).toContain("confirmed preferences: 1");
  expect(doc.text).toContain("inbox signals: 1");
  expect(doc.text).toContain("Auto-generated");
});

test("writeProfileDoc materializes Brain/profile.md and the .o2bfs marker", () => {
  const result = writeProfileDoc(vault, { now: NOW });
  expect(result.path).toBe(join(vault, PROFILE_DOC_REL));
  expect(existsSync(result.path)).toBe(true);
  const marker = join(vault, O2BFS_MARKER_FILE);
  expect(existsSync(marker)).toBe(true);
  const parsed = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
  expect(parsed["vault"]).toBe(vault);
  expect(typeof parsed["generated_at"]).toBe("string");
});

test("isProfileStale: missing file is stale, fresh file is not, old file is", () => {
  expect(isProfileStale(vault, 3600, NOW)).toBe(true);
  writeProfileDoc(vault, { now: NOW });
  expect(isProfileStale(vault, 3600, NOW)).toBe(false);
  // Age the file two hours past NOW's threshold.
  const old = new Date(NOW.getTime() - 2 * 3600 * 1000);
  utimesSync(join(vault, PROFILE_DOC_REL), old, old);
  expect(isProfileStale(vault, 3600, NOW)).toBe(true);
});
