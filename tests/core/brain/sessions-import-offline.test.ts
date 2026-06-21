/**
 * Offline guarantee for session import (t_85252236).
 *
 * The triage brief assumed `importSession` "requires provider
 * credentials". It does not: the pipeline is fully deterministic. This
 * regression test locks that guarantee by running an import under a
 * scrubbed environment with a credential-read spy installed over
 * `process.env`, asserting the import completes and never reads any
 * provider-credential variable.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { brainDirs } from "../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { importSession } from "../../../src/core/brain/sessions/import.ts";

const CLAUDE = resolve("tests/fixtures/sessions/claude-minimal.jsonl");

// Provider-credential variable names that must never be touched by a
// deterministic import. OSB resolves its own embedding key from
// `OPEN_SECOND_BRAIN_EMBEDDING_KEY`; the others are the generic provider
// keys the upstream task brief called out.
const CREDENTIAL_KEYS = [
  "OPEN_SECOND_BRAIN_EMBEDDING_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-import-offline-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(join(dirs.brain, "_brain.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("importSession completes and never reads provider credentials", async () => {
  const realEnv = process.env;
  const touched: string[] = [];

  // Scrub credentials and spy on every read so an accidental
  // credential lookup is observable, not silent.
  const scrubbed: NodeJS.ProcessEnv = { ...realEnv };
  for (const k of CREDENTIAL_KEYS) delete scrubbed[k];

  const spy = new Proxy(scrubbed, {
    get(target, prop: string | symbol) {
      if (typeof prop === "string" && (CREDENTIAL_KEYS as readonly string[]).includes(prop)) {
        touched.push(prop);
      }
      return Reflect.get(target, prop);
    },
  });

  // eslint-disable-next-line no-global-assign
  (process as { env: NodeJS.ProcessEnv }).env = spy;
  try {
    const res = await importSession(tmp, CLAUDE, { agent: "test" });
    expect(res.format).toBe("claude");
    expect(res.signals_created).toBeGreaterThan(0);
  } finally {
    (process as { env: NodeJS.ProcessEnv }).env = realEnv;
  }

  expect(touched).toEqual([]);
});
