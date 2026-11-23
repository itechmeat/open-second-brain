/**
 * `llms.txt` is the index an agent reads to install and operate Open
 * Second Brain. It follows the llmstxt.org shape (an H1 with the product
 * name, a blockquote summary, then sections of described links), and every
 * link it gives must reach a file of this repository: a moved or renamed
 * document fails here instead of sending an agent to a missing page.
 *
 * The README and the features page, which route readers to the same
 * documents, are held to the same rule for their repository links.
 *
 * An agent also runs the commands these pages name, so every `o2b ...`
 * command in `llms.txt` and the README must name a verb path the command
 * manifest (the source of `o2b help --json` and the shell completions)
 * declares: a renamed or removed verb fails here instead of in an agent's
 * terminal.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CLI_COMMAND_MANIFEST, type CliCommandManifest } from "../../src/cli/command-manifest.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Inline Markdown links: the text and the target, in order of appearance. */
function markdownLinks(text: string): ReadonlyArray<{ label: string; target: string }> {
  const links: Array<{ label: string; target: string }> = [];
  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    links.push({ label: match[1]!, target: match[2]! });
  }
  return links;
}

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

/** Repository links of `file` whose target file does not exist. */
function brokenLinks(file: string): ReadonlyArray<string> {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  const base = dirname(join(REPO_ROOT, file));
  return markdownLinks(text)
    .map((link) => link.target)
    .filter((target) => !isExternal(target) && !target.startsWith("#"))
    .filter((target) => !existsSync(resolve(base, target.split("#")[0]!)));
}

/**
 * Every `o2b ...` command in `text`: each inline code span and each line of a
 * fenced block that starts with `o2b `, cut at the first shell operator.
 */
function o2bCommands(text: string): ReadonlyArray<string> {
  const commands: string[] = [];
  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("o2b ") && trimmed !== "o2b") return;
    commands.push(trimmed.split(/\s(?:&&|\|\||\||;|>)\s/)[0]!.trim());
  };
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) add(line);
    else for (const span of line.matchAll(/`([^`]+)`/g)) add(span[1]!);
  }
  return commands;
}

/**
 * The verb path of `command` the manifest does not declare, or null when it
 * declares it. Words are read while the command reached so far has
 * subcommands; the first word that is not one of them is the error. A flag,
 * a placeholder (`<host>`) or a quoted argument ends the verb path, and so
 * does a command without subcommands, whose further words are arguments.
 */
function unknownVerb(command: string): string | null {
  const words = command.split(/\s+/).slice(1);
  let level: ReadonlyArray<CliCommandManifest> | undefined = CLI_COMMAND_MANIFEST.commands;
  const path: string[] = [];
  for (const word of words) {
    if (level === undefined || !/^[a-z][a-z0-9-]*$/.test(word)) break;
    const next: CliCommandManifest | undefined = level.find((item) => item.name === word);
    path.push(word);
    if (next === undefined) return `o2b ${path.join(" ")}`;
    level = next.commands;
  }
  if (path.length === 0 && words.length > 0 && !words[0]!.startsWith("-")) {
    return `o2b ${words[0]}`;
  }
  return null;
}

describe("llms.txt", () => {
  const text = readFileSync(join(REPO_ROOT, "llms.txt"), "utf8");
  const lines = text.split("\n");

  test("opens with the product name and a blockquote summary", () => {
    expect(lines[0]).toBe("# Open Second Brain");
    const firstContent = lines.slice(1).find((line) => line.trim() !== "");
    expect(firstContent?.startsWith("> ")).toBe(true);
  });

  test("lists described links under H2 sections", () => {
    const sections = lines.filter((line) => line.startsWith("## "));
    expect(sections.length).toBeGreaterThan(0);
    const items = lines.filter((line) => line.startsWith("- ["));
    expect(items.length).toBeGreaterThan(0);
    const undescribed = items.filter((line) => !/^- \[[^\]]+\]\([^)]+\): \S/.test(line));
    expect(undescribed).toEqual([]);
  });

  test("links only to repository paths that exist", () => {
    const external = markdownLinks(text)
      .map((link) => link.target)
      .filter(isExternal);
    expect(external).toEqual([]);
    expect(brokenLinks("llms.txt")).toEqual([]);
  });

  test("covers what an agent needs to install and operate the product", () => {
    const targets = new Set(markdownLinks(text).map((link) => link.target));
    for (const required of [
      "install.md",
      "install/prerequisites.md",
      "docs/how-it-works.md",
      "docs/dream.md",
      "docs/brain-store.md",
      "docs/cli-reference.md",
      "docs/mcp.md",
      "docs/updating.md",
    ]) {
      expect(targets.has(required)).toBe(true);
    }
  });
});

describe("repository links of the landing pages", () => {
  for (const file of ["README.md", "docs/features.md"]) {
    test(`${file} links only to files that exist`, () => {
      expect(brokenLinks(file)).toEqual([]);
    });
  }
});

describe("o2b commands of the agent-facing pages", () => {
  for (const file of ["llms.txt", "README.md"]) {
    test(`${file} names only verbs the command manifest declares`, () => {
      const commands = o2bCommands(readFileSync(join(REPO_ROOT, file), "utf8"));
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.map(unknownVerb).filter((verb) => verb !== null)).toEqual([]);
    });
  }

  test("a verb the manifest does not declare is reported", () => {
    expect(unknownVerb("o2b dream agent set '[]'")).toBeNull();
    expect(unknownVerb("o2b setup --target <host>")).toBeNull();
    expect(unknownVerb("o2b dream agnet check")).toBe("o2b dream agnet");
    expect(unknownVerb("o2b discipline-report")).toBe("o2b discipline-report");
  });
});
