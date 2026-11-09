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
 *
 * With no vault (design D14, task 2.10) the brain is the store alone: the
 * checklist then walks the store, the agent identity and a first signal,
 * and names the vault as an optional step for Obsidian notes. The vault
 * steps (scaffold, the vault's index, the runtime notices and the data
 * ownership record, which all measure a vault) are left out.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { discoverConfig } from "../core/config.ts";
import { defaultRegistry } from "../core/install/registry.ts";
// The canonical adapter set registers itself on import of this barrel; the
// ownership statement enumerates the runtime configs those adapters own,
// so it has to see the same list the installer does.
import "../core/install/adapters/all.ts";
import type { DataOwnership } from "../core/install/ownership.ts";
import { measureDataOwnership } from "../core/install/ownership-measure.ts";
import { resolveSearchConfig } from "../core/search/index.ts";
import { readEntitiesOf } from "../core/store/read/store-entities.ts";
import { inspectStore, type StoreInspection } from "../core/store/store-open.ts";
import { resolveConfiguredStoreRoot } from "../core/store/store-paths.ts";
import {
  collectRuntimeNotices,
  renderRuntimeNotices,
  type RuntimeNotice,
} from "../core/brain/runtime-notices.ts";
import { storeRecordPages } from "../core/brain/memory-pages.ts";
import { storeOnlyMode } from "../core/store/store-only.ts";

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
  /** The vault walked, or `null` when none is configured. */
  readonly vault: string | null;
  readonly steps: ReadonlyArray<OnboardingStep>;
  readonly notices: ReadonlyArray<RuntimeNotice>;
  /** True when every required (non-optional) step is satisfied. */
  readonly complete: boolean;
  /**
   * What the operator owns and where it is, as a structured record.
   *
   * It rides HERE because this checklist is the one machine-readable
   * next-action surface that already serialises whole (`o2b onboarding
   * --json`), and an agent deciding what to do next is exactly the reader
   * who needs to know that the vault is the artifact and what does not
   * travel inside it.
   *
   * Deliberately NOT rendered into the human checklist: the prose form is
   * the close `o2b install --apply` and a passing `o2b install --check`
   * print, and repeating it on every `o2b init` would turn a statement
   * into noise. Both surfaces read this same record, so neither can gain
   * a field the other lacks.
   *
   * `null` with no vault: the record measures the vault.
   */
  readonly data_ownership: DataOwnership | null;
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
 * True when this vault's search index has been built.
 *
 * Exported because `o2b init` prints its search block immediately above
 * this checklist and must reach the same answer: the block used to
 * advertise the indexer unconditionally, so one command's output said
 * "build the index" and "[x] Build the search index" two lines apart.
 * One predicate, one answer.
 */
export function searchIndexExists(vault: string, configPath?: string): boolean {
  return existsSync(resolveSearchConfig({ vault, configPath }).dbPath);
}

/**
 * Compute the onboarding checklist from the vault's real on-disk + config
 * state. Pure read: never writes, never calls the network or an LLM.
 */
