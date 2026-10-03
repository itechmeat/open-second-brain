# Per-context scope resolution - variants and decision

Consultant: the primary CLI consultant (`claude -p`, prompt in `cli-output/prompt.md`, verbatim answer in `cli-output/claude.md`). Exit 0, three parseable variants; the fallback consultant was not run.

## Variant 1: Three local seams - lost

Fix each lane where it lives: an optional `env` mapping on every Hermes resolver, sibling scoped-rule files read by a second reader, identity resolved inline in `server.ts` at `initialize` (from `clientInfo`) and separately in the hook, per-view reach edits.

Why it lost: identity derived in two places drifts, which is the cross-context carry-over this release exists to close, and `clientInfo` is a name the client asserts about itself. Its file layout and its untouched constitution survive in the chosen variant.

## Variant 2: One derived identity, one rules ladder, one reach layer - chosen, adjusted

Consultant's recommendation, accepted with five adjustments (evidence in `design.md`, "Chosen approach"):

1. No ladder around the constitution: `standing-rules.ts`, its header and its exemption are pinned byte for byte; the scoped reader is a second module joined after it.
2. No `clientInfo` and no MCP roots as identity sources: both are caller-named. The harness comes from a launch-time `--harness` argument.
3. No `ReachLayer` object: the shipped per-reader `readable` predicate, omitted at local reach, keeps local output byte-identical and the fast paths intact.
4. No settings-source argument on the Hermes resolvers: the doctor parity check and the parity suite call them with no arguments by file location.
5. The scoped layer renders at local reach only, the rule the consultant named as missing from its own variant.

## Variant 3: Scope axes extended, identity on the wire - lost

Scoped rules as ordinary pages with `harness` and `host` added to `SCOPE_AXES`; one Hermes child per vault with the turn's agent name sent as JSON-RPC `_meta`; reach pushed into the page index.

Why it lost: extending `SCOPE_AXES` changes page dedup keys, hub-candidate pools and search filters; per-call `_meta` turns the agent name into a request property every startup reader would have to learn, or it carries the launch profile over anyway; an index-level reach filter puts the local byte-identity pin at risk; rule pages outside the Brain-root refusal need uneditability argued again.

## Alternatives considered inside the chosen variant

| Question | Chosen | Lost, and why |
|---|---|---|
| Where a scoped rule lives | One file per scope value under `Brain/standing-rules/<axis>/<key>.md` | Frontmatter scoping inside the constitution: the constitution reader must not branch on content (`standing-rules.ts:37-44`) and its file is pinned byte for byte. |
| Harness source | Packaged `o2b mcp --harness <id>`, falling back to `--host-target` | `clientInfo` from MCP initialize: named by the client about itself (tests send arbitrary names, Hermes sends a constant), so a caller could pick its own rules. |
| Host source | Device id (`resolveDeviceId`) | `os.hostname()`: not stable, not unique, and host names must not reach public text or rule file names. |
| Budget of the scoped layer | Charged against `inject_budget_chars`, own cap, recorded in the receipt | Exempt like the constitution: the exemption is argued as the constitution's own property; three more exempt files would let scoped text grow the preamble without bound. |
| Axis vocabulary | Separate `SCOPED_RULE_AXIS` and `HARNESS_ID` | Extending `SCOPE_AXES`: it feeds page dedup keys, hub candidates and search filters, which are frontmatter- and caller-named by design. Extending `INSTALL_TARGET_ID`: its census requires it to equal the install adapter registry. |
| Hermes child environment | Explicit: copy, strip `PROFILE_SCOPED_ENV`, set resolved values | Adopting Hermes `strip_launch_profile_env`: Hermes-internal (`tools/environments/local.py`), not a plugin contract, and it would tie the plugin to an unpublished helper; the explicit strip names exactly what this plugin owns. |
| Missing profile scope | New `ProfileScopeError(ConfigReadError)` with its own message | Reusing `ConfigReadError`'s template: it says the config FILE is unreadable, which is false here, and its text is pinned by the parity test. A subclass keeps every existing catch site correct without touching that template. |
| Scoped-rule key | Unicode letters and digits kept (NFC, lowercased) | The session slug rule `[^a-z0-9]+`: throws on a project name with no Latin letters or digits, so such a project could never be keyed. |
| Host-unreadable report | One fixed sentence inside the scoped block, only when host files exist | A runtime notice: the collector runs on every surface without identity input, and would fire where no host file could apply. |
| Left-over lane content | Today loops, monthly, doctor counts, operator view | Status triple, entity-page provenance, ranking statistics: each is a lane of its own or a design change (recorded in `design.md`, "Out of scope"). |
