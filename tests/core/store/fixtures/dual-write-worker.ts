/**
 * Child process for the dual-write warning tests: a fresh process, so the
 * once-per-process warning state starts clean. Appends `count` log events
 * to the vault with the environment the parent test prepared.
 *
 * argv: <vault> <count>
 */
import { appendLogEvent } from "../../../../src/core/brain/log.ts";

const [vault, countText] = process.argv.slice(2) as [string, string];
for (let i = 0; i < Number(countText); i++) {
  appendLogEvent(vault, {
    timestamp: "2026-11-06T10:01:00Z",
    eventType: "note",
    agent: "claude",
    body: { text: `event ${i}` },
  });
}
