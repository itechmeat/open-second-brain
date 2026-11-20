/**
 * The session-start digest fits the host's per-hook context cap as one
 * payload. Claude Code takes at most 10,000 characters of
 * `additionalContext` from one hook; past that it saves the text to a file
 * and gives the model only a path and a preview, so a 13,600-character
 * digest delivered no active preferences at all. Everything one
 * active-inject run emits - the standing and scoped rules, the topic
 * heads, the pinned context, the runtime notices, the active and lessons
 * bodies, their framing and the separators - stays under
 * `HOST_CONTEXT_CEILING_CHARS`, with the usual truncation notice, while
 * the confirmed preferences still reach the model.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fitHostContext,
  fitHostContextCut,
  HOST_CONTEXT_CAP_CHARS,
  HOST_CONTEXT_CEILING_CHARS,
} from "../../hooks/lib/host-context-ceiling.ts";
import { takeRegroundPart } from "../../hooks/lib/injection-ledger.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { newUlid } from "../../src/core/store/ulid.ts";
import { homeEnv } from "../helpers/platform.ts";
import { waitForSelfHealChildren } from "../helpers/self-heal-children.ts";
import { lingerGuardEnv } from "../helpers/hook-linger.ts";
import { TEST_DEVICE_ID } from "../helpers/test-vault.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "active-inject.ts",
);

let parent: string;
let vault: string;
let storeRoot: string;
let projectDir: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "o2b-hook-ceiling-"));
  vault = join(parent, "vault");
  storeRoot = join(parent, "store");
  projectDir = join(parent, "work", "o2b");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(parent, "home"), { recursive: true });
  writeFileSync(join(projectDir, ".o2b-vault.json"), JSON.stringify({ vault }));
});

afterEach(async () => {
  await waitForSelfHealChildren(vault);
  rmSync(parent, { recursive: true, force: true });
});

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...homeEnv(join(parent, "home")),
      VAULT_DIR: vault,
      OPEN_SECOND_BRAIN_STORE_ROOT: storeRoot,
      O2B_DEVICE_ID: TEST_DEVICE_ID,
      ...lingerGuardEnv(),
      ...env,
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(await proc.exited).toBe(0);
  return stdout;
}

function injected(stdout: string): string {
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
}

/** `count` preference bullets of one section, each about 200 characters. */
function rules(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      `- \`pref-${prefix}-${i}\` (scope: writing, confidence: high (0.9)) — ` +
      `Rule ${prefix} ${i}: ${"keep the wording plain and the claims sourced ".repeat(3)}`,
  );
}

