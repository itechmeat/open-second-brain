---
name: embeddings-setup
description: Bring Open Second Brain semantic search online — embedding API key, sqlite-vec extension, first reindex, optional periodic refresh. INVOKE when the user mentions "embeddings", "semantic search", "vector index", or after `o2b search check` reports `vec_extension: unavailable`, `embedding_key: missing`, or any line in its `recommendations:` block. SKIP when the user is asking conceptual questions about embeddings or comparing providers without intent to set up — answer those directly.
---

# Embeddings setup

Open Second Brain ships with two search paths: keyword-only (always
on, no credentials) and semantic via embedded vectors (opt-in). This
SKILL walks the activation flow for the semantic path. The flow is
proactive — when the user mentions semantic search or `o2b search
check` surfaces missing pieces, take the user through this list
rather than waiting for explicit instruction.

## Step 1 — Always start with `o2b search check`

```
o2b search check
```

The output names every missing piece and ends with a
`recommendations:` block listing the exact commands to fix each.
Read both before suggesting next steps. The `recommendations` field
is also present in the `--json` output for headless callers.

Branch on what the report shows:

- `embedding_key: MISSING` → go to step 2.
- `vec_extension: unavailable` on macOS → go to step 3.
- `vec_extension: unavailable` on Linux → go to step 4.
- Everything OK but `semantic_enabled: false` (no embeddings yet) →
  go to step 5.

## Step 2 — Provider and API key

Ask the user which provider they want. The default is
`text-embedding-3-small` from OpenAI (about $0.02 per 1M tokens,
which covers tens of thousands of vault pages). Any OpenAI-compatible
endpoint works — Groq, Together, a local LM Studio server, etc.

Required env vars (write to `~/.hermes/.env` or the configured env
file, never to a tracked file):

```bash
OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER=openai-compat
OPEN_SECOND_BRAIN_EMBEDDING_MODEL=text-embedding-3-small
OPEN_SECOND_BRAIN_EMBEDDING_KEY=<placeholder; user pastes the key>
# Optional — only when not using OpenAI:
# OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL=https://api.together.xyz/v1
```

**Never invent or echo the key.** Write a placeholder, then ask the
user to paste their key in place of it. Recheck with `o2b search
check` after the user confirms.

## Step 3 — macOS: install Homebrew SQLite

Apple ships `/usr/lib/libsqlite3.dylib` with
`SQLITE_OMIT_LOAD_EXTENSION`, so the optional `sqlite-vec` extension
cannot load against the system SQLite. Homebrew's `sqlite` formula
is built with extension loading enabled.

```bash
brew install sqlite
```

The `o2b` wrapper auto-detects Homebrew SQLite on Darwin and exports
`DYLD_LIBRARY_PATH` for `bun:sqlite` on the next invocation. No
manual patching of the wrapper script is needed (the v0.10.5 shim
`scripts/_macos-sqlite.sh` handles it). Verify with:

```
o2b search check
```

Expect `vec_extension: loaded`.

## Step 4 — Linux: reconfirm the optional dependency

`sqlite-vec` ships as an optional dependency. If the install path
missed it, force a rebuild:

```bash
bun pm ls | grep sqlite-vec
bun install --force
```

If the package is present but still does not load, the Linux build
of `libsqlite3` may have been compiled without `LOAD_EXTENSION`.
Capture `sqlite3 :memory: "PRAGMA compile_options;"` and surface it
to the user — they will know whether their distro's SQLite is
unusual.

## Step 5 — Compute the first vectors

```
o2b search reindex --embeddings
```

This walks the vault, chunks every Markdown file, and computes
embeddings. Cost scales linearly with vault size — a 150-file vault
typically lands in a few seconds.

Verify semantic search works:

```
o2b search "preferences for code review"
```

The output rows carry `(semantic)` in the source column when the
match came from the vector index.

## Step 6 — Offer periodic reindex

The vault keeps changing — other agents add notes, the user edits
existing ones. Without periodic refresh the embeddings drift behind
the keyword index.

```
o2b search reindex --cron-template
```

Prints a watchdog script (a heredoc that, when the operator runs
the printed block, lands at `~/.local/bin/osb-reindex.sh`), a
native crontab line, and a `hermes cron create` command. Pure
stdout — the verb writes nothing on its own; pick the path that
matches the host and paste the relevant section into your
shell / crontab. Recommended cadence:

- 30 minutes when the vault sees active multi-agent work.
- 6 hours when changes are sporadic.

Override with `--interval 6h` (or any `<N>m|h|d` value below 60m / 24h
/ unlimited days).

## Multi-agent note

Only the agent that runs `reindex` needs
`OPEN_SECOND_BRAIN_EMBEDDING_KEY`. Read-only consumers (sibling
Claude Code / Codex / OpenClaw sessions on the same vault) query
the already-computed vectors and never see the key. When designating
the reindex owner, the canonical choice is Hermes (it carries the
cron infrastructure); the others stay credential-free.

## What this SKILL does NOT do

- Does not invoke `brew install` on the user's behalf. The SKILL
  prints the command; the user runs it.
- Does not paste an API key into the env file silently. Always use
  a placeholder, then ask the user to substitute.
- Does not commit env files. They live outside the tracked tree.
- Does not launch a long-running watcher inside OSB — the
  `--cron-template` recipe is the endorsed automation path.
