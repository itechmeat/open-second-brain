/**
 * `o2b topic` - topics (design D8, D9; task 3.5), the CLI twin of the
 * `brain_topic` MCP tool. Every verb runs the same action
 * (`core/topics/actions.ts`); a change is a topic record, rendered into
 * the human view by the view writer.
 *
 * Verbs: `list [--scope <scope>]`, `show <topic>`, `review`,
 * `create <title> [--scope <scope>] [--goal <goal>] [--description <text>]
 * [--private | --shared]`, `rename <topic> [--title <title>]
 * [--description <text>]`, `status <topic> <status> [--resolved <day>]`,
 * `goal <topic> <goal> | --clear`, `assign <topic> <record>`,
 * `unassign <topic> <record>`, `merge <topic> --into <topic>`,
 * `split <topic> --into <topic> [--items <ids>] [--records <ids>]
 * [--owner <topic>]`,
 * `link <topic> --to <topic> [--remove]`, `archive <topic>`,
 * `undo <record>` and `record <topic> <kind> [--text ...]`. A command is
 * the user asking, so it carries `human` authority; `record` writes with
 * `agent` authority unless `--as-human`.
 */

import { writerSessionKey } from "../core/agent-context/session-identity.ts";
import { ConfigReadError } from "../core/config.ts";
import { StoreWriteError } from "../core/store/store-write.ts";
import { runTopicAction, TopicActionError, type TopicActionInput } from "../core/topics/actions.ts";
import { TopicWriteError } from "../core/topics/write.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { sortedReplacer } from "./helpers.ts";

const USAGE = [
  "usage: o2b topic list [--scope <scope>]",
  "       o2b topic show <topic>",
  "       o2b topic review",
  "       o2b topic create <title> [--scope project:<p>|personal] [--goal <goal>] [--description <text>] [--private|--shared]",
  "       o2b topic rename <topic> [--title <title>] [--description <text>]",
  "       o2b topic status <topic> <active|waiting|blocked|on-hold|done|closed> [--resolved <YYYY-MM-DD>]",
  "       o2b topic goal <topic> (<goal> | --clear)",
  "       o2b topic assign|unassign <topic> <record>",
  "       o2b topic merge <topic> --into <topic>",
  "       o2b topic split <topic> --into <topic> [--items <id,...>] [--records <id,...>] [--owner <topic>]",
  "       o2b topic link <topic> --to <topic> [--remove]",
  "       o2b topic archive <topic>",
  "       o2b topic undo <record>",
  "       o2b topic record <topic> <decision|open-question|log-entry|milestone|question-resolved|milestone-done> [--text <text>] [--class <class>] [--reason <text>] [--item <id>] [--question <id>] [--answer <text>] [--milestone <id>] [--evidence <text>] [--owner <topic>] [--as-human]",
  "       every verb: [--config <file>] [--json]",
].join("\n");

const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 } as const);

const FLAGS = {
  config: { type: "string" },
  json: { type: "boolean" },
  scope: { type: "string" },
  goal: { type: "string" },
  description: { type: "string" },
  title: { type: "string" },
  resolved: { type: "string" },
  into: { type: "string" },
  to: { type: "string" },
  items: { type: "string" },
  records: { type: "string" },
  remove: { type: "boolean" },
  clear: { type: "boolean" },
  private: { type: "boolean" },
  shared: { type: "boolean" },
  "as-human": { type: "boolean" },
  text: { type: "string" },
  class: { type: "string" },
  reason: { type: "string" },
  item: { type: "string" },
  question: { type: "string" },
  answer: { type: "string" },
  milestone: { type: "string" },
  evidence: { type: "string" },
  owner: { type: "string" },
} as const;

/** The CLI flags of every verb, for the command manifest. */
export const TOPIC_CLI_FLAGS = FLAGS;

type Flags = Record<string, string | boolean | string[] | undefined>;

