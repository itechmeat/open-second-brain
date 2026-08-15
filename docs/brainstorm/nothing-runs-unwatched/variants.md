# Variants - audit trail

The consultant was Claude Code, run once with the prompt at
`cli-output/prompt.md` and captured verbatim at `cli-output/claude.md`. It
returned three parseable variants and a recommendation, so the fallback
consultant was not run.

The prompt deliberately carried the **corrected** framing rather than the
tracker's original wording. Reconnaissance had already established that most of
the nine task bodies describe a different system - a daemon that caps model
inference, an ingest that locks too often, a scanner whose cost is in rendering.
Variants generated from those premises would have been variants for another
codebase.

## The three variants, verbatim

See `cli-output/claude.md`. In summary:

1. **The observation spine** - one closed-vocabulary lifecycle event emitted
   from the checkpoint boundaries that already exist, delivered through an
   optional sink on the same options object that already carries `safeguard`,
   with a census enumerating every long operation. Complexity large, risk
   medium. Recommended by the consultant.
2. **The claim census** - take the honesty half of the thesis as the organising
   principle: no user-facing assertion ships unless it is a registered claim
   with a resolver, or a registered refusal naming why it cannot be checked.
   Complexity large, risk high.
3. **Wire what is dead, refuse what is unanswerable, delete what was wrong** -
   no new subsystem and no new vocabulary; pair each unit with the mechanism
   that already exists and either connect it or state by name that it cannot be
   connected. Complexity medium, risk low.

## Decision

**Variant 1, with one correction and one graft.**

### Agreement with the recommendation

The consultant's core argument holds against the source. Units 1, 3 and 4 of the
brief really are one seam: the silent consolidation pass, the dead
`SafeguardAbortError` and the herd of detached reindexes are three symptoms of
the same missing channel, and the checkpoint boundaries where a tick belongs are
already carved. Variant 3's decisive weakness is stated in its own trade-offs -
nine local fixes leave nothing that forces the *next* long operation to speak,
which is the exact failure the previous release argued against and then
committed three instances of.

### The correction

Variant 1 lists "MCP gets no progress at all in this release" as an accepted
cost, treating both transports as non-carriers. That is true of HTTP, which
`res.end`s a single SSE event, and false of stdio. The stdio frame writer is
private but reachable, and a third **optional** handler parameter does not force
edits at the 88 registration sites, because a handler declaring two parameters
satisfies a type declaring three. So stdio carries real progress notifications
and HTTP carries a typed refusal. Accepting the consultant's cost here would
have shipped a smaller capability than the codebase supports, and - worse -
would have left the discarded `_meta.progressToken` discarded, which is the
silent-drop defect this release exists to attack.

### The graft

Variant 3's per-unit discipline is kept in full: every unit lands inside a
mechanism this repository already enforces. The maintenance lane's existing gate
set, lease and typed journal carry the pressure gate rather than a new
scheduler. The `agent-backend` registry shape carries the ingest adapters rather
than a second registry idiom. The doctor code census carries the sunset check.
The write-site census's syntactic technique carries the progress census. This is
what the operator's "maximally native integration, no crutches" constraint
means in practice, and Variant 1 alone would have permitted a parallel idiom.

Variant 2 was rejected on evidence rather than on taste. Its own trade-offs
predict "a registry with more refusals than resolvers", and reconnaissance
confirms that prediction: of the claims it would register, the environment
class, the vendor name, the host load average and the exact token count are all
unanswerable in this codebase. A registry whose majority is refusals is a
correct description of the problem and a poor mechanism for fixing it. Its best
idea survives inside Variant 1 anyway - the `refused` member of `PROGRESS_KIND`
gives the unanswerable cases one shared, typed home.
