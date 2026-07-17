/**
 * Cross-agent shared memory namespace (Agent Write Contract Suite,
 * t_936a1a61): opt-in mirror of explicit remember-writes into a shared
 * vault, per-agent + origin attribution, fail-soft mirroring.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mirrorNote,
  mirrorSignal,
  resolveSharedNamespace,
} from "../../../src/core/brain/shared-namespace.ts";
import { appendBrainNote } from "../../../src/core/brain/note.ts";
import { parseSignal } from "../../../src/core/brain/signal.ts";
import { parseLogDay } from "../../../src/core/brain/log.ts";
import { buildToolTable, findTool } from "../../../src/mcp/tools.ts";
import type { ServerContext } from "../../../src/mcp/tool-contract.ts";

let tmp: string;
let vault: string;
let shared: string;
let configPath: string;

const SIGNAL_INPUT = {
  topic: "mirror-topic",
  signal: "positive" as const,
  agent: "coding-agent",
  principle: "Mirrored facts stay attributed.",
  created_at: "2026-06-04T10:00:00Z",
  date: "2026-06-04",
  slug: "mirror-topic",
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-shared-ns-"));
  vault = join(tmp, "vault");
  shared = join(tmp, "shared");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(shared, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\nshared_namespace: "${shared}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("resolveSharedNamespace reads the config key; absent means off", () => {
  expect(resolveSharedNamespace(configPath)).toBe(shared);
  writeFileSync(configPath, `vault: "${vault}"\n`);
  expect(resolveSharedNamespace(configPath)).toBeNull();
  expect(resolveSharedNamespace(join(tmp, "missing.yaml"))).toBeNull();
});

test("mirrorSignal lands the signal in the shared vault with origin attribution", () => {
  expect(mirrorSignal(shared, vault, SIGNAL_INPUT)).toBe("ok");
  const inbox = join(shared, "Brain", "inbox");
  const files = readdirSync(inbox).filter((f) => f.endsWith(".md"));
  expect(files).toHaveLength(1);
  const signal = parseSignal(join(inbox, files[0]!));
  expect(signal.agent).toBe("coding-agent");
  const text = readFileSync(join(inbox, files[0]!), "utf8");
  expect(text).toContain("origin_vault: vault");
});

test("a broken shared namespace degrades to failed without throwing", () => {
  rmSync(shared, { recursive: true, force: true });
  writeFileSync(shared, "not a directory");
  expect(mirrorSignal(shared, vault, SIGNAL_INPUT)).toBe("failed");
  expect(mirrorNote(shared, vault, { text: "hello", agent: "coding-agent" })).toBe("failed");
});

test("a shared namespace pointing at the origin vault is refused as failed", () => {
  expect(mirrorSignal(vault, vault, SIGNAL_INPUT)).toBe("failed");
  expect(mirrorNote(vault, vault, { text: "self", agent: "a" })).toBe("failed");
  expect(readdirSync(join(vault, "Brain")).some((f) => f === "inbox")).toBe(false);
});

test("mirrorNote lands a note event with origin attribution", () => {
  expect(
    mirrorNote(shared, vault, {
      text: "released v1",
      agent: "coding-agent",
      now: new Date("2026-06-04T10:00:00Z"),
    }),
  ).toBe("ok");
  const { entries } = parseLogDay(shared, "2026-06-04");
  expect(entries).toHaveLength(1);
  expect(entries[0]!.eventType).toBe("note");
  expect(entries[0]!.body["origin_vault"]).toBe("vault");
  expect(entries[0]!.body["agent"]).toBe("coding-agent");
});

test("appendBrainNote mirrors when configured and reports the outcome", () => {
  const res = appendBrainNote({
    vault,
    text: "fact discovered",
    agent: "coding-agent",
    configPath,
    now: new Date("2026-06-04T10:00:00Z"),
  });
  expect(res.mirror).toBe("ok");
  expect(parseLogDay(shared, "2026-06-04").entries).toHaveLength(1);
  // Primary log always lands regardless of mirror state.
  expect(parseLogDay(vault, "2026-06-04").entries).toHaveLength(1);
});

test("appendBrainNote without the key stays silent about mirroring", () => {
  writeFileSync(configPath, `vault: "${vault}"\n`);
  const res = appendBrainNote({ vault, text: "no mirror", agent: "a", configPath });
  expect(res.mirror).toBeUndefined();
});

test("MCP brain_feedback mirrors the signal and reports mirror: ok", async () => {
  const ctx: ServerContext = { vault, configPath, repoRoot: null };
  const tool = findTool(buildToolTable("writer"), "brain_feedback");
  const res = (await tool.handler(ctx, {
    topic: "mirror-topic",
    signal: "positive",
    principle: "Mirrored facts stay attributed.",
    agent: "coding-agent",
  })) as Record<string, unknown>;
  expect(res["mirror"]).toBe("ok");
  const files = readdirSync(join(shared, "Brain", "inbox")).filter((f) => f.endsWith(".md"));
  expect(files).toHaveLength(1);
});

test("MCP brain_feedback mirror failure never breaks the primary write", async () => {
  rmSync(shared, { recursive: true, force: true });
  writeFileSync(shared, "not a directory");
  const ctx: ServerContext = { vault, configPath, repoRoot: null };
  const tool = findTool(buildToolTable("writer"), "brain_feedback");
  const res = (await tool.handler(ctx, {
    topic: "mirror-topic",
    signal: "positive",
    principle: "Primary write survives.",
    agent: "coding-agent",
  })) as Record<string, unknown>;
  expect(res["mirror"]).toBe("failed");
  const files = readdirSync(join(vault, "Brain", "inbox")).filter((f) => f.endsWith(".md"));
  expect(files).toHaveLength(1);
});

test("unconfigured setups keep the previous result shape (no mirror key)", async () => {
  writeFileSync(configPath, `vault: "${vault}"\n`);
  const ctx: ServerContext = { vault, configPath, repoRoot: null };
  const tool = findTool(buildToolTable("writer"), "brain_feedback");
  const res = (await tool.handler(ctx, {
    topic: "plain",
    signal: "positive",
    principle: "No mirror configured.",
    agent: "coding-agent",
  })) as Record<string, unknown>;
  expect("mirror" in res).toBe(false);
});
