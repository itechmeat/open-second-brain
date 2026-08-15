/**
 * Every `o2b install --json` payload, pinned.
 *
 * The human side of this verb was already pinned byte-for-byte: each
 * `install/<runtime>.md` carries an expected-output block and
 * `tests/docs/install-verify-conformance.test.ts` renders the real
 * `verify()` against it. The machine side was pinned by nothing. Four
 * modes emit four different payloads, three declared `schema_version: 1`
 * and the fourth - apply, the only mode that actually changes the machine -
 * declared no version at all, and no test asserted a single field name in
 * any of them.
 *
 * That asymmetry is the defect: a field added to the human table breaks a
 * documented block and names the file to edit, while the same field
 * forgotten on the JSON twin breaks nothing. This file removes the second
 * half of the asymmetry by naming the key set of every payload.
 *
 * Known wire inconsistency, pinned rather than fixed here: the plan
 * payload serialises `InstallPlan` verbatim, so it carries `postNotes` in
 * camelCase while every other payload in this family uses snake_case
 * (`config_path`, `fix_hint`, `steps_executed`). Renaming it is a wire
 * break with no consumer asking for it; pinning it is what makes the
 * rename a deliberate act rather than an accident.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTALL_JSON_SCHEMA_VERSION } from "../../src/cli/install/render.ts";
import { runCli as baseRunCli, type RunCliOptions, type RunResult } from "../helpers/run-cli.ts";

// Same reason as `install-verb.test.ts`: the adapters resolve the home
// directory at module-load time, so each call needs a fresh process to
// honour this file's per-case temp HOME.
function runCli(args: ReadonlyArray<string>, opts: RunCliOptions = {}): Promise<RunResult> {
  return baseRunCli(args, { ...opts, subprocess: true });
}

let vault: string;
let home: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-ijs-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-ijs-h-"));
  configPath = join(home, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\nagent_name: "claude-vps"\ntimezone: "UTC"\n`);
});

afterEach(() => {
  for (const p of [vault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function envBase() {
  return {
    HOME: home,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    VAULT_DIR: vault,
    VAULT_AGENT_NAME: "claude-vps",
    VAULT_TIMEZONE: "UTC",
  };
}

async function payloadOf(args: ReadonlyArray<string>): Promise<Record<string, unknown>> {
  const r = await runCli(args, { env: envBase() });
  expect(`${args.join(" ")} exit ${r.returncode}\n${r.stderr}`).toBe(`${args.join(" ")} exit 0\n`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/**
 * Every case here spawns a real `o2b` child, which costs about two seconds
 * of module graph on an unloaded machine. The default five would make this
 * file fail for being slow rather than for being wrong.
 */
const CLI_TIMEOUT_MS = 30_000;

/** Sorted key list, so a failure names the field rather than a count. */
function keys(value: unknown): string {
  return Object.keys(value as object)
    .toSorted()
    .join(",");
}

describe("every install --json payload declares its schema version", () => {
  test(
    "detect",
    async () => {
      const payload = await payloadOf(["install", "--json"]);
      expect(payload["schema_version"]).toBe(INSTALL_JSON_SCHEMA_VERSION);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "plan",
    async () => {
      const payload = await payloadOf(["install", "--target", "cursor", "--json"]);
      expect(payload["schema_version"]).toBe(INSTALL_JSON_SCHEMA_VERSION);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "apply - the one mode that changes the machine, and the one that had none",
    async () => {
      const payload = await payloadOf(["install", "--target", "cursor", "--apply", "--json"]);
      expect(payload["schema_version"]).toBe(INSTALL_JSON_SCHEMA_VERSION);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "verify",
    async () => {
      const payload = await payloadOf(["install", "--check", "--json"]);
      expect(payload["schema_version"]).toBe(INSTALL_JSON_SCHEMA_VERSION);
    },
    CLI_TIMEOUT_MS,
  );
});

describe("every install --json payload names its fields", () => {
  test(
    "detect carries a target row per adapter",
    async () => {
      const payload = await payloadOf(["install", "--json"]);
      expect(keys(payload)).toBe("schema_version,targets");
      const targets = payload["targets"] as ReadonlyArray<unknown>;
      expect(targets.length).toBeGreaterThan(0);
      for (const row of targets) expect(keys(row)).toBe("config_path,notes,status,target");
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "plan carries the plan verbatim",
    async () => {
      const payload = await payloadOf(["install", "--target", "cursor", "--json"]);
      expect(keys(payload)).toBe("plan,schema_version");
      expect(keys(payload["plan"])).toBe("postNotes,steps,target");
      for (const step of (payload["plan"] as { steps: ReadonlyArray<unknown> }).steps) {
        expect(keys(step)).toBe("kind,path,preview");
      }
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "apply carries the manifest it wrote, at the top level as before",
    async () => {
      const payload = await payloadOf(["install", "--target", "cursor", "--apply", "--json"]);
      // `schema_version` is ADDED beside the result's own fields rather than
      // nesting the result under a key: an existing consumer reading
      // `.manifest` or `.steps_executed` keeps working and gains a version,
      // which a re-nesting would have broken for no benefit.
      expect(keys(payload)).toContain("manifest");
      expect(keys(payload)).toContain("steps_executed");
      expect(keys(payload)).toContain("target");
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "verify carries a verify row per adapter",
    async () => {
      const payload = await payloadOf(["install", "--check", "--json"]);
      expect(keys(payload)).toBe("schema_version,targets");
      const targets = payload["targets"] as ReadonlyArray<unknown>;
      expect(targets.length).toBeGreaterThan(0);
      for (const row of targets) expect(keys(row)).toBe("details,fix_hint,status,target");
    },
    CLI_TIMEOUT_MS,
  );
});
