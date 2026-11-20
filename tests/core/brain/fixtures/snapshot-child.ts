/**
 * Take one snapshot of the vault given as argv[2] in a process of its own,
 * so the PATH it starts with (a test's tar shim first) is the PATH its tar
 * runs under. Prints {"ok":true,"path":...} or {"ok":false,"error":...}.
 */
import { createSnapshot } from "../../../../src/core/brain/snapshot.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../../src/core/brain/types.ts";

const vault = process.argv[2]!;
try {
  const res = createSnapshot(vault, process.argv[3] ?? "dream-vanish", {
    reason: BRAIN_SNAPSHOT_REASON.dream,
  });
  process.stdout.write(JSON.stringify({ ok: true, path: res.path }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: (err as Error).message }));
}
