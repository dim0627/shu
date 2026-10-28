# SHU specification

SHU (朱) is a local task store CLI through which humans and AI agents (mainly Claude Code) read and write information about the tasks of software development work.

## 1. Positioning

- **SHU does not collect data.** Gathering information from GitHub, Linear, Slack and so on is the AI agent's job (`gh`, MCP). The one place this repository does it is the `shu-triage` skill (§10), which runs outside the CLI.
- **SHU's only responsibility is file input and output.** Listing tasks, fetching a task, saving a task, appending to its log, and storing artifacts.
- **SHU exists to enforce a few guarantees.** By going through SHU instead of editing Markdown directly, an agent gets the following:
  1. The same piece of work never becomes two tasks (dedupe by reference). A task without refs has nothing to dedupe by, so for it this rests on the `shu` skill (§10), which has the agent look through every task, closed ones included, before creating one
  2. IDs never collide (even between agents running in parallel)
  3. The format never breaks (schema validation)
  4. The log is append-only (the past is never rewritten)
- **The CLI depends on neither the network nor an AI.** It is deterministic and works offline.

## 2. Concepts

| Concept | Description |
|---|---|
| Task | A unit of work: a review request, review feedback on your own PR, a bug investigation, an alert investigation, a fix request, an assigned ticket, and so on |
| Ref | A pointer to where a task came from. A task can have several refs (for example, work that grew from a Slack thread into a ticket and then a PR), or none (work that started in a conversation with an agent; a ref is added when a ticket or a PR appears). A ref can carry a label, one line on what it is to the task (a child ticket for the client API, the PR that fixes it), because most refs name their page only by an ID |
| Log | A chronological record of what happened to a task and what was learned. Append-only |
| Artifact | A file attached to a task: a brief, an investigation report, a fix plan, and so on |

## 3. Storage and layout

The root is `~/.shu`. The `SHU_HOME` environment variable overrides it (tests must always point it at a temporary directory).

```
~/.shu/
  tasks/
    20261001-aoi-kitsune/
      task.md        # metadata (YAML front matter) and body
      log.md         # log (append-only)
      artifacts/     # artifacts
        brief.md
```

### 3.1 task.md

```markdown
---
id: 20261001-aoi-kitsune
title: Investigate double-charged payments
kind: bug-investigation
status: waiting
note: Waiting for the payment provider to reply
refs:
  - slack:https://example.slack.com/archives/C000/p1700000000000000
  - ref: linear:ABC-123
    label: "Ticket: retries without an idempotency key"
  - github:example-org/example-repo#482
created: 2026-10-01T12:00:00+09:00
updated: 2026-10-01T12:34:56+09:00
---

(Optional body: the background, decisions, and conclusions of the task. `save` may overwrite it.)
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Assigned by SHU (§4). Cannot be changed by input |
| `title` | string | ✓ | A one-line heading. Must not be empty |
| `kind` | string | ✓ | The kind of task. Free-form, but the suggested values are `review` / `pr-followup` / `bug-investigation` / `alert-investigation` / `fix-request` / `ticket`. `shu kinds` (§6.8) lists the kinds already in use, so that a writer can reuse one instead of adding a near-duplicate |
| `status` | enum | ✓ | `todo` (not started) / `open` (in progress) / `waiting` (blocked on someone else) / `done` / `dropped` |
| `note` | string | | One line, with no control characters, that says where the task stands: why it is in its status, such as who a `waiting` task is waiting on, or the next step of an `open` one. `list` shows it, and `log` prints it after every entry (§6.5). Cleared when the status changes without a new note (§6.3, §6.9) |
| `refs` | (string \| `{ref, label}`)[] | | Normalized refs (§5), each with an optional label. No duplicates. A ref with a label is written as a mapping, one without as the ref alone |
| `created` | ISO 8601 | ✓ | Set by SHU. Cannot be changed |
| `updated` | ISO 8601 | ✓ | Updated by SHU on every `save`, `status`, or `log --note` that writes the task (a matched save that changes no ref writes nothing, §6.3; nor does a `status` that changes nothing, §6.9). A `log` without `--note` does not write the task, so a log entry newer than `updated` was written after the note and the body were last touched (§10.1) |

Unknown fields are preserved: reading a task and writing it back does not drop them or change their values, and comments in the front matter are kept. The exception is a comment attached to a field that SHU removes (`refs` when the last ref is removed, `note` when the note is cleared): it is removed with the field.

- `title`, `kind`, and `note` are single-line strings with no line breaks. `title` and `kind` must not be empty
- A `note` has no control characters either (a tab and an escape sequence included), nor the Unicode line and paragraph separators (U+2028, U+2029), because `list` prints it inside one line. Blank edges are trimmed first, so a trailing line break is not an error. An empty `note` is the same as no note, and is not written to `task.md`
- If a `task.md` that is read does not match this format (for example, after being edited by hand), the task is not silently skipped; it is an error (`invalid_task`). Skipping it would remove its refs from the dedupe check and lead to duplicate tasks
- A task directory without a `task.md` is considered mid-creation and is treated as if it did not exist
- A build of SHU reads only the statuses it knows. A task whose status was added by a newer build is `invalid_task` to an older build, which makes `list`, `find`, and a `save` with refs fail for the whole store. Upgrade every `shu` that shares a store before saving a task with a new status
- `note` is a field of SHU from 0.4.0. A `note` that was written into a `task.md` by hand before then is read as the note: it must follow the rules above (otherwise the task is `invalid_task`), and it is cleared like any other note. A build older than 0.4.0 keeps `note` as an unknown field, so it does not clear the note when it changes the status. Upgrade every `shu` that shares a store before using notes
- A label follows the rules for a note: one line, with no control characters and no U+2028 or U+2029, and its blank edges trimmed. An empty label is the same as none, and the ref is then written as a string. An item that is a mapping has exactly the keys `ref` and `label`, both strings; anything else is `invalid_task`
- The label is part of the item rather than a field of its own, so that a ref and its label cannot drift apart: removing the ref removes the label, and a stored `url` ref read as another kind (§5) keeps it
- Labels are a feature of SHU from 0.10.0. A build older than that reads a task with a labeled ref as `invalid_task`, which makes `list`, `find`, and a `save` with refs fail for the whole store. A task with no label is written as before, so it stays readable. Upgrade every `shu` that shares a store before labeling a ref

### 3.2 log.md

Append-only. The format of one entry:

```markdown
## 2026-10-01T12:34:56+09:00 claude
Reviewed the PR changes. The likely cause is that the idempotency key is not set on payment retries.
```

- The heading line is `## <ISO 8601> <author>`. The author defaults to `unknown`. The author is a single-line string: it has no line breaks, which includes the Unicode line and paragraph separators (U+2028, U+2029)
- No command rewrites or deletes existing content
- Only a line that starts with `## <ISO 8601>`, where the timestamp is a real date and time, separates entries. Ordinary Markdown headings inside a message (such as `## Findings`) do not
- Appending a message that contains a line of the form `## <ISO 8601> ...` is an error (so that a line cannot pass for a past entry). An empty message is also an error
- Line breaks in a message are stored as LF, so the entry that `log` returns is the entry that `show` reads back

