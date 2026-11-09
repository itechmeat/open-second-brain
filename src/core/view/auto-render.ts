/**
 * The render pass without a manual command (design D7): the end of every
 * dream pass and the session-start hook run it, so the view writer keeps
 * the view current and doctor does not report it silent.
 *
 * The same trigger first runs the automatic transition import of a
 * switched machine (`store-migration/auto-transition.ts`).
 *
 * Rules:
 *
 *  - **Only where the store is in use.** No store at the resolved root,
 *    or no device id configured (none is ever minted here), means nothing
 *    runs and `null` is returned, so a machine that never opted in pays one
 *    `stat` and its dream summary is unchanged.
 *  - **Cheap off the writer.** The pass reads the writer records first and
 *    stops there on any other machine (`render.ts`).
 *  - **Throttled from hooks.** The session-start trigger runs at most once
 *    an hour per device; the stamp is written before the pass, so a pass
 *    that dies does not retry at every session start.
 *  - **Bounded.** A trigger may pass a time budget; the pass stops between
 *    pages once it runs out, and the rest wait for the next pass.
 *  - **Fail open.** Every failure is returned as `{ status: "error" }`,
 *    never thrown: a dream pass or a session start must not fail because
 *    the view could not be rendered.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readDeviceId, resolveAgentName, resolveVault } from "../config.ts";
import { readVaultIdentity } from "../brain/vault-identity.ts";
import { inspectStore, openStore, type StoreHandle } from "../store/store-open.ts";
import { runAutoTransition } from "../store-migration/auto-transition.ts";
import { deviceStateDirFor, resolveConfiguredStoreRoot } from "../store/store-paths.ts";
import {
  DEVICE_HOOK_AUDIT_DIR,
  VIEW_AUTO_PASS_FILE,
  VIEW_AUTO_PASS_INTERVAL_MS,
  VIEW_STATE_DIR,
} from "./constants.ts";
import { runViewPass, type ViewPassReport } from "./render.ts";
import { resolveViewTarget } from "./target.ts";

/** What started the pass. */
export type AutoViewTrigger = "dream" | "session-start";

export interface AutoViewOptions {
  readonly trigger: AutoViewTrigger;
  readonly configPath?: string;
  /** Wall clock (default `Date.now`). */
  readonly now?: () => number;
  /** Stop between pages once this many milliseconds have passed. */
  readonly budgetMs?: number;
}

export type AutoViewResult =
  | ViewPassReport
  | { readonly status: "throttled" }
  | { readonly status: "error"; readonly error: string };

function autoPassPath(store: StoreHandle): string {
  return join(store.deviceStateDir, VIEW_STATE_DIR, VIEW_AUTO_PASS_FILE);
}

/** Whether the hourly hook pass ran recently; records this one when not. */
function throttled(store: StoreHandle, nowMs: number): boolean {
  const path = autoPassPath(store);
  try {
    const last = (JSON.parse(readFileSync(path, "utf8")) as { at?: unknown }).at;
    if (
      typeof last === "number" &&
      nowMs - last >= 0 &&
      nowMs - last < VIEW_AUTO_PASS_INTERVAL_MS
    ) {
      return true;
    }
  } catch {
    // never ran, or unreadable: run now
  }
  mkdirSync(join(store.deviceStateDir, VIEW_STATE_DIR), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ at: nowMs })}\n`);
  return false;
}

/** The opened store, or `null` when this machine does not use one. */
function storeInUse(configPath: string | undefined): StoreHandle | null {
  const { root } = resolveConfiguredStoreRoot(configPath);
  if (inspectStore(root) === null) return null;
  const device = readDeviceId(configPath);
  if (device === null) return null;
  return openStore({ root, device });
}

/** One render pass for `options.trigger`; `null` when the store is not in use here. */
export function runAutoViewPass(options: AutoViewOptions): AutoViewResult | null {
  const now = options.now ?? Date.now;
  try {
    const store = storeInUse(options.configPath);
    if (store === null) return null;
    if (options.trigger === "session-start" && throttled(store, now())) {
      return { status: "throttled" };
    }
    // The budget runs from the start of the pass, the transition import
    // below included: the whole pass is synchronous, so nothing else can
    // stop it inside the hook's ceiling. Measured on the pass's own clock.
    const started = now();
    const vault = resolveVault(options.configPath);
    const agent = resolveAgentName(options.configPath);
    // A switched machine first imports late legacy writes of machines still
    // on an old release (task 2.4), so the view renders them too. It has
    // its own hourly throttle and never fails the render.
    runAutoTransition({
      store,
      vault,
      agent,
      vaultId: vault === null ? null : (readVaultIdentity(vault)?.vault_id ?? null),
      trigger: options.trigger,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    const target = resolveViewTarget(store.root, options.configPath, vault);
    const budget = options.budgetMs;
    return runViewPass(store, {
      target: target?.dir ?? null,
      vault,
      agent,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(budget !== undefined ? { shouldStop: () => now() - started > budget } : {}),
    });
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The device-local hook audit of this machine's store
 * (`<device state>/hook-audit`, design D14 item 1), or `null` when no
 * store is in use here. Never synced.
 */
export function deviceHookAuditDir(configPath?: string): string | null {
  try {
    const store = inspectStore(resolveConfiguredStoreRoot(configPath).root);
    return store === null ? null : join(deviceStateDirFor(store.storeId), DEVICE_HOOK_AUDIT_DIR);
  } catch {
    return null;
  }
}

/** One line for a report: what the pass did, naming the writer when this is not it. */
export function describeAutoView(result: AutoViewResult): string {
  switch (result.status) {
    case "not-writer":
      return `this machine writes no view page; the view writer is ${result.writer}`;
    case "rendered": {
      const written = result.pages.filter((p) => p.status === "written").length;
      const deferred = result.pages.filter((p) => p.status === "deferred").length;
      return (
        `rendered ${result.pages.length} page(s), ${written} changed` +
        (deferred > 0 ? `, ${deferred} deferred to the next pass` : "")
      );
    }
    case "released":
      return `handed the view writer role to ${result.to}`;
    case "error":
      return `the view could not be rendered: ${result.error}`;
    case "incomplete-read":
      return "the view was not rendered: some shards could not be read";
    case "no-writer":
      return "no machine renders the view yet";
    case "waiting-for-claim":
      return "this machine just took the view writer role; it renders from its next pass";
    case "no-target":
      return "no view folder is configured";
    case "throttled":
      return "the view was rendered less than an hour ago";
  }
}

/**
 * The audit line of a pass worth one: `ok` only for a rendered pass whose
 * pages were all written, unchanged or deferred by the budget; the pages
 * that were not written with their reason, and the unreadable shards of an
 * incomplete read, so the line says what to fix.
 */
export function autoViewAudit(result: AutoViewResult): [boolean, Record<string, unknown>] {
  const failed =
    result.status === "rendered"
      ? result.pages
          .filter((p) => p.status !== "written" && p.status !== "unchanged")
          .map((p) => ({
            page: p.page,
            status: p.status,
            ...(p.detail ? { detail: p.detail } : {}),
          }))
      : [];
  const ok = result.status === "rendered" && failed.every((p) => p.status === "deferred");
  return [
    ok,
    {
      status: result.status,
      summary: describeAutoView(result),
      ...(failed.length > 0 ? { pages: failed } : {}),
      ...(result.status === "incomplete-read" ? { shards: result.shards } : {}),
      ...(result.status === "error" ? { error: result.error } : {}),
    },
  ];
}
