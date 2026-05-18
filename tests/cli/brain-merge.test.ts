/**
 * CLI tests for `o2b brain merge`.
 *
 * The verb wraps `mergePreferences` from `src/core/brain/merge.ts`,
 * which has its own end-to-end unit coverage. Here we lock the CLI
 * surface: argument shape, interactive prompt, `--force` / `--dry-run`,
 * `--json`, and the exact exit codes for the most-common guard
 * failures.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePreference } from "../../src/core/brain/preference.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-merge-cli-test-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(brainInit.returncode).toBe(0);
}

function makePref(slug: string, overrides: Record<string, unknown> = {}): void {
  writePreference(vault, {
    slug,
    topic: "commits",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: "high",
    confidence_value: 0.8,
    pinned: false,
    ...overrides,
  });
}

describe("o2b brain merge — surface", () => {
  test("--help prints the verb usage block", async () => {
    const r = await runCli(["brain", "merge", "--help"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("brain merge");
    expect(r.stdout).toContain("<keep-pref-id>");
    expect(r.stdout).toContain("<drop-pref-id>");
  });

  test("missing positional args exits 1", async () => {
    await bootstrap();
    const r = await runCli(["brain", "merge"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("two positional ids");
  });

  test("only one positional exits 1", async () => {
    await bootstrap();
    const r = await runCli(["brain", "merge", "pref-a"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
  });
});

describe("o2b brain merge — guards", () => {
  test("same id exits 1 with explanatory message", async () => {
    await bootstrap();
    makePref("a");
    const r = await runCli(
      ["brain", "merge", "pref-a", "pref-a", "--vault", vault, "--force"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("same preference");
  });

  test("keep missing exits 1", async () => {
    await bootstrap();
    makePref("b");
    const r = await runCli(
      ["brain", "merge", "pref-missing", "pref-b", "--vault", vault, "--force"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("not found");
  });

  test("topic mismatch exits 1 even with --force", async () => {
    await bootstrap();
    makePref("a", { topic: "x" });
    makePref("b", { topic: "y" });
    const r = await runCli(
      ["brain", "merge", "pref-a", "pref-b", "--vault", vault, "--force"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("topic mismatch");
    // Drop is still present in preferences/ — guard refused the write.
    expect(
      existsSync(join(vault, "Brain", "preferences", "pref-b.md")),
    ).toBe(true);
  });
});

describe("o2b brain merge — happy paths", () => {
  test("--dry-run prints plan and writes nothing", async () => {
    await bootstrap();
    makePref("keep", { applied_count: 3 });
    makePref("drop", { applied_count: 2 });
    const r = await runCli(
      [
        "brain", "merge", "pref-keep", "pref-drop",
        "--vault", vault, "--dry-run",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("merge plan:");
    expect(r.stdout).toContain("applied_sum: 5");
    expect(r.stdout).toContain("dry-run; no changes written");
    // Drop is still in preferences/.
    expect(
      existsSync(join(vault, "Brain", "preferences", "pref-drop.md")),
    ).toBe(true);
    expect(
      existsSync(join(vault, "Brain", "retired", "ret-drop.md")),
    ).toBe(false);
  });

  test("--force commits without prompt", async () => {
    await bootstrap();
    makePref("keep");
    makePref("drop");
    const r = await runCli(
      [
        "brain", "merge", "pref-keep", "pref-drop",
        "--vault", vault, "--force",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("merged:");
    expect(
      existsSync(join(vault, "Brain", "preferences", "pref-drop.md")),
    ).toBe(false);
    expect(
      existsSync(join(vault, "Brain", "retired", "ret-drop.md")),
    ).toBe(true);
  });

  test("interactive 'y' commits", async () => {
    await bootstrap();
    makePref("keep");
    makePref("drop");
    const r = await runCli(
      ["brain", "merge", "pref-keep", "pref-drop", "--vault", vault],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config }, stdin: "y\n" },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("merged:");
    expect(
      existsSync(join(vault, "Brain", "retired", "ret-drop.md")),
    ).toBe(true);
  });

  test("interactive default 'N' (empty input) cancels", async () => {
    await bootstrap();
    makePref("keep");
    makePref("drop");
    const r = await runCli(
      ["brain", "merge", "pref-keep", "pref-drop", "--vault", vault],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config }, stdin: "\n" },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("merge cancelled");
    expect(
      existsSync(join(vault, "Brain", "preferences", "pref-drop.md")),
    ).toBe(true);
    expect(
      existsSync(join(vault, "Brain", "retired", "ret-drop.md")),
    ).toBe(false);
  });

  test("--json --dry-run emits parseable payload", async () => {
    await bootstrap();
    makePref("keep", { applied_count: 3, violated_count: 1 });
    makePref("drop", { applied_count: 2, violated_count: 0 });
    const r = await runCli(
      [
        "brain", "merge", "pref-keep", "pref-drop",
        "--vault", vault, "--dry-run", "--json",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      dry_run: boolean;
      plan: { applied_sum: number; violated_sum: number };
    };
    expect(payload.dry_run).toBe(true);
    expect(payload.plan.applied_sum).toBe(5);
    expect(payload.plan.violated_sum).toBe(1);
  });
});
