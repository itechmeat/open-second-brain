/**
 * `o2b brain doctor` names its exits (no-dead-ends, task 4).
 *
 * The doctor is the densest diagnosis surface in the product and, until
 * this task, the only consumer of {@link DIAGNOSTIC_SIGNALS} it was NOT:
 * it printed `[WARN] <code>: <message>` and stopped, leaving the caller
 * to re-derive the repair. Every reported issue now goes through the
 * advisory rail, so the human surface prints the structural command and
 * the JSON surface carries it as a field.
 *
 * Three obligations are pinned here. A registered code names its command
 * on both surfaces. An unregistered code names nothing on either - the
 * doctor must be able to report an issue it has no exit for without
 * inventing one. And a clean vault is byte-for-byte what it was before,
 * because a surface that gained a line when it had nothing to say would
 * be chrome, not a next step.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { DIAGNOSTIC_SIGNALS } from "../../src/core/brain/diagnostics.ts";
import { DOCTOR_EXIT_EXCLUSIONS } from "../../src/core/brain/doctor-exits.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { runCli } from "../helpers/run-cli.ts";

/** Two registered doctor codes that share one structural command. */
const REPAIR_COMMAND = DIAGNOSTIC_SIGNALS.get("broken-wikilink")!.nextCommand;
/** A registered doctor code with a command of its own. */
const BACKLINKS_COMMAND = DIAGNOSTIC_SIGNALS.get("broken-backlinks")!.nextCommand;

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-next-step-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath: config });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Seed two registered warning classes that resolve to the SAME command
 * (`broken-wikilink` from the dead evidence pointer, `dangling-workrun`
 * from the unterminated journal) plus one that resolves to a different
 * one (`broken-backlinks`, raised by the same dead pointer).
 */
function seedRegisteredIssues(): void {
  const runs = join(vault, "Brain", "log", "dream-runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(
    join(runs, "run-next-step.jsonl"),
    JSON.stringify({ phase: "started", at: "2026-07-18T00:00:00.000Z", run_id: "run-next-step" }) +
      "\n",
    "utf8",
  );
  writePreference(vault, {
    slug: "dead-pointer",
    topic: "dead-pointer",
    principle: "a rule whose evidence pointer went missing",
    created_at: "2026-05-14T10:00:00Z",
    unconfirmed_until: "2026-05-28T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: ["[[sig-does-not-exist]]"],
  });
}

/**
 * Seed `status-folder-mismatch`: a real doctor code with no registry
 * entry, and the only issue in the vault. The status is rewritten after
 * the write because the writer refuses to emit a folder-inconsistent
 * one - which is the point of the lint.
 */
function seedUnregisteredIssue(): void {
  writePreference(vault, {
    slug: "mismatch",
    topic: "mismatch",
    principle: "a rule filed under the wrong folder",
    created_at: "2026-05-14T10:00:00Z",
    unconfirmed_until: "2026-05-28T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: [],
  });
  const path = join(vault, "Brain", "preferences", "pref-mismatch.md");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("_status: unconfirmed", "_status: retired"),
    "utf8",
  );
}

/** Every `next:` line in `stdout`, in order. */
function nextLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("next: "));
}

describe("brain doctor - the human surface names the command", () => {
  test("a registered code prints its structural next command", async () => {
    seedRegisteredIssues();
    const r = await runCli(["brain", "doctor", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("[WARN]  broken-wikilink:");
    expect(nextLines(r.stdout)).toContain(`next: ${REPAIR_COMMAND}`);
    expect(nextLines(r.stdout)).toContain(`next: ${BACKLINKS_COMMAND}`);
  });

  test("two codes sharing one command print that command once", async () => {
    seedRegisteredIssues();
    const r = await runCli(["brain", "doctor", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    // `broken-wikilink` and `dangling-workrun` both exit through the
    // repair verb. Two identical lines would be noise, not a next step.
    expect(r.stdout).toContain("[WARN]  broken-wikilink:");
    expect(r.stdout).toContain("[WARN]  dangling-workrun:");
    const repeated = nextLines(r.stdout).filter((line) => line === `next: ${REPAIR_COMMAND}`);
    expect(repeated).toHaveLength(1);
  });

  test("an unregistered code prints no next step at all", async () => {
    seedUnregisteredIssue();
    const r = await runCli(["brain", "doctor", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("[WARN]  status-folder-mismatch:");
    expect(nextLines(r.stdout)).toEqual([]);
  });
});

describe("brain doctor --json - the field, never the line", () => {
  test("a registered issue carries next_command and stdout still parses", async () => {
    seedRegisteredIssues();
    const r = await runCli(["brain", "doctor", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("next: ");
    const payload = JSON.parse(r.stdout) as {
      warnings: ReadonlyArray<{ code: string; next_command?: string }>;
    };
    const wikilink = payload.warnings.find((w) => w.code === "broken-wikilink");
    expect(wikilink?.next_command).toBe(REPAIR_COMMAND);
    const backlinks = payload.warnings.find((w) => w.code === "broken-backlinks");
    expect(backlinks?.next_command).toBe(BACKLINKS_COMMAND);
  });

  test("an unregistered issue carries no next_command key", async () => {
    seedUnregisteredIssue();
    const r = await runCli(["brain", "doctor", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const payload = JSON.parse(r.stdout) as {
      warnings: ReadonlyArray<Record<string, unknown>>;
    };
    const mismatch = payload.warnings.find((w) => w["code"] === "status-folder-mismatch");
    expect(mismatch).toBeDefined();
    expect(Object.hasOwn(mismatch!, "next_command")).toBe(false);
  });
});

describe("brain doctor - silence is explained, not merely silent", () => {
  test("a code with no exit says so, with the published reason", async () => {
    seedUnregisteredIssue();
    const r = await runCli(["brain", "doctor", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(
      `no exit: status-folder-mismatch - ${DOCTOR_EXIT_EXCLUSIONS.get("status-folder-mismatch")!}`,
    );
  });

  test("a registered code contributes no explanation - it has a command instead", async () => {
    seedRegisteredIssues();
    const r = await runCli(["brain", "doctor", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.stdout).not.toContain("no exit: broken-wikilink");
  });

  test("--json carries the reasons once per code, off the issue records", async () => {
    seedUnregisteredIssue();
    const r = await runCli(["brain", "doctor", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.stdout).not.toContain("no exit: ");
    const payload = JSON.parse(r.stdout) as {
      no_exit?: Record<string, string>;
      warnings: ReadonlyArray<Record<string, unknown>>;
    };
    expect(payload.no_exit?.["status-folder-mismatch"]).toBe(
      DOCTOR_EXIT_EXCLUSIONS.get("status-folder-mismatch")!,
    );
    // The reason rides once, beside the streams - never repeated per issue.
    const mismatch = payload.warnings.find((w) => w["code"] === "status-folder-mismatch");
    expect(Object.hasOwn(mismatch!, "no_exit")).toBe(false);
  });
});

describe("brain doctor - byte-identical when there is nothing to point at", () => {
  test("a clean vault prints exactly what it printed before", async () => {
    const r = await runCli(["brain", "doctor", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe("brain doctor: clean\n");
  });

  test("a clean vault's JSON payload is the pre-task shape", async () => {
    const r = await runCli(["brain", "doctor", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe(JSON.stringify({ warnings: [], errors: [] }, null, 2) + "\n");
  });
});
