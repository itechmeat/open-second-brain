/**
 * The marker of a dream session (change `dream-launched-agent`, design
 * D2): what tells hooks, session capture and the day check that a
 * process runs inside a session the dream worker started, and the line
 * the session's task opens with so a transcript read later, with no
 * environment, is known for one too.
 *
 * The marker grants nothing. The credential of a run is the pair of the
 * run id and its token, checked against the run record
 * (`run-record.ts`); the marker alone only makes things stay out.
 */

/** The run id: the marker any process of a dream session carries. */
export const DREAM_RUN_ENV = "OPEN_SECOND_BRAIN_DREAM_RUN";
/** The run's token: with the run id, the credential of the session's server. */
export const DREAM_TOKEN_ENV = "OPEN_SECOND_BRAIN_DREAM_TOKEN";

/** The word the fixed task of a dream session begins with. */
export const DREAM_SESSION_WORD = "open-second-brain-dream-session";

/** Whether the process whose environment is `env` runs inside a dream session. */
export function insideDreamSession(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[DREAM_RUN_ENV];
  return typeof value === "string" && value.trim() !== "";
}

/** The first line of a dream session's task, naming its run. */
export function dreamSessionLine(run: string): string {
  return `${DREAM_SESSION_WORD} ${run}`;
}

const LINE = new RegExp(`^\\s*${DREAM_SESSION_WORD} (\\S+)`);

/** The run named by a text that begins with the session line, or `null`. */
export function dreamSessionRunOf(text: string | undefined | null): string | null {
  if (typeof text !== "string") return null;
  return LINE.exec(text)?.[1] ?? null;
}

/** Whether a session's first user message makes it a dream session. */
export function beginsWithDreamSessionLine(text: string | undefined | null): boolean {
  return dreamSessionRunOf(text) !== null;
}

export const DREAM_EXECUTOR_SERVER_NAME = "open-second-brain-dream";
export const DREAM_WORK_TAKE = "dream_work_take";
export const DREAM_WORK_ANSWER = "dream_work_answer";
export const DREAM_WORK_FINISH = "dream_work_finish";
export const DREAM_EXECUTOR_TOOLS = Object.freeze([
  DREAM_WORK_TAKE,
  DREAM_WORK_ANSWER,
  DREAM_WORK_FINISH,
] as const);

/**
 * The fixed task of a dream session: the session line, then one
 * paragraph. It names no file, no tool but the three and no user data.
 */
export function dreamSessionTask(run: string): string {
  return (
    `${dreamSessionLine(run)}\n` +
    "You answer work items of Open Second Brain's dream queue, one at a time, using only the " +
    `tools ${DREAM_WORK_TAKE}, ${DREAM_WORK_ANSWER} and ${DREAM_WORK_FINISH}. Call ` +
    `${DREAM_WORK_TAKE}. For the item it returns, read the question and the payload, produce ` +
    "the answer in the given answer shape, and call " +
    `${DREAM_WORK_ANSWER} with the item's id and generation, your answer and the name of the ` +
    "model you are. If the answer is refused, correct it once. Repeat until " +
    `${DREAM_WORK_TAKE} returns no item, then call ${DREAM_WORK_FINISH} and stop. ` +
    "Do not use any other tool, do not read or write files, do not ask questions."
  );
}
