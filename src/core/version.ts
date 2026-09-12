/**
 * The version of this Open Second Brain install, read once.
 *
 * `package.json` `version` is the repository's single source of truth
 * (`CLAUDE.md`), mirrored into the plugin manifests and `pyproject.toml`
 * by `scripts/sync-version.ts`. This module is the single source of
 * truth for the same fact INSIDE `src/`: every surface that reports a
 * version - the CLI verb, the MCP handshake, the continuity export
 * header, the stamped opencode plugin - reads this constant rather than
 * importing the manifest again.
 *
 * It is a leaf on purpose. It imports the manifest and nothing else, so
 * any layer may depend on it without pulling a dependency along, and
 * `tests/core/version.test.ts` holds the census that keeps the manifest
 * import from spreading back out.
 */

import packageJson from "../../package.json" with { type: "json" };

/** The version this install reports on every surface. */
export const OPEN_SECOND_BRAIN_VERSION: string = packageJson.version;
