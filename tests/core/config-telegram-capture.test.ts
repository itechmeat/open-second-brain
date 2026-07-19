/**
 * Telegram capture config resolvers (Knowledge intake suite, t_f8f5ef6a).
 * Token + chat allowlist resolution, redaction of the token, and the
 * byte-identical default (both absent) when nothing is configured.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  redactMapping,
  resolveTelegramBotToken,
  resolveTelegramCaptureAllowlist,
} from "../../src/core/config.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ALLOWLIST"] as const;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-telegram-config-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function cfg(body: string): string {
  const p = join(tmp, "config.yaml");
  writeFileSync(p, body);
  return p;
}

test("token resolves from config and env, defaulting to null", () => {
  expect(resolveTelegramBotToken(cfg("vault: /x\n"))).toBeNull();
  expect(resolveTelegramBotToken(cfg("telegram_bot_token: abc123\n"))).toBe("abc123");
  process.env["TELEGRAM_BOT_TOKEN"] = "env-token";
  expect(resolveTelegramBotToken(cfg("telegram_bot_token: abc123\n"))).toBe("env-token");
});

test("allowlist parses a comma-separated list, defaulting to empty", () => {
  expect(resolveTelegramCaptureAllowlist(cfg("vault: /x\n"))).toEqual([]);
  expect(
    resolveTelegramCaptureAllowlist(cfg('telegram_chat_allowlist: "100, 200 ,100"\n')),
  ).toEqual(["100", "200"]);
  process.env["TELEGRAM_CHAT_ALLOWLIST"] = "900";
  expect(resolveTelegramCaptureAllowlist(cfg('telegram_chat_allowlist: "100"\n'))).toEqual(["900"]);
});

test("a numeric YAML token value degrades safely and never throws", () => {
  // parseSimpleYaml reads every scalar as a string, so a numeric (or boolean)
  // token becomes its string form; the resolvers only ever call .trim() on a
  // string (or undefined, guarded by ?.), so neither resolver throws.
  expect(() => resolveTelegramBotToken(cfg("telegram_bot_token: 12345\n"))).not.toThrow();
  expect(resolveTelegramBotToken(cfg("telegram_bot_token: 12345\n"))).toBe("12345");
  expect(() =>
    resolveTelegramCaptureAllowlist(cfg("telegram_chat_allowlist: 100\n")),
  ).not.toThrow();
  expect(resolveTelegramCaptureAllowlist(cfg("telegram_chat_allowlist: 100\n"))).toEqual(["100"]);
});

test("redactMapping hides the bot token but keeps the allowlist", () => {
  const out = redactMapping({ telegram_bot_token: "secret", telegram_chat_allowlist: "100" });
  expect(out["telegram_bot_token"]).toBe("[REDACTED]");
  expect(out["telegram_chat_allowlist"]).toBe("100");
});
