/**
 * Does the Brain log still link up? (who-wrote-what, Task E)
 *
 * The per-shard hash chain is report-only: nothing in the read path
 * consults it, so a shard that stopped linking up is invisible until
 * something looks. `o2b brain log verify` is the surface for an operator
 * who suspects something; this check is the surface for the operator who
 * does not, and it is the one they already run.
 *
 * ## A warning, and one finding per shard
 *
 * Not an ERROR: nothing is broken. Every event the shard holds still
 * reads, every pass still runs, and the store is exactly as usable as it
 * was - what changed is that its history can no longer be vouched for. A
 * warning is the severity for a standing condition worth stating rather
 * than for a store that cannot be used.
 *
 * Not UNCERTAIN either: the shard was read and the answer is known. The
 * lineage ledger's equivalent reaches `uncertain` because its finding is
 * often "the ledger could not be read at all"; here the common case is a
 * definite break at a definite line, so it belongs in the stream an
 * operator reads as findings.
 *
 * One finding per SHARD, because the chain's unit is one file: a break
 * in one device's day says nothing about another's, and an operator who
 * has to open two files should be told about two files. The message
 * names the path and the line so the finding is never a dead end.
 */

import { breakDetail, verifyLogChain } from "../log-chain.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

/** A shard of the Brain log does not link up: a line was edited or removed. */
export const LOG_CHAIN_BROKEN_CODE = "log-chain-broken";

/** Named once: the finding and its registered next command spell the same verb. */
const LOG_VERIFY_COMMAND = "o2b brain log verify";

export const logChainCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const result = verifyLogChain(ctx.vault);
    for (const shard of result.shards) {
      const found = shard.firstBreak;
      if (found === null) continue;
      out.issues.push({
        severity: "warning",
        code: LOG_CHAIN_BROKEN_CODE,
        path: shard.path,
        message:
          `the Brain log shard ${shard.path} stops linking up at line ${found.line}: it ` +
          `${breakDetail(found.reason)}. ${shard.chained} of its lines still carry a chain ` +
          "hash and every event in it still reads - the chain is an audit surface, never a " +
          `read gate. Run \`${LOG_VERIFY_COMMAND}\` for the whole picture across every shard`,
      } satisfies DoctorIssue);
    }
  },
};
