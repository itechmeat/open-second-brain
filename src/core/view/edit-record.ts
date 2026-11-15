/**
 * A record that a human edit of a view page produces, before the ingest
 * picks its partition (`view-records.ts`). A leaf module: the edit
 * mappers of every page family (`corrections.ts`, `topic-edits.ts`) build
 * it and the ingest writes it.
 */

import type { RecordBody } from "../store/envelope.ts";

export interface EditRecord {
  readonly stream: "events" | "topics";
  readonly kind: string;
  readonly body: RecordBody;
  /** The topic id a topic record belongs to (the envelope `topic`). */
  readonly topic?: string;
}
