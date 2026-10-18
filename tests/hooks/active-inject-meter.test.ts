/**
 * Unit H - injection-size meter for the SessionStart eager layer.
 *
 * The hook is fail-soft by absolute contract, so every assertion here is
 * paired with the invariant that matters more than the measurement: the
 * emitted context and the exit code are what they were without the meter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homeEnv } from "../helpers/platform.ts";
import { waitForSelfHealChildren } from "../helpers/self-heal-children.ts";
import { untrustedBindingFramingHeader } from "../../src/core/brain/untrusted-source.ts";
import {
  assembleActiveContext,
  createInjectionMeter,
  SOURCE_ACTIVE_BODY,
  SOURCE_LESSONS_BODY,
} from "../../hooks/lib/active-context.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "active-inject.ts",
);

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-inject-meter-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-inject-meter-cfg-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(async () => {
  // A SessionStart on an initialised vault spawns a detached reindex that
  // would otherwise recreate the directories removed below.
  await waitForSelfHealChildren(vault);
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly exit: number;
}

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    ...homeEnv(configHome),
    OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
    VAULT_DIR: vault,
  };
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, exit };
}

function writeActive(body: string): void {
  writeFileSync(join(vault, "Brain", "active.md"), body, "utf8");
}

function writeLessons(body: string): void {
  writeFileSync(join(vault, "Brain", "lessons.md"), body, "utf8");
}

/** Run `fn` with the runtime-notice channel off, restoring the env after. */
function withRuntimeNoticesOff(fn: () => void): void {
  const priorNotices = process.env["OPEN_SECOND_BRAIN_RUNTIME_NOTICES"];
  process.env["OPEN_SECOND_BRAIN_RUNTIME_NOTICES"] = "false";
  try {
    fn();
  } finally {
    if (priorNotices === undefined) delete process.env["OPEN_SECOND_BRAIN_RUNTIME_NOTICES"];
    else process.env["OPEN_SECOND_BRAIN_RUNTIME_NOTICES"] = priorNotices;
  }
}

interface ReceiptRecord {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

function readReceipts(): ReceiptRecord[] {
  const dir = join(vault, "Brain", "log", "continuity");
  if (!existsSync(dir)) return [];
  const out: ReceiptRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line) as ReceiptRecord);
    }
  }
  return out;
}

function injectionReceipts(): ReceiptRecord[] {
  return readReceipts().filter(
    (r) => r.kind === "context_receipt" && r.payload["trigger"] === "session_inject",
  );
}

const ACTIVE_BODY =
  "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (1)\n\n- `pref-foo` — Rule body\n";
const LESSONS_BODY =
  "---\nkind: brain-lessons\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Lessons\n\n## Avoid (1)\n\n- `de-2026-05-18-x` (score: -0.95) — the flaky retry loop\n";
/** The frontmatter-stripped bodies, as the assembly budgets and meters them. */
const ACTIVE_TRIMMED = ACTIVE_BODY.slice(ACTIVE_BODY.indexOf("# Active")).trimEnd();
const LESSONS_TRIMMED = LESSONS_BODY.slice(LESSONS_BODY.indexOf("# Lessons")).trimEnd();
/** An active body far too wide for a small budget, and a lessons body that is not. */
const WIDE_ACTIVE_BODY =
  "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n" +
  "# Active Brain Preferences — a preamble line long enough that no small inner budget survives it\n\n" +
  "## Confirmed (1)\n\n- `pref-foo` — Rule body\n";
const TINY_LESSONS_BODY =
  "---\nkind: brain-lessons\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Lessons\n\n## Avoid (1)\n\n- `de-1` — short lesson\n";

