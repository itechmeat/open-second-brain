/**
 * Preload for a hook run in a child process: when the child exits, the
 * counters of its store log reads (`logReadStats`) and of its verified
 * prefixes (`verifiedPrefixStats`, when the build has them) are written as
 * JSON to the file `RECORD_LOG_READS_TO` names. It shares the hook's
 * module instances, so the counters are the hook's own.
 */
import { writeFileSync } from "node:fs";

import { logReadStats } from "../../../src/core/brain/log-days.ts";

const target = process.env["RECORD_LOG_READS_TO"];
if (target !== undefined && target !== "") {
  let prefixStats: (() => unknown) | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../../src/core/store/verified-prefixes.ts") as {
      verifiedPrefixStats: () => unknown;
    };
    prefixStats = mod.verifiedPrefixStats;
  } catch {
    prefixStats = null;
  }
  process.on("exit", () => {
    writeFileSync(
      target,
      JSON.stringify({ log: logReadStats(), prefixes: prefixStats?.() ?? null }),
    );
  });
}
