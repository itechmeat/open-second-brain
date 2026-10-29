import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BEGIN_MARKER,
  DEFAULT_END_MARKER,
} from "../../../src/core/install/managed-block.ts";

import {
  AGENT_INSTRUCTION_FILES,
  HOST_INSTRUCTION_PRECEDENCE,
  WRITEBACK_CONTRACT_FINDING,
  WRITEBACK_CONTRACT_REQUIREMENTS,
  WRITEBACK_CONTRACT_RECOVERY,
  auditWorkspaceWritebackContract,
  auditWritebackContractFile,
  locateAgentInstructionFiles,
  missingWritebackGateClauses,
  referencedImportBasenames,
  resolveShadowedInstructionContracts,
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

  test("a read file records the basenames its @import lines reference", () => {
    // Claude Code's memory-import syntax: a line starting with `@` followed
    // by a path. The audit only records what it matched - the referenced
    // basenames - and the shadow resolver compares those against the
    // contract file's basename.
    const path = join(tmp, "CLAUDE.md");
    writeFileSync(path, ["# Claude", "", "@AGENTS.md", "", "@GEMINI.md"].join("\n"));
    const audit = auditWritebackContractFile(path);
    expect(audit.finding).toBe(WRITEBACK_CONTRACT_FINDING.missingBlock);
    expect([...audit.imports]).toEqual(["AGENTS.md", "GEMINI.md"]);
  });

  test("a file with no @import line records an empty imports list", () => {
    const path = join(tmp, "CLAUDE.md");
    writeFileSync(path, "# Claude\n\nplain instructions\n");
    const audit = auditWritebackContractFile(path);
    expect([...audit.imports]).toEqual([]);
  });

  test("refused reads carry no imports: absent, symlink", () => {
    const real = join(tmp, "real.md");
    writeFileSync(real, "@AGENTS.md\n");
    const link = join(tmp, "CLAUDE.md");
    symlinkSync(real, link);
    expect([...auditWritebackContractFile(link).imports]).toEqual([]);
    expect([...auditWritebackContractFile(join(tmp, "GEMINI.md")).imports]).toEqual([]);
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

describe("HOST_INSTRUCTION_PRECEDENCE", () => {
  test("keys each host family on the instruction file it reads at the workspace root", () => {
    expect(HOST_INSTRUCTION_PRECEDENCE["claude-code"]).toEqual(["CLAUDE.md"]);
    expect(HOST_INSTRUCTION_PRECEDENCE.codex).toEqual(["AGENTS.md"]);
    expect(HOST_INSTRUCTION_PRECEDENCE.cursor).toEqual(["AGENTS.md"]);
    expect(HOST_INSTRUCTION_PRECEDENCE.opencode).toEqual(["AGENTS.md"]);
    expect(HOST_INSTRUCTION_PRECEDENCE.aider).toEqual(["AGENTS.md"]);
    expect(HOST_INSTRUCTION_PRECEDENCE["gemini-cli"]).toEqual(["GEMINI.md"]);
  });

  test("the table and every per-host list are frozen", () => {
    expect(Object.isFrozen(HOST_INSTRUCTION_PRECEDENCE)).toBe(true);
    for (const files of Object.values(HOST_INSTRUCTION_PRECEDENCE)) {
      expect(Object.isFrozen(files)).toBe(true);
    }
  });
});

describe("referencedImportBasenames", () => {
  /**
   * The Claude Code memory-import facts this tree implements, recorded
   * where the matcher lives: a line whose FIRST character is `@`,
   * immediately followed by a basename-shaped token that ends at
   * whitespace or end of line. Anything looser is not matched, because a
   * lookalike that suppressed a shadow would hide a live gate.
   */
  test("a line-start @ followed by a basename records that basename", () => {
    expect([...referencedImportBasenames("@AGENTS.md\n")]).toEqual(["AGENTS.md"]);
    expect([...referencedImportBasenames("@AGENTS.md trailing prose\n")]).toEqual(["AGENTS.md"]);
    expect([...referencedImportBasenames("# header\n\n@CLAUDE.md\nbody\n")]).toEqual(["CLAUDE.md"]);
  });

  test("CRLF line endings are normalized before the match", () => {
    expect([...referencedImportBasenames("@AGENTS.md\r\nnext\r\n")]).toEqual(["AGENTS.md"]);
  });

  test("mid-line mentions, doubled sigils and prefixed paths are not imports", () => {
    expect([...referencedImportBasenames("see @AGENTS.md for details\n")]).toEqual([]);
    expect([...referencedImportBasenames("email me at me@example.com @AGENTS.md\n")]).toEqual([]);
    expect([...referencedImportBasenames("@@AGENTS.md\n")]).toEqual([]);
    expect([...referencedImportBasenames(" @AGENTS.md\n")]).toEqual([]);
    expect([...referencedImportBasenames("@docs/AGENTS.md\n")]).toEqual([]);
  });

  test("a token that only looks like the basename is recorded verbatim, never truncated", () => {
    expect([...referencedImportBasenames("@AGENTS.md.bak\n")]).toEqual(["AGENTS.md.bak"]);
    expect([...referencedImportBasenames("@AGENTS.MD\n")]).toEqual(["AGENTS.MD"]);
  });

  test("the same basename twice is recorded once, in first-appearance order", () => {
    expect([...referencedImportBasenames("@AGENTS.md\n\n@AGENTS.md\n@GEMINI.md\n")]).toEqual([
      "AGENTS.md",
      "GEMINI.md",
    ]);
  });
});

describe("resolveShadowedInstructionContracts", () => {
  /**
   * The resolver is pure over the workspace audit rows: these tests drive
   * it through `auditWorkspaceWritebackContract` on real temp files and,
   * for the purity case, through synthetic audits of paths that exist
   * nowhere on disk.
   */

  test("a bare CLAUDE.md beside a conforming AGENTS.md shadows claude-code, naming both paths", () => {
    const claude = join(tmp, "CLAUDE.md");
    writeFileSync(claude, "# Claude\n\nplain instructions, no managed block\n");
    const agents = join(tmp, "AGENTS.md");
    writeFileSync(agents, `# W\n\n${CONFORMING_BLOCK}\n`);
    const shadows = resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp));
    expect(shadows).toEqual([{ host: "claude-code", readsPath: claude, contractPath: agents }]);
  });

  test("a block in any carried state shadows: conforming, malformed and clause-incomplete", () => {
    const claude = join(tmp, "CLAUDE.md");
    writeFileSync(claude, "plain\n");
    const agents = join(tmp, "AGENTS.md");
    writeFileSync(
      agents,
      [
        "# >>> open-second-brain managed >>>",
        "use the open-second-brain note tools",
        "# <<< open-second-brain managed <<<",
      ].join("\n"),
    );
    const clauseIncomplete = resolveShadowedInstructionContracts(
      auditWorkspaceWritebackContract(tmp),
    );
    expect(clauseIncomplete.map((s) => s.host)).toEqual(["claude-code"]);
    expect(clauseIncomplete[0]).toEqual({
      host: "claude-code",
      readsPath: claude,
      contractPath: agents,
    });

    writeFileSync(agents, `${DEFAULT_BEGIN_MARKER}\nhalf a block\n`);
    const malformed = resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp));
    expect(malformed.map((s) => s.host)).toEqual(["claude-code"]);
    expect(malformed[0]!.contractPath).toBe(agents);
  });

  test("GEMINI.md-only and AGENTS.md-only workspaces yield no shadow", () => {
    writeFileSync(join(tmp, "GEMINI.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    expect(resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp))).toEqual([]);

    rmSync(join(tmp, "GEMINI.md"));
    writeFileSync(join(tmp, "AGENTS.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    expect(resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp))).toEqual([]);

    // And a bare AGENTS.md alone: nothing carries the block to shadow with.
    writeFileSync(join(tmp, "AGENTS.md"), "plain\n");
    expect(resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp))).toEqual([]);
  });

  test("a workspace whose every existing file carries the block yields no shadow", () => {
    writeFileSync(join(tmp, "AGENTS.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    writeFileSync(join(tmp, "CLAUDE.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    expect(resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp))).toEqual([]);
  });

  test("shadowing is host-symmetric: a bare AGENTS.md shadows the agents.md family, not claude-code", () => {
    writeFileSync(join(tmp, "CLAUDE.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    writeFileSync(join(tmp, "AGENTS.md"), "plain\n");
    const shadows = resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp));
    expect(shadows.map((s) => s.host)).toEqual(["codex", "cursor", "opencode", "aider"]);
    expect(shadows.every((s) => s.readsPath === join(tmp, "AGENTS.md"))).toBe(true);
    expect(shadows.every((s) => s.contractPath === join(tmp, "CLAUDE.md"))).toBe(true);
  });

  test("several hosts can be shadowed at once, in table order", () => {
    writeFileSync(join(tmp, "CLAUDE.md"), "plain\n");
    writeFileSync(join(tmp, "GEMINI.md"), "plain\n");
    writeFileSync(join(tmp, "AGENTS.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    const shadows = resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp));
    expect(shadows.map((s) => s.host)).toEqual(["claude-code", "gemini-cli"]);
    expect(shadows[0]).toEqual({
      host: "claude-code",
      readsPath: join(tmp, "CLAUDE.md"),
      contractPath: join(tmp, "AGENTS.md"),
    });
    expect(shadows[1]).toEqual({
      host: "gemini-cli",
      readsPath: join(tmp, "GEMINI.md"),
      contractPath: join(tmp, "AGENTS.md"),
    });
  });

  test("absent-only workspaces yield nothing", () => {
    expect(resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp))).toEqual([]);
  });

  test("a symlink candidate is refused evidence: never read, never a shadow side", () => {
    const real = join(tmp, "real-agents.md");
    writeFileSync(real, `# W\n\n${CONFORMING_BLOCK}\n`);
    symlinkSync(real, join(tmp, "AGENTS.md"));
    writeFileSync(join(tmp, "CLAUDE.md"), "plain\n");
    const shadows = resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp));
    expect(shadows).toEqual([]);
  });

  test("the resolver is pure: synthetic audits of paths that exist nowhere still resolve", () => {
    const synthetic = [
      {
        path: "/nowhere/o2b-purity/AGENTS.md",
        finding: WRITEBACK_CONTRACT_FINDING.conforming,
        detail: "synthetic",
        missing: [],
        imports: [],
      },
      {
        path: "/nowhere/o2b-purity/CLAUDE.md",
        finding: WRITEBACK_CONTRACT_FINDING.missingBlock,
        detail: "synthetic",
        missing: [],
        imports: [],
      },
      {
        path: "/nowhere/o2b-purity/GEMINI.md",
        finding: WRITEBACK_CONTRACT_FINDING.absent,
        detail: "synthetic",
        missing: [],
        imports: [],
      },
    ];
    const shadows = resolveShadowedInstructionContracts(synthetic);
    expect(shadows).toEqual([
      {
        host: "claude-code",
        readsPath: "/nowhere/o2b-purity/CLAUDE.md",
        contractPath: "/nowhere/o2b-purity/AGENTS.md",
      },
    ]);
    // The resolver ran entirely on the given data: it created nothing and
    // never touched the filesystem its input paths name.
    expect(existsSync("/nowhere")).toBe(false);
  });

  test("a CLAUDE.md that only imports the conforming AGENTS.md is not shadowed", () => {
    // The common real setup: Claude Code's import syntax renders the
    // imported file - managed block included - into the surface the host
    // reads, so the contract is NOT shadowed away and the readiness gate
    // must stay green.
    const claude = join(tmp, "CLAUDE.md");
    writeFileSync(claude, "# Claude\n\n@AGENTS.md\n");
    const agents = join(tmp, "AGENTS.md");
    writeFileSync(agents, `# W\n\n${CONFORMING_BLOCK}\n`);
    expect(resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp))).toEqual([]);
  });

  test("an import only excuses the file it names: a bare CLAUDE.md is still shadowed", () => {
    // The same workspace as above minus the import line: the shadow is
    // exactly what the gate exists to report.
    const claude = join(tmp, "CLAUDE.md");
    writeFileSync(claude, "# Claude\n\nplain instructions, no managed block\n");
    const agents = join(tmp, "AGENTS.md");
    writeFileSync(agents, `# W\n\n${CONFORMING_BLOCK}\n`);
    expect(
      resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp)).map((s) => s.host),
    ).toEqual(["claude-code"]);
  });

  test("malformed import lookalikes do not suppress the shadow", () => {
    const lookalikes = [
      "see @AGENTS.md for details\n", // mid-line mention
      "@@AGENTS.md\n", // doubled sigil
      " @AGENTS.md\n", // not at line start
      "@docs/AGENTS.md\n", // a path the token grammar cannot name
      "@AGENTS.md.bak\n", // a different file
    ];
    for (const body of lookalikes) {
      writeFileSync(join(tmp, "CLAUDE.md"), body);
      writeFileSync(join(tmp, "AGENTS.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
      const shadows = resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp));
      expect(
        shadows.map((s) => s.host),
        body,
      ).toEqual(["claude-code"]);
    }
  });

  test("an import excuses only the named contract file, not every candidate", () => {
    // CLAUDE.md imports GEMINI.md, but the contract lives in AGENTS.md:
    // the host still never sees the block, so the shadow stands.
    writeFileSync(join(tmp, "CLAUDE.md"), "@GEMINI.md\n");
    writeFileSync(join(tmp, "AGENTS.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    expect(
      resolveShadowedInstructionContracts(auditWorkspaceWritebackContract(tmp)).map((s) => s.host),
    ).toEqual(["claude-code"]);
  });
});
