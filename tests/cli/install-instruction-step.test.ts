/**
 * `o2b install` instruction step, subprocess-level tests (t_ba41a78a B3).
 *
 * The instruction step rides `runTarget`: the plan renders it (or its
 * named skip) for every target, ONE consent verdict covers the adapter
 * write and the instruction write, a `user-modified-block` refusal exits
 * 4, and a failure after the adapter applied still exits non-zero with a
 * re-run converging. `--check` is untouched: the readiness probe remains
 * the block auditor.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli as baseRunCli, type RunCliOptions, type RunResult } from "../helpers/run-cli.ts";
import { auditWritebackContractFile } from "../../src/core/brain/writeback-contract.ts";
import { DEFAULT_BEGIN_MARKER, DEFAULT_END_MARKER } from "../../src/core/install/managed-block.ts";
import { instructionBlockLockPath } from "../../src/core/install/instruction-block.ts";

function runCli(args: ReadonlyArray<string>, opts: RunCliOptions = {}): Promise<RunResult> {
  return baseRunCli(args, { ...opts, subprocess: true });
}

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let vault: string;
let home: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-install-step-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-install-step-h-"));
  configPath = join(home, "config.yaml");
  mkdirSync(vault, { recursive: true });
  writeFileSync(configPath, `vault: "${vault}"\nagent_name: "claude-vps"\ntimezone: "UTC"\n`);
});

afterEach(() => {
  for (const p of [vault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function envBase(extra: Record<string, string> = {}) {
  return {
    HOME: home,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    VAULT_DIR: vault,
    VAULT_AGENT_NAME: "claude-vps",
    VAULT_TIMEZONE: "UTC",
    ...extra,
  };
}

describe("o2b install --target <host>: the instruction step in the plan", () => {
  test("a cursor plan includes the managed-block step for the vault-root AGENTS.md", async () => {
    const r = await runCli(["install", "--target", "cursor", "--json"], { env: envBase() });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      plan: { steps: ReadonlyArray<{ kind: string; path: string | null; diff?: string }> };
    };
    const step = payload.plan.steps.find((s) => s.path !== null && s.path.endsWith("AGENTS.md"));
    expect(step).toBeDefined();
    expect(step?.kind).toBe("managed-block");
    expect(step?.diff).not.toBe("");
    // Plan-only writes nothing.
    expect(existsSync(join(vault, "AGENTS.md"))).toBe(false);
  });

  test("a gemini-cli plan carries the name-implied reading caveat", async () => {
    const r = await runCli(["install", "--target", "gemini-cli", "--json"], { env: envBase() });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      plan: { steps: ReadonlyArray<{ path: string | null; preview: string }> };
    };
    const step = payload.plan.steps.find((s) => s.path !== null && s.path.endsWith("GEMINI.md"));
    expect(step).toBeDefined();
    expect(step?.preview).toContain("name-implied");
  });

  test("a target with no precedence entry plans the named skip and no instruction step", async () => {
    const r = await runCli(["install", "--target", "copilot-cli", "--json"], { env: envBase() });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      plan: { steps: ReadonlyArray<{ path: string | null }>; postNotes: ReadonlyArray<string> };
    };
    const instructionSteps = payload.plan.steps.filter(
      (s) =>
        s.path !== null &&
        (s.path.endsWith("AGENTS.md") ||
          s.path.endsWith("CLAUDE.md") ||
          s.path.endsWith("GEMINI.md")),
    );
    expect(instructionSteps.length).toBe(0);
    expect(payload.plan.postNotes.join("\n")).toContain("copilot-cli");
    expect(payload.plan.postNotes.join("\n")).toContain("agent-instruction");
  });

  test("a symlinked instruction file refuses the plan by name, not with a crash", async () => {
    // The checker's posture: a plan cannot even be computed against a
    // link, because the file a write would land on is not the file the
    // contract audits. The refusal must be the named one on stderr - the
    // module throws before the consent gate, so an unhandled rejection
    // here would print a stack trace and exit through the top-level
    // handler instead.
    const real = join(home, "real-agents.md");
    writeFileSync(real, "# operator notes\n");
    symlinkSync(real, join(vault, "AGENTS.md"));
    const planned = await runCli(["install", "--target", "cursor", "--json"], { env: envBase() });
    expect(planned.returncode).toBe(1);
    expect(planned.stderr).toContain("error:");
    expect(planned.stderr).toContain("symbolic link");
    expect(planned.stderr).not.toMatch(/\n\s+at /);
    // The apply path refuses the same way, before any consent or write.
    const applied = await runCli(["install", "--target", "cursor", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(applied.returncode).toBe(1);
    expect(applied.stderr).toContain("symbolic link");
    expect(applied.stderr).not.toMatch(/\n\s+at /);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(instructionBlockLockPath(vault))).toBe(false);
  });
});

describe("o2b install --target <host> --apply: one consent verdict, both writes", () => {
  test("headless apply without --yes refuses with exit 6 and writes nothing", async () => {
    const r = await runCli(["install", "--target", "cursor", "--apply", "--json"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(6);
    const payload = JSON.parse(r.stdout) as { consent: string; written: boolean };
    expect(payload.consent).toBe("headless-refused");
    expect(payload.written).toBe(false);
    // Neither the adapter write nor the instruction write happened.
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(join(vault, "AGENTS.md"))).toBe(false);
    expect(existsSync(instructionBlockLockPath(vault))).toBe(false);
  });

  test("apply with --yes writes the block, and the readiness auditor grades it conforming", async () => {
    const r = await runCli(["install", "--target", "cursor", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(0);
    const audit = auditWritebackContractFile(join(vault, "AGENTS.md"));
    expect(audit.finding).toBe("conforming");
    expect(r.stdout).toContain("AGENTS.md");
    const lock = JSON.parse(readFileSync(instructionBlockLockPath(vault), "utf8")) as {
      schema_version: number;
      files: Record<string, { applied_at: string; begin_marker: string }>;
    };
    expect(lock.schema_version).toBe(1);
    expect(lock.files["AGENTS.md"]?.begin_marker).toBe(DEFAULT_BEGIN_MARKER);
    expect(Number.isFinite(Date.parse(lock.files["AGENTS.md"]?.applied_at ?? "never"))).toBe(true);
  });

  test("apply is idempotent: a re-apply converges with the same bytes", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    const once = readFileSync(join(vault, "AGENTS.md"), "utf8");
    const r = await runCli(["install", "--target", "cursor", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(0);
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toBe(once);
  });

  test("the post-apply line reports created, updated and already-current honestly", async () => {
    // First install on a vault with no AGENTS.md: the block is CREATED,
    // and the line must not claim the file already carried it.
    const created = await runCli(["install", "--target", "cursor", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(created.returncode).toBe(0);
    expect(created.stdout).toContain("instruction block: ");
    expect(created.stdout).toContain("created with the write-gate block");
    expect(created.stdout).not.toContain("already carries");

    // A hand-edited block rewritten under --force is an UPDATE.
    const rulesPath = join(vault, "AGENTS.md");
    writeFileSync(
      rulesPath,
      readFileSync(rulesPath, "utf8").replace(
        "observing-memory layer. At session start, read the current preferences",
        "hand-edited wording that no longer matches the canonical body",
      ),
    );
    const updated = await runCli(["install", "--target", "cursor", "--apply", "--yes", "--force"], {
      env: envBase(),
    });
    expect(updated.returncode).toBe(0);
    expect(updated.stdout).toContain("now carries the write-gate block");
    expect(updated.stdout).not.toContain("already carries");

    // A re-apply with nothing to change is already current.
    const current = await runCli(["install", "--target", "cursor", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(current.returncode).toBe(0);
    expect(current.stdout).toContain("already carries the current write-gate block");
  });

  test("apply with --yes --dry-run writes nothing on either lane", async () => {
    const r = await runCli(["install", "--target", "cursor", "--apply", "--yes", "--dry-run"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(0);
    expect(existsSync(join(vault, "AGENTS.md"))).toBe(false);
    expect(existsSync(instructionBlockLockPath(vault))).toBe(false);
  });
});

describe("o2b install --apply: refusals and convergence", () => {
  test("a hand-edited block on a fresh file refuses with exit 4 and a force upgrade exits 0", async () => {
    // The docs-snippet block an older manual install pasted: present,
    // non-conforming, and no lock record can prove it ours.
    writeFileSync(
      join(vault, "AGENTS.md"),
      [
        "# operator notes",
        "",
        DEFAULT_BEGIN_MARKER,
        "## Open Second Brain",
        "",
        "This project shares an Obsidian-compatible vault. Read Brain/active.md.",
        DEFAULT_END_MARKER,
        "",
      ].join("\n"),
    );
    const refused = await runCli(["install", "--target", "cursor", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(refused.returncode).toBe(4);
    expect(refused.stderr).toContain("hand-edited");
    // Nothing was written by the refused step.
    expect(auditWritebackContractFile(join(vault, "AGENTS.md")).finding).not.toBe("conforming");
    const forced = await runCli(["install", "--target", "cursor", "--apply", "--yes", "--force"], {
      env: envBase(),
    });
    expect(forced.returncode).toBe(0);
    expect(auditWritebackContractFile(join(vault, "AGENTS.md")).finding).toBe("conforming");
    // The operator's own bytes survived the upgrade.
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8").startsWith("# operator notes")).toBe(
      true,
    );
  });

  test("a failure after the adapter apply exits non-zero; a re-run converges", async () => {
    // A hand-pasted docs-snippet block refuses at APPLY time - after the
    // adapter's config write has already landed. Symlinks refuse at PLAN
    // time instead (the checker's posture), so the refusal that proves
    // the ordering here is the hand-edit one.
    writeFileSync(
      join(vault, "AGENTS.md"),
      [
        "# operator notes",
        "",
        DEFAULT_BEGIN_MARKER,
        "## Open Second Brain",
        "",
        "This project shares an Obsidian-compatible vault. Read Brain/active.md.",
        DEFAULT_END_MARKER,
        "",
      ].join("\n"),
    );
    const failed = await runCli(["install", "--target", "cursor", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(failed.returncode).toBe(4);
    // The adapter write is committed even though the run failed.
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
    expect(auditWritebackContractFile(join(vault, "AGENTS.md")).finding).not.toBe("conforming");
    // The re-run - with the documented --force override - converges: the
    // adapter write is idempotent and the instruction block lands.
    const converged = await runCli(
      ["install", "--target", "cursor", "--apply", "--yes", "--force"],
      { env: envBase() },
    );
    expect(converged.returncode).toBe(0);
    expect(auditWritebackContractFile(join(vault, "AGENTS.md")).finding).toBe("conforming");
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8").startsWith("# operator notes")).toBe(
      true,
    );
    expect(converged.stdout).toContain("instruction block");
  });
});

describe("o2b install --check stays the block-free verifier", () => {
  test("check after a successful install still exits 0 through the adapter's own verify", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    const r = await runCli(["install", "--check", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("ok");
  });
});
