# ADR: Brain Model Semantics Foundation

**Status:** accepted for this PR
**Date:** 2026-05-30
**Scope:** `t_965212be`, `t_f373499d`, `t_09dc93c1`

## Context

The selected upstream tasks point toward three related but differently sized ideas: typed memory edges, selective branch picks, and L0-L3 memory layers. Open Second Brain already has typed graph semantics for arbitrary vault pages, a Brain backlink index, a deterministic preference writer/parser, and pairwise merge/retire behavior. The safest foundation is to extend those existing boundaries rather than introduce a second graph or rewrite the Brain lifecycle.

## Decision

Open Second Brain will add a narrow, frontmatter-native semantics foundation for preferences:

- Preference typed edges use the existing relation vocabulary boundary.
- Preference files may carry optional top-level typed relation fields such as `depends_on:` and `refines:`.
- Preference files may carry optional inert metadata labels: `memory_layer: L0|L1|L2|L3` and `memory_branch` as a validated slug value.
- The Brain explorer and backlink index project these fields as read-only semantics.
- A deterministic dry-run planner can propose high-confidence supersession-edge backfill from existing `supersedes` / `superseded_by` evidence.

## Consequences

This PR creates a stable source-of-truth shape for future model semantics while preserving existing Brain behavior. It does not create isolated branch state, does not implement selective pick mutation, and does not change `dream` retention or confidence policies per layer. Those behaviors need separate ADRs because they affect snapshots, audit, rollback, query semantics, conflict handling, and user expectations.

## Deferred decisions

- Where branch state lives if Open Second Brain later supports copy-on-write Brain branches.
- How selective pick resolves conflicts between preference revisions and content hashes.
- Whether L0-L3 layers should influence `dream`, active digest rendering, search ranking, or retention.
- Whether semantic backfill should gain an apply mode, and which audit/snapshot guard it must use before writes.
- Whether relation tokens beyond `depends_on` and `refines` should be added.
