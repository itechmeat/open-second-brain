# Expected output, before and after

Fixture vault `<vault>` with a folder `Clips/`:

- `page.html` (138 bytes): `<html><head><title>Release notes</title></head><body><h1>Overview</h1><p>Fish &amp; chips</p><h2>Install</h2><p>Run it.</p></body></html>`
- `parts.csv` (22 bytes): `name,qty` / `bolt,4` / `nut,7`
- `report.pdf` (9 bytes, a PDF header only), `blob.bin` (3 bytes), `notes.md` (15 bytes).

The "before" blocks were captured on f5c46615 with the CLI from the worktree (Bun 1.4.0). The "after" blocks are the target shape pinned by the plan; `<plan id>` stands for the new plan id (the discovered set gains the HTML and CSV files, so the id changes).

## `o2b brain batch-plan Clips`

Before:

```
batch-plan: Clips (plan 6e4905944b42be45)
  1 file(s) to ingest in 1 batch(es); 0 unchanged skipped
  batch 0: 1 file(s), 15 byte(s)
    - Clips/notes.md (new, 15B)
  4 unclassifiable file(s) not planned, by extension:
    - .bin: 1
    - .csv: 1
    - .html: 1
    - .pdf: 1
```

After:

```
batch-plan: Clips (plan <plan id>)
  3 file(s) to ingest in 1 batch(es); 0 unchanged skipped
  batch 0: 3 file(s), 175 byte(s)
    - Clips/notes.md (new, 15B)
    - Clips/page.html (new, 138B, html)
    - Clips/parts.csv (new, 22B, csv)
  1 non-extractable page(s) skipped:
    - Clips/report.pdf (format-not-extractable: pdf)
    by reason: format-not-extractable=1
  1 unclassifiable file(s) not planned, by extension:
    - .bin: 1
```

## `o2b brain batch-plan Clips --json`

Before:

```json
{
  "ok": true,
  "source_dir": "Clips",
  "max_batch_bytes": 1048576,
  "max_batch_files": 25,
  "total_files": 1,
  "total_bytes": 15,
  "skipped": [],
  "unclassifiable": {
    "total": 4,
    "by_extension": {
      ".bin": 1,
      ".csv": 1,
      ".html": 1,
      ".pdf": 1
    }
  },
  "plan_id": "6e4905944b42be45",
  "resumed_completed": 0,
  "batches": [
    {
      "index": 0,
      "total_bytes": 15,
      "files": [
        {
          "path": "Clips/notes.md",
          "bytes": 15,
          "status": "new"
        }
      ]
    }
  ]
}
```

After:

```json
{
  "ok": true,
  "source_dir": "Clips",
  "max_batch_bytes": 1048576,
  "max_batch_files": 25,
  "total_files": 3,
  "total_bytes": 175,
  "skipped": [],
  "skipped_non_extractable": [
    {
      "path": "Clips/report.pdf",
      "reason": "format-not-extractable",
      "detail": "pdf"
    }
  ],
  "skip_reason_counts": {
    "format-not-extractable": 1
  },
  "unclassifiable": {
    "total": 1,
    "by_extension": {
      ".bin": 1
    }
  },
  "plan_id": "<plan id>",
  "resumed_completed": 0,
  "batches": [
    {
      "index": 0,
      "total_bytes": 175,
      "files": [
        { "path": "Clips/notes.md", "bytes": 15, "status": "new" },
        { "path": "Clips/page.html", "bytes": 138, "status": "new", "format": "html" },
        { "path": "Clips/parts.csv", "bytes": 22, "status": "new", "format": "csv" }
      ]
    }
  ]
}
```

## `o2b brain extract <vault>/Clips/page.html`

Before (every form of the verb):

```
error: unknown brain verb: extract
usage: o2b brain <verb> [args...]
```

After:

```
extract: <vault>/Clips/page.html (html)
  title: Release notes
  2 part(s):
    h1 Overview | lines 1-2
    h2 Overview > Install | lines 3-4
```

