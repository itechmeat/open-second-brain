# Open Second Brain release image and body canon

Reference for the `draft` node of `osb-release`. Adapted from the operator's
canon (the operator's local `.ai-notes/release-image-style.md`, approved
2026-06-05) and from releases v1.54.0 to v1.56.0. `render.sh` enforces the
mechanical parts; this file is the part an agent has to author.

## Image: terminal TUI, interaction-diagram layout

Start from the canon SVG `scope` downloaded (`canon/<tag>-<slug>-source.svg`,
the source of the most recent release that has one). Copy verbatim
everything before `<!-- header`: the root element (viewBox `0 0 1640 1240`,
font `'Courier New', Courier, monospace`), `<defs>` (scan pattern,
`logoCut` mask, `osbLogo` group, `arrG`/`arrA` arrow markers) and the window
chrome. Change only the version in the window title
`o2b - open-second-brain - vX.Y.Z`. `render.sh` refuses any other difference.

Layout since v1.10.0 for interaction diagrams (v1.54.0, v1.56.0): a scheme
of interacting parts that shows why THIS release is useful - actors, flows
and arrows - not text blocks and not deep technical detail.

- Header: logo `translate(56,104) scale(0.22)`; `OPEN SECOND BRAIN` 54px
  bold; `vX.Y.Z - TAGLINE` 32px (version `#39d353`, tagline `#ffb000`);
  release date and a one-line claim right-aligned in `#8b949e`.
- Body: boxes (`#11161d`, border `#30363d`, green 9px accent bar where a box
  is a capability) joined by arrows with `marker-end="url(#arrG)"` (flows
  that now work) or `url(#arrA)` (the gap that was closed). Arrows are
  straight or orthogonal and anchored on box edges - never skewed curves
  from empty space.
- Status bar (optional): one `#161b22` row with true facts from this
  release's CI and review (tests, typecheck, lint, review verdict).
- Footer: `$ o2b ...` with a real command of this release, then the
  blinking cursor `<rect id="cursor">` right after it (keep its SMIL
  `<animate>`), repo URL right-aligned at 17px.
- Palette: text `#e6edf3`, secondary `#8b949e` / `#9fb0c0`, green
  `#39d353`, amber `#ffb000`, red `#f85149`, bars `#161b22`.
- No font below 17px (X/Twitter preview readability).
- Proof lines show real command shapes and outputs from the release, never
  invented ones.

Assets (all four are uploaded; the GIF is embedded in the body):
`vX.Y.Z-<slug>.gif`, `vX.Y.Z-<slug>.png`, `vX.Y.Z-<slug>-source@2x.png`,
`vX.Y.Z-<slug>-source.svg`.

Export (what `render.sh` runs): sharp 0.34.5 at density 72 x scale -> the
@2x PNG (3280x2480) and the 1x PNG (1640x1240); frame 1 = the SVG as is,
frame 2 = the cursor rect with `opacity="0"`; ffmpeg
`-framerate 5/3 ... palettegen=stats_mode=diff ... paletteuse=dither=none
-loop 0` -> a 2-frame GIF, 600 ms per frame.

## Body

One line per paragraph and per bullet (no hard wraps), " - " as the
separator (never an em dash), no exclamation marks, the full name
"Open Second Brain", no AI-authorship line.

```
## Open Second Brain vX.Y.Z - <Tagline>

<One paragraph, capability-first: what was missing, what exists now.>

![<Tagline>](https://github.com/itechmeat/open-second-brain/releases/download/vX.Y.Z/vX.Y.Z-<slug>.gif)

### What ships

- **<Capability sentence.>** <why and how, one line>

### Process wins

- <How the work was done: verified premises, one source per fact, ...>
- Quality record: <N> tests / 0 fail, TypeScript clean, lint at 0 errors, version synced, <review verdict>.

### Notes

- <Caveats, refused or reshaped scope, bugs fixed along the way.>
- The version bump to X.Y.Z shipped inside the PR (#NNN), per the project rule in `CLAUDE.md`.
- Release image: the canonical terminal style, here as an interaction diagram (animated GIF in this body; static PNG, 2x PNG and the SVG source attached as assets).
```

A release that covers several versions (for example 1.57.0 and 1.57.1)
takes its title and tag from the newest version and says in the opening
paragraph which versions and PRs it covers; "What ships" groups the
capabilities of every covered version, and Notes names each PR.

The title is `vX.Y.Z - <Tagline In Title Case>` without the project name.
Every claim must be true to the CHANGELOG entries in scope and the merged PR
descriptions; quality numbers come from the CI run of the target commit or
the PR's own verification section.
