/**
 * CLI surface for the Brain Portability & Interop suite (Unit A):
 * `o2b brain bank-export | bank-import`. Locks argument shape, --json,
 * --mode validation, and exit codes; the core has its own unit coverage.
 *
 * Since unit E2 the import also restores preferences, so this file locks
 * the two operator-visible consequences: a carried rule reaches the
 * vault, and a rule that could not be restored makes the run exit
 * non-zero instead of reporting a clean import of material it dropped.
 * The per-field round-trip is asserted in the core suite, not here.
 *
 * The redacted-identity refusal is locked here only at the operator
 * surface - the reason reaches stdout and the run exits non-zero. Which
 * fields count as an identity, and the payload placeholder that must still
 * restore, are asserted in
 * `tests/core/brain/portability/redacted-identity-restore.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { REDACTION_PLACEHOLDER } from "../../src/core/redactor.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-bank-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * One complete preference row as `bank-export` emits it. Written by hand
 * so the CLI's JSON boundary is exercised the way an operator's bundle
 * file reaches it.
 */
function preferenceRow(): Record<string, unknown> {
  return {
    id: "pref-carried-rule",
    topic: "writing",
    scope: null,
    status: "confirmed",
    principle: "name the artifact the rule governs",
    applied_count: 2,
    violated_count: 0,
    confidence: "medium",
    confidence_value: 0.5,
    pinned: false,
    last_evidence_at: "2026-05-03T00:00:00Z",
    created_at: "2026-05-01T00:00:00Z",
    confirmed_at: "2026-05-02T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    revision: 2,
    aliases: null,
    tags: ["brain", "brain/preference", "brain/topic/writing"],
    evidenced_by: [],
    body: "",
  };
}

async function bootstrap(): Promise<void> {
  expect(
    (
      await runCli(["init", "--vault", vault, "--name", "T"], {
        env: { OPEN_SECOND_BRAIN_CONFIG: config },
      })
    ).returncode,
  ).toBe(0);
  expect(
    (
      await runCli(["brain", "init", "--vault", vault], {
        env: { OPEN_SECOND_BRAIN_CONFIG: config },
      })
    ).returncode,
  ).toBe(0);
}

