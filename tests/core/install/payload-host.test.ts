/**
 * `HOST_PAYLOAD_TARGETS` against the artifacts the ten adapters write.
 *
 * The set answers one question - "does this target's generated
 * registration carry the host dimensions" - and three surfaces read it:
 * `payloadForHost` (which refuses a non-member), `o2b update`'s payload
 * hash, and `--friction`'s tool-profile cell. A declaration read by three
 * surfaces and checked by none would be a fourth place for the routing to
 * drift from what is claimed about it, which is the shape of defect this
 * release exists to remove.
 *
 * So the check is BEHAVIOURAL, not a re-listing: every adapter is applied
 * for real into a temporary home, every file it leaves is read back, and
 * the set of targets whose artifact mentions `--host-target` is required
 * to equal the declared set. A target that stopped routing through
 * `payloadForHost`, or started, moves in the measurement rather than in a
 * literal somebody has to remember to edit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { registerAllAdapters } from "../../../src/core/install/adapters/all.ts";
import {
  resetCodexRunner,
  setCodexRunner,
  type CodexRunner,
} from "../../../src/core/install/adapters/codex.ts";
import {
  resetCopilotRunner,
  setCopilotRunner,
  type CopilotRunner,
} from "../../../src/core/install/adapters/copilot-cli.ts";
import {
  carriesHostDimensions,
  HOST_PAYLOAD_TARGETS,
  HOST_TARGET_FLAG,
  payloadAsWritten,
  payloadForHost,
  writtenToolProfile,
} from "../../../src/core/install/payload-host.ts";
import { buildPayload } from "../../../src/core/install/payload.ts";
import { INSTALL_TARGET_IDS, type InstallTargetId } from "../../../src/core/runtime/host-facts.ts";
import type { ApplyOpts, InstallEnv } from "../../../src/core/install/types.ts";

let vault: string;
let home: string;

/**
 * Both subprocess seams are pinned absent, so every adapter takes its FILE
 * path and leaves something on disk to read. Left on their defaults they
 * would spawn the operator's real host binaries against the operator's
 * real registrations - and the subprocess branches would then leave
 * nothing under `home` for the sweep below to find.
 */
const ABSENT_CODEX: CodexRunner = {
  available: () => false,
  run: () => ({ exitCode: 1, stdout: "", stderr: "codex is not on PATH" }),
};

const ABSENT_COPILOT: CopilotRunner = {
  available: () => false,
  run: () => ({ exitCode: 1, stdout: "", stderr: "copilot is not on PATH" }),
  list: () => ({ ok: false, names: [] }),
};

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-payload-host-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-payload-host-h-"));
  setCodexRunner(ABSENT_CODEX);
  setCopilotRunner(ABSENT_COPILOT);
});

afterEach(() => {
  resetCodexRunner();
  resetCopilotRunner();
  for (const dir of [vault, home]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
});

function sink(): NodeJS.WriteStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
}

function installEnv(): InstallEnv {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "claude-vps", VAULT_TIMEZONE: "UTC" },
    now: new Date("2026-08-16T12:00:00.000Z"),
  };
}

/** Every regular file under `dir`, following no symlink. */
function filesUnder(dir: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      out.push(...filesUnder(path));
      continue;
    }
    if (statSync(path).isFile()) out.push(path);
  }
  return out;
}

/**
 * Apply `target` into the temporary home and return everything it wrote.
 *
 * `generic` prints rather than installing, so it is given an explicit
 * `--out` inside the same home; without one it writes to stdout and the
 * sweep would report it as carrying nothing for the wrong reason.
 */
function artifactsAfterApply(target: InstallTargetId): string {
  const adapter = registerAllAdapters().get(target)!;
  const env = installEnv();
  const payload = buildPayload({ vault, agent_name: "claude-vps", timezone: "UTC" });
  const opts: ApplyOpts = {
    dryRun: false,
    force: false,
    stdout: sink(),
    stderr: sink(),
    outPath: join(home, "generic-payload.json"),
    piSkillDir: join(home, "pi-skills"),
  };
  adapter.apply(adapter.plan(payload, env), payload, env, opts);
  return filesUnder(home)
    .map((file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

describe("the declared set is the set that actually writes host dimensions", () => {
  test("the population is the whole registry, so neither direction can be empty", () => {
    expect(INSTALL_TARGET_IDS.length).toBe(registerAllAdapters().list().length);
    expect(HOST_PAYLOAD_TARGETS.size).toBeGreaterThan(0);
    expect(HOST_PAYLOAD_TARGETS.size).toBeLessThan(INSTALL_TARGET_IDS.length);
  });

  test("an applied artifact carries --host-target exactly when the set says so", () => {
    const measured: string[] = [];
    for (const target of INSTALL_TARGET_IDS) {
      if (artifactsAfterApply(target).includes(HOST_TARGET_FLAG)) measured.push(target);
      // Each target gets a clean home, so one adapter's artifact cannot be
      // credited to the next.
      rmSync(home, { recursive: true, force: true });
      home = mkdtempSync(join(tmpdir(), "osb-payload-host-h-"));
    }
    expect(measured.toSorted()).toEqual([...HOST_PAYLOAD_TARGETS].toSorted());
  });

  test("a target outside the set is refused by name rather than silently transformed", () => {
    // The other direction of the same claim: an adapter that started
    // routing an undeclared target through here would fail loudly instead
    // of leaving the declaration quietly wrong.
    let message = "";
    try {
      payloadForHost(
        "generic",
        buildPayload({ vault, agent_name: "claude-vps", timezone: "UTC" }),
        installEnv(),
      );
    } catch (exc) {
      message = (exc as Error).message;
    }
    expect(message).toContain("generic");
    expect(message).toContain("HOST_PAYLOAD_TARGETS");
  });
});

describe("what update hashes is what gets written", () => {
  test("a member's hashed payload carries the dimensions", () => {
    const payload = buildPayload({ vault, agent_name: "claude-vps", timezone: "UTC" });
    const written = payloadAsWritten("cursor", payload, installEnv());
    expect(written.full.args).toContain(HOST_TARGET_FLAG);
    expect(written).toEqual(payloadForHost("cursor", payload, installEnv()));
  });

  test("a non-member's hashed payload is the canonical one, unchanged", () => {
    const payload = buildPayload({ vault, agent_name: "claude-vps", timezone: "UTC" });
    expect(payloadAsWritten("generic", payload, installEnv())).toEqual(payload);
  });
});

describe("the profile question distinguishes its two nulls", () => {
  test("a target that writes no command line answers null for the whole question", () => {
    for (const target of INSTALL_TARGET_IDS.filter((t) => !carriesHostDimensions(t))) {
      expect(`${target}: ${writtenToolProfile(target, installEnv())}`).toBe(`${target}: null`);
    }
  });

  test("a target with no declared profile answers a resolution whose value is null", () => {
    const resolved = writtenToolProfile("kiro", installEnv());
    expect(resolved).not.toBeNull();
    expect(resolved!.value).toBeNull();
    expect(resolved!.origin).toBe("default");
  });
});