### 3.3 artifacts/

- Any file can be stored. The file name is kept as is
- The file name is a single name directly under `artifacts/`. A name containing a path separator (`/` `\`), `.`, and `..` are errors
- If a file with the same name exists, it is an error. It is overwritten only with `--force`
- On a case-insensitive file system, a name that differs from an existing one only in case names the same file. Without `--force` it is an error; with `--force` the file is replaced and stored under the new spelling

## 4. ID allocation

Format: `YYYYMMDD-<adjective>-<noun>` (for example `20261001-aoi-kitsune`). Like Docker container names, it combines the date with random words.

- The words are romanized Japanese (lowercase letters only). At least 100 adjectives and 100 nouns are bundled in the source code
  - Adjective examples: `aoi` `akai` `shiroi` `shizuka` `hayai` `nagai` `atarashii` `kashikoi`
  - Noun examples: `kitsune` `tanuki` `tsuru` `kame` `sakura` `kawa` `yama` `tsuki`
- The date is the creation date in the local time zone
- **Collisions are avoided by atomic directory creation, not by a lock.** The directory is created with `mkdir` (non-recursive); if it already exists, new words are drawn. After 20 failed attempts it is an error
- Where an ID is expected, **just the words (`aoi-kitsune`) are also accepted**, in addition to an exact match. If they match several tasks, it is an error that lists the candidates

## 5. Refs

The format is `<kind>:<value>`. Refs are normalized when saved.

| Kind | Normal form | Examples of accepted input |
|---|---|---|
| `github` | `github:<owner>/<repo>#<number>` | `https://github.com/owner/repo/pull/482`, `owner/repo#482` |
| `linear` | `linear:<KEY>-<number>` (KEY in uppercase) | `abc-123`, `https://linear.app/<ws>/issue/ABC-123/...` |
| `slack` | `slack:<permalink URL>` | The permalink of a Slack message |
| `notion` | `notion:<page ID>` (32 hexadecimal digits, lowercase, no hyphens) | `https://www.notion.so/<ws>/<title>-<ID>`, `https://app.notion.com/p/<ID>` |
| `url` | `url:<URL>` | Any other `http(s)` URL |

- Input that cannot be normalized is an error (`invalid_ref`)
- `github`: `owner` and `repo` are lowercased (GitHub does not distinguish case). URLs of the form `/pull/<number>` and `/issues/<number>` are accepted, and any path after that (such as `/files`) is ignored
- `slack`: the query and the fragment are dropped. However, if the query has `thread_ts` (the permalink of a reply inside a thread), the ref is **normalized to the permalink of the thread's parent message**, so that a link to any message in a thread dedupes to the same task
- `notion`: a URL on `notion.so` or `notion.com` (bare, or under `www.` or `app.`), or on a subdomain of `notion.site`, whose last path segment is a page ID or ends with `-<page ID>`. Other subdomains (the API, the calendar) carry IDs that are not pages, so their URLs stay `url`. Only the ID is kept: the host, the workspace, the title, the query, and the fragment are dropped, so that every URL of a page dedupes to the same task. The ID is also accepted with the explicit kind (`notion:<ID>`), with or without the hyphens of a UUID, but not on its own: any UUID or 32-digit hash has that shape. However, if the query of such a URL has `p` with a page ID (a page opened as a peek over a database, whose path names the database), the ref is **normalized to the page in `p`**. `p` on a URL whose path has no ID changes nothing
- Input with an explicit kind (`linear:abc-123`, `github:https://github.com/...`, and so on) is also accepted. If the kind detected from the value differs from the given kind, it is an error (for example `linear:owner/repo#1`, or `url:` with a GitHub PR URL)
- `<number>` is a positive integer. Input in the form of a pull request, an issue, or a Linear issue whose number is 0 or too large to be an integer is an error, also when it is a URL (it does not become `url`)
- GitHub, Linear, Slack, and Notion URLs that do not have the forms above (such as a repository's top page) become `url`
- **A stored `url` ref whose URL has a kind of its own is read as that kind.** A URL that was saved as `url` before its kind existed (a Notion page saved before `notion` did) would otherwise make its task invalid and never match another URL of the same thing. Only a `url` ref in the form it was stored in is read this way: a short form after `url:`, or a URL in another spelling, is `invalid_task`, as is every other stored ref that is not in its normal form
  - If that leaves a task with the same ref twice, it is read once, with the first label it has
  - If it leaves two tasks with the same ref (each was saved from a different URL of one page), `find` and a `save` without `id` are `ref_conflict` until one of them drops the ref: `shu save --remove-ref <ref>` with the `id` of that task
  - The file is rewritten in the normal form the next time the task is written, by any command, also one that does not name a ref. A build older than the kind does not know it, so the rewritten task is `invalid_task` to that build, which makes `list`, `find`, and a `save` with refs fail for the whole store. Upgrade every `shu` that shares a store before writing with the newer build
- **A ref belongs to at most one task across all tasks** (the basis of the dedupe in §6.3)

## 6. Commands

Common to all commands:

- Every command accepts `--json`. With it, only JSON is written to standard output (no human-oriented decoration is mixed in)
- On failure the exit code is non-zero. With `--json`, the error is also written to standard output as `{"error": {"code": "...", "message": "..."}}`
- The shape of the JSON stays compatible (fields are not removed and their types do not change). Fields and enum values (such as a `status`) may be added, so a consumer must tolerate the ones it does not know
- Human-oriented errors go to standard error (nothing is written to standard output)
- `--help` together with a command (`shu save --help`) prints the entry of that command from the full usage, under the same `Usage:` heading and followed by a line that points at `shu --help`, and runs nothing. For `log`, the when-to-log text of the full usage comes with it (§10). The other arguments must still parse: an unknown option, or an option without its value, is reported instead
- Options may come before or after the command. `--` ends the options: everything after it is a positional argument, even if it looks like an option

Output shape with `--json`:

| Command | Output |
|---|---|
| `list` | `{"tasks": [<task>]}` (without `body`) |
| `show` | `{"task": <task>, "log": [{"at", "author", "message"}], "log_total": <number>, "artifacts": ["<file name>"]}` |
| `save` | `{"result": "created" \| "updated" \| "matched", "task": <task>, "skipped": ["<field name>"]}` |
| `status` | `{"tasks": [<task>]}` (without `body`) |
| `find` | `{"task": <task>}` |
| `log` | `{"id", "entry": {"at", "author", "message"}, "task": <task>}` (without `body`) |
| `artifact` | `{"id", "name", "path"}` |
| `path` | `{"id", "path"}` |
| `kinds` | `{"kinds": [{"kind", "count"}]}` |
| `--help`, or no command | `{"help": "<usage text>"}` (with a command, the usage of that command) |
| `--version` | `{"version": "<version>"}` |

`<task>` is `{"id", "title", "kind", "status", "note", "refs", "ref_labels", "created", "updated", "body"}`. `refs` is returned as an empty array when the task has none, and `note` as an empty string. `refs` stays an array of strings; `ref_labels` maps each labeled ref to its label, and is `{}` when no ref has one.

Error codes (`error.code`):

| Code | Meaning |
|---|---|
| `invalid_input` | Invalid arguments, options, or input JSON |
| `invalid_ref` | The ref cannot be normalized |
| `invalid_task` | A stored task.md does not match the format (`error.id` holds the ID of that task) |
| `not_found` | The task was not found |
| `ambiguous_id` | The words of an ID match several tasks (`error.candidates` holds the candidate IDs) |
| `ref_conflict` | A ref belongs to another task or to several tasks (`error.candidates` holds the IDs of those tasks) |
| `artifact_exists` | An artifact with the same name already exists |
| `lock_timeout` | A lock could not be acquired |
| `id_exhausted` | No free ID could be found |
| `internal` | An unexpected error |

### 6.1 `shu list`

Lists tasks. By default only those whose `status` is `open` or `waiting`: the work in hand. Tasks that are not started (`todo`) are left out, so that a backlog saved in bulk does not bury it; `--status todo` lists them. When the default list is empty and there are `todo` tasks, the human-readable output says how many, so that it does not read as an empty store.

| Option | Description |
|---|---|
| `--status <s>` | Filter by status (can be repeated) |
| `--kind <k>` | Filter by kind (can be repeated) |
| `--all` | Include every status |

The order is descending by `updated` (descending by ID when the timestamps are equal). Using `--all` together with `--status` is an error.

The human-readable output is one task per line: the ID, the status, the kind, and the title, followed by the note in parentheses when the task has one.

### 6.2 `shu show <id> [--log <n>]`

Shows the details of a task: the metadata, the body, every log entry, and the list of artifact file names.

| Option | Description |
|---|---|
| `--log <n>` | Show only the last `<n>` log entries. `<n>` is a non-negative integer; 0 shows none, and a number larger than the log shows all of it |

A long log is most of what `show` prints, and a reader who wants the body and the latest entries would otherwise cut the output blindly. With `--log`, `log` in the JSON holds only those entries. So that a shortened log does not read as the whole of it, `log_total` in the JSON is the number of entries the task has, with or without `--log`, and the human-readable output says how many there are when it leaves some out (`# Log (last 2 of 12)`).

The human-readable output prints each ref on a line of its own, followed by its label in parentheses when it has one.

### 6.3 `shu save`

Creates or updates a task (upsert). Takes JSON from standard input.

```json
{
  "id": "20261001-aoi-kitsune",
  "title": "Investigate double-charged payments",
  "kind": "bug-investigation",
  "status": "waiting",
  "note": "Waiting for the payment provider to reply",
  "refs": [
    "https://github.com/example-org/example-repo/pull/482",
    {"ref": "ABC-123", "label": "Ticket: retries without an idempotency key"}
  ],
  "body": "A retry without an idempotency key charges twice."
}
```

How the target task is chosen:

1. If `id` is given, that task is updated (an error if it does not exist)
2. If `id` is not given and any of `refs` belongs to an existing task, the save resolves to that task (**dedupe**) and is a matched save (see below)
3. If `refs` belong to **two or more different existing tasks**, it is an error (tasks are never merged automatically). When `id` is given, it is also an error if any of `refs` belongs to **another task** (to keep "a ref belongs to at most one task" from §5)
4. If none of the above applies, a new task is created (`title` and `kind` are required; `status` defaults to `open`, so work that is not started is saved with `todo`)

Update rules:

- With `id`, only the given fields are updated (partial update). The one exception is the note, which a change of status clears (below)
- `refs` are **added to the existing ones** (not replaced). A ref is removed explicitly with `--remove-ref <ref>`, and its label with it
- An item of `refs` is a ref, or `{"ref": "<ref>", "label": "<label>"}`. A label is given together with its ref: it replaces the stored label, and an empty label removes it. A ref given without a label keeps the label it has, so a save that only lists refs (a matched save from a sync, for one) never drops a label. A label that breaks the rules in §3.1, a mapping with other keys, and the same ref given twice with different labels are errors (`invalid_input`)
- `id` and `created` cannot be changed
- The only input fields are `id` / `title` / `kind` / `status` / `note` / `refs` / `body`. Anything else (including `created` / `updated` and misspellings) is an error
- `--remove-ref` can be repeated. Naming a ref that the target task does not have does nothing (it is not an error). Naming the same ref in both `refs` and `--remove-ref` is an error
- `--remove-ref` is not used to choose the target task. If the save does not resolve to an existing task (by `id` or by `refs`), `--remove-ref` is an error and no task is created
- An empty `body` clears the body, and an empty `note` clears the note
- A note says why the task is in its status, so it does not outlive that status: a save that changes `status` without giving `note` clears the note. A save that leaves the status as it is keeps the note

Matched saves (a save without `id` that resolves to an existing task):

- **Only refs and their labels change.** The input's `refs` are added, with their labels, and `--remove-ref` is applied. `title`, `kind`, `status`, `note`, and `body` are not applied. Input written to create a task therefore never overwrites a task that already exists, and a sync can be run again without moving a task back to an earlier status
- The output names, in `skipped`, the input fields whose value differs from the stored one. To apply them, save again with the `id`
- A matched save that changes no ref and no label writes nothing: the task stays as it is, including `updated`

The output includes a field that tells whether the task was created, updated, or matched by dedupe (`"result": "created" | "updated" | "matched"`). `skipped` is an empty array unless the save matched.

### 6.4 `shu find --ref <ref>`

Looks up a task from a ref. The input goes through the normalization in §5 before matching. If nothing is found, the exit code is non-zero. With `--json` the exit code is also non-zero and the output is `{"error": {"code": "not_found", ...}}` (so that the error shape matches the other commands and callers can branch on the exit code alone).

If the ref is found on more than one task (which can only happen when files were edited by hand, or when two tasks hold `url` refs that are now read as one ref, §5), it is an error (`ref_conflict`), the same as for `save`.

### 6.5 `shu log <id> [message] [--note <text>]`

Appends one entry to the log. If `message` is omitted, it is read from standard input. `--author <name>` sets the author. Without `--note`, `task.md` (including `updated`) is not changed.

The output carries the task as it stands after the command. Without `--note`, the human-readable output prints its note (`none` when it has none) and its `updated`, and a line that points at `--note` and at `save`; with `--note`, only the note it set. An agent writes entries as a habit but has no other moment to notice that an entry has outdated the note or the body, so the note is put in front of it every time.

Every `log` reads the task before it appends, so a task whose `task.md` cannot be read (`invalid_task`) takes no entry, with or without `--note`, until it is fixed.

- `--note <text>` also sets the note, the same as `status` does (§6.9) but without changing the status. It can be given only once. An empty text clears it. A text that breaks the rules for a note (§3.1) is an error (`invalid_input`), and nothing is written. A text that starts with `-` is written `--note=<text>`
- With `--note`, the task lock (§7) is taken before the entry is appended, and the entry and `task.md` are written under it, so a `lock_timeout` leaves both as they were and the command can be run again
- With `--note`, the entry's time is read once the lock is held, and `updated` is set to that same time. The task is written even when the note is unchanged, so `updated` records that the note was checked against this entry (§10.1). An entry that another `log` without `--note` appended in the same second, or that took its time before the lock and was appended after it, is not newer than `updated` either

A message that starts with `-` would be read as an option. Put it after `--` (`shu log <id> -- "- a bullet"`) or pass it on standard input.

A message is Markdown, kept to bullet lists (`- `), inline code, and links. An entry that packs several points into one line (joined by ` / ` or numbered `(1) (2)`) is hard to read, and headings and tables are too big for one entry. The help text and the `shu` skill (§10) say how to write one; the CLI does not check it, and stores the message as it is. A line of the form `## <ISO 8601> ...` is still refused (§3.2); a heading such as `## Findings` is not, and the extension shows it as a bold line (§11).

### 6.6 `shu artifact <id> <file>`

Stores (copies) a file as an artifact.

| Option | Description |
|---|---|
| `--name <name>` | The file name to store it under. Required when `<file>` is `-` (read from standard input) |
| `--force` | Overwrite a file with the same name |

### 6.7 `shu path <id>`

Prints the absolute path of the task directory. Agents use it to read artifacts directly.

### 6.8 `shu kinds`

Lists the kinds in use, with the number of tasks of each. Tasks of every status are counted.

The order is descending by count. Kinds with the same count are in ascending order, compared by UTF-16 code unit (so uppercase sorts before lowercase), which does not depend on the locale.

### 6.9 `shu status <status> <id>... [--note <text>]`

Sets the status of one or more tasks. Only `status`, `note`, and `updated` change.

- `--note <text>` sets the note of every task named, so it can be given only once. An empty text clears it. A text that breaks the rules for a note (§3.1) is an error (`invalid_input`), checked before anything is written
- A text that starts with `-` would be read as an option. Write it as `--note=<text>` (`shu status waiting <id> --note="- a bullet"`)
- Without `--note`, a task whose status changes loses its note, the same as in `save` (§6.3)
- A task that already has that status, and that note if one is given, is not written: its `updated` stays, so running the command again does not reorder the list

- Every `<id>` is checked before anything is written. If the status is not a known one (`invalid_input`), or any `<id>` is not a task ID (`invalid_input`) or does not resolve to a task that can be read (`not_found`, `ambiguous_id`, `invalid_task`), it is an error and no task is changed
- Naming the same task more than once (for example by its full ID and by its words) updates it once
- The tasks are then updated one at a time, each under its own lock (§7). The command is not atomic across tasks: if an update fails after the check (for example `lock_timeout`, or a task that became unreadable or unwritable since the check), the tasks before it stay updated. Running the command again finishes the rest and leaves the tasks already updated as they are
- Each task goes to whichever command wrote it last. Two commands that set different statuses on the same tasks at the same time can each win some of them
- The output lists the tasks in the order they were given, including those that were not written

## 7. Concurrency safety

SHU is built on the assumption that several agents call it at the same time.

- **Creation**: collisions are prevented by the atomic directory creation in §4
- **Writing task.md**: written to a temporary file and then put in place with `rename` (no intermediate state is visible)
- **Conflicting updates to task.md**: a per-task lock file (`tasks/<id>/.lock`, created with `O_EXCL`) is taken before the read → update → write. If the lock cannot be taken, it is retried at short intervals and given up as an error after a set time. A stale lock (not modified for a set time) may be taken over. `updated` is the time read after the lock is taken, so a save that had to wait never writes an older `updated` over a newer one
- **Conflicting dedupe**: the ref uniqueness check and the save that follows run inside a global lock (`~/.shu/.lock`). Only a `save` whose input has `refs` or `--remove-ref` takes the global lock (an update that leaves refs alone cannot affect dedupe, so it runs under the per-task lock only). When both are taken, the order is always the global lock, then the task lock
- **Lock timing**: the retry interval is 20–40 ms, a lock attempt is given up after 15 seconds as an error (`lock_timeout`), and a lock last modified 10 or more seconds ago is considered stale and is taken over. The wait is the longer of the two, so that a waiter can take over a lock left behind by a crashed process and proceed
- **A live holder's lock does not go stale**: while a process waits for a lock, it keeps refreshing the modification time of the locks it already holds. Without this, a save that holds the global lock while waiting for a task lock would look dead after 10 seconds and lose the global lock to another save
- **Taking over a stale lock**: only one process at a time may take over a given lock. It claims that right by creating a guard file (`<lock>.steal`) with `O_EXCL`, checks under the guard that the lock is still stale, and then renames the guard over the lock. The lock path is never empty during a takeover, so no third process can create the lock in between. Releasing a lock takes the same guard, so a takeover cannot swap the lock between the release's ownership check and its unlink. A guard left behind by a crashed process is removed once it is stale
- **log.md**: one entry is written with a single write in append mode
- **Artifacts**: the file is written completely to a temporary file and then placed in `artifacts/`. Without `--force` it is placed with an operation that fails if the name is taken (a hard link), so that exactly one of several simultaneous saves succeeds

## 8. Technology

- TypeScript and Bun
- Tests run with `bun test`. They point `SHU_HOME` at a temporary directory and verify against real files
- The distributable is a single executable produced by `bun build --compile`
- Dependencies are kept to a minimum (reading and writing YAML, schema validation, and little else)

## 9. Out of scope (not done at this stage)

- Data collection (connecting to GitHub, Linear, or Slack). The one exception is the `shu-triage` skill (§10.1), which does it from outside the CLI
- Calling an AI
- An MCP server
- A web view or a local server. The browser extension (§11) is neither: it shows what the CLI prints for one page, through a script the browser starts for each lookup, and listens on nothing

## 10. Skills

- `skills/shu/SKILL.md` teaches an agent to read and write task information through SHU. The skills are installed with `npx skills add dim0627/shu`
- The `shu` skill is kept thin: when to reach for SHU, when to log, what belongs in refs, the body, the log, and artifacts, and a handful of example commands. `shu --help` remains the full usage, and the skill does not restate it
- The skill tells the agent where each kind of information goes. The next step goes in the note and nowhere else, and the body holds the background, the decisions, and the conclusions, not the current state: a fact written in two places goes stale in one of them. After an entry, `log` prints the note (§6.5), and the skill has the agent update the note (`--note`) or the body when the entry outdated it
- The skill reaches for SHU for any work worth picking up again or looking back on, whatever it came from: a PR, a ticket, a Slack thread, a document, or only a conversation (a verification, an investigation, a design discussion) that reached a conclusion or a next step. A question answered on the spot is not a task. Before it creates a task without refs, the agent looks for the same work in `shu list --all` and updates that task by `id` if it is there, and a ref that appears later is added to the existing task. The CLI has no other key to dedupe such a task by: a free-form key chosen by the agent would not be chosen the same way twice, so it would catch no more than reading the list does
- Before the agent reads a PR, a ticket, a Slack thread, or a document by its URL, the skill has it run `shu find --ref` with that URL, including one it only reads for reference during other work, such as someone else's PR. What an earlier session stored for it (a brief, a review, the log) is read before the source. A miss means there is nothing to read first, not that a task should be made: a read for reference is not a task
- The one thing written in both is when to log: the moments that call for an entry (a lookup or a subagent returns, the user voices a concern, a preference, or a decision, the agent is about to wait for an answer), and that an entry is written before anything is settled. An agent can learn the commands from `shu --help` without loading the skill, and one that does would otherwise never be told when to log. A test keeps the moments named in the help and in the skill's "When to log" section the same, in both directions, and checks that both carry the two sentences on what is unsettled. The skill's description and this section repeat the moments and are kept in step by hand
- The skill has the agent label a ref whose ID alone does not say what it is: its relation to the task (a child ticket, the PR that fixes it) and its topic. The title of a page changes, so a label is worth more for the relation, which does not; when the agent sees that a label no longer fits, it saves the ref again with a new one. A label is written by the agent from what it already read, because the CLI collects nothing (§1)
- The skill and the help text of `log` have the agent write an entry in Markdown kept to bullets, inline code, and links (§6.5), and the skill shows one such entry among its examples
- The `shu` skill does not collect data either. How to query GitHub, Linear, or Slack, and how to classify what comes back, is left to the agent and to the user's own skills

### 10.1 `shu-triage`

A task is a hand-written copy of facts that live elsewhere (a pull request, a deploy, a reply), and the copy goes stale: a task stays `open` after its pull request is merged, or `waiting` on a deploy that has shipped. An agent that recommends work from `shu list` alone recommends from the stale copy. `skills/shu-triage/` is for the question "what should I work on next": a script that checks the tasks against their sources, and a skill that tells the agent how to act on the result.

- `triage.py` runs outside the CLI, with `python3` (standard library only), `gh`, and `git`. The CLI stays offline and deterministic (§1)
- **The script writes nothing to SHU.** It reads through `shu list`, `shu show`, and `shu path`. Bringing a task up to date is the agent's job, through the CLI
- It covers the `open`, `waiting`, and `todo` tasks. Run inside a clone whose `origin` or `upstream` (a fork's) is on GitHub, it covers only those with a pull request or an issue in one of those repositories, by a ref or by a title (below), and lists only the user's own pull requests there: a question asked in a repository is about that repository's work. A task with no ref, or with refs elsewhere only, is left out, and the output says how many were. A task in scope keeps all its pull requests, those elsewhere included, so its marks do not depend on where the script runs. `--all`, or a run outside such a clone, covers every task. A remote counts as GitHub when its host is `github.com`, `ssh.github.com`, or a `github.com-<name>` alias; another SSH alias is not recognized, and the run then covers every task. A missing `git` is a failed lookup, and the run covers every task
- It looks up:
  - every `github` ref, in one GraphQL request (a ref does not say whether it is a pull request or an issue, §5)
  - the user's own pull requests: the open ones, and those merged in the last 14 days. Each of the two searches reads at most 200
  - for a repository listed in the config, whether a merged pull request's merge commit is in a deploy tag. Only tags of the configured pattern are fetched, so the clone's branches and other tags are left alone. A pull request merged into a branch other than the default one is not looked for
- `linear`, `slack`, `notion`, and `url` refs are not looked up. They are printed as such, and the skill tells the agent when to look them up
- One of the user's own pull requests that no task refs:
  - joins a task in hand when its title carries the key of one of that task's `linear` refs, read the way §5 normalizes a key (any case, leading zeros dropped). It then counts toward that task's marks and is printed as matched by title. A `review` task is never joined this way, because its pull requests are someone else's. A merged pull request joined only by its title drops out when it leaves the 14-day search, so the skill tells the agent to add the ref
  - otherwise, when open: listed if it was created in the last 30 days, counted if older
  - otherwise, when merged: counted, unless its title carries the key of a closed task
- An open pull request of the user's that belongs to a `done` or `dropped` task, by a ref or by its title, is listed
- Marks, each meaning "check this task", never "change it". An issue ref, and a pull request closed without merging, do not count toward a mark. A `github` ref that could not be read prevents `merged` and `shipped`:

  | Mark | Condition |
  |---|---|
  | `merged` | `open` or `todo`, at least one pull request, and all of them merged. Also `waiting` with the same, when none of the pull requests is in a repository with a configured deploy tag |
  | `started` | `todo`, with an open pull request |
  | `shipped` | `waiting`, all pull requests merged, at least one of them in a repository with a configured deploy tag, and all of those in a tag |
  | `blank` | `open` or `waiting`, no pull request, and an empty body or no log entry other than the skill's own (author `shu-triage`) |
  | `log-ahead` | `open`, `waiting`, or `todo`, and a log entry other than the skill's own that is newer than the task's `updated`. Such an entry was written after the note, the body, and the status were last touched (§3.1), so they may say less than the log. The skill has the agent read the whole log before it recommends the task, and bring the note and the body up to it |

  `updated` stands in for the time the note was last checked, which SHU does not keep. So the mark misses some entries: any write of `task.md` moves `updated` past the log, a save that only adds a ref included, and timestamps are whole seconds, so an entry written in the same second as `updated` is not newer. The skill has the agent bring the note up to the log before it writes the task for another reason. A `status` with the status and the note the task already has writes nothing, so it does not clear the mark


- A task without refs, covered only by a run of every task, has no source to check, so it can carry `blank` and `log-ahead` and nothing else. The skill has the agent read every such task and ask the user whether to close one whose work reads as finished
- A mark depends only on the task (its status, body, log, and `updated`) and what the lookups return, so a task the agent rightly left as it is carries the same mark on the next run. `log-ahead` is the exception the agent can clear without a change: `shu log --note` with the same note moves `updated` past the log. The skill has the agent say in its answer what it did with every marked task
- **A lookup that fails is reported, not treated as "nothing found".** The first line of the output is then `LOOKUPS FAILED`, followed by what failed; otherwise it is `lookups: all succeeded`. A failure can remove a mark and can also add a wrong one (a failed search hides an open pull request that only its title ties to a task, so the task reads as `merged`). A program or a clone directory that is missing counts as a failed lookup. A GraphQL response is read per ref, so one unreadable ref does not discard the others. Only a failing `shu` stops the script, with how to install the latest
- Standard output is short enough for an agent to read whole: a `scope:` line saying which tasks it covers, then for each task one line with its marks (or `no tasks in scope`), then one line per pull request and one for the refs that were not looked up. The full text (body and the last three log entries of each task, and for a `log-ahead` task how many entries are newer than `updated`) goes to a file, whose path is the last line
- Files, under `~/.local/state/shu-triage/` (`XDG_STATE_HOME`; `SHU_TRIAGE_STATE` overrides): `last.md`, `runs.jsonl` (one line per run: the repositories it was scoped to and how many tasks it left out, counts per status of the tasks it covered, and the IDs under each mark), and `backup/<time>/` with a copy of every `task.md` read, because a body or a note overwritten by `save` is kept nowhere else. A task whose copy could not be made is named in a `WARNING` line
- Config, at `~/.config/shu-triage/config.json` (`XDG_CONFIG_HOME`; `SHU_TRIAGE_CONFIG` overrides): `{"deployTags": {"<owner>/<repo>": {"clone": "<path>", "pattern": "<tag pattern>"}}}`. The pattern is used both as a fetch refspec and as a `git tag` pattern, so it may hold one `*` and no `?` or `[`. Without the config there is no `shipped` mark
- Tests run the script against a temporary `SHU_HOME`, `SHU_TRIAGE_STATE`, and `SHU_TRIAGE_CONFIG`, with stand-ins for `gh` and `git` on `PATH`, so they stay offline and never touch the real `~/.local/state` or `~/.config`

## 11. Browser extension

While the user reads a pull request, a ticket, or a document in the browser, the task that refs it, and what is already stored for it (artifacts, the latest log entries), is one lookup away: `shu find --ref` with the page's URL. `browser/` puts that lookup in Google Chrome.

- `browser/chrome/` is the extension. It marks the toolbar icon of a tab whose page a task refs, and its popup shows the task's ID, status, kind, note, refs (each as a link to the page it names, with its label when it has one), artifact names (each with a button that copies its path), the last three log entries (and how many there are when some are left out), and the body
- The log entries and the body are rendered as Markdown, but only bullet lists (`- ` and `* `, nested one level below the list's first bullet), inline code, fenced code blocks, links (`[text](url)` and bare URLs), bold, headings, and paragraphs with their line breaks kept. A heading is shown as one bold line, not at a heading's size. Bold is only a tight pair (`**x**`, with no space inside either end) and never a `**` next to a `/`, so a glob such as `test/**/*.test.js` stays as written. Anything else stays as written, because entries already hold text that a full renderer would change: raw HTML and strings that look like it (`<!channel>`, `<url|text>`) are never rendered as HTML, and a single `*` and an `_` inside a word are never emphasis. Only a line that starts with three backticks and has no backtick after them opens a code block, so three backticks inside a sentence, or around code on one line, are not a code block. A link is made only for an `http(s)` URL, and opens in a new tab; any other `[text](url)` stays as text. A bare URL ends at its first character outside ASCII, so that text written right after it stays out of the link; a URL with such characters is linked whole only as `[text](url)`. The renderer returns a tree that the popup builds from text nodes, never from HTML. It is written in the extension rather than taken from a library: an extension can load no remote script, and the subset is small
- The mark is looked up when a tab loads a page or changes its URL, when the user switches to a tab (the store may have changed meanwhile), for every tab when the extension is installed or the browser starts, and again when the popup opens. A tab left open while the store changes keeps its mark until one of those
- **It only reads.** It changes nothing in SHU and offers no command that does
- An extension cannot run programs, so it asks `browser/host.py` through Chrome's Native Messaging. Chrome starts the script for a lookup and stops it after. The script runs outside the CLI, with `python3` (standard library only), and answers through `shu find --ref`, `shu show --log 3`, and `shu path`, the same JSON any consumer reads (§6), so it needs `shu` 0.6.0 or later. The CLI knows nothing of the browser
- A message is `{"url": "<page URL>"}`. The answer is `{"task": null}` when the page is not `http(s)`, when `shu` cannot read the URL as a ref (`invalid_ref`), or when no task refs it (`not_found`); otherwise the output of `shu show` with `"path"` (the task directory) added. A `url` ref keeps its fragment (§5), so when the URL has one and nothing refs it, the URL without it is looked up too; the query is kept, since it can name another page
- Any other failure of `shu`, or a `shu` that cannot be found, is passed on as `{"error": {"code", "message"}}` and shown as such, never as "no task". A failure that comes from an older `shu` (`invalid_input`), or a missing one, says how to install the latest. `find` reads every task, so one unreadable `task.md` marks every `http(s)` page with the error until it is fixed
- Chrome started from the Dock gets neither the user's shell `PATH` nor `SHU_HOME`, and a store read from the wrong place would answer "no task" for every page. So `browser/install.sh` records the `shu` found on `PATH` and the `SHU_HOME` of the shell it runs in (which must be absolute), in `~/.config/shu/browser-host.json` (`XDG_CONFIG_HOME`). The script uses the recorded `shu`, else one on `PATH`; and `SHU_HOME` from its environment, else the recorded one
- `browser/install.sh <extension ID>` registers the script with Google Chrome (macOS and Linux) for that one extension; `SHU_CHROME_HOSTS_DIR` points it at another Chromium browser's folder. The extension is loaded unpacked from a clone of this repository; it is not published to the Chrome Web Store, and the release (§8) does not ship it
- Tests run the script against a temporary `SHU_HOME` and `HOME`, with stand-ins for `shu`, and point `install.sh` at a temporary directory (`SHU_CHROME_HOSTS_DIR`). Of the extension, the links built from refs and the Markdown rendering are tested as functions, and the badge chosen for an answer with a stand-in for the `chrome` API; its pages and events are not tested automatically
