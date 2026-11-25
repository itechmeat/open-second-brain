# Topics

A topic is one readable place for one theme: knowledge from different sessions, machines and directories that belongs together, an initiative, a sub-project or a personal matter. A topic does not depend on projects: it may relate to one by meaning, and a record's project is only an attribute of it. Its page says where things stand (status and goal), what is planned (milestones), what was decided, what is still open, and the few events worth remembering. Agents keep it current; you read it, and you correct it when it is wrong.

This guide covers what a topic is, the page it gets in the human view, how to ask an agent for one, what the dream pass does on its own, and how to take any of that back. It assumes the brain store and the human view are set up (see [brain-store.md](brain-store.md)).

## What a topic is

- **An id that never changes.** A topic is identified by an id (a ULID such as `01KA3Z...`). Its title and the folder of its page are display values: renaming a topic changes them and keeps the id, so every record and every link still points at it.
- **A scope.** A topic carries one project (`project:<name>`) when its records name that one project, else the personal scope (no project). The scope is an attribute and a listing filter (`o2b topic list --scope`), never a condition: a record of any project, or of none, groups and routes by its theme. Agents see the topics of the project they work in, and other projects' topics only when they ask for them.
- **A status.** One of Active, Waiting, Blocked, On hold, Done (with the day it was resolved) and Closed.
- **Records, not a file.** Every change is a record in the brain store: a create, a rename, a status, a goal, a decision, an open question, a log entry, a milestone, an assignment of other material, a merge, a split, a link or an undo. Your records outweigh an agent's, and an agent's outweigh a decision model's, so a change you make is never overwritten by an automatic one. The record kinds are documented in the store's `FORMAT.md`.
- **Private by default when personal and made by hand.** A topic you or an agent create in the personal scope is written to the `private` partition unless you ask otherwise, and so is everything recorded on it later. A topic the dream pass makes is shared when its records are, private when they are private: shared and private records are grouped apart, so a private record never joins or shapes a shared topic. A private topic never appears in the human view, and a remote MCP caller never sees it.

## The page

The view writer renders every shared topic to `topics/<date>-<slug>/topic.md` in the view folder: the day the topic was created (a dream pass judged with `--now` files it under that day) and a short form of its title. The page has a fixed order:

1. the title and a one-line description (the goal stands in when there is no description; with neither, the line is left out);
2. the status line, for example `Status: Active`;
3. the goal, when the description is its own;
4. milestones: open ones first, done ones ticked with their day; a milestone an automatic check thinks is finished shows `looks done, confirm` and stays open until you or an agent with evidence marks it done;
5. decisions, newest first;
6. open questions, including a goal an agent proposed after you set yours;
7. rules and facts: the signals the topic holds, one line each with the day they happened and their text;
8. the log, newest first by the day each entry happened: corrections, decisions made outside the normal flow, blockers, reframings, rejected approaches (with the reason), your own notes, and the notes the topic holds;
9. related: the project, linked topics, topics merged into this one, the archive, and how many held records the page does not show (past the newest 30, or judged not readable by the history step) with `o2b topic show <topic> --held` to list them all.

A held record shows on the page only when nothing of it is private: a private note or signal, or one with a `<private>` region, never appears there. A line longer than 400 characters is cut at a word with an ellipsis.

Empty sections are left out. When a section grows past the page budget, its oldest done milestones, decisions and log entries move to `archive.md` in the same folder, with the resolved questions; open milestones and open questions always stay on the page.

Edit the page like any note. The view writer reads your edit before its next render and records it with your authority: a new title renames the topic, a status line sets the status, a reworded goal or item replaces it, a ticked or unticked milestone marks it done or open again, a deleted line removes the item, and a line you add under a section becomes a new item there. Your files in a topic folder move with it when the topic is renamed. A note tool (`brain_create_note`, `brain_update_note`) refuses to write a topic page and names the topic tool instead.

Research reports and source summaries get pages too, in `reports/` and `sources/`.

## Asking an agent

