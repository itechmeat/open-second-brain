import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { attentionFlowsDir, brainDirs } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { listProceduralMemory } from "./procedural-memory.ts";
import { listPendingSkillProposals } from "./skill-proposals.ts";
import { listRecurrenceEntries } from "./recurrence.ts";
import { parsePreference } from "./preference.ts";
import { parseSignal } from "./signal.ts";
import {
  resolvePreferenceProvenance,
  type SessionRefOrigin,
  type SignalSessionRefLookup,
} from "./preference-provenance.ts";
import { BRAIN_PREFERENCE_STATUS } from "./types.ts";

export type AttentionFlowAction =
  | "open_proposals"
  | "high_recurrence"
  | "active_procedures"
  | "standing_query";

export interface AttentionFlowRecipe {
  readonly id: string;
  readonly title: string;
  readonly actions: ReadonlyArray<AttentionFlowAction>;
  /**
   * Operator-declared scope tokens for the `standing_query` action. A
   * confirmed preference whose `scope` is in this set always surfaces into
   * the assembled context. Structural selector - never a natural-language
   * phrase - so the attention layer stays language-agnostic.
   */
  readonly standingQueryScopes: ReadonlyArray<string>;
  readonly sourcePath: string;
}

export interface AttentionFlowSection {
  readonly action: AttentionFlowAction;
  readonly items: ReadonlyArray<string>;
  /**
   * Structured standing-instruction facets, present ONLY while the
   * evaluation named `standingInstructionFacets` - omitted otherwise,
   * so an unset option leaves the section shape byte-identical to the
   * legacy one. A preference whose provenance join resolves gains an
   * entry; one whose join does not resolve stays absent, an honest
   * zero rather than an implied provenance.
   */
  readonly facets?: ReadonlyArray<StandingInstructionFacet>;
}

/**
 * One confirmed preference surfaced by the `standing_query` action,
 * with the origin coordinates its provenance join resolved.
 *
 * Contract-style cross-reference: this is the preference-corpus sibling
 * of `ThreadFacet` in `thread-topics.ts` - a stable key, ordered
 * origin coordinates, pure derivation - for a different corpus. A
 * thread facet selects the turns of one thread for the coverage pass;
 * this facet annotates a standing instruction with the origin its
 * evidence cites first. The distinct name is deliberate, so the coverage lane's
 * meaning of "facet" stays unambiguous.
 */
export interface StandingInstructionFacet {
  /** Stable facet key: `pref:<preference id>`. */
  readonly key: string;
  readonly preferenceId: string;
  readonly scope: string;
  /**
   * Resolved origins in the preference's `evidenced_by` order - never
   * re-sorted, and not a chronological claim; `[0]` is the earliest
   * cited origin, not the earliest signal in time.
   */
  readonly origins: ReadonlyArray<SessionRefOrigin>;
}

export interface AttentionFlowEvaluationOptions {
  /**
   * Opt-in standing-instruction provenance (recall lane). Omitted or
   * false, every emitted string is the legacy `id (scope)` output and
   * sections carry no `facets` field. True, a surfaced preference whose
   * provenance join resolves gains an earliest-cited annotation on its
   * item string plus a facet entry; the option changes annotations,
   * never membership - no preference is admitted that the plain lane
   * would not already deliver.
   */
  readonly standingInstructionFacets?: boolean;
}

export interface AttentionFlowEvaluation {
  readonly flow_id: string;
  readonly title: string;
  readonly sections: ReadonlyArray<AttentionFlowSection>;
}

export function ensureDefaultAttentionFlows(vault: string): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const dir = attentionFlowsDir(vault);
  mkdirSync(dir, { recursive: true });
  const defaultPath = join(dir, "open-loops.md");
  if (existsSync(defaultPath)) return;
  writeFrontmatterAtomic(
    defaultPath,
    {
      kind: "brain-attention-flow",
      id: "open-loops",
      title: "Open loops and learnings",
      actions: ["open_proposals", "high_recurrence", "active_procedures"],
      status: "active",
    },
    [
      "# Open loops and learnings",
      "",
      "Declarative flow for context surfaces:",
      "- open proposals needing review",
      "- strong recurrence candidates",
      "- active procedural memory entries",
    ].join("\n"),
    {
      overwrite: false,
      existsErrorKind: "attention flow",
      vaultForRelativePath: vault,
    },
  );
}

