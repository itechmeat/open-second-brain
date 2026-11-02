You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Release wave "agent-presence-self-improvement" (option 1): implement all four kanban cards in one PR on one feature branch.

- t_635e3e72 - Scored skill rewrites gated by task benchmarks: give an existing skill's instructions an improvement lane that is closed-loop over scored tasks. Per-skill benchmark task sets, a candidate rewrite driven through envelopes, a deterministic selection gate the candidate must win on training tasks, one held-out check on the final champion, and an apply path through the existing human-accepted, journalled proposal pipeline.
- t_ba41a78a - Install writes a brain-usage instruction block into agent rules files: an install step that writes the same-turn atomic-fact write-gate managed block (whose conformance the writeback-contract checker already fully specifies) into the agent-instruction file each installed host actually reads, idempotently, keeping operator content outside the block byte-for-byte.
- t_1e952e43 - Operator-approved lessons promoted into rules files: an approval-hold tier on lessons plus an apply-gated write that installs a managed block of operator-approved, qualified lessons into the same rules files, reaching agents that never load hooks.
- t_8b793376 - ChatGPT desktop as an install target: it reads the same ~/.codex/config.toml the codex adapter already writes; the residue is naming it (detect notes, README, guide). The decision left open is separate target vs alias of the codex adapter.

The four cards share one machinery spine: an apply-gated rules-file write path (the installer and the lessons lane are two producers over one writer) plus the closed skill-improvement loop. The task is to argue the SHAPE of the wave - how the four implementations compose into one coherent design.

# Project context

Open Second Brain - local-first agent memory for Claude Code, Codex, opencode and other hosts as an MCP server and CLI (`o2b`), TypeScript on Bun. Kernel invariants that bind every variant: writes to operator surfaces pass explicit apply gates (plan/consent/apply with typed refusals), no model in the kernel (generation is envelope-mediated), no silent fallbacks (errors surface by name), no hardcoded natural-language vocabularies (structural predicates and operator-declared lists), and the tree's census tests fail loudly on unregistered write sites, state surfaces and verdict vocabularies.

Recent commits:
07125f6d feat: delivery trust, end to end (v1.97.0) (#285)
285cb9a8 feat: trust and responsiveness hardening - neutralized imports, gitignore guardrails, shadowed-contract detection, parallel MCP reads (v1.96.0) (#281)
88c118aa feat: verified delivery and honest write surfaces (v1.95.0) (#280)

Answer with three named variants (approach, trade-offs with pros and cons, complexity, risk) and a recommendation with rationale.
