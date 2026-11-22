/**
 * The creating installation becomes the dream owner (design D5) and a
 * brain from before the capability keeps working until it is adopted
 * (design D6): `o2b init` and `o2b store init` that create the store
 * claim; no agent name claims nothing and says how to choose; attaching
 * and initialising again change nothing; a declared `primary_agent` with
 * no owner runs live passes from any device and is named as requested;
 * `--here` adopts; a legacy-tree brain reports that ownership starts with
 * the store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimDreamOwnerOnCreate } from "../../src/core/brain/dream-owner/create.ts";
import { readDreamOwner } from "../../src/core/brain/dream-owner/owner.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
let configPath: string;
let storeRoot: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-dream-owner-create-"));
  configPath = join(parent, "config.yaml");
  storeRoot = join(parent, "store");
  writeFileSync(configPath, "");
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function cli(device: string, args: string[], extra: Record<string, string> = {}) {
  return runCli(args, {
    env: {
      OPEN_SECOND_BRAIN_CONFIG: configPath,
      [STORE_ROOT_ENV]: storeRoot,
      O2B_DEVICE_ID: device,
      HOME: join(parent, "home"),
      XDG_STATE_HOME: join(parent, "state"),
      LOCALAPPDATA: join(parent, "state"),
      ...extra,
    },
  });
}

const owner = () =>
  readDreamOwner(
    openStore({
      root: storeRoot,
      device: "dev-x",
      dirs: {
        platform: process.platform,
        home: join(parent, "home"),
        env: { XDG_STATE_HOME: join(parent, "state"), LOCALAPPDATA: join(parent, "state") },
      },
    }),
  ).owner;

describe("creation claims the dream owner", () => {
  test("o2b init with an agent name creates the brain and claims", async () => {
    const r = await cli("dev-a", ["init", "--agent-name", "claude"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("own dream on this brain");
    expect(owner()).toMatchObject({ device: "dev-a", agent: "claude" });
  });

  test("o2b init --vault on a fresh vault claims", async () => {
    const vault = join(parent, "vault");
    mkdirSync(vault);
    const r = await cli("dev-a", ["init", "--vault", vault, "--agent-name", "codex"]);
    expect(r.returncode).toBe(0);
    expect(owner()).toMatchObject({ device: "dev-a", agent: "codex" });
  });

  test("creating with no agent name claims nothing and prints how to choose", async () => {
    const r = await cli("dev-a", ["init"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("No dream owner was bound");
    expect(r.stdout).toContain("o2b dream owner --here --agent <name>");
    expect(owner()).toBeNull();
  });

  test("attaching a second device and initialising again change nothing", async () => {
    await cli("dev-a", ["init", "--agent-name", "claude"]);
    // A second device attaches (the store already exists) and runs init again.
    const second = await cli("dev-b", ["init", "--agent-name", "codex"]);
    expect(second.returncode).toBe(0);
    const again = await cli("dev-a", ["init", "--agent-name", "hermes"]);
    expect(again.returncode).toBe(0);
    expect(owner()).toMatchObject({ device: "dev-a", agent: "claude" });
    const status = JSON.parse((await cli("dev-b", ["dream", "owner", "--json"])).stdout);
    expect(status).toMatchObject({ is_owner: false, owner: { device: "dev-a" } });
  });

  test("o2b store init that creates the store claims; one that attaches does not", async () => {
    writeFileSync(configPath, "agent_name: claude\n");
    const created = await cli("dev-a", ["store", "init", "--json"]);
    expect(created.returncode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ dreamOwner: { claimed: true } });
    expect(owner()).toMatchObject({ device: "dev-a", agent: "claude" });
    const attached = await cli("dev-b", ["store", "init", "--json"]);
    expect(owner()).toMatchObject({ device: "dev-a" });
    expect(JSON.parse(attached.stdout)["dreamOwner"] ?? null).toBeNull();
  });
});

describe("a brain from before the capability", () => {
  test("a declared primary_agent with no owner runs live passes anywhere and is named as requested", async () => {
    initStore({ root: storeRoot });
    writeFileSync(configPath, "agent_name: codex\n");
    expect((await cli("dev-a", ["brain", "set-primary", "hermes"])).returncode).toBe(0);
    const pass = await cli("dev-b", ["brain", "dream", "--json"]);
    expect(pass.returncode).toBe(0);
    const status = JSON.parse((await cli("dev-b", ["dream", "owner", "--json"])).stdout);
    expect(status).toMatchObject({ owner: null, declared_primary_agent: "hermes" });
    const text = (await cli("dev-b", ["dream", "owner"])).stdout;
    expect(text).toContain("No dream owner is bound");
    expect(text).toContain("The declared primary_agent (hermes) is the requested owner");
  });

  test("--here adopts it, and from then on other devices refuse live passes", async () => {
    initStore({ root: storeRoot });
    writeFileSync(configPath, "agent_name: hermes\n");
    expect((await cli("dev-a", ["dream", "owner", "--here"])).returncode).toBe(0);
    expect(owner()).toMatchObject({ device: "dev-a", agent: "hermes" });
    const refused = await cli("dev-b", ["brain", "dream"]);
    expect(refused.returncode).toBe(1);
    expect(refused.stderr).toContain("not the dream owner");
  });

  test("a brain on the legacy tree reports that ownership starts with the store", async () => {
    const vault = join(parent, "legacy");
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
    const res = await cli("dev-a", ["dream", "owner", "--json"]);
    expect(JSON.parse(res.stdout)).toMatchObject({ enforced: false, reason: "legacy-tree" });
    expect((await cli("dev-a", ["dream", "owner"])).stdout).toContain(
      "enforced once the brain moves to the store",
    );
  });
});

describe("a claim that fails after the store was created", () => {
  test.skipIf(CHMOD_CANNOT_DENY)(
    "a filesystem error on the claim write is a warning, not a refusal",
    () => {
      initStore({ root: storeRoot });
      writeFileSync(configPath, "agent_name: claude\n");
      const shared = join(storeRoot, "shared");
      chmodSync(shared, 0o500);
      try {
        const result = claimDreamOwnerOnCreate(storeRoot, configPath);
        expect(result.claimed).toBe(false);
        expect(result.message).toContain("No dream owner was bound");
        expect(result.message).toContain("EACCES");
        expect(result.message).toContain("o2b dream owner --here --agent <name>");
      } finally {
        chmodSync(shared, 0o700);
      }
      expect(owner()).toBeNull();
    },
  );
});
