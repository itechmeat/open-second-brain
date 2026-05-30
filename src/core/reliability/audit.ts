import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { redactRawOutput } from "../redactor.ts";

export interface AuditRecord {
  readonly timestamp: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly ok: boolean;
  readonly details?: Record<string, unknown>;
}

export function appendAuditRecord(auditRoot: string, record: AuditRecord): string {
  const timestamp = new Date(record.timestamp);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`invalid audit timestamp: ${record.timestamp}`);
  }
  mkdirSync(auditRoot, { recursive: true });
  const path = join(auditRoot, `${isoWeekLabel(timestamp)}.jsonl`);
  const line = redactRawOutput(JSON.stringify(record), {
    maxInput: Number.POSITIVE_INFINITY,
  });

  const fileDescriptor = openSync(path, "a", 0o600);
  try {
    writeFileSync(fileDescriptor, line + "\n", "utf8");
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  return path;
}

export function isoWeekLabel(input: Date): string {
  const date = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  const dayNumber = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
