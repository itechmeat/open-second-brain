/**
 * Hand-built records of the dream work queue for the pure fold tests:
 * every record is stamped with an explicit clock so a test controls the
 * fold order, and the dream owner records come from the same builder.
 */
import { buildRecord, type StoreRecord } from "../../../../src/core/store/envelope.ts";
import {
  dreamWorkInputHash,
  dreamWorkItemId,
  dreamWorkReceipt,
} from "../../../../src/core/brain/dream-queue/records.ts";
import type { StorePartition } from "../../../../src/core/store/constants.ts";

export const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

let tick = 0;
/** A clock that only grows, so records built later fold later. */
export function nextAt(): number {
  tick += 1;
  return T0 + tick * 10;
}

export function rec(
  device: string,
  kind: string,
  body: Record<string, unknown>,
  at: number = nextAt(),
): StoreRecord {
  return buildRecord({ hlc: { physical: at, counter: 0 }, device, agent: "t", kind, body });
}

export function claim(device: string, at?: number): StoreRecord {
  return rec(
    device,
    "dream-owner-claim",
    { authority: "human", device, agent: "claude", force: false },
    at,
  );
}

export function forceClaim(device: string, at?: number): StoreRecord {
  return rec(
    device,
    "dream-owner-claim",
    { authority: "human", device, agent: "codex", force: true },
    at,
  );
}

export interface ItemSpec {
  readonly operation?: string;
  readonly subject?: string;
  readonly occurrence?: string;
  readonly input?: unknown;
  readonly after?: ReadonlyArray<string>;
  readonly resources?: ReadonlyArray<string>;
}

export function itemBody(spec: ItemSpec = {}): Record<string, unknown> {
  const identity = {
    operation: spec.operation ?? "fixture-closed",
    subject: spec.subject ?? "s1",
    occurrence: spec.occurrence ?? "2026-11-20/1",
    input_hash: dreamWorkInputHash(spec.input ?? spec.subject ?? "s1"),
    prompt_version: "1",
    schema_version: "1",
  };
  return {
    id: dreamWorkItemId(identity),
    ...identity,
    answer_schema: { type: "string", enum: ["yes", "no"] },
    after: [...(spec.after ?? [])],
    resources: [...(spec.resources ?? [])],
    private_resource_barriers: [],
    evidence: [],
    payload: { question: "?" },
  };
}

export function item(device: string, spec: ItemSpec = {}, at?: number): StoreRecord {
  return rec(device, "dream-work-item", itemBody(spec), at);
}

export function idOf(record: StoreRecord): string {
  return record.body["id"] as string;
}

export function lease(
  device: string,
  of: StoreRecord,
  generation: number,
  expiresAt: number,
  at?: number,
): StoreRecord {
  return rec(
    device,
    "dream-work-lease",
    {
      item: idOf(of),
      generation,
      lease_token: `lease-${generation}`,
      run: "run-1",
      owner_revision: "r",
      expires_at: new Date(expiresAt).toISOString(),
    },
    at,
  );
}

export function answer(
  device: string,
  of: StoreRecord,
  generation: number,
  value: unknown = "yes",
  at?: number,
): StoreRecord {
  const body = {
    item: idOf(of),
    generation,
    lease_token: `lease-${generation}`,
    input_hash: of.body["input_hash"] as string,
    value,
    agent: "claude",
    model: "m",
  };
  return rec(device, "dream-work-answer", { ...body, receipt: dreamWorkReceipt(body) }, at);
}

export function attempt(
  device: string,
  of: StoreRecord,
  generation: number,
  outcome: "failed" | "refused" | "released",
  retryAt: number | null = null,
  at?: number,
): StoreRecord {
  return rec(
    device,
    "dream-work-attempt",
    {
      item: idOf(of),
      generation,
      lease_token: `lease-${generation}`,
      outcome,
      reason: `${outcome} for a test`,
      retry_at: retryAt === null ? null : new Date(retryAt).toISOString(),
    },
    at,
  );
}

export function applied(
  device: string,
  of: StoreRecord,
  answerRecord: StoreRecord,
  at?: number,
): StoreRecord {
  return rec(
    device,
    "dream-work-applied",
    {
      item: idOf(of),
      generation: answerRecord.body["generation"],
      lease_token: answerRecord.body["lease_token"],
      receipt: answerRecord.body["receipt"],
      effects: [],
    },
    at,
  );
}

export function closed(
  device: string,
  of: StoreRecord,
  reason: "cancelled" | "superseded",
  successor: string | null = null,
  at?: number,
): StoreRecord {
  return rec(
    device,
    "dream-work-closed",
    { item: idOf(of), reason, note: "test", successor, authority: "agent" },
    at,
  );
}

export function retry(device: string, of: StoreRecord, at?: number): StoreRecord {
  return rec(device, "dream-work-retry", { item: idOf(of), authority: "human" }, at);
}

export function work(
  records: ReadonlyArray<StoreRecord>,
  partition: StorePartition = "shared",
): Array<{ partition: StorePartition; record: StoreRecord }> {
  return records.map((record) => ({ partition, record }));
}

export function shuffled<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 48271) % 2147483647;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
