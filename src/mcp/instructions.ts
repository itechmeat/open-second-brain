/**
 * Server-supplied instructions returned in `initialize.instructions`.
 *
 * Mirrors `_build_instructions` from the legacy Python implementation.
 * Keep the wording identical — the same string is read by Hermes, Claude
 * Code, Codex, and OpenClaw, and is referenced verbatim in test fixtures.
 */

export function buildInstructions(defaultAgent: string): string {
  return (
    `You are @${defaultAgent} on this Open Second Brain vault. ` +
    "Always log under this identity; do not invent or change the name.\n\n" +
    "When to call event_log_append:\n" +
    "  - immediately after producing a durable artifact, including:\n" +
    "    * code shipped, bug fixed, refactor merged\n" +
    "    * config / deployment / infrastructure change\n" +
    "    * instruction-file edit (CLAUDE.md, SOUL.md, plugin docs, " +
    "system prompts, similar)\n" +
    "    * content artifact created (post, draft, documentation, " +
    "marketing copy, release notes)\n" +
    "    * research, investigation, or analysis that produced a " +
    "concrete finding, design, or decision worth recalling later\n" +
    "    * discovery of an external fact (CLI behaviour change, " +
    "API quirk, undocumented edge case) that future sessions should " +
    "know\n" +
    "  - skip for: pure discussion or brainstorming without " +
    "conclusion, read-only queries, or planning that hasn't yet " +
    "produced an artifact\n\n" +
    'If unsure, ask: "would future-me want to find this in the log ' +
    'by searching for it later?". If yes, log it.\n\n' +
    "How to format the `message` argument:\n" +
    "  - plain prose describing what was done / found / decided and " +
    "why it matters\n" +
    "  - DO NOT prepend `HH:MM —` or `@<name> —` to the message; " +
    "the server adds these automatically\n" +
    "  - terse, append-only, factual; never edit historical lines\n\n" +
    "Identity is resolved server-side. Do not pass the `agent` argument " +
    "unless deliberately logging on another agent's behalf.\n\n" +
    "Other tools: second_brain_status (config status), " +
    "vault_health (verify vault), second_brain_query (look up notes), " +
    "second_brain_capture (add wiki pages)."
  );
}
