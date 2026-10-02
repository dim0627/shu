# SHU

SHU (朱) is a local task store for humans and AI agents. It is a small CLI that keeps what you know about each piece of work — its state, its history, and the files produced along the way — as plain Markdown under `~/.shu`.

It is built for working alongside a coding agent such as Claude Code. The agent gathers information from GitHub, Linear, Slack and so on; SHU is where that understanding is written down, so it survives the session that produced it.

## Why a CLI instead of editing Markdown directly

Agents can edit files on their own. SHU sits in between to enforce a few guarantees that are easy to break by hand, especially when several agents run at once:

- **No duplicate tasks.** A task is looked up by its references (a PR, a ticket, a Slack thread) before a new one is created.
- **No ID collisions.** IDs are allocated by atomically creating the task directory.
- **No malformed tasks.** Input and stored files are validated against a schema.
- **History is append-only.** There is no command that rewrites or deletes a log entry.

SHU itself never touches the network and never calls an AI. It is deterministic and works offline.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/dim0627/shu/main/scripts/install.sh | sh
```

This downloads the binary for your platform from the latest [release](https://github.com/dim0627/shu/releases), verifies its SHA-256 against the release's `checksums.txt`, and puts it at `~/.local/bin/shu`. macOS and Linux are supported, on arm64 and x64.

| Variable | Effect |
|---|---|
| `SHU_VERSION` | Install this release tag (for example `v0.1.0`) instead of the latest. |
| `SHU_INSTALL_DIR` | Install into this directory instead of `~/.local/bin`. |

### From source

Requires [Bun](https://bun.sh).

```sh
bun install
bun run build        # produces a single executable at dist/shu
cp dist/shu /usr/local/bin/   # or anywhere on your PATH
```

### Skill for coding agents

```sh
npx skills add dim0627/shu
```

This installs a small skill that tells an agent such as Claude Code when to reach for SHU and what to store in it. A skill is picked up by matching its description, so it is not guaranteed to fire every time. If you want the agent to reach for SHU more reliably, also add a line about it to your own `CLAUDE.md` or `AGENTS.md`.

## Quick start

```sh
# Create a task. The JSON comes from standard input.
echo '{
  "title": "Investigate double-charged payments",
  "kind": "bug-investigation",
  "refs": ["https://github.com/example-org/example-repo/pull/482"]
}' | shu save
# => created 20261001-aoi-kitsune

# Saving again with the same reference finds that task instead of creating another,
# and adds the new reference to it.
echo '{"refs": ["example-org/example-repo#482", "ABC-123"]}' | shu save
# => matched 20261001-aoi-kitsune

# Update a task by its ID.
echo '{"id": "aoi-kitsune", "status": "waiting"}' | shu save
# => updated 20261001-aoi-kitsune

# Record what happened.
shu log aoi-kitsune "The retry path does not set an idempotency key." --author claude

# Attach a file.
shu artifact aoi-kitsune ./brief.md

# Read it back, from any session.
shu list
shu show aoi-kitsune
shu find --ref ABC-123
```

## Commands

| Command | What it does |
|---|---|
| `shu list [--status <s>]... [--kind <k>]... [--all]` | List tasks, most recently updated first. Shows `open` and `waiting` by default; `--status todo` shows what is not started. |
| `shu show <id>` | Show a task: metadata, body, log entries, and artifact file names. |
| `shu save [--remove-ref <ref>]...` | Create or update a task from JSON on standard input. |
| `shu find --ref <ref>` | Look up the task that owns a reference. |
| `shu log <id> [message] [--author <name>]` | Append one log entry. Reads the message from standard input if omitted. A message that starts with `-` goes after `--` (`shu log <id> -- "- a bullet"`) or on standard input. |
| `shu artifact <id> <file> [--name <name>] [--force]` | Copy a file into the task. Use `-` to read from standard input (requires `--name`). |
| `shu path <id>` | Print the absolute path of the task directory. |
| `shu kinds` | List the kinds in use, with the number of tasks of each. |

Every command accepts `--json`. Run `shu --help` for the full usage text.

### `shu save`

Input fields: `id`, `title`, `kind`, `status`, `refs`, `body`. Any other field is rejected.

The target task is chosen in this order:

1. If `id` is given, that task is updated. It is an error if it does not exist.
2. Otherwise, if any of `refs` already belongs to a task, the save matches that task: its `refs` are merged and nothing else is changed.
3. If `refs` belong to two or more different tasks, it is an error. SHU never merges tasks on its own.
4. Otherwise a new task is created. `title` and `kind` are required; `status` defaults to `open`, so pass `todo` for work that is not started.

A matched save never overwrites `title`, `kind`, `status`, or `body`, so input written to create a task cannot clobber one that already exists. The fields that differ from the stored ones are listed in `skipped`; save again with the `id` to apply them. A matched save that changes no reference leaves the task untouched.

Updates by `id` are partial: only the fields you pass are changed. `refs` are added to the existing ones, never replaced. To remove a reference, pass `--remove-ref <ref>` together with the `id` (or another reference) of the task to remove it from.

### Task fields

| Field | Notes |
|---|---|
| `id` | Assigned by SHU. Cannot be changed. |
| `title` | One line, not empty. |
| `kind` | Free-form, one line. Suggested values: `review`, `pr-followup`, `bug-investigation`, `alert-investigation`, `fix-request`, `ticket`. `shu kinds` lists the ones already in use. |
| `status` | `todo` (not started), `open` (in progress), `waiting` (blocked on someone else), `done`, or `dropped`. |
| `refs` | Normalized references. Each reference belongs to at most one task. |
| `created`, `updated` | Set by SHU. |

## IDs

IDs look like `20261001-aoi-kitsune`: the local creation date followed by a random adjective and noun in romanized Japanese.

Anywhere an ID is expected you can pass just the words (`aoi-kitsune`). If the words match more than one task, SHU reports the candidates and fails.

## References

A reference points at where a task came from. One task can have several, because work tends to move — a Slack thread becomes a ticket, which becomes a PR.

References are normalized when saved, so different spellings of the same thing resolve to the same task.

| Kind | Normal form | Accepted input |
|---|---|---|
| `github` | `github:<owner>/<repo>#<number>` | PR and issue URLs, `owner/repo#482` |
| `linear` | `linear:<KEY>-<number>` | `abc-123`, Linear issue URLs |
| `slack` | `slack:<permalink>` | Slack message permalinks |
| `url` | `url:<URL>` | Any other `http(s)` URL |

