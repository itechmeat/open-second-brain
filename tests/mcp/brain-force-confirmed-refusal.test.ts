/**
 * The force-confirmed rule under a permissions document (write-side
 * trust, Task 12).
 *
 * `force_confirmed: true` skips the dream trial window and writes a
 * confirmed rule directly - the one write in this tool whose whole point
 * is to bypass a review. Under a permissions document that bypass is the
 * operator's to grant, not the caller's: the refusal fires when the
 * caller's `write` verdict is anything but allow, BEFORE any write, and
 * names its token so a client branches on the code instead of the
 * prose. With no document the rule never fires - the document-absent
 * behavior is byte-identically the pre-Task-12 one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { FEEDBACK_TOOLS } from "../../src/mcp/brain/feedback-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const DOC = () => join(vault, "Brain", "_permissions.yaml");

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-force-confirm-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-force-confirm-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const feedback = FEEDBACK_TOOLS.find((t) => t.name === "brain_feedback")!.handler;

const ARGS = {
  topic: "prefer tests",
  signal: "positive",
  principle: "always test first",
  force_confirmed: true,
};

/** Inbox entries this suite's topic wrote (the starter bundle ships one signal). */
function writtenSignals(): string[] {
  const dir = join(vault, "Brain", "inbox");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.includes("prefer-tests")) : [];
}

/** Whether the force-confirmed preference for this suite's topic exists. */
function prefWritten(): boolean {
  const dir = join(vault, "Brain", "preferences");
  return existsSync(dir) && readdirSync(dir).some((n) => n.includes("prefer-tests"));
}

describe("brain_feedback force_confirmed under a permissions document", () => {
  test("a non-allow write verdict refuses with the named token before any write", async () => {
    writeFileSync(DOC(), "version: 1\ndefault_action: ask\n");
    let refused: MCPError | undefined;
    try {
      await feedback(ctx, ARGS);
    } catch (err) {
      refused = err instanceof MCPError ? err : undefined;
    }
    expect(refused).toBeInstanceOf(MCPError);
    expect(refused?.message).toContain("force-confirmed-requires-allow");
    expect((refused?.data as { code?: string } | undefined)?.code).toBe(
      "force-confirmed-requires-allow",
    );
    // Refused BEFORE any write: no signal, no preference, nothing.
    expect(writtenSignals()).toEqual([]);
    expect(prefWritten()).toBe(false);
  });

  test("an allow write verdict lets the force-confirmed write proceed", async () => {
    writeFileSync(
      DOC(),
      ["version: 1", "default_action: deny", "agents:", "  claude:", "    write: allow"].join(
        "\n",
      ) + "\n",
    );
    const res = (await feedback(ctx, ARGS)) as Record<string, unknown>;
    // The force-confirmed preference is the point of the call: the receipt
    // reads as a preference write, not a bare signal.
    expect(res["kind"]).toBe("preference");
    expect(writtenSignals()).toHaveLength(1);
    expect(prefWritten()).toBe(true);
  });

  test("without a document the force-confirmed behavior is unchanged", async () => {
    expect(existsSync(DOC())).toBe(false);
    const res = (await feedback(ctx, ARGS)) as Record<string, unknown>;
    expect(res["kind"]).toBe("preference");
    expect(writtenSignals()).toHaveLength(1);
    expect(prefWritten()).toBe(true);
  });
});
