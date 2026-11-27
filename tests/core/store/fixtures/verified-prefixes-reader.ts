/**
 * A process standing for one hook: it trusts the memory of verified
 * prefixes, reads the `log` stream of the store at argv[2] argv[3] times,
 * writing the memory after each read, and prints `ok <records>` per read.
 * Used by the concurrency case of `verified-prefixes.test.ts`.
 */
import { readStreamRecords } from "../../../../src/core/store/read/stream-read.ts";
import {
  flushVerifiedPrefixes,
  trustVerifiedPrefixes,
} from "../../../../src/core/store/verified-prefixes.ts";

const root = process.argv[2]!;
const times = Number(process.argv[3] ?? "1");
trustVerifiedPrefixes();
for (let i = 0; i < times; i++) {
  const read = readStreamRecords(root, "shared", { stream: "log" });
  if (read.unreadable.length > 0) throw new Error(`unreadable: ${read.unreadable.join(", ")}`);
  flushVerifiedPrefixes();
  process.stdout.write(`ok ${read.records.length}\n`);
}
