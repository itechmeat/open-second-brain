/**
 * Agent Write Contract Suite end-to-end (epic t_f01ed100): one flow
 * per feature against a real tmp vault, driven the way a calling
 * agent would drive it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openArtifactSession, submitToSession } from "../../src/core/brain/write-session/engine.ts";
import {
  openPanelSession,
  submitToPanelSession,
} from "../../src/core/brain/write-session/panel.ts";
import { resolveMemoryBackend } from "../../src/core/brain/agent-backend/registry.ts";
import { appendBrainNote } from "../../src/core/brain/note.ts";
import { mirrorSignal } from "../../src/core/brain/shared-namespace.ts";
import { parseLogDay } from "../../src/core/brain/log.ts";
import { parseSignal } from "../../src/core/brain/signal.ts";

let tmp: string;
let vault: string;
let shared: string;
let configPath: string;

const NOW = "2026-06-04T12:00:00.000Z";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-awc-e2e-"));
  vault = join(tmp, "vault");
  shared = join(tmp, "shared");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(shared, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\nshared_namespace: "${shared}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("artifact session: open -> invalid -> correction -> valid -> commit + audit", () => {
  const opened = openArtifactSession(vault, {
    agent: "e2e-agent",
    targetPath: "Brain/notes/handoff.md",
    schemaType: "note",
    now: NOW,
  });
  expect(opened.status).toBe("needs-llm-step");

  const corrected = submitToSession(vault, {
    sessionId: opened.session_id,
    artifact: "just text, no frontmatter",
    now: NOW,
  });
  expect(corrected.status).toBe("needs-correction");
  expect(corrected.prompt).toContain("resubmit the full corrected artifact");

  const done = submitToSession(vault, {
    sessionId: opened.session_id,
    artifact: "---\nkind: note\ntype: note\n---\n\n# Handoff\n\nState captured.\n",
    now: NOW,
  });
  expect(done.status).toBe("done");
  expect(readFileSync(join(vault, "Brain", "notes", "handoff.md"), "utf8")).toContain("# Handoff");

  const audit = parseLogDay(vault, "2026-06-04").entries.filter(
    (e) => e.eventType === "write-session",
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]!.body["attempts"]).toBe("1");
});

test("panel session: four lenses, synthesis, committed decision note", () => {
  const opened = openPanelSession(vault, {
    agent: "e2e-agent",
    topic: "Adopt write sessions",
    now: NOW,
  });
  let env = opened;
  for (const answer of ["Feasible.", "Aligned.", "Low risk.", "Better UX."]) {
    env = submitToPanelSession(vault, { sessionId: opened.session_id, text: answer, now: NOW });
  }
  expect(env.step).toBe("synthesis");
  const done = submitToPanelSession(vault, {
    sessionId: opened.session_id,
    text: "Adopt now.",
    now: NOW,
  });
  expect(done.status).toBe("done");
  const note = readFileSync(join(vault, done.target_path), "utf8");
  expect(note).toContain("kind: decision-panel");
  expect(note).toContain("## risk and failure modes (risk)");
  expect(note).toContain("Adopt now.");
});

test("backend registry renders a preference through the claude adapter", () => {
  const backend = resolveMemoryBackend(configPath);
  expect(backend.id).toBe("claude");
  const parsed = backend.parseMemoryFile(
    [
      "---",
      "name: prefer_pipelines",
      "description: Prefer pipeline() over barriers",
      "metadata:",
      "  type: feedback",
      "---",
      "",
      "Use pipeline() by default.",
    ].join("\n"),
  );
  if (parsed.kind !== "feedback") throw new Error("expected feedback parse");
  const rendered = backend.renderPreference({
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    memoryPath: "/x/memory/prefer_pipelines.md",
    importedAt: "2026-06-04T12:00:00Z",
    bodySha256: parsed.bodySha256,
  });
  expect(rendered).toContain("pref-prefer-pipelines");
});

test("shared namespace: signal and note mirror with attribution; primary always lands", () => {
  expect(
    mirrorSignal(shared, vault, {
      topic: "e2e-topic",
      signal: "positive",
      agent: "e2e-agent",
      principle: "Mirrors carry origin.",
      created_at: "2026-06-04T12:00:00Z",
      date: "2026-06-04",
      slug: "e2e-topic",
    }),
  ).toBe("ok");
  const inbox = readdirSync(join(shared, "Brain", "inbox")).filter((f) => f.endsWith(".md"));
  expect(inbox).toHaveLength(1);
  expect(parseSignal(join(shared, "Brain", "inbox", inbox[0]!)).agent).toBe("e2e-agent");

  const res = appendBrainNote({
    vault,
    text: "e2e milestone",
    agent: "e2e-agent",
    configPath,
    now: new Date(NOW),
  });
  expect(res.mirror).toBe("ok");
  expect(parseLogDay(vault, "2026-06-04").entries.some((e) => e.eventType === "note")).toBe(true);
  expect(parseLogDay(shared, "2026-06-04").entries.some((e) => e.eventType === "note")).toBe(true);

  // Break the shared namespace: the primary write must be untouched.
  rmSync(shared, { recursive: true, force: true });
  writeFileSync(shared, "not a directory");
  const degraded = appendBrainNote({
    vault,
    text: "after breakage",
    agent: "e2e-agent",
    configPath,
    now: new Date("2026-06-04T12:01:00Z"),
  });
  expect(degraded.mirror).toBe("failed");
  const notes = parseLogDay(vault, "2026-06-04").entries.filter((e) => e.eventType === "note");
  expect(notes).toHaveLength(2);
});
