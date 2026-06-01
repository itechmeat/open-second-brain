import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { attentionFlowsDir } from "./paths.ts";
import { listProceduralMemory } from "./procedural-memory.ts";
import { listPendingSkillProposals } from "./skill-proposals.ts";
import { listRecurrenceEntries } from "./recurrence.ts";

export type AttentionFlowAction = "open_proposals" | "high_recurrence" | "active_procedures";

export interface AttentionFlowRecipe {
  readonly id: string;
  readonly title: string;
  readonly actions: ReadonlyArray<AttentionFlowAction>;
  readonly sourcePath: string;
}

export interface AttentionFlowSection {
  readonly action: AttentionFlowAction;
  readonly items: ReadonlyArray<string>;
}

export interface AttentionFlowEvaluation {
  readonly flow_id: string;
  readonly title: string;
  readonly sections: ReadonlyArray<AttentionFlowSection>;
}

export function ensureDefaultAttentionFlows(vault: string): void {
  const dir = attentionFlowsDir(vault);
  mkdirSync(dir, { recursive: true });
  const defaultPath = join(dir, "open-loops.md");
  if (existsSync(defaultPath)) return;
  writeFrontmatterAtomic(
    defaultPath,
    {
      kind: "brain-attention-flow",
      id: "open-loops",
      title: "Open loops and learnings",
      actions: ["open_proposals", "high_recurrence", "active_procedures"],
      status: "active",
    },
    [
      "# Open loops and learnings",
      "",
      "Declarative flow for context surfaces:",
      "- open proposals needing review",
      "- strong recurrence candidates",
      "- active procedural memory entries",
    ].join("\n"),
    {
      overwrite: false,
      existsErrorKind: "attention flow",
      vaultForRelativePath: vault,
    },
  );
}

export function listAttentionFlows(vault: string): ReadonlyArray<AttentionFlowRecipe> {
  ensureDefaultAttentionFlows(vault);
  const dir = attentionFlowsDir(vault);
  if (!existsSync(dir)) return Object.freeze([]);
  const out: AttentionFlowRecipe[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      const [fm] = parseFrontmatter(path);
      if (fm["kind"] !== "brain-attention-flow") continue;
      const actions = normalizeActions(fm["actions"]);
      out.push({
        id: typeof fm["id"] === "string" ? fm["id"] : name.replace(/\.md$/, ""),
        title: typeof fm["title"] === "string" ? fm["title"] : name.replace(/\.md$/, ""),
        actions,
        sourcePath: path,
      });
    } catch {
      continue;
    }
  }
  return Object.freeze(out);
}

export function evaluateAttentionFlow(vault: string, flowId: string): AttentionFlowEvaluation {
  const flow = listAttentionFlows(vault).find((item) => item.id === flowId);
  if (!flow) throw new Error(`attention flow not found: ${flowId}`);

  const sections: AttentionFlowSection[] = [];
  for (const action of flow.actions) {
    if (action === "open_proposals") {
      const items = listPendingSkillProposals(vault).map(
        (item) => `${item.slug} (${item.patternKind})`,
      );
      sections.push({ action, items: Object.freeze(items) });
      continue;
    }
    if (action === "high_recurrence") {
      const items = listRecurrenceEntries(vault)
        .filter((entry) => entry.supportCount >= 3)
        .map((entry) => `${entry.contentHash} (${entry.supportCount})`);
      sections.push({ action, items: Object.freeze(items) });
      continue;
    }
    if (action === "active_procedures") {
      const items = listProceduralMemory(vault)
        .filter((entry) => entry.kind === "procedure" || entry.kind === "skill")
        .map((entry) => `${entry.title} [${entry.kind}]`);
      sections.push({ action, items: Object.freeze(items) });
    }
  }

  return {
    flow_id: flow.id,
    title: flow.title,
    sections: Object.freeze(sections.map((item) => Object.freeze(item))),
  };
}

export function renderAttentionFlow(vault: string, flowId: string): string {
  const report = evaluateAttentionFlow(vault, flowId);
  const lines: string[] = [`# ${report.title}`, ""];
  for (const section of report.sections) {
    lines.push(`## ${section.action}`);
    if (section.items.length === 0) {
      lines.push("- (empty)");
    } else {
      for (const item of section.items) lines.push(`- ${item}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function normalizeActions(value: unknown): ReadonlyArray<AttentionFlowAction> {
  const allowed = new Set<AttentionFlowAction>([
    "open_proposals",
    "high_recurrence",
    "active_procedures",
  ]);
  const out: AttentionFlowAction[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const action = item.trim() as AttentionFlowAction;
      if (allowed.has(action)) out.push(action);
    }
  }
  if (out.length === 0) return Object.freeze(["open_proposals", "high_recurrence"]);
  return Object.freeze([...new Set(out)]);
}

export function buildAttentionContextBlock(
  vault: string,
  flowIds: ReadonlyArray<string>,
): string | null {
  const chunks: string[] = [];
  for (const id of flowIds) {
    try {
      chunks.push(renderAttentionFlow(vault, id));
    } catch {
      continue;
    }
  }
  if (chunks.length === 0) return null;
  return chunks.join("\n");
}
