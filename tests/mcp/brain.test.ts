/**
 * MCP integration tests for the six Brain tools.
 *
 * These exercise the full handler path (`MCPServer.handleRequest →
 * tools/call → handler → core/brain/*`). We rely on the existing
 * `MCPServer` plumbing — no direct handler imports — so a regression in
 * tool registration or argument coercion is caught here too.
 *
 * Each test stands up a fresh tmp vault, initialises the Brain layer
 * via `bootstrapBrain` (mirrors what `o2b brain init` would do), and
 * tears down at the end. Wall-clock-sensitive cases pin time via the
 * tool's own `now` argument.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JSONRPC_VERSION,
  MCPServer,
  PROTOCOL_VERSION,
} from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import {
  brainDirs,
  preferencePath,
} from "../../src/core/brain/paths.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { vaultRelativeSafe } from "../../src/mcp/brain-tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-brain-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-brain-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Isolate from any system-wide plugin config — the project's own
  // dev config on the developer's machine would otherwise leak through.
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "brain-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function call(
  server: MCPServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function makeServer(): MCPServer {
  return new MCPServer({ vault, configPath });
}

// ---------------------------------------------------------------------------
// brain_feedback
// ---------------------------------------------------------------------------

describe("vaultRelativeSafe", () => {
  test("returns the original target unchanged when target is outside the vault", () => {
    // Cross-platform regression: the prior implementation used a
    // hard-coded `/` separator and a prefix-match. On Windows it would
    // misbehave for `C:\Users\...`-style absolute paths. Using
    // `path.relative` / `path.isAbsolute` is the correct shape.
    const outOfVault = "/tmp/somewhere-else/file.md";
    expect(vaultRelativeSafe(vault, outOfVault)).toBe(outOfVault);
  });

  test("returns vault-relative path for an in-vault target", () => {
    const inVault = join(vault, "Brain", "inbox", "sig-x.md");
    const rel = vaultRelativeSafe(vault, inVault);
    expect(rel).toBe(join("Brain", "inbox", "sig-x.md"));
    // The returned path must NOT be absolute — that's the property
    // every downstream consumer (digest, JSON output) relies on.
    expect(rel.startsWith("/")).toBe(false);
  });

  test("returns empty string when target equals the vault root", () => {
    expect(vaultRelativeSafe(vault, vault)).toBe("");
  });
});

describe("brain_feedback tool schema", () => {
  test("force_confirmed description reflects the alongside-signal behaviour", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 50,
      method: "tools/list",
    });
    const tools = (r as any).result.tools as ReadonlyArray<{
      name: string;
      inputSchema: { properties?: Record<string, { description?: string }> };
    }>;
    const feedback = tools.find((t) => t.name === "brain_feedback");
    expect(feedback).toBeDefined();
    const fcDesc =
      feedback!.inputSchema.properties?.["force_confirmed"]?.description ?? "";
    // The handler ALWAYS writes the inbox signal; with force_confirmed
    // it additionally materialises a confirmed preference. The earlier
    // "instead of an inbox signal" wording was incorrect.
    expect(fcDesc).toContain("alongside");
    expect(fcDesc).not.toMatch(/instead of an inbox signal/i);
  });
});

describe("brain_feedback", () => {
  test("writes a signal under Brain/inbox/ and returns path + id", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_feedback", {
      topic: "no-internal-abbrev",
      signal: "negative",
      principle: "Expand internal abbreviations on first use.",
      scope: "writing",
      source: ["[[Daily/2026.05.14]]"],
      raw: "Sergey pointed out OSB appeared without explanation.",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.kind).toBe("signal");
    expect(s.id).toMatch(/^sig-\d{4}-\d{2}-\d{2}-no-internal-abbrev$/);
    expect(s.path).toMatch(/^Brain\/inbox\/sig-.*\.md$/);
    expect(s.agent).toBe("claude");
    const file = join(vault, s.path);
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("kind: brain-signal");
    expect(text).toContain("signal: negative");
    expect(text).toContain("topic: no-internal-abbrev");
    expect(text).toContain("Sergey pointed out OSB appeared");
  });

  test("force_confirmed: true creates a preference directly", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_feedback", {
      topic: "imperative-prompts",
      signal: "positive",
      principle: "Write prompts in imperative voice.",
      scope: "process",
      source: ["[[Daily/2026.05.14#prompts]]"],
      force_confirmed: true,
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.kind).toBe("preference");
    expect(s.id).toBe("pref-imperative-prompts");
    const prefFile = preferencePath(vault, "imperative-prompts");
    expect(existsSync(prefFile)).toBe(true);
    const text = readFileSync(prefFile, "utf8");
    expect(text).toContain("status: confirmed");
    expect(text).toContain("topic: imperative-prompts");
  });

  test("INVALID_PARAMS when required field missing", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_feedback", {
      // topic missing
      signal: "positive",
      principle: "x",
    });
    expect(r.error.code).toBe(-32602);
  });

  test("INVALID_PARAMS for invalid signal value", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_feedback", {
      topic: "x-rule",
      signal: "neutral",
      principle: "y",
    });
    expect(r.error.code).toBe(-32602);
  });
});

// ---------------------------------------------------------------------------
// brain_dream
// ---------------------------------------------------------------------------

describe("brain_dream", () => {
  test("no-op on empty vault returns changed=false", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_dream", {});
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.changed).toBe(false);
    expect(s.new_unconfirmed).toEqual([]);
    expect(s.confirmed).toEqual([]);
    expect(s.retired).toEqual([]);
    // No snapshot or log file should be written when nothing changed.
    expect(s.snapshot_path).toBeNull();
    expect(s.log_path).toBeNull();
  });

  test("promotes a cluster after 3 same-sign signals", async () => {
    // Seed three signals for the same topic so dream promotes them.
    for (let i = 0; i < 3; i++) {
      writeSignal(vault, {
        topic: "no-tabs-in-md",
        signal: "negative",
        agent: "claude",
        principle: "Use spaces, not tabs, in Markdown.",
        created_at: `2026-05-${10 + i}T10:00:00Z`,
        date: `2026-05-${10 + i}`,
        slug: `no-tabs-in-md-${i}`,
        scope: "writing",
      });
    }

    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_dream", {
      now: "2026-05-14T10:00:00Z",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.changed).toBe(true);
    expect(s.new_unconfirmed).toContain("pref-no-tabs-in-md");
    expect(s.moved_to_processed.length).toBe(3);
    expect(typeof s.run_id).toBe("string");
    expect(s.log_path).not.toBeNull();
    expect(s.snapshot_path).not.toBeNull();
  });

  test("dry_run computes plan without writing", async () => {
    for (let i = 0; i < 3; i++) {
      writeSignal(vault, {
        topic: "dry-run-rule",
        signal: "positive",
        agent: "claude",
        principle: "Dry-run test.",
        created_at: `2026-05-${10 + i}T10:00:00Z`,
        date: `2026-05-${10 + i}`,
        slug: `dry-run-rule-${i}`,
      });
    }
    const server = makeServer();
    await initialize(server);
    const dirs = brainDirs(vault);
    const inboxBefore = readdirSync(dirs.inbox).filter((n) =>
      n.endsWith(".md"),
    ).length;
    const prefsBefore = readdirSync(dirs.preferences).filter((n) =>
      n.endsWith(".md"),
    ).length;

    const r = await call(server, "brain_dream", {
      dry_run: true,
      now: "2026-05-14T10:00:00Z",
    });
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent.dry_run).toBe(true);

    // Files unchanged on disk after a dry-run.
    const inboxAfter = readdirSync(dirs.inbox).filter((n) =>
      n.endsWith(".md"),
    ).length;
    const prefsAfter = readdirSync(dirs.preferences).filter((n) =>
      n.endsWith(".md"),
    ).length;
    expect(inboxAfter).toBe(inboxBefore);
    expect(prefsAfter).toBe(prefsBefore);
  });
});

// ---------------------------------------------------------------------------
// brain_apply_evidence
// ---------------------------------------------------------------------------

describe("brain_apply_evidence", () => {
  function seedPref(slug: string): void {
    writePreference(vault, {
      slug,
      topic: slug,
      principle: `Rule for ${slug}`,
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: [`[[sig-2026-05-14-${slug}]]`],
      confirmed_at: null,
      scope: "writing",
    });
  }

  test("happy path appends to today's log and returns logged_at", async () => {
    seedPref("no-internal-abbrev");
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_apply_evidence", {
      pref_id: "pref-no-internal-abbrev",
      artifact: "[[Daily/2026.05.14#blog]]",
      result: "applied",
      note: "Expanded OSB on first use.",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.logged_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(s.log_path.startsWith("Brain/log/")).toBe(true);
    expect(s.agent).toBe("claude");
    const file = join(vault, s.log_path);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("[[pref-no-internal-abbrev]]");
    expect(text).toContain("applied");
    expect(text).toContain("Expanded OSB on first use.");
  });

  test("missing preference returns tool-level error (isError true)", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_apply_evidence", {
      pref_id: "pref-does-not-exist",
      artifact: "[[somewhere]]",
      result: "applied",
    });
    // Per design doc §9.2: "not an error condition" — surface a
    // friendly tool-level error envelope, not a JSON-RPC protocol error.
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("preference not found");
  });

  test("INVALID_PARAMS for invalid result value", async () => {
    seedPref("x-rule");
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_apply_evidence", {
      pref_id: "pref-x-rule",
      artifact: "[[x]]",
      result: "maybe",
    });
    expect(r.error.code).toBe(-32602);
  });
});

// ---------------------------------------------------------------------------
// brain_digest
// ---------------------------------------------------------------------------

describe("brain_digest", () => {
  test("empty vault returns 'no changes' markdown", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_digest", {});
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.empty).toBe(true);
    expect(s.format).toBe("markdown");
    expect(s.content).toContain("no changes");
  });

  test("with confirmed prefs renders Markdown sections", async () => {
    // Seed a confirmed preference inside the digest window.
    writePreference(vault, {
      slug: "confirmed-rule",
      topic: "confirmed-rule",
      principle: "Confirmed test rule.",
      created_at: "2026-05-14T09:00:00Z",
      unconfirmed_until: "2026-05-14T09:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      confirmed_at: "2026-05-14T09:00:00Z",
      applied_count: 1,
      scope: "process",
    });
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_digest", {
      since: "2026-05-14T00:00:00Z",
      until: "2026-05-14T23:59:59Z",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.empty).toBe(false);
    expect(s.content).toContain("Brain digest");
    expect(s.content).toContain("Confirmed");
  });

  test("format=json returns valid JSON content", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_digest", { format: "json" });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.format).toBe("json");
    // Content must parse as JSON with the design-doc shape.
    const parsed = JSON.parse(s.content);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.empty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// brain_query
// ---------------------------------------------------------------------------

describe("brain_query", () => {
  function seedPref(slug: string): void {
    writePreference(vault, {
      slug,
      topic: slug,
      principle: `Rule for ${slug}`,
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: [`[[sig-2026-05-14-${slug}]]`],
      confirmed_at: null,
      scope: "writing",
    });
  }

  test("by preference returns preference + evidence", async () => {
    seedPref("query-pref");
    // Append an apply-evidence event so the trail is non-empty.
    const server = makeServer();
    await initialize(server);
    await call(server, "brain_apply_evidence", {
      pref_id: "pref-query-pref",
      artifact: "[[doc]]",
      result: "applied",
    });
    const r = await call(server, "brain_query", {
      preference: "pref-query-pref",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.mode).toBe("preference");
    expect(s.preference.id).toBe("pref-query-pref");
    expect(s.evidence.length).toBe(1);
    expect(s.evidence[0].event_type).toBe("apply-evidence");
  });

  test("by topic returns signals + preference + log events", async () => {
    // Seed both a signal and a preference on the same topic.
    writeSignal(vault, {
      topic: "topic-query-rule",
      signal: "positive",
      agent: "claude",
      principle: "Whatever.",
      created_at: "2026-05-14T10:00:00Z",
      date: "2026-05-14",
      slug: "topic-query-rule",
    });
    seedPref("topic-query-rule");
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_query", {
      topic: "topic-query-rule",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.mode).toBe("topic");
    expect(s.topic).toBe("topic-query-rule");
    expect(s.signals.length).toBe(1);
    expect(s.preference).not.toBeNull();
    expect(s.preference.id).toBe("pref-topic-query-rule");
  });

  test("by since returns log events from the cutoff onward", async () => {
    seedPref("since-rule");
    const server = makeServer();
    await initialize(server);
    await call(server, "brain_apply_evidence", {
      pref_id: "pref-since-rule",
      artifact: "[[a]]",
      result: "applied",
    });
    const r = await call(server, "brain_query", {
      since: "1970-01-01T00:00:00Z",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.mode).toBe("since");
    expect(s.events.length).toBeGreaterThanOrEqual(1);
    expect(s.events[0].event_type).toBe("apply-evidence");
  });

  test("requires exactly one selector", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_query", {});
    expect(r.error.code).toBe(-32602);

    const r2 = await call(server, "brain_query", {
      preference: "pref-x",
      topic: "y",
    });
    expect(r2.error.code).toBe(-32602);
  });

  test("unknown preference yields tool-level error (isError true)", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_query", {
      preference: "pref-not-here",
    });
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("no preference");
  });
});

// ---------------------------------------------------------------------------
// brain_doctor
// ---------------------------------------------------------------------------

describe("brain_doctor", () => {
  test("clean vault returns ok=true with no issues", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_doctor", {});
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.ok).toBe(true);
    expect(s.errors).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  test("corrupted preference file surfaces as a doctor issue", async () => {
    // Write a preference file with broken YAML to trip a parse error.
    const dirs = brainDirs(vault);
    atomicWriteFileSync(
      join(dirs.preferences, "pref-broken.md"),
      "---\nkind: brain-preference\nid: pref-broken\n---\n# garbage with no required fields\n",
    );
    const server = makeServer();
    await initialize(server);
    const r = await call(server, "brain_doctor", { strict: true });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    // At least one issue must be surfaced — either a warning or an error.
    expect(s.errors.length + s.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Advertised-tool deprecation guard
// ---------------------------------------------------------------------------

describe("deprecated MCP tools — advertised list", () => {
  test("`event_log_append` and `second_brain_capture` are NOT in the registry", () => {
    const names = new Set(buildToolTable().map((t) => t.name));
    expect(names.has("event_log_append")).toBe(false);
    expect(names.has("second_brain_capture")).toBe(false);
  });

  test("all six Brain tools are advertised", () => {
    const names = new Set(buildToolTable().map((t) => t.name));
    for (const expected of [
      "brain_feedback",
      "brain_dream",
      "brain_apply_evidence",
      "brain_digest",
      "brain_query",
      "brain_doctor",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });
});