After, `--json`:

```json
{
  "ok": true,
  "path": "<vault>/Clips/page.html",
  "extracted": true,
  "format": "html",
  "title": "Release notes",
  "text": "Overview\nFish & chips\nInstall\nRun it.",
  "parts": [
    { "index": 0, "level": 1, "heading": "Overview", "trail": "Overview", "line_start": 1, "line_end": 2, "source_offset": 53 },
    { "index": 1, "level": 2, "heading": "Install", "trail": "Overview > Install", "line_start": 3, "line_end": 4, "source_offset": 93 }
  ]
}
```

## `o2b brain extract <vault>/Clips/parts.csv`

After:

````
extract: <vault>/Clips/parts.csv (csv)
  comma-delimited, 2 column(s), 2 row(s), 2 rendered, 0 redacted cell(s)
## Table

### Rows 1-2

```table
name | qty
bolt | 4
nut | 7
```
````

After, `--json`:

```json
{
  "ok": true,
  "path": "<vault>/Clips/parts.csv",
  "extracted": true,
  "format": "csv",
  "delimiter": "comma",
  "columns": 2,
  "rows": 2,
  "rows_rendered": 2,
  "redacted_cells": 0,
  "section": "## Table\n\n### Rows 1-2\n\n```table\nname | qty\nbolt | 4\nnut | 7\n```"
}
```

After, on `report.pdf` and on `notes.md` (`--json`):

```json
{ "ok": true, "path": "<vault>/Clips/report.pdf", "extracted": false, "format": "pdf", "reason": "format-not-extractable" }
{ "ok": true, "path": "<vault>/Clips/notes.md", "extracted": false, "format": "text", "reason": "format-read-verbatim" }
```

## `brain_ingest_source` result

Before, for `sourcePath: "Clips/page.html"` (and the same shape for `Clips/parts.csv`):

```json
{
  "summary_path": "Brain/sources/<slug>-<hash12>.md",
  "created": true,
  "entities_created": [],
  "entities_updated": [],
  "connections": [],
  "capture_scope": "full-local"
}
```

After, HTML:

```json
{
  "summary_path": "Brain/sources/<slug>-<hash12>.md",
  "created": true,
  "entities_created": [],
  "entities_updated": [],
  "connections": [],
  "capture_scope": "full-local",
  "parts": { "extracted": true, "count": 2 }
}
```

The page gains `source_format: html` and `source_content_hash: <sha256>` and ends with:

````
## Parts

```parts
h1 Overview | lines 1-2
h2 Overview > Install | lines 3-4
```
````

After, CSV:

```json
{
  "summary_path": "Brain/sources/<slug>-<hash12>.md",
  "created": true,
  "entities_created": [],
  "entities_updated": [],
  "connections": [],
  "capture_scope": "full-local",
  "table": { "rendered": true, "format": "csv", "delimiter": "comma", "columns": 2, "rows": 2, "rows_rendered": 2, "redacted_cells": 0 }
}
```

The page gains `source_format: csv`, `source_content_hash: <sha256>`, `table_delimiter: comma`, `table_columns: 2`, `table_rows: 2`, `table_rows_rendered: 2`, and ends with the `## Table` section shown above. At remote reach, a hidden `.csv` source and an absent one both answer `"table": { "rendered": false, "format": "csv", "reason": "source-not-local" }` with no digest and no section; `notes.md` answers exactly as before (no `parts`, no `table`, page byte-identical).

## `o2b brain architect` module-dependencies region, only unlinkable edges

Fixture: module `web` depends only on `@mono/ab`, owned by module `a[b]`.

Before (overview region, false):

```
No module's manifest names exactly one other module's manifest as a runtime dependency.
```

Before (module note `web`, false):

```
Depends on: no other module
```

After (overview region):

```
Every declared module edge touches a module whose name a link cannot carry, so none is drawn:
- `web` -> `a[b]`
```

After (module note `web`):

```
Not linked: `a[b]`
```
