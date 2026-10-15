/**
 * A stored comma-separated scope survives the dream refresh (issue #253).
 *
 * `parsePreference` has always read `scope: alpha,beta` back verbatim,
 * and records written before the v1.78.0 tag hardening can carry it. The
 * refresh writer re-composes the record's tags, and composed the whole
 * value as ONE `brain/scope/...` tag, so the shared tag rule refused the
 * comma and the whole dream pass aborted on a record the reader accepts.
 *
 * The contract pinned here: a comma-separated scope is a list - one
 * `brain/scope/<segment>` tag per segment, the `scope` field verbatim -
 * and a stored segment that still fails the rule (a legacy value such as
 * `front end`, written before v1.78.0) is slugified rather than aborting
 * the pass, for a stored preference and for stored signals alike.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { parsePreference, writePreference } from "../../../src/core/brain/preference.ts";
import { parseSignal, writeSignal } from "../../../src/core/brain/signal.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-csv-scope-"));
  const configPath = join(vault, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: csv-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** A native preference whose stored scope (and scope tag) is then hand-set. */
function storedPreference(scope: string, scopeTag: string): string {
  const { path } = writePreference(vault, {
    slug: "example-rule",
    topic: "example-rule",
    principle: "Use concise summaries.",
    created_at: "2026-10-01T10:00:00Z",
    unconfirmed_until: "2026-10-15T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: [],
    scope: "alpha",
  });
  writeFileSync(
    path,
    readFileSync(path, "utf8")
      .replace("scope: alpha", `scope: ${scope}`)
      .replace("brain/scope/alpha", scopeTag),
  );
  // Guard against a writer format change turning the edit into a no-op.
  const edited = readFileSync(path, "utf8");
  expect(edited).toContain(`scope: ${scope}`);
  expect(edited).toContain(scopeTag);
  return path;
}

function refresh(): void {
  dream(vault, { now: new Date("2026-10-02T12:00:00Z"), agentName: "csv-agent" });
}

test.each([
  ["a valid original scope tag", "brain/scope/alpha"],
  ["a legacy comma-bearing scope tag", '"brain/scope/alpha,beta"'],
])("dream refreshes a comma-separated scope with %s", (_label, scopeTag) => {
  const path = storedPreference("alpha, beta,alpha", scopeTag);

  refresh();

  const raw = readFileSync(path, "utf8");
  expect(raw).toContain(
    "tags: [brain, brain/preference, brain/topic/example-rule, brain/scope/alpha, brain/scope/beta]",
  );
  expect(parsePreference(path).scope).toBe("alpha, beta,alpha");
});

test("a stored scope segment that fails the tag rule is slugified, not refused", () => {
  const path = storedPreference("alpha,two words", "brain/scope/alpha");

  refresh();

  const raw = readFileSync(path, "utf8");
  expect(raw).toContain(
    "tags: [brain, brain/preference, brain/topic/example-rule, brain/scope/alpha, brain/scope/two-words]",
  );
  expect(parsePreference(path).scope).toBe("alpha,two words");
});

test("stored signals with a legacy scope promote into a preference", () => {
  // Three same-sign signals on one topic is the promotion threshold; each
  // is written with a valid scope and then hand-set to the legacy value.
  for (const slug of ["a", "b", "c"]) {
    const { path } = writeSignal(vault, {
      topic: "tabs-rule",
      signal: "positive",
      agent: "csv-agent",
      principle: "Indent source with tabs, not spaces",
      created_at: "2026-10-01T09:00:00Z",
      date: "2026-10-01",
      slug,
      scope: "frontend",
    });
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replace("scope: frontend", "scope: front end")
        .replace("brain/scope/frontend", '"brain/scope/front end"'),
    );
    expect(parseSignal(path).scope).toBe("front end");
  }

  refresh();

  const prefPath = join(vault, "Brain", "preferences", "pref-tabs-rule.md");
  expect(parsePreference(prefPath).scope).toBe("front end");
  expect(readFileSync(prefPath, "utf8")).toContain("brain/scope/front-end");
});
