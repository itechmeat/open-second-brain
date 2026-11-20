/**
 * One atomic step on the index connection that nests: a plain transaction
 * when none is open, a savepoint inside one. The writers that replace a
 * document's chunks or a chunk's entities each run as one step on their
 * own (a search-time refresh), and also inside the batch a catch-up of the
 * brain store opens around many records (`brain-store/catch-up.ts`), where
 * a `BEGIN` of their own would fail and a commit per record would sync the
 * index file once per record.
 */

import type { Database } from "bun:sqlite";

let savepoints = 0;

/** An open step: end it with exactly one of `commit` or `rollback`. */
export interface Step {
  commit(): void;
  rollback(): void;
}

/** Open a step on `db`: a transaction, or a savepoint inside the open one. */
export function beginStep(db: Database): Step {
  if (!db.inTransaction) {
    db.exec("BEGIN");
    return { commit: () => db.exec("COMMIT"), rollback: () => db.exec("ROLLBACK") };
  }
  savepoints += 1;
  const name = `o2b_step_${savepoints}`;
  db.exec(`SAVEPOINT ${name}`);
  return {
    commit: () => db.exec(`RELEASE ${name}`),
    rollback: () => {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    },
  };
}

/** Run `fn` as one step (see {@link beginStep}). */
export function atomically<T>(db: Database, fn: () => T): T {
  const step = beginStep(db);
  try {
    const out = fn();
    step.commit();
    return out;
  } catch (e) {
    step.rollback();
    throw e;
  }
}
