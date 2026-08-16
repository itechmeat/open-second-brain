# Recon: two censuses built the same lexer (t_1d4f932f)

Read-only reconnaissance on `feat/a-label-is-not-a-boundary`. Every claim below
carries a `file:line` anchor that was read, and every number was produced by
running the code, not by reading a comment.

Test command that worked (clean `HOME`, per the suite convention in
`bunfig.toml:1-3` preloading `tests/setup.ts`):

```
mkdir -p /tmp/emptyhome
env HOME=/tmp/emptyhome bun test tests/core/architecture/progress-census.test.ts \
  tests/core/architecture/verdict-vocabulary-census.test.ts \
  tests/core/architecture/destructive-site-census.test.ts \
  tests/core/architecture/write-site-census.test.ts
# 162 pass, 0 fail, 278 expect() calls, 4 files, 6.99s
```

## 1. What exists: every test that reads source text structurally

`tests/` holds seventeen tests that read `.ts` source and decide something from
its shape. Only the technique column matters for this task.

| Test | Anchor | Technique | Owns a lexer? |
|---|---|---|---|
| progress census | `tests/core/architecture/progress-census.test.ts:181-285` | full lexer, two-view collapsed to one (`code`) | YES — `lex` |
| destructive-site census | `tests/core/architecture/destructive-site-census.test.ts:232-339` | full lexer, two views (`withoutComments`, `code`) | YES — `lex` |
| verdict-vocabulary census | `tests/core/architecture/verdict-vocabulary-census.test.ts:1047-1102` | partial masker: comments + quoted strings + whole templates; **no regex rule** | YES — `maskSource` |
| progress-emitter census | `tests/cli/progress-emitter-census.test.ts:97-132` | partial masker: comments blanked, strings *skipped* (contents kept); **no regex rule** | YES — `blankComments` |
| write-site census | `tests/core/architecture/write-site-census.test.ts:745`, `:805-806` | regex over RAW text | no |
| egress census | `tests/core/architecture/egress-census.test.ts:149-174` | regex over raw text | no |
| import cycles | `tests/core/architecture/import-cycles.test.ts:51-57`, `:81-85` | line-anchored regex over raw text (`^[ \t]*import`) | no |
| core layering | `tests/core/layering.test.ts:39-42`, `:48-57` | per-line, `isCommentLine` prefix test | no |
| doctor-exit census | `tests/core/brain/doctor-exit-census.test.ts:91`, `:127-136` | regex over raw text | no |
| terminal-state census | `tests/cli/terminal-state-census.test.ts:239`, `:303`, `:361`, `:387-394` | regex + `indexOf` slicing over raw text | no |
| entity-read census | `tests/core/brain/entities/entity-read-census.test.ts:69-115` | regex over raw text | no |
| vault-guard census | `tests/core/brain/vault-guard-census.test.ts:29-57`, `:119-122` | regex over raw text | no |
| continuity reader census | `tests/core/brain/continuity/reader-census.test.ts:44-46`, `:167-168` | regex over raw text | no |
| manifest completeness | `tests/cli/manifest-completeness.test.ts:76-95`, `:111` | `indexOf` slicing over raw text | no |
| help-surface parity | `tests/cli/help-surface-parity.test.ts:31-33` | parses CLI *output*, not source | n/a |
| chunk-window census | `tests/core/search/chunk-window-census.test.ts` | imports values; reads no source | n/a |
| config-template ratchet | `tests/core/brain/config-template-ratchet.test.ts:114` | reads YAML lines, not TS | n/a |

### Correction to the premise

