/**
 * Identity reminder: the text the OpenClaw `before_prompt_build` hook and
 * the Hermes `pre_llm_call` hook inject into each turn so the agent keeps
 * remembering which `@<agent_name>` it is logging under and which Brain
 * writer tool (`brain_feedback` / `brain_apply_evidence` / `brain_note`)
 * fits the current turn.
 *
 * Single source of truth: `templates/identity-reminder.txt` at repo root.
 * The Hermes Python shim reads the same file; both runtimes stay in sync
 * without manual mirroring.
 *
 * The Claude Code and Codex adapters get their per-turn nudge from the
 * `hooks/lib/messages.ts:postWriteReminder` PostToolUse hook (and the
 * Stop guardrail) instead of this template — see `hooks/README.md`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "identity-reminder.txt",
);

/**
 * Closed enumeration of runtime targets the resolver knows about.
 * The list contains exactly the runtimes that call `buildReminder`
 * per-turn / per-action: Hermes through its Python `pre_llm_call`
 * shim, OpenClaw through its native `before_prompt_build` hook.
 * Adding a target is a PR-change (new template file + new union
 * member), not a runtime decision — the project deliberately ships
 * a fixed list rather than a dynamic registry. Claude Code and
 * Codex are intentionally absent; their post-tool-call steering is
 * delivered by `hooks/lib/messages.ts:postWriteReminder`, which is
 * a different mechanism.
 */
export const KNOWN_RUNTIME_TARGETS = ["hermes", "openclaw"] as const;

export type RuntimeTarget = (typeof KNOWN_RUNTIME_TARGETS)[number];

export function isRuntimeTarget(value: string | undefined): value is RuntimeTarget {
  return typeof value === "string" && (KNOWN_RUNTIME_TARGETS as readonly string[]).includes(value);
}

let commonTemplateCache: string | undefined;

/**
 * Read the common template from disk. Caller substitutes `{agent}`
 * via {@link buildReminder}. Cached at first read — templates are
 * installation-time artifacts that do not change at runtime, and the
 * reminder is consulted on every LLM turn.
 */
export function loadReminderTemplate(): string {
  if (commonTemplateCache !== undefined) return commonTemplateCache;
  try {
    commonTemplateCache = readFileSync(TEMPLATE_PATH, "utf8").trimEnd();
    return commonTemplateCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load identity reminder template from ${TEMPLATE_PATH}: ${message}`, {
      cause: err,
    });
  }
}

const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");

const PER_TARGET_PATHS: Readonly<Record<RuntimeTarget, string>> = Object.freeze(
  Object.fromEntries(
    KNOWN_RUNTIME_TARGETS.map((t) => [t, resolve(TEMPLATES_DIR, `identity-reminder.${t}.txt`)]),
  ),
) as Readonly<Record<RuntimeTarget, string>>;

/**
 * Cache the per-target template body once per process. The reminder
 * is read on every LLM turn through the OpenClaw / Hermes hooks; a
 * disk read per turn shows up under heavy use. The cache stores both
 * resolved bodies and a `null` sentinel for "file absent" so a
 * partially deployed install keeps falling back without re-stating
 * `ENOENT` against the filesystem every turn.
 *
 * Templates change only on install / upgrade; a process restart
 * (which happens on every gateway restart and every CLI invocation)
 * flushes the cache.
 */
const TEMPLATE_CACHE = new Map<RuntimeTarget, string | null>();

function tryReadTargetTemplate(target: RuntimeTarget): string | null {
  const cached = TEMPLATE_CACHE.get(target);
  if (cached !== undefined) return cached;
  let body: string | null;
  try {
    body = readFileSync(PER_TARGET_PATHS[target], "utf8").trimEnd();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    body = null;
  }
  TEMPLATE_CACHE.set(target, body);
  return body;
}

let envWarnedOnce = false;

function resolveTargetFromEnv(): RuntimeTarget | undefined {
  const raw = process.env.O2B_TARGET;
  if (raw === undefined || raw === "") return undefined;
  if (isRuntimeTarget(raw)) return raw;
  if (!envWarnedOnce) {
    envWarnedOnce = true;
    process.stderr.write(
      `open-second-brain: unknown O2B_TARGET='${raw}', using common identity template\n`,
    );
  }
  return undefined;
}

/**
 * Substitute `{agent}` and return the rendered reminder body.
 *
 * Resolution order for the template source:
 *   1. Explicit `target` parameter, when its per-target file exists.
 *   2. `process.env.O2B_TARGET`, when it names a known target and
 *      the per-target file exists.
 *   3. Common `templates/identity-reminder.txt`.
 *
 * A missing per-target file silently falls back — that is a valid
 * intermediate state during partial rollouts. An unknown env value
 * warns to stderr once per process and falls back.
 */
export function buildReminder(agent: string, target?: RuntimeTarget): string {
  const effective = target ?? resolveTargetFromEnv();
  if (effective !== undefined) {
    const tpl = tryReadTargetTemplate(effective);
    if (tpl !== null) return tpl.replace(/\{agent\}/g, agent);
  }
  return loadReminderTemplate().replace(/\{agent\}/g, agent);
}

/** Test-only: reset the warn-once latch and the template caches. */
export function __resetEnvWarnedOnceForTests(): void {
  envWarnedOnce = false;
  commonTemplateCache = undefined;
  TEMPLATE_CACHE.clear();
}

export const __TEMPLATE_PATH_FOR_TESTS = TEMPLATE_PATH;
