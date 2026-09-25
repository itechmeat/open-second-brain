/**
 * `bun install` lifecycle hook: point git at the repository's `.githooks`.
 *
 * Was an inline `sh` one-liner (`git rev-parse ... >/dev/null 2>&1 && ...
 * || true`). Bun runs lifecycle scripts through its own shell on Windows,
 * which does not parse those redirections, so `bun install` failed there.
 * Same contract in TypeScript: silently do nothing outside a git checkout
 * (an npm tarball, a plugin cache) or without git, never fail the install.
 */

import { spawnSync } from "node:child_process";

const inRepo = spawnSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
if (inRepo.status === 0) {
  spawnSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
}
