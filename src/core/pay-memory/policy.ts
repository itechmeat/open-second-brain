/**
 * Spending-policy template writer.
 *
 * Pay Memory does not enforce policy at runtime — this MVP ships a Markdown
 * document that the agent must read before paying and reference in the
 * receipt. The default template uses generic placeholders so it does not
 * pin a specific paid service; a commented-out `paysponge/fal` example sits
 * inside the file as a reference for demo flows.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
} from "../fs-atomic.ts";
import { PAY_MEMORY_ROOT_REL, policyPath } from "./paths.ts";

export const DEFAULT_POLICY_TEMPLATE = `# Agent Spending Policy

This file is read by the agent before any paid action. The agent MUST cite
this policy in the resulting payment receipt.

This MVP does not enforce limits at the payment layer. The policy exists so
that a human reviewer can see, after the fact, which rules the agent agreed
to follow.

## Budget

- Max total spend for the current task: TODO (e.g. $0.10)
- Max single paid call: TODO (e.g. $0.07)
- Max paid generations per task: TODO (e.g. 1)
- Approve repeats: false
- Approve dynamic pricing: false

## Allowed services

List the services the agent is allowed to call. One per line. Edit before
running a paid task.

- TODO

<!--
Example for the OpenSecondBrain hackathon demo:

- paysponge/fal
-->

## Required before each paid call

The agent must state:

- service name
- expected price range
- reason for payment
- expected output
- which vault files will be created or updated

## Required after each paid call

The agent must save:

- raw payment-tool output (after redaction)
- payment amount, if available
- service endpoint, if available
- generated asset URL or response identifier
- payment receipt note in \`${PAY_MEMORY_ROOT_REL}/<date>/\`
- daily event log entry referencing the receipt
`;

export type PolicyWriteStatus = "created" | "overwritten" | "skipped";

export interface WritePolicyResult {
  readonly path: string;
  readonly status: PolicyWriteStatus;
  readonly created: boolean;
  readonly overwritten: boolean;
  readonly skipped: boolean;
}

export interface WritePolicyOptions {
  readonly overwrite?: boolean;
}

export function writePolicyIfMissing(
  vault: string,
  opts: WritePolicyOptions = {},
): WritePolicyResult {
  const target = policyPath(vault);
  const overwrite = opts.overwrite ?? false;
  mkdirSync(dirname(target), { recursive: true });

  if (overwrite) {
    // existsSync here is only for the report status (created vs overwritten);
    // the actual write is atomic regardless. A torn read of the result
    // status under concurrent overwrite is acceptable — disk state is
    // always correct.
    const existed = existsSync(target);
    atomicWriteFileSync(target, DEFAULT_POLICY_TEMPLATE);
    return existed
      ? buildPolicyResult(target, "overwritten")
      : buildPolicyResult(target, "created");
  }

  // Race-free "create only if missing": link(2) returns EEXIST atomically.
  try {
    atomicCreateFileSyncExclusive(target, DEFAULT_POLICY_TEMPLATE);
    return buildPolicyResult(target, "created");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      return buildPolicyResult(target, "skipped");
    }
    throw err;
  }
}

function buildPolicyResult(path: string, status: PolicyWriteStatus): WritePolicyResult {
  return {
    path,
    status,
    created: status === "created",
    overwritten: status === "overwritten",
    skipped: status === "skipped",
  };
}

/** Read the spending policy file if it exists; returns null otherwise. */
export function readPolicy(vault: string): string | null {
  const target = policyPath(vault);
  // Single try-read avoids the existsSync→readFileSync TOCTOU window: if
  // the file is removed between the two calls we'd otherwise throw ENOENT
  // instead of returning null per the documented contract.
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}
