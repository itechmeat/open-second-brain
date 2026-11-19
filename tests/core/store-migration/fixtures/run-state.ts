/**
 * The run state a test expects to read: the run, or null when there is
 * none. A run state that cannot be read fails the test, since no case
 * that uses this helper makes it unreadable.
 */
import {
  readMigrationState,
  type MigrationState,
} from "../../../../src/core/store-migration/journal.ts";

export function runStateOf(dir: string): MigrationState | null {
  const read = readMigrationState(dir);
  if (read.kind === "unreadable") throw new Error(`run state unreadable: ${read.error}`);
  return read.kind === "state" ? read.state : null;
}
