/**
 * The hook-side glue of the session start digest's topic and pinned
 * blocks (task 4.2, design D10 `head_select`, D20): reads the topics at
 * local reach (`readTopics`), resolves the session's project scope,
 * selects and orders the heads (deterministic fallback, then the
 * `head_select` decision use) and builds the pinned block. Returns the
 * two blocks plus the meter entries the digest charges them with.
 *
 * Fail-open everywhere: no store, no project, no topics, an unreadable
 * fold or a spent budget all answer empty blocks, and the digest stays
 * byte-identical to before.
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";

import { resolveProjectScope } from "../../src/core/brain/scope-identity.ts";
import { discoverConfig } from "../../src/core/config.ts";
import { resolveDecisionModelConfig } from "../../src/core/decision-model/config.ts";
import type { DecisionProvider } from "../../src/core/decision-model/contract.ts";
import { runHeadSelect } from "../../src/core/agent-context/head-select.ts";
import { buildHeadsBlock, candidateTopicHeads } from "../../src/core/agent-context/heads.ts";
import { budgetCutLine } from "../../src/core/agent-context/budget-line.ts";
import { buildPinnedBlock } from "../../src/core/agent-context/pinned-block.ts";
import { configuredStore } from "../../src/core/store/read/store-entities.ts";
import { readTopicsOf } from "../../src/core/topics/read.ts";
import type { InjectionMeter } from "./standing-block.ts";
import { LANE_BUDGETED } from "./standing-block.ts";
import type { InjectionLimits } from "./active-context.ts";

/** The `head_select` options the glue hands on (an injected provider in tests). */
export interface AgentContextBlocksOptions {
  readonly vault: string;
  readonly workspaceDir: string | null;
  readonly limits: InjectionLimits;
  readonly meter: InjectionMeter;
  readonly remainingMs: number;
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly configPath?: string;
}

/** The branch the workspace's `.git/HEAD` names, or null. */
function workspaceBranch(workspaceDir: string | null): string | null {
  if (workspaceDir === null) return null;
  try {
    const head = readFileSync(`${workspaceDir}/.git/HEAD`, "utf8").trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match === null ? null : match[1]!;
  } catch {
    return null;
  }
}

export interface AgentContextBlocks {
  /** The fenced topic heads block, or "" when there is nothing to show. */
  readonly headsBlock: string;
  /** The pinned block, or "" when there is no pinned context. */
  readonly pinnedBlock: string;
  /** Candidate topics the digest does not show, whatever the reason. */
  readonly droppedHeads: number;
}

/** Build both blocks; never throws. */
export async function buildAgentContextBlocks(
  options: AgentContextBlocksOptions,
): Promise<AgentContextBlocks> {
  const heads = await buildHeads(options);
  const pinned = buildPinned(options);
  return { headsBlock: heads.block, pinnedBlock: pinned.block, droppedHeads: heads.dropped };
}

function buildPinned(options: AgentContextBlocksOptions): { block: string } {
  try {
    const pinned = buildPinnedBlock({
      vault: options.vault,
      maxChars: options.limits.pinnedMaxChars,
    });
    if (pinned.text === "") return { block: "" };
    options.meter.sources.push({
      name: "pinned-context",
      text: pinned.text,
      lane: LANE_BUDGETED,
      outsideBoundary: false,
    });
    return { block: pinned.text };
  } catch {
    return { block: "" };
  }
}

async function buildHeads(
  options: AgentContextBlocksOptions,
): Promise<{ block: string; dropped: number }> {
  try {
    // The store of the config the decision settings below come from.
    const store = configuredStore(options.configPath);
    if (store === null) return { block: "", dropped: 0 };
    const read = readTopicsOf(store);
    if (read.unreadable.length > 0) return { block: "", dropped: 0 };
    const project = resolveProjectScope(options.workspaceDir, options.vault);
    if (project === null) return { block: "", dropped: 0 };
    const candidates = candidateTopicHeads(read.fold, project);
    if (candidates.length === 0) return { block: "", dropped: 0 };
    // The decision use reorders the candidates in `enforce`; the
    // deterministic order stands for `off` and `shadow`. The use
    // enforces its own budget again around the call; the glue bounds it
    // once more, so the digest never hangs on a stuck provider.
    let ordered = candidates;
    let droppedBelow = 0;
    // A decision step that fails (an unreadable config, a rejected
    // request) keeps the deterministic order: the heads still show.
    try {
      const config = resolveDecisionModelConfig({
        config: discoverConfig(options.configPath).data,
        vault: options.vault,
      });
      const select = runHeadSelect({
        config,
        heads: candidates,
        request: { project, branch: workspaceBranch(options.workspaceDir) },
        remainingMs: options.remainingMs,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
      // The timer is cleared once the race settles: a pending timer would
      // keep the hook process alive long after its output is written.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cutoff = new Promise<"cutoff">((resolve) => {
        timer = setTimeout(() => resolve("cutoff"), Math.max(0, options.remainingMs));
      });
      let winner: Awaited<typeof select> | "cutoff";
      try {
        winner = await Promise.race([select, cutoff]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (winner !== "cutoff") {
        ordered = [...winner.heads];
        droppedBelow = winner.droppedBelow;
      }
    } catch {
      // The deterministic order stands.
    }
    const block = buildHeadsBlock({
      heads: ordered,
      max: options.limits.topicHeadsMax,
      maxChars: options.limits.topicHeadsMaxChars,
      cutLine: (dropped) =>
        budgetCutLine({
          dropped: dropped + droppedBelow,
          what: "topics in this project",
          whatOne: "topic in this project",
          command: `List them with \`o2b topic list --scope project:${project}\` or \`brain_topic\` action \`list\`; open one with \`brain_topic\` action \`show\``,
        }),
      shortCutLine: (dropped) =>
        budgetCutLine({
          dropped: dropped + droppedBelow,
          what: "topics",
          whatOne: "topic",
          command: "See `brain_topic` action `list`",
        }),
    });
    // The agent wrote the topic text: the block rides the untrusted
    // fence, and the fence counts against the block's characters.
    const fenced = block.text;
    if (fenced === "") return { block: "", dropped: block.dropped + droppedBelow };
    options.meter.sources.push({
      name: "topic-heads",
      text: fenced,
      lane: LANE_BUDGETED,
      outsideBoundary: false,
    });
    return { block: fenced, dropped: block.dropped + droppedBelow };
  } catch {
    return { block: "", dropped: 0 };
  }
}

/** The basename of a workspace dir, as the project key's source. */
export function projectKeyOf(workspaceDir: string | null): string | null {
  return workspaceDir === null ? null : basename(workspaceDir);
}
