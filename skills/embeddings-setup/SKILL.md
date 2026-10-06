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

```bash
o2b search check
```

The output names every missing piece and ends with a
`recommendations:` block listing the exact commands to fix each.
Read both before suggesting next steps. The `recommendations` field
is also present in the `--json` output for headless callers.

Branch on what the report shows:

- `embedding_key: MISSING` → go to step 2. The `key_sources_checked:`
  line names where the key was looked for, and `key_present_under:`
  names any other registered provider profile whose env key is set. If
  the key sits under another profile, the fix may be pointing
  `embedding_provider` at that profile rather than adding a key.
- A recommendation saying the embedding model has no known price, or
  that the price pair names another model → see "Declare the model's
  price" in step 2.
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

The base URL must be `https://`. Plain `http://` works only for a
loopback host (`localhost`, `127.0.0.1`, `::1`). When the user's
embedding server runs on ANOTHER machine without TLS - LM Studio on the
Windows host reached from WSL, Ollama on a LAN box, a tailnet `100.x`
address - the endpoint is refused until the operator opts in for it
explicitly:

```bash
OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL=http://100.64.0.5:1234/v1
OPEN_SECOND_BRAIN_EMBEDDING_ALLOW_INSECURE_HTTP=true
```

(or `embedding_allow_insecure_http: true` in the o2b config; the
reranker has its own `search_rerank_allow_insecure_http`). Tell the user
what it means before setting it: chunk text and the API key cross the
network unencrypted, so it belongs only on a network they trust. The
opt-out never applies to a base URL that comes from a provider profile
registered with `o2b search provider add`; set the URL in config or env
instead. Every run that uses it prints one stderr warning per endpoint.

**Never invent or echo the key.** Write a placeholder, then ask the
user to paste their key in place of it. Recheck with `o2b search
check` after the user confirms.

### Declare the model's price

Spend estimates name their price source: `builtin` (the built-in table;
the `local` provider is free), `operator` (declared) or `unknown`. A
model the table does not list (most local servers, newer or niche
models) is `unknown`, and its estimates print `price unknown`. When the
user has set a positive `embedding_cost_gate_usd`, an unknown price
refuses embedding runs with `EMBEDDING_COST_UNPRICED` until the price is
declared, and it also refuses the query embeds of searches that do not
run at local reach (MCP tools and hooks): a hybrid search falls back to
keyword-only and names `semantic-cost-unpriced` in its trail. Ask the
user for the provider's rate (USD per million tokens)
and write the pair beside the other embedding settings:

```bash
OPEN_SECOND_BRAIN_EMBEDDING_PRICE_MODEL=nomic-embed-text:latest
OPEN_SECOND_BRAIN_EMBEDDING_PRICE_USD_PER_MTOK=0
```

(or `embedding_price_model` and `embedding_price_usd_per_mtok` in the
o2b config). Set both or neither. `0` declares the model free; only use
it when the user confirms the endpoint costs nothing, because a
loopback URL can still be a paid proxy. The pair names one model, so
after a model switch `o2b search check` flags the stale declaration
until it is updated. Declaring a price never triggers a reindex.

### Declare the model's input window (uncurated models)

A search query longer than the model's input window is cut to it before
the embed and the trail names `semantic-query-truncated`. The window
comes from the curated model table; for a model it does not list the
window is unknown and nothing is cut, so a serving stack that truncates
silently or refuses long inputs does so unannounced. When the user knows
the model's window (in its own tokens), declare it:

```bash
OPEN_SECOND_BRAIN_EMBEDDING_INPUT_WINDOW_TOKENS=512
```

(or `embedding_input_window_tokens` in the o2b config). It is refused
for the `local` provider, which has no window.

### Extra request fields (OpenAI-compatible endpoints)

When the user's serving stack needs a request field the provider does
not send, put a JSON object in `embedding_extra_body` (env
`OPEN_SECOND_BRAIN_EMBEDDING_EXTRA_BODY`). Only `openai-compat` sends it,
and `model`, `input` and `encoding_format` are refused by name. A
`dimensions` field needs `embedding_dimension` set to the same width:

```bash
OPEN_SECOND_BRAIN_EMBEDDING_EXTRA_BODY='{"dimensions": 512}'
OPEN_SECOND_BRAIN_EMBEDDING_DIM=512
```

The extra body is not part of the embedding identity, so changing it
never triggers a reindex; a changed `embedding_dimension` does. Some
fields shape the vectors the provider returns (a provider `task`,
`input_type`, `normalize` or `truncate` switch): after changing such a
field, rebuild the vectors with `o2b search reindex --embeddings` so new
query vectors stay in the space of the stored passages (`o2b search index
--force` keeps the stored vector of every unchanged chunk).

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

```bash
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

```bash
o2b search reindex --embeddings
```

This walks the vault, chunks every Markdown file, and computes
embeddings. Cost scales linearly with vault size — a 150-file vault
typically lands in a few seconds.

When the index already exists and only some chunks lack vectors,
price the work first with the dry run, then apply it:

```bash
o2b search vector-backfill
o2b search vector-backfill --apply
```

`--path <prefix>` (repeatable) limits the census, the estimate and the
spend to one part of the vault. For example,
`o2b search vector-backfill --path Brain/preferences/ --path Brain/retired/ --apply`
embeds just the belief notes, which is what the `semantic` query mode of
`brain_context_pack` reads. Later edits re-embed only the chunks that
changed; unchanged chunks keep their vectors.

Verify semantic search works:

```bash
o2b search "preferences for code review"
```

The output rows carry `(semantic)` in the source column when the
match came from the vector index.

## Step 6 — Offer periodic reindex

The vault keeps changing — other agents add notes, the user edits
existing ones. Without periodic refresh the embeddings drift behind
the keyword index.

```bash
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
