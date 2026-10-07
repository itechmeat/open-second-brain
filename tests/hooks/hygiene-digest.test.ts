/**
 * Spawn-based tests for the Stop hygiene-digest hook
 * (context-injection-pipeline, lane B, task B3).
 *
 * The hook is opt-in (`hygiene_digest_enabled`, default OFF), gated to
 * turns that wrote an artifact, surfaces the default hygiene sweep plus
 * the dangling-link count as ONE line, and emits a given state once per
 * change via the vault-level hash ledger. Every gate and failure path
 * exits 0 silently.
 *
 * The fixture vault holds one contested truth slot, so the default sweep
 * deterministically reports a single `conflicts` finding (severity
 * `warning`) - the smallest eligible population the composer accepts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appendClaimEvent } from "../../src/core/brain/truth/store.ts";
import {
  HYGIENE_DIGEST_HASH_FILENAME,
  computeHygieneDigestHash,
  hygieneDigestHashPath,
} from "../../hooks/lib/hygiene-digest-state.ts";
import {
  HYGIENE_DIGEST_POINTER,
  HYGIENE_DIGEST_SEVERITIES,
} from "../../hooks/lib/hygiene-digest-text.ts";
import { homeEnv } from "../helpers/platform.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "hygiene-digest.ts",
);

const FLAG_ON = { OPEN_SECOND_BRAIN_HYGIENE_DIGEST_ENABLED: "true" };

/**
 * Modules a flag-off run must never load: the detector sweep and the
 * search index are the whole cost of this hook, so the flag gate must
 * come before they are imported (lazy imports after the gates).
 */
const HEAVY_MODULE_SUFFIXES = [
  "/brain/hygiene/scan.ts",
  "/search/link-ratchet.ts",
  "/search/index.ts",
  "/brain/hygiene/detectors/conflicts.ts",
];

/** Preload that reports every loaded module path on stderr at exit. */
const LOADED_PROBE = `process.on("exit", () => {
  process.stderr.write("LOADED:" + JSON.stringify(Object.keys(require.cache)) + "\\n");
});
`;

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-digest-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hygiene-digest-home-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Two contested claims for one slot: one deterministic `conflicts` finding. */
function seedConflict(): void {
  const now = Date.now();
  appendClaimEvent(vault, {
    ts: new Date(now - 48 * 3_600_000).toISOString(),
    agent: "agent-a",
    entity: "Acme Corp",
    aspect: "headquarters",
    value: "Berlin",
    source: "[[note-a]]",
  });
  appendClaimEvent(vault, {
    ts: new Date(now - 24 * 3_600_000).toISOString(),
    agent: "agent-b",
    entity: "Acme Corp",
    aspect: "headquarters",
    value: "Lisbon",
    source: "[[note-b]]",
  });
}

function ccUser(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function ccAssistantToolUse(name: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_" + name, name, input }],
    },
  });
}

function writeTranscript(path: string, lines: readonly string[]): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

/** A claudecode-shaped transcript path, under the throwaway home. */
function claudeTranscript(withArtifact: boolean): string {
  const lines = withArtifact
    ? [ccUser("please add a file"), ccAssistantToolUse("Write", { file_path: "/tmp/x.md" })]
    : [ccUser("what is in the README?"), ccAssistantToolUse("Read", { file_path: "/tmp/x.md" })];
  return writeTranscript(join(configHome, ".claude", "projects", "session.jsonl"), lines);
}

function stopPayload(transcriptPath: string, extra: Record<string, unknown> = {}): unknown {
  return {
    hook_event_name: "Stop",
    transcript_path: transcriptPath,
    stop_hook_active: false,
    ...extra,
  };
}

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

async function runHook(
  payload: unknown,
  env: Record<string, string> = {},
  preload: ReadonlyArray<string> = [],
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", ...preload, HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: configHome,
    env: {
      PATH: process.env["PATH"] ?? "",
      ...homeEnv(configHome),
      VAULT_DIR: vault,
      ...env,
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, stderr, exit };
}

