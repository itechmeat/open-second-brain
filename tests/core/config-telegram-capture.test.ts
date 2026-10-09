/**
 * Telegram capture config resolvers (Knowledge intake suite, t_f8f5ef6a).
 * Token + chat allowlist resolution, redaction of the token, and the
 * byte-identical default (both absent) when nothing is configured.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setSecret } from "../../src/core/brain/secrets/store.ts";
import { resolveTelegramBotToken, resolveTelegramCaptureAllowlist } from "../../src/core/config.ts";
import { redactConfigMapping } from "../../src/core/egress/guard.ts";
import { SecretReferenceError } from "../../src/core/secret-ref.ts";
import { REDACTION_PLACEHOLDER } from "../../src/core/redactor.ts";
// The entry scripts load the named-secret resolver at startup, which is
// what fills config's resolver port; the `$secret:` cases below need the
// same wiring in this process.
import "../../src/core/secret-resolver.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

let tmp: string;
let custodyVault: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ALLOWLIST"] as const;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-telegram-config-"));
  custodyVault = mkdtempSync(join(tmpdir(), "o2b-telegram-custody-"));
  mkdirSync(join(custodyVault, "Brain"), { recursive: true });
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(custodyVault, { recursive: true, force: true });
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

test("redactConfigMapping hides the bot token but keeps the allowlist", () => {
  const out = redactConfigMapping({
    telegram_bot_token: "secret",
    telegram_chat_allowlist: "100",
  });
  expect(out["telegram_bot_token"]).toBe(REDACTION_PLACEHOLDER);
  expect(out["telegram_chat_allowlist"]).toBe("100");
});

const STORED_TOKEN_REF = "$secret:telegram_bot_token";
const ABSENT_TOKEN_REF = "$secret:absent_name";

// ----- Token through the custody store (trust-surface-hardening, B2) ---------
//
// A token written as a `$secret:NAME` reference resolves through the vault's
// custody store when the caller passes it; plain tokens keep today's path
// byte-identically, and an unresolvable reference refuses with the named
// resolver error instead of silently starting with the reference string.

const STORED_TOKEN = fakeCredential("stored-", "tg-token-61be");
const TOKEN_NOW = new Date("2026-06-05T10:00:00Z");

function storeBotToken(): void {
  setSecret(custodyVault, {
    name: "telegram_bot_token",
    value: STORED_TOKEN,
    agent: "tester",
    now: TOKEN_NOW,
  });
}

test("a reference token resolves through the custody store from config", () => {
  storeBotToken();
  expect(
    resolveTelegramBotToken(cfg(`telegram_bot_token: "${STORED_TOKEN_REF}"\n`), custodyVault),
  ).toBe(STORED_TOKEN);
});

test("a reference token resolves through the custody store from env", () => {
  storeBotToken();
  process.env["TELEGRAM_BOT_TOKEN"] = STORED_TOKEN_REF;
  expect(resolveTelegramBotToken(cfg("vault: /x\n"), custodyVault)).toBe(STORED_TOKEN);
});

test("a plain token keeps resolving byte-identically with a custody vault passed", () => {
  expect(resolveTelegramBotToken(cfg("telegram_bot_token: abc123\n"), custodyVault)).toBe("abc123");
  process.env["TELEGRAM_BOT_TOKEN"] = "env-token";
  expect(resolveTelegramBotToken(cfg("telegram_bot_token: abc123\n"), custodyVault)).toBe(
    "env-token",
  );
});

test("an unresolvable reference token refuses with the named resolver error", () => {
  expect(() =>
    resolveTelegramBotToken(cfg(`telegram_bot_token: "${ABSENT_TOKEN_REF}"\n`), custodyVault),
  ).toThrow(SecretReferenceError);
});
