---
name: shu
description: Read and write task information through the shu CLI, a local task store shared across sessions. Use when the user asks what to work on next or how a task stands, when you start or resume work that came from a PR, ticket, or Slack thread, and when you have a finding, decision, or file about that work worth keeping after the session ends.
---

# shu — the task store

What you learn about a piece of work goes into SHU, so the next session starts
from it. Every write goes through the `shu` command: it is what keeps tasks
deduplicated, IDs unique, and the log append-only. `shu --help` is the full
usage, one screen.

If `shu` is missing: `curl -fsSL https://raw.githubusercontent.com/dim0627/shu/main/scripts/install.sh | sh`

## Cheatsheet

```sh
shu list --json                                   # open and waiting tasks, newest first
shu list --status todo --json                     # tasks that are not started
shu kinds --json                                  # kinds in use: reuse one before adding a new one
shu find --ref example-org/example-repo#482 --json   # is there already a task for this?
shu show aoi-kitsune --json                       # metadata, body, log, artifact names

echo '{"title": "Investigate double-charged payments", "kind": "bug-investigation",
       "refs": ["https://github.com/example-org/example-repo/pull/482", "ABC-123"]}' | shu save --json
echo '{"id": "aoi-kitsune", "status": "waiting", "body": "Current summary."}' | shu save --json

shu log aoi-kitsune "The retry path does not set an idempotency key." --author claude
shu artifact aoi-kitsune ./brief.md               # the file lands in "$(shu path aoi-kitsune)/artifacts"
```

## What goes where

- **refs**: every place the work lives (PR, issue, ticket, Slack thread), on every
  `save`. `save` finds the existing task by its refs, so a save that carries them
  can never create a duplicate. To sync many items, `save` each one directly.
  Pass URLs as they are; SHU normalizes them.
- **body**: the current summary. Each `save` that passes `body` replaces it.
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
- `find` exits non-zero with `not_found` when no task owns the ref: that is the
  answer "no task yet", so create one with `save`.
- `ref_conflict` means the refs belong to different tasks. SHU never merges
  tasks: show the user the candidates and let them choose.
