/**
 * The command line and the SessionStart hook of a machine switched to the
 * brain store, whose vault folder is gone (an unmounted disk) or cannot be
 * examined (mode 000).
 *
 * The brain lives in the store there, so one decision (`servedVault`,
 * shared with the MCP server) serves it from the store in both shapes:
 * the store-backed verbs answer, a verb that needs the vault's files
 * refuses with one line naming the reason, and the hook injects the
 * digest with one line saying the operator's rules could not be read.
 * Before the fix a vault at mode 000 failed every one of these verbs and
 * left the hook silent, while a vault that was gone answered.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

import { writePreference } from "../../src/core/brain/preference.ts";
import { storesStateDir } from "../../src/core/store/store-paths.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS * 4);

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const HOOK = join(import.meta.dir, "../../hooks/active-inject.ts");
const RULE = "Always feed the otters before the herons.";

let env: StoreEnv | undefined;
const undo: Array<() => void> = [];
afterEach(() => {
  try {
    for (const step of undo.splice(0)) step();
  } finally {
    env?.cleanup();
    env = undefined;
  }
});

/** A switched machine with no legacy tree, holding one confirmed preference in the store. */
function switchedMachine(prefix: string): StoreEnv {
  env = makeStoreEnv(prefix, { legacyTree: false });
  switchDevice(env.storeRoot);
  writePreference(env.vault, {
    slug: "otters-first",
    topic: "otters-first",
    principle: RULE,
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-02T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-02T00:00:00Z",
    evidenced_by: ["[[sig-x]]"],
    confidence_value: 0.9,
  });
  return env;
}

function run(argv: string[], stdin?: string): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync([process.execPath, ...argv], {
    env: { ...process.env } as Record<string, string>,
    ...(stdin !== undefined ? { stdin: Buffer.from(stdin) } : {}),
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

/** The verbs that read or write the store: each answers from it. */
const STORE_VERBS: ReadonlyArray<readonly string[]> = [
  ["brain", "feedback", "--topic", "tabs", "--principle", "Prefer tabs.", "--signal", "positive"],
  ["brain", "note", "Shipped the otter feeder."],
  ["brain", "doctor"],
  ["brain", "dream", "--dry-run"],
  ["brain", "export", "--format", "json"],
  ["brain", "claims"],
  ["brain", "rollback", "--list"],
  ["brain", "query", "--topic", "otters-first"],
];

const UNREACHABLE = [
  {
    shape: "gone",
    skip: false,
    reason: "is not there (ENOENT)",
    cutOff(vault: string): void {
      const away = `${vault}-away`;
      renameSync(vault, away);
      undo.push(() => {
        if (existsSync(away) && !existsSync(vault)) renameSync(away, vault);
      });
    },
  },
  {
    shape: "unreadable",
    skip: CHMOD_CANNOT_DENY,
    reason: "cannot be examined (EACCES)",
    cutOff(vault: string): void {
      chmodSync(vault, 0o000);
      undo.push(() => chmodSync(vault, 0o755));
    },
  },
] as const;

for (const { shape, skip, reason, cutOff } of UNREACHABLE) {
  test.skipIf(skip)(`the store-backed verbs answer while the vault is ${shape}`, () => {
    const e = switchedMachine(`osb-cli-switched-${shape}-`);
    cutOff(e.vault);
    const exits: Record<string, string> = {};
    for (const argv of STORE_VERBS) {
      const res = run([CLI, ...argv]);
      exits[argv.slice(0, 2).join(" ")] = res.code === 0 ? "ok" : `${res.code}: ${res.err}`;
    }
    expect(exits).toEqual(
      Object.fromEntries(STORE_VERBS.map((argv) => [argv.slice(0, 2).join(" "), "ok"])),
    );
    // The export carries the stored rule.
    const exported = run([CLI, "brain", "export", "--format", "json"]).out;
    expect(exported).toContain(RULE);
    // The stand-in root the store is read through is never named as the vault.
    expect(exported).not.toContain("no-vault");
    if (shape === "gone") expect(existsSync(e.vault)).toBe(false);
  });

  test.skipIf(skip)(
    `a verb that needs the vault's files refuses in one line while it is ${shape}`,
    () => {
      const e = switchedMachine(`osb-cli-switched-files-${shape}-`);
      cutOff(e.vault);
      const res = run([CLI, "brain", "migrate-store", "--dry-run"]);
      expect(res.code).toBe(1);
      expect(res.out).toBe("");
      expect(res.err.trim().split("\n")).toHaveLength(1);
      expect(res.err).toContain(reason);
      expect(res.err).toContain("this machine's brain is in the store");
    },
  );

  test.skipIf(skip)(
    `the SessionStart hook injects the stored rules while the vault is ${shape}`,
    () => {
      const e = switchedMachine(`osb-hook-switched-${shape}-`);
      cutOff(e.vault);
      const res = run(
        [HOOK],
        JSON.stringify({ hook_event_name: "SessionStart", session_id: "s-1", cwd: e.parent }),
      );
      expect(res.code).toBe(0);
      const context = JSON.parse(res.out)["hookSpecificOutput"]["additionalContext"] as string;
      expect(context).toContain(RULE);
      // The operator's rules live in the vault: one line says they could not be read.
      expect(context).toContain(`UNAVAILABLE: Brain/standing-rules.md could not be read`);
      expect(context).toContain(reason);
      if (shape === "gone") expect(existsSync(e.vault)).toBe(false);
    },
  );

  test.skipIf(skip)(
    `the dry run writes nothing, not even the switch marker, while the vault is ${shape}`,
    () => {
      // A switch this machine has not recorded yet: the record sits in the
      // store, and no device-local marker says so.
      env = makeStoreEnv(`osb-cli-switched-dry-${shape}-`, { legacyTree: false });
      switchDevice(env.storeRoot);
      const marker = join(storesStateDir(), "store-only.json");
      expect(existsSync(marker)).toBe(false);
      cutOff(env.vault);
      const res = run([CLI, "brain", "migrate-store", "--dry-run"]);
      expect(res.code).toBe(1);
      expect(res.err).toContain(reason);
      // "Nothing was written": the reachability decision is a look.
      expect(existsSync(marker)).toBe(false);
    },
  );
}