Ask in plain words: "start a topic for the move to the new flat with the goal of signing by March", "put this into the store topic", "rename it", "mark it done", "merge these two". The agent uses the `brain_topic` tool. What an agent writes carries its own authority, so it never outweighs what you wrote on the page or with a command: a goal it sets after yours shows as an open question on the page instead. When it acts on your explicit request it may mark the record as yours (`authority: "human"`); a remote MCP caller cannot. Commands you run (`o2b topic ...`) are stored as yours, except `o2b topic record`: it writes agent authority unless you add `--as-human`. An agent also records its own decisions, open questions and log entries on the topic it works on. After a merge two topics can hold an item of the same id; the agent then names the item's `owner`, which must be the topic or one merged into it and must hold that item, or nothing is written. Over a remote MCP transport every topic text the agent gets back, the scope included, is marked as agent-written text.

The same actions are CLI verbs. The guide's commands run as written in the test suite; `<topic>` stands for the id `create` printed and `<record>` for the record id the last command printed:

<!-- doc-test: topics -->
```sh
o2b topic create "Brain store" --scope project:o2b --goal "Move machine data out of the vault"
o2b topic list
o2b topic record <topic> decision --text "Keep one shard per device and month"
o2b topic record <topic> log-entry --text "Sync conflicts on pinned.md" --class blocker
o2b topic record <topic> milestone --text "Store core released" --as-human
o2b topic status <topic> waiting
o2b topic rename <topic> --title "Brain store and topics"
o2b topic show <topic>
o2b topic review
o2b topic undo <record>
o2b topic archive <topic>
```

