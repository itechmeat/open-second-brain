/**
 * `o2b brain permissions` (write-side-trust, Task 4).
 *
 * The operator surface over the permissions document and the decision
 * ledger. `show` exists so the foot-gun a default-deny document is stays
 * visible BEFORE the first refusal: it renders the dry-run decision table
 * over the declared agents. `ledger` is the query half of the
 * accountability trail. A document that cannot be read is never smoothed
 * over: `show` fails naming the field, and the doctor reports the same
 * fault under `permissions-unreadable` - exactly once.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendDecisionLedger } from "../../src/core/brain/permissions/ledger.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let docPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-permissions-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  docPath = join(vault, "Brain", "_permissions.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeDoc(text: string): void {
  writeFileSync(docPath, text, "utf8");
}

const DOCUMENT = [
  "version: 1",
  "default_action: deny",
  "roles:",
  "  reviewer:",
  "    write: ask",
  "    ingest: deny",
  "agents:",
  "  codex:",
  "    role: reviewer",
  "    write: allow",
  "entries:",
  "  - id: freeze-notes",
  "    agent: codex",
  "    action: write",
  "    target: notes/foo.md",
  "    verdict: deny",
].join("\n");

describe("brain permissions show", () => {
  test("with no document it says so and prints no decision table", async () => {
    const result = await runCli(["brain", "permissions", "show", "--vault", vault]);
    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain("no permissions document");
    expect(result.stdout).toContain("_permissions.yaml");
    // The decision table's header never appears when there is nothing to resolve.
    expect(result.stdout).not.toContain("decision");
  });

  test("with a document it renders the resolved decision for each declared agent", async () => {
    writeDoc(`${DOCUMENT}\n`);
    const result = await runCli(["brain", "permissions", "show", "--vault", vault]);
    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain("deny"); // the explicit default
    expect(result.stdout).toContain("reviewer");
    expect(result.stdout).toContain("codex");
    // Sources name the deciding rule: the target-scoped entry beats the
    // agent override on its target, the override wins elsewhere.
    expect(result.stdout).toContain("entry:freeze-notes");
    expect(result.stdout).toContain("agent:codex");
    expect(result.stdout).toContain("role:reviewer");
  });

  test("--json carries the document and one resolved row per agent per action", async () => {
    writeDoc(`${DOCUMENT}\n`);
    const result = await runCli(["brain", "permissions", "show", "--vault", vault, "--json"]);
    expect(result.returncode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      document: { default_action: string } | null;
      decisions: Array<{
        agent: string;
        action: string;
        target: string;
        verdict: string;
        source: string;
      }>;
    };
    expect(payload.document).not.toBeNull();
    expect(payload.document!.default_action).toBe("deny");
    // One agent: three blanket actions plus the one declared target.
    expect(payload.decisions).toHaveLength(4);
    const write = payload.decisions.find((d) => d.action === "write" && d.target === "")!;
    expect(write.verdict).toBe("allow");
    expect(write.source).toBe("agent:codex");
    const scoped = payload.decisions.find((d) => d.target === "notes/foo.md")!;
    expect(scoped.source).toBe("entry:freeze-notes");
    expect(scoped.verdict).toBe("deny");
  });

  test("a corrupt document fails with the field-named error", async () => {
    writeDoc("version: 1\n");
    const result = await runCli(["brain", "permissions", "show", "--vault", vault]);
    expect(result.returncode).not.toBe(0);
    const said = `${result.stdout}${result.stderr}`;
    expect(said).toContain("default_action");
    expect(said).toContain("_permissions.yaml");
  });
});

describe("brain permissions ledger", () => {
  test("an empty vault reports no rows", async () => {
    const result = await runCli(["brain", "permissions", "ledger", "--vault", vault]);
    expect(result.returncode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no decision ledger rows");
  });

  test("rows list in deterministic order and filters narrow them", async () => {
    appendDecisionLedger(vault, {
      ts: "2026-10-10T10:00:00Z",
      actor: "codex",
      via: "token",
      action: "write",
      target: "notes/foo.md",
      verdict: "deny",
      source: "entry:freeze-notes",
      reason: "target-scoped entry freeze-notes",
    });
    appendDecisionLedger(vault, {
      ts: "2026-10-10T11:00:00Z",
      actor: "gemini",
      via: "token",
      action: "ingest",
      target: "sources/x.pdf",
      verdict: "ask",
      source: "role:reviewer",
      reason: "role mapping",
    });
    const all = await runCli(["brain", "permissions", "ledger", "--vault", vault]);
    expect(all.returncode).toBe(0);
    const codexAt = all.stdout.indexOf("codex");
    const geminiAt = all.stdout.indexOf("gemini");
    expect(codexAt).toBeGreaterThanOrEqual(0);
    expect(geminiAt).toBeGreaterThan(codexAt);

    const filtered = await runCli([
      "brain",
      "permissions",
      "ledger",
      "--vault",
      vault,
      "--actor",
      "gemini",
    ]);
    expect(filtered.stdout).toContain("gemini");
    expect(filtered.stdout).not.toContain("codex");

    const json = await runCli(["brain", "permissions", "ledger", "--vault", vault, "--json"]);
    const payload = JSON.parse(json.stdout) as {
      rows: Array<{ actor: string; verdict: string; source: string }>;
    };
    expect(payload.rows.map((r) => r.actor)).toEqual(["codex", "gemini"]);
    expect(payload.rows[0]!.source).toBe("entry:freeze-notes");
  });
});

describe("the doctor finding", () => {
  test("a corrupt document yields exactly one permissions-unreadable error", async () => {
    writeDoc("version: 1\ndefault_action: maybe\n");
    const result = await runCli(["brain", "doctor", "--vault", vault, "--json"]);
    expect(result.returncode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as {
      errors: Array<{ code: string; message: string }>;
    };
    const findings = payload.errors.filter((e) => e.code === "permissions-unreadable");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("default_action");
  });

  test("a healthy or absent document raises no permissions finding", async () => {
    const absent = await runCli(["brain", "doctor", "--vault", vault, "--json"]);
    const absentPayload = JSON.parse(absent.stdout) as {
      errors: Array<{ code: string }>;
      warnings: Array<{ code: string }>;
    };
    expect(
      [...absentPayload.errors, ...absentPayload.warnings].filter(
        (e) => e.code === "permissions-unreadable",
      ),
    ).toEqual([]);

    writeDoc(`${DOCUMENT}\n`);
    const healthy = await runCli(["brain", "doctor", "--vault", vault, "--json"]);
    const healthyPayload = JSON.parse(healthy.stdout) as {
      errors: Array<{ code: string }>;
      warnings: Array<{ code: string }>;
    };
    expect(
      [...healthyPayload.errors, ...healthyPayload.warnings].filter(
        (e) => e.code === "permissions-unreadable",
      ),
    ).toEqual([]);
  });

  test("the finding names its exit: o2b brain permissions show", async () => {
    writeDoc("version: 2\ndefault_action: ask\n");
    const result = await runCli(["brain", "doctor", "--vault", vault]);
    expect(result.returncode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("o2b brain permissions show");
  });
});
