/**
 * The vault-policy tools of the admin family: the label vocabulary
 * (`brain_labels`), the frontmatter tier guard (`brain_tiers`) and the
 * secret custody surface (`brain_secrets`). Split from `admin-tools.ts`
 * (task 3.19); registration happens through that module's registry,
 * which preserves the public ADMIN_TOOLS surface.
 */

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { toPosix } from "../../core/path-safety.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { resolveAgentName } from "../../core/config.ts";
import { resolveSearchConfig } from "../../core/search/index.ts";
import { Store } from "../../core/search/store.ts";
import {
  assignNoteLabel,
  LabelVocabularyError,
  readLabels,
  removeNoteLabel,
} from "../../core/brain/labels.ts";
import { LabelSuggestPrivateNoteError, suggestNoteLabels } from "../../core/brain/label-suggest.ts";
import { StandingRulesWriteRefusedError } from "../../core/brain/standing-rules.ts";
import { GovernedPathWriteRefusedError } from "../../core/write-binding/index.ts";
import { assertVaultIdentityForWrite } from "../../core/brain/vault-identity.ts";
import { loadSchemaPack } from "../../core/brain/schema-pack.ts";
import { listSecrets } from "../../core/brain/secrets/store.ts";
import { runWithSecret, SecretExecDeniedError } from "../../core/brain/secrets/exec.ts";
import { readableAtContextReach, readableAtContextReachOrUndefined } from "./reach-readable.ts";
import { requiredStringArg } from "./shared.ts";
import { writeFrontmatterAtomic } from "../../core/vault.ts";
import { resolveNotePath } from "../../core/brain/note-path.ts";
import type { FrontmatterMap } from "../../core/types.ts";
import { parseFrontmatter } from "../../core/vault.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { coerceStrList, unknownOperationError } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext } from "../tool-contract.ts";
import { contextReach } from "../tool-contract.ts";

/**
 * `brain_labels suggest`: advisory decision-model suggestions (use
 * `labels`). Read-only; never assigns.
 */
export async function labelsSuggest(
  ctx: ServerContext,
  args: Record<string, unknown>,
  path: string,
): Promise<Record<string, unknown>> {
  const abs = vaultContainedPath(ctx.vault, path, "brain_labels suggest");
  // Same reach rule as `show`: a page reserved against remote reads
  // answers exactly as an absent one.
  const view = reachView(ctx.vault, contextReach(ctx));
  if (!view.visible(toPosix(relative(ctx.vault, abs)))) {
    throw new MCPError(INVALID_PARAMS, `brain_labels suggest: note does not exist: ${path}`);
  }
  const dimensions = coerceStrList(args, "dimensions");
  try {
    const result = await suggestNoteLabels(ctx.vault, path, {
      pack: loadSchemaPack(ctx.vault),
      ...(dimensions.length > 0 ? { dimensions } : {}),
      configPath: ctx.configPath,
    });
    return { ...result };
  } catch (exc) {
    if (exc instanceof LabelVocabularyError || exc instanceof LabelSuggestPrivateNoteError) {
      throw new MCPError(INVALID_PARAMS, `brain_labels suggest: ${exc.message}`);
    }
    throw exc;
  }
}

