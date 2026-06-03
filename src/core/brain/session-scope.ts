/**
 * Session-scope kernel (Agent Surface Suite).
 *
 * One normalisation for every per-session surface: session-scoped
 * search focus files, intention chains, and handoff note names all key
 * on the same `[a-z0-9-]` slug, so a session identifier from any host
 * (Claude Code UUIDs, Codex paths, operator-chosen workstream labels)
 * maps to one stable, filesystem- and wikilink-safe scope.
 */

export class SessionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionScopeError";
  }
}

export const SESSION_SCOPE_MAX_LENGTH = 64;

/**
 * Normalise a raw session id or workstream label into a scope slug:
 * lowercase, non-alphanumerics collapsed to single dashes, edge dashes
 * trimmed, length-capped. Deterministic and idempotent. Empty or
 * separator-only input is a caller bug and throws.
 */
export function resolveSessionScope(raw: string): string {
  // Plain toLowerCase: scope slugs become cross-host filenames, so
  // locale-dependent casing (Turkish dotless-i) must never vary them.
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, SESSION_SCOPE_MAX_LENGTH)
    .replace(/-+$/gu, "");
  if (slug.length === 0) {
    throw new SessionScopeError(
      `session scope requires at least one alphanumeric: ${JSON.stringify(raw)}`,
    );
  }
  return slug;
}
