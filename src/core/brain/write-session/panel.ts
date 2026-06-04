/**
 * Decision panel as a write-session kind
 * (Agent Write Contract Suite, t_0cc6fdff on the t_bc36a8a2 kernel).
 *
 * The panel rides the session kernel instead of owning a second state
 * machine: persona steps and the synthesis step reuse the kernel's
 * correction loop, retry cap, TTL, review gate, commit, and audit. OSB
 * sequences the lenses and validates the texts; the calling agent
 * supplies every generated word - the no-LLM-in-core rule holds.
 *
 * Step walk: `persona:<slug>` for each persona in declared order, then
 * `synthesis`, then the rendered decision note commits to the session
 * target (default `Brain/decisions/panels/panel-<date>-<topic>.md`).
 */

import {
  WriteSessionRequestError,
  commitArtifact,
  loadLiveSession,
  recordFailedAttempt,
  resolveNow,
  sessionEnvelope,
  submitToSession,
  DEFAULT_RETRY_CAP,
  DEFAULT_TTL_MS,
} from "./engine.ts";
import { createWriteSession, saveWriteSession } from "./store.ts";
import { loadPersonas } from "./personas.ts";
import { inspectExistingTarget, validateTargetPath } from "./validate.ts";
import { formatFrontmatter, slugify } from "../../vault.ts";
import type {
  WriteSessionEnvelope,
  WriteSessionError,
  WriteSessionPersona,
  WriteSessionRecord,
} from "./types.ts";

/** Per-step text cap - a lens answer, not an essay collection. */
export const PANEL_STEP_MAX_CHARS = 8000;

const SYNTHESIS_STEP = "synthesis";

export interface OpenPanelSessionInput {
  readonly agent: string;
  readonly topic: string;
  /** Persona slugs to convene, in order; defaults to every loaded persona. */
  readonly personas?: ReadonlyArray<string>;
  /** Override the default panels namespace target. */
  readonly targetPath?: string;
  readonly requireReview?: boolean;
  readonly retryCap?: number;
  readonly ttlMs?: number;
  readonly now?: string;
}

