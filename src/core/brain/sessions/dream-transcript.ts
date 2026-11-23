/**
 * Whether a host transcript is a dream session's (change
 * `dream-launched-agent`, design D2): its first user message begins with
 * the session line. Read by both capture seams through the capture
 * boundary; the batch import has no environment of the session to read,
 * so the transcript's own first message is what marks it.
 *
 * Reads until the first user turn and stops. Fails soft to "not a dream
 * session": a transcript that cannot be read is judged by the boundary
 * as before.
 */

import { existsSync } from "node:fs";

import { beginsWithDreamSessionLine } from "../dream-queue/dream-session.ts";
import { readFirstLine } from "./read-lines.ts";
import { detectAdapter, getAdapter } from "./registry.ts";
import type { SessionAdapterId } from "./types.ts";

/** Whether the transcript at `path` opens with the dream session line. */
export async function isDreamSessionTranscript(
  path: string | undefined,
  format?: SessionAdapterId,
): Promise<boolean> {
  if (path === undefined || !existsSync(path)) return false;
  try {
    const adapter =
      format !== undefined ? getAdapter(format) : detectAdapter(await readFirstLine(path));
    if (!adapter) return false;
    for await (const turn of adapter.iterate(path)) {
      if (turn.role !== "user") continue;
      return beginsWithDreamSessionLine(turn.text);
    }
  } catch {
    return false;
  }
  return false;
}
