/**
 * The topic heads of the session start digest (task 4.2, design D10
 * `head_select`): the active topics of the session's project scope, one
 * line each, cut whole. Pure: no store, no model, no vault - the hook
 * glue (`hooks/lib/agent-context-blocks.ts`) reads and decides, this
 * module selects, orders, renders and cuts.
 *
 * Which topics (design D20): scope `project:<P>`, statuses active,
 * waiting and blocked, not merged. Personal topics are never injected at
 * session start; with no project no topic block is emitted at all.
 */

import { scopedRuleKey } from "../brain/scoped-rules.ts";
import { TOPIC_PROJECT_SCOPE_PREFIX } from "../topics/constants.ts";
import type { TopicFold, TopicState } from "../topics/fold.ts";
import { fenceUntrustedContent, neutralizeSingleLine } from "../brain/untrusted-source.ts";

/** The statuses whose topics are live work an agent should know about. */
export const HEAD_TOPIC_STATUSES = Object.freeze(["active", "waiting", "blocked"] as const);

/** Most characters one head line may carry before it is cut. */
export const HEAD_LINE_MAX_CHARS = 300;

/** Most characters a goal may carry inside a head line. */
export const HEAD_GOAL_MAX_CHARS = 160;

/**
 * Whether a topic scope names this session's project (section 3.7 item
 * 2): the topic's scope is keyed by the fold (`canonicalTopicScope`), and
 * a planned topic's by the project its records were stamped with; the
 * session's project is the scoped-rule key of the workspace directory.
 * All of them are `scopedRuleKey`, and both sides go through it once
 * more here, so the rules cannot drift apart.
 */
export function topicScopeMatchesProject(scope: string, project: string): boolean {
  if (!scope.startsWith(TOPIC_PROJECT_SCOPE_PREFIX)) return false;
  const segment = scope.slice(TOPIC_PROJECT_SCOPE_PREFIX.length);
  const left = scopedRuleKey(segment);
  const right = scopedRuleKey(project);
  return left !== null && left === right;
}

/** The topic heads eligible for the digest, in the deterministic order. */
export function candidateTopicHeads(fold: TopicFold, project: string): TopicState[] {
  return [...fold.topics.values()]
    .filter(
      (topic) =>
        topic.mergedInto === null &&
        topicScopeMatchesProject(topic.scope, project) &&
        (HEAD_TOPIC_STATUSES as ReadonlyArray<string>).includes(topic.status),
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One head line, its parts neutralised and cut (task 4.2 item 5). */
export function renderHeadLine(topic: TopicState): string {
  const status = `[${topic.status}]`;
  const parts = [`- ${neutralizeSingleLine(topic.title)} ${status} (${topic.id})`];
  const description = topic.description === null ? "" : neutralizeSingleLine(topic.description);
  if (description !== "") parts.push(`: ${description}`);
  let line = parts.join("");
  line = line.endsWith(".") || line.endsWith(")") ? line : `${line}.`;
  if (topic.goal !== null && topic.goal !== "") {
    const goal = neutralizeSingleLine(topic.goal);
    const cut =
      [...goal].length > HEAD_GOAL_MAX_CHARS
        ? `${[...goal].slice(0, HEAD_GOAL_MAX_CHARS - 3).join("")}...`
        : goal;
    line = `${line} Goal: ${cut}`;
  }
  return [...line].length > HEAD_LINE_MAX_CHARS
    ? `${[...line].slice(0, HEAD_LINE_MAX_CHARS - 3).join("")}...`
    : line;
}

export interface HeadsBlock {
  /** The fenced block (heading, head lines, cut line), "" when not even one head fits. */
  readonly text: string;
  /** How many candidate topics are not shown, whatever the reason. */
  readonly dropped: number;
  /** The heads shown, in the order they appear (the decision use reorders them). */
  readonly shown: ReadonlyArray<TopicState>;
}

export const TOPIC_HEADS_HEADING = "## Topics in this project";

/** The untrusted-fence origin of the heads block: agents wrote the topic text. */
export const TOPIC_HEADS_ORIGIN = "topic-heads";

/**
 * Select, order, render and cut the head lines (task 4.2 item 6). Heads
 * are cut whole, lowest-ranked first, never mid-line; the dropped count
 * is the number of candidate topics not shown, whatever the reason
 * (count cap, character cap, or a `head_select` drop - pass that order
 * in as `ordered`). The whole fenced block - heading, fence and cut line
 * included - fits `maxChars`. A block always shows at least one head:
 * when not even one fits beside the cut line, the short cut line is
 * tried, and when none fits beside that either there is no block.
 */
export function buildHeadsBlock(input: {
  readonly heads: ReadonlyArray<TopicState>;
  readonly max: number;
  readonly maxChars: number;
  readonly cutLine: (dropped: number) => string;
  /** The cut line without its pointers, for a block too small for the full one. */
  readonly shortCutLine?: (dropped: number) => string;
}): HeadsBlock {
  const all = [...input.heads];
  const lines = all.slice(0, Math.max(0, input.max)).map(renderHeadLine);
  const render = (n: number, cutLine: (dropped: number) => string): string => {
    const cut = cutLine(all.length - n);
    const body = [TOPIC_HEADS_HEADING, "", ...lines.slice(0, n), ...(cut !== "" ? ["", cut] : [])];
    return fenceUntrustedContent(body.join("\n"), TOPIC_HEADS_ORIGIN);
  };
  // The most heads that fit, in rank order: the lowest-ranked go first.
  for (const cutLine of [input.cutLine, ...(input.shortCutLine ? [input.shortCutLine] : [])]) {
    for (let n = lines.length; n >= 1; n--) {
      const text = render(n, cutLine);
      if (text.length <= input.maxChars) {
        return { text, dropped: all.length - n, shown: all.slice(0, n) };
      }
    }
  }
  return { text: "", dropped: all.length, shown: [] };
}
