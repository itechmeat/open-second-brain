/**
 * `brain_context` (task 3.19): the active-digest regeneration the agent
 * context opens with, with the standing-rules and scoped-rules blocks it
 * renders and the counts it reports. Split from `context-tools.ts`;
 * registration happens through that module's registry, which preserves
 * the public CONTEXT_TOOLS surface.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  brainDirsOf,
  brainStandingRulesPath,
  BRAIN_ACTIVE_FILE,
  BRAIN_ROOT_REL,
} from "../../core/brain/paths.ts";
import {
  readStandingRules,
  renderStandingRules,
  renderStandingRulesFailure,
  type StandingRules,
} from "../../core/brain/standing-rules.ts";
import {
  loadBrainConfig,
  resolveScopedRulesMaxChars,
  resolveStandingRulesMaxChars,
} from "../../core/brain/policy.ts";
import {
  readScopedRules,
  type ScopedRuleIdentity,
  type ScopedRules,
} from "../../core/brain/scoped-rules.ts";
import { resolveHostScope, resolveProjectScope } from "../../core/brain/scope-identity.ts";
import type { BrainConfig } from "../../core/brain/types.ts";
import {
  regenerateActive,
  readerNarrowsActive,
  renderActiveForReader,
  type RegenerateActiveResult,
} from "../../core/brain/active.ts";
import {
  compiledDigestPath,
  digestsRenderedOnDemand,
} from "../../core/brain/compiled-digest-path.ts";
import { computeMaintenanceOverdueFlag } from "../../core/brain/status.ts";
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { parseFrontmatter } from "../../core/vault.ts";
import { readVaultInstructionFile } from "../../core/brain/vault-instruction-file.ts";
import { readPinnedContext } from "../../core/brain/pinned.ts";
import { contextReach, contextVault, type ServerContext } from "../tool-contract.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { deliveryView } from "./reach-events.ts";
import { readableAtContextReachOrUndefined } from "./reach-readable.ts";
import { toolPath } from "./device-path.ts";
import {
  appendPinnedToContextContent,
  serializePinnedContext,
  shapedPinnedContent,
} from "./context-pinned-tools.ts";

export type BrainContextCounts = RegenerateActiveResult["counts"];

export const EMPTY_CONTEXT_COUNTS: BrainContextCounts = {
  confirmed: 0,
  quarantine: 0,
  retired_recent: 0,
  most_applied_30d: 0,
};

/**
 * Pull-bootstrap of `Brain/active.md` + the active-preference counts.
 * Built for runtimes that have no `SessionStart` hook (Cursor, Aider,
 * raw Claude API): one tool call gives the agent the same shortcut card
 * the SessionStart-aware runtimes get injected automatically.
 *
 * Not a pure read: the bootstrap path calls `regenerateActive`, which
 * writes `Brain/active.md` whenever the on-disk body is absent or
 * stale, so the tool classifies `write` (write-mode-dominant,
 * `tool-contract.ts`) and the stdio transport never runs two bootstrap
 * calls beside each other on the concurrent read path.
 *
 * Behaviour matrix:
 *   - Brain/ absent           → present:false, zero counts, and content
 *                               carrying the standing-rules block or the
 *                               statement that it could not be read (empty
 *                               for the ordinary case, where there is no
 *                               such file either).
 *   - Brain/ present, active.md absent → call regenerateActive (idempotent)
 *                                        and read the regenerated file.
 *   - Brain/ present, active.md fresh  → idempotent regenerate leaves an
 *                                        equal body on disk; the on-disk
 *                                        body is returned verbatim.
 */
