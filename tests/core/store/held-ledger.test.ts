import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lostHeldPartitions, recordHeldPartitions } from "../../../src/core/store/held-ledger.ts";
import type { PlatformDirsEnv } from "../../../src/core/platform-dirs.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const LEDGER = join(import.meta.dir, "../../../src/core/store/held-ledger.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stateEnv(state: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    XDG_STATE_HOME: state,
    LOCALAPPDATA: state,
  };
}

describe("held partitions ledger", () => {
  test("concurrent opens never drop one another's held partition", async () => {
    const state = mkdtempSync(join(tmpdir(), "osb-held-"));
    dirs.push(state);
    const env = stateEnv(state);
    const roots = Array.from({ length: 24 }, (_, i) => join(state, `store-${i}`));
    // Every process records a different root at the same moment: a list
    // rewritten in place loses the roots a concurrent writer overwrote.
    const script = join(state, "record.ts");
    writeFileSync(
      script,
      `import { recordHeldPartitions } from ${JSON.stringify(LEDGER)};
recordHeldPartitions(process.argv[2], ["private"]);
`,
    );
    const procs = roots.map((root) =>
      Bun.spawn([process.execPath, script, root], { env, stdout: "ignore", stderr: "inherit" }),
    );
    for (const p of procs) expect(await p.exited).toBe(0);

    const saved = {
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    };
    process.env.XDG_STATE_HOME = state;
    process.env.LOCALAPPDATA = state;
    try {
      for (const root of roots) {
        expect(lostHeldPartitions(root, new Set(["shared"]))).toEqual(["private"]);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 30_000);

  test("a partition recorded for one store is not lost for another", () => {
    const state = mkdtempSync(join(tmpdir(), "osb-held-"));
    dirs.push(state);
    const env: PlatformDirsEnv = { platform: process.platform, home: state, env: stateEnv(state) };
    recordHeldPartitions(join(state, "a"), ["shared", "private"], env);
    const saved = process.env.XDG_STATE_HOME;
    const savedLocal = process.env.LOCALAPPDATA;
    process.env.XDG_STATE_HOME = state;
    process.env.LOCALAPPDATA = state;
    try {
      expect(lostHeldPartitions(join(state, "a"), new Set(["shared"]))).toEqual(["private"]);
      expect(lostHeldPartitions(join(state, "b"), new Set(["shared"]))).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
      if (savedLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = savedLocal;
    }
  });
});