export function listAttentionFlows(vault: string): ReadonlyArray<AttentionFlowRecipe> {
  ensureDefaultAttentionFlows(vault);
  const dir = attentionFlowsDir(vault);
  if (!existsSync(dir)) return Object.freeze([]);
  const out: AttentionFlowRecipe[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    // Unit F: unreachable `catch { continue }` removed - nothing in this
    // body throws (`parseFrontmatter` reads inside its own try, and both
    // normalizers are total over `unknown`). A recipe whose frontmatter
    // could not be read yields an empty map, fails the `kind` check on
    // the next line, and is skipped exactly as the dead branch intended.
    // See the "Why most readers keep the two-tuple form" section in
    // src/core/vault.ts for where the condition IS reported.
    const [fm] = parseFrontmatter(path);
    if (fm["kind"] !== "brain-attention-flow") continue;
    const actions = normalizeActions(fm["actions"]);
    out.push({
      id: typeof fm["id"] === "string" ? fm["id"] : name.replace(/\.md$/, ""),
      title: typeof fm["title"] === "string" ? fm["title"] : name.replace(/\.md$/, ""),
      actions,
      standingQueryScopes: normalizeStandingQueryScopes(fm["standing_queries"]),
      sourcePath: path,
    });
  }
  return Object.freeze(out);
}

export function evaluateAttentionFlow(
  vault: string,
  flowId: string,
  options: AttentionFlowEvaluationOptions = {},
): AttentionFlowEvaluation {
  const flow = listAttentionFlows(vault).find((item) => item.id === flowId);
  if (!flow) throw new Error(`attention flow not found: ${flowId}`);

  const sections: AttentionFlowSection[] = [];
  for (const action of flow.actions) {
    if (action === "open_proposals") {
      const items = listPendingSkillProposals(vault).map(
        (item) => `${item.slug} (${item.patternKind})`,
      );
      sections.push({ action, items: Object.freeze(items) });
      continue;
    }
    if (action === "high_recurrence") {
      const items = listRecurrenceEntries(vault)
        .filter((entry) => entry.supportCount >= 3)
        .map((entry) => `${entry.contentHash} (${entry.supportCount})`);
      sections.push({ action, items: Object.freeze(items) });
      continue;
    }
    if (action === "active_procedures") {
      const items = listProceduralMemory(vault)
        .filter((entry) => entry.kind === "procedure" || entry.kind === "skill")
        .map((entry) => `${entry.title} [${entry.kind}]`);
      sections.push({ action, items: Object.freeze(items) });
      continue;
    }
    if (action === "standing_query") {
      const facetsWanted = options.standingInstructionFacets === true;
      const surfaced = listConfirmedPreferencesByScope(
        vault,
        flow.standingQueryScopes,
        facetsWanted,
      );
      sections.push({
        action,
        items: Object.freeze(surfaced.items),
        // Key present only under the opt-in: an unset option leaves the
        // section byte-identical to the legacy shape.
        ...(options.standingInstructionFacets === true
          ? { facets: Object.freeze(surfaced.facets) }
          : {}),
      });
    }
  }

  return {
    flow_id: flow.id,
    title: flow.title,
    sections: Object.freeze(sections.map((item) => Object.freeze(item))),
  };
}

