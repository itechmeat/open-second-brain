/**
 * The private-data guard of the topic and agent-context uses (design
 * D10, "Private data stays local"): a private record - one in the
 * `private` partition, a file with the reserved visibility token, or a
 * private topic - may leave the machine only when the provider chain is
 * local end to end, or when the operator opted the use in through
 * `decision_model_private_uses` on this machine. A chain that mixes
 * local and hosted entries counts as hosted, because a fallthrough must
 * not carry private text to the hosted entry. `<private>` regions are
 * stripped by `buildCandidateState` in every case and never leave the
 * machine, opt-in or not.
 */

import { resolvedProviderEntries } from "./provider-entries.ts";
import { isDecisionModelUse, type DecisionModelUse } from "./contract.ts";
import type { ResolvedDecisionModelConfig, ResolvedDecisionProvider } from "./config-types.ts";
import { TOPIC_USES } from "./questions-topics.ts";

/**
 * Hosts where a self-hosted server runs on this machine (localhost,
 * 127.0.0.1 and ::1). Moved here from `config.ts`, which imports it back.
 */
export function isLoopbackUrl(raw: string | null): boolean {
  if (raw === null) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Strip any `user:password@` part of a URL, reporting whether there was
 * one. Credentials never belong in the URL (the key travels in a
 * header), and a URL that carries them is never printed as is. Moved
 * here from `config.ts` (which imports it back) beside `isLoopbackUrl`,
 * its neighbour in endpoint-URL hygiene.
 */
export function withoutUserinfo(raw: string): {
  readonly url: string;
  readonly hadUserinfo: boolean;
} {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: raw, hadUserinfo: false };
  }
  if (parsed.username === "" && parsed.password === "") return { url: raw, hadUserinfo: false };
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.toString().replace(/\/+$/, ""), hadUserinfo: true };
}

/**
 * Whether one provider-chain entry keeps the data it receives on this
 * machine: true exactly for a loopback base URL. Every other entry is a
 * hosted provider.
 */
export function providerKeepsDataLocal(entry: ResolvedDecisionProvider): boolean {
  return isLoopbackUrl(entry.baseUrl);
}

/**
 * Parse `decision_model_private_uses`: a comma list of the nine topic
 * and agent-context uses whose private records may go to a hosted
 * provider on this machine. An unknown use (including an original use,
 * which never had a private-record lane) makes the config invalid,
 * naming the key. The key belongs to the machine config alone; the
 * vault `_brain.yaml` opt-out can narrow the uses but cannot set this
 * one.
 */
export function parseDecisionModelPrivateUses(
  raw: string | null,
  errors: string[],
): ReadonlyArray<DecisionModelUse> {
  if (raw === null || raw.trim() === "") return Object.freeze([]);
  const out: DecisionModelUse[] = [];
  for (const part of raw.split(",")) {
    const use = part.trim();
    if (use === "") continue;
    if (!isDecisionModelUse(use) || !(TOPIC_USES as ReadonlyArray<string>).includes(use)) {
      errors.push(
        `decision_model_private_uses: unknown use '${use}' ` +
          `(expected one of ${TOPIC_USES.join(", ")})`,
      );
      continue;
    }
    if (!out.includes(use)) out.push(use);
  }
  return Object.freeze(out);
}

/**
 * Whether a record of the use may be sent. A record that is not private
 * may always be sent. A private record may be sent only when every
 * entry of the provider chain keeps data local, or when the operator
 * opted the use in through `decision_model_private_uses`
 * (`cfg.privateHostedUses`).
 */
export function mayShareRecord(
  cfg: ResolvedDecisionModelConfig,
  use: DecisionModelUse,
  isPrivate: boolean,
): boolean {
  if (!isPrivate) return true;
  const optedIn = cfg.privateHostedUses?.includes(use) ?? false;
  if (optedIn) return true;
  return resolvedProviderEntries(cfg).every(providerKeepsDataLocal);
}

/**
 * The head fields of a topic as the use may send them: a field whose
 * winning record sits in `private` (a shared topic can carry a private
 * rename, description or goal) is blank unless a private record of the
 * use may leave the machine, the rule the planner already applies to
 * the words that route a shared record.
 */
export function shareableHeadFields(
  cfg: ResolvedDecisionModelConfig,
  use: DecisionModelUse,
  head: {
    readonly title: string | null;
    readonly description: string | null;
    readonly goal: string | null;
    readonly privateFields: Readonly<Record<"title" | "description" | "goal", boolean>>;
  },
): { readonly title: string; readonly description: string; readonly goal: string } {
  const field = (name: "title" | "description" | "goal"): string =>
    mayShareRecord(cfg, use, head.privateFields[name]) ? (head[name] ?? "") : "";
  return { title: field("title"), description: field("description"), goal: field("goal") };
}
