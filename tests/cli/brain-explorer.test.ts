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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { collectExplorerData, renderExportedHtml } from "../../src/core/brain/explorer.ts";
import { moveToRetired, writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_RETIRED_REASON } from "../../src/core/brain/types.ts";
import { REDACTION_PLACEHOLDER } from "../../src/core/redactor.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

/**
 * A vendor-prefixed credential shape, synthesised for this test. Caught by
 * shape rather than by a word list, which is why an obviously fake body is
 * enough to prove the boundary runs.
 */
const FAKE_VENDOR_TOKEN = fakeCredential("sk-", "live-FAKEEXAMPLE0000111122223333");

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
/**
 * Read `stream` until `marker` appears or the stream ends (the process
 * exited). Returns what was read either way, so a failure can show it.
 */
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: string,
): Promise<{ readonly found: boolean; readonly text: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes(marker)) {
      // Each read waits on the child's next write: there is nothing to batch.
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done) return { found: false, text };
      text += decoder.decode(chunk.value, { stream: true });
    }
    return { found: true, text };
  } finally {
    reader.releaseLock();
  }
}

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
    const r = await runCli(["brain", "explorer", "--vault", vault, "--export", out], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
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
    // The console sections travel with the template; on a static export
    // they state that the live routes are unreachable instead of firing
    // fetches that can only fail against a file path.
    expect(body).toContain('id="counts-body"');
    expect(body).toContain('id="ops-body"');
    expect(body).toContain("static export");
  });

  test("the exported graph goes through the shared egress guard", async () => {
    // The eighth egress site. Every other export path scans its bytes;
    // this one wrote the preference graph - principles verbatim - to an
    // operator-named path with no scan at all.
    await bootstrap();
    writePreference(vault, {
      slug: "secret-leak",
      topic: "secret-leak",
      principle: `Always deploy with OPENAI_API_KEY=${FAKE_VENDOR_TOKEN} set`,
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-2026-05-01-secret-leak]]"],
      confirmed_at: "2026-05-02T00:00:00Z",
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-05-02T00:00:00Z",
      confidence: "high",
      confidence_value: 0.8,
      pinned: false,
    });
    const out = join(tmp, "brain.html");
    const r = await runCli(["brain", "explorer", "--vault", vault, "--export", out], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const body = readFileSync(out, "utf8");
    expect(body).not.toContain(FAKE_VENDOR_TOKEN);
    expect(body).toContain(REDACTION_PLACEHOLDER);
    // stdout stays the parseable line it was; the notice goes to stderr.
    expect(r.stdout).toContain("exported");
    expect(r.stderr).toContain("no longer matches the vault byte for byte");
  });

  test("a preference that cannot be parsed refuses the export by name", async () => {
    // An export that omits a rule reads identically to a vault that never
    // had it, so the graph is not written at all.
    await bootstrap();
    seedOnePref();
    writeFileSync(join(vault, "Brain", "preferences", "pref-broken.md"), "no frontmatter here\n");
    const out = join(tmp, "brain.html");
    const r = await runCli(["brain", "explorer", "--vault", vault, "--export", out], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("pref-broken.md");
    expect(existsSync(out)).toBe(false);
  });

  test("refuses to overwrite without --force", async () => {
    await bootstrap();
    seedOnePref();
    const out = join(tmp, "brain.html");
    writeFileSync(out, "pre-existing");
    const r = await runCli(["brain", "explorer", "--vault", vault, "--export", out], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("exists");
    expect(readFileSync(out, "utf8")).toBe("pre-existing");
  });

  test("overwrites with --force", async () => {
    await bootstrap();
    seedOnePref();
    const out = join(tmp, "brain.html");
    writeFileSync(out, "pre-existing");
    const r = await runCli(["brain", "explorer", "--vault", vault, "--export", out, "--force"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(readFileSync(out, "utf8").startsWith("<!doctype html>")).toBe(true);
  });

  test("invalid --port values exit 1", async () => {
    await bootstrap();
    for (const port of ["garbage", "123abc"]) {
      const r = await runCli(["brain", "explorer", "--vault", vault, "--port", port], {
        env: { OPEN_SECOND_BRAIN_CONFIG: config },
      });
      expect(r.returncode).toBe(1);
      expect(r.stderr).toContain("invalid --port");
    }
  });
});

describe("o2b brain explorer --export privacy denials", () => {
  /**
   * Hand-add an informal privacy marker the same way an operator does:
   * a user-tier frontmatter line on the node's file.
   */
  function stampMarker(relPath: string, line: string): void {
    const abs = join(vault, relPath);
    writeFileSync(abs, readFileSync(abs, "utf8").replace(/^---\n/, `---\n${line}\n`));
  }

  function seedReservedPref(): void {
    writePreference(vault, {
      slug: "reserved",
      topic: "reserved",
      principle: "Reserved principle",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-2026-05-01-reserved]]"],
      confirmed_at: "2026-05-02T00:00:00Z",
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-05-02T00:00:00Z",
      confidence: "high",
      confidence_value: 0.8,
      pinned: false,
    });
    stampMarker("Brain/preferences/pref-reserved.md", "access: private");
  }

  test("a reserved preference is absent from the HTML and named on stderr", async () => {
    await bootstrap();
    seedOnePref();
    seedReservedPref();
    const out = join(tmp, "brain.html");
    const r = await runCli(["brain", "explorer", "--vault", vault, "--export", out], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const body = readFileSync(out, "utf8");
    expect(body).not.toContain("pref-reserved");
    expect(body).not.toContain("Reserved principle");
    // The unmarked rule still ships.
    expect(body).toContain("pref-explorer-seed");
    // The omission is disclosed on stderr, with the key that denied it.
    expect(r.stderr).toContain("pref-reserved");
    expect(r.stderr).toContain("(access)");
    expect(r.stderr).toContain("left out");
    // stderr only: the HTML names the omission as absence, not prose.
    expect(r.stdout).not.toContain("left out");
    // The count answers for what was written: one node exported, one
    // named as withheld on stderr.
    expect(r.stdout).toContain("exported 1 ");
  });

  test("a reserved retired entry is absent too", async () => {
    await bootstrap();
    seedOnePref();
    writePreference(vault, {
      slug: "old-reserved",
      topic: "old-reserved",
      principle: "Old reserved principle",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-2026-05-01-old-reserved]]"],
      confirmed_at: "2026-05-02T00:00:00Z",
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-05-02T00:00:00Z",
      confidence: "high",
      confidence_value: 0.8,
      pinned: false,
    });
    const deadPath = join(vault, "Brain", "preferences", "pref-old-reserved.md");
    moveToRetired(vault, deadPath, BRAIN_RETIRED_REASON.staleNoEvidence, {
      now: new Date("2026-05-10T00:00:00Z"),
      retired_by: "[[Brain/log/2026-05-10]]",
    });
    stampMarker("Brain/retired/ret-old-reserved.md", "sensitivity: confidential");

    const out = join(tmp, "brain.html");
    const r = await runCli(["brain", "explorer", "--vault", vault, "--export", out], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const body = readFileSync(out, "utf8");
    expect(body).not.toContain("ret-old-reserved");
    expect(body).not.toContain("Old reserved principle");
    expect(r.stderr).toContain("ret-old-reserved");
    expect(r.stderr).toContain("(sensitivity)");
  });

  test("an unmarked vault exports byte-identically to the shared collector's rendering", async () => {
    await bootstrap();
    seedOnePref();
    const out = join(tmp, "brain.html");
    const r = await runCli(["brain", "explorer", "--vault", vault, "--export", out], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    // No reservation held anything back, so the file is exactly what the
    // pre-denial pipeline rendered - the denial pass changed no bytes.
    const stripTimestamp = (s: string): string =>
      s.replace(/"generated_at":"[^"]*"/, '"generated_at":"X"');
    expect(stripTimestamp(readFileSync(out, "utf8"))).toBe(
      stripTimestamp(renderExportedHtml(collectExplorerData(vault))),
    );
    expect(r.stderr).not.toContain("left out");
  });
});

describe("o2b brain explorer (live) store group", () => {
  test("a failed lock probe keeps the errno and drops the host path from the reason", async () => {
    await bootstrap();
    seedOnePref();
    // A lock path that cannot even be stat'd: a symlink loop where the
    // lock directory would sit - the throw shape whose fs message
    // embeds the full resolved host path.
    const { resolveSearchConfig } = await import("../../src/core/search/index.ts");
    const lockPath = `${resolveSearchConfig({ vault, configPath: config }).dbPath}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    symlinkSync(lockPath, lockPath);

    const port = pickPort();
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/cli/main.ts",
        "brain",
        "explorer",
        "--vault",
        vault,
        "--port",
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPEN_SECOND_BRAIN_CONFIG: config },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const banner = await readUntil(proc.stdout, "Live explorer at ");
      if (!banner.found) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`explorer exited before listening:\n${banner.text}${stderr}`);
      }
      const res = await fetch(`http://127.0.0.1:${port}/status.json`);
      expect(res.ok).toBe(true);
      const status = JSON.parse(await res.text()) as {
        store: {
          writerLock: string;
          writerLockPath: string | null;
          writerLockReason: string | null;
        };
      };
      // The path is withheld from the field AND from the reason: the
      // browser surface answers below local reach for the whole store
      // group, not for one field of it. The errno stays - "could not
      // find out, and here is why".
      expect(status.store.writerLock).toBe("unknown");
      expect(status.store.writerLockPath).toBeNull();
      expect(status.store.writerLockReason).toContain("ELOOP");
      expect(status.store.writerLockReason).not.toContain(lockPath);
      expect(status.store.writerLockReason).not.toContain(tmpdir());
    } finally {
      proc.kill("SIGINT");
      await proc.exited;
    }
  }, 20000);
});

