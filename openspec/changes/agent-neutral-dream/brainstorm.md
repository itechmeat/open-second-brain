# Brainstorm

## Problem

Dream, the pass that turns signals into preferences and keeps topics, has no owner in the product: nothing starts it, the guides tell the reader to hang it on a Hermes cron job, and several surfaces treat Hermes as the agent every installation has. Version 2.0 must make dream belong to the agent the user chose (by default the one that created the brain), start it without any external scheduler, let the chosen agent's model do the judgment and wording work inside it, and remove every advantage Hermes has over other agents without breaking what is specific to Hermes.

## Related work

1. `openspec/changes/brain-store-and-topics` (in flight, its phases merged without a release): it introduced the dream-time decide pass (`src/core/topics/decide*.ts`), the view writer role and its request, release and take handoff (`src/core/view/writer.ts`), and the store-only machine. This change builds on all three and must not move the view writer.
2. Open pull requests at the time of writing touch locks on Windows, the search index swap and title slugs. None touches dream ownership, triggers or the Hermes surfaces. The lock classifier in `src/core/fs-lock.ts` is the lock primitive this change reuses.
3. No other change under `openspec/changes/` and no recent commit touches `primary_agent`, the cron recipes or `src/cli/discipline-install.ts`.

## Doubts

Put to the partner in the first round:

1. What "dream is run by the chosen agent" should mean when the pass is a deterministic pipeline.
2. Who starts dream, on Linux, macOS and Windows, for an agent that has no scheduler of its own, and what happens when the chosen agent is absent for days or two machines both believe they own the pass.
3. Every place where Hermes holds an advantage, and which of them are legitimate adapter features.
4. What "an ordinary agent" means for a repository whose root is the Hermes plugin.
5. What breaks for an installation whose dream runs today from a Hermes cron entry.
6. Which wrong implementations would pass obvious acceptance tests.

Put to the partner in the second round, after the owner's decisions: the cheapest correct daily trigger, the trigger firing on a machine that is not the owner, what a gap of weeks does to the pass, the contract of the launched agent, a queue whose head is stuck, the cost of a large backlog, and whether any memory figure is a release gate.

## Approaches considered

### What the code says today