/** A digest the size of a real vault's: hundreds of confirmed rules and more sections. */
function writeLargeActive(): void {
  writeFileSync(
    join(vault, "Brain", "active.md"),
    [
      "---",
      "kind: brain-active",
      "generated_at: 2026-11-20T10:00:00Z",
      "---",
      "",
      "# Active Brain Preferences",
      "",
      "## Confirmed (260)",
      "",
      ...rules("confirmed", 260),
      "",
      "## Most-applied (30d) (10)",
      "",
      ...rules("applied", 10),
      "",
      "## Quarantined (40)",
      "",
      ...rules("quarantined", 40),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(vault, "Brain", "lessons.md"),
    `# Lessons\n\n${Array.from(
      { length: 120 },
      (_, i) => `- Lesson ${i}: ${"a dead end worth remembering ".repeat(4)}`,
    ).join("\n")}\n`,
  );
}

function writeOperatorRules(): void {
  writeFileSync(
    join(vault, "Brain", "standing-rules.md"),
    Array.from({ length: 80 }, (_, i) => `- Standing rule ${i}: never skip the review.`).join("\n"),
  );
  const scoped = join(vault, "Brain", "standing-rules", "project");
  mkdirSync(scoped, { recursive: true });
  writeFileSync(
    join(scoped, "o2b.md"),
    Array.from({ length: 60 }, (_, i) => `- Project rule ${i}: run the full gate.`).join("\n"),
  );
  writeFileSync(join(vault, "Brain", "pinned.md"), "pinned context words ".repeat(1000));
}

function seedTopics(count: number): void {
  initStore({ root: storeRoot });
  const store = openStore({ root: storeRoot, device: TEST_DEVICE_ID });
  for (let i = 0; i < count; i++) {
    appendRecord(
      store,
      {
        partition: "shared",
        stream: "topics",
        kind: "topic-create",
        agent: "seed",
        topic: newUlid(Date.UTC(2026, 10, 1) + i * 1000),
        body: {
          authority: "agent",
          title: `Topic number ${i} with a long enough title to cost room`,
          scope: "project:o2b",
          description: `Description of topic ${i}.`,
          goal: `Goal of topic ${i}.`,
        },
      },
      { now: () => Date.UTC(2026, 10, 1) + i * 1000 },
    );
  }
}

function startPayload(): Record<string, unknown> {
  return {
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: "ceiling-session-1",
    cwd: projectDir,
  };
}

describe("active-inject under the host's context cap", () => {
  test("the ceiling keeps a margin under the documented cap", () => {
    expect(HOST_CONTEXT_CEILING_CHARS).toBeLessThan(HOST_CONTEXT_CAP_CHARS);
  });

  test("a large vault state with every lane filled stays under the ceiling and keeps the preferences", async () => {
    writeLargeActive();
    writeOperatorRules();
    seedTopics(30);
    const context = injected(await runHook(startPayload()));
    expect(context.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
    // Every lane still speaks.
    expect(context).toContain("Standing rule 0");
    expect(context).toContain("Project rule 0");
    expect(context).toContain("Topic number");
    expect(context).toContain("pinned context words");
    expect(context).toContain("## Confirmed (260)");
    expect(context).toContain("`pref-confirmed-0`");
    // The body was cut with the usual notice pointing at the full set.
    expect(context).toContain("Injection truncated to budget");
    expect(context).toContain("`brain_context`");
  });

  test("the field case: no operator rules, a large digest, lessons and pinned context", async () => {
    writeLargeActive();
    writeFileSync(join(vault, "Brain", "pinned.md"), "pinned context words ".repeat(1000));
    const context = injected(await runHook(startPayload()));
    expect(context.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
    expect(context).toContain("`pref-confirmed-0`");
    expect(context).toContain("Injection truncated to budget");
  });

  test("caps an operator set past the ceiling still give one payload under it", async () => {
    writeLargeActive();
    writeOperatorRules();
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      [
        "schema_version: 1",
        "active:",
        "  inject_budget_chars: 60000",
        "  standing_rules_max_chars: 20000",
        "  scoped_rules_max_chars: 20000",
        "  pinned_max_chars: 20000",
        "",
      ].join("\n"),
    );
    // Standing rules larger than the whole ceiling on their own.
    writeFileSync(
      join(vault, "Brain", "standing-rules.md"),
      Array.from({ length: 400 }, (_, i) => `- Standing rule ${i}: never skip the review.`).join(
        "\n",
      ),
    );
    const context = injected(await runHook(startPayload()));
    expect(context.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
    expect(context).toContain("Standing rule 0");
    expect(context).toContain("Injection truncated to budget");
  });

  test("with the split re-delivery on, part 1 fits its ceiling and the rest is queued, not cut", async () => {
    writeLargeActive();
    writeOperatorRules();
    const session = "ceiling-session-1";
    const stdout = await runHook(
      {
        ...startPayload(),
        // A Claude Code transcript path: the host the re-delivery carrier serves.
        transcript_path: `/home/u/.claude/projects/p/${session}.jsonl`,
      },
      { OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED: "true" },
    );
    const context = injected(stdout);
    expect(context.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
    expect(context).toContain("[Open Second Brain context - part 1 of");
    const queued: string[] = [];
    for (;;) {
      const take = takeRegroundPart(vault, session);
      if (take.status !== "part") break;
      queued.push(take.part);
    }
    expect(queued.length).toBeGreaterThan(0);
    for (const part of queued) expect(part.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
  });

  test("a part ceiling configured above the host's takes the host's, and no part loses its tail", async () => {
    writeLargeActive();
    writeOperatorRules();
    const session = "ceiling-session-1";
    const stdout = await runHook(
      {
        ...startPayload(),
        transcript_path: `/home/u/.claude/projects/p/${session}.jsonl`,
      },
      {
        OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED: "true",
        OPEN_SECOND_BRAIN_REGROUND_PART_CHARS: "20000",
      },
    );
    const first = injected(stdout);
    expect(first.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
    const parts = [first];
    for (;;) {
      const take = takeRegroundPart(vault, session);
      if (take.status !== "part") break;
      expect(take.partCeilingChars).toBe(HOST_CONTEXT_CEILING_CHARS);
      parts.push(take.part);
    }
    expect(parts.length).toBeGreaterThan(1);
    // Each part fits as it is, so the carrier's last guard cuts nothing.
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
      expect(fitHostContext(part)).toBe(part);
    }
    // Every standing rule is in some part, and the last part still ends
    // with the tail of the joined context: nothing was cut on the way.
    const all = parts.join("\n");
    for (let i = 0; i < 80; i++) expect(all).toContain(`- Standing rule ${i}: `);
    expect(all).toContain("- Lesson 0: ");
    expect(parts.at(-1)!.endsWith("for the full preference set._")).toBe(true);
  });
});

describe("fitHostContext", () => {
  test("a payload that fits is returned unchanged", () => {
    expect(fitHostContext("short")).toBe("short");
  });

  test("a longer payload is cut at a line, under the ceiling, with the notice and the pointer", () => {
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const fitted = fitHostContext(text, " Call `brain_context` for the rest.");
    expect(fitted.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
    expect(fitted).toContain(`of ${text.length} characters`);
    expect(fitted.endsWith("Call `brain_context` for the rest._")).toBe(true);
    expect(text.startsWith(fitted.slice(0, fitted.indexOf("\n\n_Injection")))).toBe(true);
  });

  test("a cut never lands inside a surrogate pair", () => {
    // No line break in the room: the cut is a character cut. Both parities
    // of the pairs' offset, so one of them puts the room between a pair.
    for (const lead of ["", "x"]) {
      const text = `${lead}${"😀".repeat(6000)}`;
      const fitted = fitHostContext(text);
      expect(fitted.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
      expect(fitted).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
      expect(fitted.startsWith(`${lead}😀`)).toBe(true);
    }
  });

  test("the cut reports how much of the input it kept", () => {
    expect(fitHostContextCut("short")).toEqual({ text: "short", kept: 5 });
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const cut = fitHostContextCut(text);
    expect(cut.kept).toBeLessThan(text.length);
    expect(cut.text.startsWith(text.slice(0, cut.kept))).toBe(true);
    expect(cut.text).toContain(`kept ${cut.kept} of ${text.length} characters`);
  });
});

describe("fitHostContext and untrusted-source fences", () => {
  test("a cut inside a fence closes the fence before the notice", () => {
    const text = `<untrusted_source origin="x">\n${"vault line\n".repeat(2000)}</untrusted_source>`;
    const fitted = fitHostContext(text);
    expect(fitted.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
    const close = fitted.lastIndexOf("</untrusted_source>");
    expect(close).toBeGreaterThan(fitted.lastIndexOf('<untrusted_source origin="x">'));
    expect(close).toBeLessThan(fitted.indexOf("_Injection truncated to budget"));
  });
});
