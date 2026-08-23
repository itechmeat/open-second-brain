/**
 * Unit C — the server-derived origin channel, at its resolver.
 *
 * Claims pinned here:
 *  1. The vocabulary is closed at three members and spelled exactly
 *     `mcp-tool` / `cli` / `import`; `ORIGIN_CHANNELS` is that list.
 *  2. A value outside the vocabulary is refused at the setter, by name,
 *     so a bad channel can never be claimed for a process.
 *  3. Reading the channel before any entry point claimed it FAILS LOUD:
 *     `resolveOriginChannel` throws and the message names the function
 *     and the entry points that are supposed to have called the setter.
 *  4. The record-writer read never throws and never guesses: it returns
 *     the explicit `unset` literal, which serializes as `unset`.
 *  5. `unset` is not a member of the channel vocabulary — a reader can
 *     tell "no entry point claimed this process" from every real answer.
 *  6. A claim is readable by both accessors; `clearOriginChannel` puts
 *     the process back to unclaimed (entry-point re-entry / test
 *     isolation).
 *  7. Re-claiming is allowed and last-claim-wins: one process can re-enter
 *     the entry point (the CLI test harness calls `main()` many times).
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  ORIGIN_CHANNEL,
  ORIGIN_CHANNEL_UNSET,
  ORIGIN_CHANNELS,
  OriginChannelUnsetError,
  clearOriginChannel,
  isOriginChannel,
  originChannelStamp,
  resolveOriginChannel,
  setOriginChannel,
} from "../../src/core/origin-channel.ts";

afterEach(() => {
  clearOriginChannel();
});

describe("the origin-channel vocabulary", () => {
  test("is closed at three members with exact spellings", () => {
    expect([...ORIGIN_CHANNELS]).toEqual(["mcp-tool", "cli", "import"]);
    expect(ORIGIN_CHANNEL.mcpTool).toBe("mcp-tool");
    expect(ORIGIN_CHANNEL.cli).toBe("cli");
    expect(ORIGIN_CHANNEL.import).toBe("import");
  });

  test("`unset` is outside it, so absence of a claim is distinguishable", () => {
    expect(ORIGIN_CHANNEL_UNSET).toBe("unset");
    expect(isOriginChannel(ORIGIN_CHANNEL_UNSET)).toBe(false);
    expect(ORIGIN_CHANNELS).not.toContain(ORIGIN_CHANNEL_UNSET as never);
  });

  test("refuses a value outside the vocabulary at the setter, naming it", () => {
    expect(() => setOriginChannel("http" as never)).toThrow(/"http"/);
    expect(() => setOriginChannel("http" as never)).toThrow(/mcp-tool, cli, import/);
    // The refusal left the process unclaimed rather than half-claimed.
    expect(originChannelStamp()).toBe(ORIGIN_CHANNEL_UNSET);
  });
});

describe("reading before any entry point claimed the process", () => {
  test("the strict read fails loud and names itself", () => {
    expect(() => resolveOriginChannel()).toThrow(OriginChannelUnsetError);
    expect(() => resolveOriginChannel()).toThrow(/resolveOriginChannel/);
  });

  test("the strict refusal names the entry points that owe the claim", () => {
    let message = "";
    try {
      resolveOriginChannel();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("setOriginChannel");
  });

  test("the record-writer read returns the explicit unset literal instead", () => {
    expect(originChannelStamp()).toBe(ORIGIN_CHANNEL_UNSET);
  });
});

describe("a claimed process", () => {
  test("reports the claim through both accessors", () => {
    setOriginChannel(ORIGIN_CHANNEL.cli);
    expect(resolveOriginChannel()).toBe(ORIGIN_CHANNEL.cli);
    expect(originChannelStamp()).toBe(ORIGIN_CHANNEL.cli);
  });

  test("last claim wins, so a re-entered entry point is not a fault", () => {
    setOriginChannel(ORIGIN_CHANNEL.cli);
    setOriginChannel(ORIGIN_CHANNEL.import);
    expect(resolveOriginChannel()).toBe(ORIGIN_CHANNEL.import);
  });

  test("clearing puts it back to unclaimed", () => {
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    clearOriginChannel();
    expect(originChannelStamp()).toBe(ORIGIN_CHANNEL_UNSET);
    expect(() => resolveOriginChannel()).toThrow(OriginChannelUnsetError);
  });
});