1. A live dream can already call a model. The decide pass asks a decision model closed questions (topic routing, a new topic, same topic, event kind, milestone done, question resolved) before the synchronous pass, only on the view writer, off by default, and every failure falls back to the deterministic rule. The rollup ladder can emit a `needs-llm-step` envelope for the calling agent (`src/core/brain/llm-step.ts`), but nothing reliably brings an answer back. (Found by the partner; the author's brief had said no model call exists.)
2. `primary_agent` is advisory. It has two storage paths (the legacy `_brain.yaml` and the shared store setting), a run by another agent only warns, and the maintenance lane calls `dream()` without an agent name, so a scheduled run can miss even the warning. An agent cannot overwrite a value a human set, so "change the owner through a prompt" works once and fails the second time. (Partner.)
3. Nothing in the product starts a recurring dream. The recipes print a script, a crontab line, a systemd timer and a `hermes cron create` line. Session start and the MCP server start already spawn a detached, bounded post-upgrade worker (`hooks/active-inject.ts`, `src/core/maintenance/`). (Author and partner.)
4. The maintenance lease lives in a device-local database on a switched machine, so two machines can both hold it. (Partner.)

### Ownership

1. Author: reuse `primary_agent` as the owner and make the gate hard.
2. Partner: bind the owner to one enrolled installation (brain, device, runtime and profile, with a revision), not to an agent name, because a name, a host name or a caller-supplied `--agent` proves nothing about which installation acts; transfer through one operation shared by the command line and MCP; across machines an acknowledged handoff in the request, release and take pattern the view writer already uses; never elect a replacement silently.
3. Owner: one specific installation on one machine, any supported agent, with an ordered fallback list for the model work on the same machine when the first agent cannot work (limits spent, logged out).

### Trigger

1. Partner: session catch-up plus an optional per-user operating system schedule (systemd user timer, LaunchAgent, Task Scheduler), one daily due pass, every backend waking the same one-shot command.
2. Owner: no operating system scheduler at all. The first agent session of the day with Open Second Brain connected starts dream, through a script of the product (session start hook, MCP server start), not through the agent's reasoning. Once the day is done the check must cost almost nothing.
3. Author: the existing detached post-upgrade worker is the precedent; the check is one read of a small machine-local state file.

### Model participation

1. Partner: ship ownership and triggering only; defer any new requirement that the chosen agent's model takes part. If it is in scope, the smallest honest step is one optional review in the chosen agent's next live session through the existing `needs-llm-step` envelope, producing a draft.
2. Owner: the model takes part from the first version. A user with no model is not a user of this product, so the deterministic rule no longer stands in for the model; when the model is unavailable the work waits and the next run processes everything that accumulated. Text work never goes through a model API key and never into an open interactive session (several are open at once and their context must stay clean): the dream worker launches the agent from the command line as a separate short session.
3. Owner and author: decision models stay as an optional accelerator for closed questions; without a key the launched agent answers them too. First setup asks whether the user has such a key, because a key for a hosted route cannot be discovered from the machine.

### Hermes

The partner's inventory, checked against the code, sorts the surfaces into three groups:

1. Remove or neutralise: the `hermes cron create` line and the `hermesSchedule` naming in the shared recipe renderer; the native maintenance and reindex scripts sourcing `$HOME/.hermes/.env`; the embeddings skill and the indexer diagnostic naming Hermes as the owner of the key; the uninstall plan that always prints Hermes steps; `o2b discipline install` writing the Hermes jobs file with a Telegram target, and the Telegram MarkdownV2 renderer; the managed writeback block telling other agents not to run dream; the Hermes install guide designating that installation as primary.
2. Generalise: dream ownership and its status in doctor; the identity reminder as a guarantee with host-specific delivery; foreign-directory protection in uninstall for every target.
3. Keep as the Hermes adapter: the memory provider, the host memory bridge, profile isolation, capture and pre-compression hooks, the manifest and resolver parity checks under `--repo`, and the repository root as the Git install entry (`plugin.yaml`, `__init__.py`, `cli.py` are forwarding shims; the implementation is already in `plugins/hermes`).

## Decision

One change, several pull requests, shipped as 2.0. Decisions marked (owner) are product decisions of the owner; the rest follow from them and from the code.

### Owner and fallback

1. Each brain has one dream owner: one enrolled agent installation on one machine (owner). The default is the installation that created the brain; a brain created from a bare terminal asks once or stays "owner not chosen" with dream inactive.
2. The owner record keeps the compatible public name `primary_agent` and gains the device and enrollment binding and a revision. It is a shared setting; everything machine-local (paths, launch commands, the fallback order) stays in the machine config.
3. Transfer is one operation reachable from the command line and from MCP, so "let agent X on this machine run dream" works every time. Across machines it is the acknowledged request, release and take handoff. There is no automatic takeover.
4. The owner machine holds an ordered list of agents for the model work (owner). The first that can be launched and answers does the work; a failed launch (limits, logged out, missing binary) moves to the next.
5. Every live dream path passes one gate: the direct verb, the MCP tool, staged apply, the mutating steps and the maintenance lane's dream task. A machine that is not the owner previews but does not write. The gate is checked before model preparation and before the early repair writes.

### Trigger

1. No operating system scheduler and no resident process (owner). The recipes for cron and systemd stay as printed text for operators who want them; the product installs none.
2. One shared check runs at session entry: on the session start hook where the adapter has a real one, and on a successful MCP `initialize` for clients without a hook (partner: the start of a long-lived MCP server would miss every later day, so the check belongs to the session, not to the server). One entry point per adapter; probes and sessions launched by dream itself are excluded; a brain with no vault is included.
3. The check reads one small machine-local record per brain: the owner revision and whether this installation is eligible, the configured time zone, the claimed civil date, the outcome and a retry-after time. When the record says the claimed day is closed, or that this machine is not the owner, the check returns; its whole cost is that read and a comparison, with no database opened, no process started and no model asked.
4. When a pass is due the check takes a non-blocking exclusive claim before it spawns anything, rechecks under the claim and hands the claim to the detached one-shot worker (partner; the existing post-upgrade worker claims before it spawns in the same way). An abandoned claim is recovered, and a stale worker is fenced when it tries to commit.
5. A day stamp and coverage are two different facts (partner). The stamp only stops another launch today. Coverage is the boundary up to which every input has been processed, and it advances only after the outcomes are durable. Completion, or verified empty work, up to the run's frozen input boundary closes the claimed day, even when the run crosses midnight. Failure, a model that is not available, an incomplete read and a spent budget leave coverage open and set a retry-after with bounded backoff, so later session starts do not hammer a broken pass.
6. A gap is replayed, not skipped (owner: no period is left unprocessed; partner: a single scan of the current state is not enough). Today's pass excludes expired signals, archives evidence outside the contradiction window, judges trial expiry and staleness against the present moment and asks about topics newest first inside an eight-week window, so after weeks away one scan could archive evidence before considering the promotion it once qualified for. The pass therefore keeps a position per source, replays the missed windows oldest first with the evidence available at each boundary, reconciles records that synced late, and revalidates against the current state before it applies. Catching up may take several session starts. The digest shown afterwards covers the interval that was really processed. Acceptance compares daily runs with a replay over several weeks, including late sync, expiry and a crash in the middle: same outcomes, no gap, no duplicate effect.
7. Any connected agent on the owner machine may wake the owner's worker. Other machines stay silent, except for one cached line when the owner has been silent for three days: the last success and how to transfer.
8. An existing large brain does not start its coverage at the moment of the update, which would silently drop its history: the retained history is inventoried in resumable pages, the initial boundary is frozen, and history that is missing is reported.

### Model work

1. The deterministic pipeline stays the frame and does everything that needs no judgment.
2. Closed questions go to the decision model chain when one is configured, otherwise to the launched agent (owner). The rule no longer decides them: an unanswered question waits in a durable queue.
3. Text work (wording a rule from several signals, merging two rules, a topic summary) goes only to the launched agent (owner): never an API key, never an open session.
4. The launch command is a line in the machine config, filled in for known agents and adjustable at setup (owner). It is never a shared, synced setting, because a synced command would run on another machine.
5. The launched session receives a fixed short task and three operations through MCP: take, answer, finish. Take leases the oldest item with bounded evidence and an answer schema. Answer checks the lease, the owner revision, the hash of the input, the prompt version and the allowed values or text constraints, commits idempotently, and requeues an item whose input changed. Finish releases the leases; the worker, not the agent, decides that the pass is complete. Each answer records the agent and the model that really produced it.
   The launched session is isolated (partner): a credential scoped to the run, a profile with only the queue surface, no shell, no file tools, no other connectors, and its own startup hooks and capture suppressed before initialization. A marker in its environment prevents recursion but grants nothing. An adapter that cannot enforce the isolation is treated like an agent with no command-line mode. The privacy and egress checks that guard decision models apply to every executor, because a local command can front a hosted model.
6. A pass has a budget of items, time and tokens across all fallback attempts. Every accepted answer is persisted at once; the remaining count and the age of the oldest item are visible. A large backlog drains across passes, oldest first, so the order of the replay is kept.
7. An item that fails repeatedly is retried with backoff and then named, with its reason and the retry action, in doctor and the session start note. It is never decided by the rule. Deterministic work and model work that do not depend on it continue; model work that is ordered after it (the same record chain or topic) waits behind it with its completion cursor (the author first had every later item proceed; the partner pointed out that ordered work must not overtake it).
8. Text written by a model is stored as a draft with its author recorded; applying drafts automatically is a setting (owner).
9. An agent with no command-line mode can be the owner. Its model work goes to the next agent in the list, or waits for an explicit request by the user in a session.
10. First setup verifies the launch command with a real short call and asks about a decision model key (owner). A brain whose model path was never verified reports it in doctor and at session start instead of running silently without judgment.

### Hermes as an ordinary agent

1. Everything in group 1 of the inventory is removed or neutralised; group 2 is generalised; group 3 stays.
2. The digest of a dream pass is shown by the agent at the next session start. The discipline check moves into doctor and a session start note. `o2b brain digest` and `o2b discipline report` stay plain commands with neutral output. The Hermes cron installer and the Telegram format are removed (owner).
3. The repository root stays installable by Hermes. The boundary is tested the other way round: a machine with no Hermes, no Python and no Telegram creates a brain, becomes the owner, runs dream with model work, sees the digest, transfers ownership and uninstalls.

### Update of an existing installation

1. A brain with an explicit `primary_agent` keeps it as the requested owner; a brain without one is "owner not chosen" and its existing external trigger keeps working until the user adopts the new scheme. Ownership is never inferred from an installed Hermes directory or from the last writer in the log.
2. Adoption names the old job it found, binds the owner to this installation, verifies the launch command, and from then on a run from the old external job is refused by the gate with a message that says how to remove it.

### Memory

No memory ceiling is a release gate (owner). The peak of a cold changed pass is measured after implementation on a reproducible synthetic store and published.

### Pull requests, in order

The partner's order after the owner's decisions; triggering is enabled last, when everything it starts is in place.

1. Ownership and adoption: owner identity, creation, status, the transfer operation, the single gate on every live path, adoption of 1.x installations. Evidence: a transfer raced against the command line, MCP, staged apply, maintenance and a legacy cron invocation; only the current enrollment commits.
2. Replay and queue: per-source positions, oldest-first replay, the durable model queue. Evidence: daily runs compared with a replay over several weeks, with late sync, expiry and crash recovery; no gap and no duplicate effect.
3. Executors and drafts: the launch command, the launched-agent surface and its isolation, the fallback list, decision models as the first executor for closed questions, drafts with provenance, setup questions. Topic judgment moves from the view writer to the dream owner while the view writer role stays separate. Evidence: setup with and without a decision model key, fallback, a stale answer, isolation, draft provenance.
4. Triggering: the session entry check and the one-shot worker. Evidence: simultaneous starts, the winner killed, midnight and a daylight saving change, a persistent MCP server, a brain with no vault, and the measured cost of the closed-day path.
5. Hermes parity, digest and discipline, the no-Hermes end-to-end journey, measurement, then the 2.0 documentation and release. Evidence: the digest delivered once at the next session start, doctor reporting, a full installation with no Hermes, no Telegram and no scheduler, and the published peak memory of a cold pass and of a backlog pass, child processes included, with corpus size and platform.

## Rejected

1. Ownership and triggering only, model work deferred (partner): the owner wants the model in the first version.
2. Model work in an open interactive session (author, and the partner's smallest step): it pollutes the context of sessions the user works in, and several open sessions would race.
3. Text work through a chat model API key: it is not the chosen agent, and it needs a key and money.
4. An operating system schedule installed by the product (partner): the owner considers it overkill; the first session of the day is enough.
5. Dream that refuses to run when no model is configured at all, with no setup path: replaced by verified setup, since every user has an agent.
6. The deterministic rule as the fallback when the model fails: the owner prefers a late right answer to an early wrong one.
7. Automatic election of a new owner after a silence: two machines that sync late could both write.
8. Moving the Hermes plugin out of the repository root: it changes the install address and the update channel and gives no other agent anything.
9. Removing the discipline report: a silently broken integration would go unnoticed again.
10. A fixed memory ceiling as a release gate: the owner set none.

## Open questions

None for the owner at this point.

## Process

The partner was an agent of a different model family than the author, run read-only against main, at its highest reasoning setting, in two rounds. Round one was written before the owner's decisions and argued for ownership and triggering only; its findings about the code and its Hermes inventory are used above, and its recommendation on model participation and on an operating system schedule was overruled by the owner. Round two took the owner's decisions as binding and attacked the design that follows from them. It changed four things: the check moved from the MCP server start to the session entry; the day stamp was separated from coverage; a gap is replayed oldest first instead of scanned once; and the launched agent gets an isolated profile rather than only an environment marker. One disagreement was settled by the author: what waits behind a stuck item (only the work ordered after it). The owner took part between the rounds and made the product decisions marked above. Nothing was measured: the memory and timing figures are to be taken after implementation.