A few details worth knowing:

- GitHub owner and repository names are lowercased.
- A Slack permalink to a reply inside a thread is normalized to the thread's parent message, so any link into the same thread finds the same task.
- Input that cannot be normalized is rejected.

## Where things are stored

The root is `~/.shu`. Set `SHU_HOME` to use a different directory.

```
~/.shu/
  tasks/
    20261001-aoi-kitsune/
      task.md        # metadata (YAML front matter) and body
      log.md         # history, append-only
      artifacts/     # attached files
        brief.md
```

Everything is plain Markdown, so both people and agents can read it directly. Fields in `task.md` that SHU does not know about are preserved when the task is rewritten, along with their values and any comments.

## JSON output

With `--json`, a command prints JSON to standard output and nothing else. Field names and types are treated as a contract: fields are not removed or retyped.

| Command | Output |
|---|---|
| `list` | `{"tasks": [<task>]}` (without `body`) |
| `show` | `{"task": <task>, "log": [{"at", "author", "message"}], "artifacts": ["<file name>"]}` |
| `save` | `{"result": "created" \| "updated" \| "matched", "task": <task>, "skipped": ["<field name>"]}` |
| `find` | `{"task": <task>}` |
| `log` | `{"id", "entry": {"at", "author", "message"}}` |
| `artifact` | `{"id", "name", "path"}` |
| `path` | `{"id", "path"}` |
| `kinds` | `{"kinds": [{"kind", "count"}]}` |
| `--help` | `{"help": "<usage text>"}` |
| `--version` | `{"version": "<version>"}` |

On failure the exit code is non-zero. With `--json` the error is also printed to standard output:

```json
{ "error": { "code": "not_found", "message": "..." } }
```

| Code | Meaning |
|---|---|
| `invalid_input` | Bad arguments, options, or input JSON |
| `invalid_ref` | The reference could not be normalized |
| `invalid_task` | A stored `task.md` does not match the schema (`error.id` is that task) |
| `not_found` | No such task |
| `ambiguous_id` | The ID words match several tasks (`error.candidates` lists them) |
| `ref_conflict` | A reference belongs to another task, or to several (`error.candidates` lists them) |
| `artifact_exists` | An artifact with that name already exists |
| `lock_timeout` | A lock could not be acquired |
| `id_exhausted` | No free ID was found |
| `internal` | Unexpected error |

## Concurrency

SHU assumes several agents may call it at the same time.

- New tasks are created with an atomic `mkdir`; on a collision the words are drawn again.
- `task.md` is written to a temporary file and renamed into place.
- Updates to a task are serialized with a per-task lock file.
- Reference checks and the save that follows run under a global lock.
- A lock left behind by a crashed process is taken over after 10 seconds, by one process at a time.
- A log entry is written with a single append.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

Tests always point `SHU_HOME` at a temporary directory and never touch the real `~/.shu`. The concurrency tests run multiple processes at once.

The full specification is in [`docs/SPEC.md`](docs/SPEC.md).

## Out of scope

SHU deliberately does not collect data from GitHub, Linear, or Slack, call an AI, run as an MCP server, or serve a web UI. Gathering and understanding is the agent's job; SHU only stores the result.

## License

[MIT](LICENSE)