/** Open a panel session; the first envelope carries persona step one. */
export function openPanelSession(
  vault: string,
  input: OpenPanelSessionInput,
): WriteSessionEnvelope {
  const topic = input.topic.trim();
  if (topic === "") {
    throw new WriteSessionRequestError("panel topic must not be empty");
  }
  const personas = selectPersonas(loadPersonas(vault), input.personas);
  const now = resolveNow(input.now);
  const targetPath =
    input.targetPath ?? `Brain/decisions/panels/panel-${now.slice(0, 10)}-${slugify(topic)}.md`;
  const targetErrors = validateTargetPath(targetPath);
  if (targetErrors.length > 0) {
    throw new WriteSessionRequestError(
      `target rejected: ${targetErrors[0]!.message}`,
      targetErrors,
    );
  }
  const first = personas[0]!;
  const expiresAt = new Date(Date.parse(now) + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
  const record = createWriteSession(vault, now, (id) =>
    Object.freeze({
      id,
      kind: "panel" as const,
      status: "needs-llm-step" as const,
      step: `persona:${first.slug}`,
      agent: input.agent.trim() || "unknown",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      attempts: 0,
      retryCap: input.retryCap ?? DEFAULT_RETRY_CAP,
      targetPath,
      intent: "create" as const,
      requireReview: input.requireReview === true,
      prompt: personaPrompt(first, topic),
      schemaType: null,
      topic,
      personas,
      responses: {},
      pendingArtifact: null,
      lastErrors: [],
      failReason: null,
    }),
  );
  return sessionEnvelope(record);
}

export interface SubmitPanelStepInput {
  readonly sessionId: string;
  readonly text: string;
  readonly now?: string;
}

/** Submit the current panel step (persona answer or synthesis). */
export function submitToPanelSession(
  vault: string,
  input: SubmitPanelStepInput,
): WriteSessionEnvelope {
  const now = resolveNow(input.now);
  const session = loadLiveSession(vault, input.sessionId, now);
  if (session.kind !== "panel") {
    throw new WriteSessionRequestError(
      `session ${session.id} is an '${session.kind}' session - use the artifact submit surface`,
    );
  }
  const errors = validateStepText(input.text);
  if (errors.length > 0) {
    return recordFailedAttempt(vault, session, errors, now);
  }
  const text = input.text.trim();

  if (session.step === SYNTHESIS_STEP) {
    // Commit-time collision guard: panel sessions always carry `create`
    // intent, and create NEVER overwrites - same contract as the
    // artifact flow. An occupied target (operator-specified, or a
    // same-day rerun of the same topic) is a structured error, not a
    // silent overwrite.
    if (inspectExistingTarget(vault, session.targetPath) !== null) {
      return recordFailedAttempt(
        vault,
        session,
        [
          Object.freeze({
            code: "target-exists",
            path: "target",
            message: `${session.targetPath} already exists; abandon and reopen with --target`,
          }),
        ],
        now,
      );
    }
    const note = renderPanelNote(session, text, now);
    if (session.requireReview) {
      const parked: WriteSessionRecord = Object.freeze({
        ...session,
        status: "needs-review" as const,
        updatedAt: now,
        responses: Object.freeze({ ...session.responses, [SYNTHESIS_STEP]: text }),
        pendingArtifact: note,
        lastErrors: [],
        prompt: "Awaiting operator review - no further generation needed.",
      });
      saveWriteSession(vault, parked);
      return sessionEnvelope(parked);
    }
    return commitArtifact(
      vault,
      Object.freeze({
        ...session,
        responses: Object.freeze({ ...session.responses, [SYNTHESIS_STEP]: text }),
      }),
      note,
      now,
    );
  }

  // Persona step accepted: record the answer, advance, reset attempts.
  const responses = Object.freeze({ ...session.responses, [session.step]: text });
  const next = nextStep(session, session.step);
  const advanced: WriteSessionRecord = Object.freeze({
    ...session,
    status: "needs-llm-step" as const,
    step: next,
    attempts: 0,
    updatedAt: now,
    responses,
    lastErrors: [],
    prompt:
      next === SYNTHESIS_STEP
        ? synthesisPrompt({ ...session, responses })
        : personaPrompt(
            session.personas.find((p) => `persona:${p.slug}` === next)!,
            session.topic ?? "",
          ),
  });
  saveWriteSession(vault, advanced);
  return sessionEnvelope(advanced);
}

export interface DispatchSubmitInput {
  readonly sessionId: string;
  readonly text: string;
  readonly now?: string;
}

/**
 * Kind-agnostic submit for surfaces that take a bare session id (CLI
 * `brain session submit`, the MCP tool): routes to the artifact or
 * panel flow based on the stored session kind.
 */
export function dispatchSubmit(vault: string, input: DispatchSubmitInput): WriteSessionEnvelope {
  const now = resolveNow(input.now);
  const session = loadLiveSession(vault, input.sessionId, now);
  if (session.kind === "panel") {
    return submitToPanelSession(vault, { sessionId: input.sessionId, text: input.text, now });
  }
  return submitToSession(vault, { sessionId: input.sessionId, artifact: input.text, now });
}

// ----- internals -------------------------------------------------------------

function selectPersonas(
  loaded: ReadonlyArray<WriteSessionPersona>,
  requested: ReadonlyArray<string> | undefined,
): ReadonlyArray<WriteSessionPersona> {
  if (requested === undefined || requested.length === 0) return loaded;
  const bySlug = new Map(loaded.map((p) => [p.slug, p]));
  const selected: WriteSessionPersona[] = [];
  // Duplicates would break step progression: `nextStep` walks the
  // persona list by indexOf, so a repeated slug loops on itself and
  // the session never reaches synthesis.
  const seen = new Set<string>();
  for (const rawSlug of requested) {
    const slug = rawSlug.trim();
    if (slug === "") {
      throw new WriteSessionRequestError("persona slug must not be empty");
    }
    if (seen.has(slug)) {
      throw new WriteSessionRequestError(`duplicate persona '${slug}' requested`);
    }
    seen.add(slug);
    const persona = bySlug.get(slug);
    if (persona === undefined) {
      throw new WriteSessionRequestError(
        `unknown persona '${slug}' - available: ${loaded.map((p) => p.slug).join(", ")}`,
      );
    }
    selected.push(persona);
  }
  return Object.freeze(selected);
}

function validateStepText(text: string): ReadonlyArray<WriteSessionError> {
  if (typeof text !== "string" || text.trim() === "") {
    return Object.freeze([
      Object.freeze({ code: "step-empty", path: "body", message: "step text must not be empty" }),
    ]);
  }
  if (text.length > PANEL_STEP_MAX_CHARS) {
    return Object.freeze([
      Object.freeze({
        code: "step-too-long",
        path: "body",
        message: `step text exceeds ${PANEL_STEP_MAX_CHARS} characters`,
      }),
    ]);
  }
  return Object.freeze([]);
}

function nextStep(session: WriteSessionRecord, current: string): string {
  const steps = session.personas.map((p) => `persona:${p.slug}`);
  const index = steps.indexOf(current);
  return index >= 0 && index < steps.length - 1 ? steps[index + 1]! : SYNTHESIS_STEP;
}

function personaPrompt(persona: WriteSessionPersona, topic: string): string {
  return `Decision topic: ${topic}\n\nAnswer as the '${persona.slug}' panelist (${persona.lens}).\n${persona.prompt}`;
}

function synthesisPrompt(session: WriteSessionRecord): string {
  const answers = session.personas
    .map((p) => `### ${p.lens} (${p.slug})\n${session.responses[`persona:${p.slug}`] ?? ""}`)
    .join("\n\n");
  return (
    `Decision topic: ${session.topic}\n\n` +
    `Every panelist has answered:\n\n${answers}\n\n` +
    "Synthesize the deliberation into a recommendation: state the decision, the strongest supporting argument per lens, the unresolved tensions, and the conditions that would reverse it."
  );
}

/** Deterministic decision note - same session state, same bytes. */
function renderPanelNote(session: WriteSessionRecord, synthesis: string, now: string): string {
  const metadata = {
    kind: "decision-panel",
    topic: session.topic ?? "",
    created_at: now.replace(/\.\d{3}Z$/u, "Z"),
    session: session.id,
    agent: session.agent,
    personas: session.personas.map((p) => p.slug),
    tags: ["brain", "brain/decision-panel"],
  };
  const lines: string[] = [`# Panel: ${session.topic ?? ""}`, ""];
  for (const persona of session.personas) {
    lines.push(`## ${persona.lens} (${persona.slug})`, "");
    lines.push(session.responses[`persona:${persona.slug}`] ?? "", "");
  }
  lines.push("## Synthesis", "", synthesis);
  return formatFrontmatter(metadata, lines.join("\n"));
}
