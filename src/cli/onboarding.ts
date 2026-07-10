/**
 * Guided first-run onboarding checklist (t_84500f39).
 *
 * A freshly initialized vault otherwise gets a single search-indexing hint.
 * This turns `o2b init` (and a re-runnable `o2b onboarding` verb) into a
 * walked-through setup: a state-driven, ordered list of next steps - vault
 * config, Brain scaffold, first index, agent identity, an optional embedding
 * key, a first feedback signal, importing existing sessions, and a health
 * check. Each step reports whether it is already satisfied and carries a
 * copy-pasteable command, so time-to-value is short for both human operators
 * and the agent driving onboarding. It reuses the same runtime-state notice
 * channel the rest of the release exposes. Deterministic; reads state only.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { discoverConfig } from "../core/config.ts";
import { resolveSearchConfig } from "../core/search/index.ts";
import {
  collectRuntimeNotices,
  renderRuntimeNotices,
  type RuntimeNotice,
} from "../core/brain/runtime-notices.ts";

export interface OnboardingStep {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  /** Whether the step is advisory (does not gate `complete`). */
  readonly optional: boolean;
  /** Copy-pasteable command to advance the step, or null when informational. */
  readonly command: string | null;
  readonly hint: string;
}

export interface OnboardingChecklist {
  readonly vault: string;
  readonly steps: ReadonlyArray<OnboardingStep>;
  readonly notices: ReadonlyArray<RuntimeNotice>;
  /** True when every required (non-optional) step is satisfied. */
  readonly complete: boolean;
}

export interface OnboardingOptions {
  readonly configPath?: string;
  readonly env?: Record<string, string | undefined>;
}

/** Count markdown files under a vault-relative directory, 0 when absent. */
function countMarkdown(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/**
 * Compute the onboarding checklist from the vault's real on-disk + config
 * state. Pure read: never writes, never calls the network or an LLM.
 */
export function buildOnboardingChecklist(
  vault: string,
  opts: OnboardingOptions = {},
): OnboardingChecklist {
  const config = discoverConfig(opts.configPath).data;
  const search = resolveSearchConfig({ vault, configPath: opts.configPath });

  const vaultConfigured = typeof config["vault"] === "string" && config["vault"].length > 0;
  const brainScaffolded = existsSync(join(vault, "Brain"));
  const indexBuilt = existsSync(search.dbPath);
  const agentNamed =
    (typeof config["agent_name"] === "string" && config["agent_name"].length > 0) ||
    (typeof config["agentName"] === "string" && config["agentName"].length > 0);
  const semanticReady = search.semantic.enabled && Boolean(search.semantic.apiKey);
  const hasFirstSignal =
    countMarkdown(join(vault, "Brain", "preferences")) > 0 ||
    countMarkdown(join(vault, "Brain", "inbox")) > 0;

  const steps: OnboardingStep[] = [
    {
      id: "vault_configured",
      title: "Vault configured",
      done: vaultConfigured,
      optional: false,
      command: vaultConfigured ? null : `o2b init --vault "${vault}"`,
      hint: `Vault: ${vault}`,
    },
    {
      id: "scaffold_brain",
      title: "Scaffold the Brain layer",
      done: brainScaffolded,
      optional: false,
      command: brainScaffolded ? null : "o2b brain init",
      hint: "Creates Brain/ (preferences, inbox, log, ...).",
    },
    {
      id: "build_index",
      title: "Build the search index",
      done: indexBuilt,
      optional: false,
      command: indexBuilt ? null : "o2b search index",
      hint: "Lexical recall works once the index exists.",
    },
    {
      id: "agent_name",
      title: "Register an agent identity",
      done: agentNamed,
      optional: false,
      command: agentNamed ? null : `o2b init --vault "${vault}" --agent-name <your-agent>`,
      hint: "Signals and evidence are attributed to this name.",
    },
    {
      id: "semantic_search",
      title: "Enable semantic search (optional)",
      done: semanticReady,
      optional: true,
      command: semanticReady ? null : "o2b search check",
      hint: "Set an embedding key to add semantic recall on top of lexical.",
    },
    {
      id: "first_feedback",
      title: "Record a first feedback signal",
      done: hasFirstSignal,
      optional: false,
      command: hasFirstSignal ? null : 'o2b brain feedback positive <topic> "<principle>"',
      hint: "Teach the Brain one durable preference to prove the loop.",
    },
    {
      id: "import_sessions",
      title: "Import existing agent sessions (optional)",
      done: false,
      optional: true,
      command: "o2b brain import-session <path>",
      hint: "Replay past Claude Code / Codex / opencode logs into the Brain.",
    },
    {
      id: "verify",
      title: "Verify the setup",
      done: false,
      optional: true,
      command: "o2b doctor",
      hint: "Each failing check prints an exact remediation command.",
    },
  ];

  const complete = steps.every((s) => s.optional || s.done);
  const notices = collectRuntimeNotices(vault, {
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });

  return { vault, steps, notices, complete };
}

/** Render the checklist as a human-readable block for the CLI. */
export function renderOnboardingChecklist(checklist: OnboardingChecklist): string {
  const lines: string[] = ["", "Next steps:"];
  for (const step of checklist.steps) {
    const box = step.done ? "[x]" : "[ ]";
    const tag = step.optional && !step.done ? " (optional)" : "";
    lines.push(`  ${box} ${step.title}${tag}`);
    if (!step.done && step.command) lines.push(`        run: ${step.command}`);
  }
  if (checklist.complete) {
    lines.push("", "All required steps are done. Your Second Brain is ready.");
  }
  const noticeBlock = renderRuntimeNotices(checklist.notices);
  if (noticeBlock.length > 0) lines.push("", noticeBlock);
  lines.push("");
  return lines.join("\n");
}
