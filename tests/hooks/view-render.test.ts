/**
 * The `view-render` SessionStart hook: on the view writer it renders the
 * human view, prints nothing and exits 0; a failure is one line in the
 * device-local hook audit, and the hook still exits 0.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { initStore } from "../../src/core/store/store-init.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { deviceStateDirFor } from "../../src/core/store/store-paths.ts";
import { VIEW_AUTO_PASS_FILE, VIEW_STATE_DIR } from "../../src/core/view/constants.ts";
import { runViewPass } from "../../src/core/view/render.ts";
import { claimViewWriter } from "../../src/core/view/writer.ts";
import { homeEnv } from "../helpers/platform.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-view-hook-"));
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function env(view: string): Record<string, string> {
  const home = join(parent, "home");
  return {
    PATH: process.env["PATH"] ?? "",
    ...homeEnv(home),
    OPEN_SECOND_BRAIN_CONFIG: join(parent, "config.yaml"),
    OPEN_SECOND_BRAIN_STORE_ROOT: join(parent, "store"),
    OPEN_SECOND_BRAIN_VIEW_TARGET: view,
    O2B_DEVICE_ID: "dev-a",
    XDG_STATE_HOME: join(parent, "state"),
    LOCALAPPDATA: join(parent, "state"),
  };
}

async function runHook(view: string): Promise<{ stdout: string; exit: number }> {
  const proc = Bun.spawn(["bun", "run", join(HOOKS_DIR, "view-render.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: env(view),
  });
  proc.stdin.write(JSON.stringify({ hook_event_name: "SessionStart" }));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  return { stdout, exit: await proc.exited };
}

describe("view-render hook", () => {
  test("renders on the writer, prints nothing, and audits a failure while still exiting 0", async () => {
    const root = join(parent, "store");
    const { storeId } = initStore({ root });
    const dirs = {
      platform: process.platform,
      home: join(parent, "home"),
      env: { XDG_STATE_HOME: join(parent, "state"), LOCALAPPDATA: join(parent, "state") },
    };
    const store = openStore({ root, device: "dev-a", dirs });
    claimViewWriter(store, { agent: "t" });
    // The fresh claim's one catch-up of wait, so the hook's pass renders.
    expect(runViewPass(store, { target: null, vault: null, agent: "t" }).status).toBe(
      "waiting-for-claim",
    );

    const view = join(parent, "view");
    const ok = await runHook(view);
    expect(ok).toEqual({ stdout: "", exit: 0 });
    expect(existsSync(join(view, "about-me.md"))).toBe(true);

    // A view folder inside the store fails; the hook says nothing and audits it.
    // Clear the auto-pass throttle stamp so the second run is not throttled.
    rmSync(join(store.deviceStateDir, VIEW_STATE_DIR, VIEW_AUTO_PASS_FILE));
    const bad = await runHook(join(root, "shared", "view"));
    expect(bad).toEqual({ stdout: "", exit: 0 });
    const auditDir = join(deviceStateDirFor(storeId, dirs), "hook-audit");
    const lines = readdirSync(auditDir).flatMap((f) =>
      readFileSync(join(auditDir, f), "utf8").trim().split("\n"),
    );
    expect(lines.map((l) => JSON.parse(l) as { actor: string; ok: boolean })).toMatchObject([
      { actor: "view-render", ok: false },
    ]);
  });
});
