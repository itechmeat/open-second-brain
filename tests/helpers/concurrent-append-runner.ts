/**
 * Test helper: append a single event from a subprocess. Used by the
 * concurrent-append test to exercise cross-process locking. Argv:
 *   <vault> <index>
 */

import { appendEvent } from "../../src/core/event-log.ts";

const [, , vault, indexStr] = process.argv;
if (!vault || indexStr === undefined) {
  process.stderr.write("usage: <vault> <index>\n");
  process.exit(2);
}
const index = Number.parseInt(indexStr, 10);
if (!Number.isFinite(index)) {
  process.stderr.write(`error: <index> must be a finite number, got ${JSON.stringify(indexStr)}\n`);
  process.exit(2);
}
const time = `10:${String(index).padStart(2, "0")}`;

await appendEvent(vault, "worker", `entry ${index}`, { date: "2026.05.06", time });
