import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BEGIN_MARKER,
  DEFAULT_END_MARKER,
} from "../../../src/core/install/managed-block.ts";

import {
  AGENT_INSTRUCTION_FILES,
  WRITEBACK_CONTRACT_FINDING,
  WRITEBACK_CONTRACT_REQUIREMENTS,
  WRITEBACK_CONTRACT_RECOVERY,
  auditWorkspaceWritebackContract,
  auditWritebackContractFile,
  locateAgentInstructionFiles,
  missingWritebackGateClauses,
} from "../../../src/core/brain/writeback-contract.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-writeback-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A managed block whose body carries every contract clause. */
const CONFORMING_BLOCK = [
  "# >>> open-second-brain managed >>>",
  "Memory write gate: write every durable fact you learn to the Open Second",
  "Brain in the same turn, as an atomic fact, through the note tools;",
  "@osb set mutations require guardrails.marker_writeback in _brain.yaml.",
  "# <<< open-second-brain managed <<<",
].join("\n");

describe("missingWritebackGateClauses", () => {
  test("a body carrying every clause has no missing clauses", () => {
    expect(missingWritebackGateClauses(CONFORMING_BLOCK)).toEqual([]);
  });

  test("the clause patterns tolerate hyphen, spacing and case variants", () => {
    expect(missingWritebackGateClauses("Same-Turn writes; ATOMIC FACTS; marker_writeback")).toEqual(
      [],
    );
    expect(missingWritebackGateClauses("same\tturn; atomic\nfact; marker_writeback")).toEqual([]);
  });

  test("a body missing clauses names exactly the failing requirements", () => {
    const missing = missingWritebackGateClauses("only mentions marker_writeback");
    expect(missing).toEqual([
      WRITEBACK_CONTRACT_REQUIREMENTS[1]!.label,
      WRITEBACK_CONTRACT_REQUIREMENTS[2]!.label,
    ]);
  });

  test("the guardrail clause is keyed on the runtime's own flag name", () => {
    // A block that paraphrases the guardrail without naming it does not
    // pass: check and runtime refuse in the same words.
    expect(missingWritebackGateClauses("same turn atomic fact write-back guardrail")).toContain(
      WRITEBACK_CONTRACT_REQUIREMENTS[0]!.label,
    );
  });
});

