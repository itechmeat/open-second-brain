/**
 * Decision panel as a write-session kind
 * (Agent Write Contract Suite, t_0cc6fdff on the t_bc36a8a2 kernel).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PERSONAS,
  loadPersonas,
} from "../../../../src/core/brain/write-session/personas.ts";
import {
  dispatchSubmit,
  openPanelSession,
  submitToPanelSession,
} from "../../../../src/core/brain/write-session/panel.ts";
import {
  WriteSessionRequestError,
  approveSession,
  openArtifactSession,
} from "../../../../src/core/brain/write-session/engine.ts";
import { readWriteSession } from "../../../../src/core/brain/write-session/store.ts";
import { parseLogDay } from "../../../../src/core/brain/log.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";

let tmp: string;
let vault: string;

const NOW = "2026-06-04T10:00:00.000Z";

function openPanel(over: Record<string, unknown> = {}) {
  return openPanelSession(vault, {
    agent: "fixture-agent",
    topic: "Adopt the new sync engine",
    now: NOW,
    ...over,
  });
}

function drivePersonas(sessionId: string): ReturnType<typeof submitToPanelSession> {
  let env = submitToPanelSession(vault, {
    sessionId,
    text: "Technically feasible with bounded effort.",
    now: NOW,
  });
  env = submitToPanelSession(vault, { sessionId, text: "Strategically sound.", now: NOW });
  env = submitToPanelSession(vault, { sessionId, text: "Risk is acceptable.", now: NOW });
  env = submitToPanelSession(vault, { sessionId, text: "Users benefit immediately.", now: NOW });
  return env;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ws-panel-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ----- personas --------------------------------------------------------------

test("built-in default personas cover the four lenses in declared order", () => {
  expect(DEFAULT_PERSONAS.map((p) => p.slug)).toEqual([
    "technical",
    "strategic",
    "risk",
    "user-experience",
  ]);
  for (const persona of DEFAULT_PERSONAS) {
    expect(persona.lens.length).toBeGreaterThan(0);
    expect(persona.prompt.length).toBeGreaterThan(0);
  }
});

test("loadPersonas falls back to defaults and reads Brain/personas/ when present", () => {
  expect(loadPersonas(vault).map((p) => p.slug)).toEqual(DEFAULT_PERSONAS.map((p) => p.slug));

  const dir = join(vault, "Brain", "personas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "contrarian.md"),
    "---\nkind: persona\nlens: devil's advocate\n---\n\nArgue against the proposal.\n",
  );
  writeFileSync(join(dir, "ignored.md"), "---\nkind: note\n---\n\nNot a persona.\n");
  const personas = loadPersonas(vault);
  expect(personas.map((p) => p.slug)).toEqual(["contrarian"]);
  expect(personas[0]!.lens).toBe("devil's advocate");
  expect(personas[0]!.prompt).toContain("Argue against");
});

// ----- panel lifecycle --------------------------------------------------------

test("open walks persona steps in order, then synthesis, then commits the note", () => {
  const opened = openPanel();
  expect(opened.status).toBe("needs-llm-step");
  expect(opened.kind).toBe("panel");
  expect(opened.step).toBe("persona:technical");
  expect(opened.prompt).toContain("Adopt the new sync engine");
  expect(opened.target_path).toBe(
    "Brain/decisions/panels/panel-2026-06-04-adopt-the-new-sync-engine.md",
  );

  const afterPersonas = drivePersonas(opened.session_id);
  expect(afterPersonas.step).toBe("synthesis");
  expect(afterPersonas.status).toBe("needs-llm-step");
  expect(afterPersonas.prompt).toContain("Technically feasible");
  expect(afterPersonas.prompt).toContain("Users benefit immediately.");

  const done = submitToPanelSession(vault, {
    sessionId: opened.session_id,
    text: "Adopt it; risks are manageable.",
    now: NOW,
  });
  expect(done.status).toBe("done");

  const note = readFileSync(join(vault, done.target_path), "utf8");
  const [meta, body] = parseFrontmatter(join(vault, done.target_path));
  expect(meta["kind"]).toBe("decision-panel");
  expect(meta["topic"]).toBe("Adopt the new sync engine");
  expect(meta["personas"]).toEqual(["technical", "strategic", "risk", "user-experience"]);
  expect(body).toContain("## Synthesis");
  expect(body).toContain("Adopt it; risks are manageable.");
  expect(note).toContain("Risk is acceptable.");

  const { entries } = parseLogDay(vault, "2026-06-04");
  const audit = entries.filter((e) => e.eventType === "write-session");
  expect(audit).toHaveLength(1);
  expect(audit[0]!.body["kind"]).toBe("panel");
});

test("an empty persona answer is a correction, not an advance", () => {
  const opened = openPanel();
  const env = submitToPanelSession(vault, { sessionId: opened.session_id, text: "  ", now: NOW });
  expect(env.status).toBe("needs-correction");
  expect(env.step).toBe("persona:technical");
  expect(env.errors.map((e) => e.code)).toContain("step-empty");
  const retry = submitToPanelSession(vault, {
    sessionId: opened.session_id,
    text: "Feasible.",
    now: NOW,
  });
  expect(retry.step).toBe("persona:strategic");
  expect(retry.attempts_left).toBe(3);
});

test("a persona subset can be requested at open", () => {
  const opened = openPanel({ personas: ["risk", "technical"] });
  expect(opened.step).toBe("persona:risk");
  const next = submitToPanelSession(vault, {
    sessionId: opened.session_id,
    text: "Low risk.",
    now: NOW,
  });
  expect(next.step).toBe("persona:technical");
});

test("unknown persona selection is a structured error", () => {
  expect(() => openPanel({ personas: ["nonexistent"] })).toThrow(WriteSessionRequestError);
});

test("require_review parks the rendered note for operator approval", () => {
  const opened = openPanel({ requireReview: true });
  drivePersonas(opened.session_id);
  const parked = submitToPanelSession(vault, {
    sessionId: opened.session_id,
    text: "Adopt.",
    now: NOW,
  });
  expect(parked.status).toBe("needs-review");
  expect(existsSync(join(vault, parked.target_path))).toBe(false);
  const approved = approveSession(vault, { sessionId: opened.session_id, now: NOW });
  expect(approved.status).toBe("done");
  expect(readFileSync(join(vault, parked.target_path), "utf8")).toContain("## Synthesis");
});

test("dispatchSubmit routes by session kind", () => {
  const panel = openPanel();
  expect(dispatchSubmit(vault, { sessionId: panel.session_id, text: "Fine.", now: NOW }).step).toBe(
    "persona:strategic",
  );
  const artifact = openArtifactSession(vault, {
    agent: "fixture-agent",
    targetPath: "Brain/notes/x.md",
    now: NOW,
  });
  const env = dispatchSubmit(vault, {
    sessionId: artifact.session_id,
    text: "---\nkind: note\n---\n\n# X\n",
    now: NOW,
  });
  expect(env.status).toBe("done");
});

test("panel responses survive process restarts via the session file", () => {
  const opened = openPanel();
  submitToPanelSession(vault, { sessionId: opened.session_id, text: "Feasible.", now: NOW });
  const probe = readWriteSession(vault, opened.session_id, NOW);
  expect(probe.session!.responses["persona:technical"]).toBe("Feasible.");
  expect(probe.session!.step).toBe("persona:strategic");
});