export async function toolBrainContext(ctx: ServerContext): Promise<Record<string, unknown>> {
  // `null` on a server with no vault (design D14): the digest renders from
  // the store's folds into the device-local cache, and there is no vault
  // file to read (standing rules, scoped rules, the instruction file).
  const vault = contextVault(ctx);
  const dirs = brainDirsOf(vault);
  // `Brain/active.md` on an unswitched machine; on a store-only one the
  // device-local cache the digest is rendered into on demand (D14 item 7).
  const activePath = compiledDigestPath(vault, "active");
  const onDemand = digestsRenderedOnDemand(vault);
  const pinned = readPinnedContext(vault);
  // The request's delivery binding, resolved ONCE and used for the active
  // body AND the pinned scratchpad beside it (delivery-trust, lane A): one
  // frontmatter cache serves the whole assembly, instead of the pinned
  // serializer building a second binding per call.
  const delivery = deliveryView(ctx);
  // Bounded to the single newest `Brain/log/` day - see
  // `computeMaintenanceOverdueFlag`'s docblock for the cost bound. This
  // is the always-loaded path, so the full `maintenance_debt` derivation
  // on `computeBrainStatus` never runs here.
  const maintenanceOverdue = computeMaintenanceOverdueFlag(vault, {
    withholdsPrivate: contextReach(ctx) !== TRANSPORT_REACH.local,
  });

  // The operator's standing rules, resolved before anything else this
  // surface assembles - INCLUDING the no-Brain return below. `brain_context`
  // is the pull-mode twin of the SessionStart hook, so the constitution has
  // to lead the content here for exactly the reason it leads the injected
  // payload: on the error branch further down, which zeroes `content` and
  // would otherwise hand a runtime the memory layer's failure and none of
  // the rules that still govern it, and equally on the branch that reports
  // `Brain/` as absent. That probe answers false for a directory it cannot
  // TRAVERSE as well as one that is not there, and it was the one return
  // path that said nothing at all about the rules - the last silent answer
  // on a surface where every other path either carries the block or states
  // why it could not be read.
  const standing = vault === null ? NO_STANDING_BLOCK : readStandingBlock(vault);
  // The scoped operator rules for the project, harness and host this
  // server was launched for - local reach only, see `readScopedBlock`.
  // Read beside the constitution, before the no-Brain return, for the
  // same reason: the rules govern a session whatever the memory layer did.
  const scoped = readScopedBlock(ctx);

  // A store-only machine keeps its memory in the store, `Brain/` or not.
  if (!onDemand && !existsSync(dirs.brain)) {
    return {
      vault_path: vaultPathField(ctx),
      present: false,
      active_path: activePath,
      content: prependBlock(standing.text, prependBlock(scoped?.text ?? "", "")),
      counts: EMPTY_CONTEXT_COUNTS,
      generated_at: null,
      pinned: serializePinnedContext(ctx, pinned, undefined, undefined, {
        shapeBody: true,
        delivery,
      }),
      maintenance_overdue: maintenanceOverdue,
      ...standingRulesField(ctx, standing),
      ...scopedRulesField(scoped),
    };
  }

  let counts: BrainContextCounts = EMPTY_CONTEXT_COUNTS;
  let error: string | undefined;
  try {
    // The SHARED file is regenerated unscoped, always. `active.md` is one
    // file for the whole vault - injected into every agent's SessionStart
    // by `hooks/active-inject.ts` and regenerated unscoped by the
    // `osb://preferences/active` resource - so narrowing the WRITE to this
    // caller would make it thrash and could drop an agent's own memories
    // from its session start (context-integrity-gates, A3).
    counts = regenerateActive(vault).counts;
  } catch (err) {
    error = (err as Error)?.message ?? String(err);
  }

  // After a successful regenerateActive, active.md is guaranteed to
  // exist (the function either wrote it or confirmed an equal body
  // already on disk). A read failure here is an unrelated filesystem
  // race, not a missing-file branch — handle it in the same `error`
  // slot the regenerate failure uses.
  let content = "";
  let generatedAt: string | null = null;
  if (!error) {
    try {
      content = readFileSync(activePath, "utf8");
      const [meta] = parseFrontmatter(activePath);
      const v = meta["generated_at"];
      if (typeof v === "string" && v.trim().length > 0) {
        generatedAt = v;
      }
    } catch (err) {
      error = (err as Error)?.message ?? String(err);
      content = "";
      generatedAt = null;
    }
  }
  // What this ONE caller is handed, not what is on disk, answers at its
  // reach and under the owner gate. This surface takes no arguments, so
  // `ServerContext.agentName` is its only source of identity and the
  // minted reach its only source of distance. A preference or retired
  // record the caller cannot read is absent from its digest - principle,
  // counts and most-applied entry alike. A local caller with no enforced
  // owner scope keeps the file's own bytes; any other caller gets the
  // reader render, decided on its reach rather than on what is withheld,
  // and stamped with the generation already on disk.
  if (!error) {
    const readable = readableAtContextReachOrUndefined(ctx);
    const reader = {
      ...(readable !== undefined ? { readable } : {}),
      restricted: contextReach(ctx) !== TRANSPORT_REACH.local,
      ...(ctx.agentName !== undefined ? { agentScope: ctx.agentName } : {}),
    };
    if (readerNarrowsActive(vault, reader)) {
      const narrowed = renderActiveForReader(vault, reader);
      content = narrowed.document;
      counts = narrowed.counts;
    }
  }

  // Constitution first, then the scoped rules, then the memory body -
  // and the body is shaped BEFORE the assembly (delivery-trust, lane A):
  // the fence wraps the stored-record bytes only. The constitution and
  // the scoped rules are the operator's own voice delivered local-only,
  // and the pinned scratchpad shapes through the same binding beside
  // this assembly, so neither slips past the fence the body carries.
  // An unfetchable body has nothing to fence: the pinned scratchpad's
  // shaper skips empty bodies, and the main body answers the same way
  // instead of wrapping an empty block in the fence.
  if (content.length > 0) {
    content = delivery.shape(content, `${BRAIN_ROOT_REL}/${BRAIN_ACTIVE_FILE}`);
  }
  content = prependBlock(standing.text, prependBlock(scoped?.text ?? "", content));
  content = appendPinnedToContextContent(content, shapedPinnedContent(ctx, pinned, delivery));

  // Optional vault-root instruction file (v0.10.17). Absent file =
  // field omitted so hosts that strip unknown fields stay
  // byte-identical.
  //
  // A THROW IS NOT AN ABSENCE. This used to be `catch { null }`, which
  // put an operator configuration error - an absolute path, a `..`
  // segment, an empty name - and an unreadable file on the same wire as
  // a vault that simply has no instruction file: the field vanished and
  // nothing said why. The reason now rides its own key, so the
  // enrichment stays best-effort without being silent.
  let vaultInstruction: ReturnType<typeof readVaultInstructionFile> = null;
  let vaultInstructionError: string | undefined;
  try {
    vaultInstruction = vault === null ? null : readVaultInstructionFile(vault);
  } catch (err) {
    vaultInstructionError = (err as Error)?.message ?? String(err);
  }

  return {
    vault_path: vaultPathField(ctx),
    present: true,
    active_path: activePath,
    content,
    counts,
    generated_at: generatedAt,
    pinned: serializePinnedContext(ctx, pinned, undefined, undefined, {
      shapeBody: true,
      delivery,
    }),
    maintenance_overdue: maintenanceOverdue,
    ...(error ? { error } : {}),
    ...standingRulesField(ctx, standing),
    ...scopedRulesField(scoped),
    ...(vaultInstruction
      ? {
          vault_instruction: {
            path: vaultInstruction.path,
            content: vaultInstruction.content,
            lines: vaultInstruction.lines,
          },
        }
      : {}),
    ...(vaultInstructionError !== undefined
      ? { vault_instruction_error: vaultInstructionError }
      : {}),
  };
}

