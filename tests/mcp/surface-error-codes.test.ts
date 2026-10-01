/**
 * Per-surface error codes at the MCP boundary.
 *
 * The boundary seam can only see a class; the surfaces below know a more
 * precise reason and name it in `error.data.code` from the closed registry
 * in `src/mcp/tool-error-codes.ts`. Every message stays byte-identical to
 * the one it replaced, because agents and the Hermes bridge parse it.
 *
 * Handlers are called directly: the precise code is set at the throw, and
 * the seam keeps a thrower-supplied code untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import { SKILL_TOOLS } from "../../src/mcp/skill-tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";
import { isToolErrorCode } from "../../src/mcp/tool-error-codes.ts";

/** The `MCPError` a call raised; fails the test when it answered instead. */
async function raised(run: () => unknown): Promise<MCPError> {
  let thrown: unknown;
  try {
    await run();
  } catch (exc) {
    thrown = exc;
  }
  expect(thrown).toBeInstanceOf(MCPError);
  return thrown as MCPError;
}

/** The code a raised error carries, checked against the closed registry. */
function codeOf(err: MCPError): string {
  const code = (err.data as { readonly code?: unknown } | undefined)?.code;
  expect(typeof code).toBe("string");
  expect(isToolErrorCode(code)).toBe(true);
  return code as string;
}

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-surface-codes-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ----- skills -----------------------------------------------------------------

function skillCtx(): ServerContext {
  const skillDir = join(tmp, "skills", "demo-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: demo-skill\ndescription: Demonstration skill.\n---\n\n# Demo\n",
  );
  return { vault, configPath: null, repoRoot: tmp };
}

const getSkill = (): ToolDefinition => SKILL_TOOLS.find((t) => t.name === "get_skill")!;

describe("skill errors", () => {
  test("an unknown skill answers unknown_skill", async () => {
    const err = await raised(() => getSkill().handler(skillCtx(), { name: "no-such-skill" }));
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.message).toBe("unknown skill: no-such-skill. Known skills: demo-skill");
    expect(codeOf(err)).toBe("unknown_skill");
  });

  test("a missing skill file answers skill_not_found", async () => {
    const err = await raised(() =>
      getSkill().handler(skillCtx(), { name: "demo-skill", file_path: "missing.md" }),
    );
    expect(err.message).toBe("skill file not found: missing.md");
    expect(codeOf(err)).toBe("skill_not_found");
  });

  test("an escaping skill file path answers skill_invalid_path", async () => {
    const err = await raised(() =>
      getSkill().handler(skillCtx(), { name: "demo-skill", file_path: "../outside.md" }),
    );
    expect(err.message).toBe("skill file path must stay inside the skill directory");
    expect(codeOf(err)).toBe("skill_invalid_path");
  });
});
