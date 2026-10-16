/**
 * The `forget-source` front door names what did not delete (storage
 * lifecycle, PR #257 review M8). The core `deleteBySource` result has
 * carried `failed: [{path, message}]` since the per-entry failure
 * collection landed, but this verb left it out of both the JSON payload
 * and the text report and exited 0 - a confirmed removal that could not
 * delete three files looked like a clean run with a smaller count. The
 * confirmed run now carries `failed` in the JSON, prints the blocked
 * paths in text mode, and exits 1 when any failure was collected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cmdBrainForgetSource } from "../../../../src/cli/brain/verbs/forget-source.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";

let vault: string;
let configHome: string;
let savedConfigEnv: string | undefined;

const SOURCE = "imports/benchmark.md";
const NOW = new Date("2026-06-01T00:00:00Z");

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-cli-forget-source-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-cli-forget-source-cfg-"));
  atomicWriteFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: join(configHome, "config.yaml") });
  savedConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = join(configHome, "config.yaml");
  mkdirSync(join(vault, "imports"), { recursive: true });
  writeFileSync(join(vault, SOURCE), "benchmark rows\n", "utf8");
  ingestSource(
    vault,
    {
      sourcePath: SOURCE,
      summary: "Benchmark import summary.",
      extraction: { entities: [{ category: "concept", name: "BenchWidget" }] },
    },
    { agent: "tester", now: NOW },
  );
});

afterEach(() => {
  if (savedConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfigEnv;
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(configHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Run the verb in-process, capturing stdout and the returned exit code. */
async function captureVerb(argv: string[]): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await cmdBrainForgetSource(argv);
    return { code, stdout: chunks.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe("forget-source carries the core failed list to the front door", () => {
  test("a confirmed run with a blocked removal exits 1 and names the path in JSON", async () => {
    if (CHMOD_CANNOT_DENY) return;
    // The summary page sits in Brain/sources; a read-only directory makes
    // exactly that removal fail while the run completes.
    const preview = await captureVerb([SOURCE, "--vault", vault, "--json"]);
    const previewPayload = JSON.parse(preview.stdout) as {
      derived: Array<{ path: string; kind: string }>;
    };
    const blockedPath = previewPayload.derived.find((e) => e.kind === "summary")!.path;
    const blockedDir = join(vault, dirname(blockedPath));
    chmodSync(blockedDir, 0o555);
    try {
      const run = await captureVerb([SOURCE, "--vault", vault, "--confirm", "--json"]);
      expect(run.code).toBe(1);
      const payload = JSON.parse(run.stdout) as {
        changed: number;
        failed: ReadonlyArray<{ path: string; message: string }>;
      };
      expect(payload.failed.length).toBe(1);
      expect(payload.failed[0]!.path).toBe(blockedPath);
      expect(payload.failed[0]!.message.length).toBeGreaterThan(0);
      expect(payload.changed).toBeGreaterThan(0);
      expect(existsSync(join(vault, blockedPath))).toBe(true);
    } finally {
      chmodSync(blockedDir, 0o755);
    }
  });

  test("a clean confirmed run exits 0 and names no failure", async () => {
    const run = await captureVerb([SOURCE, "--vault", vault, "--confirm", "--json"]);
    expect(run.code).toBe(0);
    const payload = JSON.parse(run.stdout) as { failed?: unknown };
    expect(payload.failed).toEqual([]);
  });
});
