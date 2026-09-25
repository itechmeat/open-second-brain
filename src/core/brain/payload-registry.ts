/**
 * Lossless externalized payload registry (t_35440e83).
 *
 * Session import stores every recalled turn in the continuity ledger,
 * and recall search reads those rows directly. A pasted screenshot as a
 * data URI, a base64 attachment or a multi-megabyte tool dump would sit
 * in that ledger forever, be scanned by every recall query and be handed
 * back in every snippet. The registry moves such content out of the row
 * into a content-addressed file and leaves a compact placeholder:
 *
 *   Brain/.payloads/<sha256>.txt
 *   [payload: osb-payload://<sha256> chars=N]
 *
 * What moves:
 *
 *   - a data URI or a base64 run (>= 80 chars of the base64 alphabet)
 *     longer than `maxInlineChars`, replaced in place;
 *   - when `maxTextChars` is set and the text is STILL longer than that
 *     after the blobs moved, the whole remaining text - which covers a
 *     giant plain tool output that no blob pattern matches. The row
 *     keeps a bounded head preview (never splitting a placeholder) so
 *     recall can still find the turn, followed by the placeholder.
 *
 * A whole-text payload can itself contain blob placeholders; those refs
 * stay live through the payload that holds them (see
 * `payload-inventory.ts`, which follows them transitively).
 *
 * Every byte that reaches disk is first stripped of `<private>` regions
 * and passed through `redactRawOutput` - the same sanitisation the
 * continuity store applies to a row, without the receipt-sized scan
 * window, so a payload never holds what the row it came from could not.
 * The page a caller reads back is therefore the exact stored (sanitised)
 * text, character for character.
 *
 * Text that needs no externalization is returned UNCHANGED - not even
 * sanitised - so an ordinary session imports byte-identically to the
 * pre-registry behaviour and the continuity store's own sanitiser stays
 * the one that decides that row.
 */

import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { sha256Hex } from "../integrity/digest.ts";
import { redactRawOutput, stripPrivateRegions } from "../redactor.ts";
import { payloadPath, payloadsDir } from "./paths.ts";
import { acquireLockSyncWithRetry, LOCK_WAIT_BUDGET_MS } from "./sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

export interface PayloadRegistryOptions {
  readonly vault: string;
  /** Blobs (data URIs, base64 runs) longer than this are externalized. */
  readonly maxInlineChars: number;
  /**
   * Text still longer than this after blob externalization is moved out
   * whole. Absent means no whole-text bound (blobs only).
   */
  readonly maxTextChars?: number;
  /** Head preview kept inline beside a whole-text placeholder. */
  readonly previewChars?: number;
}

export interface ExternalizedPayload {
  readonly ref: string;
  readonly placeholder: string;
  readonly sha256: string;
  readonly chars: number;
}

export interface ExternalizedText {
  readonly text: string;
  readonly payloads: ReadonlyArray<ExternalizedPayload>;
}

export interface PayloadPage {
  readonly ref: string;
  readonly offset: number;
  readonly limit: number;
  readonly content: string;
  /** Length of the whole stored payload, in characters. */
  readonly totalChars: number;
  readonly nextOffset: number | null;
}

/** The ref scheme every placeholder and every reader speaks. */
export const PAYLOAD_REF_PREFIX = "osb-payload://";

/**
 * Every ref inside a larger text. Global, so callers must use it through
 * `matchAll` (which clones it) rather than `exec` on the shared instance.
 */
export const PAYLOAD_REF_RE = /osb-payload:\/\/([a-f0-9]{64})/g;

/** Default head preview kept beside a whole-text placeholder. */
export const DEFAULT_PAYLOAD_PREVIEW_CHARS = 1_000;

/** Default page size of a payload read. */
export const DEFAULT_PAYLOAD_PAGE_CHARS = 4_000;

const DATA_URI_RE = /data:[^\s\])"'>]+/g;
const BASE64_RUN_RE = /\b[A-Za-z0-9+/]{80,}={0,2}\b/g;
const PLACEHOLDER_OPEN = "[payload: ";

