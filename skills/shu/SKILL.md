---
name: shu
description: Read and write task information through the shu CLI, a local task store shared across sessions. Use when the user asks what to work on next or how a task stands, when you start or resume work that came from a PR, ticket, or Slack thread, and when you have a finding, decision, or file about that work worth keeping after the session ends.
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

## Cheatsheet

```sh
shu list --json                                   # open and waiting tasks, newest first
shu list --status todo --json                     # tasks that are not started
shu kinds --json                                  # kinds in use: reuse one before adding a new one
shu find --ref example-org/example-repo#482 --json   # is there already a task for this?
shu show aoi-kitsune --json                       # metadata, body, log, artifact names

echo '{"title": "Investigate double-charged payments", "kind": "bug-investigation",
       "refs": ["https://github.com/example-org/example-repo/pull/482", "ABC-123"]}' | shu save --json
echo '{"id": "aoi-kitsune", "body": "Current summary."}' | shu save --json
shu status open aoi-kitsune --json                # when you start a todo task
shu status waiting aoi-kitsune --note "Waiting for the provider to reply" --json
shu status done aoi-kitsune akai-tsuru --json     # when the work is finished (dropped if abandoned)

shu log aoi-kitsune "The retry path does not set an idempotency key." --author claude
shu artifact aoi-kitsune ./brief.md               # the file lands in "$(shu path aoi-kitsune)/artifacts"
```

## What goes where

- **refs**: every place the work lives (PR, issue, ticket, Slack thread), on every
  `save`. `save` finds the existing task by its refs, so a save that carries them
  can never create a duplicate. Pass URLs as they are; SHU normalizes them.
- **note**: every `waiting` task gets one, naming who or what it waits on.
  `shu list` shows it, so the reason is readable without opening the task.
- **body**: the current summary. Each `save` by `id` that passes `body` replaces it.
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
