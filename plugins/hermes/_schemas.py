"""Vendored static schemas for the curated Hermes memory-tool surface.

Hermes builds its memory-tool routing table from ``get_tool_schemas()`` at
provider registration time, BEFORE ``initialize()`` starts the ``o2b mcp``
bridge. These vendored copies let the provider advertise its curated tools
while the bridge is not available yet; once the bridge is up, live schemas
from ``tools/list`` win.

Each entry is a verbatim (name, description, inputSchema) projection of the
live server's ``tools/list`` output. ``tests/python/test_static_schemas.py``
compares these copies against the live server (anti-drift), so edits here
that diverge from the TS core fail CI. To re-vendor after a schema change in
the TS core, copy the projection from a live ``o2b mcp`` ``tools/list``.

The copies mirror the live server exactly, including spots where the provider
relies on server-side coercion (e.g. ``brain_pre_compact_extract`` declares
``turn_start``/``turn_end`` as strings while ``_flush_buffer`` passes ints).
Do not "fix" such fields here; the server is the source of truth.
"""

from __future__ import annotations

import copy
from typing import Any

STATIC_TOOL_SCHEMAS: tuple[dict[str, Any], ...] = (
    {'name': 'brain_feedback',
     'description': 'Record one Brain taste signal in `Brain/inbox/sig-*.md`. With '
                    '`force_confirmed: true`, create the preference directly (skips the dream '
                    'trial window).',
     'inputSchema': {'type': 'object',
                     'properties': {'topic': {'type': 'string',
                                              'description': 'Stable kebab-slug for the rule, e.g. '
                                                             '`no-internal-abbrev`.'},
                                    'signal': {'type': 'string',
                                               'enum': ['positive', 'negative'],
                                               'description': '`positive` when the principle is '
                                                              'the rule to follow, `negative` when '
                                                              "it's what to avoid."},
                                    'principle': {'type': 'string',
                                                  'description': 'One-line, agent-readable '
                                                                 'formulation of the rule '
                                                                 '(imperative voice).'},
                                    'scope': {'type': 'string',
                                              'description': 'Optional soft category for later '
                                                             'application-scope matching, e.g. '
                                                             '`writing`, `coding`.'},
                                    'source': {'type': 'array',
                                               'items': {'type': 'string'},
                                               'description': 'Optional wikilinks to the artifacts '
                                                              'or notes that triggered the '
                                                              'signal.'},
                                    'agent': {'type': 'string',
                                              'description': 'Optional agent identity override; '
                                                             'defaults to the server-resolved '
                                                             'name.'},
                                    'raw': {'type': 'string',
                                            'description': 'Optional free-form raw quote (rendered '
                                                           'under `## Raw` in the signal file).'},
                                    'force_confirmed': {'type': 'boolean',
                                                        'description': 'When true, also creates an '
                                                                       'immediately-active '
                                                                       'confirmed `pref-*` '
                                                                       'alongside the inbox '
                                                                       'signal, skipping the '
                                                                       'dream-pass promotion '
                                                                       'step.'},
                                    'event_time': {'type': 'string',
                                                   'description': 'Optional ISO-8601 event-time for '
                                                                  'a backfilled signal (when it '
                                                                  'actually happened). Stamps '
                                                                  '`created_at`/`valid_from`/'
                                                                  '`recorded_at`; absent uses '
                                                                  'wall-clock.'},
                                    'idempotency_key': {'type': 'string',
                                                        'description': 'Optional client key that '
                                                                       'dedupes retried calls: same '
                                                                       'key + same payload is a '
                                                                       'no-op; same key + different '
                                                                       'payload is rejected.'}},
                     'required': ['topic', 'signal', 'principle'],
                     'additionalProperties': False}},
    {'name': 'brain_apply_evidence',
     'description': 'Record whether an active preference was applied, violated, or marked outdated '
                    'against a freshly-produced durable artifact. Appends one event to '
                    '`Brain/log/<today>.md`. A single `outdated` event triggers retire on the next '
                    'dream pass.',
     'inputSchema': {'type': 'object',
                     'properties': {'pref_id': {'type': 'string',
                                                'description': 'Preference id (`pref-<slug>` or '
                                                               'bare `<slug>`).'},
                                    'artifact': {'type': 'string',
                                                 'description': 'Wikilink identifying the '
                                                                'artifact; optional inclusive '
                                                                'line-range suffix, e.g. '
                                                                '`[[src/cli/main.ts:120-145]]`.'},
                                    'result': {'type': 'string',
                                               'enum': ['applied', 'violated', 'outdated'],
                                               'description': '`applied` if the rule held, '
                                                              '`violated` if broken, `outdated` if '
                                                              'the artifact shows the rule itself '
                                                              'is obsolete.'},
                                    'agent': {'type': 'string',
                                              'description': 'Optional agent identity override; '
                                                             'defaults to the server-resolved '
                                                             'name.'},
                                    'outcome': {'type': 'string',
                                                'enum': ['success', 'failure', 'unknown'],
                                                'description': 'Optional downstream outcome of the '
                                                               'artifact (t_d478df53): did the '
                                                               'work the rule was applied to '
                                                               'actually succeed? `unknown` is '
                                                               'treated like an absent outcome.'},
                                    'note': {'type': 'string',
                                             'description': 'Optional one-line context.'}},
                     'required': ['pref_id', 'artifact', 'result'],
                     'additionalProperties': False}},
    {'name': 'brain_note',
     'description': 'Append one narrative-milestone line (release shipped, PR merged, fact '
                    "discovered) to today's Brain log under the `note` event kind. Use when "
                    'neither brain_feedback nor brain_apply_evidence fits.',
     'inputSchema': {'type': 'object',
                     'properties': {'text': {'type': 'string',
                                             'description': 'One-line narrative description. '
                                                            'Newlines collapse to single spaces; '
                                                            'the shared redactor strips '
                                                            'secret-shaped tokens.'},
                                    'agent': {'type': 'string',
                                              'description': 'Optional agent identity override; '
                                                             'defaults to the server-resolved '
                                                             'name.'}},
                     'required': ['text'],
                     'additionalProperties': False}},
    {'name': 'brain_pinned_context',
     'description': 'Read, write, append, or clear the transient current-task scratchpad at '
                    '`Brain/pinned.md`. Use for facts that should survive context rotation but '
                    'should not become permanent preferences. Pass `operations` to apply an '
                    'ordered batch atomically (all-or-nothing).',
     'inputSchema': {'type': 'object',
                     'properties': {'operation': {'type': 'string',
                                                  'enum': ['read', 'write', 'append', 'clear'],
                                                  'description': 'Single operation to perform. '
                                                                 'Defaults to read. Ignored when '
                                                                 '`operations` is given.'},
                                    'content': {'type': 'string',
                                                'description': 'Pinned context body for '
                                                               'write/append operations.'},
                                    'operations': {'type': 'array',
                                                   'description': 'Ordered batch applied '
                                                                  'atomically; any invalid op '
                                                                  'aborts the whole batch with no '
                                                                  'write.',
                                                   'items': {'type': 'object',
                                                             'properties': {'op': {'type': 'string',
                                                                                   'enum': ['write',
                                                                                            'append',
                                                                                            'clear',
                                                                                            'replace']},
                                                                            'content': {'type': 'string',
                                                                                        'description': 'Body for write/append ops.'},
                                                                            'find': {'type': 'string',
                                                                                     'description': 'Exact segment to locate for a replace op.'},
                                                                            'replace': {'type': 'string',
                                                                                        'description': 'Replacement text for a replace op.'}},
                                                             'required': ['op'],
                                                             'additionalProperties': False}}},
                     'additionalProperties': False}},
    {'name': 'brain_query',
     'description': 'Read-only lookup: one preference + its evidence trail, all artifacts under a '
                    'topic, or every log event after a timestamp. Exactly one of `preference`, '
                    '`topic`, `since` must be supplied.',
     'inputSchema': {'type': 'object',
                     'properties': {'preference': {'type': 'string',
                                                   'description': 'Preference id (`pref-...` or '
                                                                  '`ret-...`) to look up with its '
                                                                  'evidence trail.'},
                                    'topic': {'type': 'string',
                                              'description': 'Topic slug to aggregate signals + '
                                                             'active/retired preference + log '
                                                             'events.'},
                                    'show_expired': {'type': 'boolean',
                                                     'description': 'Topic mode only: include '
                                                                    'memories past their '
                                                                    '`expiration_date`. Default '
                                                                    'false (expired memories are '
                                                                    'silently dropped from the '
                                                                    'result).'},
                                    'since': {'type': 'string',
                                              'description': 'ISO-8601 timestamp; returns every '
                                                             'Brain log event with timestamp >= '
                                                             'since.'},
                                    'format': {'type': 'string',
                                               'enum': ['markdown', 'json'],
                                               'description': 'Reserved for forward-compat; the '
                                                              'structured response is the same '
                                                              'regardless.'},
                                    'telemetry': {'type': 'boolean',
                                                  'description': 'Opt-in recall telemetry: emit '
                                                                 'one continuity record (mode '
                                                                 "'query', kind-only payload) for "
                                                                 'this call.'},
                                    'telemetry_host': {'type': 'string', 'maxLength': 200},
                                    'session_id': {'type': 'string', 'maxLength': 512},
                                    'turn_id': {'type': 'string', 'maxLength': 512},
                                    'agent_scope': {'type': 'string',
                                                    'description': 'Optional owner scope: with '
                                                                   'owner_scoped_facts on, an '
                                                                   'owner-tagged fact returns only '
                                                                   'to its own scope; ownerless '
                                                                   'facts always match. Absent = '
                                                                   'no filtering.'}},
                     'additionalProperties': False}},
    {'name': 'brain_search',
     'description': 'Full-text search across the vault. Optional semantic layer when configured. '
                    'Read-only.',
     'inputSchema': {'type': 'object',
                     'properties': {'query': {'type': 'string', 'minLength': 1, 'maxLength': 2000},
                                    'query_document': {'type': 'string',
                                                       'minLength': 1,
                                                       'maxLength': 4000},
                                    'focus_query': {'type': 'string',
                                                    'minLength': 1,
                                                    'maxLength': 1000},
                                    'focus_path_prefix': {'type': 'string',
                                                          'minLength': 1,
                                                          'maxLength': 256},
                                    'focus_session': {'type': 'string',
                                                      'minLength': 1,
                                                      'maxLength': 128,
                                                      'description': 'Session id whose bound focus '
                                                                     'applies (falls back to the '
                                                                     'global focus).'},
                                    'evidence_pack': {'type': 'boolean'},
                                    'include_superseded': {'type': 'boolean',
                                                           'description': 'History mode for '
                                                                          'relation polarity: keep '
                                                                          'matched superseded '
                                                                          'predecessors undemoted '
                                                                          'and skip successor '
                                                                          'pull-in. Default '
                                                                          'false.'},
                                    'since': {'type': 'string',
                                              'maxLength': 64,
                                              'description': 'Time-aware recall: only documents '
                                                             'modified at/after this point. ISO '
                                                             "date/datetime, 'today', 'yesterday', "
                                                             "'last week', 'last month', or "
                                                             '<n>h/<n>d/<n>w.'},
                                    'until': {'type': 'string',
                                              'maxLength': 64,
                                              'description': 'Time-aware recall: only documents '
                                                             'modified at/before this point. Same '
                                                             "forms as 'since'."},
                                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 50},
                                    'semantic': {'type': 'boolean'},
                                    'keyword_only': {'type': 'boolean'},
                                    'profile': {'type': 'string',
                                                'enum': ['fast', 'balanced', 'thorough'],
                                                'description': 'Named recall profile '
                                                               '(fast|balanced|thorough): a fixed '
                                                               'knob preset, preferred over '
                                                               'persisted self-tuning. Absent '
                                                               'leaves ranking unchanged.'},
                                    'explain': {'type': 'boolean',
                                                'description': 'Include a structured '
                                                               'score_breakdown (per-layer numeric '
                                                               'components) on each result. '
                                                               'Default false.'},
                                    'trust': {'type': 'boolean',
                                              'description': 'Stamp each result with inline trust '
                                                             'metadata (age_days, superseded, '
                                                             'conflict), computed at read time. '
                                                             'Default false.'},
                                    'threshold': {'type': 'number',
                                                  'minimum': 0,
                                                  'maximum': 1,
                                                  'description': 'Relevance floor in [0,1] on the '
                                                                 'final score; drops weaker hits '
                                                                 'so an irrelevant query returns '
                                                                 'no match. Default 0 (disabled).'},
                                    'rerank': {'type': 'boolean',
                                               'description': 'Re-order the threshold-qualified '
                                                              'results by core textual relevance '
                                                              '(keyword + semantic). Default '
                                                              'false.'},
                                    'reinforce': {'type': 'array',
                                                  'maxItems': 50,
                                                  'items': {'type': 'string',
                                                            'minLength': 1,
                                                            'maxLength': 512},
                                                  'description': 'Paths proven useful: recorded to '
                                                                 'the reinforce ledger and lifted '
                                                                 '(bounded) before the top_k cut. '
                                                                 'Default absent.'},
                                    'record_access': {'type': 'boolean',
                                                      'description': 'Record the surfaced paths as '
                                                                     'one activation access event '
                                                                     '(feeds the usage-aware '
                                                                     'ranking layer). Default '
                                                                     'true; never recorded for '
                                                                     'global searches.'},
                                    'global': {'type': 'boolean',
                                               'description': 'Cross-vault union: search profile '
                                                              'vaults and read-only recall sources '
                                                              'too, merging results with origin '
                                                              'labels. Default false (active vault '
                                                              'only).'},
                                    'path_prefix': {'type': 'string', 'maxLength': 256},
                                    'telemetry': {'type': 'boolean'},
                                    'telemetry_host': {'type': 'string', 'maxLength': 200},
                                    'session_id': {'type': 'string', 'maxLength': 512},
                                    'turn_id': {'type': 'string', 'maxLength': 512},
                                    'properties': {'type': 'object',
                                                   'description': 'Optional frontmatter property '
                                                                  'filter (v0.10.17). Each key '
                                                                  'maps to one or more accepted '
                                                                  'scalar values; multi-value '
                                                                  'within a key is OR, multiple '
                                                                  'keys is AND.',
                                                   'additionalProperties': {'type': 'array',
                                                                            'items': {'type': 'string'}}},
                                    'visibility': {'type': 'array',
                                                   'description': 'Optional content-visibility '
                                                                  'scope; untagged pages always '
                                                                  'match, tagged pages only when '
                                                                  'this scope includes one of '
                                                                  'their values.',
                                                   'items': {'type': 'string'}},
                                    'agent_scope': {'type': 'string',
                                                    'description': 'Optional agent-ownership '
                                                                   'scope; shared (ownerless) '
                                                                   'pages always match, '
                                                                   'owner-tagged pages only their '
                                                                   'owner. Absent = no ownership '
                                                                   'filtering.'},
                                    'disclosure': {'type': 'string',
                                                   'enum': ['full', 'cards'],
                                                   'description': "Result depth: 'full' "
                                                                  '(default) returns full chunk '
                                                                  "content; 'cards' returns token-"
                                                                  'cheap layer-1 cards — drill a '
                                                                  'hit with brain_search_expand.'}},
                     'required': ['query'],
                     'additionalProperties': False}},
    {'name': 'brain_recall_gate',
     'description': 'Classify whether an automatic recall/surfacing attempt should run. '
                    'Diagnostics only; does not search. Pass `scores` (a recall attempt\'s '
                    'top-k relevance scores) to also get an adequacy verdict — sufficient '
                    '(proceed) / weak (re_recall) / insufficient (abstain + escalate).',
     'inputSchema': {'type': 'object',
                     'properties': {'prompt': {'type': 'string', 'minLength': 1, 'maxLength': 4000},
                                    'previous_prompt': {'type': 'string', 'maxLength': 4000},
                                    'explicit': {'type': 'boolean'},
                                    'telemetry_host': {'type': 'string', 'maxLength': 200},
                                    'session_id': {'type': 'string', 'maxLength': 512},
                                    'scores': {'type': 'array',
                                               'maxItems': 200,
                                               'items': {'type': 'number'},
                                               'description': 'Optional top-k recall relevance '
                                                              'scores. When given, the gate adds '
                                                              'an adequacy verdict: '
                                                              'sufficient/proceed, weak/re_recall, '
                                                              'or insufficient/abstain.'}},
                     'required': ['prompt'],
                     'additionalProperties': False}},
    {'name': 'brain_context',
     'description': 'Pull the current Brain/active.md body, pinned current-task context, and '
                    'active-preference counts. Use at session start when SessionStart hook is '
                    'unavailable (Cursor, Aider, raw Claude API). Read-only.',
     'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}},
    {'name': 'brain_context_pack',
     'description': 'Return the highest-tier, most recent vault slice that fits under '
                    '`max_tokens`. Ordered core → supporting → peripheral, newest first; stops '
                    'adding pages when the next page would exceed the budget. Read-only.',
     'inputSchema': {'type': 'object',
                     'properties': {'max_tokens': {'type': 'integer',
                                                   'minimum': 1,
                                                   'description': 'Strict upper bound on the '
                                                                  "returned slice's token count."},
                                    'query': {'type': 'string',
                                              'description': 'Optional case/Unicode-insensitive '
                                                             'substring filter on topic + '
                                                             'principle.'},
                                    'focus_session': {'type': 'string',
                                                      'minLength': 1,
                                                      'maxLength': 128,
                                                      'description': 'Session id whose bound '
                                                                     'search focus boosts matching '
                                                                     'memories (requires '
                                                                     'search_focus_context_pack).'},
                                    'max_chars_per_memory': {'type': 'integer',
                                                             'minimum': 1,
                                                             'description': 'Optional per-page '
                                                                            'character cap so one '
                                                                            'huge page cannot '
                                                                            'crowd out the rest; '
                                                                            'trimmed pages carry '
                                                                            '`trimmed: true`.'},
                                    'max_total_chars': {'type': 'integer',
                                                        'minimum': 1,
                                                        'description': 'Optional second ceiling '
                                                                       '(code points) on the '
                                                                       'cumulative size of the '
                                                                       'returned slice. '
                                                                       'Lowest-priority overflow '
                                                                       'is dropped with an '
                                                                       '`over-char-budget` skip '
                                                                       'reason.'},
                                    'lanes': {'type': 'boolean',
                                              'description': 'When true, also return '
                                                             'polarity-aware directives, '
                                                             'constraints, and consider lanes. '
                                                             'Legacy flat `items` remains '
                                                             'present.'},
                                    'cache_stable': {'type': 'boolean',
                                                     'description': 'When true, reorder the '
                                                                    'selected items by stable id '
                                                                    'and annotate their original '
                                                                    'rank.'},
                                    'dedup_repeated': {'type': 'boolean',
                                                       'description': 'When true, replace repeated '
                                                                      'context bodies with '
                                                                      'reference hints to an '
                                                                      'earlier emitted item.'},
                                    'attention_flow_ids': {'type': 'array',
                                                           'items': {'type': 'string'},
                                                           'description': 'Optional declarative '
                                                                          'attention flow ids to '
                                                                          'inject as a synthetic '
                                                                          'context block.'},
                                    'receipt': {'type': 'boolean',
                                                'description': 'When true, emit an opt-in context '
                                                               'receipt for this context-pack '
                                                               'run.'},
                                    'receipt_host': {'type': 'string',
                                                     'description': 'Optional host/runtime name '
                                                                    'for emitted receipts; '
                                                                    'defaults to `mcp`.'},
                                    'recall_scores': {'type': 'array',
                                                       'maxItems': 200,
                                                       'items': {'type': 'number'},
                                                       'description': 'Optional relevance scores '
                                                                      'of the recall behind this '
                                                                      'material. When given, the '
                                                                      'response adds an adequacy '
                                                                      'verdict (level + action) and '
                                                                      'persists it in the receipt.'},
                                    'telemetry': {'type': 'boolean',
                                                  'description': 'When true, emit an opt-in recall '
                                                                 'telemetry record for this '
                                                                 'context-pack run.'},
                                    'telemetry_host': {'type': 'string',
                                                       'description': 'Optional host/runtime name '
                                                                      'for emitted telemetry; '
                                                                      'defaults to `mcp`.'},
                                    'session_id': {'type': 'string',
                                                   'description': 'Optional session id recorded on '
                                                                  'emitted telemetry.'},
                                    'turn_id': {'type': 'string',
                                                'description': 'Optional turn id recorded on '
                                                               'emitted telemetry.'}},
                     'required': ['max_tokens'],
                     'additionalProperties': False}},
    {'name': 'brain_pre_compact_extract',
     'description': 'Extract typed Decision/Commitment/Outcome/Rule/Open question records from '
                    'bounded text into continuity storage.',
     'inputSchema': {'type': 'object',
                     'properties': {'session_id': {'type': 'string',
                                                   'description': 'Session identifier used for '
                                                                  'idempotency and source refs.'},
                                    'turn_start': {'type': 'string',
                                                   'description': 'First source turn id in the '
                                                                  'extracted segment.'},
                                    'turn_end': {'type': 'string',
                                                 'description': 'Last source turn id in the '
                                                                'extracted segment.'},
                                    'text': {'type': 'string',
                                             'description': 'Bounded text segment to scan for '
                                                            'labeled extraction lines.'},
                                    'host': {'type': 'string',
                                             'description': 'Optional host/client label.'},
                                    'max_chars': {'type': 'integer',
                                                  'minimum': 1,
                                                  'description': 'Optional maximum input '
                                                                 'characters to scan before '
                                                                 'extracting.'},
                                    'interrupted': {'type': 'boolean',
                                                    'description': 'When true, mark the extracted '
                                                                   'records as flushed by an '
                                                                   'interrupted close '
                                                                   '(SIGHUP/SIGTERM/force-quit/'
                                                                   'restart-drain). Absent by '
                                                                   'default.'},
                                    'dry_run': {'type': 'boolean',
                                                'description': 'Preview the candidate records '
                                                               'extraction would append WITHOUT '
                                                               'writing to the vault (no '
                                                               'continuity record, no dream/retire '
                                                               'trigger). Absent by default.'}},
                     'required': ['session_id', 'turn_start', 'turn_end', 'text'],
                     'additionalProperties': False}},
)


def static_tool_schemas() -> list[dict[str, Any]]:
    """Deep copies of the vendored schemas; callers may mutate freely.

    Converts MCP ``inputSchema`` to ``parameters`` so Hermes adapters
    (Anthropic, OpenAI, Bedrock) can see the tool's expected arguments.
    """
    schemas = [copy.deepcopy(schema) for schema in STATIC_TOOL_SCHEMAS]
    for s in schemas:
        if "inputSchema" in s and "parameters" not in s:
            s["parameters"] = s.pop("inputSchema")
    return schemas
