# Variants - audit trail

The consultant was Claude Code, run once with the prompt at
`cli-output/prompt.md` and captured verbatim at `cli-output/claude.md`. It
returned three parseable variants and a recommendation, so the fallback
consultant was not run.

The prompt carried the **corrected** framing rather than the tracker's original
wording. Eight reconnaissance passes against the real source had already
established that most of the ten task bodies describe a different system: one
where the ask is a git-visibility ladder for a product with no git transport, a
per-agent instruction block over a transport that cannot carry an agent, a fleet
view over a metric with no referent, and a symmetric shared scope for a private
flag that is content-derived rather than caller-declared. Variants generated
from those premises would have been variants for another codebase. The
corrections are in `recon/`, each anchored and several reproduced by execution.

## The three variants, verbatim

See `cli-output/claude.md`. In summary:

1. **Repair the instruments, let the red builds define the scope** - treat the
   release as a measurement failure first: fix the broken auditors in dependency
   order and ship whatever product fixes the newly-red builds demand. Complexity
   large, risk high.
2. **A boundary census** - build an eleventh census in the established idiom
   where every label-bearing declaration must name the site that enforces it,
   and make all ten findings rows in one table. Complexity large, risk high.
3. **Disposition triage: enforce, retract, or re-measure; no new mechanism** -
   assign every finding exactly one of three verdicts and route it to the census
   that already owns its class. Complexity medium, risk medium. Recommended by
   the consultant.

## Decision

**Variant 3, with one correction and one graft.**

### Agreement with the recommendation

The consultant's decisive argument is the empty critical path, and it holds
against the source: the ten units touch largely disjoint files, each has a
definition of done anchored at a specific `file:line`, and only the lexer
extraction has a shared owner. Variant 1 states outright that its scope is
whatever the repaired instruments turn red, which is not a scope for a single
branch that must also keep an exact tool count, four hardcoded lists and a
byte-diffed bundle green. Variant 2 is the parallel idiom the operator's
constraints forbid, and its own trade-offs predict the failure mode precisely:
"a registry whose membership check is weaker than what it claims to enforce is
precisely the defect under review."

### The correction

Variant 3 accepts "no single new mechanism guards the eleventh instance" as a
cost. That cost is not accepted. This repository's durability doctrine is that a
fix without a census is a fix a reviewer has to remember, and the previous
release proved the point in the sharpest possible way - the census its whole
argument rested on read no source at all.

The mechanism does not have to be new. Finding 1 already names it: the scope
matrix asserts that each of 110 tools is classified exactly once and never that
a classification is correct, which is the same shape as every other finding in
this release. Turning the unasserted bucket from a bare name list into entries
that each carry drivable arguments and a written reason, and running them
against a two-owner fixture, is a structurally-derived enforcement census inside
the test that already owns the class. That is U3, and it is what makes U1
durable rather than a fix that holds until the next tool is added.

### The graft

Variant 2's organising principle survives inside the ENFORCE units: a bucket
without a per-surface assertion is another label with nothing under it, so every
ENFORCE unit ships its assertion in the same commit as its check. U8 carries the
same idea one level up - the egress census missed the eighth site because its
destination derivation is a hardcoded name list, so the derivation is widened
and a synthetic destination is used to prove the widening works. The census that
catches unguarded exports had the defect it exists to catch.

Variant 1's best material is kept as individual RE-MEASURE units - the shared
lexer, the discarded IDF-weighted coverage, the egress destination derivation -
without buying the unbounded discovery loop that came with them. The one place
its logic is honoured in full is U3's risk note: driving ten tools against a
two-owner fixture may surface more leaks than the unit expects, and the budget
must absorb that rather than stopping at the ten already named.

### Why RETRACT is first-class, and its one exception

Two of the ten items ask for mechanisms with no subject in this product. The
operator's standing constraint is that a fallback which quietly does nothing is
forbidden and an error must be shown explicitly; a knob that cannot change an
outcome is that same defect in configuration form, because the operator sets it,
sees no error, and believes a boundary exists. So retraction is a shipped
outcome with its evidence recorded, not a deferral.

The exception is written into the tracker and is honoured: t_eb94ac35 states
that `below_floor` must not be closed by deleting the vocabulary member, because
the member describes a state the system should be able to reach. U4 re-measures
instead, and after it the floor fires when the match is genuinely weak - which is
what the member always claimed and what it has never done.
