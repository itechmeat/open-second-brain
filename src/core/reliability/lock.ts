import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import lockfile from "proper-lockfile";

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
  writeFileSync(targetPath, "", { flag: "a" });

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(targetPath, {
      stale: opts.staleMs ?? 30_000,
      realpath: false,
      retries: {
        retries: opts.retries ?? 3,
        factor: 1,
        minTimeout: opts.retryDelayMs ?? 250,
        maxTimeout: opts.retryDelayMs ?? 250,
      },
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