/** Controlled-vocabulary classification over the schema pack's labels. */
export function toolBrainLabels(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> | Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "assign" && op !== "remove" && op !== "show" && op !== "suggest") {
    throw unknownOperationError("brain_labels: operation must be assign|remove|show|suggest");
  }
  // a-label-is-not-a-boundary, U12: the ARGUMENT is right and the
  // VALIDATOR's message was wrong. `path` is the only name this tool
  // declares for the note - a caller passing `id` is refused by name by
  // the unknown-argument gate (`src/mcp/argument-guard.ts`) before the
  // handler runs - but this check answered an ABSENT `path` with a
  // sentence about its SHAPE, so a caller who sent the wrong name read
  // it as "my path is malformed" and retried the same call. The shared
  // coercion already tells absence and malformation apart, and stamps
  // the operation into both, so the two failures no longer share a
  // sentence.
  const path = requiredStringArg(`brain_labels ${op}`, args, "path");
  if (op === "suggest") return labelsSuggest(ctx, args, path);
  if (op === "show") {
    const abs = vaultContainedPath(ctx.vault, path, "brain_labels show");
    // A metadata oracle otherwise (audit L8): at remote reach a page
    // reserved against remote reads answers exactly as an absent one, so
    // the reply cannot prove it exists. At local reach the view is a no-op.
    const view = reachView(ctx.vault, contextReach(ctx));
    if (!view.visible(toPosix(relative(ctx.vault, abs)))) {
      throw new MCPError(INVALID_PARAMS, `brain_labels show: note does not exist: ${path}`);
    }
    const [metadata] = parseFrontmatter(abs);
    return { path, labels: readLabels(metadata) };
  }
  const pack = loadSchemaPack(ctx.vault);
  const dimension = args["dimension"];
  if (typeof dimension !== "string" || dimension.trim() === "") {
    throw new MCPError(INVALID_PARAMS, `brain_labels ${op}: dimension must be non-empty`);
  }
  // A note the caller may not read at its reach is refused as a missing
  // one, before its frontmatter is read or written.
  const readable = readableAtContextReachOrUndefined(ctx);
  const reach = readable !== undefined ? { readable } : {};
  try {
    if (op === "remove") {
      return { ...removeNoteLabel(ctx.vault, path, { dimension, pack, ...reach }) };
    }
    const value = args["value"];
    if (typeof value !== "string" || value.trim() === "") {
      throw new MCPError(INVALID_PARAMS, "brain_labels assign: value must be non-empty");
    }
    const agentArg = args["agent"];
    const agent =
      normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
      resolveAgentName(ctx.configPath ?? undefined);
    return {
      ...assignNoteLabel(ctx.vault, path, {
        dimension,
        value,
        pack,
        agent,
        now: new Date(),
        ...reach,
      }),
    };
  } catch (exc) {
    if (exc instanceof LabelVocabularyError) {
      throw new MCPError(INVALID_PARAMS, `brain_labels ${op}: ${exc.message}`);
    }
    // A refused target is a bad argument, not a server fault: the caller
    // named a file this surface will not rewrite, and the message says
    // which one so the agent stops trying rather than retrying blind.
    if (exc instanceof StandingRulesWriteRefusedError) {
      throw new MCPError(INVALID_PARAMS, `brain_labels ${op}: ${exc.message}`);
    }
    // The Brain machinery root and the operator's declared write binding
    // refuse the same way: the caller named a target the governance
    // envelope does not admit, and naming it back is the whole answer.
    if (exc instanceof GovernedPathWriteRefusedError) {
      throw new MCPError(INVALID_PARAMS, `brain_labels ${op}: ${exc.message}`);
    }
    throw exc;
  }
}

// ----- brain_tiers (t_3f92d3f1) ----------------------------------------------

