import { existsSync, readFileSync } from "node:fs";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { sanitiseTextField } from "../redactor.ts";
import { brainPinnedPath } from "./paths.ts";

export const MAX_PINNED_CONTEXT_LEN = 20_000;

export interface PinnedContext {
  readonly path: string;
  readonly present: boolean;
  readonly content: string;
}

export function readPinnedContext(vault: string): PinnedContext {
  const path = brainPinnedPath(vault);
  if (!existsSync(path)) {
    return { path, present: false, content: "" };
  }
  return {
    path,
    present: true,
    content: readFileSync(path, "utf8").trimEnd(),
  };
}

export function writePinnedContext(vault: string, content: unknown): PinnedContext {
  const path = brainPinnedPath(vault);
  const normalised = normalisePinnedContent(content);
  atomicWriteFileSync(path, normalised.length > 0 ? `${normalised}\n` : "");
  return { path, present: true, content: normalised };
}

export function appendPinnedContext(vault: string, content: unknown): PinnedContext {
  const incoming = normalisePinnedContent(content);
  if (incoming.length === 0) return readPinnedContext(vault);

  const current = readPinnedContext(vault).content;
  const next = current.length > 0 ? `${current}\n\n${incoming}` : incoming;
  return writePinnedContext(vault, next);
}

export function clearPinnedContext(vault: string): PinnedContext {
  const path = brainPinnedPath(vault);
  atomicWriteFileSync(path, "");
  return { path, present: true, content: "" };
}

function normalisePinnedContent(content: unknown): string {
  return sanitiseTextField(content, {
    maxLen: MAX_PINNED_CONTEXT_LEN,
  }).trim();
}
