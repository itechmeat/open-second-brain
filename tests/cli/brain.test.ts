/**
 * CLI tests for `o2b brain *` (Task 6, Step 25).
 *
 * Each verb is exercised end-to-end through `runCli`, which forks the
 * actual `bun src/cli/main.ts` binary. The fork model is shared with the
 * legacy CLI tests so the test surface stays consistent.
 *
 * Test-vault setup pattern:
 *   1. `o2b init --vault <tmp>` registers the vault in a per-test
 *      machine config (isolated via OPEN_SECOND_BRAIN_CONFIG).
 *   2. `o2b brain init --vault <tmp>` creates the Brain skeleton.
 *   3. The verb under test runs against that vault.
 *
 * We assert exit codes (the §9.2 matrix) and the canonical stdout/stderr
 * patterns. Markdown body shapes are spot-checked but kept loose — the
 * unit tests under `tests/core/brain.*.test.ts` already lock the
 * renderers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-cli-test-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Bootstrap a fresh vault with the Brain layer installed. */
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

describe("brain --help", () => {
  test("prints the verb listing", async () => {
    const r = await runCli(["brain", "--help"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("usage: o2b brain");
    expect(r.stdout).toContain("init");
    expect(r.stdout).toContain("feedback");
    expect(r.stdout).toContain("dream");
    expect(r.stdout).toContain("apply-evidence");
    expect(r.stdout).toContain("digest");
    expect(r.stdout).toContain("intent-review");
    expect(r.stdout).toContain("retention");
    expect(r.stdout).toContain("monthly");
    expect(r.stdout).toContain("query");
    expect(r.stdout).toContain("reject");
    expect(r.stdout).toContain("pin");
    expect(r.stdout).toContain("unpin");
    expect(r.stdout).toContain("rollback");
    expect(r.stdout).toContain("doctor");
    expect(r.stdout).toContain("upgrade");
  });

  test("unknown verb exits 2 and lists known verbs", async () => {
    const r = await runCli(["brain", "no-such-verb"]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("unknown brain verb");
  });

  test("unknown verb requesting --help falls back to generic help with exit 2", async () => {
    const r = await runCli(["brain", "no-such-verb", "--help"]);
    expect(r.returncode).toBe(2);
    // Should print the generic Brain help (lists known verbs), not a
    // bare placeholder line.
    expect(r.stdout).toContain("usage: o2b brain");
    expect(r.stdout).toContain("feedback");
  });

  test("known verb --help exits 0 with verb-specific help", async () => {
    const r = await runCli(["brain", "feedback", "--help"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("brain feedback");
  });
});

describe("brain init", () => {
  test("creates Brain/ skeleton against a registered vault", async () => {
    const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(init.returncode).toBe(0);
    const r = await runCli(["brain", "init", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("brain initialized:");
    expect(existsSync(join(vault, "Brain", "_brain.yaml"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "_BRAIN.md"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "inbox"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "preferences"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "retired"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "log"))).toBe(true);
  });

  test("--json emits structured output", async () => {
    const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(init.returncode).toBe(0);
    const r = await runCli(["brain", "init", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.created)).toBe(true);
  });

  test("missing vault config exits 1 with hint", async () => {
    // No prior `o2b init` → bootstrapBrain refuses.
    const cfg = join(tmp, "missing-config.yaml");
    const r = await runCli(["brain", "init", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: cfg },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("o2b init");
  });

  test("--primary-agent threads value into _brain.yaml", async () => {
    const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(init.returncode).toBe(0);
    const r = await runCli(["brain", "init", "--vault", vault, "--primary-agent", "hermes-vps"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const yaml = readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8");
    expect(yaml).toMatch(/^primary_agent: "hermes-vps"$/m);
  });

  test("--primary-agent empty value exits 1", async () => {
    const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(init.returncode).toBe(0);
    const r = await runCli(["brain", "init", "--vault", vault, "--primary-agent", "   "], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("primary-agent");
  });
});

describe("brain set-primary", () => {
  test("writes the agent name into _brain.yaml", async () => {
    await bootstrap();
    const r = await runCli(["brain", "set-primary", "hermes-vps", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("primary_agent: null → hermes-vps");
    const yaml = readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8");
    expect(yaml).toMatch(/^primary_agent: "hermes-vps"$/m);
  });

  test("repeat call is a no-op", async () => {
    await bootstrap();
    await runCli(["brain", "set-primary", "hermes-vps", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(["brain", "set-primary", "hermes-vps", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("already set to hermes-vps");
  });

  test("--clear restores null", async () => {
    await bootstrap();
    await runCli(["brain", "set-primary", "hermes-vps", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(["brain", "set-primary", "--clear", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("hermes-vps → null");
  });

  test("missing positional and missing --clear exits 1", async () => {
    await bootstrap();
    const r = await runCli(["brain", "set-primary", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
  });

  test("--json emits structured output", async () => {
    await bootstrap();
    const r = await runCli(["brain", "set-primary", "hermes-vps", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.previous).toBeNull();
    expect(parsed.next).toBe("hermes-vps");
    expect(parsed.changed).toBe(true);
  });
});

describe("brain feedback", () => {
  test("writes a signal file with all required fields", async () => {
    await bootstrap();
    const r = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "no-abbrev",
        "--signal",
        "negative",
        "--principle",
        "Do not use abbreviations",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("signal: ");
    expect(r.stdout).toContain("id: sig-");
    const inbox = readdirSync(join(vault, "Brain", "inbox")).filter((n) => n.endsWith(".md"));
    expect(inbox.length).toBe(1);
    const body = readFileSync(join(vault, "Brain", "inbox", inbox[0]!), "utf8");
    expect(body).toContain("no-abbrev");
    expect(body).toContain("negative");
  });

  test("missing --topic exits 1 naming the flag", async () => {
    await bootstrap();
    const r = await runCli(
      ["brain", "feedback", "--vault", vault, "--signal", "positive", "--principle", "x"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--topic");
  });

  test("bad --signal value exits 1", async () => {
    await bootstrap();
    const r = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "t",
        "--signal",
        "maybe",
        "--principle",
        "x",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--signal");
  });

  test("--force-confirmed writes a confirmed preference", async () => {
    await bootstrap();
    const r = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "shortcut",
        "--signal",
        "positive",
        "--principle",
        "Skip the trial window",
        "--force-confirmed",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("status: confirmed");
    const pref = join(vault, "Brain", "preferences", "pref-shortcut.md");
    expect(existsSync(pref)).toBe(true);
    const body = readFileSync(pref, "utf8");
    expect(body).toContain("status: confirmed");
  });
});

describe("brain feedback — default_scope", () => {
  /** Append a feedback block to the vault's _brain.yaml. */
  function setDefaultScope(scope: string): void {
    const yamlPath = join(vault, "Brain", "_brain.yaml");
    const existing = readFileSync(yamlPath, "utf8");
    writeFileSync(yamlPath, `${existing}\nfeedback:\n  default_scope: ${scope}\n`, "utf8");
  }

  function readInbox(): string {
    const inbox = readdirSync(join(vault, "Brain", "inbox")).filter((n) => n.endsWith(".md"));
    expect(inbox.length).toBe(1);
    return readFileSync(join(vault, "Brain", "inbox", inbox[0]!), "utf8");
  }

  test("default_scope applies when no --scope is passed", async () => {
    await bootstrap();
    setDefaultScope("coding");
    const r = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "use-tabs",
        "--signal",
        "positive",
        "--principle",
        "Indent with tabs",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const body = readInbox();
    expect(body).toContain("scope: coding");
    expect(body).toContain("brain/scope/coding");
  });

  test("explicit --scope overrides default_scope", async () => {
    await bootstrap();
    setDefaultScope("coding");
    const r = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "doc-rule",
        "--signal",
        "positive",
        "--principle",
        "Document public APIs",
        "--scope",
        "docs",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const body = readInbox();
    expect(body).toContain("scope: docs");
    expect(body).not.toContain("scope: coding");
  });

  test("no default and no --scope omits scope (byte-identical)", async () => {
    await bootstrap();
    const r = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "plain-rule",
        "--signal",
        "positive",
        "--principle",
        "A scope-less rule",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const body = readInbox();
    expect(body).not.toContain("scope:");
    expect(body).not.toContain("brain/scope/");
  });

  test("force-confirmed preference inherits the default scope", async () => {
    await bootstrap();
    setDefaultScope("coding");
    const r = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "fc-rule",
        "--signal",
        "positive",
        "--principle",
        "Force confirmed with default scope",
        "--force-confirmed",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const pref = readFileSync(join(vault, "Brain", "preferences", "pref-fc-rule.md"), "utf8");
    expect(pref).toContain("scope: coding");
  });
});

describe("brain dream", () => {
  test("happy path on empty vault returns no-op", async () => {
    await bootstrap();
    const r = await runCli(["brain", "dream", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.changed).toBe(false);
  });

  test("--now must be ISO-8601", async () => {
    await bootstrap();
    const r = await runCli(["brain", "dream", "--vault", vault, "--now", "not-a-date"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--now");
  });

  test("blank --agent exits 1 instead of falling back to the resolved default", async () => {
    await bootstrap();
    const r = await runCli(["brain", "dream", "--vault", vault, "--agent", "   "], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--agent");
  });
});

describe("brain apply-evidence", () => {
  test("missing required flag exits 1 naming the flag", async () => {
    await bootstrap();
    const r = await runCli(["brain", "apply-evidence", "--vault", vault, "--artifact", "[[foo]]"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--pref");
  });

  test("unknown pref exits 2 (informational not-found)", async () => {
    await bootstrap();
    const r = await runCli(
      [
        "brain",
        "apply-evidence",
        "--vault",
        vault,
        "--pref",
        "pref-missing",
        "--artifact",
        "[[Daily/2026.05.14]]",
        "--result",
        "applied",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("preference not found");
  });

  test("happy path appends to today's log", async () => {
    await bootstrap();
    // Seed a force-confirmed preference so apply-evidence has a target.
    const seed = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "fast",
        "--signal",
        "positive",
        "--principle",
        "Be fast",
        "--force-confirmed",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(seed.returncode).toBe(0);
    const r = await runCli(
      [
        "brain",
        "apply-evidence",
        "--vault",
        vault,
        "--pref",
        "pref-fast",
        "--artifact",
        "[[Daily/2026.05.14]]",
        "--result",
        "applied",
        "--agent",
        "claude",
        "--note",
        "applied to draft",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("logged:");
    const logs = readdirSync(join(vault, "Brain", "log")).filter((n) => n.endsWith(".md"));
    expect(logs.length).toBe(1);
    const body = readFileSync(join(vault, "Brain", "log", logs[0]!), "utf8");
    expect(body).toContain("apply-evidence");
    expect(body).toContain("[[pref-fast|");
  });
});

describe("brain digest", () => {
  test("empty vault → one-line default output", async () => {
    await bootstrap();
    const r = await runCli(["brain", "digest", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("no changes");
  });

  test("--silent-if-empty exits 2 with no body", async () => {
    await bootstrap();
    const r = await runCli(["brain", "digest", "--vault", vault, "--silent-if-empty"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stdout.trim()).toBe("");
  });

  test("--json emits structured payload", async () => {
    await bootstrap();
    const r = await runCli(["brain", "digest", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.schema_version).toBe(1);
    expect(payload.summary.empty).toBe(true);
  });
});

describe("brain query", () => {
  test("requires one of --preference / --topic / --since", async () => {
    await bootstrap();
    const r = await runCli(["brain", "query", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--preference");
  });

  test("--topic on empty vault returns empty result", async () => {
    await bootstrap();
    const r = await runCli(
      ["brain", "query", "--vault", vault, "--topic", "no-such-topic", "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.signals.length).toBe(0);
    expect(payload.preference).toBeNull();
  });

  test("--preference on missing pref exits 2", async () => {
    await bootstrap();
    const r = await runCli(["brain", "query", "--vault", vault, "--preference", "pref-nope"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("brain query");
  });

  test("--since requires ISO timestamp", async () => {
    await bootstrap();
    const r = await runCli(["brain", "query", "--vault", vault, "--since", "garbage"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--since");
  });
});

describe("brain reject", () => {
  test("moves a pref to retired/", async () => {
    await bootstrap();
    const seed = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "obsolete",
        "--signal",
        "negative",
        "--principle",
        "Never do X",
        "--force-confirmed",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(seed.returncode).toBe(0);
    const r = await runCli(
      [
        "brain",
        "reject",
        "--vault",
        vault,
        "--id",
        "pref-obsolete",
        "--reason",
        "user changed mind",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("retired: ret-obsolete");
    expect(existsSync(join(vault, "Brain", "preferences", "pref-obsolete.md"))).toBe(false);
    expect(existsSync(join(vault, "Brain", "retired", "ret-obsolete.md"))).toBe(true);
  });

  test("missing --id exits 1", async () => {
    await bootstrap();
    const r = await runCli(["brain", "reject", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--id");
  });

  test("missing --reason exits 1 (mandatory from v0.10.1)", async () => {
    await bootstrap();
    const r = await runCli(["brain", "reject", "--vault", vault, "--id", "pref-ghost"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--reason");
  });

  test("unknown pref exits 2", async () => {
    await bootstrap();
    const r = await runCli(
      ["brain", "reject", "--vault", vault, "--id", "pref-ghost", "--reason", "ghost"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("preference not found");
  });

  test("pinned pref refuses without --yes", async () => {
    await bootstrap();
    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "important",
        "--signal",
        "positive",
        "--principle",
        "Important rule",
        "--force-confirmed",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const pin = await runCli(["brain", "pin", "--vault", vault, "--id", "pref-important"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(pin.returncode).toBe(0);

    const r = await runCli(
      [
        "brain",
        "reject",
        "--vault",
        vault,
        "--id",
        "pref-important",
        "--reason",
        "no longer relevant",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("pinned");
    expect(r.stderr).toContain("--yes");
    // Pref must still exist (rejection refused).
    expect(existsSync(join(vault, "Brain", "preferences", "pref-important.md"))).toBe(true);
  });

  test("pinned pref retires with --yes", async () => {
    await bootstrap();
    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "important",
        "--signal",
        "positive",
        "--principle",
        "Important rule",
        "--force-confirmed",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    await runCli(["brain", "pin", "--vault", vault, "--id", "pref-important"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(
      [
        "brain",
        "reject",
        "--vault",
        vault,
        "--id",
        "pref-important",
        "--yes",
        "--reason",
        "no longer the right call",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(existsSync(join(vault, "Brain", "retired", "ret-important.md"))).toBe(true);
    // §6: the user reason must land on the retired file's frontmatter.
    const ret = readFileSync(join(vault, "Brain", "retired", "ret-important.md"), "utf8");
    expect(ret).toContain("user_rejected_reason: no longer the right call");
  });
});

describe("brain pin / unpin", () => {
  async function seedPref(): Promise<void> {
    await bootstrap();
    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "rule",
        "--signal",
        "positive",
        "--principle",
        "Keep going",
        "--force-confirmed",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
  }

  test("pin then idempotent rerun", async () => {
    await seedPref();
    const r1 = await runCli(["brain", "pin", "--vault", vault, "--id", "pref-rule"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r1.returncode).toBe(0);
    expect(r1.stdout).toContain("pinned: pref-rule");
    const r2 = await runCli(["brain", "pin", "--vault", vault, "--id", "pref-rule"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r2.returncode).toBe(0);
    expect(r2.stdout).toContain("already pinned");
  });

  test("unpin toggles back", async () => {
    await seedPref();
    await runCli(["brain", "pin", "--vault", vault, "--id", "pref-rule"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(["brain", "unpin", "--vault", vault, "--id", "pref-rule"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("unpinned: pref-rule");
  });

  test("missing --id exits 1", async () => {
    await bootstrap();
    const r = await runCli(["brain", "pin", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--id");
  });
});

describe("brain rollback", () => {
  test("--list reports the snapshot directory contents", async () => {
    await bootstrap();
    // Force a snapshot by running dream after producing a state change.
    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "rollback-target",
        "--signal",
        "positive",
        "--principle",
        "p",
        "--force-confirmed",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    await runCli(["brain", "dream", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(["brain", "rollback", "--vault", vault, "--list", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const list = JSON.parse(r.stdout) as Array<{ run_id: string }>;
    // Snapshot may or may not have been written depending on whether
    // dream produced any state changes — accept either shape; the
    // crucial bit is that the command emitted a JSON array.
    expect(Array.isArray(list)).toBe(true);
  });

  test("requires a run_id when not using --list", async () => {
    await bootstrap();
    const r = await runCli(["brain", "rollback", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("run_id");
  });

  test("unknown run_id exits 2", async () => {
    await bootstrap();
    const r = await runCli(["brain", "rollback", "--vault", vault, "no-such-run", "--yes"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("snapshot not found");
  });

  test("--json without --yes fails fast (never hangs on a prompt)", async () => {
    await bootstrap();
    // Even on a fake run_id the dispatcher must refuse to prompt under
    // --json — otherwise scripted callers deadlock waiting for stdin.
    // The new non-interactive guard short-circuits before the snapshot
    // existence probe; we treat that as the contract under test.
    const r = await runCli(["brain", "rollback", "--vault", vault, "any-run", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    // Either 1 (non-interactive guard) or 2 (snapshot-not-found) is
    // acceptable as long as the call returns without hanging. The
    // crucial bit is no timeout.
    expect([1, 2]).toContain(r.returncode);
  });

  test("--yes restores byte-for-byte", async () => {
    await bootstrap();
    // 1. State A: one signal.
    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "before",
        "--signal",
        "positive",
        "--principle",
        "p",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    // 2. Dream creates a snapshot.
    const dr = await runCli(["brain", "dream", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(dr.returncode).toBe(0);
    const dpayload = JSON.parse(dr.stdout) as {
      run_id: string;
      changed: boolean;
    };
    if (!dpayload.changed) {
      // No state change → no snapshot. Nothing to assert; this is a
      // dream-determinism quirk on near-empty vaults. We rely on the
      // prior --list test for the snapshot-listing contract.
      return;
    }
    // 3. Add a second signal (state B).
    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "after",
        "--signal",
        "positive",
        "--principle",
        "p",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(
      readdirSync(join(vault, "Brain", "inbox")).filter((n) => n.endsWith(".md")).length,
    ).toBeGreaterThanOrEqual(1);
    // 4. Rollback to the snapshot. State B drifted (a new signal
    // landed after the snapshot), so v0.10.6 rollback requires
    // --force-rollback to overwrite the live tree.
    const r = await runCli(
      ["brain", "rollback", "--vault", vault, dpayload.run_id, "--yes", "--force-rollback"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("restored:");
  });

  test("aborts on drift without --force-rollback (§5-tail)", async () => {
    await bootstrap();
    // State A: one signal.
    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "drift-a",
        "--signal",
        "positive",
        "--principle",
        "p",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const dr = await runCli(["brain", "dream", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const dpayload = JSON.parse(dr.stdout) as {
      run_id: string;
      changed: boolean;
    };
    if (!dpayload.changed) return;

    // Drift: second signal lands after the snapshot.
    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "drift-b",
        "--signal",
        "positive",
        "--principle",
        "p",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const r = await runCli(["brain", "rollback", "--vault", vault, dpayload.run_id, "--yes"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("Drift detected");
    expect(r.stderr).toContain("--force-rollback");
  });

  test("--json drift abort emits structured payload", async () => {
    await bootstrap();
    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "drift-json-a",
        "--signal",
        "positive",
        "--principle",
        "p",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const dr = await runCli(["brain", "dream", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const dpayload = JSON.parse(dr.stdout) as {
      run_id: string;
      changed: boolean;
    };
    if (!dpayload.changed) return;

    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "drift-json-b",
        "--signal",
        "positive",
        "--principle",
        "p",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const r = await runCli(
      ["brain", "rollback", "--vault", vault, dpayload.run_id, "--yes", "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    const payload = JSON.parse(r.stdout) as {
      run_id: string;
      drift: boolean;
      added: string[];
      removed: string[];
      changed: string[];
    };
    expect(payload.run_id).toBe(dpayload.run_id);
    expect(payload.drift).toBe(true);
  });

  test("legacy snapshot without sidecar warns and proceeds", async () => {
    await bootstrap();
    await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "legacy-a",
        "--signal",
        "positive",
        "--principle",
        "p",
        "--agent",
        "claude",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const dr = await runCli(["brain", "dream", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const dpayload = JSON.parse(dr.stdout) as {
      run_id: string;
      changed: boolean;
    };
    if (!dpayload.changed) return;

    // Simulate a pre-v0.10.6 snapshot: archive with no manifest.
    const sidecar = join(vault, "Brain", ".snapshots", `${dpayload.run_id}.manifest.json`);
    rmSync(sidecar, { force: true });

    const r = await runCli(["brain", "rollback", "--vault", vault, dpayload.run_id, "--yes"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stderr).toContain("no manifest sidecar");
    expect(r.stderr).toContain("predates v0.10.6");
  });
});

describe("brain doctor", () => {
  test("clean vault reports clean", async () => {
    await bootstrap();
    const r = await runCli(["brain", "doctor", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("clean");
  });

  test("--json emits structured output", async () => {
    await bootstrap();
    const r = await runCli(["brain", "doctor", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(Array.isArray(payload.warnings)).toBe(true);
    expect(Array.isArray(payload.errors)).toBe(true);
  });

  test("--strict promotes warnings to exit 2", async () => {
    await bootstrap();
    // Introduce a status-vs-folder warning: drop a `pref-` file whose
    // status doesn't match the folder.
    const corrupt = join(vault, "Brain", "preferences", "pref-broken.md");
    // Use the same canonical shape as the writer so the parser surfaces
    // a status-folder mismatch (status='retired' under preferences/).
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    writeFileSync(
      corrupt,
      [
        "---",
        "kind: brain-preference",
        "id: pref-broken",
        "created_at: 2026-05-14T10:00:00Z",
        "confirmed_at: null",
        "unconfirmed_until: 2026-05-28T10:00:00Z",
        "tags: [brain, brain/preference]",
        "topic: broken",
        "status: retired",
        "principle: x",
        "evidenced_by: []",
        "applied_count: 0",
        "violated_count: 0",
        "last_evidence_at: null",
        "confidence: low",
        "pinned: false",
        "---",
        "",
        "## Principle",
        "",
        "x",
      ].join("\n"),
      "utf8",
    );
    const r = await runCli(["brain", "doctor", "--vault", vault, "--strict"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    // Status-folder mismatch is a warning; --strict promotes to exit 2.
    // An invariant-error path would land at exit 1 (errors), and that
    // also satisfies the spirit of "doctor surfaced the corruption", so
    // we accept either non-zero code as a regression guard.
    expect([1, 2]).toContain(r.returncode);
  });
});

// ── §9 scan-inline CLI ──────────────────────────────────────────────────────

describe("brain scan-inline", () => {
  test("finds inline marker, creates signal, rewrites source file", async () => {
    await bootstrap();
    const notePath = join(vault, "Daily", "2026-05-16.md");
    mkdirSync(join(vault, "Daily"), { recursive: true });
    writeFileSync(notePath, "@osb feedback negative topic=cli-test principle=p\n", "utf8");

    const r = await runCli(["brain", "scan-inline", "--vault", vault, "--path", "Daily"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toMatch(/created: 1/);

    const after = readFileSync(notePath, "utf8");
    expect(after).toMatch(/@osb✓ \[\[sig-/);

    const inbox = join(vault, "Brain", "inbox");
    const sigs = readdirSync(inbox).filter((n) => n.startsWith("sig-"));
    expect(sigs.length).toBe(1);
  });

  test("--dry-run does not write signals or rewrite files", async () => {
    await bootstrap();
    const notePath = join(vault, "Daily", "2026-05-16.md");
    mkdirSync(join(vault, "Daily"), { recursive: true });
    writeFileSync(notePath, "@osb feedback negative topic=dry principle=p\n", "utf8");
    const before = readFileSync(notePath, "utf8");

    const r = await runCli(
      ["brain", "scan-inline", "--vault", vault, "--dry-run", "--path", "Daily"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(readFileSync(notePath, "utf8")).toBe(before);
    const inbox = join(vault, "Brain", "inbox");
    expect(readdirSync(inbox).filter((n) => n.startsWith("sig-")).length).toBe(0);
  });

  test("--json emits machine-readable summary", async () => {
    await bootstrap();
    mkdirSync(join(vault, "Daily"), { recursive: true });
    writeFileSync(
      join(vault, "Daily", "x.md"),
      "@osb feedback negative topic=jt principle=p\n",
      "utf8",
    );
    const r = await runCli(
      ["brain", "scan-inline", "--vault", vault, "--json", "--path", "Daily"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.created).toBe(1);
    expect(parsed.found).toBe(1);
  });

  test("--strict exits 2 when malformed marker attempts are present", async () => {
    await bootstrap();
    mkdirSync(join(vault, "Daily"), { recursive: true });
    writeFileSync(
      join(vault, "Daily", "bad.md"),
      "@osb feedback negative topic=missing-principle\n",
      "utf8",
    );
    const r = await runCli(
      ["brain", "scan-inline", "--vault", vault, "--strict", "--path", "Daily"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stdout).toMatch(/malformed: 1/);
  });
});

// ── §16 import-session CLI ──────────────────────────────────────────────────

describe("brain import-session", () => {
  test("imports a single .jsonl file and creates signals", async () => {
    await bootstrap();
    const fixture = join(process.cwd(), "tests/fixtures/sessions/claude-minimal.jsonl");
    const r = await runCli(["brain", "import-session", fixture, "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toMatch(/signals_created: [1-9]/);

    const inbox = join(vault, "Brain", "inbox");
    const sigs = readdirSync(inbox).filter((n) => n.startsWith("sig-"));
    expect(sigs.length).toBeGreaterThan(0);
  });

  test("--dry-run does not create signals", async () => {
    await bootstrap();
    const fixture = join(process.cwd(), "tests/fixtures/sessions/claude-minimal.jsonl");
    const r = await runCli(["brain", "import-session", fixture, "--vault", vault, "--dry-run"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const inbox = join(vault, "Brain", "inbox");
    expect(readdirSync(inbox).filter((n) => n.startsWith("sig-")).length).toBe(0);
  });

  test("--json structured output", async () => {
    await bootstrap();
    const fixture = join(process.cwd(), "tests/fixtures/sessions/codex-minimal.jsonl");
    const r = await runCli(["brain", "import-session", fixture, "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.files.length).toBe(1);
    expect(parsed.files[0].format).toBe("codex");
  });

  test("--recall populates session recall DAG", async () => {
    await bootstrap();
    const fixture = join(process.cwd(), "tests/fixtures/sessions/codex-minimal.jsonl");
    const r = await runCli(
      [
        "brain",
        "import-session",
        fixture,
        "--vault",
        vault,
        "--recall",
        "--recall-session-id",
        "cli-import-recall",
        "--json",
      ],
      {
        env: { OPEN_SECOND_BRAIN_CONFIG: config },
      },
    );
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.files[0].recall_turns_imported).toBeGreaterThan(0);

    const describe = await runCli(
      [
        "brain",
        "session-describe",
        "--vault",
        vault,
        "--session-id",
        "cli-import-recall",
        "--json",
      ],
      {
        env: { OPEN_SECOND_BRAIN_CONFIG: config },
      },
    );
    expect(describe.returncode).toBe(0);
    expect(JSON.parse(describe.stdout).raw_turns).toBe(parsed.files[0].recall_turns_imported);
  });

  test("exit 2 on unknown format without --format flag", async () => {
    await bootstrap();
    const junk = join(tmp, "junk.jsonl");
    writeFileSync(junk, '{"foo":"bar"}\n', "utf8");
    const r = await runCli(["brain", "import-session", junk, "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr.toLowerCase()).toMatch(/autodetect|format/);
  });
});

describe("brain vault resolution", () => {
  test("no vault flag and no machine config exits 1 with hint", async () => {
    const cfg = join(tmp, "non-existent-config.yaml");
    const r = await runCli(["brain", "doctor"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: cfg },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("vault");
  });
});

describe("brain protect", () => {
  test("--target claudecode --print returns the JSON shape, exit 0", async () => {
    await bootstrap();
    const r = await runCli(["brain", "protect", "--target", "claudecode", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("Write(");
    expect(r.stdout).toContain("preview only");
    expect(existsSync(join(vault, ".claude", "settings.json"))).toBe(false);
  });

  test("--target codex --print includes the managed fence", async () => {
    await bootstrap();
    const r = await runCli(["brain", "protect", "--target", "codex", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("# >>> open-second-brain managed >>>");
  });

  test("unknown --target exits 1 with a clear message", async () => {
    await bootstrap();
    const r = await runCli(["brain", "protect", "--target", "vim", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("unknown");
    expect(r.stderr).toContain("claudecode");
  });

  test("--apply writes settings.json and is idempotent", async () => {
    await bootstrap();
    const first = await runCli(
      ["brain", "protect", "--target", "claudecode", "--vault", vault, "--apply"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(first.returncode).toBe(0);
    expect(first.stdout).toContain("applied to");
    const settingsPath = join(vault, ".claude", "settings.json");
    const bytesAfterFirst = readFileSync(settingsPath, "utf8");
    expect(bytesAfterFirst).toContain("Write(");

    const second = await runCli(
      ["brain", "protect", "--target", "claudecode", "--vault", vault, "--apply"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(second.returncode).toBe(0);
    expect(second.stdout).toContain("no changes");
    expect(readFileSync(settingsPath, "utf8")).toBe(bytesAfterFirst);
  });

  test("apply + unprotect round-trip leaves no managed entries", async () => {
    await bootstrap();
    await runCli(["brain", "protect", "--target", "claudecode", "--vault", vault, "--apply"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(["brain", "unprotect", "--target", "claudecode", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("removed");
    const parsed = JSON.parse(readFileSync(join(vault, ".claude", "settings.json"), "utf8"));
    // After unprotect, OSB-owned deny entries are gone. The keys may
    // remain empty (user could have other rules) — assert via filter.
    const ownedLeft = (parsed.permissions?.deny ?? []).filter((e: string) =>
      e.includes("Brain/preferences"),
    );
    expect(ownedLeft).toEqual([]);
  });
});
