# Decision-model uses for topics and agent context

The nine uses the brain store and topics work added to the decision-model
framework (design D10). Each refines a deterministic result - the topic
planner, the session start digest, the neighbour lane - and keeps that result
on every failure, invalid answer or withheld record. What an answer below
its threshold does depends on the use: for `topic_route`, `event_kind`,
`topic_same`, `question_resolved` and `milestone_done` it acts on nothing
and the deterministic result stands; in `enforce`, a `human_readable`
answer below `hide_below` hides the note, a `topic_new` answer below
`veto_below` vetoes the creation for that pass, a `head_select` answer
below `drop_below` drops the head, and a `neighbour_relevant` answer below
`inject_min` leaves the update out (the sections below give each rule).
Each is `off` until `decision_model_uses` names it, and each runs
`shadow` first: none of them is covered by the shipped `jev-1.13` baseline,
so `enforce` needs a thresholds-store entry for the answering model, and
the value stored there is the threshold the use applies (see
[the main page](../decision-models.md#shadow-first-then-enforce)).

Shared mechanics:

- **Where the dream-time uses run.** The seven dream-time uses
  (`topic_route`, `event_kind`, `human_readable`, `topic_new`, `topic_same`,
  `question_resolved`, `milestone_done`) are closed questions on the dream
  work queue: every live pass on the dream owner's device produces one item
  per eligible subject, oldest first, with no age limit and no limit per
  pass, and the decision model chain answers ready items one per request
  before the synchronous dream pass, within `dream.model_budget_ms`. Topic
  planning, on the same device, applies an accepted answer only where its
  subject still matches the fold it read under the planning lock, and marks
  the item applied with the records it wrote. A question with no accepted
  answer waits: no fixed rule decides it (see [the main
  page](../decision-models.md#without-a-model-the-closed-questions-wait)).
  Every machine folds the stored records, so one machine deciding keeps
  every machine's fold equal.
- **Where the hook-time uses run.** `head_select` runs in the SessionStart
  digest; `neighbour_relevant` runs in the neighbour-updates hook before a
  turn. Both get `min(decision_model_hook_budget_ms, the hook's remaining
  budget)`, enforced again around the call, and the wait ends by half of
  the hook's time ceiling, so a provider that never answers leaves the
  hook time to show its deterministic result.
- **Each question names its record.** A request carries one item's
  question, and it names its own field: `route_<k>`,
  `kind_<k>`, `history_<k>` and `matters_<k>` name `records.R<k>`,
  `relevant_<k>` names `topics.T<k>`, a `topic_same` pair names `pairs.A<i>`
  and `pairs.B<i>`. The stored `version` of the eight uses whose questions
  changed this way is 2.
- **Thresholds.** Each use compares its answer against the value stored in
  the thresholds store for the model that answered and the use (the
  vault's override first), and against the built-in default below when
  nothing is stored. A fallback chain entry without tuned thresholds
  answers as `shadow` and acts on nothing; a stored verdict names the
  provider that answered. A stored value outside 0..1 (only a hand edit or
  a damaged file can produce one) is ignored for the built-in default.
- **What a pass asks about, and its budget.** The dream-time uses ask
  about records from the last eight ISO weeks, newest first, so a new
  record is never queued behind older ones, and a record dated after the
  run (a device with a fast clock) comes after every present one, as
  does a milestone's evidence record and a history note; at most
  50 subjects per use and pass. A kept history note is stored as kept and
  never asked about again. Any other answer that writes nothing (a routine
  kind, a `none` resolution, a milestone not done, an answer below its
  threshold, every `shadow` answer) goes into a device-local asked set
  beside the store's other device-local state, keyed by use, subject,
  question version, answering model and mode, and kept for the eight-week
  window: the next pass asks the subjects not yet asked, so older records
  get their turn. A new question version or another model asks again, and
  an answer given in `shadow` is asked again once the use is in `enforce`.
  An enforce `none` route is kept with its verdict and applied again
  without asking. `topic_new` keeps no asked entry: a group is asked about
  again on every pass while it qualifies, so a veto lasts that pass only,
  and `human_readable` relies on the stored verdict alone. The pass has 20
  seconds, and each use gets an even share of what is left when it starts
  (`topic_same` checks it before each batch of pairs), so a long queue of
  one use never leaves the later uses without a request. A request gets
  `decision_model_timeout_ms` or what is left of its use's share,
  whichever is less, so no request runs past the pass, and no request
  starts when that time is less than 250 ms: a request that could not
  finish might still be billed. The same 250 ms hold for the two
  hook-time uses against the time their request gets, the smaller of
  `decision_model_hook_budget_ms` and what is left of the hook. The time
  spent preparing a request counts, and with a provider chain
  (`decision_model_providers`) the 250 ms hold for each provider asked:
  the chain splits the request's time evenly, and a provider whose share
  would be less is not asked, its time going to the providers before it. A question's or
  milestone's text counts toward `decision_model_max_state_tokens` beside
  the records it is sent with.
- **Private records stay local.** A private record, private topic, private
  head field or private item is sent to a hosted provider only when you
  opted the use in through `decision_model_private_uses`; a loopback chain
  needs no opt-in. `<private>` regions never leave in any case: they are
  stripped from every text a request carries, the topic titles,
  descriptions, goals, question and milestone texts and drafted titles
  beside the records included. The planner reads every record with its
  regions removed before it groups or routes it, so a word that appears
  only inside a region never reaches a drafted title or goal, a derived
  item or a request. A per-pass cap counts only what may leave: what
  stays local is left out before the cap, so the shareable records,
  topics, groups, pairs and heads behind it are still asked, and a
  subject left out this way is not named in the `decision_model_call`
  record. A subject a request withholds is written there as `(withheld)`.
- **A record derived from private input is private.** A record a use
  writes lands in `private` when any input of its question was private:
  the record, its topic, an offered topic or question, an evidence record,
  a head field, or a `<private>` region in any of them. A request that
  batches several records (`topic_route`, `event_kind`) sends every one
  of them, with every topic offered to any of them, to each answer, so
  all of them count for every record it writes. A private head field the
  egress rule withholds is never sent and does not count. No shared record
  carries text taken from a private input, and a history note with a
  `<private>` region is not asked about.
- **Where a verdict is stored.** A use that decided a store record in
  `enforce` stores a `verdict` field on that record: `{ use, model,
  provider, version, mode: "enforce", confidence }` - identifiers and
  numbers only. A `shadow` verdict is recorded in the `decision_model_call`
  accounting record only and has no effect. The two hook-time uses write no
  store record at all.

---

## topic_route

- **When it runs:** as one queue item per record no topic holds that a
  topic's head words fit.
- **What it sends:** one `choice` question per record (`route_<k>`, naming
  `records.R<k>`), the
  options the record's scope's active topics - the deterministic best first,
  then by shared-word count, then by creation, at most 20 - plus `none`; the
  state carries the records and the topic heads (title, description, goal,
  each clipped to 300 characters). Text clips at 900 characters per record.
- **Threshold:** `route_min`, default `0.6`.
- **Fallback:** none, no fixed rule answers; the record stays unassigned. The word-overlap
  ranking of the planner (at least two shared subject words and a fifth of
  the record's words) only builds the options.
- **What `enforce` changes:** the chosen topic at or above the threshold
  becomes an `assign` with `authority: "model"` and the verdict; `none` at
  or above it leaves the record free for grouping, in later passes too;
  below the threshold the item is abstained and nothing is written. A blocked route
  is never taken, whatever the model says.
- **Where its verdict is stored:** on the `assign` record.

## event_kind

- **When it runs:** as one queue item per record a topic holds that has no
  derived item yet.
- **What it sends:** one `choice` question per record (`kind_<k>`, naming
  `records.R<k>`); the
  options are `decision`, `open_question`, `correction`, `blocker`,
  `reframing`, `rejected`, `routine`; the state carries each record beside
  its topic's title.
- **Threshold:** `kind_min`, default `0.7`.
- **Fallback:** none, no fixed rule answers; no page item; the item waits. A routine answer or
  one below the threshold abstains and writes nothing.
- **What `enforce` changes:** a non-routine answer at or above the threshold
  derives one item record on the holding topic - `authority: "model"`, the
  `verdict`, `source: <record id>`, the item id equal to the record id (which
  makes a second pass write nothing) - as a `decision`, an `open-question`,
  or a `log-entry` with that class.
- **Where its verdict is stored:** on the derived item record.

## human_readable

- **When it runs:** as one queue item per `note` log event of `shared` that
  has no stored `history-verdict`, of any age, oldest first (a note dated
  after the run after every present one).
- **What it sends:** one `noul` question per note (`history_<k>`, naming
  `records.R<k>`): would the person want this note in their weekly history.
- **Threshold:** `hide_below`, default `0.3`.
- **Fallback:** none, no fixed rule answers; every note is shown; the item waits. The question
  never abstains.
- **What `enforce` changes:** p(yes) below the threshold writes a
  `history-verdict` record (`authority: "model"`, `keep: false`) on the
  `log` stream of `shared`, and the weekly history page leaves that note
  out; at or above it the record says `keep: true`, the note stays on the
  page and is never asked about again. A note is asked once: a second pass
  finds its item answered and asks nothing.
  Decisions and confirmed rules are never asked about and never hidden.
- **Where its verdict is stored:** on the `history-verdict` record.

## topic_new

- **When it runs:** as one queue item per group that qualifies by the
  count and session thresholds, keyed by its members.
- **What it sends:** one `noul` question per group (`new_<k>`), one group
  per request: do the records in `groups` describe one recurring subject
  that deserves its own topic; the state carries the drafted title and up
  to 10 member texts (300 characters each). The title is drafted from
  every member's words, so it is sent blank when any member of the group,
  shown or not, may not leave the machine.
- **Threshold:** `veto_below`, default `0.3`.
- **Fallback:** none, no fixed rule answers; the group is not created; the item waits. The
  question never abstains.
- **What `enforce` changes:** p(yes) below the threshold vetoes the creation
  while the group keeps its members (a changed group is asked again); at or
  above it the approval
  rides the `topic-create` record as its `verdict` (the create keeps
  `authority: "agent"`). The model can never create a group that does not
  qualify.
- **Where its verdict is stored:** on the `topic-create` record.

## topic_same

- **When it runs:** as one queue item per pair of active topics of one
  scope whose head tokens share at least 0.2 Jaccard.
- **What it sends:** one `choice` question per pair (`same` / `different`,
  naming `pairs.A<i>` and `pairs.B<i>`), the two topic heads clipped to 300
  characters each.
- **Threshold:** `same_min`, default `0.7`.
- **Fallback:** the Jaccard merge proposals of the planner (0.5 Jaccard), which are
  proposals only; the item waits.
- **What `enforce` changes:** only an answer whose chain entry held
  `enforce` acts. `same` at or above the threshold adds the pair
  to the dream report's merge proposals with its confidence; `different` at
  or above it lists a Jaccard proposal last with its verdict, never removes
  it. Nothing is ever merged.
- **Where its verdict is stored:** on the answered queue item; the dream
  report and the topic review read the hint from the queue in every later
  pass.

## question_resolved

- **When it runs:** as one queue item per record held by a topic that has
  open questions, the record newer than the question.
- **What it sends:** one `choice` question per record (`answers_<k>`, naming
  `records.R<k>`); the
  options are that topic's open questions without a pending proposal, plus
  `none`; the state carries the record beside the question texts.
- **Threshold:** `resolved_min`, default `0.7`.
- **Fallback:** none, no fixed rule answers; no proposal; the item waits. `none` or an answer
  below the threshold abstains.
- **What `enforce` changes:** the chosen question at or above the threshold
  writes a `question-resolved` record with `authority: "model"` and the
  verdict; the fold shows it as "looks answered" and the question stays open
  for a person to confirm.
- **Where its verdict is stored:** on the `question-resolved` record.

## milestone_done

- **When it runs:** as one queue item per open milestone of a topic with
  held records newer than the milestone; a new held record changes its
  input, so it is asked again.
- **What it sends:** one `noul` question per milestone (`done_<k>`, naming
  `milestones.M<k>`); the
  state carries the milestone text and up to 5 of the newest held record
  texts.
- **Threshold:** `done_min`, default `0.8`.
- **Fallback:** none, no fixed rule answers; no proposal; the item waits. An answer below the
  threshold abstains.
- **What `enforce` changes:** p(yes) at or above the threshold writes a
  `milestone-done` record with `authority: "model"` and the verdict, never
  with `evidence`; the page shows "looks done, confirm" and the milestone
  stays open.
- **Where its verdict is stored:** on the `milestone-done` record.

## head_select

- **When it runs:** in the SessionStart digest, over the candidate topic
  heads of the session's project scope.
- **What it sends:** one `noul` question per head (`relevant_<k>`, naming
  `topics.T<k>`); the state carries `project`, `branch` (from the
  workspace's `.git/HEAD` when present) and the heads (title, description
  and goal; a private head field is blank, a private topic is withheld).
- **Threshold:** `drop_below`, default `0.1`.
- **Fallback:** recency and scope ranking - topics of the session's project
  scope only, by last update, then by id.
- **What `enforce` changes:** the heads are ordered by p(yes) descending
  (the fallback order on ties), and the heads below the threshold are left
  out and counted in the digest's cut line; a head without a valid answer
  keeps its fallback place after the scored ones. The use never adds a
  head outside the candidate set.
- **Where its verdict is stored:** in the `decision_model_call` record only.

## neighbour_relevant

- **When it runs:** in the neighbour-updates hook, before a turn, over the
  candidate records appended to the store's topics shards since the last
  turn, read past a per-session cursor without the index (stream
  `topics`, the neighbour kinds; the newest
  2000, the older ones of every topic and project counted in one line
  that names the `brain_changes` call listing them among every record
  since): filtered by the topics this session works on
  and its project first, then the newest 20 (the ones the cap removes are
  counted in the cut line). A routine log entry and this session's own
  records are never candidates (a record stamped with this session, or an
  unstamped one of this device and agent name; another session of the same
  agent name is a neighbour), and an item a model derived from an own
  record is never returned to it; one derived from a neighbour's record is named as
  model-derived.
- **What it sends:** one `noul` question per record (`matters_<k>`, naming
  `records.R<k>`); the state carries the prompt (its `<private>` regions
  stripped, cut to 2000 characters) and each record beside its topic title
  and kind (text cut to 300 characters). A private record, a record of a
  private topic and a private item are withheld, and a private title is
  sent blank.
- **Threshold:** `inject_min`, default `0.5`.
- **Fallback:** the deterministic gate - topic this session works on and
  kind `decision`.
- **What `enforce` changes:** the candidates judged at or above the
  threshold are injected (at most 5 lines and 800 characters, the cut line
  included in the 800, one heading per topic naming the `brain_topic` call
  that opens it, the texts cut to share what is left, at least 60
  characters each; when no update line fits, or none passes the gate
  but the candidate cap removed some, the cut line alone names them);
  candidates
  judged below it are not, the deterministic ones included. A candidate the
  model did not judge - withheld as private, cut to fit the state budget,
  or with an invalid answer - keeps the deterministic gate, so a private
  decision on the session's topic is shown as it is with the use off.
- **Where its verdict is stored:** in the `decision_model_call` record only.