export function buildOnboardingChecklist(
  vault: string | null,
  opts: OnboardingOptions = {},
): OnboardingChecklist {
  if (vault === null) return buildStoreOnlyChecklist(opts);
  const config = discoverConfig(opts.configPath).data;
  const search = resolveSearchConfig({ vault, configPath: opts.configPath });

  const vaultConfigured = typeof config["vault"] === "string" && config["vault"].length > 0;
  // A switched machine keeps its brain in the store: the store is the
  // scaffold, and its records are the first signals.
  const mode = storeOnlyMode({
    vault,
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  const storeOnly = mode.storeOnly;
  // A fresh (bare) vault is store-only as well: its brain is the store,
  // never a `Brain/` tree `o2b brain init` would scaffold into it.
  const freshVault = storeOnly && mode.reason === "no-legacy-tree";
  // A fresh vault's brain is the store: one that cannot be read is named,
  // as on the store-only checklist, not offered to `o2b init` (it refuses
  // that same store).
  const freshStore = freshVault ? storeOf(opts.configPath) : null;
  const brainScaffolded =
    mode.reason === "device-switched" ||
    existsSync(join(vault, "Brain")) ||
    (freshStore !== null && freshStore.store !== null);
  const indexBuilt = searchIndexExists(vault, opts.configPath);
  const agentNamed = hasAgentName(config);
  // A local (or disabled) provider needs no embedding key, so semantic search
  // is "ready" without one - mirroring the runtime-notice `networked` logic.
  const networked = search.semantic.provider !== "local" && search.semantic.provider !== "disabled";
  const semanticReady = search.semantic.enabled && (!networked || Boolean(search.semantic.apiKey));
  const hasFirstSignal = storeOnly
    ? storeRecordPages(vault, { kinds: new Set(["preference", "signal"]) }).length > 0
    : countMarkdown(join(vault, "Brain", "preferences")) > 0 ||
      countMarkdown(join(vault, "Brain", "inbox")) > 0;

  const steps: OnboardingStep[] = [
    {
      id: "vault_configured",
      title: "Vault configured",
      done: vaultConfigured,
      optional: false,
      command: vaultConfigured ? null : `o2b init --vault ${vaultArg(vault)}`,
      hint: `Vault: ${vault}`,
    },
    {
      id: "scaffold_brain",
      title: "Scaffold the Brain layer",
      done: brainScaffolded,
      optional: false,
      ...scaffoldStep(brainScaffolded, freshStore, vault),
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
      command: agentNamed ? null : `o2b init --vault ${vaultArg(vault)} --agent-name <your-agent>`,
      hint: "Signals and evidence are attributed to this name.",
    },
    {
      id: "semantic_search",
      title: "Enable semantic search",
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
      command: hasFirstSignal
        ? null
        : 'o2b brain feedback --signal positive --topic <topic> --principle "<principle>"',
      hint: "Teach the Brain one durable preference to prove the loop.",
    },
    {
      id: "import_sessions",
      title: "Import existing agent sessions",
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

  // Measured by the same function the install verb's close calls, so the
  // two surfaces cannot answer differently about where the search index
  // landed or which outbound integrations are configured. This checklist
  // supplies only the vault and the live adapter registry.
  const data_ownership = measureDataOwnership({
    vault,
    ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
    adapterTargets: defaultRegistry.targets(),
  });

  return { vault, steps, notices, complete, data_ownership };
}

function hasAgentName(config: Readonly<Record<string, string>>): boolean {
  return (
    (typeof config["agent_name"] === "string" && config["agent_name"].length > 0) ||
    (typeof config["agentName"] === "string" && config["agentName"].length > 0)
  );
}

/**
 * The configured store, or why it cannot be read: `{ store: null, error:
 * null }` when no store exists yet, an error when one exists but cannot be
 * read (a broken identity file, partitions of two stores).
 */
function storeOf(configPath: string | undefined): {
  store: StoreInspection | null;
  error: string | null;
} {
  try {
    return { store: inspectStore(resolveConfiguredStoreRoot(configPath).root), error: null };
  } catch (err) {
    return { store: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The command and hint of a step whose work is the brain store: done when
 * the store exists; a store that exists but cannot be read is not fixed
 * by `o2b init` (it refuses the same store), so the doctor names what is
 * wrong; else `init` creates it.
 */
function storeStep(
  found: { readonly store: StoreInspection | null; readonly error: string | null },
  init: string,
  hint: string,
): { command: string | null; hint: string } {
  if (found.store !== null) return { command: null, hint: `Store: ${found.store.root}` };
  if (found.error !== null) {
    return { command: "o2b doctor", hint: `The brain store cannot be read: ${found.error}` };
  }
  return { command: init, hint };
}

/** The scaffold step's command and hint: the store on a fresh vault, `Brain/` otherwise. */
function scaffoldStep(
  done: boolean,
  freshStore: { readonly store: StoreInspection | null; readonly error: string | null } | null,
  vault: string,
): { command: string | null; hint: string } {
  if (freshStore === null) {
    return {
      command: done ? null : "o2b brain init",
      hint: "Creates Brain/ (preferences, inbox, log, ...).",
    };
  }
  const hint =
    "The brain lives in the brain store; `o2b init --vault` creates it and binds the vault.";
  if (done && freshStore.store === null) return { command: null, hint };
  return storeStep(freshStore, `o2b init --vault ${vaultArg(vault)}`, hint);
}

/**
 * The vault path as one shell word of a suggested command: double-quoted
 * as before when that is safe, else single-quoted (a `"`, `$`, backtick or
 * `!` would otherwise break the command or run something), the PowerShell
 * way on Windows.
 */
function vaultArg(vault: string): string {
  if (!/["$`!]/.test(vault)) return `"${vault}"`;
  return process.platform === "win32"
    ? `'${vault.replaceAll("'", "''")}'`
    : `'${vault.replaceAll("'", "'\\''")}'`;
}

/** The checklist of a machine with no vault: the store is the brain. */
function buildStoreOnlyChecklist(opts: OnboardingOptions): OnboardingChecklist {
  const config = discoverConfig(opts.configPath).data;
  const { store, error } = storeOf(opts.configPath);
  const agentNamed = hasAgentName(config);
  let hasFirstSignal = false;
  if (store !== null) {
    const entities = readEntitiesOf(store);
    hasFirstSignal = entities.preferences.size > 0 || entities.signals.size > 0;
  }
  const steps: OnboardingStep[] = [
    {
      id: "store_initialized",
      title: "Create the brain store",
      done: store !== null,
      optional: false,
      ...storeStep({ store, error }, "o2b init", "The brain lives in the store."),
    },
    {
      id: "agent_name",
      title: "Register an agent identity",
      done: agentNamed,
      optional: false,
      command: agentNamed ? null : "o2b init --agent-name <your-agent>",
      hint: "Signals and evidence are attributed to this name.",
    },
    {
      id: "first_feedback",
      title: "Record a first feedback signal",
      done: hasFirstSignal,
      optional: false,
      command: hasFirstSignal
        ? null
        : 'o2b brain feedback --signal positive --topic <topic> --principle "<principle>"',
      hint: "Teach the Brain one durable preference to prove the loop.",
    },
    {
      id: "vault_configured",
      title: "Add an Obsidian vault for notes",
      done: false,
      optional: true,
      command: 'o2b init --vault "<path>"',
      hint: "Note tools and .base views need a vault; the brain does not.",
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
  return { vault: null, steps, notices: [], complete, data_ownership: null };
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
