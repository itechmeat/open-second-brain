/**
 * Vault-local artifact store for the MCP tool-result preview budget
 * (v0.18.0).
 *
 * When an MCP tool result exceeds its preview budget, the full
 * serialized payload is parked here so a text-only agent can pull it
 * back through `brain_artifact_get` instead of having it flood the
 * context window inline. Artifacts are ephemeral session scratch:
 *
 *   Brain/.artifacts/<run-id>/<artifact-id>.json
 *
 * Design notes:
 * - One store per MCP server process; the `runId` groups a process's
 *   outputs so they prune together.
 * - `artifactId` is a short SHA-256 of the persisted text - deterministic,
 *   dedupes identical payloads, depends on no clock or RNG.
 * - The text is run through `redactRawOutput` before it touches disk, so
 *   a tool that happened to surface a secret-shaped token never persists
 *   it. The returned `text`/`fullChars` reflect the redacted bytes so the
 *   caller's preview slice stays consistent with what was stored.
 * - Path construction funnels through `artifactPath` (→ `ensureInsideVault`),
 *   so a malformed `artifactId` from an MCP argument cannot traverse out.
 * - Pruning is best-effort and synchronous at construction time: no
 *   daemon, matching the "no hidden process" convention. The dot-directory
 *   is excluded from the vault walker exactly like `Brain/.snapshots`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";

import {
  artifactPath,
  artifactRunDir,
  brainArtifactsDir,
} from "../core/brain/paths.ts";
import { atomicWriteFileSync } from "../core/fs-atomic.ts";
import { redactRawOutput } from "../core/redactor.ts";

/** Length of the hex artifact id derived from the SHA-256 digest. */
const ARTIFACT_ID_HEX_LEN = 16;

export interface StoredArtifact {
  /** Content-hash id used to fetch the artifact back. */
  readonly artifactId: string;
  /** Run directory the artifact lives under. */
  readonly runId: string;
  /** Absolute path of the persisted file. */
  readonly path: string;
  /** Character count of the persisted (redacted) text. */
  readonly fullChars: number;
  /** The persisted (redacted) text, for the caller's preview slice. */
  readonly text: string;
}

export interface ArtifactStoreOptions {
  readonly vault: string;
  readonly runId: string;
}

export class ArtifactStore {
  private readonly vault: string;
  readonly runId: string;

  constructor(opts: ArtifactStoreOptions) {
    this.vault = opts.vault;
    this.runId = opts.runId;
  }

  /**
   * Persist `fullText` (after redaction) and return its metadata. Writing
   * the same content twice is idempotent: the content-hash id is stable
   * and the atomic write simply re-lands identical bytes.
   */
  put(fullText: string): StoredArtifact {
    const text = redactRawOutput(fullText);
    const artifactId = createHash("sha256")
      .update(text, "utf8")
      .digest("hex")
      .slice(0, ARTIFACT_ID_HEX_LEN);
    const path = artifactPath(this.vault, this.runId, artifactId);
    mkdirSync(artifactRunDir(this.vault, this.runId), { recursive: true });
    atomicWriteFileSync(path, text);
    return { artifactId, runId: this.runId, path, fullChars: text.length, text };
  }

  /**
   * Read the full text for `artifactId` within this store's run. Returns
   * `null` when the id is well-formed but absent. Throws when the id is
   * malformed (path-traversal attempt) - the caller turns that into a
   * tool-level error envelope.
   */
  get(artifactId: string): string | null {
    const path = artifactPath(this.vault, this.runId, artifactId);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  /**
   * Best-effort prune of run directories whose mtime is older than
   * `ttlMs`. Returns the count of directories removed. Never throws on a
   * single bad entry - pruning is a housekeeping convenience, not a
   * correctness requirement.
   */
  prune(ttlMs: number): number {
    const root = brainArtifactsDir(this.vault);
    if (!existsSync(root)) return 0;
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const dir = `${root}/${entry}`;
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) continue;
        if (st.mtimeMs < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // Entry vanished or is unreadable; skip it.
      }
    }
    return removed;
  }
}
