/**
 * The two expiration surfaces on the CLI (unit 3c / t_5e338af1).
 *
 * `expiration_date` was writable only from inside the core: `o2b brain
 * feedback` had no flag for it, and nothing anywhere could change one
 * after the write. These are the two doors that close that gap, and this
 * file covers their own share of it - the flags, the exit codes, the
 * `--json` shapes - while `tests/core/brain/expiration-set.test.ts` owns
 * the mutation semantics.
 *
 * Claims pinned here:
 *
 *  1. `feedback --expires` stamps the signal it writes, and the
 *     force-confirmed preference beside it, with the same normalised date.
 *  2. `expire <id> --expires <date>` sets one after the fact, and
 *     `--expires none` clears it - a word, never an empty string.
 *  3. An unparseable date is refused by name on both verbs, exits 2, and
 *     writes nothing.
 *  4. An id naming no artifact is refused by name rather than reported as
 *     a successful no-op.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-expiration-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Record one signal (optionally force-confirmed) and return its ids. */
async function feedback(extra: string[]): Promise<{ signalId: string; preferenceId?: string }> {
  const res = await runCli([
    "brain",
    "feedback",
    "--topic",
    "staging-endpoint",
    "--signal",
    "positive",
    "--principle",
    "Use the staging endpoint.",
    "--vault",
    vault,
    "--json",
    ...extra,
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { signal_id: string; preference_id?: string };
  return {
    signalId: body.signal_id,
    ...(body.preference_id ? { preferenceId: body.preference_id } : {}),
  };
}

test("feedback --expires stamps the signal and the force-confirmed preference", async () => {
  const { signalId, preferenceId } = await feedback([
    "--expires",
    "2026-07-15",
    "--force-confirmed",
  ]);
  expect(readFileSync(join(vault, "Brain/inbox", `${signalId}.md`), "utf8")).toContain(
    "expiration_date: 2026-07-15",
  );
  expect(preferenceId).toBeDefined();
  expect(readFileSync(join(vault, "Brain/preferences", `${preferenceId}.md`), "utf8")).toContain(
    "expiration_date: 2026-07-15",
  );
});

test("feedback refuses an unparseable --expires by name and writes no signal", async () => {
  const res = await runCli([
    "brain",
    "feedback",
    "--topic",
    "staging-endpoint",
    "--signal",
    "positive",
    "--principle",
    "Use the staging endpoint.",
    "--expires",
    "next tuesday",
    "--vault",
    vault,
  ]);
  expect(res.returncode).not.toBe(0);
  expect(res.stderr).toContain("expiration_date");
  expect(readdirSync(join(vault, "Brain/inbox")).filter((n) => n.endsWith(".md"))).toHaveLength(0);
});

test("expire sets, changes and clears an expiration on an existing signal", async () => {
  const { signalId } = await feedback([]);

  const set = await runCli([
    "brain",
    "expire",
    signalId,
    "--expires",
    "2026-07-15",
    "--vault",
    vault,
    "--json",
  ]);
  expect(set.returncode).toBe(0);
  const setBody = JSON.parse(set.stdout) as {
    ok: boolean;
    expiration: string | null;
    previous: string | null;
    changed: boolean;
  };
  expect(setBody.ok).toBe(true);
  expect(setBody.expiration).toBe("2026-07-15");
  expect(setBody.previous).toBeNull();

  const cleared = await runCli([
    "brain",
    "expire",
    signalId,
    "--expires",
    "none",
    "--vault",
    vault,
    "--json",
  ]);
  expect(cleared.returncode).toBe(0);
  const clearedBody = JSON.parse(cleared.stdout) as {
    expiration: string | null;
    previous: string | null;
  };
  expect(clearedBody.expiration).toBeNull();
  expect(clearedBody.previous).toBe("2026-07-15");
  expect(readFileSync(join(vault, "Brain/inbox", `${signalId}.md`), "utf8")).not.toContain(
    "expiration_date",
  );
});

test("expire refuses a junk date by name and leaves the artifact alone", async () => {
  const { signalId } = await feedback([]);
  const before = readFileSync(join(vault, "Brain/inbox", `${signalId}.md`), "utf8");
  const res = await runCli(["brain", "expire", signalId, "--expires", "soon", "--vault", vault]);
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("expiration_date");
  expect(readFileSync(join(vault, "Brain/inbox", `${signalId}.md`), "utf8")).toBe(before);
});

test("expire on a nonexistent id refuses by name rather than reporting a no-op", async () => {
  const res = await runCli([
    "brain",
    "expire",
    "pref-nobody-home",
    "--expires",
    "2026-07-15",
    "--vault",
    vault,
    "--json",
  ]);
  expect(res.returncode).toBe(2);
  const body = JSON.parse(res.stdout) as { ok: boolean; message: string };
  expect(body.ok).toBe(false);
  expect(body.message).toContain("pref-nobody-home");
});

test("expire without --expires is a usage refusal, not a silent read", async () => {
  const { signalId } = await feedback([]);
  const res = await runCli(["brain", "expire", signalId, "--vault", vault]);
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("--expires");
});
