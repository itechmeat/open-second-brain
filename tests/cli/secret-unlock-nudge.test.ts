/**
 * The unlock flow's custody nudge (PR #244 review L7).
 *
 * From the first `unlock` on, the passphrase is the only key to every
 * stored value and a lost one is unrecoverable - and the one act that
 * keeps a restorable copy is `o2b brain secret export`, which must run
 * while the operator still holds the values. The unlock flow now says
 * so, every time it succeeds, on the same stream its warnings use, so
 * the operator meets the nudge at the exact moment the wrap begins.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeCredential } from "../helpers/fake-credentials.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
const PASSPHRASE = fakeCredential("nudge", "-pass-", "73");
/** Placeholder seeded values, assembled so no line carries a key-shaped literal. */
const SEEDED_VALUE = fakeCredential("sk-", "nudge-fixture-2468");
const PLAIN_VALUE = fakeCredential("sk-", "nudge-plain-1357");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-secret-nudge-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function seedSecret(): Promise<void> {
  const set = await runCli(["brain", "secret", "set", "api-key", "--vault", vault], {
    stdin: `${SEEDED_VALUE}\n`,
  });
  expect(set.returncode).toBe(0);
}

describe("the unlock nudge", () => {
  test("a first unlock prints the export-before-wrap nudge", async () => {
    await seedSecret();
    const unlock = await runCli(["brain", "secret", "unlock", "--vault", vault], {
      stdin: `${PASSPHRASE}\n`,
    });
    expect(unlock.returncode).toBe(0);
    expect(unlock.stdout).toContain("unlocked");
    expect(unlock.stderr).toContain("unrecoverable");
    expect(unlock.stderr).toContain("o2b brain secret export");
  }, 20000);

  test("a re-unlock prints the nudge too", async () => {
    await seedSecret();
    const first = await runCli(["brain", "secret", "unlock", "--vault", vault], {
      stdin: `${PASSPHRASE}\n`,
    });
    expect(first.returncode).toBe(0);
    const again = await runCli(["brain", "secret", "unlock", "--vault", vault], {
      stdin: `${PASSPHRASE}\n`,
    });
    expect(again.returncode).toBe(0);
    expect(again.stderr).toContain("o2b brain secret export");
  }, 20000);

  test("the other custody ops are unchanged: set prints no nudge", async () => {
    const set = await runCli(["brain", "secret", "set", "plain", "--vault", vault], {
      stdin: `${PLAIN_VALUE}\n`,
    });
    expect(set.returncode).toBe(0);
    expect(set.stderr).not.toContain("o2b brain secret export");
  }, 20000);
});
