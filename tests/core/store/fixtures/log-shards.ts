/**
 * The JSONL shards of a store partition's `log` stream, for tests that
 * make a shard unreadable or put one record into both partitions.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Every `log` stream shard of `partition` in the store at `root`, sorted. */
export function logShardsOf(root: string, partition: "shared" | "private"): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const path = join(dir, name);
      if (name.endsWith(".jsonl")) out.push(path);
      else if (!name.includes(".")) walk(path);
    }
  };
  const base = join(root, partition, "log");
  if (existsSync(base)) walk(base);
  return out;
}

/**
 * Append every `shared` log line to the same shard under `private/`, so
 * each of those record ids is present in both partitions.
 */
export function copySharedLogIntoPrivate(root: string): void {
  const shared = join(root, "shared");
  for (const shard of logShardsOf(root, "shared")) {
    const target = join(root, "private", relative(shared, shard));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(shard, "utf8"), { flag: "a" });
  }
}