/**
 * The standing-rules block and the record behind it, or neither.
 *
 * The two travel together because the response reports them in two
 * different places - the block is prepended to `content`, the record
 * becomes the `standing_rules` key - and a read that FAILED produces a
 * block but no record: there is no path/content/truncated triple to
 * report for bytes nobody could read, and the block itself is what says
 * so in words the agent will read.
 */
export interface StandingBlock {
  readonly text: string;
  readonly rules: StandingRules | null;
}

export const NO_STANDING_BLOCK: StandingBlock = Object.freeze({ text: "", rules: null });

export function readStandingBlock(vault: string): StandingBlock {
  const path = brainStandingRulesPath(vault);
  let cfg: BrainConfig | null = null;
  try {
    cfg = loadBrainConfig(vault);
  } catch {
    // A `_brain.yaml` this surface cannot read resolves the cap to its
    // default; the config failure itself surfaces through the `error`
    // slot that the regenerate arm above already populates.
  }
  try {
    const rules = readStandingRules(vault, { maxChars: resolveStandingRulesMaxChars(cfg) });
    if (rules === null) return NO_STANDING_BLOCK;
    return Object.freeze({ text: renderStandingRules(rules), rules });
  } catch (err) {
    return Object.freeze({ text: renderStandingRulesFailure(path, err), rules: null });
  }
}

