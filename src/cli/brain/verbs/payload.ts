/**
 * `o2b brain payload get|list|gc` (payload registry, t_35440e83).
 *
 * Session import moves oversized content - data URIs, long base64 runs,
 * turn text past `sessions.payload_max_text_chars` - into
 * `Brain/.payloads/<sha256>.txt` and leaves a
 * `[payload: osb-payload://<sha256> chars=N]` placeholder in the
 * continuity row. These verbs are the operator's way back to the bytes
 * and the way to keep the store from growing without bound:
 *
 *   get <ref> [--offset N] [--limit N] [--json]
 *       One bounded page of the exact stored content. Without --json the
 *       page is written to stdout verbatim, so `--limit` large enough
 *       pipes the whole payload into a file.
 *   list [--json]
 *       Every stored payload with its size and reference count, plus every
 *       referenced payload whose file is gone.
 *   gc [--apply] [--json]
 *       Dry-run by default: names the payloads nothing in the vault
 *       references. --apply removes exactly those, behind a recovery
 *       point (`payload-gc-<stamp>`), re-planning inside it.
 */

import {
  buildPayloadInventory,
  collectPayloadGarbage,
} from "../../../core/brain/payload-inventory.ts";
import {
  DEFAULT_PAYLOAD_PAGE_CHARS,
  PAYLOAD_GC_GRACE_MS,
  PayloadNotFoundError,
  PayloadRefError,
  PayloadRegistry,
} from "../../../core/brain/payload-registry.ts";
import { brainVerbContext, CliError, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain payload get <osb-payload://sha256> [--offset N] [--limit N] [--json]\n" +
  "       o2b brain payload list [--json]\n" +
  "       o2b brain payload gc [--apply] [--json]";

export async function cmdBrainPayload(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "get") return payloadGet(argv.slice(1));
  if (sub === "list") return payloadList(argv.slice(1));
  if (sub === "gc") return payloadGc(argv.slice(1));
  return fail(USAGE);
}

function payloadGet(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    offset: { type: "string" },
    limit: { type: "string" },
  });
  const ref = positional[0];
  if (ref === undefined) return fail(USAGE);
  const offset = integerFlag(flags["offset"], "--offset", 0) ?? 0;
  const limit = integerFlag(flags["limit"], "--limit", 1) ?? DEFAULT_PAYLOAD_PAGE_CHARS;
  const vault = brainVerbContext(flags).vault;
  // Thresholds do not matter to a read; the registry only needs the vault.
  const registry = new PayloadRegistry({ vault, maxInlineChars: 1 });
  let page;
  try {
    page = registry.get(ref, { offset, limit });
  } catch (err) {
    if (err instanceof PayloadRefError || err instanceof PayloadNotFoundError) {
      return fail(`brain payload get: ${err.message}`);
    }
    throw err;
  }
  if (flags["json"] === true) {
    okJson({
      ref: page.ref,
      offset: page.offset,
      limit: page.limit,
      total_chars: page.totalChars,
      next_offset: page.nextOffset,
      content: page.content,
    });
    return 0;
  }
  process.stdout.write(page.content);
  if (page.nextOffset !== null) {
    process.stderr.write(
      `\n[payload: ${page.totalChars} chars total; next page: --offset ${page.nextOffset}]\n`,
    );
  }
  return 0;
}

function payloadList(argv: string[]): number {
  const { flags } = parse(argv, { vault: { type: "string" }, json: { type: "boolean" } });
  const vault = brainVerbContext(flags).vault;
  const inventory = buildPayloadInventory(vault);
  if (flags["json"] === true) {
    okJson({
      stored: inventory.stored.map((entry) => ({
        ref: entry.ref,
        path: entry.path,
        bytes: entry.bytes,
        referrers: entry.referrers,
        orphan: entry.referrers === 0,
      })),
      missing: inventory.missing.map((entry) => ({
        ref: entry.ref,
        referrers: entry.referrers.map((r) => ({
          path: r.path,
          ...(r.line !== undefined ? { line: r.line } : {}),
        })),
      })),
    });
    return 0;
  }
  if (inventory.stored.length === 0 && inventory.missing.length === 0) {
    ok("no payloads stored and none referenced");
    return 0;
  }
  for (const entry of inventory.stored) {
    const tag = entry.referrers === 0 ? "orphan" : `${entry.referrers} ref(s)`;
    ok(`${entry.ref}  ${entry.bytes} bytes  ${tag}`);
  }
  for (const entry of inventory.missing) {
    ok(`${entry.ref}  MISSING  referenced by ${entry.referrers.length} place(s)`);
  }
  return 0;
}

function payloadGc(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    apply: { type: "boolean" },
  });
  const vault = brainVerbContext(flags).vault;
  const apply = flags["apply"] === true;
  const result = collectPayloadGarbage(vault, { apply });
  if (flags["json"] === true) {
    okJson({
      applied: result.applied,
      orphans: result.orphans.map((entry) => ({
        ref: entry.ref,
        path: entry.path,
        bytes: entry.bytes,
      })),
      deferred: result.deferred.map((entry) => ({
        ref: entry.ref,
        path: entry.path,
        bytes: entry.bytes,
      })),
      removed: result.removed,
      bytes: result.bytes,
      snapshot: result.snapshot?.runId ?? null,
    });
    return 0;
  }
  if (result.deferred.length > 0) {
    ok(
      `${result.deferred.length} unreferenced payload(s) younger than ` +
        `${PAYLOAD_GC_GRACE_MS / 60_000} minutes left for a later pass`,
    );
  }
  if (result.orphans.length === 0) {
    ok("no unreferenced payloads to remove");
    return 0;
  }
  if (!apply) {
    for (const entry of result.orphans) ok(`would remove ${entry.path} (${entry.bytes} bytes)`);
    ok(
      `${result.orphans.length} unreferenced payload(s), ${result.bytes} bytes; ` +
        "re-run with --apply to remove them behind a recovery point",
    );
    return 0;
  }
  for (const path of result.removed) ok(`removed ${path}`);
  ok(
    `removed ${result.removed.length} payload(s), ${result.bytes} bytes; ` +
      `recovery point: ${result.snapshot?.runId ?? "none"}`,
  );
  return 0;
}

function integerFlag(
  value: string | boolean | string[] | undefined,
  flag: string,
  min: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value.trim())) {
    throw new CliError(`brain payload get: ${flag} must be an integer >= ${min}`);
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (parsed < min) throw new CliError(`brain payload get: ${flag} must be an integer >= ${min}`);
  return parsed;
}
