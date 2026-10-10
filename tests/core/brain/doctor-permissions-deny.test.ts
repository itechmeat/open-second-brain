/**
 * The doctor's `permissions-agent-denied` finding (write-side trust).
 *
 * The design's foot-gun note on `default_action: deny`: an operator who
 * writes a one-agent document denies everything else by construction, and
 * the locally configured agent is usually "everything else". The doctor
 * check resolves the SAME subject the write lanes fall back to -
 * `resolveAgentName` with the same config-path precedence, `via: config`,
 * the blanket `write` action, the resolver's own precedence table - so the
 * finding fires only when a real write from this machine would actually be
 * refused, and stays silent when an agent override or an ask verdict keeps
 * the lane open.
 *
 * Unit-level on purpose: the check is a pure function of the vault's
 * document plus the resolved identity, so the fired and silent cases are
 * pinned here against a hand-built context, exactly the shape
 * `check.ts` keeps valid for tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  permissionsDocumentCheck,
  PERMISSIONS_AGENT_DENIED_CODE,
  PERMISSIONS_UNREADABLE_CODE,
} from "../../../src/core/brain/doctor/permissions-check.ts";
import type { DoctorCheckContext, DoctorFindings } from "../../../src/core/brain/doctor/check.ts";

let vault: string;
let savedAgentName: string | undefined;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-perm-deny-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  savedAgentName = process.env["VAULT_AGENT_NAME"];
  process.env["VAULT_AGENT_NAME"] = "codex";
});

afterEach(() => {
  if (savedAgentName === undefined) delete process.env["VAULT_AGENT_NAME"];
  else process.env["VAULT_AGENT_NAME"] = savedAgentName;
  rmSync(vault, { recursive: true, force: true });
});

function writeDoc(text: string): void {
  writeFileSync(join(vault, "Brain", "_permissions.yaml"), text, "utf8");
}

function context(): DoctorCheckContext {
  return {
    vault,
    now: new Date("2026-06-05T12:00:00Z"),
    config: undefined,
    dbPath: undefined,
    configPath: undefined,
    knownBasenames: new Set(),
    idIndex: new Map(),
    preferences: [],
    logs: [],
  };
}

function run(): DoctorFindings {
  const out: DoctorFindings = { issues: [], uncertain: [] };
  permissionsDocumentCheck.run(context(), out);
  return out;
}

describe("permissionsDocumentCheck - the locally configured agent's write", () => {
  test("a default deny for the local agent fires one warning naming the agent", () => {
    writeDoc("version: 1\ndefault_action: deny\n");
    const { issues } = run();
    const findings = issues.filter((i) => i.code === PERMISSIONS_AGENT_DENIED_CODE);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain('"codex"');
    expect(findings[0]!.message).toContain("o2b brain permissions show");
    expect(findings[0]!.path).toBe(join(vault, "Brain", "_permissions.yaml"));
  });

  test("an agent override out of the deny stays silent", () => {
    writeDoc("version: 1\ndefault_action: deny\nagents:\n  codex:\n    write: allow\n");
    expect(run().issues).toEqual([]);
  });

  test("an ask verdict is not a denial", () => {
    writeDoc("version: 1\ndefault_action: ask\n");
    expect(run().issues).toEqual([]);
  });

  test("a deny aimed at another agent does not name this one", () => {
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze-gemini\n" +
        "    agent: gemini\n    action: write\n    verdict: deny\n",
    );
    expect(run().issues).toEqual([]);
  });

  test("an absent document is the default posture and says nothing", () => {
    expect(run().issues).toEqual([]);
  });

  test("an unreadable document reports only the unreadable finding", () => {
    writeDoc("version: 1\ndefault_action: deny\nagents:\n  codex:\n    write: maybe\n");
    const { issues } = run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(PERMISSIONS_UNREADABLE_CODE);
    expect(issues[0]!.severity).toBe("error");
    expect(issues.map((i) => i.code)).not.toContain(PERMISSIONS_AGENT_DENIED_CODE);
  });
});
