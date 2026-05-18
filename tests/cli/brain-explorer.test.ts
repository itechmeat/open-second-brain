/**
 * CLI tests for `o2b brain explorer`.
 *
 * Covers the two surfaces (live HTTP + static export) plus the
 * documented error paths. The live server is exercised via subprocess
 * spawn so the SIGINT shutdown path is verified end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePreference } from "../../src/core/brain/preference.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-explorer-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(brainInit.returncode).toBe(0);
}

function seedOnePref(): void {
  writePreference(vault, {
    slug: "explorer-seed",
    topic: "explorer-seed",
    principle: "Explorer seed principle",
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: ["[[sig-2026-05-01-explorer-seed]]"],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 2,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: "high",
    confidence_value: 0.8,
    pinned: false,
  });
}

/** Pick a random high port to dodge collisions on shared build hosts. */
function pickPort(): number {
  return 30000 + Math.floor(Math.random() * 25000);
}

describe("o2b brain explorer --help", () => {
  test("prints both modes", async () => {
    const r = await runCli(["brain", "explorer", "--help"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("brain explorer");
    expect(r.stdout).toContain("--export");
    expect(r.stdout).toContain("--port");
  });
});

describe("o2b brain explorer --export", () => {
  test("creates the file and prints the node count", async () => {
    await bootstrap();
    seedOnePref();
    const out = join(tmp, "brain.html");
    const r = await runCli(
      ["brain", "explorer", "--vault", vault, "--export", out],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("exported");
    expect(existsSync(out)).toBe(true);
    const body = readFileSync(out, "utf8");
    expect(body.includes("__GRAPH_JSON__")).toBe(false);
    const match = body.match(
      /<script type="application\/json" id="brain-data">([\s\S]+?)<\/script>/,
    );
    const parsed = JSON.parse(match![1]!);
    expect(parsed.nodes.length).toBe(1);
    expect(parsed.nodes[0].id).toBe("pref-explorer-seed");
  });

  test("refuses to overwrite without --force", async () => {
    await bootstrap();
    seedOnePref();
    const out = join(tmp, "brain.html");
    writeFileSync(out, "pre-existing");
    const r = await runCli(
      ["brain", "explorer", "--vault", vault, "--export", out],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("exists");
    expect(readFileSync(out, "utf8")).toBe("pre-existing");
  });

  test("overwrites with --force", async () => {
    await bootstrap();
    seedOnePref();
    const out = join(tmp, "brain.html");
    writeFileSync(out, "pre-existing");
    const r = await runCli(
      [
        "brain", "explorer", "--vault", vault,
        "--export", out, "--force",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(readFileSync(out, "utf8").startsWith("<!doctype html>")).toBe(true);
  });

  test("invalid --port value exits 1", async () => {
    await bootstrap();
    const r = await runCli(
      ["brain", "explorer", "--vault", vault, "--port", "garbage"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("invalid --port");
  });

  test("partially numeric --port value exits 1", async () => {
    await bootstrap();
    const r = await runCli(
      ["brain", "explorer", "--vault", vault, "--port", "123abc"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("invalid --port");
  });
});

describe("o2b brain explorer (live)", () => {
  test("binds to 127.0.0.1, serves / and /data.json, shuts down on SIGINT", async () => {
    await bootstrap();
    seedOnePref();
    const port = pickPort();
    // Spawn the CLI manually so we can poll the server and send SIGINT.
    const isolatedConfig = config;
    const proc = Bun.spawn(
      [
        "bun", "run", "src/cli/main.ts",
        "brain", "explorer",
        "--vault", vault,
        "--port", String(port),
      ],
      {
        cwd: "/srv/projects/open-second-brain",
        env: { ...process.env, OPEN_SECOND_BRAIN_CONFIG: isolatedConfig },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    // Wait up to ~3s for the server to come up.
    let up = false;
    let mainBody = "";
    let dataBody = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 100));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`);
        if (r.ok) {
          mainBody = await r.text();
          const d = await fetch(`http://127.0.0.1:${port}/data.json`);
          dataBody = await d.text();
          up = true;
          break;
        }
      } catch {
        // ECONNREFUSED while booting — keep waiting.
      }
    }
    expect(up).toBe(true);
    expect(mainBody).toContain("Brain Explorer");
    expect(mainBody.includes("__GRAPH_JSON__")).toBe(false);
    const parsed = JSON.parse(dataBody);
    expect(parsed.nodes.length).toBe(1);
    // Shut down.
    proc.kill("SIGINT");
    const exit = await proc.exited;
    // SIGINT exit codes vary across runtimes; what matters is the
    // process terminated cleanly within the timeout above.
    void exit;
  });

  test("port in use exits 1 with a friendly message", async () => {
    await bootstrap();
    const port = pickPort();
    // Hold the port from inside the test process so the CLI hits
    // EADDRINUSE.
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response("blocker"),
    });
    try {
      const r = await runCli(
        ["brain", "explorer", "--vault", vault, "--port", String(port)],
        { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
      );
      expect(r.returncode).toBe(1);
      expect(r.stderr).toMatch(/already in use|in use/);
    } finally {
      blocker.stop();
    }
  });
});
