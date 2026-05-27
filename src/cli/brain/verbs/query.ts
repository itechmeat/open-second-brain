import { defaultConfigPath } from "../../../core/config.ts";
import {
  queryByLogSince,
  queryByPreference,
  queryByTopic,
  BrainNotFoundError,
} from "../../../core/brain/query.ts";
import {
  parse,
  fail,
  resolveBrainVault,
  parseOptionalIsoDate,
  renderQueryPreferenceText,
  renderQueryTopicText,
  renderQueryLogText,
} from "../helpers.ts";

export async function cmdBrainQuery(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    preference: { type: "string" },
    topic: { type: "string" },
    since: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const modes = ["preference", "topic", "since"].filter(
    (k) => typeof flags[k] === "string" && (flags[k] as string).trim() !== "",
  );
  if (modes.length === 0)
    return fail("brain query requires exactly one of --preference, --topic, --since");
  if (modes.length > 1)
    return fail(
      `brain query: pick only one of --preference / --topic / --since (got ${modes.join(", ")})`,
    );

  try {
    if (flags["preference"]) {
      const out = queryByPreference(vault, String(flags["preference"]));
      if (flags["json"]) {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else {
        renderQueryPreferenceText(out);
      }
      return 0;
    }
    if (flags["topic"]) {
      const out = queryByTopic(vault, String(flags["topic"]));
      if (flags["json"]) {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else {
        renderQueryTopicText(out, String(flags["topic"]));
      }
      return 0;
    }
    if (flags["since"]) {
      const { value: sinceDate, error: sinceErr } = parseOptionalIsoDate(flags, "since");
      if (sinceErr) return fail(sinceErr);
      const entries = queryByLogSince(vault, sinceDate!);
      if (flags["json"]) {
        process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      } else {
        renderQueryLogText(entries);
      }
      return 0;
    }
  } catch (exc) {
    if (exc instanceof BrainNotFoundError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    return fail(`query failed: ${(exc as Error).message ?? exc}`);
  }
  return 0;
}
