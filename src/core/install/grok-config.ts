/**
 * Minimal TOML editor for grok's `~/.grok/config.toml` `[mcp_servers.<name>]`
 * tables.
 *
 * `config.toml` is grok's PRIMARY, highest-priority MCP source: verified
 * against live grok 0.2.45 that a server declared here is spawned and
 * handshakes in a real session (the plugin `.mcp.json` source is lower
 * priority and a bare `o2b` command does not resolve on grok's session-spawn
 * PATH). So the grok install target writes the two Open Second Brain servers
 * here, with an absolute command.
 *
 * The project ships `dependencies = []`, so rather than pull in a TOML
 * library this edits by line-section: it only ever writes/removes the exact
 * `[mcp_servers.open-second-brain]` / `[mcp_servers.open-second-brain-writer]`
 * tables and leaves every other section (`[cli]`, `[marketplace]`,
 * `[[marketplace.sources]]`, foreign `[mcp_servers.*]`, ...) byte-for-byte
 * intact. It handles only the value shapes we emit: a string `command`, a
 * string-array `args`, and an optional inline-table `env`.
 */

export interface GrokMcpEntry {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

/** TOML basic-string: wrap in double quotes, escaping backslash then quote. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tableHeader(name: string): string {
  return `[mcp_servers.${name}]`;
}

/** Render one `[mcp_servers.<name>]` table (no leading/trailing blank lines). */
export function serializeMcpServerTable(name: string, entry: GrokMcpEntry): string {
  const lines = [tableHeader(name), `command = ${tomlString(entry.command)}`];
  lines.push(`args = [${entry.args.map(tomlString).join(", ")}]`);
  if (entry.env && Object.keys(entry.env).length > 0) {
    const inner = Object.entries(entry.env)
      .map(([k, v]) => `${k} = ${tomlString(v)}`)
      .join(", ");
    lines.push(`env = { ${inner} }`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Remove the named `[mcp_servers.<name>]` sections: a section runs from its
 * header line to the line before the next table/array-of-table header (a line
 * starting with `[`) or end of file. Other sections are preserved verbatim.
 */
export function removeMcpServers(toml: string, names: ReadonlyArray<string>): string {
  const targets = new Set(names.map(tableHeader));
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) {
      skipping = targets.has(line.trim());
      if (skipping) continue;
    }
    if (skipping) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Ensure the config text declares exactly the given servers: drop any existing
 * copies of our tables, then append fresh ones. Idempotent - re-running with
 * the same entries returns byte-identical text.
 */
export function upsertMcpServers(
  toml: string,
  entries: Readonly<Record<string, GrokMcpEntry>>,
): string {
  const base = removeMcpServers(toml, Object.keys(entries)).replace(/\s*$/, "");
  const tables = Object.entries(entries)
    .map(([name, entry]) => serializeMcpServerTable(name, entry).trimEnd())
    .join("\n\n");
  return (base.length > 0 ? `${base}\n\n` : "") + tables + "\n";
}

/**
 * True when every expected server table is present verbatim. Drift (an edited
 * command, a removed table, a reformat) yields false so `verify` reports it.
 */
export function hasMcpServers(
  toml: string,
  entries: Readonly<Record<string, GrokMcpEntry>>,
): boolean {
  return Object.entries(entries).every(([name, entry]) =>
    toml.includes(serializeMcpServerTable(name, entry).trimEnd()),
  );
}
