/**
 * The registry of dream work operations (design D3): what each kind of
 * work declares so the queue can check an answer, reread the item's input
 * and apply an accepted answer.
 *
 * Production code registers its operations at module load; tests
 * register fixture operations through the same call and remove them in
 * `finally`. An item whose operation is not registered on this build is
 * waiting and never ready, and doctor names the operation: an older
 * binary must not guess.
 */

import type { StoreHandle } from "../../store/store-open.ts";
import type { StorePartition } from "../../store/constants.ts";
import type { DreamWorkAnswer, DreamWorkItem, DreamWorkTraits } from "./fold.ts";

/** Where an operation reads and writes. */
export interface DreamWorkContext {
  readonly store: StoreHandle;
  readonly vault: string | null;
  readonly configPath?: string;
  /** The queue's clock reading the entry point runs at (ms). */
  readonly now: number;
}

/** The item's input as the store holds it now. */
export interface DreamWorkInput {
  /** The source read is incomplete; leave the item unchanged and unleased. */
  readonly unavailable?: true;
  readonly input_hash: string;
  /** Partition to use if this replacement input is more private. */
  readonly partition?: StorePartition;
  /** What the executor is shown for that input, when it differs from the item's. */
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly evidence?: ReadonlyArray<string>;
}

export interface DreamWorkOperation extends DreamWorkTraits {
  readonly name: string;
  /**
   * `planning`: topic planning applies the answers under its own lock and
   * marks the items applied (`markAppliedByPlanning`); `applyAccepted`
   * leaves them alone. Absent: `applyAccepted` calls {@link apply}.
   */
  readonly appliedBy?: "planning";
  /**
   * A text operation (change `dream-launched-agent`, design D7): its
   * answer is text a model wrote, only the launched agent answers it, and
   * `dream.apply_drafts: review` holds it until a person approves it.
   */
  readonly text?: boolean;
  /**
   * Why the answer does not fit the answer schema, or `null` when it does.
   * `item` is the item answered (its options live in its schema).
   */
  validate(
    answer: { readonly value?: unknown; readonly text?: string },
    item: DreamWorkItem,
  ): string | null;
  /** The item's input reread from the store, or `null` when its subject is gone. */
  currentInput(item: DreamWorkItem, context: DreamWorkContext): DreamWorkInput | null;
  /**
   * Write the effects of an accepted answer and return their ids. Must be
   * idempotent by item id: a crash can fall between its writes and the
   * applied record, and the next pass applies again.
   */
  apply(item: DreamWorkItem, answer: DreamWorkAnswer, context: DreamWorkContext): string[];
}

const registry = new Map<string, DreamWorkOperation>();

/** Register `operation`; returns the call that removes it again. */
export function registerDreamWorkOperation(operation: DreamWorkOperation): () => void {
  if (registry.has(operation.name)) {
    throw new Error(`dream work operation ${operation.name} is already registered`);
  }
  registry.set(operation.name, operation);
  return () => {
    if (registry.get(operation.name) === operation) registry.delete(operation.name);
  };
}

/** The registered operation, or `undefined` when this build does not know it. */
export function dreamWorkOperation(name: string): DreamWorkOperation | undefined {
  return registry.get(name);
}

/** The traits the fold reads (`foldDreamWork` `operations`). */
export function dreamWorkTraits(name: string): DreamWorkTraits | undefined {
  const operation = registry.get(name);
  return operation === undefined
    ? undefined
    : {
        closedPredecessor: operation.closedPredecessor,
        ...(operation.text === true ? { text: true } : {}),
      };
}

/** Whether `name` is a registered text operation. */
export function isTextOperation(name: string): boolean {
  return registry.get(name)?.text === true;
}

/** The names of every registered text operation. */
export function textOperationNames(): string[] {
  return [...registry.values()].filter((op) => op.text === true).map((op) => op.name);
}