describe("active-inject injection meter", () => {
  test("records one session_inject receipt per injection with per-source bytes and tokens", async () => {
    writeActive(ACTIVE_BODY);
    writeLessons(LESSONS_BODY);

    const r = await runHook({ hook_event_name: "SessionStart" });
    expect(r.exit).toBe(0);
    const injected: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

    const receipts = injectionReceipts();
    expect(receipts.length).toBe(1);
    const payload = receipts[0]!.payload;
    const injection = payload["injection"] as Record<string, unknown>;
    expect(injection["hook_event"]).toBe("SessionStart");
    expect(injection["loader_source"]).toBe("fresh");
    expect(injection["sources_measured"]).toBe(true);
    expect(injection["total_bytes"]).toBe(Buffer.byteLength(injected, "utf8"));
    expect(injection["total_tokens"]).toBe(Math.ceil(Buffer.byteLength(injected, "utf8") / 4));

    const items = payload["items"] as ReadonlyArray<Record<string, unknown>>;
    const byId = new Map(items.map((i) => [i["id"], i]));
    expect([...byId.keys()].toSorted()).toEqual(["active-body", "lessons-body"]);
    for (const item of items) {
      const bytes = item["bytes"] as number;
      expect(bytes).toBeGreaterThan(0);
      expect(item["tokens"]).toBe(Math.ceil(bytes / 4));
    }
  });

  test("scopes the meter to this hook and names the runtime-notice source", async () => {
    writeActive(ACTIVE_BODY);
    const r = await runHook(
      { hook_event_name: "SessionStart" },
      { OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "true" },
    );
    expect(r.exit).toBe(0);
    const items = injectionReceipts()[0]!.payload["items"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(items.map((i) => i["id"]).toSorted()).toEqual(["active-body", "runtime-notices"]);
  });

  test("records the hook event name so a non-SessionStart injection is distinguishable", async () => {
    writeActive(ACTIVE_BODY);
    const r = await runHook({ hook_event_name: "UserPromptSubmit" });
    expect(r.exit).toBe(0);
    const injection = injectionReceipts()[0]!.payload["injection"] as Record<string, unknown>;
    expect(injection["hook_event"]).toBe("UserPromptSubmit");
  });

  test("attributes the GUARDED bytes: the framing header is part of the metered source", async () => {
    // The guard runs BEFORE the meter push, so the receipt names exactly
    // the bytes that reached the payload - framed, neutralized body
    // included. Guarding after the push would break this exact-match
    // attribution silently.
    writeActive(ACTIVE_BODY);
    writeLessons(LESSONS_BODY);
    const r = await runHook({ hook_event_name: "SessionStart" });
    expect(r.exit).toBe(0);
    const injected: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

    const items = injectionReceipts()[0]!.payload["items"] as ReadonlyArray<
      Record<string, unknown>
    >;
    const byId = new Map(items.map((i) => [i["id"], i]));
    const activeItem = byId.get(SOURCE_ACTIVE_BODY)!;
    const lessonsItem = byId.get(SOURCE_LESSONS_BODY)!;
    // Each metered source is the framing header line plus the neutralized
    // body block, exactly as the join in the emitted context carries them.
    expect(activeItem["bytes"]).toBe(
      Buffer.byteLength(
        `${untrustedBindingFramingHeader(SOURCE_ACTIVE_BODY)}\n${ACTIVE_TRIMMED}`,
        "utf8",
      ),
    );
    expect(lessonsItem["bytes"]).toBe(
      Buffer.byteLength(
        `${untrustedBindingFramingHeader(SOURCE_LESSONS_BODY)}\n${LESSONS_TRIMMED}`,
        "utf8",
      ),
    );
    expect(injected).toContain(
      `${untrustedBindingFramingHeader(SOURCE_ACTIVE_BODY)}\n${ACTIVE_TRIMMED}`,
    );
    expect(injected).toContain(untrustedBindingFramingHeader(SOURCE_LESSONS_BODY));
  });

  test("records the budget the sources were measured against", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nactive:\n  inject_budget_chars: 500\n",
      "utf8",
    );
    writeActive(ACTIVE_BODY);
    writeLessons(LESSONS_BODY);
    const r = await runHook({ hook_event_name: "SessionStart" });
    expect(r.exit).toBe(0);
    const budget = injectionReceipts()[0]!.payload["budget"] as Record<string, unknown>;
    // Both budgeted sub-bodies are charged against the SAME configured
    // ceiling, so the effective ceiling is a multiple of it. The record
    // states both numbers rather than implying one.
    expect(budget["inject_budget_chars"]).toBe(500);
    expect(budget["budgeted_source_count"]).toBe(2);
  });

  test("a degraded-to-cache injection is distinguishable from a genuinely small one", async () => {
    writeActive(ACTIVE_BODY);
    const first = await runHook({ hook_event_name: "SessionStart" });
    expect(first.exit).toBe(0);
    const fresh: string = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;

    // A directory where active.md was makes the assembly throw, so the
    // fail-open loader degrades to the last-good cache.
    rmSync(join(vault, "Brain", "active.md"));
    mkdirSync(join(vault, "Brain", "active.md"));

    const second = await runHook({ hook_event_name: "SessionStart" });
    expect(second.exit).toBe(0);
    const cached: string = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    expect(cached).toBe(fresh);

    const receipts = injectionReceipts();
    expect(receipts.length).toBe(2);
    const injection = receipts[1]!.payload["injection"] as Record<string, unknown>;
    expect(injection["loader_source"]).toBe("cached");
    // Nothing was assembled, so there is no per-source attribution to
    // report - and reporting zeros would be a finding that never happened.
    expect(injection["sources_measured"]).toBe(false);
    expect(receipts[1]!.payload["items"]).toEqual([]);
    expect(injection["total_bytes"]).toBe(Buffer.byteLength(cached, "utf8"));
  });

  test("a throwing receipt sink changes neither the emitted context nor the exit code", async () => {
    writeActive(ACTIVE_BODY);
    writeLessons(LESSONS_BODY);

    const healthy = await runHook({ hook_event_name: "SessionStart" });
    expect(healthy.exit).toBe(0);
    expect(injectionReceipts().length).toBe(1);

    // A regular file where the continuity store expects its directory
    // makes every append throw (mkdirSync recursive raises EEXIST).
    rmSync(join(vault, "Brain", "log", "continuity"), { recursive: true, force: true });
    writeFileSync(join(vault, "Brain", "log", "continuity"), "not a directory", "utf8");

    const broken = await runHook({ hook_event_name: "SessionStart" });
    expect(broken.exit).toBe(0);
    expect(broken.stdout).toBe(healthy.stdout);
  });

  test("a budget that cannot hold the framing header skips the memory sources unmetered", () => {
    // Unit-level on the exported assembly: the e2e hook cannot reach a
    // sub-header budget (the config validator floors inject_budget_chars
    // at 500), but the scoped-rules charge can leave the assembly less
    // room than the header costs. A source whose header cannot fit is
    // skipped whole - emitting it would push the framed remainder over
    // the very budget it is charged against, and metering it would name
    // bytes that never reached the payload.
    writeActive(ACTIVE_BODY);
    writeLessons(LESSONS_BODY);
    withRuntimeNoticesOff(() => {
      const meter = createInjectionMeter(8000);
      const assembled = assembleActiveContext(vault, 0, meter);
      expect(assembled).toBe("");
      expect(meter.sources.map((s) => s.name)).toEqual([]);
      expect(meter.budgetChars).toBeNull();
    });
  });

  test("a budget exactly equal to the framing overhead emits nothing", () => {
    // The floor is `<=`, not `<`: at exactly the header's overhead the
    // inner budget is 0, where the budgeter answers with the truncation
    // notice alone - and header + notice framed lands far over the very
    // budget the source is charged against. The source skips instead.
    writeActive(ACTIVE_BODY);
    writeLessons(LESSONS_BODY);
    withRuntimeNoticesOff(() => {
      const overhead = untrustedBindingFramingHeader(SOURCE_ACTIVE_BODY).length + 1;
      const meter = createInjectionMeter(8000);
      const assembled = assembleActiveContext(vault, overhead, meter);
      expect(assembled).toBe("");
      expect(meter.sources.map((s) => s.name)).toEqual([]);
      expect(meter.budgetChars).toBeNull();
    });
  });

  test("a budget barely above the framing overhead does not emit a framed truncation notice", () => {
    // With the header paid, a few spare characters cannot hold any
    // content, so the budgeter's answer is the truncation notice alone.
    // Framing it would emit header + multi-hundred-character notice over
    // budget, so a source whose budgeted inner body is nothing but the
    // notice skips whole - "never emitted over budget" holds with room
    // to spare, not only below the header.
    writeActive(ACTIVE_BODY);
    writeLessons(LESSONS_BODY);
    withRuntimeNoticesOff(() => {
      const budget = untrustedBindingFramingHeader(SOURCE_ACTIVE_BODY).length + 1 + 8;
      const meter = createInjectionMeter(8000);
      const assembled = assembleActiveContext(vault, budget, meter);
      expect(assembled).toBe("");
      // Nothing was emitted, so nothing was measured under the ceiling:
      // the receipt's budget block stays out, like the siblings above.
      expect(meter.budgetChars).toBeNull();
      expect(meter.sources.map((s) => s.name)).toEqual([]);
    });
  });

  test("an active body truncated to its notice does not sink a lessons body that fits", () => {
    // The notice-only skip is the ACTIVE source's alone. It used to
    // return "" for the whole assembly, discarding a lessons body that
    // had already passed its own budget and its own floor under the
    // same ceiling - the lessons reader answers to its header, not to
    // the active body's, so what it produced still emits and meters.
    // "" is for a run where no block was produced at all.
    writeActive(WIDE_ACTIVE_BODY);
    writeLessons(TINY_LESSONS_BODY);
    withRuntimeNoticesOff(() => {
      const activeOverhead = untrustedBindingFramingHeader(SOURCE_ACTIVE_BODY).length + 1;
      const lessonsOverhead = untrustedBindingFramingHeader(SOURCE_LESSONS_BODY).length + 1;
      const activeTrimmed = WIDE_ACTIVE_BODY.slice(WIDE_ACTIVE_BODY.indexOf("# Active")).trimEnd();
      const lessonsTrimmed = TINY_LESSONS_BODY.slice(
        TINY_LESSONS_BODY.indexOf("# Lessons"),
      ).trimEnd();
      // The lessons body fits its own inner budget with room to spare,
      // while the active body's preamble line alone outlasts anything
      // the same budget leaves it - so the budgeter's answer for the
      // active body is the notice, and the notice alone.
      const budget = lessonsOverhead + lessonsTrimmed.length + 16;
      expect(lessonsTrimmed.length + 16).toBeLessThan(activeTrimmed.length);
      const meter = createInjectionMeter(8000);
      const assembled = assembleActiveContext(vault, budget, meter);
      expect(meter.sources.map((s) => s.name)).toEqual([SOURCE_LESSONS_BODY]);
      expect(assembled).toBe(
        `${untrustedBindingFramingHeader(SOURCE_LESSONS_BODY)}\n${lessonsTrimmed}`,
      );
      // The lessons source was measured under the configured ceiling,
      // so the receipt names that ceiling even without an active body.
      expect(meter.budgetChars).toBe(8000);
    });
  });
});