`o2b topic --help` lists every verb: `assign` and `unassign` move a record in or out (`assign` takes the id of a note, a signal or a decision event, and refuses any other id, a lane entry or an id this machine has not seen, with the reason; it also refuses a signal that was removed or rejected, a signal while a shard that could hold its removal or rejection cannot be read or while a signal lifecycle record's body has not arrived on this machine (the held listing could not show it for certain then; both decide from the one read of the store that folds the signals, so a body that arrives during the check cannot pass a fold that never saw it), a signal capture whose id is not a non-empty string, a record with no text the held listing could show (an empty principle, a text wholly inside a `<private>` region), a record whose body has not arrived on this machine yet, and any assign while the brain store cannot be read to check the id), `merge <topic> --into <topic>` and `split <topic> --into <topic> --items <ids>` combine or separate topics (a split takes only items the topic shows, those of a topic merged into it included; when two merged topics hold an item of the same id, `--owner <topic>` names whose moves), `link <topic> --to <topic>` relates two, and `goal <topic> <goal>` sets the goal. Add `--json` to any verb for the full answer. The notes and signals a topic holds (its assigned records) are not items of its page: the page shows what is earned (decisions, open questions, milestones and the log entries an agent or you recorded on the topic), so routine material stays in the store. A decision it holds is the exception, since the agent named the kind itself: a decision recorded with `brain_decision` (or `o2b brain decision record`), and an open decision resolved there, shows as a decision item of the topic, with no decision model. The item names the decision's title with the option chosen (`Release page format: one markdown page`; a decision recorded before decision events carried their title is named by the title of its decision page, and by the words of the page's slug when this machine holds no such page, when the page is private and the event is not, or when the read could not hold every version of the page: a store shard read only in part, or a page version whose body has not arrived; `show` then says `decisions_incomplete: true`), and it survives your edit of the line like any item. The item is read from the held decision when the page is rendered or shown, so nothing is written for it: it shows `(resolved open decision)` when it closed an open decision and `(outcome: ...)` once an outcome is backfilled, it leaves the page when you undo the assignment or the topic, it stays off the view (and off a remote caller's `show`) when the decision is private, and a topic made earlier gains it at the next dream pass. While a log shard cannot be read, or one this machine read is gone, `show` says `decisions_incomplete: true`, since a decision of the topic may sit in it. It takes only the page slots the topic's recorded decisions leave, so it never pushes one of those to the archive. When a decision model already gave the topic an item for that decision, or you edited or deleted the line on the page (which records the item as yours), that item is shown instead, never both. Its related section says how many records the topic holds, and `o2b topic show <topic> --held` (`brain_topic` action `show` with `held: true`) lists each with its kind, day and text, leaving out a signal that was removed or rejected. A signal is shown with its text only when the store read that decides its state and privacy is complete: while an events shard cannot be read, one this machine read is gone, or a signal's move or removal is on this machine with a body that has not arrived (quarantined or not), each held signal is listed by id, kind and day with its text withheld and counted under `records_withheld` with the reason, and a caller below local reach gets a private signal the same way; that listing reads the store's signals and log, so it runs only on request. Agents read the topic page through the resource `osb://topic/{id}`, which shows the held count, the derived decision items and that command but not the records; an agent lists them with `brain_topic` action `show` and `held: true`.

## What dream does on its own

The dream pass plans topics on the view writer only, and two passes on one machine never create the same topic. Two machines can, in one case: when both claim the view writer role at about the same time and sync takes longer than the one catch-up a fresh claim waits, each may plan once before the other's claim arrives; the brief then proposes merging the two topics. Otherwise:

- **Routes** a new record to the active topic it clearly belongs to, whatever project either names: a note, a signal, or a decision recorded or resolved there, which is read as its title with the option chosen, so a decision whose choice alone shares no word with the topic still finds it. Only shared text decides: a private item, or a title, description or goal you set privately, never pulls a shared record into a topic. A `<private>` region inside a record is left out of everything the planner reads: its words never route or group a record, and never appear in a drafted title or goal.
- **Knows a record's project** from where it was written. A signal, note or decision an agent writes while it works in a project directory linked to the vault (`o2b brain project link`, which writes the `.o2b-vault.json` pointer) carries that project: an MCP server takes it from the directory it was started in, a CLI command from the directory it runs in, a hook from the working directory its host reports, and a hook or a session checkpoint also stamps the host's session id. The project is the name of the linked directory, keyed the way the scoped standing rules key it (lowercase, letters and digits of any script kept, so `café` and `cafe` are two projects), never its path: two machines group their records as one project only when each links a directory of the same name. A topic scope `project:<name>` is keyed the same way, so `o2b topic list --scope` and `o2b topic create --scope` take the name as the directory spells it. A caller of a remote MCP transport (an HTTP bind that is not loopback) gets no project, since the server's directory is not where that caller works; a loopback caller on the same machine is local and gets it. A record written anywhere else carries no project, never a guess; nor do records written before this release, the migrated history included. Such a record groups and routes like any other. `o2b status` (`store.topics`) says how many records no topic holds and how many of those name no project; a caller below local reach is given the counts of the shared records only.
- **Counts a repeated observation once.** A session capture that records the same observation again (the same topic, sign, principle and scope) is deduplicated across the whole vault, also when it comes from another project: the first project to capture it keeps it, and the repeat neither strengthens the preference twice nor joins the other project's topics.
- **Leaves out** the signals the regex fact extraction writes (`source_type: extracted`: URLs, quantities, addresses mined from a session turn): they are never grouped or routed, though you can assign one by hand.
- **Creates** a topic when enough related records that no topic holds (5 by default, the shared setting `topics.new_min_records`), of any project or of none, come from at least two sessions (`topics.new_min_sessions`, default 2). Records are related by their subject, not by the workflow words every project writes: a word more than one record in a hundred of the free records says (and more than twenty) is common, read from the records themselves in any language (`merged`, `branch`, `ready`, a busy project's name), and joins nothing. Each record's signature is its twenty rarest remaining words that another record says too, and a record joins the earliest group whose first record shares at least three of them (all of them when either has fewer, never fewer than two), else it starts a group. A group is judged by its first record, so it never drifts from theme to theme as it grows, and the grouping stays linear in the records for a brain of any size. A group whose core (the words half its records say) shares two words with an earlier group's core is folded into it, so one theme is proposed once. A note the history step hid (a machine log line, a test or a probe) is never grouped. A record's session is the `session` it names, else its `session_ref`, else the machine, agent and UTC day that wrote it. One busy session never makes a topic on its own. A record the store migration imported counts from when and where its legacy item was written (the log event's time, the signal's `created_at`, else the date in the legacy file name; the device of its legacy shard, else the migrating machine), not from the migration's moment, so its records keep the dates and sessions they were written in. A migrated record names no project and takes part like any other. Decisions count among those records, read as their title with the option chosen (an older event that carries no title, by its decision page's). When a pass creates no topic, its summary says why: the group of related records closest to a topic (the fewest records and sessions short of the thresholds, then the most records; how many notes, signals and decisions, from how many sessions) and how many more records or sessions a topic needs, how many groups that qualified wait for the dream agent's approval and wording, how many groups a decision model vetoed, and how many records are held back because a topic held them once (an undone topic or assignment: such records are routed to a fitting topic but never grouped again). Notes and signals an agent writes through MCP name no session, so those of one agent name on one machine on one day count as one session; a second agent name, another day, or records a hook or a session checkpoint stamped with the host's session id add one. The topic gets a drafted title and goal, which you can change; the title is its records' most frequent subject words, each as the records write it, so a name the records write with a hyphen (`Тема-три release checklist`) stays whole when the records write it inside that compound more often than the word alone and no part of it is already in the title.
- **Proposes** merges of two topics of one scope that look like one, and splits of a topic whose material falls into two groups. Nothing proposed is applied: the digest and the dream report list the proposal with the command that applies it.
- **Asks** about a topic that had no news for 30 days (`topics.quiet_days`): keep it, put it on hold, mark it done or close it. Its status does not change until you answer.

Every create and route is listed in the dream report with the command that undoes it; a pass run with `--config` names that file in the command.

### What a decision model may do here

With the decision-model uses on (see
[decision-models](decision-models.md)), the dream pass can refine what the
planner does on its own. Everything a model writes carries the model's
authority, which your records and an agent's records always beat, and you can
undo any topic record of it with `o2b topic undo <record>` like every
automatic write. A `human_readable` verdict is the exception: it is a
`history-verdict` record of the log, not a topic record, and that command
does not take it back:

- **Model routes.** A record the word-overlap rule would leave free can be
  assigned to a topic the model chose (`topic_route`); the assignment names
  the model and its confidence in a `verdict` field, and a route you took
  back is never taken again.
- **Derived items.** A record a topic holds can gain the item it describes -
  a decision, an open question or a log entry - with the model's kind choice
  (`event_kind`). The item names the record it came from in its `source`
  field.
- **Model proposals.** A milestone the model thinks is done shows `looks
  done, confirm` and stays open until you or an agent with evidence marks it
  (`milestone_done`); an open question a model thinks a record answers shows
  as "looks answered" until you confirm it (`question_resolved`); merge
  proposals the model adds appear in the dream report next to the Jaccard
  ones, with their confidence (`topic_same`). A model never merges,
  splits, closes or completes anything on its own.
- **A model can also say no:** a topic creation it does not believe in is
  skipped for that pass (`topic_new`), and a note it does not think belongs
  in your weekly history is hidden from that page (`human_readable`, stored
  as a `history-verdict` record; a note it keeps is stored as kept, so it
  is not asked about again). Other answers that change nothing are
  remembered on the machine that runs the dream, so the same record is
  not asked twice and older records get their turn.

## Undo

`o2b topic undo <record>` takes back one record: an automatic route, a created topic, a decision, a completion. The undo is a record, synced like every other, so every machine honours it, and the dream pass never routes that material to that topic again or recreates a topic you undid. The same holds when an agent undoes a route or takes a record out of a topic for you through `brain_topic`, from this machine or over a remote MCP transport; there your request is stored as the agent's record, since a remote caller cannot write as you, and it still blocks the route. Undoing an undo brings the record back; an undo of a private topic's record stays private, like the topic.
