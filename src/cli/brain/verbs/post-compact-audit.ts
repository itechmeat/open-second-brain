import { defaultConfigPath, resolvePostCompactSurvivalAudit } from "../../../core/config.ts";
import {
  auditPostCompaction,
  type ConversationMessage,
} from "../../../core/brain/post-compact-audit.ts";
import { readHookInput } from "../../../../hooks/lib/stdin.ts";
import { CliError, okJson, parse, resolveBrainVault } from "../helpers.ts";
import { inspect } from "node:util";

/**
 * Post-compaction pinned-anchor survival audit entry. Reads the
 * post-compaction conversation (a `{ session_id, messages }` JSON
 * document) from stdin — the shape a host hook hands a context-event
 * hook — detects the Hermes compaction, and re-asserts only the drifted
 * anchors.
 *
 * Gated by `post_compact_survival_audit` (default OFF): when the operator
 * has not opted in, the verb is a no-op that reports `enabled: false` and
 * touches nothing, so unchanged installs stay byte-identical. `--force`
 * runs the audit regardless of the gate (for diagnostics).
 */
export async function cmdBrainPostCompactAudit(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    json: { type: "boolean" },
    vault: { type: "string" },
    "session-id": { type: "string" },
    "no-reassert": { type: "boolean" },
    force: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const enabled = resolvePostCompactSurvivalAudit(config);
  const forced = flags["force"] === true;
  if (!enabled && !forced) {
    writeOutput(
      { enabled: false, forced: false, compaction_detected: false },
      flags["json"] === true,
    );
    return 0;
  }

  let payload: unknown;
  try {
    payload = await readHookInput();
  } catch (err) {
    throw new CliError(
      `brain post-compact-audit: failed to read stdin: ${(err as Error).message ?? err}`,
    );
  }

  const sessionId = stringOptional(flags["session-id"]) ?? readSessionId(payload) ?? undefined;
  if (sessionId === undefined) {
    throw new CliError(
      "brain post-compact-audit: --session-id or a payload session_id is required",
    );
  }
  const messages = readMessages(payload);

  const result = auditPostCompaction(vault, {
    sessionId,
    messages,
    ...(flags["no-reassert"] === true ? { reassert: false } : {}),
  });

  writeOutput(
    {
      enabled,
      forced,
      compaction_detected: result.compactionDetected,
      already_audited: result.alreadyAudited,
      summary_hash: result.summaryHash,
      drifted: result.drifted,
      survived: result.survived,
      absent: result.absent,
      reasserted: result.reasserted,
      ...(result.reminderBlock !== null ? { reminder_block: result.reminderBlock } : {}),
      errors: result.errors,
    },
    flags["json"] === true,
  );
  return 0;
}

function readSessionId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as { session_id?: unknown }).session_id;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readMessages(payload: unknown): ReadonlyArray<ConversationMessage> {
  if (payload === null || typeof payload !== "object") return [];
  const raw = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) return [];
  const messages: ConversationMessage[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (typeof content !== "string") continue;
    const role = (item as { role?: unknown }).role;
    messages.push(typeof role === "string" ? { role, content } : { content });
  }
  return messages;
}

function stringOptional(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function writeOutput(value: Record<string, unknown>, json: boolean): void {
  if (json) {
    okJson(value);
    return;
  }
  process.stdout.write(inspect(value, { colors: false, depth: null }) + "\n");
}
