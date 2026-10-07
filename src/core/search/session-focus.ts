import { existsSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { resolveSessionScope } from "../brain/session-scope.ts";
import { derivedDirIsSymlinked, readRegularFileNoFollow } from "../derived-store-guard.ts";
import { atomicWriteText } from "../fs-atomic.ts";
import { resolveIndexPath } from "./paths.ts";
import { SearchError, type ResolvedSearchConfig, type SearchSessionFocus } from "./types.ts";

export interface SessionFocusInput {
  readonly query?: string | null;
  readonly pathPrefix?: string | null;
  readonly ttlMinutes?: number | null;
}

export interface SessionFocusTarget {
  readonly path: string;
  readonly title: string | null;
  readonly content: string;
}

const DEFAULT_TTL_MINUTES = 120;
const MAX_TTL_MINUTES = 24 * 60;
const FOCUS_FILE = "search-focus.json";
const FOCUS_DIR = "search-focus";

function normalizePathPrefix(pathPrefix: string | null | undefined): string | null {
  if (pathPrefix === undefined || pathPrefix === null) return null;
  const normalized = pathPrefix.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.length === 0) return null;
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new SearchError("INVALID_INPUT", "session focus path prefix must stay inside the vault");
  }
  return normalized;
}

function normalizeQuery(query: string | null | undefined): string | null {
  if (query === undefined || query === null) return null;
  const normalized = query.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 ? normalized : null;
}

function normalizeTtlMinutes(raw: number | null | undefined): number {
  const ttl = raw ?? DEFAULT_TTL_MINUTES;
  if (!Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MINUTES) {
    throw new SearchError(
      "INVALID_INPUT",
      `session focus ttl must be an integer in 1..${MAX_TTL_MINUTES}`,
    );
  }
  return ttl;
}

export function normalizeSessionFocus(
  input: SessionFocusInput,
  nowMs = Date.now(),
): SearchSessionFocus {
  const query = normalizeQuery(input.query);
  const pathPrefix = normalizePathPrefix(input.pathPrefix);
  if (query === null && pathPrefix === null) {
    throw new SearchError("INVALID_INPUT", "session focus requires a query or path prefix");
  }
  const ttlMinutes = normalizeTtlMinutes(input.ttlMinutes);
  return Object.freeze({
    query,
    pathPrefix,
    expiresAt: nowMs + ttlMinutes * 60 * 1000,
  });
}

export function sessionFocusIsActive(
  focus: SearchSessionFocus | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!focus) return false;
  return focus.expiresAt === null || focus.expiresAt > nowMs;
}

/**
 * Focus file location. With no scope: the PR #54 global file. With a
 * session scope (Agent Surface Suite, t_5b478e47): one file per scope
 * slug under `search-focus/`, so concurrent sessions never clobber
 * each other's focus.
 */
export function sessionFocusPath(config: ResolvedSearchConfig, sessionScope?: string): string {
  const dir = dirname(resolveIndexPath(config.vault, config.dbPath));
  if (sessionScope === undefined) return join(dir, FOCUS_FILE);
  return join(dir, FOCUS_DIR, `${resolveSessionScope(sessionScope)}.json`);
}

/**
 * True when a directory on the way to the focus file is a symbolic link. The
 * store directory is checked segment by segment from the vault when it lies
 * inside the vault (a vault received from elsewhere could point any of them
 * outside); a store the operator configured outside the vault is trusted as
 * given, and only the per-scope `search-focus/` directory below it is checked.
 */
function focusDirIsSymlinked(config: ResolvedSearchConfig, sessionScope?: string): boolean {
  const storeDir = dirname(resolveIndexPath(config.vault, config.dbPath));
  const scopeSegments = sessionScope === undefined ? [] : [FOCUS_DIR];
  const rel = relative(config.vault, storeDir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return derivedDirIsSymlinked(config.vault, ...rel.split(sep), ...scopeSegments);
  }
  return derivedDirIsSymlinked(storeDir, ...scopeSegments);
}

/**
 * The persisted focus, or null when absent, expired, malformed, not a
 * regular file (a link is not followed) or behind a symlinked directory.
 */
export function readSessionFocus(
  config: ResolvedSearchConfig,
  nowMs = Date.now(),
  sessionScope?: string,
): SearchSessionFocus | null {
  if (focusDirIsSymlinked(config, sessionScope)) return null;
  const read = readRegularFileNoFollow(sessionFocusPath(config, sessionScope));
  if (read.status !== "ok") return null;
  try {
    const parsed = JSON.parse(read.text) as SearchSessionFocus;
    const query = normalizeQuery(typeof parsed.query === "string" ? parsed.query : null);
    const pathPrefix = normalizePathPrefix(
      typeof parsed.pathPrefix === "string" ? parsed.pathPrefix : null,
    );
    const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : null;
    if (expiresAt === null || (query === null && pathPrefix === null)) return null;
    const focus = Object.freeze({ query, pathPrefix, expiresAt });
    return sessionFocusIsActive(focus, nowMs) ? focus : null;
  } catch {
    return null;
  }
}

/**
 * Persist a focus atomically with mode 0600. A symlinked directory on the way
 * is refused with `INVALID_INPUT`; a focus file that is itself a link is
 * replaced by the rename, never written through.
 */
export function writeSessionFocus(
  config: ResolvedSearchConfig,
  focus: SearchSessionFocus,
  sessionScope?: string,
): void {
  if (focusDirIsSymlinked(config, sessionScope)) {
    throw new SearchError(
      "INVALID_INPUT",
      "session focus directory is a symbolic link; refusing to write through it",
    );
  }
  atomicWriteText(sessionFocusPath(config, sessionScope), JSON.stringify(focus, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Remove a persisted focus. A symlinked directory on the way is left alone. */
export function clearSessionFocus(config: ResolvedSearchConfig, sessionScope?: string): void {
  if (focusDirIsSymlinked(config, sessionScope)) return;
  const path = sessionFocusPath(config, sessionScope);
  if (existsSync(path)) rmSync(path, { force: true });
}

/**
 * The focus that applies to a turn: the session's own focus when one
 * is bound and unexpired, else the global focus. The two are never
 * merged - a bound session focus is more specific than the global one,
 * and averaging two intents would steer toward neither.
 */
export function readActiveSessionFocus(
  config: ResolvedSearchConfig,
  sessionId: string | undefined,
  nowMs = Date.now(),
): SearchSessionFocus | null {
  if (sessionId !== undefined) {
    const scoped = readSessionFocus(config, nowMs, sessionId);
    if (scoped !== null) return scoped;
  }
  return readSessionFocus(config, nowMs);
}

function focusTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const token of query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    if (token.length >= 2) tokens.add(token);
  }
  return [...tokens];
}

function clampContribution(value: number): number {
  if (value > 0.08) return 0.08;
  if (value < -0.03) return -0.03;
  return value;
}

export function scoreSessionFocusTarget(
  target: SessionFocusTarget,
  focus: SearchSessionFocus | null | undefined,
  nowMs = Date.now(),
): number {
  if (!sessionFocusIsActive(focus, nowMs)) return 0;
  let score = 0;
  if (focus!.pathPrefix !== null)
    score += target.path.startsWith(focus!.pathPrefix) ? 0.06 : -0.015;
  if (focus!.query !== null) {
    const haystack = `${target.path}\n${target.title ?? ""}\n${target.content}`.toLocaleLowerCase();
    const matches = focusTokens(focus!.query).filter((token) => haystack.includes(token)).length;
    score += matches > 0 ? Math.min(0.04, matches * 0.02) : -0.01;
  }
  return clampContribution(score);
}
