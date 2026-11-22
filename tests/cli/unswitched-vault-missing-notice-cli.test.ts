/**
 * The command line and the SessionStart hook of a machine that has NOT
 * switched to the brain store, whose configured vault folder is gone (an
 * unmounted disk, a renamed folder).
 *
 * The machine is not a fresh installation, and the surfaces say so:
 *
 *  - the command line writes the notice on stderr BEFORE the verb's own
 *    error, so the operator reads "the vault is missing" before the
 *    advice to initialise a new brain - the advice stays, second;
 *  - `o2b brain doctor` reports the missing folder ahead of the
 *    "brain root absent" entry;
 *  - the hook carries the notice in its runtime notices.
 *
 * The machine with no vault configured beside it keeps today's guidance
 * word for word: a fresh installation must not look like a broken one.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  MISSING_VAULT_WORDS,
  noVaultConfigured,
  STORE_SHAPES,
  unswitchedVaultGone,
} from "../core/store/fixtures/unswitched-vault-gone.ts";
import type { StoreEnv } from "../core/store/fixtures/store-env.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS * 4);

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const HOOK = join(import.meta.dir, "../../hooks/active-inject.ts");

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function run(argv: string[], stdin?: string): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync([process.execPath, ...argv], {
    env: { ...process.env } as Record<string, string>,
    ...(stdin !== undefined ? { stdin: Buffer.from(stdin) } : {}),
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

for (const shape of STORE_SHAPES) {
  test(`the command line names the missing folder before the verb's own error (${shape.label})`, () => {
    env = unswitchedVaultGone(
      `osb-cli-gone-${shape.withStore ? "store" : "nostore"}-`,
      shape.withStore,
    );
    const res = run([
      CLI,
      "brain",
      "feedback",
      "--topic",
      "tabs",
      "--principle",
      "Prefer tabs.",
      "--signal",
      "positive",
    ]);
    // The notice leads the stderr, before the error that follows it.
    const lines = res.err.trim().split("\n");
    expect(lines[0]).toStartWith("warning: the configured vault folder ");
    for (const word of MISSING_VAULT_WORDS) expect(lines[0]!).toContain(word);
    if (shape.withStore) {
      // The write answers from the store: the notice is the only line.
      expect(res.code).toBe(0);
      expect(lines).toHaveLength(1);
    } else {
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[1]).toStartWith("error: ");
    }
    // The advice to initialise stays, second.
    const advice = res.err.indexOf("o2b store init");
    if (advice >= 0) expect(advice).toBeGreaterThan(res.err.indexOf("is missing"));
    // The folder that is gone is not recreated.
    expect(existsSync(env.vault)).toBe(false);
  });

  test(`o2b brain doctor reports the missing folder first (${shape.label})`, () => {
    env = unswitchedVaultGone(
      `osb-cli-gone-doctor-${shape.withStore ? "store" : "nostore"}-`,
      shape.withStore,
    );
    const res = run([CLI, "brain", "doctor"]);
    expect(res.code).toBe(0);
    const missing = res.out.indexOf("vault-folder-missing");
    const absent = res.out.indexOf("brain-root-absent");
    expect(missing).toBeGreaterThan(-1);
    expect(absent).toBeGreaterThan(-1);
    // The missing folder comes first, and its exit comes before the
    // `o2b brain init` advice, which stays.
    expect(missing).toBeLessThan(absent);
    expect(res.out.indexOf("next: o2b status")).toBeLessThan(
      res.out.indexOf("next: o2b brain init"),
    );
    for (const word of MISSING_VAULT_WORDS) expect(res.out).toContain(word);
  });

  test(`the SessionStart hook carries the notice in its runtime notices (${shape.label})`, () => {
    env = unswitchedVaultGone(
      `osb-hook-gone-${shape.withStore ? "store" : "nostore"}-`,
      shape.withStore,
    );
    const res = run(
      [HOOK],
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "s-1", cwd: env.parent }),
    );
    expect(res.code).toBe(0);
    const context = JSON.parse(res.out)["hookSpecificOutput"]["additionalContext"] as string;
    expect(context).toContain("Runtime notices:");
    for (const word of MISSING_VAULT_WORDS) expect(context).toContain(word);
    // It is the first notice of the session.
    const first = context.slice(context.indexOf("Runtime notices:"));
    expect(first.indexOf("is missing")).toBeLessThan(
      first.indexOf("Search index is not built yet"),
    );
    // The folder that is gone is not recreated.
    expect(existsSync(env.vault)).toBe(false);
  });
}

// ----- The machine beside it: no vault configured ---------------------------

for (const shape of STORE_SHAPES) {
  test(`a machine with no vault configured keeps today's guidance (${shape.label})`, () => {
    env = noVaultConfigured(
      `osb-cli-novault-${shape.withStore ? "store" : "nostore"}-`,
      shape.withStore,
    );
    const res = run([
      CLI,
      "brain",
      "feedback",
      "--topic",
      "tabs",
      "--principle",
      "Prefer tabs.",
      "--signal",
      "positive",
    ]);
    // No notice: there is no folder that could be missing, and the
    // guidance is today's, word for word.
    expect(res.err).not.toContain("the configured vault folder");
    if (!shape.withStore) {
      expect(res.code).toBe(1);
      expect(res.err).toContain("run `o2b store init`");
      expect(res.err.trim().split("\n")).toHaveLength(1);
    }

    const doctor = run([CLI, "brain", "doctor"]);
    expect(doctor.out).not.toContain("vault-folder-missing");
    expect(doctor.out).not.toContain("the configured vault folder");

    const hook = run(
      [HOOK],
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "s-1", cwd: env.parent }),
    );
    expect(hook.out).not.toContain("the configured vault folder");
  });
}
