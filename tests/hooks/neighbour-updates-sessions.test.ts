/**
 * The neighbour-updates hook across sessions (owner check of concurrent
 * agents): several sessions of one agent name on one device (several
 * windows of one host) each write their own records. A session sees what
 * the others wrote, on this device and on another, one line each within
 * the budget, and never what it wrote itself. A record with no session
 * stamp keeps the older rule: same device and agent name is this
 * session's own.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import {
  injected,
  LOCAL_DEVICE,
  NEIGHBOUR_AGENT,
  neighbourHarness,
  REMOTE_DEVICE,
} from "../helpers/neighbour-hook.ts";
import {
  SESSION_ENV,
  SESSION_FIELD,
  sessionKey,
  sessionStamp,
  writerSessionKey,
} from "../../src/core/agent-context/session-identity.ts";
import { newUlid } from "../../src/core/store/ulid.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const h = neighbourHarness("osb-neighbour-sessions-");

const stamped = (session: string): { extra: Record<string, unknown> } => ({
  extra: { [SESSION_FIELD]: sessionKey(session) },
});

const updateLines = (context: string | null): string[] =>
  (context ?? "").split("\n").filter((line) => line.startsWith("- "));

describe("one stamp rule for the writer and the hook", () => {
  test("with the launcher's name and the host's id both set and different, both sides take the launcher's", () => {
    const env = { [SESSION_ENV]: "launcher-name", CLAUDE_CODE_SESSION_ID: "host-id" };
    const writer = writerSessionKey({ env, harness: "claude-code" });
    expect(writer).toBe(sessionKey("launcher-name"));
    expect(sessionStamp({ env, hostSessionId: "host-id" })).toBe(writer);
    // Without the launcher's name both sides fall back to the host's id.
    const bare = { CLAUDE_CODE_SESSION_ID: "host-id" };
    expect(writerSessionKey({ env: bare, harness: "claude-code" })).toBe(sessionKey("host-id"));
    expect(sessionStamp({ env: bare, hostSessionId: "host-id" })).toBe(sessionKey("host-id"));
  });

  test("the hook with the launcher's name set drops what its writer stamped under that name", async () => {
    const launcher = { [SESSION_ENV]: "launcher-name" };
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the first own decision", stamped("launcher-name"));
    await h.reindex();
    await h.runHook(h.payload("Shared topic work.", "s1"), launcher);
    // The writer of this session, given the same environment, stamps the
    // launcher's name, not the payload's id.
    h.decision(LOCAL_DEVICE, topic, "a later own decision", stamped("launcher-name"));
    h.decision(LOCAL_DEVICE, topic, "a decision stamped with the host id", stamped("s1"));
    await h.reindex();
    const second = await h.runHook(h.payload("Shared topic work.", "s1"), launcher);
    const context = injected(second.stdout) ?? "";
    expect(context).not.toContain("a later own decision");
    expect(context).toContain("a decision stamped with the host id");
  });
});

describe("neighbour updates across sessions of one agent name", () => {
  test("another session of this agent on this device is a neighbour; this session's own record is not", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the first own decision", stamped("s1"));
    await h.reindex();
    const first = await h.runHook(h.payload("Shared topic work.", "s1"));
    expect(first.stdout).toBe("");
    h.decision(LOCAL_DEVICE, topic, "a decision of the sibling window", stamped("s2"));
    h.decision(LOCAL_DEVICE, topic, "a later own decision", stamped("s1"));
    await h.reindex();
    const second = await h.runHook(h.payload("Shared topic work.", "s1"));
    expect(second.exit).toBe(0);
    const context = injected(second.stdout);
    expect(context).toContain("a decision of the sibling window");
    expect(context).not.toContain("a later own decision");
    expect(context).not.toContain("the first own decision");
  });

  test("an unstamped record of this device and agent stays this session's own", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the first own decision", stamped("s1"));
    await h.reindex();
    await h.runHook(h.payload("Shared topic work.", "s1"));
    h.decision(LOCAL_DEVICE, topic, "an unstamped decision of this agent");
    await h.reindex();
    const second = await h.runHook(h.payload("Shared topic work.", "s1"));
    expect(second.exit).toBe(0);
    expect(second.stdout).toBe("");
  });

  test("three sessions of one agent name on another device: each decision is one line", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the first own decision", stamped("s1"));
    await h.reindex();
    await h.runHook(h.payload("Shared topic work.", "s1"));
    for (const name of ["r1", "r2", "r3"]) {
      h.decision(REMOTE_DEVICE, topic, `decision of window ${name}`, {
        agent: NEIGHBOUR_AGENT,
        ...stamped(name),
      });
    }
    await h.reindex();
    const second = await h.runHook(h.payload("Shared topic work.", "s1"));
    const lines = updateLines(injected(second.stdout));
    expect(lines).toHaveLength(3);
    for (const name of ["r1", "r2", "r3"]) {
      expect(lines.some((line) => line.includes(`decision of window ${name}`))).toBe(true);
    }
  });

  test.each([3, 5])(
    "%i decisions of 200 characters are all shown, their texts cut to share the characters",
    async (count) => {
      const topic = newUlid(h.clock());
      h.decision(LOCAL_DEVICE, topic, "the first own decision", stamped("s1"));
      await h.reindex();
      await h.runHook(h.payload("Shared topic work.", "s1"));
      const names = Array.from({ length: count }, (_, i) => `r${i + 1}`);
      for (const name of names) {
        h.decision(
          REMOTE_DEVICE,
          topic,
          `window ${name}: ${"long reasoning ".repeat(20)}`.slice(0, 200),
          {
            agent: NEIGHBOUR_AGENT,
            ...stamped(name),
          },
        );
      }
      await h.reindex();
      const second = await h.runHook(h.payload("Shared topic work.", "s1"));
      const context = injected(second.stdout) ?? "";
      const lines = updateLines(context);
      expect(lines).toHaveLength(count);
      for (const name of names) {
        expect(lines.some((line) => line.includes(`window ${name}: `))).toBe(true);
      }
      expect(lines.every((line) => line.endsWith("\u2026"))).toBe(true);
      expect(context).not.toContain("more neighbour update");
      // The call that opens the topic is said once, not per line.
      expect(context.split(`topic ${topic}):`)).toHaveLength(2);
    },
  );

  test("eight decisions of 200 characters: five lines and the cut line naming three", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the first own decision", stamped("s1"));
    await h.reindex();
    await h.runHook(h.payload("Shared topic work.", "s1"));
    for (let i = 1; i <= 8; i++) {
      h.decision(
        REMOTE_DEVICE,
        topic,
        `window r${i}: ${"long reasoning ".repeat(20)}`.slice(0, 200),
        {
          agent: NEIGHBOUR_AGENT,
          ...stamped(`r${i}`),
        },
      );
    }
    await h.reindex();
    const second = await h.runHook(h.payload("Shared topic work.", "s1"));
    const context = injected(second.stdout) ?? "";
    expect(updateLines(context)).toHaveLength(5);
    expect(context).toContain("_3 more neighbour updates are not shown.");
  });
});
