import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { cursorAdapter } from "../../../../src/core/install/adapters/cursor.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import { readManifest } from "../../../../src/core/install/manifest.ts";
import { InstallError } from "../../../../src/core/install/types.ts";

let vault: string;
let home: string;
let stdoutBuf: string[];
let stderrBuf: string[];

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-cursor-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-cursor-h-"));
  stdoutBuf = [];
  stderrBuf = [];
});

afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

function makeEnv(now = new Date("2026-05-20T12:00:00.000Z")) {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "claude-vps", VAULT_TIMEZONE: "UTC" },
    now,
  };
}

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutBuf.push(chunk.toString());
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrBuf.push(chunk.toString());
      cb();
    },
  });
  return { stdout, stderr };
}

function payload() {
  return buildPayload({
    vault,
    agent_name: "claude-vps",
    timezone: "UTC",
  });
}

function applyOpts(overrides: Record<string, unknown> = {}) {
  const { stdout, stderr } = makeStreams();
  return {
    dryRun: false,
    force: false,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    ...overrides,
  };
}

function cursorConfigPath() {
  return join(home, ".cursor", "mcp.json");
}

describe("cursor adapter", () => {
  test("detect on clean home returns not-installed", () => {
    const r = cursorAdapter.detect(makeEnv());
    expect(r.status).toBe("not-installed");
    expect(r.configPath).toBe(cursorConfigPath());
  });

  test("apply on clean home creates config with both OSB keys", () => {
    const p = payload();
    const plan = cursorAdapter.plan(p, makeEnv());
    const result = cursorAdapter.apply(plan, p, makeEnv(), applyOpts());
    expect(existsSync(cursorConfigPath())).toBe(true);
    const parsed = JSON.parse(readFileSync(cursorConfigPath(), "utf8"));
    expect(Object.keys(parsed.mcpServers)).toEqual([
      "open-second-brain",
      "open-second-brain-writer",
    ]);
    expect(result.manifest.owned_keys).toEqual([
      "mcpServers.open-second-brain",
      "mcpServers.open-second-brain-writer",
    ]);
    expect(readManifest(vault).installs.cursor).toBeDefined();
  });

  test("re-apply is idempotent (file bytes unchanged)", () => {
    const p = payload();
    const plan = cursorAdapter.plan(p, makeEnv());
    cursorAdapter.apply(plan, p, makeEnv(), applyOpts());
    const after1 = readFileSync(cursorConfigPath(), "utf8");
    cursorAdapter.apply(plan, p, makeEnv(), applyOpts());
    const after2 = readFileSync(cursorConfigPath(), "utf8");
    expect(after2).toBe(after1);
  });

  test("apply preserves unrelated mcpServers keys", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      cursorConfigPath(),
      JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }, null, 2) + "\n",
    );
    const p = payload();
    const plan = cursorAdapter.plan(p, makeEnv());
    cursorAdapter.apply(plan, p, makeEnv(), applyOpts());
    const parsed = JSON.parse(readFileSync(cursorConfigPath(), "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "x", args: [] });
    expect(Object.keys(parsed.mcpServers)).toEqual([
      "other",
      "open-second-brain",
      "open-second-brain-writer",
    ]);
  });

  test("verify on installed config reports ok", () => {
    const p = payload();
    const plan = cursorAdapter.plan(p, makeEnv());
    cursorAdapter.apply(plan, p, makeEnv(), applyOpts());
    const v = cursorAdapter.verify(makeEnv());
    expect(v.status).toBe("ok");
  });

  test("verify reports drift when writer key was manually removed", () => {
    const p = payload();
    const plan = cursorAdapter.plan(p, makeEnv());
    cursorAdapter.apply(plan, p, makeEnv(), applyOpts());
    const parsed = JSON.parse(readFileSync(cursorConfigPath(), "utf8"));
    delete parsed.mcpServers["open-second-brain-writer"];
    writeFileSync(cursorConfigPath(), JSON.stringify(parsed, null, 2) + "\n");
    const v = cursorAdapter.verify(makeEnv());
    expect(v.status).toBe("drift");
    expect(v.fix_hint).toContain("o2b install --target cursor --apply");
  });

  test("verify reports drift when OSB key payload was manually changed", () => {
    const p = payload();
    const plan = cursorAdapter.plan(p, makeEnv());
    cursorAdapter.apply(plan, p, makeEnv(), applyOpts());
    const parsed = JSON.parse(readFileSync(cursorConfigPath(), "utf8"));
    parsed.mcpServers["open-second-brain"].command = "TAMPERED";
    writeFileSync(cursorConfigPath(), JSON.stringify(parsed, null, 2) + "\n");
    const v = cursorAdapter.verify(makeEnv());
    expect(v.status).toBe("drift");
    expect(v.details.join("\n")).toContain("canonical payload");
  });

  test("detect reports drift instead of throwing when config root is not an object", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(cursorConfigPath(), "null\n");
    const r = cursorAdapter.detect(makeEnv());
    expect(r.status).toBe("drift");
  });

  test("uninstall removes both OSB keys, preserves user key, drops manifest entry", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      cursorConfigPath(),
      JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }, null, 2) + "\n",
    );
    const p = payload();
    cursorAdapter.apply(cursorAdapter.plan(p, makeEnv()), p, makeEnv(), applyOpts());
    cursorAdapter.uninstall(makeEnv(), applyOpts());
    const parsed = JSON.parse(readFileSync(cursorConfigPath(), "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeUndefined();
    expect(parsed.mcpServers["open-second-brain-writer"]).toBeUndefined();
    expect(parsed.mcpServers.other).toEqual({ command: "x", args: [] });
    expect(readManifest(vault).installs.cursor).toBeUndefined();
  });

  test("uninstall without manifest entry throws manifest-missing", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      cursorConfigPath(),
      JSON.stringify(
        { mcpServers: { "open-second-brain": { command: "o2b", args: ["mcp"] } } },
        null,
        2,
      ) + "\n",
    );
    try {
      cursorAdapter.uninstall(makeEnv(), applyOpts());
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InstallError);
      expect((err as InstallError).kind).toBe("manifest-missing");
    }
  });

  test("uninstall --force-from-snippet works without manifest", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      cursorConfigPath(),
      JSON.stringify(
        { mcpServers: { "open-second-brain": { command: "o2b", args: ["mcp"] } } },
        null,
        2,
      ) + "\n",
    );
    expect(() =>
      cursorAdapter.uninstall(makeEnv(), applyOpts({ fromSnippet: true })),
    ).not.toThrow();
    const parsed = JSON.parse(readFileSync(cursorConfigPath(), "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeUndefined();
  });

  test("user hand-edits the block, re-apply without --force throws user-modified-block", () => {
    const env1 = makeEnv(new Date("2026-05-20T12:00:00.000Z"));
    const p = payload();
    cursorAdapter.apply(cursorAdapter.plan(p, env1), p, env1, applyOpts());
    // Tamper with the file and bump mtime past the manifest applied_at.
    const parsed = JSON.parse(readFileSync(cursorConfigPath(), "utf8"));
    parsed.mcpServers["open-second-brain"] = { command: "TAMPERED", args: [] };
    writeFileSync(cursorConfigPath(), JSON.stringify(parsed, null, 2) + "\n");
    const future = new Date("2026-05-20T13:00:00.000Z");
    utimesSync(cursorConfigPath(), future, future);

    const env2 = makeEnv(new Date("2026-05-20T13:05:00.000Z"));
    try {
      cursorAdapter.apply(cursorAdapter.plan(p, env2), p, env2, applyOpts());
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InstallError);
      expect((err as InstallError).kind).toBe("user-modified-block");
    }
  });

  test("user hand-edits + --force overwrites", () => {
    const env1 = makeEnv(new Date("2026-05-20T12:00:00.000Z"));
    const p = payload();
    cursorAdapter.apply(cursorAdapter.plan(p, env1), p, env1, applyOpts());
    const parsed = JSON.parse(readFileSync(cursorConfigPath(), "utf8"));
    parsed.mcpServers["open-second-brain"] = { command: "TAMPERED", args: [] };
    writeFileSync(cursorConfigPath(), JSON.stringify(parsed, null, 2) + "\n");
    const future = new Date("2026-05-20T13:00:00.000Z");
    utimesSync(cursorConfigPath(), future, future);

    const env2 = makeEnv(new Date("2026-05-20T13:05:00.000Z"));
    cursorAdapter.apply(cursorAdapter.plan(p, env2), p, env2, applyOpts({ force: true }));
    const after = JSON.parse(readFileSync(cursorConfigPath(), "utf8"));
    expect(after.mcpServers["open-second-brain"].command).toBe("o2b");
  });

  test("dryRun does not write the config file or manifest", () => {
    const p = payload();
    const plan = cursorAdapter.plan(p, makeEnv());
    cursorAdapter.apply(plan, p, makeEnv(), applyOpts({ dryRun: true }));
    expect(existsSync(cursorConfigPath())).toBe(false);
    expect(readManifest(vault).installs.cursor).toBeUndefined();
  });
});
