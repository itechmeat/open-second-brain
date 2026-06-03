/**
 * Scoped current-intention chains (Agent Surface Suite, t_6d78f69e).
 *
 * A per-workstream "now" document: `Brain/intentions/<scope>.md` holds
 * the current intention, every update bumps `version` and appends the
 * superseded text to an in-file `## History` trail, and `move`
 * retires the whole chain into `Brain/intentions/history/` so the
 * active directory only ever shows live work. Markdown first - the
 * chain is operator-readable without any tooling. `Brain/pinned.md`
 * stays untouched as the scope-free scratchpad.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { parseFrontmatter } from "../vault.ts";
import { resolveSessionScope } from "./session-scope.ts";
import { isoDate, isoSecond } from "./time.ts";

export interface IntentionChain {
  readonly scope: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly agent: string;
  /** Current intention text (without the history trail). */
  readonly text: string;
  /** History lines, newest first. */
  readonly history: ReadonlyArray<string>;
  readonly path: string;
}

export interface SetIntentionInput {
  readonly scope: string;
  readonly text: string;
  readonly agent: string;
  readonly now?: Date;
}

export interface MoveIntentionInput {
  readonly scope: string;
  readonly now?: Date;
}

export interface MoveIntentionResult {
  readonly scope: string;
  readonly archivePath: string;
}

const HISTORY_HEADER = "## History";
const HISTORY_SNIPPET_CHARS = 120;

function intentionsDir(vault: string): string {
  return join(vault, "Brain", "intentions");
}

function intentionPath(vault: string, scope: string): string {
  return join(intentionsDir(vault), `${scope}.md`);
}

function renderChain(chain: Omit<IntentionChain, "path">): string {
  const history =
    chain.history.length === 0
      ? ""
      : `\n${HISTORY_HEADER}\n\n${chain.history.map((line) => `- ${line}`).join("\n")}\n`;
  return [
    "---",
    `scope: ${chain.scope}`,
    `version: ${chain.version}`,
    `updated_at: ${chain.updatedAt}`,
    `agent: ${chain.agent}`,
    "---",
    "",
    chain.text,
    history,
  ].join("\n");
}

function parseChain(vault: string, scope: string): IntentionChain | null {
  const path = intentionPath(vault, scope);
  if (!existsSync(path)) return null;
  const [meta, body] = parseFrontmatter(path);
  const versionRaw = meta["version"];
  const version =
    typeof versionRaw === "string" && /^[0-9]+$/.test(versionRaw)
      ? Number.parseInt(versionRaw, 10)
      : 1;
  const headerIndex = body.indexOf(HISTORY_HEADER);
  const text = (headerIndex < 0 ? body : body.slice(0, headerIndex)).trim();
  const history: string[] = [];
  if (headerIndex >= 0) {
    for (const line of body.slice(headerIndex + HISTORY_HEADER.length).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) history.push(trimmed.slice(2));
    }
  }
  return Object.freeze({
    scope,
    version,
    updatedAt: typeof meta["updated_at"] === "string" ? meta["updated_at"] : "",
    agent: typeof meta["agent"] === "string" ? meta["agent"] : "",
    text,
    history: Object.freeze(history),
    path,
  });
}

/** Create or update the scoped intention; prior text lands in history. */
export function setIntention(vault: string, input: SetIntentionInput): IntentionChain {
  const scope = resolveSessionScope(input.scope);
  const now = input.now ?? new Date();
  const text = input.text.trim();
  if (text.length === 0) throw new Error("intention text must not be empty");
  const prior = parseChain(vault, scope);
  const history =
    prior === null
      ? []
      : [
          `v${prior.version} (${prior.updatedAt}): ${prior.text.replace(/\s+/gu, " ").slice(0, HISTORY_SNIPPET_CHARS)}`,
          ...prior.history,
        ];
  const chain = {
    scope,
    version: (prior?.version ?? 0) + 1,
    updatedAt: isoSecond(now),
    agent: input.agent,
    text,
    history: Object.freeze(history),
  };
  mkdirSync(intentionsDir(vault), { recursive: true });
  const path = intentionPath(vault, scope);
  atomicWriteFileSync(path, renderChain(chain));
  return Object.freeze({ ...chain, path });
}

/** Current chain for a scope, or null. */
export function showIntention(vault: string, scope: string): IntentionChain | null {
  return parseChain(vault, resolveSessionScope(scope));
}

/** Active chains sorted by scope. History entries are excluded. */
export function listIntentions(vault: string): IntentionChain[] {
  const dir = intentionsDir(vault);
  if (!existsSync(dir)) return [];
  const out: IntentionChain[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const chain = parseChain(vault, name.replace(/\.md$/u, ""));
    if (chain !== null) out.push(chain);
  }
  return out.toSorted((a, b) => a.scope.localeCompare(b.scope));
}

/** Retire a chain into Brain/intentions/history/ and clear the active file. */
export function moveIntentionToHistory(
  vault: string,
  input: MoveIntentionInput,
): MoveIntentionResult {
  const scope = resolveSessionScope(input.scope);
  const now = input.now ?? new Date();
  const activePath = intentionPath(vault, scope);
  if (!existsSync(activePath)) {
    throw new Error(`no active intention for scope: ${scope}`);
  }
  const historyDir = join(intentionsDir(vault), "history");
  mkdirSync(historyDir, { recursive: true });
  const base = `${scope}-${isoDate(now)}`;
  let archivePath = join(historyDir, `${base}.md`);
  for (let suffix = 2; existsSync(archivePath); suffix++) {
    archivePath = join(historyDir, `${base}-${suffix}.md`);
  }
  try {
    renameSync(activePath, archivePath);
  } catch {
    // Cross-device fallback: copy then remove.
    atomicWriteFileSync(archivePath, readFileSync(activePath, "utf8"));
    rmSync(activePath, { force: true });
  }
  return Object.freeze({ scope, archivePath });
}