describe("auditWritebackContractFile", () => {
  test("a file with a conforming block passes, naming file and gate", () => {
    const path = join(tmp, "AGENTS.md");
    writeFileSync(path, `# Workspace\n\n${CONFORMING_BLOCK}\n`);
    const audit = auditWritebackContractFile(path);
    expect(audit.finding).toBe(WRITEBACK_CONTRACT_FINDING.conforming);
    expect(audit.missing).toEqual([]);
    expect(audit.detail).toContain(path);
    expect(audit.detail).toContain("atomic-fact");
  });

  test("a file without the block names it as not installed, with the recovery line", () => {
    const path = join(tmp, "AGENTS.md");
    writeFileSync(path, "# Workspace\n\nplain instructions, no managed block\n");
    const audit = auditWritebackContractFile(path);
    expect(audit.finding).toBe(WRITEBACK_CONTRACT_FINDING.missingBlock);
    expect(audit.detail).toContain(path);
    expect(audit.detail).toContain("no Open Second Brain managed block");
    expect(audit.detail).toContain("not installed");
    expect(audit.detail).toContain(WRITEBACK_CONTRACT_RECOVERY);
  });

  test("a lone marker is a broken block, not a missing one", () => {
    const path = join(tmp, "AGENTS.md");
    writeFileSync(path, `# Workspace\n\n${DEFAULT_BEGIN_MARKER}\nhalf a block\n`);
    const audit = auditWritebackContractFile(path);
    expect(audit.finding).toBe(WRITEBACK_CONTRACT_FINDING.malformedBlock);
    expect(audit.detail).toContain(path);
    expect(audit.detail).toContain(WRITEBACK_CONTRACT_RECOVERY);
  });

  test("the recovery line names the surface and the markers, never a board id", () => {
    expect(WRITEBACK_CONTRACT_RECOVERY).toContain("ambient write-back managed block");
    expect(WRITEBACK_CONTRACT_RECOVERY).toContain(DEFAULT_BEGIN_MARKER);
    expect(WRITEBACK_CONTRACT_RECOVERY).toContain(DEFAULT_END_MARKER);
    expect(WRITEBACK_CONTRACT_RECOVERY).not.toMatch(/\bt_[0-9a-f]{8}\b/);
  });

  test("a block present but without the gate clauses fails naming the pieces", () => {
    const path = join(tmp, "AGENTS.md");
    writeFileSync(
      path,
      [
        "# >>> open-second-brain managed >>>",
        "use the open-second-brain note tools",
        "# <<< open-second-brain managed <<<",
      ].join("\n"),
    );
    const audit = auditWritebackContractFile(path);
    expect(audit.finding).toBe(WRITEBACK_CONTRACT_FINDING.missingClauses);
    expect(audit.missing.length).toBe(WRITEBACK_CONTRACT_REQUIREMENTS.length);
    expect(audit.detail).toContain(WRITEBACK_CONTRACT_REQUIREMENTS[0]!.label);
    expect(audit.detail).toContain(WRITEBACK_CONTRACT_RECOVERY);
  });

  test("an absent file is a named absent verdict, not an error", () => {
    const audit = auditWritebackContractFile(join(tmp, "AGENTS.md"));
    expect(audit.finding).toBe(WRITEBACK_CONTRACT_FINDING.absent);
    expect(audit.detail).toContain("AGENTS.md");
    expect(audit.detail.length).toBeGreaterThan(0);
  });

  test("a symlink is refused without reading through it", () => {
    const real = join(tmp, "real-instructions.md");
    // The real file has NO managed block: if the audit followed the link
    // it would report missing-block; refusing reports the symlink itself.
    writeFileSync(real, "no block here\n");
    const link = join(tmp, "AGENTS.md");
    symlinkSync(real, link);
    const audit = auditWritebackContractFile(link);
    expect(audit.finding).toBe(WRITEBACK_CONTRACT_FINDING.symlink);
    expect(audit.detail).toContain("symbolic link");
    expect(audit.finding).not.toBe(WRITEBACK_CONTRACT_FINDING.missingBlock);
  });

  test("a path that exists but cannot be read as a file is unreadable with the reason", () => {
    const dir = join(tmp, "AGENTS.md");
    mkdirSync(dir);
    const audit = auditWritebackContractFile(dir);
    expect(audit.finding).toBe(WRITEBACK_CONTRACT_FINDING.unreadable);
    expect(audit.detail).toContain(dir);
    expect(audit.detail.length).toBeGreaterThan(dir.length);
  });
});

describe("workspace audit", () => {
  test("AGENTS.md leads the candidate list, then the tracked peers", () => {
    expect(AGENT_INSTRUCTION_FILES[0]).toBe("AGENTS.md");
    expect(AGENT_INSTRUCTION_FILES).toContain("CLAUDE.md");
    expect(AGENT_INSTRUCTION_FILES).toContain("GEMINI.md");
    const paths = locateAgentInstructionFiles(tmp);
    expect(paths).toEqual(AGENT_INSTRUCTION_FILES.map((name) => join(tmp, name)));
  });

  test("every candidate is audited in priority order", () => {
    writeFileSync(join(tmp, "AGENTS.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    writeFileSync(join(tmp, "CLAUDE.md"), "no block\n");
    const audits = auditWorkspaceWritebackContract(tmp);
    expect(audits.map((a) => a.finding)).toEqual([
      WRITEBACK_CONTRACT_FINDING.conforming,
      WRITEBACK_CONTRACT_FINDING.missingBlock,
      WRITEBACK_CONTRACT_FINDING.absent,
    ]);
  });

  test("an empty workspace reports every candidate absent", () => {
    const audits = auditWorkspaceWritebackContract(tmp);
    expect(audits.length).toBe(AGENT_INSTRUCTION_FILES.length);
    for (const audit of audits) {
      expect(audit.finding).toBe(WRITEBACK_CONTRACT_FINDING.absent);
    }
  });
});
