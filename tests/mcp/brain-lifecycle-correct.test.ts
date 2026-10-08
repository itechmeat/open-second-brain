/**
 * The `brain_lifecycle` `correct` action and the `o2b brain lifecycle
 * correct` CLI verb (truth-correctable-time-aware, Task 17).
 *
 * Both surfaces expose the correct-verb sweep core with `dry_run`
 * defaulting to true, a `flatly_wrong` flag, an optional `window_end`,
 * and reach-gated targets: a target the caller may not read is refused
 * as missing before anything is written. The receipt reason codes stay
 * the existing vocabulary, name-aligned with the verb and action
 * (`supersede` for validity_close, `tombstone` for tombstone).
 */

import { afterEach, afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { parseFrontmatter } from "../../src/core/vault.ts";
import { appendClaimEvent, readClaimEvents } from "../../src/core/brain/truth/store.ts";
import {
  buildReachLogFixture,
  reachServer,
  type ReachLogFixture,
} from "../helpers/reach-log-fixture.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { cmdBrainLifecycle } from "../../src/cli/brain/verbs/lifecycle.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { tempDirs } from "../helpers/temp-dir.ts";

afterAll(() => {
  delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
});

const mkTemp = tempDirs();

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-lifecycle-correct-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-lifecycle-correct-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "lifecycle-correct-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_lifecycle", arguments: args },
  })) as { result?: { content: ReadonlyArray<{ type: string; text: string }> }; error?: unknown };
  if (response.error !== undefined) return { error: response.error } as Record<string, unknown>;
  return JSON.parse(response.result!.content[0]!.text) as Record<string, unknown>;
}

function seedPair(): { target: string; successor: string } {
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  const target = "Brain/preferences/pref-old.md";
  writeFileSync(
    join(vault, target),
    [
      "---",
      "kind: brain-preference",
      "id: pref-old",
      "_status: confirmed",
      "created_at: 2026-05-01T00:00:00Z",
      "unconfirmed_until: 2026-05-01T00:00:00Z",
      "_confirmed_at: 2026-05-01T00:00:00Z",
      "_evidenced_by: []",
      "tags: [brain, brain/preference]",
      "topic: deploy-timeout",
      "principle: Deploy timeout stays at thirty seconds.",
      "pinned: false",
      "---",
      "",
      "The rule body.",
      "",
    ].join("\n"),
  );
  const successor = "Brain/preferences/pref-new.md";
  writeFileSync(
    join(vault, successor),
    [
      "---",
      "kind: brain-preference",
      "id: pref-new",
      "_status: confirmed",
      "created_at: 2026-06-10T00:00:00Z",
      "unconfirmed_until: 2026-06-10T00:00:00Z",
      "_confirmed_at: 2026-06-10T00:00:00Z",
      "_evidenced_by: []",
      "tags: [brain, brain/preference]",
      "topic: deploy-timeout",
      "principle: Deploy timeout is two minutes.",
      "pinned: false",
      "---",
      "",
      "The corrected rule body.",
      "",
    ].join("\n"),
  );
  appendClaimEvent(vault, {
    ts: "2026-05-02T00:00:00Z",
    agent: "tester",
    entity: "deploy timeout",
    aspect: "limit",
    value: "30s",
    source: "[[Brain/preferences/pref-old.md]]",
  });
  return { target, successor };
}

