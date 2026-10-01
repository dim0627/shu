# SHU specification

SHU (朱) is a local task store CLI through which humans and AI agents (mainly Claude Code) read and write information about the tasks of software development work.

## 1. Positioning

- **SHU does not collect data.** Gathering information from GitHub, Linear, Slack and so on is the AI agent's job (`gh`, MCP).
- **SHU's only responsibility is file input and output.** Listing tasks, fetching a task, saving a task, appending to its log, and storing artifacts.
- **SHU exists to enforce a few guarantees.** By going through SHU instead of editing Markdown directly, an agent gets the following:
  1. The same piece of work never becomes two tasks (dedupe by reference)
  2. IDs never collide (even between agents running in parallel)
  3. The format never breaks (schema validation)
  4. The log is append-only (the past is never rewritten)
- **The CLI depends on neither the network nor an AI.** It is deterministic and works offline.

## 2. Concepts

| Concept | Description |
|---|---|
| Task | A unit of work: a review request, review feedback on your own PR, a bug investigation, an alert investigation, a fix request, an assigned ticket, and so on |
| Ref | A pointer to where a task came from. A task can have several refs (for example, work that grew from a Slack thread into a ticket and then a PR) |
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
status: open
refs:
  - slack:https://example.slack.com/archives/C000/p1700000000000000
  - linear:ABC-123
  - github:example-org/example-repo#482
created: 2026-10-01T12:00:00+09:00
updated: 2026-10-01T12:34:56+09:00
---

(Optional body, such as the current summary of the task. `save` may overwrite it.)
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Assigned by SHU (§4). Cannot be changed by input |
| `title` | string | ✓ | A one-line heading. Must not be empty |
| `kind` | string | ✓ | The kind of task. Free-form, but the suggested values are `review` / `pr-followup` / `bug-investigation` / `alert-investigation` / `fix-request` / `ticket` |
| `status` | enum | ✓ | `open` / `waiting` / `done` / `dropped` |
| `refs` | string[] | | Normalized refs (§5). No duplicates |
| `created` | ISO 8601 | ✓ | Set by SHU. Cannot be changed |
| `updated` | ISO 8601 | ✓ | Updated by SHU on every save |

Unknown fields are preserved (reading a task and writing it back does not drop them).

- `title` and `kind` are single-line strings with no line breaks
- If a `task.md` that is read does not match this format (for example, after being edited by hand), the task is not silently skipped; it is an error (`invalid_task`). Skipping it would remove its refs from the dedupe check and lead to duplicate tasks
- A task directory without a `task.md` is considered mid-creation and is treated as if it did not exist

### 3.2 log.md

Append-only. The format of one entry:

```markdown
## 2026-10-01T12:34:56+09:00 claude
Reviewed the PR changes. The likely cause is that the idempotency key is not set on payment retries.
```

- The heading line is `## <ISO 8601> <author>`. The author defaults to `unknown`. The author is a single-line string with no line breaks
- No command rewrites or deletes existing content
- Only a line that starts with `## <ISO 8601>` separates entries. Ordinary Markdown headings inside a message (such as `## Findings`) do not
- Appending a message that contains a line of the form `## <ISO 8601> ...` is an error (so that a line cannot pass for a past entry). An empty message is also an error

### 3.3 artifacts/