The task says "three censuses now read source syntactically". **Four do.**
`tests/cli/progress-emitter-census.test.ts:97-132` carries a fourth
hand-written blanker, written for the same reason and stated in the same
words ("A census that matched raw text would count `progressCounter(` inside a
docblock as an emitter", `:92-95`). The task also says "a fourth will be
written eventually" — it already was.

The task also implies the destructive census's lexer was the origin the
progress census borrowed from. That is what `progress-census.test.ts:179` says
("This is the same lexer the destructive-site census runs, for the same
reason"), and it is exactly true: the two bodies are character-identical apart
from the second view (see §2).

## 2. Comparison of the four implementations

| Aspect | `destructive.lex` (`:232-339`) | `progress.lex` (`:181-285`) | `verdict.maskSource` (`:1047-1102`) | `emitter.blankComments` (`:97-132`) |
|---|---|---|---|---|
| Return | `SourceViews { withoutComments, code }` (`:178-181`) | `string` (the `code` view only) | `string` | `string` |
| Offsets preserved | yes (`:236-240`) | yes (`:184-188`) | yes (`:1049-1051`) | yes (`:98`) |
| Newlines preserved | yes | yes | yes | yes |
| Line comments | blanked in both views (`:274-281`) | blanked (`:222-228`) | blanked (`:1056-1062`) | blanked (`:103-106`) |
| Block comments | blanked in both views (`:282-289`) | blanked (`:229-235`) | blanked (`:1063-1069`) | blanked (`:107-119`) |
| String contents | blanked in `code`, KEPT in `withoutComments` (`:290-297`) | blanked (`:236-243`) | blanked (`:1070-1098`) | **kept** — the scanner only skips past them (`:120-128`) |
| Unterminated-quote rule | none — regex rule covers it | none — regex rule covers it | "a `"`/`'` with no partner before the newline is not an opener" (`:1078-1088`) | none |
| Template literals | mode stack; text blanked, `${…}` re-entered as CODE (`:250-272`, `:298-302`) | identical (`:198-220`, `:244-248`) | blanked WHOLE, no `${…}` re-entry (`:1070`, `:1085`) | skipped whole, contents kept (`:120-128`) |
| Nested `${}` braces | own brace counter per interpolation (`:244-245`, `:323-334`) | identical (`:192-193`, `:269-280`) | n/a (blanked whole) | n/a |
| Regex literals | recognised, contents blanked, char-class aware (`:303-322`) | identical (`:249-267`) | **NOT recognised** | **NOT recognised** |
| Regex-vs-division | `REGEX_PRECEDING` set + keyword lookbehind (`:184-230`) | identical (`:124-170`) | n/a | n/a |
| Escapes | `\` consumes two chars in strings, templates, regexes | identical | `\` consumes two chars in strings only (`:1073-1076`) | `\` consumes two chars in strings (`:123`) |

`diff` of `progress-census.test.ts:181-285` against
`destructive-site-census.test.ts:232-339` is nine hunks, every one of them the
mechanical consequence of the second view (`blank(from,to)` becoming
`blank(arr,from,to)`; two extra `blank(withoutComments, …)` calls in the two
comment branches; the return type). The preceding constant blocks
(`progress:124-170` vs `destructive:184-230`) differ only by the
`ReadonlySet<string>` annotation on two `new Set([…])`. **The two are one
implementation typed twice.**

### The one thing `withoutComments` buys

`destructive-site-census.test.ts:172-174` states it: an import specifier IS a
string, so the binding detector must read it. `fsImports(withoutComments)`
at `:425` reads specifiers; `removalSites(code, …)` at `:469` and
`gateSpans(code)` at `:503` read calls. Any extraction must expose both views,
and §5 shows a migration that forgets this silently zeroes a census.

## 3. Measured populations, today

| Census | Measurement | Value |
|---|---|---|
| progress | modules scanned (`SRC_ROOT`, `:974`) | 951 |
| progress | `safeguardedShapes(SOURCES)` (`:979`) | **10** options types |
| progress | of those, with a sink | 9 (the 10th is the declared exemption `EmbeddingPhaseOptions`, `:107-111`) |
| progress | `filesDeclaringSafeguard` cross-check (`:994`) | 9 files |
| verdict | files scanned (`:1326`) | 951 |
| verdict | `scanVocabularies` population (`:1327`) | **57** vocabularies |
| verdict | `CENSUS` registry (`:1328`) | 57 entries — exact agreement |
| destructive | modules under `src/core/brain/` (`:565`) | 461 |
| destructive | files with removal sites (`ROWS`, `:566`) | 32 |
| destructive | ungated rows (`:568`) | 31 |
| destructive | `DESTRUCTIVE_SITES` registry | 31 — exact agreement |
| write-site | modules scanned | 951 |
| write-site | rows in population (`:821`) | 129 |
| write-site | direct-fs rows (`:822`) | 64 (registry `DIRECT_WRITE_EXCLUSIONS` also 64) |
| write-site | shared-writer rows | 94 |
| emitter | `progressCounter(` sites in `src/` | 9 |

The 10 and the 57 the task quotes are confirmed. Note that no census asserts an
exact count — `progress-census.test.ts:985` is `toBeGreaterThan(0)` and
`verdict-vocabulary-census.test.ts:1451-1452` is `toBeGreaterThan(50)` /
`toBeGreaterThan(500)`. A before/after equality check on the extraction has to
be run, not read off an assertion.

## 4. Measured mis-parses

Adversarial inputs were run against all four implementations from
`/tmp/.../scratchpad/` by importing each census under a `bun:test` stub.

Neither of the two full lexers mis-parsed any of the 24 inputs tried, including
every case the task named: regex containing a quote; template with nested
braces and an interpolated string; comment containing a quote; division after
an identifier, a `)`, a `]`, a `>` and a `++`; escaped backslash before a
closing quote; regex containing `{`, `//`, an escaped `/` in a character class,
and an escaped `[`; nested template inside an interpolation; a comment inside an
interpolation. Length and newline positions were preserved in every case.

### Defect 1 — `verdict.maskSource` is wrong on live source, today

The rule at `verdict-vocabulary-census.test.ts:1085` is
`if (char !== "\`" && text[k] === "\n")`. The unterminated-quote guard —
the one the docblock at `:86-91` credits with keeping `/["]/` from blanking
the rest of a module — is **excluded for backticks**. A backtick inside a
regex literal is therefore read as a template opener and blanks real code to
the next backtick anywhere in the file.

Two shapes that exist in `src/` today reproduce it:

```
src/core/vault.ts:88                       const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`]+`/g;
src/core/install/adapters/generic.ts:70    if (/[:#[\]{},&*!|>'"%@`]/.test(s) || …)
```

Measured over the real tree: `maskSource` blanks **9,706 of the 31,608 bytes**
of `src/core/vault.ts` (31 %) that the shared lexer keeps. Consequence today:
the frozen binding `DOUBLE_QUOTED_ESCAPES` at `src/core/vault.ts:748` is
**invisible** to the census — it is the one frozen binding in the whole tree
that `maskSource` cannot see and the shared lexer can.

Positive control (a synthetic module carrying `src/core/vault.ts:88` verbatim
followed by a complete four-piece vocabulary):

```
current maskSource   scanVocabularies -> []      <- the vocabulary vanishes
same file, regex line deleted            -> ["ZZ"]
shared lexer         scanVocabularies -> ["ZZ"]
```

This is the mis-parse class the file's own docblock says is "worse than a
miss" (`:1081-1084`), still live, one line away from hiding a real vocabulary.

### Defect 2 — `emitter.blankComments` has the original bug, latent

`tests/cli/progress-emitter-census.test.ts:120-128` treats `"`, `'` and
`` ` `` as string openers with no regex rule and no newline guard. Input:

```
const RE = /["]/;
/** Mentions progressCounter( in prose. */
const tail = "x";
```

Result: the docblock is **not blanked** and `progressCounter(` in prose counts
as an emitter — precisely the failure `:92-95` says the function exists to
prevent. Measured over `src/` today the count is unchanged (9 sites either
way), so this one is latent, not live.

### Not defects, but asymmetries to decide

- `destructive.withoutComments` leaks string and template CONTENTS by design
  (`:172-176`). Any shared type must keep that documented at the helper.
- `verdict.maskSource` blanks templates whole, so code inside `${…}` is
  invisible; the shared lexer reads it as code. This is a *widening* on
  migration and the docblock text at `:86-91` must change with it.

## 5. Would the extraction break layering or import cycles?

No, and neither guard can even see it.

- `tests/core/architecture/import-cycles.test.ts:43` sets `SRC = resolve(ROOT, "src")`
  and `moduleFiles()` at `:82` globs `**/*.ts` under that root only. A module
  under `tests/helpers/` is not a node in the graph.
- `tests/core/layering.test.ts:18` sets `CORE_ROOT = src/core` and walks only
  that. The banned calls (`process.exit`, `process.stdout.write`, `console.log`)
  are irrelevant to a pure string function anyway.
- The helper would import nothing — not even from `src/` — so it adds no edge
  in either direction.

## 6. What `tests/helpers/` looks like today

Ten modules, no subdirectories: `cli-timeout.ts`, `epipe-stream-harness.ts`,
`fake-http.ts`, `fixtures.ts`, `mock-embedding.ts`, `progress-records.ts`,
`run-cli.ts`, `search-fixtures.ts`, `sqlite-vec.ts`, `vault-digest.ts`.

Conventions, from `tests/helpers/progress-records.ts:1-24` and
`tests/helpers/vault-digest.ts:1-20`:

- kebab-case filename naming the thing, not the verb;
- a docblock that argues WHY the helper exists before it says what it does,
  and `{@link}` references to the exported names;
- named `export`s only, no default export;
- explicit `ReadonlyArray` / `Readonly` on returned structures;
- imports use an explicit `.ts` extension and a relative specifier
  (`tests/cli/progress-emitter-census.test.ts:79-80`);
- helpers may import from `src/` (`progress-records.ts:11`) but need not.

**No helper has its own test file** — `tests/helpers/*.test.ts` does not exist,
and the three helpers whose behaviour is load-bearing (`vault-digest`,
`progress-records`, `run-cli`) are exercised only indirectly through the 298
tests that import from `tests/helpers/`. The acceptance criterion "its own
tests" therefore establishes a new convention rather than following one. Bun
discovers `*.test.ts` anywhere, and `bunfig.toml` preloads `tests/setup.ts`
globally, so `tests/helpers/source-lexer.test.ts` needs no configuration.

## 7. Each census's "what this cannot see", quoted

**progress census**, `progress-census.test.ts:67-86`, "## What it still does not
see, stated rather than implied": a heritage clause this tree cannot resolve
(`extends`/`&` followed only into this tree; an imported base or `Omit<…>`
resolves to the whole base); a sink whose asynchrony is more than one alias
deep; a counter it cannot recognise as one; whether a declared `onProgress` is
ever READ. **None of these four belongs to the lexer.** The lexer's own limits
are stated positively instead, at `:51-65`.

**verdict-vocabulary census**, `verdict-vocabulary-census.test.ts:63-96`,
"## What the scan cannot see, stated rather than implied": a vocabulary SPLIT
ACROSS MODULES; a vocabulary with no membership list or no guard; values that
are not literals in the object; a guard whose parameter is typed `string`;
trees other than `src/`; and — the lexer one — "Code inside a `${…}`
interpolation: a template literal is blanked whole, so a vocabulary piece
written inside one is not read. A template can also legally span lines, which
is why the masker's 'a quote with no partner on this line is not a string' rule
— the rule that keeps a regex literal such as `/["]/` from blanking the rest of
a module — applies to `"` and `'` only." That last sentence is the one the
measurement in §4 falsifies as a *safety* claim: it is true as written and the
gap it leaves is a live mis-parse.

**destructive-site census**, `destructive-site-census.test.ts:100-114`, "## What
this file deliberately does NOT do": it does not check that a declared recovery
story is TRUE; it does not reach outside `src/core/brain/`. Its lexer claim is
separate, at `:51-54`: "a removal named in a comment is not a site and a site is
not hidden by a quote inside a regular expression."

**write-site census**, `write-site-census.test.ts:54-58`: "a write issued through
a `node:fs/promises` FileHandle method, or through a binding re-exported by an
intermediate module." It states no lexical limit because it does no lexing.

Union of lexer-owned limits, to state once at the helper: interpolated `${…}`
code is read as code but is not attributed to the template; a regex whose
opening `/` sits in a position the heuristic reads as division is read as
division; angle brackets are not counted as brackets; `withoutComments` carries
literal contents on purpose. Intersection of the *non*-lexer limits: empty —
every census's remaining blind spots are about its own rule and stay with it.

## 8. Recommended extraction

**Module:** `tests/helpers/source-lexer.ts`

**Exported surface:**

```ts
/** Two views of one module, both the same LENGTH as the source. */
export interface LexedSource {
  /** Comments blanked; string, template and regex CONTENTS kept. */
  readonly withoutComments: string;
  /** Comments and all literal CONTENTS blanked; `${…}` code kept. */
  readonly code: string;
}

export function lexSource(text: string): LexedSource;

/** `lexSource(text).code`, for the callers that need one view. */
export function lexCode(text: string): string;
```

Take the body verbatim from `destructive-site-census.test.ts:184-339` — it is
the strictly more general of the two identical copies. Move the docblock
prose from `progress-census.test.ts:36-65` and `:172-179` (the argument for
lexing) and from `destructive-site-census.test.ts:168-181` (the argument for
two views) into the helper's header, and state the union from §7 there.

**Tests:** `tests/helpers/source-lexer.test.ts`, minimum cases:

1. regex literal containing a quote (`/["']/`) — code after it survives;
2. regex literal containing a backtick, using `src/core/vault.ts:88` verbatim —
   this is the Defect-1 regression test;
3. brace inside a string — bracket matching unaffected;
4. brace inside a comment — same;
5. template with nested `${}` and an interpolated string;
6. division that looks like a regex opener, after an identifier, `)`, `]`, `>`
   and `++`;
7. escaped backslash before a closing quote;
8. `withoutComments` keeps an import specifier while `code` blanks it —
   the invariant the write-site migration depends on;
9. length and newline-offset preservation on every input above.

**Migration, per census:**

| Census | Change | Measured effect |
|---|---|---|
| destructive-site | delete `:184-339`, import `lexSource`; `lexed()` at `:534` and `classify()` at `:539` call it | none — identical implementation |
| progress | delete `:124-285`, import `lexCode`; `analyze()` at `:622` becomes `lexCode(file.text)` | none — identical implementation. `constants(file.text, code)` at `:629` keeps working because offsets are preserved |
| verdict-vocabulary | delete `maskSource` `:1047-1102`; `scanVocabularies` at `:1288` becomes `lexSource(file.text).code` | **57 → 57**, names identical. Fixes Defect 1. Requires rewriting the docblock bullet at `:86-91`, because interpolated code becomes visible |
| progress-emitter | delete `blankComments` `:97-132`; `:158` becomes `lexCode(readFileSync(…))` | **9 → 9** call sites. Fixes Defect 2 |
| write-site | *optional, recommended*: `classify` at `:803-806` becomes `directWriteCalls(V.code, fsImports(V.withoutComments))` and `V.code.matchAll(SHARED_WRITE_RE)` | **129 rows / 64 direct / 94 shared → identical**, no registry drift. Removes its raw-text reading |

**Every census can migrate.** There is no census that must keep its own copy.
The one migration that is *not* mechanical is `verdict-vocabulary`, and only
because its prose asserts a limit that stops being true.

**The trap:** routing `fsImports` through `code` instead of `withoutComments`
blanks the `"node:fs"` specifier and silently drops the write-site census from
64 direct rows to **0**, with an empty failure list — measured. That is the
same false-clean signature the censuses exist to prevent, so criterion 8 in the
test list above is not optional.

## 9. Other defects noticed

- `tests/core/layering.test.ts:39-42` decides "is a comment" from a line prefix,
  so `const s = "// process.exit";` is not skipped (false positive) and
  `foo(); // ok` on a code line is scanned (harmless), while a banned call
  inside a block-comment line that does not start with `*` is skipped. With the
  helper available this becomes `lexCode(text).split("\n")` and the
  `isCommentLine` heuristic disappears.
- `tests/core/architecture/import-cycles.test.ts:51-57` anchors on `^[ \t]*`,
  which is why a specifier inside a docblock does not match — but a specifier
  inside a template literal at column zero would. Low risk; worth one line in
  the helper's "who could use this next" note.
- None of the three lexer-owning censuses has a test that exercises the
  regex-literal case its own docblock argues about
  (`progress:1088-1117` covers brace-in-generic, brace-in-string and
  commented-out-sink; `destructive:808` covers string-and-comment;
  `verdict` covers none of the three). The bug in §4 survived exactly there.
- `verdict-vocabulary-census.test.ts:1451` floors the population at
  `toBeGreaterThan(50)` against an actual 57. The extraction is the moment to
  make that an equality against `CENSUS.length`, which is already asserted
  to match at `:1407-1426`.
