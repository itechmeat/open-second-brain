import { Database } from "bun:sqlite";

let cachedLoadable: boolean | null = null;

export function sqliteVecLoadable(): boolean {
  if (cachedLoadable !== null) return cachedLoadable;

  const db = new Database(":memory:");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vec = require("sqlite-vec") as { getLoadablePath(): string };
    db.loadExtension(vec.getLoadablePath());
    db.query("SELECT vec_version()").get();
    cachedLoadable = true;
  } catch {
    cachedLoadable = false;
  } finally {
    db.close();
  }
  return cachedLoadable;
}
