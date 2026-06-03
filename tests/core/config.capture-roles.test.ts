import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSessionCaptureRoles } from "../../src/core/config.ts";

let tmp: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-capture-roles-"));
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env["OPEN_SECOND_BRAIN_SESSION_CAPTURE_ROLES"];
});

test("absent key captures all roles (null = no filter)", () => {
  writeFileSync(config, `vault: "${tmp}"\n`);
  expect(resolveSessionCaptureRoles(config)).toBeNull();
  expect(resolveSessionCaptureRoles(join(tmp, "ghost.yaml"))).toBeNull();
});

test("comma-separated roles parse, trim, and dedupe", () => {
  writeFileSync(config, `vault: "${tmp}"\nsession_capture_roles: "user, assistant,user"\n`);
  expect(resolveSessionCaptureRoles(config)).toEqual(["user", "assistant"]);
});

test("an empty value is treated as no filter", () => {
  writeFileSync(config, `vault: "${tmp}"\nsession_capture_roles: ""\n`);
  expect(resolveSessionCaptureRoles(config)).toBeNull();
});

test("an invalid role name fails fast", () => {
  writeFileSync(config, `vault: "${tmp}"\nsession_capture_roles: "user,reviewer"\n`);
  expect(() => resolveSessionCaptureRoles(config)).toThrow("session_capture_roles");
});

test("the env override wins over the config key", () => {
  writeFileSync(config, `vault: "${tmp}"\nsession_capture_roles: "user"\n`);
  process.env["OPEN_SECOND_BRAIN_SESSION_CAPTURE_ROLES"] = "tool,meta";
  expect(resolveSessionCaptureRoles(config)).toEqual(["tool", "meta"]);
});