/**
 * The optional `standing_rules` key, or nothing.
 *
 * Both return shapes spread it from here so the two cannot disagree about
 * when the key appears. It is omitted for a vault whose operator wrote no
 * rules AND for a read that failed - the failure has no path/content/
 * truncated triple to report, and the block inside `content` is what says
 * so in words.
 */
export function standingRulesField(
  ctx: ServerContext,
  standing: StandingBlock,
): Record<string, unknown> {
  if (standing.rules === null) return {};
  return {
    standing_rules: {
      path: toolPath(ctx, standing.rules.path),
      content: standing.rules.text,
      truncated: standing.rules.truncated,
    },
  };
}

/** Put a block at the head of the content, or leave the content alone. */
export function prependBlock(block: string, content: string): string {
  if (block.length === 0) return content;
  const trimmed = content.trimStart();
  return trimmed.length === 0 ? `${block}\n` : `${block}\n\n${trimmed}`;
}

/**
 * The scoped operator rules rendered for this server's scope, or nothing.
 *
 * LOCAL REACH ONLY. The scope is resolved from facts about the process
 * that serves the call - the directory it was launched in, the harness
 * its registration names, the device it runs on - and at remote reach
 * none of them describes the caller. So at remote reach nothing is read
 * at all: not the files, not the pointer, not the device id, and the
 * answer is byte-identical whether or not any scoped file exists.
 *
 * The identity comes from {@link ServerContext.ruleScope} and the device
 * id; no argument of this tool can name it (the tool takes none).
 */
export function readScopedBlock(ctx: ServerContext): ScopedRules | null {
  if (contextReach(ctx) !== TRANSPORT_REACH.local) return null;
  // Scoped rules are vault files; a server with no vault has none.
  if (contextVault(ctx) === null) return null;
  let host: { readonly host: string | null; readonly unreadable: boolean };
  try {
    host = resolveHostScope(ctx.configPath ?? undefined);
  } catch {
    // A device id that cannot be resolved for any other reason (a config
    // home that cannot be created, say) must not take the bootstrap
    // surface down with it. It matches no host file, and the block says
    // so when there is a host file it could have matched.
    host = { host: null, unreadable: true };
  }
  const identity: ScopedRuleIdentity = {
    project: resolveProjectScope(ctx.ruleScope?.workspaceDir ?? null, ctx.vault),
    harness: ctx.ruleScope?.harness ?? null,
    host: host.host,
  };
  let rules: ScopedRules;
  try {
    rules = readScopedRules(ctx.vault, identity, {
      maxChars: scopedRulesMaxChars(ctx.vault),
      hostUnreadable: host.unreadable,
    });
  } catch {
    // The reader renders every per-file failure as an `UNAVAILABLE:` line
    // and does not throw for one; anything that still escapes it must not
    // take the constitution and the memory layer down with the scoped block.
    return null;
  }
  return rules.text.length === 0 ? null : rules;
}

/**
 * The configured cap, or its default when `_brain.yaml` cannot be read
 * (that failure surfaces through the regenerate arm's `error` slot, as
 * for the constitution's cap).
 */
export function scopedRulesMaxChars(vault: string): number {
  let cfg: BrainConfig | null = null;
  try {
    cfg = loadBrainConfig(vault);
  } catch {
    // absorbed - see above
  }
  return resolveScopedRulesMaxChars(cfg);
}

/**
 * The optional `scoped_rules` key, or nothing: present only when a file
 * matched or the host notice applies, so a vault with no scoped rules -
 * and every remote caller - keeps today's bytes.
 */
export function scopedRulesField(scoped: ScopedRules | null): Record<string, unknown> {
  if (scoped === null) return {};
  return {
    scoped_rules: {
      scope: {
        project: scoped.identity.project,
        harness: scoped.identity.harness,
        host: scoped.identity.host,
      },
      files: scoped.files.map((file) => ({
        path: file.path,
        axis: file.axis,
        truncated: file.truncated,
      })),
    },
  };
}
