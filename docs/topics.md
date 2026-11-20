# Topics

A topic is one readable place for one area of work: an initiative, a project, a sub-project or a personal matter. Its page says where things stand (status and goal), what is planned (milestones), what was decided, what is still open, and the few events worth remembering. Agents keep it current; you read it, and you correct it when it is wrong.

This guide covers what a topic is, the page it gets in the human view, how to ask an agent for one, what the dream pass does on its own, and how to take any of that back. It assumes the brain store and the human view are set up (see [brain-store.md](brain-store.md)).

## What a topic is

- **An id that never changes.** A topic is identified by an id (a ULID such as `01KA3Z...`). Its title and the folder of its page are display values: renaming a topic changes them and keeps the id, so every record and every link still points at it.
- **A scope.** A topic belongs to one project (`project:<name>`) or to the personal scope. Agents see the topics of the project they work in, and other projects' topics only when they ask for them.
- **A status.** One of Active, Waiting, Blocked, On hold, Done (with the day it was resolved) and Closed.
- **Records, not a file.** Every change is a record in the brain store: a create, a rename, a status, a goal, a decision, an open question, a log entry, a milestone, an assignment of other material, a merge, a split, a link or an undo. Your records outweigh an agent's, and an agent's outweigh a decision model's, so a change you make is never overwritten by an automatic one. The record kinds are documented in the store's `FORMAT.md`.
- **Private by default when personal.** A topic in the personal scope is written to the `private` partition unless you ask otherwise, and so is everything recorded on it later. A private topic never appears in the human view, and a remote MCP caller never sees it.

## The page

The view writer renders every shared topic to `topics/<date>-<slug>/topic.md` in the view folder: the day the topic was created and a short form of its title. The page has a fixed order:

1. the title and a one-line description;
2. the status line, for example `Status: Active`;
3. the goal;
4. milestones: open ones first, done ones ticked with their day; a milestone an automatic check thinks is finished shows `looks done, confirm` and stays open until you or an agent with evidence marks it done;
5. decisions, newest first;
6. open questions, including a goal an agent proposed after you set yours;
7. the log, newest first: only corrections, decisions made outside the normal flow, blockers, reframings, rejected approaches (with the reason) and your own notes; routine progress stays in the store;
8. related: the scope, linked topics, topics merged into this one, and the archive.

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

`o2b topic --help` lists every verb: `assign` and `unassign` move a record in or out, `merge <topic> --into <topic>` and `split <topic> --into <topic> --items <ids>` combine or separate topics (a split takes only items the topic shows, those of a topic merged into it included; when two merged topics hold an item of the same id, `--owner <topic>` names whose moves), `link <topic> --to <topic>` relates two, and `goal <topic> <goal>` sets the goal. Add `--json` to any verb for the full answer. The notes, signals and decisions a topic holds (its assigned records) are not items of its page: the page shows what is earned (decisions, open questions, milestones and the log entries an agent or you recorded on the topic), so routine material stays in the store. Its related section says how many records the topic holds, and `o2b topic show <topic> --held` (`brain_topic` action `show` with `held: true`) lists each with its kind, day and text, leaving out a signal that was removed or rejected. A signal is shown with its text only when the store read that decides its state and privacy is complete: while an events shard cannot be read, or one this machine read is gone, each held signal is listed by id, kind and day with its text withheld and counted under `records_withheld` with the reason, and a caller below local reach gets a private signal the same way; that listing reads the store's signals and log, so it runs only on request. Agents read the topic page through the resource `osb://topic/{id}`, which shows the held count and that command but not the records; an agent lists them with `brain_topic` action `show` and `held: true`.

## What dream does on its own

The dream pass plans topics on the view writer only, and two passes on one machine never create the same topic. Two machines can, in one case: when both claim the view writer role at about the same time and sync takes longer than the one catch-up a fresh claim waits, each may plan once before the other's claim arrives; the brief then proposes merging the two topics. Otherwise:

- **Routes** a new record of a project to the active topic of that project it clearly belongs to. Only shared text decides: a private item, or a title, description or goal you set privately, never pulls a shared record into a topic. A `<private>` region inside a record is left out of everything the planner reads: its words never route or group a record, and never appear in a drafted title or goal.
- **Knows a record's project** from where it was written. A signal, note or decision an agent writes while it works in a project directory linked to the vault (`o2b brain project link`, which writes the `.o2b-vault.json` pointer) carries that project: an MCP server takes it from the directory it was started in, a CLI command from the directory it runs in, a hook from the working directory its host reports, and a hook or a session checkpoint also stamps the host's session id. The project is the name of the linked directory, keyed the way the scoped standing rules key it (lowercase, letters and digits of any script kept, so `café` and `cafe` are two projects), never its path: two machines group their records as one project only when each links a directory of the same name. A topic scope `project:<name>` is keyed the same way, so `o2b topic list --scope` and `o2b topic create --scope` take the name as the directory spells it. A caller of a remote MCP transport (an HTTP bind that is not loopback) gets no project, since the server's directory is not where that caller works; a loopback caller on the same machine is local and gets it. A record written anywhere else carries no project, never a guess, and so never makes a topic; nor do records written before this release, the migrated history included. When the last pass made nothing for that reason, its topic summary, `o2b status` (`store.topics`) and doctor (`topics-records-without-project`) say how many records no topic holds name no project; a caller below local reach is given the counts of the shared records only.
- **Counts a repeated observation once.** A session capture that records the same observation again (the same topic, sign, principle and scope) is deduplicated across the whole vault, also when it comes from another project: the first project to capture it keeps it, and the repeat neither strengthens the preference twice nor joins the other project's topics.
- **Creates** a topic when enough related records of one project that no topic holds (5 by default, the shared setting `topics.new_min_records`) come from at least two sessions (`topics.new_min_sessions`, default 2). A record's session is the `session` it names, else its `session_ref`, else the machine, agent and UTC day that wrote it. One busy session never makes a topic on its own. A record the store migration imported counts from when and where its legacy item was written (the log event's time, the signal's `created_at`, else the date in the legacy file name; the device of its legacy shard, else the migrating machine), not from the migration's moment, so its records keep the dates and sessions they were written in. Those dates alone start no topic: a migrated record names no project, so it joins one only when you assign it, or when the planner routes it to a personal topic you made by hand. The topic gets a drafted title and goal, which you can change.
- **Proposes** merges of two topics that look like one, and splits of a topic whose material falls into two groups. Nothing proposed is applied: the digest and the dream report list the proposal with the command that applies it.
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