describe("o2b brain explorer (live)", () => {
  test(
    "binds to 127.0.0.1, serves all four routes, shuts down on SIGINT",
    async () => {
      await bootstrap();
      seedOnePref();
      const port = pickPort();
      // Spawn the CLI manually so we can poll the server and send SIGINT.
      // `cwd: process.cwd()` instead of a hard-coded path so the test
      // works from any checkout (CI, local clone, contributor laptop).
      const isolatedConfig = config;
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "src/cli/main.ts",
          "brain",
          "explorer",
          "--vault",
          vault,
          "--port",
          String(port),
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, OPEN_SECOND_BRAIN_CONFIG: isolatedConfig },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        // Wait for the CLI to say it is listening, not for a clock. It prints
        // the line only after the server is bound, so the first fetch cannot
        // race the boot. The fixed 3 s poll this replaces lost to a cold
        // `bun run src/cli/main.ts` on the Windows runner, and polling a port
        // nothing is bound to yet is not even a clean refusal everywhere
        // (WSL's mirrored loopback drops the SYN instead of refusing it).
        const banner = await readUntil(proc.stdout, "Live explorer at ");
        if (!banner.found) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(`explorer exited before listening:\n${banner.text}${stderr}`);
        }
        const r = await fetch(`http://127.0.0.1:${port}/`);
        expect(r.ok).toBe(true);
        const mainBody = await r.text();
        const d = await fetch(`http://127.0.0.1:${port}/data.json`);
        const dataBody = await d.text();
        expect(mainBody).toContain("Brain Explorer");
        expect(mainBody.includes("__GRAPH_JSON__")).toBe(false);
        const parsed = JSON.parse(dataBody);
        expect(parsed.nodes.length).toBe(1);
        // The counts and ops sections fetch the two console routes
        // client-side, in the page's own vanilla JS; the substituted
        // graph payload remains the page's single inline JSON block.
        expect(mainBody).toContain('id="counts-body"');
        expect(mainBody).toContain('id="ops-body"');
        expect(mainBody).toContain('fetchJson("/counts.json")');
        expect(mainBody).toContain('fetchJson("/status.json")');
        expect(mainBody.split('<script type="application/json" id="brain-data">').length).toBe(2);
        // The live-counts console routes (session-mining-economy): both
        // are loopback JSON re-read from the vault per GET.
        const countsRes = await fetch(`http://127.0.0.1:${port}/counts.json`);
        expect(countsRes.ok).toBe(true);
        const counts = JSON.parse(await countsRes.text()) as {
          schema_version: number;
          telemetry: { total: number };
          written_per_day: ReadonlyArray<unknown>;
          report_snapshots: unknown;
        };
        expect(counts.schema_version).toBe(1);
        expect(counts.telemetry.total).toBe(0);
        expect(counts.written_per_day.length).toBe(30);
        expect(counts.report_snapshots).toEqual({ status: "disabled" });
        const statusRes = await fetch(`http://127.0.0.1:${port}/status.json`);
        expect(statusRes.ok).toBe(true);
        const status = JSON.parse(await statusRes.text()) as {
          healthy: boolean;
          counts: { preferences: number };
          activeProfile: string | null;
          store: {
            writerLock: string;
            writerLockPath: string | null;
            writerLockOwner: string | null;
            thisCaller: string;
          };
        };
        expect(typeof status.healthy).toBe("boolean");
        expect(status.counts.preferences).toBe(1);
        // The explorer serves browsers, not the operator's own reach, so
        // the lock PATH is withheld the way the MCP surface withholds it
        // below local reach (a resolved host path is not a browser
        // client's fact) - while the rest of the store group stays. The
        // local CLI status keeps the path; that is pinned in status.test.
        expect(status.store.writerLockPath).toBeNull();
        expect(typeof status.store.writerLock).toBe("string");
        expect(status.store.thisCaller).toBe("read-only");
        // The verb threads its resolved config path into the server, so
        // the operator snapshot sees this run's profile registry.
        writeFileSync(
          join(dirname(config), "profiles.json"),
          JSON.stringify({ active: "test", profiles: { test: { vault } } }),
        );
        const profiled = await fetch(`http://127.0.0.1:${port}/status.json`);
        const profileStatus = JSON.parse(await profiled.text()) as {
          activeProfile: string | null;
        };
        expect(profileStatus.activeProfile).toBe("test");
      } finally {
        // Always tear the spawned CLI down so a failing assertion does
        // not leak the port into the next test on the same worker.
        try {
          proc.kill("SIGINT");
          await proc.exited;
        } catch {
          // process may have already exited or be in a weird state;
          // either way nothing else for us to do here.
        }
      }
    },
    CLI_SPAWN_BUDGET_MS,
  );

  test("port in use exits 1 with a friendly message", async () => {
    await bootstrap();
    // Hold a port the OS picked from inside the test process so the CLI
    // hits EADDRINUSE; a random pick can collide with a port another
    // process already holds, and then the blocker itself fails to bind.
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("blocker"),
    });
    const port = blocker.port;
    try {
      const r = await runCli(["brain", "explorer", "--vault", vault, "--port", String(port)], {
        env: { OPEN_SECOND_BRAIN_CONFIG: config },
      });
      expect(r.returncode).toBe(1);
      expect(r.stderr).toMatch(/already in use|in use/);
    } finally {
      blocker.stop();
    }
  });
});
