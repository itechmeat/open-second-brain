/**
 * Vault bootstrap: scaffolding the canonical Open Second Brain layout
 * (`AI Wiki/...`) into a fresh or partially-initialized vault directory.
 *
 * Mirrors `src/open_second_brain/init.py`. Idempotent — re-running on an
 * already-initialized vault only creates missing files (or rewrites the
 * registered-agents list if a new `agentName` is supplied).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, normalize } from "node:path";

export const VAULT_FILES: ReadonlyArray<string> = [
  posix.join("AI Wiki", "_OPEN_SECOND_BRAIN.md"),
  posix.join("AI Wiki", "_open-second-brain.yaml"),
  posix.join("AI Wiki", "index.md"),
  posix.join("AI Wiki", "hot.md"),
  posix.join("AI Wiki", "log.md"),
  posix.join("AI Wiki", "identity", "user.md"),
  posix.join("AI Wiki", "identity", "agents.md"),
];

export const AGENTS_PLACEHOLDER =
  "- (add your agents here, e.g., my-agent: operator on my-server)";

const AGENTS_REGISTERED_HEADING = "## Registered agents";

interface Template {
  readonly relPath: string;
  readonly render: (ctx: TemplateContext) => string;
}

interface TemplateContext {
  readonly name: string;
  readonly created: string;
  readonly agentsBlock: string;
}

const TEMPLATES: ReadonlyArray<Template> = [
  {
    relPath: posix.join("AI Wiki", "_OPEN_SECOND_BRAIN.md"),
    render: ({ name, created }) =>
      `---\nopen_second_brain_version: 1\nname: ${name}\ncreated: ${created}\n---\n\n` +
      `# ${name}\n\n` +
      "This vault is managed by Open Second Brain.\n\n" +
      "## Rules\n\n" +
      "- Raw operational evidence goes into event log (Daily/).\n" +
      "- Synthesized knowledge goes into the wiki (AI Wiki/).\n" +
      "- Never write secrets, tokens, or credentials here.\n" +
      "- Read the identity files before acting on this vault.\n",
  },
  {
    relPath: posix.join("AI Wiki", "_open-second-brain.yaml"),
    render: ({ name, created }) => `version: 1\nname: ${name}\ncreated: ${created}\n`,
  },
  {
    relPath: posix.join("AI Wiki", "index.md"),
    render: ({ name }) =>
      `# ${name}\n\n` +
      `Welcome to the ${name} second brain.\n\n` +
      "## Key pages\n\n" +
      "- [[hot]] — short-term priority items.\n" +
      "- [[log]] — durable operation log.\n" +
      "- [[identity/user]] — owner profile.\n" +
      "- [[identity/agents]] — allowed agents and scopes.\n",
  },
  {
    relPath: posix.join("AI Wiki", "hot.md"),
    render: () =>
      "# Hot\n\n" +
      "Short-term items, current focus, active decisions.\n\n" +
      "Items fade to cold over time.\n",
  },
  {
    relPath: posix.join("AI Wiki", "log.md"),
    render: () =>
      "# Operation Log\n\n" +
      "Durable operations, major decisions, and infrastructure changes.\n\n" +
      "The event log (Daily/) is raw chronological evidence.\n" +
      "This page is synthesized operational knowledge.\n",
  },
  {
    relPath: posix.join("AI Wiki", "identity", "user.md"),
    render: () =>
      "# User Identity\n\n" +
      "Owner of this vault.\n\n" +
      "## Profile\n\n" +
      "- Name: (set your name)\n" +
      "- Timezone: (set your timezone)\n" +
      "- Contact: (set your primary contact)\n\n" +
      "## Preferences\n\n" +
      "(add durable preferences here so agents can read them)\n",
  },
  {
    relPath: posix.join("AI Wiki", "identity", "agents.md"),
    render: ({ agentsBlock }) =>
      "# Agent Identity\n\n" +
      "Allowed agents and their scopes.\n\n" +
      "## Registered agents\n\n" +
      `${agentsBlock}\n\n` +
      "## Scopes\n\n" +
      "- Write scope: AI Wiki/, Daily/\n" +
      "- Read scope: whole vault\n",
  },
];

export interface BootstrapVaultOptions {
  readonly name?: string;
  readonly agentName?: string | null;
  readonly force?: boolean;
}

/**
 * Bootstrap the canonical layout. Returns the list of relative paths that
 * were created or rewritten in this invocation (caller uses this to print
 * a summary).
 */
export function bootstrapVault(vaultDir: string, opts: BootstrapVaultOptions = {}): string[] {
  const name = opts.name ?? "Second Brain";
  const agentName = opts.agentName ?? null;
  const force = opts.force ?? false;
  const created: string[] = [];
  const ctx: TemplateContext = {
    name,
    created: nowIsoZ(),
    agentsBlock: agentsBlock(agentName),
  };

  for (const tmpl of TEMPLATES) {
    const target = join(vaultDir, tmpl.relPath);
    mkdirSync(dirname(target), { recursive: true });

    if (existsSync(target) && !force) {
      // Special-case: agents.md may need to be rewritten to register a new
      // agent identity even though the file already exists. This is what
      // makes `o2b init --agent-name X` idempotent and additive across
      // multiple runtimes installing Open Second Brain on the same vault.
      if (tmpl.relPath === posix.join("AI Wiki", "identity", "agents.md") && agentName) {
        if (upgradeAgentsFile(target, agentName)) {
          created.push(normalize(tmpl.relPath));
        }
      }
      continue;
    }
    writeFileSync(target, tmpl.render(ctx), "utf8");
    created.push(normalize(tmpl.relPath));
  }
  return created;
}

function agentsBlock(agentName: string | null): string {
  if (agentName) return `- ${agentName}: primary agent on this server`;
  return AGENTS_PLACEHOLDER;
}

/**
 * Register `agentName` in the existing `agents.md` registry.
 *
 * Cases handled, in order:
 *   - file still has bootstrap placeholder → replace with agent line.
 *   - agent already registered → no-op (idempotent re-init).
 *   - file initialised with another agent's entry → append the new line
 *     under `## Registered agents`, before the next `##` heading.
 *
 * Returns `true` when the file was actually rewritten.
 */
function upgradeAgentsFile(path: string, agentName: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }

  const entry = `- ${agentName}: primary agent on this server`;
  if (text.includes(entry)) return false;

  if (text.includes(AGENTS_PLACEHOLDER)) {
    writeFileSync(path, text.replace(AGENTS_PLACEHOLDER, entry), "utf8");
    return true;
  }

  const headingIdx = text.indexOf(AGENTS_REGISTERED_HEADING);
  if (headingIdx === -1) return false;

  const afterHeading = headingIdx + AGENTS_REGISTERED_HEADING.length;
  const rest = text.slice(afterHeading);
  const nextSectionRel = rest.indexOf("\n## ");

  let newText: string;
  if (nextSectionRel === -1) {
    newText = text.slice(0, afterHeading) + rest.replace(/\s+$/, "") + `\n${entry}\n`;
  } else {
    const boundary = afterHeading + nextSectionRel;
    const before = text.slice(0, boundary).replace(/\s+$/, "");
    const after = text.slice(boundary);
    newText = before + `\n${entry}\n` + after;
  }
  writeFileSync(path, newText, "utf8");
  return true;
}

function nowIsoZ(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