const str = (flags: Flags, name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined;

const list = (value: string | undefined): string[] | undefined =>
  value === undefined
    ? undefined
    : value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

function arg(positional: ReadonlyArray<string>, index: number, name: string): string {
  const value = positional[index];
  if (value === undefined) throw new CliError(`missing <${name}>`);
  return value;
}

/** The record fields a `record` verb names. */
function recordFields(flags: Flags): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of [
    "text",
    "class",
    "reason",
    "item",
    "question",
    "answer",
    "milestone",
    "evidence",
  ]) {
    const value = str(flags, name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function inputOf(verb: string, positional: ReadonlyArray<string>, flags: Flags): TopicActionInput {
  const description = str(flags, "description");
  const optional = description !== undefined ? { description } : {};
  switch (verb) {
    case "list":
      return {
        action: verb,
        ...(str(flags, "scope") !== undefined ? { listScope: str(flags, "scope")! } : {}),
      };
    case "review":
      return { action: verb };
    case "show":
    case "archive":
      return { action: verb, topic: arg(positional, 0, "topic") };
    case "create": {
      if (flags["private"] === true && flags["shared"] === true) {
        throw new CliError("--private and --shared exclude each other");
      }
      return {
        action: verb,
        title: arg(positional, 0, "title"),
        ...optional,
        ...(str(flags, "scope") !== undefined ? { scope: str(flags, "scope")! } : {}),
        ...(str(flags, "goal") !== undefined ? { goal: str(flags, "goal")! } : {}),
        ...(flags["private"] === true ? { private: true } : {}),
        ...(flags["shared"] === true ? { private: false } : {}),
      };
    }
    case "rename":
      return {
        action: verb,
        topic: arg(positional, 0, "topic"),
        ...optional,
        ...(str(flags, "title") !== undefined ? { title: str(flags, "title")! } : {}),
      };
    case "status":
      return {
        action: verb,
        topic: arg(positional, 0, "topic"),
        status: arg(positional, 1, "status"),
        ...(str(flags, "resolved") !== undefined ? { resolved: str(flags, "resolved")! } : {}),
      };
    case "goal":
      return {
        action: verb,
        topic: arg(positional, 0, "topic"),
        goal: flags["clear"] === true ? null : arg(positional, 1, "goal"),
      };
    case "assign":
    case "unassign":
      return {
        action: verb,
        topic: arg(positional, 0, "topic"),
        record: arg(positional, 1, "record"),
      };
    case "merge":
      return { action: verb, topic: arg(positional, 0, "topic"), into: str(flags, "into") ?? "" };
    case "split": {
      const items = list(str(flags, "items"));
      const records = list(str(flags, "records"));
      return {
        action: verb,
        topic: arg(positional, 0, "topic"),
        into: str(flags, "into") ?? "",
        ...(items !== undefined ? { items } : {}),
        ...(records !== undefined ? { records } : {}),
        ...(str(flags, "owner") !== undefined ? { owner: str(flags, "owner")! } : {}),
      };
    }
    case "link":
      return {
        action: verb,
        topic: arg(positional, 0, "topic"),
        to: str(flags, "to") ?? "",
        ...(flags["remove"] === true ? { removed: true } : {}),
      };
    case "undo":
      return { action: verb, record: arg(positional, 0, "record") };
    case "record":
      return {
        action: verb,
        topic: arg(positional, 0, "topic"),
        kind: arg(positional, 1, "kind"),
        fields: recordFields(flags),
        ...(str(flags, "owner") !== undefined ? { owner: str(flags, "owner")! } : {}),
        ...(flags["as-human"] === true ? { authority: "human" } : {}),
      };
    default:
      throw new CliError(`unknown topic verb: ${verb}`);
  }
}

function render(answer: Record<string, unknown>): string {
  switch (answer["action"]) {
    case "list": {
      const topics = answer["topics"] as Array<Record<string, unknown>>;
      if (topics.length === 0) return "no topics\n";
      return topics
        .map((t) => `${t["id"]}  ${t["status"]}  ${t["scope"]}  ${t["title"]}\n`)
        .join("");
    }
    case "show":
      return String(answer["page"]);
    case "review": {
      if (answer["incomplete"] === true) {
        return "review incomplete: the topics stream could not be read in full; run `o2b brain doctor`\n";
      }
      const merges = answer["merges"] as Array<{ topics: string[] }>;
      const quiet = answer["quiet"] as Array<{ topic: string; days: number }>;
      if (merges.length + quiet.length === 0) return "nothing to review\n";
      return [
        ...merges.map((m) => `merge? ${m.topics[0]} ${m.topics[1]}\n`),
        ...quiet.map((q) => `quiet ${q.days} days: ${q.topic}\n`),
      ].join("");
    }
    default:
      return `${answer["action"]}: topic ${answer["topic"]}, record ${(answer["records"] as string[]).join(", ")}\n`;
  }
}

export async function handleTopicSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return verb === undefined ? EXIT.usage : EXIT.ok;
  }
  const rest = argv.slice(1);
  let json = false;
  try {
    const { flags, positional } = parseFlags(rest, FLAGS);
    json = flags["json"] === true;
    const input = inputOf(verb, positional, flags);
    const configPath = str(flags, "config");
    // A command is the user asking: requested actions carry human authority.
    // Only a session the caller names explicitly is stamped: a command
    // has no host session of its own (`agent-context/session-identity.ts`).
    const session = writerSessionKey({ env: process.env });
    const answer = runTopicAction(input, {
      humanRequest: true,
      ...(configPath !== undefined ? { configPath } : {}),
      ...(session !== null ? { session } : {}),
    });
    process.stdout.write(json ? `${JSON.stringify(answer, sortedReplacer, 2)}\n` : render(answer));
    // A review over a partial read is not a clean review.
    return answer["incomplete"] === true ? EXIT.refused : EXIT.ok;
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n${USAGE}\n`);
      return EXIT.usage;
    }
    const known =
      err instanceof TopicActionError ||
      err instanceof TopicWriteError ||
      err instanceof StoreWriteError ||
      err instanceof ConfigReadError;
    if (!known) throw err;
    if (json)
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
    process.stderr.write(`error: ${err.message}\n`);
    return EXIT.refused;
  }
}
