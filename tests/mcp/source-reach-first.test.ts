/**
 * The reach question is asked before any filesystem question about a cited
 * source, on the vault-relative identity the classifier resolves.
 *
 * `brain_distill_source` and `brain_intake_entities` answer for a vault page
 * the caller may not read at its reach exactly as for an absent one. That
 * holds for a page the size ceiling or a refused read would otherwise stop:
 * the caller is answered `untrusted`, and only a caller that may read the
 * page is told why it cannot be classified. A predicate keyed on plain
 * strings is asked about the resolved identity, never a spelling with `.`
 * or `..` segments.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { distillSource } from "../../src/core/brain/distill/distill-source.ts";
import { intakeExtraction } from "../../src/core/brain/intake/extract-intake.ts";
import { SOURCE_HASH_MAX_BYTES } from "../../src/core/brain/intake/source-trust.ts";
import { resolveCaptureScope } from "../../src/core/brain/provenance/capture-scope.ts";
import { INTAKE_TRUST } from "../../src/core/brain/trust/untrusted-provenance.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { DISTILL_TOOLS } from "../../src/mcp/brain/distill-tools.ts";
import { NER_TOOLS } from "../../src/mcp/brain/ner-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

const PRIVATE_PATH = "Notes/secret.md";
const ABSENT = "Notes/absent.md";
const OPEN = "Notes/open.md";
const PRIVATE_HEAD = "---\nvisibility: private\n---\n";
const NOW = new Date("2026-06-13T12:00:00Z");

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-reach-first-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-reach-first-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, OPEN), "open\n");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const distillTool = DISTILL_TOOLS[0]!.handler;
const intakeTool = NER_TOOLS[0]!.handler;
const localCtx = (): ServerContext => ({ ...ctx, reach: TRANSPORT_REACH.local });

/** The `trust` each of the two tools answers for `source` at `reachCtx`. */
async function trustOf(source: string, reachCtx: ServerContext): Promise<unknown[]> {
  const distilled = (await distillTool(reachCtx, {
    source_path: source,
    claims: [{ text: "A claim." }],
  })) as Record<string, unknown>;
  const intaken = (await intakeTool(reachCtx, {
    source,
    entities: [{ category: "concept", name: "Codes" }],
  })) as Record<string, unknown>;
  return [distilled["trust"], intaken["trust"]];
}

describe("a page withheld at the caller's reach is never stat-ed or read for it", () => {
  test("a page past the size ceiling answers like an absent one", async () => {
    writeFileSync(join(vault, PRIVATE_PATH), PRIVATE_HEAD + "a".repeat(SOURCE_HASH_MAX_BYTES + 1));
    const untrusted = [INTAKE_TRUST.untrusted, INTAKE_TRUST.untrusted];
    expect(await trustOf(PRIVATE_PATH, ctx)).toEqual(untrusted);
    expect(await trustOf(ABSENT, ctx)).toEqual(untrusted);
    await expect(trustOf(PRIVATE_PATH, localCtx())).rejects.toThrow(String(SOURCE_HASH_MAX_BYTES));
  });

  test.skipIf(CHMOD_CANNOT_DENY)("an unreadable page answers like an absent one", async () => {
    writeFileSync(join(vault, PRIVATE_PATH), `${PRIVATE_HEAD}body\n`);
    chmodSync(join(vault, PRIVATE_PATH), 0o000);
    try {
      expect(await trustOf(PRIVATE_PATH, ctx)).toEqual([
        INTAKE_TRUST.untrusted,
        INTAKE_TRUST.untrusted,
      ]);
      await expect(trustOf(PRIVATE_PATH, localCtx())).rejects.toThrow("EACCES");
    } finally {
      chmodSync(join(vault, PRIVATE_PATH), 0o644);
    }
  });
});

describe("the predicate is asked about the resolved identity", () => {
  const SPELLINGS = ["Notes/./secret.md", "[[Notes/../Notes/secret.md]]"];
  const byString = (rel: string): boolean => rel !== PRIVATE_PATH;

  beforeEach(() => {
    writeFileSync(join(vault, PRIVATE_PATH), "body\n");
  });

  test("a single-source and a multi-source intake", () => {
    for (const spelling of SPELLINGS) {
      for (const sources of [[spelling], [OPEN, spelling]]) {
        const res = intakeExtraction(
          vault,
          { entities: [{ category: "concept", name: "Codes" }] },
          {
            agent: "claude",
            now: NOW,
            provenance: { level: "stated", sources, premises: [] },
            readable: byString,
          },
        );
        expect(res.trust).toBe(INTAKE_TRUST.untrusted);
      }
    }
  });

  test("a distillation", () => {
    for (const spelling of SPELLINGS) {
      const res = distillSource(
        vault,
        { sourcePath: spelling, claims: [{ text: "A claim." }] },
        { agent: "claude", now: NOW, readable: byString },
      );
      expect(res.trust).toBe(INTAKE_TRUST.untrusted);
    }
  });

  test("the capture-scope backing file", () => {
    for (const spelling of SPELLINGS) {
      expect(resolveCaptureScope(vault, spelling).backing).toBe(PRIVATE_PATH);
    }
  });
});
