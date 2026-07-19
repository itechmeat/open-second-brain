/**
 * Canonical runtime-adapter registration barrel.
 *
 * Importing each adapter module triggers `defaultRegistry.register(...)`
 * at module-load time. The side-effect imports are ordered alphabetically
 * so the registry's iteration order is predictable. This is the single
 * place the adapter set is listed; every caller that needs the full
 * registry populated (the install orchestrator, the doctor readiness
 * probe) imports {@link registerAllAdapters} instead of repeating the
 * list.
 */

import { defaultRegistry } from "../registry.ts";

import "./aider.ts";
import "./copilot-cli.ts";
import "./cursor.ts";
import "./gemini-cli.ts";
import "./generic.ts";
import "./grok.ts";
import "./kiro.ts";
import "./opencode.ts";
import "./pi.ts";

/**
 * Ensure every runtime adapter is registered in the default registry.
 *
 * The registrations happen at import time (the side-effect imports above),
 * so importing this module is already sufficient. This function exists so a
 * caller can express the dependency explicitly and idempotently at a call
 * site (e.g. a readiness probe) without relying on import ordering; it
 * returns the shared default registry for convenience.
 */
export function registerAllAdapters(): typeof defaultRegistry {
  return defaultRegistry;
}
