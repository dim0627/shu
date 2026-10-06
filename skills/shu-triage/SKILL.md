---
name: shu-triage
description: Check every SHU task in hand against GitHub and the deploy tags, then recommend what to work on. Use when the user asks what to work on next.
---

# shu-triage — recommend from facts, not from the list

A task in SHU is a hand-written copy of facts that live elsewhere: a pull request,
a deploy, a reply. The copy goes stale within the hour. `triage.py`, beside this
file, reads every open, waiting, and todo task, looks up what a machine can, and
marks each task whose copy disagrees with its source.

## Steps

1. Run `python3 <this folder>/triage.py` every time the question comes up. An
   earlier run in the same session is already stale.
   If the output starts with `LOOKUPS FAILED`, tell the user which lookup failed:
   a task without a mark is unchecked, not fine.
2. Open the full-text file the last line names. Read the block of every marked
   task and of every task you might recommend, until you can say for each one, in
   one line, what work remains and whose move it is.
3. Bring each of those tasks up to date in SHU (the marks below say how), then
   recommend only tasks the user can start now, each with its remaining work.

## Marks

A mark says "check this", never "change this": a task can carry one and be right.

| Mark | Meaning | What to decide |
|---|---|---|
| `merged` | open or todo, and every pull request is merged | Nothing left: `done`. Left but not startable now: `waiting` with a note. Left and startable: leave it `open` |
| `started` | todo, and it has a pull request | The work began: `open`, or `waiting` with a note |
| `shipped` | waiting, and every pull request is in a deploy tag | The deploy wait is over. A next step tied to a time ("after tonight's peak") stays `waiting` with that time in the note; otherwise `open` |
| `blank` | no pull request, and no body or no log | SHU holds nothing to judge by: look up its other refs first |

## Rules

- Before a change of status, log the old one, because `shu status` keeps no history:
  `shu log <id> "status: open → waiting. <reason>. Previous note: <note>" --author shu-triage`
- A task that a loop or another skill keeps (a registered review request, for
  example) is that owner's to write. Report its mark and leave the task as it is.
- `not looked up:` lists refs the script cannot read (Linear, Slack, other URLs).
  Look them up with your own tools before recommending that task, and for every
  unmarked `waiting` task whose log says it waits on a reply. A task that waits on
  the user's own decision goes in your answer as theirs to decide.
- `(matched by title, not a ref yet)`: the pull request's title carries the
  task's ticket key. Add it: `echo '{"id": "<id>", "refs": ["<owner>/<repo>#<n>"]}' | shu save`
- An open pull request that no task refs: add it to its task if one exists
  (`shu list --all`), otherwise create the task. One whose ticket belongs to a
  closed task: show it to the user.

## Deploy tags

`shipped` needs to know how a repository tags a deploy. Without this file the
mark never appears. `~/.config/shu-triage/config.json`:

```json
{ "deployTags": { "example-org/example-repo": { "clone": "~/src/example-repo", "pattern": "prod/*" } } }
```

## What the script writes

Nothing in SHU. Under `~/.local/state/shu-triage/`: `last.md` (the full text),
`runs.jsonl` (one line per run: counts and marked IDs), and `backup/<time>/`, a
copy of every `task.md` it read, to restore a body or note you changed by mistake.