describe("hygiene-digest hook", () => {
  test("flag off: no stdout, no ledger write, and the scan is never invoked", async () => {
    seedConflict();
    const probe = join(configHome, "loaded-probe.ts");
    writeFileSync(probe, LOADED_PROBE, "utf8");
    const transcript = claudeTranscript(true);
    const r = await runHook(stopPayload(transcript), {}, ["--preload", probe]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(hygieneDigestHashPath(vault))).toBe(false);
    const line = r.stderr.split("\n").find((l) => l.startsWith("LOADED:"));
    expect(line).toBeDefined();
    const loaded = (JSON.parse(line!.slice("LOADED:".length)) as string[]).map((path) =>
      path.replaceAll("\\", "/"),
    );
    expect(loaded.some((path) => path.endsWith("/hooks/hygiene-digest.ts"))).toBe(true);
    for (const suffix of HEAVY_MODULE_SUFFIXES) {
      expect(loaded.filter((path) => path.endsWith(suffix))).toEqual([]);
    }
  });

  test("flag on, eligible findings, artifact-writing turn: exactly one line and the ledger is written", async () => {
    seedConflict();
    const transcript = claudeTranscript(true);
    const r = await runHook(stopPayload(transcript), FLAG_ON);
    expect(r.exit).toBe(0);
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout.trim()).not.toBe("");
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
    const line = parsed.hookSpecificOutput.additionalContext;
    expect(line.includes("\n")).toBe(false);
    expect(line.startsWith("Open Second Brain hygiene:")).toBe(true);
    expect(line).toContain("1 conflicts");
    expect(line.endsWith(HYGIENE_DIGEST_POINTER)).toBe(true);
    const hashPath = hygieneDigestHashPath(vault);
    expect(existsSync(hashPath)).toBe(true);
    expect(readFileSync(hashPath, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The eligible findings a fresh in-process sweep reports for the
   * fixture vault, the same population the hook just hashed: one
   * deterministic `conflicts` warning.
   */
  async function fixtureEligibleFindings() {
    const { runHygieneScan } = await import("../../src/core/brain/hygiene/scan.ts");
    const findings = runHygieneScan(vault, { now: new Date() }).findings;
    expect(
      findings.filter((f) => HYGIENE_DIGEST_SEVERITIES.includes(f.severity)).map((f) => f.detector),
    ).toEqual(["conflicts"]);
    return findings;
  }

  test("a vault with no search index records the null-dangling hash, never a zero-flattened one", async () => {
    seedConflict();
    const transcript = claudeTranscript(true);
    const r = await runHook(stopPayload(transcript), FLAG_ON);
    expect(r.exit).toBe(0);
    expect(r.stdout).not.toBe("");
    const findings = await fixtureEligibleFindings();
    const recorded = readFileSync(hygieneDigestHashPath(vault), "utf8").trim();
    // The index is absent, so the count is UNMEASURED: the recorded state
    // keeps `danglingLinks: null` and is never flattened into a zero.
    expect(recorded).toBe(computeHygieneDigestHash({ findings, danglingLinks: null }));
    expect(recorded).not.toBe(computeHygieneDigestHash({ findings, danglingLinks: 0 }));
  });

  test("a throwing search config degrades to an unmeasured dangling count and the digest still emits", async () => {
    seedConflict();
    const transcript = claudeTranscript(true);
    // An out-of-range env twin makes resolveSearchConfig throw before the
    // measurement runs; the digest must survive it with the count omitted.
    const r = await runHook(stopPayload(transcript), {
      ...FLAG_ON,
      OPEN_SECOND_BRAIN_SEARCH_CHUNK_SIZE: "0",
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).not.toBe("");
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const line = parsed.hookSpecificOutput.additionalContext;
    expect(line).toContain("1 conflicts");
    // The pointer names the dangling-links surface, so the segment check
    // is numeric: no "<n> dangling links" count may appear.
    expect(line).not.toMatch(/\d dangling links/);
    const findings = await fixtureEligibleFindings();
    const recorded = readFileSync(hygieneDigestHashPath(vault), "utf8").trim();
    expect(recorded).toBe(computeHygieneDigestHash({ findings, danglingLinks: null }));
  });

  test("a stdout write that fails records no ledger hash: the emit lands before the ledger", async () => {
    seedConflict();
    const payloadPath = join(configHome, "payload.json");
    writeFileSync(payloadPath, JSON.stringify(stopPayload(claudeTranscript(true))), "utf8");
    // A completed run cannot tell a landed emit from a lost one, so the
    // hook is driven with a stdout pipe that is already closed: `head
    // -c0` exits before the hook starts and its single write hits EPIPE
    // in a real process (the stdout-epipe-guard precedent). The delay
    // makes the close deterministic; bash's pipefail carries the hook's
    // own exit past head.
    const script =
      "set -o pipefail; sleep 0.3; " +
      `bun run ${JSON.stringify(HOOK)} < ${JSON.stringify(payloadPath)}` +
      " | head -c0 >/dev/null";
    const proc = Bun.spawn(["bash", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env["PATH"] ?? "",
        ...homeEnv(configHome),
        VAULT_DIR: vault,
        ...FLAG_ON,
      },
    });
    const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    // The hook never deadlocks on its own failure: the write error is
    // silenced by the fail-soft catch and exits 0.
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    // The line never landed: recording the hash here would silence this
    // exact state until the findings change, so the ledger stays empty
    // and the next eligible turn re-emits (lose-not-duplicate).
    expect(existsSync(hygieneDigestHashPath(vault))).toBe(false);
  }, 20_000);

  test("an immediate second identical run is silent", async () => {
    seedConflict();
    const transcript = claudeTranscript(true);
    const first = await runHook(stopPayload(transcript), FLAG_ON);
    expect(first.stdout).not.toBe("");
    const hashPath = hygieneDigestHashPath(vault);
    const recorded = readFileSync(hashPath, "utf8");
    const second = await runHook(stopPayload(transcript), FLAG_ON);
    expect(second.exit).toBe(0);
    expect(second.stdout).toBe("");
    expect(readFileSync(hashPath, "utf8")).toBe(recorded);
  });

  test("stop_hook_active is silent", async () => {
    seedConflict();
    const transcript = claudeTranscript(true);
    const r = await runHook(stopPayload(transcript, { stop_hook_active: true }), FLAG_ON);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(hygieneDigestHashPath(vault))).toBe(false);
  });

  test("a turn without an artifact write is silent", async () => {
    seedConflict();
    const transcript = claudeTranscript(false);
    const r = await runHook(stopPayload(transcript), FLAG_ON);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(hygieneDigestHashPath(vault))).toBe(false);
  });

  test("a missing vault is silent", async () => {
    seedConflict();
    const transcript = claudeTranscript(true);
    // No VAULT_DIR and a throwaway home with no config: resolution falls
    // through every source and returns null. The cwd is the throwaway
    // home, so the project-pointer walk-up finds no pointer either.
    const r = await runHook(stopPayload(transcript), { VAULT_DIR: "" });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a scan with nothing eligible emits nothing and writes no ledger", async () => {
    // Fresh vault: the default sweep runs (flag on, artifact turn) and
    // finds nothing eligible, so the composer answers null.
    const transcript = claudeTranscript(true);
    const r = await runHook(stopPayload(transcript), FLAG_ON);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(hygieneDigestHashPath(vault))).toBe(false);
  });

  test("claudecode gets the Stop shape; every other runtime stays silent", async () => {
    seedConflict();
    // M5: a codex-shaped Stop must be probed BEFORE the claudecode run
    // below writes the hash ledger - under the old per-runtime shape the
    // codex probe emitted decision:block, and on those runtimes a Stop
    // block is a forced continuation turn. The digest is opt-in, so a
    // runtime without a non-blocking channel stays silent instead.
    const codex = writeTranscript(join(configHome, ".codex", "sessions", "codex-session.jsonl"), [
      ccUser("please add a file"),
      ccAssistantToolUse("apply_patch", { input: "*** Begin Patch\n+new line\n*** End Patch" }),
    ]);
    const codexRun = await runHook(stopPayload(codex), FLAG_ON);
    expect(codexRun.exit).toBe(0);
    expect(codexRun.stdout).toBe("");
    expect(existsSync(hygieneDigestHashPath(vault))).toBe(false);

    // The claudecode transcript path is what earns the non-blocking
    // channel; its line rides hookSpecificOutput.additionalContext.
    const claude = await runHook(stopPayload(claudeTranscript(true)), FLAG_ON);
    expect(claude.exit).toBe(0);
    const claudeParsed = JSON.parse(claude.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string } | undefined;
      decision: string | undefined;
    };
    expect(claudeParsed.hookSpecificOutput).toBeDefined();
    expect(claudeParsed.hookSpecificOutput!.hookEventName).toBe("Stop");
    expect(claudeParsed.decision).toBeUndefined();

    // An unrecognised runtime has no non-blocking channel either: same
    // silence, and the emitted state is never recorded for it.
    rmSync(hygieneDigestHashPath(vault), { force: true });
    const plain = writeTranscript(join(configHome, "plain-session.jsonl"), [
      ccUser("please add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
    ]);
    const unknown = await runHook(stopPayload(plain), FLAG_ON);
    expect(unknown.exit).toBe(0);
    expect(unknown.stdout).toBe("");
    expect(existsSync(hygieneDigestHashPath(vault))).toBe(false);
  });

  test(`the ledger file is named ${HYGIENE_DIGEST_HASH_FILENAME} beside hook-state, never inside it`, () => {
    expect(HYGIENE_DIGEST_HASH_FILENAME).toBe("hygiene-digest.hash");
    expect(hygieneDigestHashPath("/v").replaceAll("\\", "/")).toBe(
      "/v/.open-second-brain/hygiene-digest.hash",
    );
  });
});