describe("o2b brain bank-export / bank-import", () => {
  test("bank-export emits a schema-versioned bundle with content sections", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Note.md"), "---\ntitle: Note\n---\nlinks to [[Other]].\n");
    const exp = await runCli(["brain", "bank-export"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(exp.returncode).toBe(0);
    const bundle = JSON.parse(exp.stdout);
    expect(bundle.schema).toBe("1");
    expect(Array.isArray(bundle.graph.nodes)).toBe(true);
    expect(Array.isArray(bundle.pages)).toBe(true);
    expect(Array.isArray(bundle.preferences)).toBe(true);
  });

  test("bank-export then bank-import round-trips the page graph", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Note.md"), "---\ntitle: Note\n---\nlinks to [[Other]].\n");
    const exp = await runCli(["brain", "bank-export"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(exp.returncode).toBe(0);
    const bundleFile = join(tmp, "bank.json");
    writeFileSync(bundleFile, exp.stdout);
    const imp = await runCli(["brain", "bank-import", bundleFile, "--mode", "skip", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(imp.returncode).toBe(0);
    const result = JSON.parse(imp.stdout);
    // The page already exists in the same vault -> skipped (idempotent).
    expect(result.graph.skipped).toContain("Note.md");
    expect(typeof result.pagesCarried).toBe("number");
  });

  test("bank-import restores a carried preference into the vault", async () => {
    await bootstrap();
    const bundleFile = join(tmp, "with-prefs.json");
    writeFileSync(
      bundleFile,
      JSON.stringify({ schema: "1", graph: { nodes: [] }, preferences: [preferenceRow()] }),
    );
    const imp = await runCli(["brain", "bank-import", bundleFile, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(imp.returncode).toBe(0);
    const result = JSON.parse(imp.stdout);
    expect(result.preferences.restored).toContain("pref-carried-rule");
    expect(result.preferences.failed).toEqual([]);
    expect(existsSync(join(vault, "Brain", "preferences", "pref-carried-rule.md"))).toBe(true);
  });

  test("bank-import restores a legacy row whose trial window is inert, and says so", async () => {
    // The shape every bundle taken before the trial window entered the
    // export projection has. The rule is confirmed, so the window is inert
    // and derivable from the row's own `confirmed_at`: refusing it would
    // exit 1 on a backup that is the only copy left of these rules.
    await bootstrap();
    const row = preferenceRow();
    delete row["unconfirmed_until"];
    delete row["revision"];
    const bundleFile = join(tmp, "legacy-prefs.json");
    writeFileSync(
      bundleFile,
      JSON.stringify({ schema: "1", graph: { nodes: [] }, preferences: [row] }),
    );
    const imp = await runCli(["brain", "bank-import", bundleFile], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(imp.returncode).toBe(0);
    expect(imp.stdout).toContain("unconfirmed_until derived from confirmed_at");
    expect(existsSync(join(vault, "Brain", "preferences", "pref-carried-rule.md"))).toBe(true);
  });

  test("bank-import exits non-zero when a carried preference cannot be restored", async () => {
    // The one row whose deadline is live: an `unconfirmed` rule. Its
    // `unconfirmed_until` is not a function of anything the row carries, so
    // it is refused rather than invented - and a refused rule is a partial
    // import, which the exit code has to say.
    await bootstrap();
    const row = preferenceRow();
    delete row["unconfirmed_until"];
    row["status"] = "unconfirmed";
    row["confirmed_at"] = null;
    const bundleFile = join(tmp, "legacy-trial-prefs.json");
    writeFileSync(
      bundleFile,
      JSON.stringify({ schema: "1", graph: { nodes: [] }, preferences: [row] }),
    );
    const imp = await runCli(["brain", "bank-import", bundleFile], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(imp.returncode).not.toBe(0);
    expect(imp.stdout).toContain("missing_trial_window");
    expect(existsSync(join(vault, "Brain", "preferences", "pref-carried-rule.md"))).toBe(false);
  });

  test("bank-import names a row whose identity was redacted and exits non-zero", async () => {
    // The bundle an earlier build of this branch could produce: the
    // redactor ran over the export and replaced the topic - an identity -
    // with its placeholder. Restoring it would write a rule keyed on a
    // constant that every other redacted row shares.
    await bootstrap();
    const bundleFile = join(tmp, "redacted-prefs.json");
    writeFileSync(
      bundleFile,
      JSON.stringify({
        schema: "1",
        graph: { nodes: [] },
        preferences: [
          { ...preferenceRow(), topic: REDACTION_PLACEHOLDER },
          { ...preferenceRow(), id: "pref-intact-rule" },
        ],
      }),
    );
    const imp = await runCli(["brain", "bank-import", bundleFile], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(imp.returncode).not.toBe(0);
    expect(imp.stdout).toContain("redacted_identifier");
    expect(existsSync(join(vault, "Brain", "preferences", "pref-carried-rule.md"))).toBe(false);
    // The rest of the bundle is not held hostage by the refused row.
    expect(existsSync(join(vault, "Brain", "preferences", "pref-intact-rule.md"))).toBe(true);
  });

  test("bank-import rejects an unknown --mode", async () => {
    await bootstrap();
    writeFileSync(join(tmp, "b.json"), '{"schema":"1","graph":{"nodes":[]}}');
    const r = await runCli(["brain", "bank-import", join(tmp, "b.json"), "--mode", "bogus"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).not.toBe(0);
  });

  test("bank-import fails loudly on an unsupported schema", async () => {
    await bootstrap();
    writeFileSync(join(tmp, "old.json"), '{"schema":"999","graph":{"nodes":[]}}');
    const r = await runCli(["brain", "bank-import", join(tmp, "old.json")], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("schema");
  });
});
