/**
 * A background worker standing in for the dream worker: it writes its own
 * pid and its parent's pid to the report file, then stays alive until it
 * is signalled (or for a minute, so a lost one never lingers).
 *
 * argv: <report file>
 */
import { renameSync, writeFileSync } from "node:fs";

const [report] = process.argv.slice(2) as [string];
writeFileSync(`${report}.tmp`, JSON.stringify({ pid: process.pid, ppid: process.ppid }));
renameSync(`${report}.tmp`, report);
setTimeout(() => {}, 60_000);
