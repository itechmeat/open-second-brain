/**
 * The MCP half of expiration (unit 3c / t_5e338af1): `expires` on
 * `brain_feedback` and the `brain_expire` tool beside it.
 *
 * The core owns the mutation semantics
 * (`tests/core/brain/expiration-set.test.ts`); what belongs here is the
 * tool surface's own share - that the argument reaches the writer, that a
 * bad date is the CALLER's fault with a typed code rather than an
 * internal fault, and that the response distinguishes a change from a
 * no-op.
 *
 * Claims pinned here:
 *
 *  1. `brain_feedback` with `expires` stamps the signal and the
 *     force-confirmed preference with the same normalised date.
 *  2. An unparseable `expires` refuses the whole call before any signal is
 *     written - not a signal followed by a failure on the preference.
 *  3. `brain_expire` sets, changes and clears by id, reporting both sides
 *     of the change.
 *  4. A junk date, an unknown id, and an id shape this surface cannot
 *     address are each INVALID_PARAMS carrying their own code.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { FEEDBACK_TOOLS } from "../../src/mcp/brain/feedback-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let vault: string;
let ctx: ServerContext;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-expire-"));
  vault = join(tmp, "vault");
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const feedbackTool = FEEDBACK_TOOLS.find((t) => t.name === "brain_feedback")!;
const expireTool = FEEDBACK_TOOLS.find((t) => t.name === "brain_expire")!;

async function feedback(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await feedbackTool.handler(ctx, {
    topic: "staging-endpoint",
    signal: "positive",
    principle: "Use the staging endpoint.",
    ...args,
  })) as Record<string, unknown>;
}

async function expire(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await expireTool.handler(ctx, args)) as Record<string, unknown>;
}

describe("brain_feedback expires", () => {
  test("stamps the signal and the force-confirmed preference", async () => {
    const res = await feedback({ expires: "2026-07-15", force_confirmed: true });
    const signalId = res["signal_id"] as string;
    const prefId = res["preference_id"] as string;
    expect(readFileSync(join(vault, "Brain/inbox", `${signalId}.md`), "utf8")).toContain(
      "expiration_date: 2026-07-15",
    );
    expect(readFileSync(join(vault, "Brain/preferences", `${prefId}.md`), "utf8")).toContain(
      "expiration_date: 2026-07-15",
    );
  });

  test("an unparseable expires refuses before anything is written", async () => {
    let caught: unknown;
    try {
      await feedback({ expires: "next tuesday" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPError);
    expect((caught as MCPError).message).toContain("expiration_date");
    expect(readdirSync(join(vault, "Brain/inbox")).filter((n) => n.endsWith(".md"))).toHaveLength(
      0,
    );
  });
});

/** Assert one refusal reaches the caller as INVALID_PARAMS with its code. */
async function expectRefusal(args: Record<string, unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await expire(args);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(MCPError);
  expect((caught as MCPError).data).toMatchObject({ code });
}

describe("brain_expire", () => {
  test("sets, changes and clears by id, reporting both sides", async () => {
    const signalId = (await feedback({}))["signal_id"] as string;

    const set = await expire({ id: signalId, expires: "2026-07-15" });
    expect(set["kind"]).toBe("signal");
    expect(set["expiration"]).toBe("2026-07-15");
    expect(set["previous"]).toBeNull();
    expect(set["changed"]).toBe(true);

    const moved = await expire({ id: signalId, expires: "2026-09-01" });
    expect(moved["previous"]).toBe("2026-07-15");
    expect(moved["expiration"]).toBe("2026-09-01");

    const cleared = await expire({ id: signalId, expires: "none" });
    expect(cleared["expiration"]).toBeNull();
    expect(cleared["previous"]).toBe("2026-09-01");
    expect(readFileSync(join(vault, "Brain/inbox", `${signalId}.md`), "utf8")).not.toContain(
      "expiration_date",
    );
  });

  test("re-setting the same date is reported as unchanged, not as a write", async () => {
    const signalId = (await feedback({}))["signal_id"] as string;
    await expire({ id: signalId, expires: "2026-07-15" });
    const again = await expire({ id: signalId, expires: "2026-07-15" });
    expect(again["changed"]).toBe(false);
  });

  test("a junk date, an unknown id and an unaddressable shape each carry a code", async () => {
    const signalId = (await feedback({}))["signal_id"] as string;
    await expectRefusal({ id: signalId, expires: "soon" }, "ExpirationValueError");
    await expectRefusal(
      { id: "pref-nobody-home", expires: "2026-07-15" },
      "ExpirationTargetNotFoundError",
    );
    await expectRefusal(
      { id: "Projects/Note.md", expires: "2026-07-15" },
      "InvalidExpirationTargetError",
    );
    // The artifact is untouched by any of them.
    expect(existsSync(join(vault, "Brain/inbox", `${signalId}.md`))).toBe(true);
    expect(readFileSync(join(vault, "Brain/inbox", `${signalId}.md`), "utf8")).not.toContain(
      "expiration_date",
    );
  });
});
