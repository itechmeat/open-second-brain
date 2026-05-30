import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteTextOptions {
  readonly mode?: number;
  readonly validate?: (candidate: string) => void;
}

export function atomicWriteText(
  targetPath: string,
  candidate: string,
  opts: AtomicWriteTextOptions = {},
): void {
  opts.validate?.(candidate);

  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true });
  const tempPath = join(
    parent,
    `.${basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(tempPath, "wx", opts.mode ?? 0o600);
    writeFileSync(fileDescriptor, candidate, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = null;
    renameSync(tempPath, targetPath);
    fsyncDirectoryBestEffort(parent);
  } catch (error) {
    if (fileDescriptor !== null) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // Best-effort cleanup; preserve the original write error.
      }
    }
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup; preserve the original write error.
      }
    }
    throw error;
  }
}

function fsyncDirectoryBestEffort(path: string): void {
  let directoryDescriptor: number | null = null;
  try {
    directoryDescriptor = openSync(path, "r");
    fsyncSync(directoryDescriptor);
  } catch {
    // Some platforms/filesystems reject directory fsync. The file fsync
    // and atomic rename have already happened, so degrade quietly.
  } finally {
    if (directoryDescriptor !== null) {
      try {
        closeSync(directoryDescriptor);
      } catch {
        // Ignore close failures on a best-effort durability flush.
      }
    }
  }
}
