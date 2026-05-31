import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "./paths.ts";

export interface PayloadRegistryOptions {
  readonly vault: string;
  readonly maxInlineChars: number;
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
  readonly nextOffset: number | null;
}

const PAYLOAD_REF_PREFIX = "osb-payload://";
const DATA_URI_RE = /data:[^\s]+/g;
const BASE64_RUN_RE = /\b[A-Za-z0-9+/]{80,}={0,2}\b/g;

export class PayloadRegistry {
  private readonly vault: string;
  private readonly maxInlineChars: number;

  constructor(opts: PayloadRegistryOptions) {
    this.vault = opts.vault;
    this.maxInlineChars = Math.max(1, opts.maxInlineChars);
  }

  externalizeOversized(text: string): ExternalizedText {
    const payloads: ExternalizedPayload[] = [];
    let output = this.replaceMatches(text, DATA_URI_RE, payloads);
    output = this.replaceMatches(output, BASE64_RUN_RE, payloads);
    return Object.freeze({ text: output, payloads: Object.freeze(payloads) });
  }

  get(ref: string, opts: { readonly offset: number; readonly limit: number }): PayloadPage {
    const id = this.idFromRef(ref);
    const path = this.payloadPath(id);
    if (!existsSync(path)) throw new Error(`missing payload: ${ref}`);
    const text = readFileSync(path, "utf8");
    const offset = Math.max(0, opts.offset);
    const limit = Math.max(1, opts.limit);
    const content = text.slice(offset, offset + limit);
    const next = offset + limit < text.length ? offset + limit : null;
    return Object.freeze({ ref, offset, limit, content, nextOffset: next });
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
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    const ref = `${PAYLOAD_REF_PREFIX}${sha256}`;
    const placeholder = `[payload: ${ref} chars=${text.length}]`;
    mkdirSync(this.payloadDir(), { recursive: true });
    atomicWriteFileSync(this.payloadPath(sha256), text);
    return Object.freeze({ ref, placeholder, sha256, chars: text.length });
  }

  private idFromRef(ref: string): string {
    if (!ref.startsWith(PAYLOAD_REF_PREFIX)) throw new Error(`invalid payload ref: ${ref}`);
    const id = ref.slice(PAYLOAD_REF_PREFIX.length);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`invalid payload ref: ${ref}`);
    return id;
  }

  private payloadDir(): string {
    return ensureInsideVault(join(this.vault, "Brain", ".payloads"), this.vault);
  }

  private payloadPath(id: string): string {
    return ensureInsideVault(join(this.payloadDir(), `${id}.txt`), this.vault);
  }
}
