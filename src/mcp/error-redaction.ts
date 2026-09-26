/**
 * What an exception's prose may say about this host once it leaves the
 * process (audit L11).
 *
 * Node's fs errors embed the absolute path of whatever the caller's last
 * bad argument named, and the generic error channels forward that prose
 * verbatim. Redacting only the vault root still told a caller the home
 * directory, the user name inside it and the temp root - the host layout
 * a traversal probe is after. So the three roots a path on this host
 * usually hangs off are replaced with named placeholders, longest first
 * (the vault usually lives under the home directory), and the result
 * then goes through the shared redactor for anything secret-shaped.
 *
 * Placeholders rather than a blanket marker: `<vault>/notes/x.md: no such
 * file` is still a useful error to the caller that sent `notes/x.md`.
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

import { TRANSPORT_REACH, type TransportReach } from "../core/graph/transport-reach.ts";
import { redactRawOutput } from "../core/redactor.ts";

function withRealpath(path: string): string[] {
  const out = [path];
  try {
    const real = realpathSync(path);
    if (real !== path) out.push(real);
  } catch {
    // A root that does not exist cannot appear in an fs error for a path
    // under it any differently than its literal spelling.
  }
  // An error may spell a Windows path with either separator.
  const slashed = out.filter((p) => p.includes("\\")).map((p) => p.replaceAll("\\", "/"));
  return [...out, ...slashed];
}

/**
 * Redact error prose for a caller at `reach`. At local reach - a caller
 * that already holds filesystem-equivalent access - only the vault root
 * is redacted, as it always was; at remote reach the home and temp roots
 * are replaced too, and every root becomes a named placeholder.
 */
export function redactErrorForCaller(raw: string, vault: string, reach: TransportReach): string {
  if (reach === TRANSPORT_REACH.local) return redactRawOutput(raw, { literals: [vault] });
  const roots: Array<readonly [string, string]> = [];
  for (const [path, label] of [
    [vault, "<vault>"],
    [homedir(), "<home>"],
    [tmpdir(), "<tmp>"],
  ] as const) {
    for (const spelling of withRealpath(path)) {
      // A root of `/` (or a drive root) would erase every path separator.
      const trimmed = spelling.replace(/[\\/]+$/, "");
      if (trimmed.length > 2) roots.push([trimmed, label]);
    }
  }
  roots.sort((a, b) => b[0].length - a[0].length);
  let text = raw;
  for (const [root, label] of roots) {
    // Only a whole path segment: `/home/al` must not eat `/home/alice`.
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`${escaped}(?=$|[\\\\/\\s'"\`:,;)\\]])`, "g"), label);
  }
  return redactRawOutput(text, {});
}
