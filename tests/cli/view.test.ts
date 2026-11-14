/**
 * `o2b view` and the view writer claim of `o2b store init`: the creating
 * machine takes the role, `writer --here` asks for it, `--force` warns,
 * `render` writes the pages only on the writer, and `recover` lists and
 * prints replaced versions.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { VIEW_TARGET_ENV } from "../../src/core/view/constants.ts";
import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-view-cli-"));
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function env(device: string, root = join(parent, "store")): Record<string, string> {
  return {
    [STORE_ROOT_ENV]: root,
    [VIEW_TARGET_ENV]: join(parent, "view", device),
    O2B_DEVICE_ID: device,
    HOME: join(parent, "home", device),
    XDG_STATE_HOME: join(parent, "state", device),
    LOCALAPPDATA: join(parent, "state", device),
  };
}

describe("o2b view", () => {
  test("store init makes the creating machine the view writer, and render writes the pages", async () => {
    const init = await runCli(["store", "init", "--json"], { env: env("dev-a") });
    expect(init.returncode).toBe(0);
    expect(JSON.parse(init.stdout).viewWriter).toMatchObject({ claimed: true, device: "dev-a" });

    const shown = await runCli(["view", "writer", "--json"], { env: env("dev-a") });
    expect(JSON.parse(shown.stdout)).toMatchObject({ writer: "dev-a", pending: null });

    const first = await runCli(["view", "render"], { env: env("dev-a") });
    expect(first.stdout).toContain("renders from its next catch-up");
    const second = await runCli(["view", "render", "--json"], { env: env("dev-a") });
    expect(JSON.parse(second.stdout).status).toBe("rendered");
    expect(readFileSync(join(parent, "view", "dev-a", "about-me.md"), "utf8")).toContain(
      "# About me",
    );
  });

  test("another machine writes no page and names the writer; --force moves the role with a warning", async () => {
    await runCli(["store", "init"], { env: env("dev-a") });
    const rootB = join(parent, "store-b");
    cpSync(join(parent, "store"), rootB, { recursive: true });
    const b = env("dev-b", rootB);

    const render = await runCli(["view", "render"], { env: b });
    expect(render.stdout).toContain("the view writer is dev-a");

    const asked = await runCli(["view", "writer", "--here"], { env: b });
    expect(asked.stdout).toContain("Asked dev-a to hand the view writer role to dev-b");
    const forced = await runCli(["view", "writer", "--here", "--force"], { env: b });
    expect(forced.stdout).toContain("now renders the human view");
    expect(forced.stderr).toContain("may render the view once more");

    const usage = await runCli(["view", "writer", "--force"], { env: b });
    expect(usage.returncode).toBe(2);
  });

  test("recover lists replaced versions and prints one", async () => {
    await runCli(["store", "init"], { env: env("dev-a") });
    await runCli(["view", "render"], { env: env("dev-a") });
    await runCli(["view", "render"], { env: env("dev-a") });
    const page = join(parent, "view", "dev-a", "about-me.md");
    writeFileSync(page, `${readFileSync(page, "utf8")}- A line I added.\n`);
    await runCli(["view", "render"], { env: env("dev-a") });

    const listed = await runCli(["view", "recover", "about-me.md", "--json"], {
      env: env("dev-a"),
    });
    const versions = JSON.parse(listed.stdout).versions as Array<{ id: string; reason: string }>;
    expect(versions.map((v) => v.reason)).toEqual(["edit"]);
    const printed = await runCli(["view", "recover", "about-me.md", "--print", versions[0]!.id], {
      env: env("dev-a"),
    });
    expect(printed.stdout).toContain("- A line I added.");
    expect(readFileSync(page, "utf8")).toContain("- A line I added.");
  });

  test("a view folder inside the store is refused", async () => {
    await runCli(["store", "init"], { env: env("dev-a") });
    const r = await runCli(["view", "render"], {
      env: { ...env("dev-a"), [VIEW_TARGET_ENV]: join(parent, "store", "shared", "view") },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("is inside the brain store");
  });
});
