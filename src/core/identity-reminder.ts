/**
 * Identity reminder: the text the OpenClaw `before_prompt_build` hook and
 * the Hermes `pre_llm_call` hook inject into each turn so the agent keeps
 * remembering it has access to `event_log_append` and under which
 * `@<agent_name>` it is supposed to log.
 *
 * Single source of truth: `templates/identity-reminder.txt` at repo root.
 * The Hermes Python shim reads the same file; both runtimes stay in sync
 * without manual mirroring.
 *
 * The Codex and Claude Code adapters use the bundled `agent-event-log`
 * skill (description + body) instead of a hook — see
 * `skills/agent-event-log/SKILL.md`. Skill description is part of the
 * system prompt every session, so it does not need a hook to land.
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

/** Read the template from disk. Caller substitutes `{agent}` via `buildReminder`. */
export function loadReminderTemplate(): string {
  try {
    return readFileSync(TEMPLATE_PATH, "utf8").trimEnd();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load identity reminder template from ${TEMPLATE_PATH}: ${message}`,
    );
  }
}

/** Substitute `{agent}` and return the rendered reminder body. */
export function buildReminder(agent: string): string {
  return loadReminderTemplate().replace(/\{agent\}/g, agent);
}

export const __TEMPLATE_PATH_FOR_TESTS = TEMPLATE_PATH;
