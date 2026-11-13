/**
 * `o2b store partition leave` (design D7 item 5 of change `store-hardening`):
 * the CLI contract only. Each refusal reason exits 1 and names itself in
 * the `--json` envelope, answers exit 0, and a lost partition that names
 * the verb is what `store device list` prints. The state effects behind
 * the reasons are proven in `tests/core/store/partition-leave.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";

// Every test here runs the CLI, most of them several times.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let parent: string;
let root: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-store-partition-"));
  root = join(parent, "store");
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function env(): Record<string, string> {
  return {
    [STORE_ROOT_ENV]: root,
    HOME: join(parent, "home"),
    XDG_STATE_HOME: join(parent, "state"),
    LOCALAPPDATA: join(parent, "state"),
    OPEN_SECOND_BRAIN_CONFIG: join(parent, "config.yaml"),
    O2B_DEVICE_ID: "dev-a",
  };
}

/** Every test starts from a store this machine initialized and opened. */
async function initedStore(): Promise<void> {
  const r = await runCli(["store", "init"], { env: env(), stdin: "" });
  expect(r.returncode).toBe(0);
}

describe("o2b store partition leave", () => {
  test("a lost private partition fails closed and names the verb", async () => {
    await initedStore();
    rmSync(join(root, "private"), { recursive: true, force: true });
    const r = await runCli(["store", "device", "list"], { env: env(), stdin: "" });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("o2b store partition leave private");
  });

  test("refusals exit 1 and name their reason", async () => {
    await initedStore();
    // name, setup, argv
    const cases: Array<{
      name: string;
      setup?: () => void;
      argv: Array<string>;
    }> = [
      { name: "shared", argv: ["store", "partition", "leave", "shared"] },
      { name: "still-held", argv: ["store", "partition", "leave", "private"] },
      {
        name: "files-left",
        setup: () => rmSync(join(root, "private", "store.json")),
        argv: ["store", "partition", "leave", "private"],
      },
      {
        name: "files-left on an unlistable folder",
        setup: () => {
          rmSync(join(root, "private"), { recursive: true, force: true });
          writeFileSync(join(root, "private"), "a sync conflict landed here\n");
        },
        argv: ["store", "partition", "leave", "private"],
      },
      {
        name: "no-store-id",
        setup: () => {
          rmSync(join(root, "private"), { recursive: true, force: true });
          writeFileSync(join(root, "shared", "store.json"), "{");
        },
        argv: ["store", "partition", "leave", "private"],
      },
    ];
    for (const { name, setup, argv } of cases) {
      setup?.();
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      const text = await runCli(argv, { env: env(), stdin: "" });
      expect(text.returncode, name).toBe(1);
      expect(text.stderr.startsWith("error: "), name).toBe(true);
      expect(text.stdout, name).toBe("");
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      const j = await runCli([...argv, "--json"], { env: env(), stdin: "" });
      expect(j.returncode, name).toBe(1);
      const body = JSON.parse(j.stdout) as { ok: boolean; reason: string };
      expect(body.ok, name).toBe(false);
      expect(body.reason, name).toBe(name.split(" ")[0] ?? name);
    }
  });

  test("--force turns the files-left refusal into a leave", async () => {
    await initedStore();
    rmSync(join(root, "private", "store.json"));
    const j = await runCli(["store", "partition", "leave", "private", "--force", "--json"], {
      env: env(),
      stdin: "",
    });
    expect(j.returncode).toBe(0);
    const body = JSON.parse(j.stdout) as { ok: boolean; left: boolean };
    expect(body.ok).toBe(true);
    expect(body.left).toBe(true);
  });

  test("a store root inside the vault is refused", async () => {
    await initedStore();
    const vault = join(parent, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(parent, "config.yaml"), `vault: ${vault}\n`);
    const e = env();
    e[STORE_ROOT_ENV] = join(vault, "store");
    const j = await runCli(["store", "partition", "leave", "private", "--json"], {
      env: e,
      stdin: "",
    });
    expect(j.returncode).toBe(1);
    const body = JSON.parse(j.stdout) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("store-root-in-vault");
  });

  test("a config that cannot be read is refused", async () => {
    await initedStore();
    mkdirSync(join(parent, "config.yaml"), { recursive: true });
    const j = await runCli(["store", "partition", "leave", "private", "--json"], {
      env: env(),
      stdin: "",
    });
    expect(j.returncode).toBe(1);
    const body = JSON.parse(j.stdout) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("config");
  });

  test("leaving private", async () => {
    await initedStore();
    rmSync(join(root, "private"), { recursive: true, force: true });
    const j = await runCli(["store", "partition", "leave", "private", "--json"], {
      env: env(),
      stdin: "",
    });
    expect(j.returncode).toBe(0);
    const body = JSON.parse(j.stdout) as {
      ok: boolean;
      left: boolean;
      partition: string;
      cleared: { held_marker: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.left).toBe(true);
    expect(body.partition).toBe("private");
    expect(body.cleared.held_marker).toBe(true);
    const list = await runCli(["store", "device", "list"], { env: env(), stdin: "" });
    expect(list.returncode).toBe(0);
  });

  test("the text answer", async () => {
    await initedStore();
    rmSync(join(root, "private"), { recursive: true, force: true });
    const r = await runCli(["store", "partition", "leave", "private"], { env: env(), stdin: "" });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("Left the private partition");
    expect(r.stdout).toContain("next catch-up");
    expect(r.stdout).toContain("holds the private partition again");
  });

  test("leaving twice", async () => {
    await initedStore();
    rmSync(join(root, "private"), { recursive: true, force: true });
    await runCli(["store", "partition", "leave", "private", "--json"], { env: env(), stdin: "" });
    const second = await runCli(["store", "partition", "leave", "private", "--json"], {
      env: env(),
      stdin: "",
    });
    expect(second.returncode).toBe(0);
    const body = JSON.parse(second.stdout) as { left: boolean };
    expect(body.left).toBe(false);
    const text = await runCli(["store", "partition", "leave", "private"], {
      env: env(),
      stdin: "",
    });
    expect(text.stdout).toContain("nothing to leave");
  });

  test("usage errors", async () => {
    await initedStore();
    const cases: Array<Array<string>> = [
      ["store", "partition", "leave"],
      ["store", "partition", "leave", "bogus"],
      ["store", "partition", "leave", "private", "extra"],
      ["store", "partition"],
    ];
    for (const argv of cases) {
      const r = await runCli(argv, { env: env(), stdin: "" });
      expect(r.returncode).toBe(2);
      expect(r.stderr.startsWith("error: ")).toBe(true);
      expect(r.stderr).toContain("usage: o2b store partition leave");
      const j = await runCli([...argv, "--json"], { env: env(), stdin: "" });
      const body = JSON.parse(j.stdout) as { ok: boolean; reason: string; error: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("usage");
      expect(typeof body.error).toBe("string");
    }
  });
});
