---
name: codegraph-partner
description: Use when the user explicitly mentions codegraph, asks structural code questions such as callers/callees/impact, asks where a symbol is defined, asks what breaks if a symbol changes, or asks for an architectural overview of a code repository. Skip for prose-only or vault-only questions.
---

# Codegraph partner

OSB and codegraph are complementary, not overlapping. OSB owns the vault
(Markdown prose, the Brain layer, preferences, paid-action audit). The
codegraph CLI and its MCP server own the code-symbol graph of a
repository - callers, callees, impact radius, AST. This skill teaches the
agent to detect codegraph in the current scope and to use, recommend, or
stay quiet about it, depending on what is actually nearby.

This skill never installs, initializes, or writes data for codegraph
itself. Those actions stay in the user's hands or in codegraph's own
installer.

## Step 1 - detect

Run these checks in order. Stop at the first state that matches.

1. CLI presence: `which codegraph` (or, in Bun runtimes, `Bun.which("codegraph")`).
2. Code-project signal in the current working directory: a `.git/`
   directory plus at least one of `package.json`, `pyproject.toml`,
   `Cargo.toml`, `go.mod`, `tsconfig.json`, `Gemfile`, `composer.json`,
   `build.gradle`, `pom.xml`.
3. If neither cwd nor the user's named project is a code project, look
   at the vault's parent directory and inspect the top-level entries
   (one level only). Many users keep their repos as siblings of the
   vault. All discovered code projects are candidates, not just the first.
4. Index state: a `.codegraph/` directory inside the code project root.
5. Confirmed index: `codegraph status -j <project_path>` returns
   `{"initialized": true, ...}`. The same command on an uninitialized
   project returns `{"initialized": false, ...}` rather than failing.

The structured way to ask is `o2b doctor`. When OSB is installed in the
workspace, the doctor report carries a `code_graph` line that summarises
the detection result with node count and file count.

Multi-project workspaces: when more than one code project is discovered,
the `code_graph` line covers EVERY project. Status is threaded per project
by passing each project's path to `codegraph status`, and the line
aggregates one entry per project (`N code projects:` followed by a bullet
per project naming its path and index state/health). This per-query
project-path threading is feature-detected: if the installed codegraph CLI
does not document a positional `[path]` argument for `status`, OSB cannot
trust per-project queries, so it degrades to reporting the first project
only and appends an explicit `note: codegraph CLI has no per-query
project_path support - reported 1 of N discovered projects only`. A
single-project workspace is unaffected and its line is unchanged.

## Step 2 - branch on result

| State | Agent behaviour |
|-------|-----------------|
| ok (CLI present, indexed) | Use codegraph for AST and graph queries. No install talk. |
| not_indexed (CLI present, no `.codegraph/` or `initialized: false`) | Offer one line: "run `codegraph init <path>` to index this repo". Do not run it yourself unless the user asks. |
| missing + code project | Argued recommendation (Step 5). |
| missing + no code project in scope | Stay quiet. |
| error (CLI present, `status -j` errors with a lock or schema issue) | Suggest `codegraph unlock <path>` or a rebuild, but do not run it. |

In a multi-project workspace the aggregate `code_graph` line can mix these
states across projects (one indexed, one not); read each bullet and act per
project. When the line ends with the `note: ... project_path support` marker,
only the first project was checked - query the others explicitly with
`codegraph status <their_path>` before trusting a single-project verdict.

## Step 3 - hard rule after `codegraph init`

Whenever you run `codegraph init` in any repository on the user's
behalf, immediately read that repo's `.gitignore` and append a
`.codegraph/` line if one is not already present. The append must be
atomic, must preserve the existing trailing newline policy, and must
not touch any other line.

If the repo does not have a `.gitignore`, do not create one yourself.
Tell the user the file is missing and that they should decide whether
to add it.

This rule exists so the local codegraph index never lands in a commit.

## Step 4 - tool-vs-tool disambiguation

Use this table to pick the right tool for each kind of question. Do not
duplicate a codegraph answer by also running a grep; treat its output
as authoritative.

| Question shape | Tool |
|----------------|------|
| Where is symbol X defined? | `codegraph_search` |
| Who calls function Y? | `codegraph_callers` |
| What does Y call? | `codegraph_callees` |
| What would break if I change Z? | `codegraph_impact` |
| Show Y's signature or body. | `codegraph_node` |
| Survey several related symbols at once. | `codegraph_explore` |
| What files exist under path P? | `codegraph_files` |
| Prose, page bodies, MOC content, daily notes. | `brain_search` |
| Confirmed preferences, taste rules. | `brain_query` |
| Free-text fallback when neither index helps. | Plain grep, last resort. |

## Step 5 - argued install recommendation

Trigger only when both conditions hold: there is a code project in the
current scope, and `codegraph` is not on the user's PATH.

Show the user a short paragraph that uses real numbers from their
project, with no emoji and no marketing voice. Template:

> Found a code project at `<path>` with N source files. Without an
> index, every structural question (callers, impact, "where is X")
> spawns a grep+read loop that burns several thousand tokens per
> answer. codegraph keeps a SQLite knowledge graph and serves the
> same question in sub-millisecond time. Installer:
> `curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh`
> (or `npm i -g @colbymchenry/codegraph`). After install: `codegraph
> init <path>` from inside the repo.

If the user says no, drop the topic for the rest of the session. Do
not nag.

## Out of scope

- Do not call `codegraph install`, `codegraph init`, or `codegraph
  index` automatically.
- Do not read or write `.codegraph/codegraph.db`.
- Do not mirror codegraph data into the Brain or the vault search
  index.
- Do not modify `~/.claude.json`, `.cursor/rules/`, or any other agent
  config on behalf of codegraph.
