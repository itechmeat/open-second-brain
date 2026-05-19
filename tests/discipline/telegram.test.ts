import { describe, expect, test } from "bun:test";
import { escapeMarkdownV2 } from "../../src/core/discipline/telegram.ts";

describe("escapeMarkdownV2", () => {
  test("escapes the 16 reserved characters", () => {
    const input = "_*[]()~`>#+-=|{}.!\\";
    const out = escapeMarkdownV2(input);
    // Each reserved char becomes \X.
    expect(out).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\");
  });
  test("leaves regular text untouched", () => {
    expect(escapeMarkdownV2("hello world 123")).toBe("hello world 123");
  });
  test("escapes a realistic agent identifier", () => {
    expect(escapeMarkdownV2("@claude-vps-agent")).toBe("@claude\\-vps\\-agent");
  });
});
