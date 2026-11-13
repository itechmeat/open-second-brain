# Spec Delta

## Purpose

What a lane file written whole on a store-only machine reads back as, so
staged bytes survive the trip through a `lane-entry` record.

## ADDED Requirements

### Requirement: A lane file written whole reads back byte for byte

On a store-only machine a lane file written from its whole text SHALL read
back as exactly that text: a page without frontmatter, a quoted value that
would parse as a number or a boolean, CRLF line ends, a missing final
newline and the formatting of a JSON file are all kept.

#### Scenario: A page without frontmatter

- **WHEN** a lane page is written whole as `Just text.\n`
- **THEN** it reads back as `Just text.\n`, with no frontmatter added

#### Scenario: A quoted value

- **WHEN** a page is written whole with the frontmatter line `id: '123'`
- **THEN** it reads back with `id: '123'`, and its parsed `id` is the
  string `123`

#### Scenario: JSON formatting

- **WHEN** a JSON lane file is written whole as `{"a":1}\n`
- **THEN** it reads back as `{"a":1}\n`

### Requirement: The raw text is stored only when the parts lose it

A `lane-entry` record SHALL carry the file's text only when its fields and
text do not reproduce it, and only when that text parses back to them; a
file the parts reproduce SHALL be stored as before.

#### Scenario: A canonical page

- **WHEN** a page is written whole in the form the frontmatter writer
  itself produces
- **THEN** its record carries no raw text

### Requirement: The raw text counts for the entry's privacy

A reference to a private page, or a private region, that appears only in
the raw text (for example in a frontmatter comment) SHALL send the entry
to the `private` partition, as the same reference in its fields or text
does.

#### Scenario: A private reference in a frontmatter comment

- **WHEN** a page is written whole whose frontmatter comment names a page
  reserved as private
- **THEN** its record lands in the `private` partition

### Requirement: The writer's judge is the only privacy judge of the raw text

The writer's privacy judge SHALL be the only judge of the raw text,
exactly as it is the only judge of the text: the fold and the readers
SHALL NOT re-judge either. The read-side check that the raw text parses
back is not a privacy judge; it only stops the raw text from saying
something other than the record's own fields and text.

#### Scenario: A hand-appended shared record with a raw comment

- **GIVEN** a `lane-entry` record appended by hand to the `shared`
  partition, bypassing the writer's judge, whose raw text carries a
  frontmatter comment that names a private page and otherwise parses back
  to the record's fields and text
- **WHEN** the lane file is read
- **THEN** the reader serves the raw text, comment included, as written
  (the same trust a hand-appended `text` already gets)

### Requirement: A raw text that does not match its record is not served

A reader SHALL serve a record's raw text only when it parses back to the
record's own fields and text; otherwise it SHALL render the fields and
text as before, so a peer cannot serve content that differs from the
record's parts.

#### Scenario: A mismatched raw text

- **GIVEN** a synced record whose raw text parses to other fields than
  the record carries
- **WHEN** the lane file is read
- **THEN** the reader returns the rendering of the record's fields and
  text

### Requirement: Structured writes and moves

A structured write (fields and body) SHALL store no raw text and replace
an entry that had one; a move SHALL keep the entry's raw text; a whole-text
write that changes only bytes the parts do not carry SHALL be written, not
skipped as unchanged.

#### Scenario: A quoting-only change

- **GIVEN** an entry written whole with `id: '123'`
- **WHEN** it is written whole again with `id: "123"`
- **THEN** a new record is written and the file reads back with the
  double quotes

#### Scenario: A move

- **WHEN** an entry with raw text is moved
- **THEN** the moved file reads back byte for byte

### Requirement: The raw field is optional and never rejects a record

The raw text SHALL be an optional field of the existing record kind, with
no format version change and no change to the fold's rejection rules: a
record without it SHALL fold exactly as before, and a record whose raw
field is not a string SHALL fold without rejection, with no raw text in
its value.

#### Scenario: A record without raw text

- **WHEN** a `lane-entry` record without the field is folded
- **THEN** the entry's value has its fields and text and no raw text

#### Scenario: A raw field that is not a string

- **WHEN** a `lane-entry` record whose raw field is the number `5` is
  folded
- **THEN** the record is accepted and the entry's value has no raw text