- Any file can be stored. The file name is kept as is
- The file name is a single name directly under `artifacts/`. A name containing a path separator (`/` `\`), `.`, and `..` are errors
- If a file with the same name exists, it is an error. It is overwritten only with `--force`

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
| `url` | `url:<URL>` | Any URL that matches none of the above |

- Input that cannot be normalized is an error (`invalid_ref`)
- `github`: `owner` and `repo` are lowercased (GitHub does not distinguish case). URLs of the form `/pull/<number>` and `/issues/<number>` are accepted, and any path after that (such as `/files`) is ignored
- `slack`: the query and the fragment are dropped. However, if the query has `thread_ts` (the permalink of a reply inside a thread), the ref is **normalized to the permalink of the thread's parent message**, so that a link to any message in a thread dedupes to the same task
- Input with an explicit kind (`linear:abc-123`, `github:https://github.com/...`, and so on) is also accepted. If the kind detected from the value differs from the given kind, it is an error (for example `linear:owner/repo#1`, or `url:` with a GitHub PR URL)
- GitHub, Linear, and Slack URLs that do not match the forms above (such as a repository's top page) become `url`
- **A ref belongs to at most one task across all tasks** (the basis of the dedupe in §6.3)

## 6. Commands

Common to all commands:

- Every command accepts `--json`. With it, only JSON is written to standard output (no human-oriented decoration is mixed in)
- On failure the exit code is non-zero. With `--json`, the error is also written to standard output as `{"error": {"code": "...", "message": "..."}}`
- The shape of the JSON stays compatible (fields are not removed and their types do not change)
- Human-oriented errors go to standard error (nothing is written to standard output)

Output shape with `--json`:

| Command | Output |
|---|---|
| `list` | `{"tasks": [<task>]}` (without `body`) |
| `show` | `{"task": <task>, "log": [{"at", "author", "message"}], "artifacts": ["<file name>"]}` |
| `save` | `{"result": "created" \| "updated" \| "matched", "task": <task>}` |
| `find` | `{"task": <task>}` |
| `log` | `{"id", "entry": {"at", "author", "message"}}` |
| `artifact` | `{"id", "name", "path"}` |
| `path` | `{"id", "path"}` |

`<task>` is `{"id", "title", "kind", "status", "refs", "created", "updated", "body"}`. `refs` is returned as an empty array when the task has none.

Error codes (`error.code`):

| Code | Meaning |
|---|---|
| `invalid_input` | Invalid arguments, options, or input JSON |
| `invalid_ref` | The ref cannot be normalized |
| `invalid_task` | A stored task.md does not match the format |
| `not_found` | The task was not found |
| `ambiguous_id` | The words of an ID match several tasks (`error.candidates` holds the candidate IDs) |
| `ref_conflict` | A ref belongs to another task or to several tasks (`error.candidates` holds the IDs of those tasks) |
| `artifact_exists` | An artifact with the same name already exists |
| `lock_timeout` | A lock could not be acquired |
| `id_exhausted` | No free ID could be found |
| `internal` | An unexpected error |

### 6.1 `shu list`

Lists tasks. By default only those whose `status` is `open` or `waiting`.

| Option | Description |
|---|---|
| `--status <s>` | Filter by status (can be repeated) |
| `--kind <k>` | Filter by kind (can be repeated) |
| `--all` | Include every status |

The order is descending by `updated` (descending by ID when the timestamps are equal). Using `--all` together with `--status` is an error.

### 6.2 `shu show <id>`

Shows the details of a task: the metadata, the body, every log entry, and the list of artifact file names.

### 6.3 `shu save`

Creates or updates a task (upsert). Takes JSON from standard input.

```json
{
  "id": "20261001-aoi-kitsune",
  "title": "Investigate double-charged payments",
  "kind": "bug-investigation",
  "status": "open",
  "refs": ["https://github.com/example-org/example-repo/pull/482"],
  "body": "Current summary…"
}
```

How the target task is chosen:

1. If `id` is given, that task is updated (an error if it does not exist)
2. If `id` is not given and any of `refs` belongs to an existing task, that task is updated (**dedupe**)
3. If `refs` belong to **two or more different existing tasks**, it is an error (tasks are never merged automatically). When `id` is given, it is also an error if any of `refs` belongs to **another task** (to keep "a ref belongs to at most one task" from §5)
4. If none of the above applies, a new task is created (`title` and `kind` are required; `status` defaults to `open`)

Update rules:

- Only the given fields are updated (partial update)
- `refs` are **added to the existing ones** (not replaced). A ref is removed explicitly with `--remove-ref <ref>`
- `id` and `created` cannot be changed
- The only input fields are `id` / `title` / `kind` / `status` / `refs` / `body`. Anything else (including `created` / `updated` and misspellings) is an error
- `--remove-ref` can be repeated. Naming a ref that the target task does not have does nothing (it is not an error). Naming the same ref in both `refs` and `--remove-ref` is an error
- An empty `body` clears the body

The output includes a field that tells whether the task was created, updated, or matched by dedupe (`"result": "created" | "updated" | "matched"`).

### 6.4 `shu find --ref <ref>`

Looks up a task from a ref. The input goes through the normalization in §5 before matching. If nothing is found, the exit code is non-zero. With `--json` the exit code is also non-zero and the output is `{"error": {"code": "not_found", ...}}` (so that the error shape matches the other commands and callers can branch on the exit code alone).

### 6.5 `shu log <id> [message]`

Appends one entry to the log. If `message` is omitted, it is read from standard input. `--author <name>` sets the author. `task.md` (including `updated`) is not changed.

### 6.6 `shu artifact <id> <file>`

Stores (copies) a file as an artifact.

| Option | Description |
|---|---|
| `--name <name>` | The file name to store it under. Required when `<file>` is `-` (read from standard input) |
| `--force` | Overwrite a file with the same name |

### 6.7 `shu path <id>`

Prints the absolute path of the task directory. Agents use it to read artifacts directly.

## 7. Concurrency safety

SHU is built on the assumption that several agents call it at the same time.

- **Creation**: collisions are prevented by the atomic directory creation in §4
- **Writing task.md**: written to a temporary file and then put in place with `rename` (no intermediate state is visible)
- **Conflicting updates to task.md**: a per-task lock file (`tasks/<id>/.lock`, created with `O_EXCL`) is taken before the read → update → write. If the lock cannot be taken, it is retried at short intervals and given up as an error after a set time. A stale lock (older than a set time) may be stolen
- **Conflicting dedupe**: the ref uniqueness check and the save that follows run inside a global lock (`~/.shu/.lock`). Only a `save` whose input has `refs` or `--remove-ref` takes the global lock (an update that leaves refs alone cannot affect dedupe, so it runs under the per-task lock only). When both are taken, the order is always the global lock, then the task lock
- **Lock timing**: the retry interval is 20–40 ms, a lock attempt is given up after 15 seconds as an error (`lock_timeout`), and a lock last modified 10 or more seconds ago is considered stale and is stolen. The wait is the longer of the two, so that a waiter can steal a lock left behind by a crashed process and proceed
- **log.md**: one entry is written with a single write in append mode
- **Artifacts**: the file is written completely to a temporary file and then placed in `artifacts/`. Without `--force` it is placed with an operation that fails if the name is taken (a hard link), so that exactly one of several simultaneous saves succeeds

## 8. Technology

- TypeScript and Bun
- Tests run with `bun test`. They point `SHU_HOME` at a temporary directory and verify against real files
- The distributable is a single executable produced by `bun build --compile`
- Dependencies are kept to a minimum (reading and writing YAML, schema validation, and little else)

## 9. Out of scope (not done at this stage)

- Data collection (connecting to GitHub, Linear, or Slack)
- Calling an AI
- An MCP server
- A web view or a local server
- A skill for Claude Code (to be made separately once the CLI is complete)
