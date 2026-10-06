# SHU

A local task store CLI through which humans and AI agents read and write information about the tasks of software development work.

**Always read `docs/SPEC.md` before implementing.** If the spec and the implementation disagree, do not quietly bend toward the implementation; propose a change to the spec.

## Commands

```sh
bun install
bun test
bun run build   # produces a single executable with bun build --compile
```

## Rules

- **This is a public repository.** Do not write the name of a specific company, repository, ticket prefix, or person in code, tests, or docs. Use generic examples such as `example-org/example-repo` and `ABC-123`
- **Everything is written in English**: code, comments, CLI messages, tests, docs, and commit messages
- **The CLI depends on neither the network nor an AI.** It must be deterministic and work offline
- **The `--json` output is a contract.** Do not remove fields or change their types. Do not mix in human-oriented decoration
- **Tests must always point `SHU_HOME` at a temporary directory.** Never touch the real `~/.shu`. A test of `skills/shu-triage/triage.py` also points `SHU_TRIAGE_STATE` and `SHU_TRIAGE_CONFIG` at temporary paths: the script falls back to `~/.local/state` and `~/.config`
- Always write tests for the guarantees (dedupe, ID collision avoidance, schema validation, the append-only log, and concurrency safety). Verify concurrency by actually running several processes at once

## Current scope

The CLI itself and its tests, as described in §6 of `docs/SPEC.md`, and the skills in `skills/` (§10). Do not build anything listed as out of scope in §9 (AI calls, an MCP server, a web view, and data collection anywhere but the `shu-triage` script).

Keep the `shu` skill thin: `shu --help` is the full usage, so a change to a command updates the help text, and the skill only when one of its examples changes. A change to `list`, `show`, `path`, `save`, `log`, or `status` also means checking `skills/shu-triage/`, which calls the first three and shows the rest as examples.
