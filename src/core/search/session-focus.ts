import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveIndexPath } from "./paths.ts";
import { SearchError, type ResolvedSearchConfig } from "./types.ts";

export interface SearchSessionFocus {
  readonly query: string | null;
  readonly pathPrefix: string | null;
  readonly expiresAt: number | null;
}

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

export function sessionFocusPath(config: ResolvedSearchConfig): string {
  return join(dirname(resolveIndexPath(config.vault, config.dbPath)), FOCUS_FILE);
}

export function readSessionFocus(
  config: ResolvedSearchConfig,
  nowMs = Date.now(),
): SearchSessionFocus | null {
  const path = sessionFocusPath(config);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SearchSessionFocus;
    const focus = Object.freeze({
      query: typeof parsed.query === "string" ? parsed.query : null,
      pathPrefix: typeof parsed.pathPrefix === "string" ? parsed.pathPrefix : null,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
    });
    return sessionFocusIsActive(focus, nowMs) ? focus : null;
  } catch {
    return null;
  }
}

export function writeSessionFocus(config: ResolvedSearchConfig, focus: SearchSessionFocus): void {
  const path = sessionFocusPath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(focus, null, 2) + "\n");
}

export function clearSessionFocus(config: ResolvedSearchConfig): void {
  const path = sessionFocusPath(config);
  if (existsSync(path)) rmSync(path, { force: true });
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