export function renderAttentionFlow(vault: string, flowId: string): string {
  const report = evaluateAttentionFlow(vault, flowId);
  const lines: string[] = [`# ${report.title}`, ""];
  for (const section of report.sections) {
    lines.push(`## ${section.action}`);
    if (section.items.length === 0) {
      lines.push("- (empty)");
    } else {
      for (const item of section.items) lines.push(`- ${item}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function normalizeActions(value: unknown): ReadonlyArray<AttentionFlowAction> {
  const allowed = new Set<AttentionFlowAction>([
    "open_proposals",
    "high_recurrence",
    "active_procedures",
    "standing_query",
  ]);
  const out: AttentionFlowAction[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const action = item.trim() as AttentionFlowAction;
      if (allowed.has(action)) out.push(action);
    }
  }
  if (out.length === 0) return Object.freeze(["open_proposals", "high_recurrence"]);
  return Object.freeze([...new Set(out)]);
}

/** Parse the operator-declared `standing_queries` scope tokens. */
function normalizeStandingQueryScopes(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return Object.freeze([]);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const scope = item.trim();
    if (scope.length > 0) out.push(scope);
  }
  return Object.freeze([...new Set(out)]);
}

/** Item annotation lead for an origin resolved to a real turn. */
const EARLIEST_CITED_TURN_PREFIX = " [earliest cited turn ";
/** Item annotation lead for an origin resolved to a capture-lifecycle coordinate: the fragment is the hook event's NAME, so the annotation claims the session, never a turn. */
const EARLIEST_CITED_SESSION_PREFIX = " [earliest cited session ";
/** Item annotation suffix. */
const EARLIEST_CITED_SUFFIX = "]";

/**
 * Read-only signal-id → `session_ref` lookup over the directories the
 * signal readers walk. The on-disk signal id always equals the file's
 * basename stem (see `writeSignal`), so a lookup is a direct probe per
 * directory; an absent, unreadable, or path-shaped id contributes no
 * provenance rather than an error.
 */
function signalSessionRefLookup(vault: string): SignalSessionRefLookup {
  const dirs = brainDirs(vault);
  const searchDirs = [dirs.inbox, dirs.processed, dirs.archived];
  return (signalId) => {
    // Filename-stem ids only: a lookup key is never a path.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(signalId)) return undefined;
    for (const dir of searchDirs) {
      const path = join(dir, `${signalId}.md`);
      if (!existsSync(path)) continue;
      try {
        return parseSignal(path).session_ref;
      } catch {
        // A signal that cannot be parsed proves nothing about where a
        // preference came from - no provenance, never a guess.
        return undefined;
      }
    }
    return undefined;
  };
}

/** The item string plus the facet for one surfaced preference, per the option state. */
interface SurfacedStandingInstruction {
  readonly items: string[];
  readonly facets: StandingInstructionFacet[];
}

/**
 * Confirmed preferences whose `scope` is one the flow declared. Structural
 * match on the frontmatter scope token; no natural-language matching. Returns
 * `id (scope)` items, sorted for deterministic output. With the facet option
 * on, a preference whose provenance join resolves additionally gains an
 * earliest-cited annotation on its item string and a facet entry - annotations
 * only, never a membership change, so a facet cannot surface a preference the
 * plain lane would withhold.
 */
function listConfirmedPreferencesByScope(
  vault: string,
  scopes: ReadonlyArray<string>,
  facetsWanted: boolean,
): SurfacedStandingInstruction {
  const items: string[] = [];
  const facets: StandingInstructionFacet[] = [];
  if (scopes.length === 0) return { items, facets };
  const wanted = new Set(scopes);
  const dir = brainDirs(vault).preferences;
  if (!existsSync(dir)) return { items, facets };
  const lookup = facetsWanted ? signalSessionRefLookup(vault) : null;
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    try {
      const pref = parsePreference(join(dir, name));
      if (
        pref.status === BRAIN_PREFERENCE_STATUS.confirmed &&
        pref.scope !== undefined &&
        wanted.has(pref.scope)
      ) {
        const base = `${pref.id} (${pref.scope})`;
        // Off means the legacy bytes: no lookup runs, no annotation is
        // composed, the section gains no facet field.
        if (lookup === null) {
          items.push(base);
          continue;
        }
        const provenance = resolvePreferenceProvenance(
          { id: pref.id, evidenced_by: pref.evidenced_by },
          lookup,
        );
        if (provenance === null) {
          // Nothing resolved: the honest plain string, no implied origin.
          items.push(base);
          continue;
        }
        const earliest = provenance.origins[0]!;
        const prefix =
          earliest.kind === "turn" ? EARLIEST_CITED_TURN_PREFIX : EARLIEST_CITED_SESSION_PREFIX;
        items.push(
          `${base}${prefix}${earliest.sessionKey}#${earliest.fragment}${EARLIEST_CITED_SUFFIX}`,
        );
        facets.push({
          key: provenance.key,
          preferenceId: pref.id,
          scope: pref.scope,
          origins: provenance.origins,
        });
      }
    } catch {
      continue;
    }
  }
  return { items, facets };
}

export function buildAttentionContextBlock(
  vault: string,
  flowIds: ReadonlyArray<string>,
): string | null {
  const chunks: string[] = [];
  for (const id of flowIds) {
    try {
      chunks.push(renderAttentionFlow(vault, id));
    } catch {
      continue;
    }
  }
  if (chunks.length === 0) return null;
  return chunks.join("\n");
}