/** Staged repair surface for identity-tier frontmatter hand-edits. */
export async function toolBrainTiers(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "check" && op !== "restore" && op !== "accept") {
    throw unknownOperationError("brain_tiers: operation must be check|restore|accept");
  }
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  if (op === "check") {
    // Fail-soft: a vault that was never indexed has no snapshots and
    // therefore no drift - not an error.
    if (!existsSync(searchConfig.dbPath)) return { findings: [] };
    // A drift row names a page's path and both values of one of its
    // identity fields, so only the rows of pages the caller may read at
    // its reach are listed.
    const readable = readableAtContextReach(ctx);
    const store = await Store.open(searchConfig, { mode: "read" });
    try {
      return { findings: store.listTierDrift().filter((row) => readable(row.path)) };
    } finally {
      await store.close();
    }
  }
  // Same conflation as `brain_labels` above, same cure: `path` is
  // optional for `check` and required for the two write operations, and
  // "you did not send it" is a different sentence from "what you sent is
  // not a path".
  const path = requiredStringArg(`brain_tiers ${op}`, args, "path");
  if (op === "restore" && args["apply"] !== true) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_tiers restore: pass apply=true - restore writes the file",
    );
  }
  // Both remaining operations WRITE - `restore` rewrites the note's
  // frontmatter, `accept` rewrites the tier snapshot - so both answer to
  // the freeze the way every other content write does. The dispatcher
  // turns the thrown `VaultFrozenError` into the structured refusal and
  // records the attempt, so a frozen vault is not writable through this
  // surface merely because it is a repair surface.
  assertVaultIdentityForWrite(ctx.vault);
  const field = typeof args["field"] === "string" ? (args["field"] as string) : undefined;
  if (!existsSync(searchConfig.dbPath)) {
    throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: the vault has no search index yet`);
  }
  const store = await Store.open(searchConfig, { mode: "write" });
  try {
    // A page the caller may not read at its reach is refused as one the
    // index never saw, before anything about its drift is read or written.
    const docId = readableAtContextReach(ctx)(path) ? store.getDocumentIdByPath(path) : null;
    if (docId === null) {
      throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: not indexed: ${path}`);
    }
    const rows = store
      .listTierDrift()
      .filter((r) => r.documentId === docId && (field === undefined || r.field === field));
    if (rows.length === 0) {
      throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: no open drift for ${path}`);
    }
    if (op === "restore") {
      const absolute = vaultContainedPath(ctx.vault, path, "brain_tiers restore");
      const [metadata, body] = parseFrontmatter(absolute);
      const next = { ...metadata };
      for (const r of rows) {
        next[r.field] = frontmatterValueFromSnapshot(r.expected, r.field);
      }
      writeFrontmatterAtomic(absolute, next, body, { overwrite: true });
      for (const r of rows) store.clearTierDrift(docId, r.field);
      return { restored: rows.map((r) => r.field), path };
    }
    const snapshot: Record<string, unknown> = { ...store.getTierSnapshot(docId) };
    for (const r of rows) {
      snapshot[r.field] = r.actual;
      store.clearTierDrift(docId, r.field);
    }
    store.setTierSnapshot(docId, snapshot);
    return { accepted: rows.map((r) => r.field), path };
  } finally {
    await store.close();
  }
}

/** Resolve a vault-relative path, refusing traversal and symlink escapes. */
export function vaultContainedPath(vault: string, relPath: string, label: string): string {
  try {
    return resolveNotePath(vault, relPath);
  } catch (exc) {
    throw new MCPError(INVALID_PARAMS, `${label}: ${(exc as Error).message}`);
  }
}

/** Narrow a snapshot value to the shapes frontmatter can carry. */
export function frontmatterValueFromSnapshot(
  value: unknown,
  field: string,
): FrontmatterMap[string] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
    return value;
  }
  throw new MCPError(
    INVALID_PARAMS,
    `brain_tiers restore: snapshot value for "${field}" is not a frontmatter scalar or string array`,
  );
}

// ----- brain_secrets (t_0b134404) ---------------------------------------------

/**
 * Capability-gated custody, agent-facing subset: list metadata and
 * run an allowlisted command. Deliberately NO set/get over MCP - the
 * material enters via the operator's CLI and leaves only into a
 * subprocess env.
 */
export async function toolBrainSecrets(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "list" && op !== "run") {
    throw unknownOperationError("brain_secrets: operation must be list|run");
  }
  if (op === "list") {
    return { secrets: listSecrets(ctx.vault) };
  }
  const name = args["name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_secrets run: name must be non-empty");
  }
  const command = args["command"];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part): part is string => typeof part === "string")
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_secrets run: command must be a non-empty array of strings",
    );
  }
  const agentArg = args["agent"];
  const agent =
    normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
    resolveAgentName(ctx.configPath ?? undefined);
  try {
    const result = await runWithSecret(ctx.vault, name, command, { agent, now: new Date() });
    return { exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (exc) {
    if (exc instanceof SecretExecDeniedError) {
      throw new MCPError(INVALID_PARAMS, `brain_secrets run: ${exc.message}`);
    }
    throw exc;
  }
}
