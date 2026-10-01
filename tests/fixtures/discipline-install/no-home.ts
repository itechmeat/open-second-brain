/**
 * Preload for a spawned `o2b discipline ...`: a host whose home directory
 * cannot be resolved.
 *
 * Spawned by `tests/cli/discipline-install.test.ts` as
 * `bun --preload <this> src/cli/main.ts discipline ...`. An empty HOME is
 * not enough on POSIX, because the runtime falls back to the password
 * database, so `homedir()` itself is replaced before the CLI loads.
 */

import { mock } from "bun:test";
import * as os from "node:os";

mock.module("node:os", () => ({ ...os, default: { ...os, homedir: () => "" }, homedir: () => "" }));
