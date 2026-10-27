/**
 * CLI tests for `o2b brain bank-export`'s stderr notice surface.
 *
 * The bundle body's content-class behaviour (the default split, the
 * `--include-prompt-derived` override, the dropped structured references)
 * is pinned in `tests/core/content-class-egress.test.ts`, and the
 * preference denial's default-run notice in
 * `tests/cli/export-redaction.test.ts`. This file pins the notices of a
 * run where BOTH policies fire at once - the one combination each of
 * those suites leaves unexercised: the preference denial is UNCONDITIONAL
 * (no flag carries a reserved rule), so its notice must ride the
 * override run too, not only the default arm's.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import {
  CONTENT_CLASS,
  CONTENT_CLASS_FIELD,
} from "../../src/core/brain/provenance/content-class.ts";
import { EGRESS_CONTENT_CLASS_INCLUDE_NOTICE } from "../../src/core/egress/guard.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-bank-export-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = (): { env: Record<string, string> } => ({
  env: { OPEN_SECOND_BRAIN_CONFIG: config },
});

async function bootstrap(): Promise<void> {
  expect((await runCli(["init", "--vault", vault, "--name", "T"], ENV())).returncode).toBe(0);
  expect((await runCli(["brain", "init", "--vault", vault], ENV())).returncode).toBe(0);
  writeFileSync(
    join(vault, "Operator Page.md"),
    "---\ntitle: Operator Page\n---\n\nWritten by the operator.\n",
    "utf8",
  );
  writeFileSync(
    join(vault, "Agent Page.md"),
    `---\ntitle: Agent Page\n${CONTENT_CLASS_FIELD}: ${CONTENT_CLASS.promptDerived}\n---\n\nSynthesised from a prompt.\n`,
    "utf8",
  );
}

async function seedPreference(slug: string, principle: string): Promise<void> {
  const r = await runCli(
    [
      "brain",
      "feedback",
      "--vault",
      vault,
      "--topic",
      slug,
      "--signal",
      "positive",
      "--principle",
      principle,
      "--scope",
      "writing",
      "--force-confirmed",
      "--agent",
      "claude",
    ],
    ENV(),
  );
  expect(r.returncode).toBe(0);
}

/** Hand-add an informal privacy marker, the way an operator does. */
function stampPrefMarker(slug: string, line: string): void {
  const abs = join(vault, "Brain", "preferences", `pref-${slug}.md`);
  writeFileSync(abs, readFileSync(abs, "utf8").replace(/^---\n/, `---\n${line}\n`));
}

describe("brain bank-export notices", () => {
  test("the preference denial is named beside the --include-prompt-derived notice", async () => {
    // The reserved preference is withheld before the guard runs and no
    // flag carries a reserved rule, so the override changes nothing about
    // the denial - the notice that names the reserved row must ride the
    // override run exactly as it rides the default run, or the operator
    // who carries the marked pages back in drops the reserved rule
    // silently.
    await bootstrap();
    await seedPreference("reserved", "principle reserved");
    stampPrefMarker("reserved", "access: private");

    const r = await runCli(
      ["brain", "bank-export", "--vault", vault, "--include-prompt-derived"],
      ENV(),
    );
    expect(r.returncode).toBe(0);
    expect(r.stderr).toContain(EGRESS_CONTENT_CLASS_INCLUDE_NOTICE);
    expect(r.stderr).toContain("pref-reserved");
    expect(r.stderr).toContain("left out");
    // stderr only: the bundle names the omission as data, not prose.
    expect(r.stdout).not.toContain("left out");
    const bundle = JSON.parse(r.stdout) as {
      preferences: ReadonlyArray<{ id: string }>;
      preferences_omitted?: ReadonlyArray<{
        id: string;
        reason: string;
        denied_by: string;
      }>;
    };
    expect(bundle.preferences.map((p) => p.id)).toEqual([]);
    expect(bundle.preferences_omitted).toEqual([
      { id: "pref-reserved", reason: "visibility", denied_by: "access" },
    ]);
  });

  test("the default run still leaves the reserved row out of the preferences section", async () => {
    await bootstrap();
    await seedPreference("open", "principle open");
    await seedPreference("reserved", "principle reserved");
    stampPrefMarker("reserved", "access: private");

    const r = await runCli(["brain", "bank-export", "--vault", vault], ENV());
    expect(r.returncode).toBe(0);
    const bundle = JSON.parse(r.stdout) as {
      preferences: ReadonlyArray<{ id: string }>;
      preferences_omitted?: ReadonlyArray<{ id: string }>;
    };
    expect(bundle.preferences.map((p) => p.id)).toEqual(["pref-open"]);
    expect(bundle.preferences_omitted?.map((d) => d.id)).toEqual(["pref-reserved"]);
    expect(r.stderr).toContain("pref-reserved");
    expect(r.stderr).toContain("left out");
  });

  test("--include-reserved carries the reserved row into the backup and names the inclusion", async () => {
    // The bundle is documented as the one-file backup: the operator's own
    // copy of their own vault. A reservation is a statement about SHARED
    // readers, not about the operator, so the flag carries the reserved
    // rows back in and the run says so - the mirror of
    // --include-prompt-derived - and the denial notice is silent because
    // nothing was denied.
    await bootstrap();
    await seedPreference("open", "principle open");
    await seedPreference("reserved", "principle reserved");
    stampPrefMarker("reserved", "access: private");

    const r = await runCli(["brain", "bank-export", "--vault", vault, "--include-reserved"], ENV());
    expect(r.returncode).toBe(0);
    const bundle = JSON.parse(r.stdout) as {
      preferences: ReadonlyArray<{ id: string; principle: string }>;
      preferences_omitted?: ReadonlyArray<{ id: string }>;
    };
    expect(bundle.preferences.map((p) => p.id)).toEqual(["pref-open", "pref-reserved"]);
    expect(bundle.preferences[1]!.principle).toBe("principle reserved");
    // Nothing was withheld, so no omission report rides the bundle.
    expect("preferences_omitted" in bundle).toBe(false);
    // The run names the inclusion and the flag that caused it.
    expect(r.stderr).toContain("--include-reserved");
    expect(r.stderr).toContain("pref-reserved");
    expect(r.stderr).toContain("INCLUDED");
    // The preference denial is silent - nothing was withheld. The class
    // policy's own omission notice may still fire (the bootstrapped
    // prompt-derived page), so the assertion names the denial's phrase.
    expect(r.stderr).not.toContain("visibility reservation");
  });
});
