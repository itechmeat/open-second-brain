/**
 * `o2b brain doctor` names the offending file once per finding
 * (signals-that-survive, task 2).
 *
 * The human renderer appends ` (<path>)` from the finding's structured
 * `path` field. While the parsers also embedded the path in their
 * message, every parse-error line read:
 *
 *   [ERROR] preference-missing-field: preference missing field: \
 *     created_at (/vault/Brain/preferences/pref-x.md) \
 *     (/vault/Brain/preferences/pref-x.md)
 *
 * This pins the renderer as unchanged and the line as carrying the path
 * exactly once, on both the human and the machine surface.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-parse-path-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath: config });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A preference file whose frontmatter omits `created_at`. */
function seedMissingField(): string {
  const path = join(vault, "Brain", "preferences", "pref-no-created-at.md");
  writeFileSync(
    path,
    [
      "---",
      "kind: brain-preference",
      "id: pref-no-created-at",
      "_confirmed_at: null",
      "unconfirmed_until: 2026-05-28T10:42:00Z",
      "tags: [brain, brain/preference]",
      "topic: broken",
      "_status: unconfirmed",
      "principle: A rule with no birthday",
      "_evidenced_by: []",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("brain doctor - the path appears once per parse-error line", () => {
  test("the human surface names the file exactly once", async () => {
    const path = seedMissingField();
    const r = await runCli(["brain", "doctor", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    const line = r.stdout
      .split("\n")
      .find((l) => l.startsWith("[ERROR] preference-missing-field:"));
    expect(line).toBeDefined();
    expect(occurrences(line!, path)).toBe(1);
    expect(line).toBe(
      `[ERROR] preference-missing-field: preference missing field: created_at (${path})`,
    );
  });

  test("the machine surface carries the path only in its own field", async () => {
    const path = seedMissingField();
    const r = await runCli(["brain", "doctor", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const payload = JSON.parse(r.stdout) as {
      errors: ReadonlyArray<{ code: string; path?: string; message: string }>;
    };
    const issue = payload.errors.find((e) => e.code === "preference-missing-field");
    expect(issue).toBeDefined();
    expect(issue!.path).toBe(path);
    expect(issue!.message).toBe("preference missing field: created_at");
  });
});
