---
name: shu
description: Read and write task information through the shu CLI, a local task store shared across sessions. Use when the user asks what to work on next or how a task stands, when you start or resume work worth picking up again later, whether it came from a PR, ticket, Slack thread, or document such as a Notion page, or only from a conversation that reached a conclusion or a next step, and during that work whenever a lookup or a subagent returns, the user voices a concern, a preference, or a decision, you reach a conclusion of your own, you write a file worth keeping, or you are about to wait for an answer.
---

# shu — the task store

What you learn about a piece of work goes into SHU, so the next session starts
from it. Every write goes through the `shu` command: it is what keeps tasks
deduplicated, IDs unique, and the log append-only. `shu --help` is the full
usage, one screen.

For "what should I work on next", use the `shu-triage` skill: the list alone is a
stale copy of pull requests and deploys, and that skill checks it against them.
If it is not installed, add it with `npx skills add dim0627/shu --skill shu-triage`
(`npx skills update` only updates skills that are already installed); until then,
answer from `shu list` and say that the list is unchecked.

If `shu` is missing, or rejects a command, option, or field shown here, install the latest: `curl -fsSL https://raw.githubusercontent.com/dim0627/shu/main/scripts/install.sh | sh`

## When to make a task

Make one for any work the next session could pick up or look back on, whatever
it came from: a PR, a ticket, a Slack thread, a document, or only a conversation
(a verification, an investigation, a design discussion, a tool you are building)
that reached a conclusion or a next step. A question answered on the spot is not
a task: the list is only useful while it holds work.

Before you create a task without refs, look for it in `shu list --all`, which
holds closed tasks too. If the same work is there, update that task by `id`.
`save` can only dedupe by refs, so for a task without them this check is the
only thing that keeps it from becoming two. When a PR or a ticket appears later,
add its ref to the existing task by `id` instead of creating another.

## Cheatsheet

```sh
shu list --json                                   # open and waiting tasks, newest first
shu list --status todo --json                     # tasks that are not started
shu kinds --json                                  # kinds in use: reuse one before adding a new one
shu find --ref example-org/example-repo#482 --json   # is there already a task for this?
shu show aoi-kitsune --json                       # metadata, body, log, artifact names
shu show aoi-kitsune --log 3 --json               # the same, with only the last 3 log entries

echo '{"title": "Investigate double-charged payments", "kind": "bug-investigation",
       "refs": ["https://github.com/example-org/example-repo/pull/482", "ABC-123"]}' | shu save --json
echo '{"id": "aoi-kitsune", "body": "Current summary."}' | shu save --json
shu status open aoi-kitsune --json                # when you start a todo task
shu status waiting aoi-kitsune --note "Waiting for the provider to reply" --json
shu status done aoi-kitsune akai-tsuru --json     # when the work is finished (dropped if abandoned)

shu log aoi-kitsune "The retry path does not set an idempotency key." --author claude
shu log aoi-kitsune "The provider will ship a fix on Friday." --note "Waiting for Friday's fix" --author claude
shu artifact aoi-kitsune ./brief.md               # the file lands in "$(shu path aoi-kitsune)/artifacts"
```

## When to log

Log what you learn when you learn it, before anything is settled. A log entry
notifies nobody: it is the next session's starting material, so it has a lower
bar than a ticket comment.

- **A lookup or a subagent returns**: log the facts it found, even when no
  decision follows from them yet. State that changes at the source, such as a
  CI result, stays there (see "What goes where").
- **The user voices a concern, a preference, or a decision**: log it.
- **You are about to wait for an answer**: log the options you gave and the
  open question.

Say in the entry when something is unverified or undecided.

`shu log` prints the task's note after the entry. If the entry changed where the
task stands, pass the new note with `--note`; if it settled something the body
should hold, update the body with `save`.

## What goes where

- **refs**: every place the work lives (PR, issue, ticket, Slack thread, Notion page), on every
  `save`. `save` finds the existing task by its refs, so a save that carries them
  can never create a duplicate. Pass URLs as they are; SHU normalizes them. Work
  that lives nowhere else has no refs: see "When to make a task".
- **note**: where the task stands, in one line: for a `waiting` task, who or what
  it waits on; for an `open` one, the next step. `shu list` shows it, so it is
  readable without opening the task. The next step lives here only: a copy in
  the body or in a ticket's todo list goes stale beside it.
- **body**: background, decisions, and conclusions: what stays true. Not the
  current state or the next step, which belong to the note. Each `save` by `id`
  that passes `body` replaces it. Fold what is settled into it: `shu-triage`
  shows the body whole and only the last three log entries.
- **log**: what happened and what you learned, one entry per event, with
  `--author` set to your own name. Entries are permanent, so a correction is a
  new entry.
- **artifacts**: files worth rereading (a brief, an investigation report, a fix
  plan). Read them from the path that `shu path` prints.

Store understanding, history, and artifacts. Leave out anything the source can
tell you again, such as a PR's review state or CI result: fetch that fresh.

## Rules

- Take the task ID from the `--json` output of `save`, `find`, or `list`.
- Collecting information (GitHub, Linear, Slack) is your job, with your own
  tools. SHU stays offline and only stores what you hand it.
- `"result": "matched"` means the task already existed: `save` merged the refs
  and applied nothing else, and `skipped` names the fields it left alone. Read
  the task with `show`, then update it by `id`.
- `find` exits non-zero with `not_found` when no task owns the ref: that is the
  answer "no task yet", so create one with `save`.
- `ref_conflict` means the refs belong to different tasks. SHU never merges
  tasks: show the user the candidates and let them choose.
