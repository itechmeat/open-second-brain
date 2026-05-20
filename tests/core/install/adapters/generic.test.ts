import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { genericAdapter } from "../../../../src/core/install/adapters/generic.ts";
import type { InstallEnv } from "../../../../src/core/install/types.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";

let vault: string;
let home: string;
let stdoutBuf: string[];
let stderrBuf: string[];
let stdout: Writable;
let stderr: Writable;
let env: InstallEnv;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-generic-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-generic-h-"));
  stdoutBuf = [];
  stderrBuf = [];
  stdout = new Writable({
    write(chunk, _enc, cb) { stdoutBuf.push(chunk.toString()); cb(); },
  });
  stderr = new Writable({
    write(chunk, _enc, cb) { stderrBuf.push(chunk.toString()); cb(); },
  });
  env = {
    vault, home, cwd: home,
    env: {}, now: new Date("2026-05-20T12:00:00.000Z"),
  };
});

afterEach(() => {
  try { rmSync(vault, { recursive: true, force: true }); } catch {}
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

const payload = buildPayload({
  vault: "/home/u/vault", agent_name: "a", timezone: "UTC",
});

function applyOpts(extra: Partial<Parameters<typeof genericAdapter.apply>[3]> = {}) {
  return {
    dryRun: false, force: false,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    ...extra,
  };
}

describe("generic adapter", () => {
  test("detect always returns not-installed", () => {
    const r = genericAdapter.detect(env);
    expect(r.target).toBe("generic");
    expect(r.status).toBe("not-installed");
    expect(r.configPath).toBeNull();
  });

  test("plan returns a single print step", () => {
    const p = genericAdapter.plan(payload, env);
    expect(p.target).toBe("generic");
    expect(p.steps.length).toBe(1);
    expect(p.steps[0]!.kind).toBe("print");
  });

  test("apply (default) prints JSON to stdout", () => {
    const plan = genericAdapter.plan(payload, env);
    const result = genericAdapter.apply(plan, payload, env, applyOpts());
    const out = stdoutBuf.join("");
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers["open-second-brain"]).toBeDefined();
    expect(parsed.mcpServers["open-second-brain-writer"]).toBeDefined();
    expect(result.manifest.operation).toBe("print");
    expect(result.manifest.config_path).toBeNull();
  });

  test("apply with --out <path> writes file", () => {
    const outPath = join(home, "out.json");
    const plan = genericAdapter.plan(payload, env);
    const result = genericAdapter.apply(plan, payload, env, applyOpts({ outPath }));
    expect(existsSync(outPath)).toBe(true);
    const raw = readFileSync(outPath, "utf8");
    expect(JSON.parse(raw).mcpServers["open-second-brain"]).toBeDefined();
    expect(result.manifest.config_path).toBe(outPath);
    // stdout should remain empty when file path provided
    expect(stdoutBuf.join("").length).toBe(0);
  });

  test("apply with --out - writes to stdout", () => {
    const plan = genericAdapter.plan(payload, env);
    genericAdapter.apply(plan, payload, env, applyOpts({ outPath: "-" }));
    expect(stdoutBuf.join("").length).toBeGreaterThan(0);
  });

  test("apply with format=yaml writes YAML", () => {
    const plan = genericAdapter.plan(payload, env);
    genericAdapter.apply(plan, payload, env, applyOpts({ format: "yaml" }));
    const out = stdoutBuf.join("");
    expect(out).toContain("mcpServers:");
    expect(out).toContain("open-second-brain:");
    expect(() => JSON.parse(out)).toThrow();   // not JSON
  });

  test("apply dryRun does not write the output file", () => {
    const outPath = join(home, "out.json");
    const plan = genericAdapter.plan(payload, env);
    genericAdapter.apply(plan, payload, env, applyOpts({ outPath, dryRun: true }));
    expect(existsSync(outPath)).toBe(false);
  });

  test("verify returns not-installed when no out_path recorded", () => {
    const r = genericAdapter.verify(env);
    expect(r.status).toBe("not-installed");
  });

  test("uninstall reports the path the operator must remove themselves", () => {
    const outPath = join(home, "out.json");
    const plan = genericAdapter.plan(payload, env);
    genericAdapter.apply(plan, payload, env, applyOpts({ outPath }));
    const result = genericAdapter.uninstall(env, applyOpts());
    expect(result.skipped.length).toBeGreaterThan(0);
    // generic must not delete the operator's file
    expect(existsSync(outPath)).toBe(true);
  });
});
