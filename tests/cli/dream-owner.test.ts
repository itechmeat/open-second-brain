/**
 * `o2b dream owner` (design D4, spec "Ownership is transferred by one
 * operation"): status on an unbound brain, on the owner's device, on
 * another device and with a pending request; adoption; an agent change;
 * a request released by the owner's next look; `--release`; `--force`; a
 * second transfer after one made on the command line; two requests and
 * the loser's answer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { takeDreamOwner } from "../../src/core/brain/dream-owner/owner.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { startDreamPassHolder } from "../helpers/dream-pass-holder.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
let storeRoot: string;
let configPath: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-dream-owner-cli-"));
  storeRoot = join(parent, "store");
  configPath = join(parent, "config.yaml");
  writeFileSync(configPath, "agent_name: claude\n");
  initStore({ root: storeRoot });
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function owner(device: string, ...args: string[]) {
  return runCli(["dream", "owner", ...args], {
    env: {
      OPEN_SECOND_BRAIN_CONFIG: configPath,
      [STORE_ROOT_ENV]: storeRoot,
      O2B_DEVICE_ID: device,
      OPEN_SECOND_BRAIN_LOCK_WAIT_MS: "100",
    },
  });
}

async function status(device: string): Promise<Record<string, unknown>> {
  const res = await owner(device, "--json");
  expect(res.returncode).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

describe("o2b dream owner", () => {
  test("an unbound brain: text and --json say no owner is bound", async () => {
    const text = await owner("dev-a");
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("No dream owner is bound");
    expect(await status("dev-a")).toMatchObject({
      ok: true,
      enforced: true,
      owner: null,
      is_owner: false,
      device: "dev-a",
    });
  });

  test("--here adopts an unbound brain; status on the owner's device and on another", async () => {
    const res = await owner("dev-a", "--here");
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("is the dream owner now, with agent claude");
    expect(await status("dev-a")).toMatchObject({
      owner: { device: "dev-a", agent: "claude" },
      is_owner: true,
    });
    const other = await owner("dev-b");
    expect(other.stdout).toContain("The dream owner is dev-a (agent claude)");
    expect(other.stdout).toContain("is not the owner");
    expect(await status("dev-b")).toMatchObject({ owner: { device: "dev-a" }, is_owner: false });
  });

  test("--here --agent on the owner's device changes the agent at once", async () => {
    await owner("dev-a", "--here");
    const res = await owner("dev-a", "--here", "--agent", "codex", "--json");
    expect(JSON.parse(res.stdout)).toMatchObject({ status: "agent-changed", agent: "codex" });
    expect(await status("dev-b")).toMatchObject({ owner: { device: "dev-a", agent: "codex" } });
  });

  test("--here on another device records a request; the owner's status releases it", async () => {
    await owner("dev-a", "--here");
    const res = await owner("dev-b", "--here", "--agent", "codex");
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("The request is pending");
    const pending = await status("dev-b");
    expect(pending).toMatchObject({
      owner: { device: "dev-a" },
      pending: { device: "dev-b", agent: "codex" },
      own_request: "pending",
    });
    expect((await owner("dev-c")).stdout).toContain("A transfer to dev-b");
    // The owner's device looks: it hands the role over.
    const look = await owner("dev-a");
    expect(look.stdout).toContain("handed the role to dev-b");
    expect(await status("dev-b")).toMatchObject({
      owner: { device: "dev-b", agent: "codex" },
      is_owner: true,
      pending: null,
    });
  });

  test("--release gives the role up; another device may not", async () => {
    await owner("dev-a", "--here");
    const refused = await owner("dev-b", "--release");
    expect(refused.returncode).toBe(1);
    expect(refused.stderr).toContain("is not the dream owner");
    const res = await owner("dev-a", "--release");
    expect(res.returncode).toBe(0);
    expect(await status("dev-b")).toMatchObject({ owner: null });
  });

  test("--release while a live pass holds the pass lock is a refusal, in --json too", async () => {
    await owner("dev-a", "--here");
    // A pass in progress on this device, in another process.
    const holder = await startDreamPassHolder(
      openStore({ root: storeRoot, device: "dev-a" }),
      60_000,
    );
    try {
      const res = await owner("dev-a", "--release", "--json");
      expect(res.returncode).toBe(1);
      expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, reason: "lock-busy" });
      expect(res.stderr).toContain("dream pass lock busy");
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
    expect(await status("dev-b")).toMatchObject({ owner: { device: "dev-a" } });
  });

  test("--force takes the role at once and warns", async () => {
    await owner("dev-a", "--here");
    const res = await owner("dev-b", "--here", "--force");
    expect(res.returncode).toBe(0);
    expect(res.stderr).toContain("warning:");
    expect(res.stderr).toContain("until its first catch-up");
    expect(await status("dev-a")).toMatchObject({ owner: { device: "dev-b" }, is_owner: false });
  });

  test("a transfer by an agent after one made on the command line succeeds", async () => {
    await owner("dev-a", "--here");
    // An agent (through the core operation MCP calls) changes the agent.
    const result = takeDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), "hermes", {
      writer: "hermes",
      authority: "agent",
      force: false,
    });
    expect(result.status).toBe("agent-changed");
    expect(await status("dev-a")).toMatchObject({ owner: { agent: "hermes" } });
  });

  test("two devices request and the owner releases: the loser is told", async () => {
    await owner("dev-a", "--here");
    await owner("dev-b", "--here");
    await owner("dev-c", "--here");
    await owner("dev-a");
    expect(await status("dev-c")).toMatchObject({ owner: { device: "dev-c" }, is_owner: true });
    const loser = await status("dev-b");
    expect(loser).toMatchObject({ owner: { device: "dev-c" }, own_request: "lost" });
    const text = await owner("dev-b");
    expect(text.stdout).toContain("request for the role lost: the role went to dev-c");
  });

  test("usage errors exit 2", async () => {
    expect((await owner("dev-a", "--force")).returncode).toBe(2);
    expect((await owner("dev-a", "--here", "--release")).returncode).toBe(2);
    expect((await owner("dev-a", "--agent", "x")).returncode).toBe(2);
  });
});
