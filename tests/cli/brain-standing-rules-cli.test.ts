/**
 * `o2b brain standing-rules` on a switched machine with no `Brain/` tree:
 * the operator's edit lands in the store's `standing-rule` lane with
 * `human` authority, reads back byte for byte, reaches the SessionStart
 * reader, and never creates `Brain/` in the vault.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPartition } from "../../src/core/store/state-digest.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let parent: string;
let vault: string;
let env: Record<string, string>;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-cli-standing-rules-"));
  vault = join(parent, "vault");
  mkdirSync(vault, { recursive: true });
  const config = join(parent, "config.yaml");
  writeFileSync(config, `vault: ${vault}\n`);
  env = {
    OPEN_SECOND_BRAIN_CONFIG: config,
    OPEN_SECOND_BRAIN_STORE_ROOT: join(parent, "store"),
    O2B_DEVICE_ID: "dev-cli",
    HOME: join(parent, "home"),
    XDG_STATE_HOME: join(parent, "state"),
    LOCALAPPDATA: join(parent, "state"),
  };
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const RULES = "# Rules\r\n\r\n- Ask before pushing.  \r\n- Отвечай кратко.\r\n";

function laneRecords(): Array<{ kind: string; body: Record<string, unknown> }> {
  return (["shared", "private"] as const).flatMap((partition) =>
    readPartition(join(parent, "store", partition))
      .flatMap((shard) => shard.records)
      .filter((r) => r.kind === "lane-entry" || r.kind === "lane-entry-remove"),
  );
}

test("set, show and clear the standing rules on a switched vault with no Brain/ tree", async () => {
  expect((await runCli(["store", "init", "--json"], { env })).returncode).toBe(0);
  const file = join(parent, "rules.md");
  writeFileSync(file, RULES);

  const set = await runCli(["brain", "standing-rules", "set", "--file", file], { env });
  expect(set.returncode).toBe(0);
  const scoped = await runCli(["brain", "standing-rules", "set", "--project", "osb", "--stdin"], {
    env,
    stdin: "Run the census.\n",
  });
  expect(scoped.returncode).toBe(0);

  const records = laneRecords();
  expect(records.map((r) => [r.body["lane"], r.body["entry"], r.body["authority"]])).toEqual([
    ["standing-rule", "standing-rules", "human"],
    ["standing-rule", "project/osb", "human"],
  ]);

  const show = await runCli(["brain", "standing-rules", "show", "--json"], { env });
  expect(show.returncode).toBe(0);
  expect(JSON.parse(show.stdout)).toEqual({ ok: true, present: true, text: RULES });

  const harness = await runCli(["brain", "standing-rules", "show", "--harness", "nope"], { env });
  expect(harness.returncode).toBe(2);

  const clear = await runCli(["brain", "standing-rules", "clear", "--project", "osb"], { env });
  expect(clear.returncode).toBe(0);
  const shown = await runCli(["brain", "standing-rules", "show", "--project", "osb", "--json"], {
    env,
  });
  expect(JSON.parse(shown.stdout)).toEqual({ ok: true, present: false, text: "" });

  expect(existsSync(join(vault, "Brain"))).toBe(false);
});

test("a blank scope flag is refused and never selects the vault-wide rules", async () => {
  expect((await runCli(["store", "init", "--json"], { env })).returncode).toBe(0);
  const set = await runCli(["brain", "standing-rules", "set", "--stdin"], {
    env,
    stdin: "Vault-wide rule.\n",
  });
  expect(set.returncode).toBe(0);
  for (const axis of ["--project", "--harness", "--host"]) {
    for (const sub of ["clear", "set", "show"]) {
      // oxlint-disable-next-line no-await-in-loop
      const out = await runCli(["brain", "standing-rules", sub, axis, "  "], {
        env,
        ...(sub === "set" ? { stdin: "Other text.\n" } : {}),
      });
      expect({ axis, sub, code: out.returncode }).toEqual({ axis, sub, code: 2 });
    }
  }
  const shown = await runCli(["brain", "standing-rules", "show", "--json"], { env });
  expect(JSON.parse(shown.stdout)).toEqual({ ok: true, present: true, text: "Vault-wide rule.\n" });
});

test.skipIf(CHMOD_CANNOT_DENY)(
  "clear over an unreadable store shard fails instead of reporting no rules",
  async () => {
    expect((await runCli(["store", "init", "--json"], { env })).returncode).toBe(0);
    const set = await runCli(["brain", "standing-rules", "set", "--stdin"], {
      env,
      stdin: "Vault-wide rule.\n",
    });
    expect(set.returncode).toBe(0);
    const shards: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".jsonl")) shards.push(path);
      }
    };
    walk(join(parent, "store", "shared", "events"));
    expect(shards.length).toBeGreaterThan(0);
    try {
      for (const shard of shards) chmodSync(shard, 0o000);
      const clear = await runCli(["brain", "standing-rules", "clear"], { env });
      expect(clear.returncode).toBe(1);
      expect(clear.stdout).not.toContain("no standing rules");
    } finally {
      for (const shard of shards) chmodSync(shard, 0o644);
    }
    const shown = await runCli(["brain", "standing-rules", "show", "--json"], { env });
    expect(JSON.parse(shown.stdout)).toMatchObject({ present: true });
  },
);