/** A ref that is not `osb-payload://<64 lowercase hex>`. */
export class PayloadRefError extends Error {
  constructor(ref: string) {
    super(`invalid payload ref: ${JSON.stringify(ref)} - expected ${PAYLOAD_REF_PREFIX}<sha256>`);
    this.name = "PayloadRefError";
  }
}

/** A well-formed ref whose file is not in the store. */
export class PayloadNotFoundError extends Error {
  readonly ref: string;
  constructor(ref: string) {
    super(
      `missing payload: ${ref} - the file under Brain/.payloads/ is gone; a snapshot ` +
        "restore brings it back if one was taken while it existed",
    );
    this.name = "PayloadNotFoundError";
    this.ref = ref;
  }
}

/** The sha256 a ref names. Throws {@link PayloadRefError} on anything else. */
export function payloadIdFromRef(ref: string): string {
  if (typeof ref !== "string" || !ref.startsWith(PAYLOAD_REF_PREFIX)) {
    throw new PayloadRefError(String(ref));
  }
  const id = ref.slice(PAYLOAD_REF_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new PayloadRefError(ref);
  return id;
}

/** The ref for a sha256. */
export function payloadRefFor(sha256: string): string {
  return `${PAYLOAD_REF_PREFIX}${sha256}`;
}

/**
 * The sanitisation every stored payload goes through: private regions
 * out, then the redactor with no scan-window cap (a payload is exactly
 * the content that is too large for the default window).
 */
export function sanitizePayloadText(text: string): string {
  return redactRawOutput(stripPrivateRegions(text), {
    maxInput: Number.POSITIVE_INFINITY,
  });
}

export class PayloadRegistry {
  private readonly vault: string;
  private readonly maxInlineChars: number;
  private readonly maxTextChars: number | undefined;
  private readonly previewChars: number;

  constructor(opts: PayloadRegistryOptions) {
    this.vault = opts.vault;
    this.maxInlineChars = Math.max(1, opts.maxInlineChars);
    this.maxTextChars =
      opts.maxTextChars === undefined ? undefined : Math.max(1, opts.maxTextChars);
    this.previewChars = Math.max(0, opts.previewChars ?? DEFAULT_PAYLOAD_PREVIEW_CHARS);
  }

  /** True when {@link externalizeOversized} would move anything out of `text`. */
  needsExternalization(text: string): boolean {
    if (this.maxTextChars !== undefined && text.length > this.maxTextChars) return true;
    return this.hasOversizedBlob(text);
  }

  externalizeOversized(text: string): ExternalizedText {
    if (!this.needsExternalization(text)) {
      return Object.freeze({ text, payloads: Object.freeze([]) });
    }
    const payloads: ExternalizedPayload[] = [];
    let output = sanitizePayloadText(text);
    output = this.replaceMatches(output, DATA_URI_RE, payloads);
    output = this.replaceMatches(output, BASE64_RUN_RE, payloads);
    if (this.maxTextChars !== undefined && output.length > this.maxTextChars) {
      const whole = this.put(output);
      payloads.push(whole);
      output = `${safePreview(output, this.previewChars)}\n${whole.placeholder}`;
    }
    return Object.freeze({ text: output, payloads: Object.freeze(payloads) });
  }

  /**
   * Whether {@link externalizeOversized} could move anything out of
   * `text`: every blob it moves is longer than the inline bound, and the
   * whole-text rule needs the text bound exceeded, so a shorter text is
   * left as it is. Cheap, so a caller can skip the store lock for the
   * common short turn.
   */
  mayExternalize(text: string): boolean {
    return text.length > Math.min(this.maxInlineChars, this.maxTextChars ?? Infinity);
  }

  get(ref: string, opts: { readonly offset: number; readonly limit: number }): PayloadPage {
    const path = payloadPath(this.vault, payloadIdFromRef(ref));
    if (!existsSync(path)) throw new PayloadNotFoundError(ref);
    const text = readFileSync(path, "utf8");
    const offset = Math.max(0, Math.floor(opts.offset));
    const limit = Math.max(1, Math.floor(opts.limit));
    const content = text.slice(offset, offset + limit);
    const next = offset + limit < text.length ? offset + limit : null;
    return Object.freeze({
      ref,
      offset,
      limit,
      content,
      totalChars: text.length,
      nextOffset: next,
    });
  }

  private hasOversizedBlob(text: string): boolean {
    for (const pattern of [DATA_URI_RE, BASE64_RUN_RE]) {
      for (const match of text.matchAll(pattern)) {
        if (match[0].length > this.maxInlineChars) return true;
      }
    }
    return false;
  }

  private replaceMatches(text: string, pattern: RegExp, payloads: ExternalizedPayload[]): string {
    return text.replace(pattern, (match: string) => {
      if (match.length <= this.maxInlineChars) return match;
      const payload = this.put(match);
      payloads.push(payload);
      return payload.placeholder;
    });
  }

  private put(text: string): ExternalizedPayload {
    // Vault-identity write guard (context-integrity-gates, Unit J). The
    // registry externalizes oversized payloads into `Brain/.payloads/`,
    // so this is the class's only byte-producing path.
    assertVaultIdentityForWrite(this.vault);
    // Sanitised again at the write itself, so no caller can land
    // unredacted bytes here by skipping `externalizeOversized`. Both
    // passes are idempotent on already-sanitised text.
    const stored = sanitizePayloadText(text);
    const sha256 = sha256Hex(stored);
    const ref = payloadRefFor(sha256);
    const placeholder = `[payload: ${ref} chars=${stored.length}]`;
    const path = payloadPath(this.vault, sha256);
    // Content-addressed: an existing file already holds these bytes. It is
    // touched instead, so a payload an orphan sweep was about to take is
    // young again the moment a new row is going to name it (see
    // PAYLOAD_GC_GRACE_MS).
    if (!existsSync(path)) {
      mkdirSync(payloadsDir(this.vault), { recursive: true });
      atomicWriteFileSync(path, stored);
    } else {
      try {
        const now = new Date();
        utimesSync(path, now, now);
      } catch {
        // A file that vanished or refuses a touch is written again by the
        // next put; the lock below is what orders this against a gc.
      }
    }
    return Object.freeze({ ref, placeholder, sha256, chars: stored.length });
  }
}

/**
 * How long an unreferenced payload is left alone by the gc. A session
 * import writes the payload first and the continuity row that names it
 * after, so for a moment every new payload is an orphan; the grace keeps
 * a sweep from taking it in that window, and a put that finds the file
 * already there touches it for the same reason.
 */
export const PAYLOAD_GC_GRACE_MS = 10 * 60 * 1000;

/**
 * Run `fn` holding the payload store's writer lock (`Brain/.payloads.lock`).
 * A session import holds it from the first payload it writes until the
 * row naming it is appended, and the gc holds it while it re-plans and
 * removes, so a removal can never land between the two halves of an
 * import. `budgetMs` is how long to wait for a holder (see
 * `sync-lockfile.ts`); the operator-run gc passes the interactive budget.
 */
export function withPayloadStoreLock<T>(
  vault: string,
  fn: () => T,
  budgetMs: number = LOCK_WAIT_BUDGET_MS,
): T {
  const handle = acquireLockSyncWithRetry(payloadsDir(vault), budgetMs);
  try {
    return fn();
  } finally {
    handle.release();
  }
}

/**
 * The first `limit` characters of `text`, cut back so no placeholder is
 * split: a half placeholder would be a ref nothing can resolve and a
 * bracket nothing closes.
 */
function safePreview(text: string, limit: number): string {
  if (limit <= 0) return "";
  let head = text.slice(0, limit);
  const open = head.lastIndexOf(PLACEHOLDER_OPEN);
  if (open >= 0 && head.indexOf("]", open) < 0) head = head.slice(0, open);
  return head;
}
