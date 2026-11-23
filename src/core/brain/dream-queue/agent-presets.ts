/**
 * Presets of the dream agent's launch command (change
 * `dream-launched-agent`, design D1): a table `name -> { program, args,
 * restricts }`. `restricts` says whether the form limits the session to
 * the one server it is given and that server's tools; a preset with
 * `restricts: false` is never offered.
 *
 * The table ships only presets this change verified with `o2b dream agent
 * check` on a development machine, each naming the program version it
 * was verified with. Any other agent is configured with a full command
 * (a JSON array of the program and its arguments), and the check is what
 * makes it usable. The arguments may hold the placeholders of
 * {@link DREAM_AGENT_PLACEHOLDERS}.
 */

export interface DreamAgentPreset {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  /** Whether the form restricts the session to the given server and its tools. */
  readonly restricts: boolean;
  /** The program version the preset was verified with. */
  readonly verifiedWith: string;
}

/**
 * The placeholders a command's arguments may hold:
 *
 *  - `{prompt}`: the session's fixed task;
 *  - `{mcp_config}`: the path of a file the worker writes for the run,
 *    holding the one server in the common MCP JSON shape
 *    (`{ "mcpServers": { "open-second-brain-dream": { command, args, env } } }`);
 *  - `{mcp_command}` and `{mcp_args_json}`: the server's program and its
 *    arguments as a JSON array, for agents that take a server inline.
 */
export const DREAM_AGENT_PLACEHOLDERS = Object.freeze([
  "{prompt}",
  "{mcp_config}",
  "{mcp_command}",
  "{mcp_args_json}",
] as const);

/**
 * The verified presets. Empty in this version: no agent installed on the
 * development machine could be checked without its own login, which
 * lives in the real home (see `docs/dream.md`, "Setting the agent").
 */
export const DREAM_AGENT_PRESETS: Readonly<Record<string, DreamAgentPreset>> = Object.freeze({});

/** The preset called `name` when it may be offered (it restricts the session). */
export function dreamAgentPreset(name: string): DreamAgentPreset | undefined {
  const preset = DREAM_AGENT_PRESETS[name];
  return preset !== undefined && preset.restricts ? preset : undefined;
}

/** The names of the presets that may be offered. */
export function dreamAgentPresetNames(): string[] {
  return Object.keys(DREAM_AGENT_PRESETS).filter((n) => DREAM_AGENT_PRESETS[n]!.restricts);
}