describe("brain_lifecycle correct", () => {
  test("dry_run defaults to true and writes nothing", async () => {
    const { target } = seedPair();
    const before = readFileSync(join(vault, target), "utf8");
    const eventsBefore = readClaimEvents(vault).events.length;

    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const res = await call(server, {
      action: "correct",
      target,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
    });

    expect(res["dry_run"]).toBe(true);
    const blast = res["blast_radius"] as Record<string, unknown>;
    expect(blast["target"]).toBe(target);
    expect(Array.isArray(blast["claims"])).toBe(true);
    expect((blast["claims"] as unknown[]).length).toBe(1);
    expect(readFileSync(join(vault, target), "utf8")).toBe(before);
    expect(readClaimEvents(vault).events.length).toBe(eventsBefore);
  });

  test("an applied validity-close retires with the supersede reason code", async () => {
    const { target } = seedPair();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const res = await call(server, {
      action: "correct",
      target,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      dry_run: false,
    });

    expect(res["dry_run"]).toBe(false);
    const retirements = res["retirements"] as ReadonlyArray<Record<string, unknown>>;
    expect(retirements.length).toBe(1);
    expect(retirements[0]!["end_state"]).toBe("validity_close");
    expect(retirements[0]!["reason_code"]).toBe("supersede");

    const meta = parseFrontmatter(join(vault, target))[0] as Record<string, unknown>;
    expect(meta["_status"]).toBe("confirmed");
    // The wall clock owns the close instant; the pin is its canonical
    // ISO-8601 UTC second shape, not which instant it names.
    expect(meta["valid_until"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(meta["superseded_by"]).toBe("[[pref-new]]");

    const receipts = res["receipts"] as ReadonlyArray<Record<string, unknown>>;
    expect(receipts.every((r) => r["appended"] === true)).toBe(true);
  });

  test("a flatly-wrong correction tombstones with the tombstone reason code", async () => {
    const { target } = seedPair();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const res = await call(server, {
      action: "correct",
      target,
      value: "the number was never thirty seconds",
      successor: "pref-new",
      flatly_wrong: true,
      reason: "fabricated figure",
      dry_run: false,
    });

    const retirements = res["retirements"] as ReadonlyArray<Record<string, unknown>>;
    expect(retirements[0]!["end_state"]).toBe("tombstone");
    expect(retirements[0]!["reason_code"]).toBe("tombstone");
    expect(retirements[0]!["valid_until"]).toBeNull();
    const meta = parseFrontmatter(join(vault, target))[0] as Record<string, unknown>;
    expect(meta["_status"]).toBe("tombstoned");
  });

  test("an optional window_end closes validity there", async () => {
    const { target } = seedPair();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const res = await call(server, {
      action: "correct",
      target,
      successor: "pref-new",
      window_end: "2026-07-01T00:00:00Z",
      reason: "the timeout changed",
      dry_run: false,
    });
    const retirements = res["retirements"] as ReadonlyArray<Record<string, unknown>>;
    expect(retirements[0]!["valid_until"]).toBe("2026-07-01T00:00:00Z");
  });

  test("a malformed window_end is refused before anything is written", async () => {
    const { target } = seedPair();
    const before = readFileSync(join(vault, target), "utf8");
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const res = await call(server, {
      action: "correct",
      target,
      window_end: "soon after the incident",
      dry_run: false,
    });
    expect(res["error"]).toBeDefined();
    expect(readFileSync(join(vault, target), "utf8")).toBe(before);
  });

  test("a target below the caller's reach is refused as missing", async () => {
    const base = mkTemp("o2b-lifecycle-correct-reach-");
    const f: ReachLogFixture = buildReachLogFixture(base, true);
    const withheld = join(f.vault, "Brain", "preferences", "pref-withheld.md");
    writeFileSync(
      withheld,
      [
        "---",
        `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`,
        "kind: brain-preference",
        "id: pref-withheld",
        "_status: confirmed",
        "created_at: 2026-05-01T00:00:00Z",
        "unconfirmed_until: 2026-05-01T00:00:00Z",
        "tags: [brain, brain/preference]",
        "topic: withheld-topic",
        "principle: Withheld from remote callers.",
        "pinned: false",
        "---",
        "",
        "Withheld body.",
        "",
      ].join("\n"),
    );
    const bytesBefore = readFileSync(withheld, "utf8");
    try {
      const server = reachServer(f, "remote");
      await initialize(server);
      const res = await call(server, {
        action: "correct",
        target: "Brain/preferences/pref-withheld.md",
        value: "two minutes",
        reason: "the timeout changed",
        dry_run: false,
      });
      expect(JSON.stringify(res)).toContain("does not exist");
      expect(readFileSync(withheld, "utf8")).toBe(bytesBefore);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a remote dry run does not name a withheld mentioning page in retarget", async () => {
    const base = mkTemp("o2b-lifecycle-correct-retarget-dry-");
    const f: ReachLogFixture = buildReachLogFixture(base, true);
    try {
      const target = "Brain/preferences/pref-public.md";
      mkdirSync(join(f.vault, "Brain", "preferences"), { recursive: true });
      writeFileSync(
        join(f.vault, target),
        [
          "---",
          "kind: brain-preference",
          "id: pref-public",
          "_status: confirmed",
          "created_at: 2026-05-01T00:00:00Z",
          "unconfirmed_until: 2026-05-08T00:00:00Z",
          "tags: [brain, brain/preference]",
          "topic: public-topic",
          "principle: Readable at remote reach.",
          "pinned: false",
          "---",
          "",
          "Public body.",
          "",
        ].join("\n"),
      );
      const withheld = "Brain/inbox/sig-hidden.md";
      mkdirSync(join(f.vault, "Brain", "inbox"), { recursive: true });
      writeFileSync(
        join(f.vault, withheld),
        [
          "---",
          `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`,
          "kind: brain-preference",
          "id: sig-hidden",
          "_status: confirmed",
          "created_at: 2026-05-01T00:00:00Z",
          "unconfirmed_until: 2026-05-08T00:00:00Z",
          "tags: [brain, brain/preference]",
          "topic: hidden-topic",
          "principle: Mentions [[pref-public]] while withheld.",
          "pinned: false",
          "---",
          "",
          "Hidden body referencing [[pref-public]].",
          "",
        ].join("\n"),
      );
      const server = reachServer(f, "remote");
      await initialize(server);
      const res = await call(server, { action: "correct", target });
      const retarget = res["retarget"] as Record<string, unknown>;
      expect(retarget["matched"] as ReadonlyArray<string>).not.toContain(withheld);
      expect(
        (retarget["failed"] as ReadonlyArray<Record<string, unknown>>).map((f) => f["path"]),
      ).not.toContain(withheld);
      // No response key discloses the withheld page.
      expect(JSON.stringify(res)).not.toContain("sig-hidden");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a remote applied run does not rewrite a withheld mentioning page", async () => {
    const base = mkTemp("o2b-lifecycle-correct-retarget-apply-");
    const f: ReachLogFixture = buildReachLogFixture(base, true);
    try {
      const target = "Brain/preferences/pref-public.md";
      mkdirSync(join(f.vault, "Brain", "preferences"), { recursive: true });
      writeFileSync(
        join(f.vault, target),
        [
          "---",
          "kind: brain-preference",
          "id: pref-public",
          "_status: confirmed",
          "created_at: 2026-05-01T00:00:00Z",
          "unconfirmed_until: 2026-05-08T00:00:00Z",
          "tags: [brain, brain/preference]",
          "topic: public-topic",
          "principle: Readable at remote reach.",
          "pinned: false",
          "---",
          "",
          "Public body.",
          "",
        ].join("\n"),
      );
      const peer = "Brain/preferences/pref-peer.md";
      writeFileSync(
        join(f.vault, peer),
        [
          "---",
          "kind: brain-preference",
          "id: pref-peer",
          "_status: confirmed",
          "created_at: 2026-05-01T00:00:00Z",
          "unconfirmed_until: 2026-05-08T00:00:00Z",
          "tags: [brain, brain/preference]",
          "topic: peer-topic",
          "principle: Mentions [[pref-public]] in reach.",
          "pinned: false",
          "---",
          "",
          "See [[pref-public]] for the old rule.",
          "",
        ].join("\n"),
      );
      const withheld = "Brain/inbox/sig-hidden.md";
      mkdirSync(join(f.vault, "Brain", "inbox"), { recursive: true });
      writeFileSync(
        join(f.vault, withheld),
        [
          "---",
          `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`,
          "kind: brain-preference",
          "id: sig-hidden",
          "_status: confirmed",
          "created_at: 2026-05-01T00:00:00Z",
          "unconfirmed_until: 2026-05-08T00:00:00Z",
          "tags: [brain, brain/preference]",
          "topic: hidden-topic",
          "principle: Mentions [[pref-public]] while withheld.",
          "pinned: false",
          "---",
          "",
          "Hidden body referencing [[pref-public]].",
          "",
        ].join("\n"),
      );
      const bytesBefore = readFileSync(join(f.vault, withheld), "utf8");
      const server = reachServer(f, "remote");
      await initialize(server);
      const res = await call(server, {
        action: "correct",
        target,
        successor: "pref-public-2",
        dry_run: false,
      });
      const retarget = res["retarget"] as Record<string, unknown>;
      expect(retarget["rewritten"] as ReadonlyArray<string>).not.toContain(withheld);
      expect(retarget["matched"] as ReadonlyArray<string>).not.toContain(withheld);
      expect(
        (retarget["failed"] as ReadonlyArray<Record<string, unknown>>).map((f) => f["path"]),
      ).not.toContain(withheld);
      // The withheld page's bytes are unchanged: no content injection.
      expect(readFileSync(join(f.vault, withheld), "utf8")).toBe(bytesBefore);
      // In-reach mentions are still retargeted.
      expect(retarget["rewritten"] as ReadonlyArray<string>).toContain(peer);
      expect(readFileSync(join(f.vault, peer), "utf8")).toContain("[[pref-public-2]]");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("o2b brain lifecycle correct", () => {
  test("dry run is the default and reports the blast radius without writing", async () => {
    const { target } = seedPair();
    const before = readFileSync(join(vault, target), "utf8");
    const eventsBefore = readClaimEvents(vault).events.length;

    const out: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      out.push(String(chunk));
      return true;
    };
    let exit: number;
    try {
      exit = await cmdBrainLifecycle([
        "correct",
        target,
        "--value",
        "two minutes",
        "--successor",
        "pref-new",
        "--reason",
        "the timeout changed",
        "--config",
        configPath,
        "--json",
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(exit).toBe(0);
    const payload = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(payload["dry_run"]).toBe(true);
    expect(readFileSync(join(vault, target), "utf8")).toBe(before);
    expect(readClaimEvents(vault).events.length).toBe(eventsBefore);
  });

  test("an applied run retires the target and reports the bundle", async () => {
    const { target } = seedPair();
    const out: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      out.push(String(chunk));
      return true;
    };
    let exit: number;
    try {
      exit = await cmdBrainLifecycle([
        "correct",
        target,
        "--value",
        "two minutes",
        "--successor",
        "pref-new",
        "--reason",
        "the timeout changed",
        "--apply",
        "--config",
        configPath,
        "--json",
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(exit).toBe(0);
    const payload = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(payload["dry_run"]).toBe(false);
    const bundleId = payload["bundle_id"] as string;
    expect(typeof bundleId).toBe("string");
    const retirements = payload["retirements"] as ReadonlyArray<Record<string, unknown>>;
    expect(retirements[0]!["reason_code"]).toBe("supersede");
    const meta = parseFrontmatter(join(vault, target))[0] as Record<string, unknown>;
    // The wall clock owns the close instant; the pin is its canonical
    // ISO-8601 UTC second shape, not which instant it names.
    expect(meta["valid_until"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(existsSync(join(vault, target))).toBe(true);
  });

  test("the correct verb requires a target", async () => {
    const exit = await cmdBrainLifecycle(["correct", "--config", configPath]);
    expect(exit).toBe(2);
  });
});
