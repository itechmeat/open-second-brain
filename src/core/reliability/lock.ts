import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { lockDir } from "../fs-lock.ts";

export interface FileLockOptions {
  readonly staleMs?: number;
  readonly retries?: number;
  readonly retryDelayMs?: number;
}

export class FileLockError extends Error {
  readonly targetPath: string;

  constructor(targetPath: string, message: string) {
    super(`failed to lock ${targetPath}: ${message}`);
    this.name = "FileLockError";
    this.targetPath = targetPath;
  }
}

export async function withFileLock<T>(
  targetPath: string,
  opts: FileLockOptions,
  callback: () => Promise<T> | T,
): Promise<T> {
  mkdirSync(dirname(targetPath), { recursive: true });

  let release: (() => Promise<void>) | null = null;
  try {
    // A held lock (Windows' delete-pending answer included) is retried;
    // any other failure, a directory refusing new entries among them,
    // ends the wait at once.
    release = await lockDir(targetPath, {
      stale: opts.staleMs ?? 30_000,
      retries: opts.retries ?? 3,
      minTimeoutMs: opts.retryDelayMs ?? 250,
      maxTimeoutMs: opts.retryDelayMs ?? 250,
    });
  } catch (error) {
    throw new FileLockError(targetPath, (error as Error).message ?? String(error));
  }

  try {
    return await callback();
  } finally {
    await release();
  }
}
