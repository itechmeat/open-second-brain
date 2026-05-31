import { createHash } from "node:crypto";

import { appendContinuityRecord } from "./continuity/store.ts";
import type { ContinuityRecord } from "./continuity/types.ts";

export type ContextReceiptTrigger = "context_pack" | "pre_compress";

export interface ContextReceiptOptions {
  readonly host: string;
  readonly trigger: ContextReceiptTrigger;
  readonly createdAt?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface ContextReceiptItemInput {
  readonly id: string;
  readonly path?: string;
  readonly text?: string;
  readonly tokens?: number;
  readonly tier?: string;
  readonly trimmed?: boolean;
  readonly safetyFiltered?: boolean;
}

export interface EmitContextReceiptInput {
  readonly options: ContextReceiptOptions;
  readonly items: ReadonlyArray<ContextReceiptItemInput>;
  readonly finalText: string;
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export function emitContextReceipt(
  vault: string,
  input: EmitContextReceiptInput,
): ContinuityRecord {
  const createdAt = input.options.createdAt ?? new Date().toISOString();
  const itemPayloads = input.items.map((item, index) => ({
    id: item.id,
    original_rank: index + 1,
    ...(item.path ? { path: item.path } : {}),
    ...(item.tokens !== undefined ? { tokens: item.tokens } : {}),
    ...(item.tier ? { tier: item.tier } : {}),
    ...(item.trimmed !== undefined ? { trimmed: item.trimmed } : {}),
    ...(item.safetyFiltered !== undefined ? { safety_filtered: item.safetyFiltered } : {}),
    ...(item.text ? { text_hash: sha256(item.text) } : {}),
  }));
  return appendContinuityRecord(vault, {
    kind: "context_receipt",
    createdAt,
    sourceRefs: input.items.map((item) => ({
      id: item.id,
      ...(item.path ? { path: item.path } : {}),
      ...(item.text ? { hash: sha256(item.text) } : {}),
    })),
    payload: {
      host: input.options.host,
      trigger: input.options.trigger,
      ...(input.options.sessionId ? { session_id: input.options.sessionId } : {}),
      ...(input.options.turnId ? { turn_id: input.options.turnId } : {}),
      item_count: input.items.length,
      final_text_hash: sha256(input.finalText),
      final_text_chars: [...input.finalText].length,
      items: itemPayloads,
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.extra ?? {}),
    },
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
