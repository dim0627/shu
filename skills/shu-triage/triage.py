#!/usr/bin/env python3
"""Check the tasks in hand against what GitHub and the deploy tags say now.

Reads every open, waiting, and todo task from SHU, looks up the pull requests
they point at, and prints one line per task with a mark where the task and the
outside world disagree. The full text of each task goes to a file.

It writes nothing to SHU. See SKILL.md for how to act on the output.
"""

import datetime
import json
import os
import re
import shutil
import subprocess
import sys

OPEN_PR_WINDOW_DAYS = 30
MERGED_PR_WINDOW_DAYS = 14
SEARCH_LIMIT = 200
LOG_TAIL = 3
ACTIVE = ("open", "waiting", "todo")
AUTHOR = "shu-triage"
INSTALL = "curl -fsSL https://raw.githubusercontent.com/dim0627/shu/main/scripts/install.sh | sh"
# The same shape src/ref.ts accepts for a linear ref. \b would not do: to Python a non-ASCII letter is a word character
KEY = re.compile(r"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)-([0-9]+)(?![A-Za-z0-9])")
GITHUB_REF = re.compile(r"^github:([^/]+)/([^#]+)#(\d+)$")


def run(args, cwd=None):
    try:
        proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except OSError as e:
        # A missing program or working directory is a failed lookup like any other
        return 127, "", str(e)
    return proc.returncode, proc.stdout, proc.stderr


def shu_json(*args):
    code, out, err = run(["shu", *args, "--json"])
    if code != 0:
        sys.exit(
            f"shu-triage: `shu {' '.join(args)}` failed: {err.strip() or out.strip()}\n"
            f"If shu is missing or too old for this command, install the latest: {INSTALL}"
        )
    return json.loads(out)


def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.environ.get("SHU_TRIAGE_STATE") or os.path.join(base, "shu-triage")


def load_config():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    path = os.environ.get("SHU_TRIAGE_CONFIG") or os.path.join(base, "shu-triage", "config.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"shu-triage: cannot read the config at {path}: {e}")


def github_refs(task):
    found = []
    for ref in task["refs"]:
        m = GITHUB_REF.match(ref)
        if m:
            found.append((f"{m[1]}/{m[2]}", int(m[3])))
    return found


def linear_keys(task):
    return [ref.split(":", 1)[1] for ref in task["refs"] if ref.startswith("linear:")]


def title_keys(title):
    return [f"{m[1].upper()}-{int(m[2])}" for m in KEY.finditer(title)]


def search_own_prs(today):
    """Own pull requests: every open one, and the ones merged lately."""
    since = (today - datetime.timedelta(days=MERGED_PR_WINDOW_DAYS)).isoformat()
    queries = {
        "open": ["--state", "open"],
        "merged": ["--merged", "--merged-at", f">={since}"],
    }
    found, problems = {}, []
    for name, flags in queries.items():
        code, out, err = run(
            ["gh", "search", "prs", "--author", "@me", *flags, "--limit", str(SEARCH_LIMIT)]
            + ["--json", "number,title,repository,createdAt"]
        )
        if code != 0:
            problems.append(f"search for your {name} pull requests failed: {err.strip()}")
            continue
        rows = json.loads(out)
        if len(rows) >= SEARCH_LIMIT:
            problems.append(f"search for your {name} pull requests hit the limit of {SEARCH_LIMIT}; some are missing")
        for row in rows:
            # SHU stores a github ref in lowercase; GitHub answers in the repository's own case
            repo = row["repository"]["nameWithOwner"].lower()
            found[(repo, row["number"])] = {
                "repo": repo,
                "number": row["number"],
                "title": row["title"],
                "created": row["createdAt"],
                "found_as": name,
            }
    return found, problems


def fetch_states(pairs):
    """One GraphQL request for every pull request or issue. A number that cannot be read is left out."""
    if not pairs:
        return {}, []
    pairs = sorted(pairs)
    parts = []
    for i, (repo, number) in enumerate(pairs):
        owner, name = repo.split("/", 1)
        parts.append(
            f'n{i}: repository(owner: "{owner}", name: "{name}") {{'
            f" defaultBranchRef {{ name }}"
            f" issueOrPullRequest(number: {number}) {{ __typename"
            f" ... on PullRequest {{ state isDraft mergedAt baseRefName mergeCommit {{ oid }} }}"
            f" ... on Issue {{ state }} }} }}"
        )
    code, out, err = run(["gh", "api", "graphql", "-f", "query=query {" + " ".join(parts) + "}"])
    # gh exits non-zero when any alias fails, yet still prints the ones that resolved
    try:
        data = json.loads(out).get("data") or {}
    except json.JSONDecodeError:
        return {}, [f"GitHub lookup failed: {err.strip() or 'no output'}"]
    states, missing = {}, 0
    for i, pair in enumerate(pairs):
        node = data.get(f"n{i}")
        item = node and node.get("issueOrPullRequest")
        if not item:
            missing += 1
            continue
        states[pair] = {
            "type": item["__typename"],
            "state": item["state"],
            "draft": item.get("isDraft", False),
            "merged_at": item.get("mergedAt"),
            "base": item.get("baseRefName"),
            "default_branch": (node.get("defaultBranchRef") or {}).get("name"),
            "merge_commit": (item.get("mergeCommit") or {}).get("oid"),
        }
    problems = [f"GitHub lookup could not read {missing} of {len(pairs)} refs"] if missing else []
    return states, problems


def deploy_tags(config, states):
    """For repositories with a configured deploy tag pattern, the oldest tag that holds each merged pull request."""
    shipped, problems = {}, []
    for repo, entry in (config.get("deployTags") or {}).items():
        repo = repo.lower()
        merged = [(pair, s) for pair, s in states.items() if pair[0] == repo and s["state"] == "MERGED"]
        if not merged:
            continue
        clone, pattern = entry.get("clone"), entry.get("pattern")
        if not clone or not pattern:
            problems.append(f"deployTags for {repo} needs both `clone` and `pattern`")
            continue
        # The pattern is also a fetch refspec, which allows a single `*` and no other wildcard
        if pattern.count("*") > 1 or any(c in pattern for c in "?["):
            problems.append(f"deployTags pattern {pattern} for {repo} may hold one `*` and no `?` or `[`")
            continue
        clone = os.path.expanduser(clone)
        # Only the deploy tags: a plain `fetch --tags` also moves origin/* for every worktree of the clone
        code, _, err = run(
            ["git", "fetch", "--quiet", "--no-tags", "--no-prune", "origin", f"+refs/tags/{pattern}:refs/tags/{pattern}"],
            cwd=clone,
        )
        if code != 0:
            reason = err.strip().splitlines()[-1] if err.strip() else "unknown error"
            problems.append(f"could not fetch {pattern} tags of {repo}: {reason}")
            continue
        for pair, s in merged:
            if s["base"] != s["default_branch"] or not s["merge_commit"]:
                continue
            # After the fetch, a commit the clone lacks is in no deploy tag: that is "not shipped", not a failure
            code, _, _ = run(["git", "cat-file", "-e", f"{s['merge_commit']}^{{commit}}"], cwd=clone)
            if code != 0:
                continue
            # creatordate, because the default order is by name, where prod/10 comes before prod/9
            code, out, err = run(
                ["git", "tag", "--sort=creatordate", "--contains", s["merge_commit"], pattern], cwd=clone
            )
            if code != 0:
                reason = err.strip().splitlines()[-1] if err.strip() else "unknown error"
                problems.append(f"could not check the deploy tags of {pair[0]}#{pair[1]}: {reason}")
                continue
            tags = out.split()
            if tags:
                shipped[pair] = tags[0]
    return shipped, problems


def describe_pr(pair, state, shipped, deploy_repos, via_title):
    repo, number = pair
    label = f"{repo}#{number}"
    if state is None:
        text = "state unknown"
    elif state["type"] == "Issue":
        text = f"issue {state['state'].lower()}"
    elif state["state"] == "MERGED":
        text = "merged" + (f" {state['merged_at'][:10]}" if state["merged_at"] else "")
        if pair in shipped:
            text += f", shipped in {shipped[pair]}"
        elif repo in deploy_repos:
            text += ", not confirmed shipped"
    elif state["state"] == "CLOSED":
        text = "closed without merging"
    else:
        text = "open" + (" draft" if state["draft"] else "")
    return f"{label} {text}" + (" (matched by title: add it as a ref)" if via_title else "")


def marks_for(task, prs, states, shipped, deploy_repos, has_own_log):
    known = [states.get(pair) for pair in prs]
    unread = any(s is None for s in known)
    pulls = [(pair, s) for pair, s in zip(prs, known) if s and s["type"] == "PullRequest"]
    # A pull request closed without merging was abandoned: it neither blocks nor counts
    live = [(pair, s) for pair, s in pulls if s["state"] != "CLOSED"]
    all_merged = bool(live) and not unread and all(s["state"] == "MERGED" for _, s in live)
    deployable = [pair for pair, _ in live if pair[0] in deploy_repos]

    marks = []
    if task["status"] in ("open", "todo") and all_merged:
        marks.append("merged")
    elif task["status"] == "todo" and any(s["state"] == "OPEN" for _, s in live):
        marks.append("started")
    elif task["status"] == "waiting" and all_merged:
        if not deployable:
            marks.append("merged")
        elif all(pair in shipped for pair in deployable):
            marks.append("shipped")
    # With an unread ref the task may well have a pull request
    if task["status"] in ("open", "waiting") and not pulls and not unread and (task["body"].strip() == "" or not has_own_log):
        marks.append("blank")
    return marks


def main():
    now = datetime.datetime.now().astimezone()
    config = load_config()
    deploy_repos = {repo.lower() for repo in (config.get("deployTags") or {})}

    active = [shu_json("show", t["id"]) for t in shu_json("list", *sum((["--status", s] for s in ACTIVE), []))["tasks"]]
    everything = shu_json("list", "--all")["tasks"]

    ref_owner = {}
    key_owner = {}
    for task in everything:
        for pair in github_refs(task):
            ref_owner[pair] = task
        for key in linear_keys(task):
            key_owner[key] = task

    own, problems = search_own_prs(now.date())

    # A pull request that no task refs joins a task when its title carries that task's ticket key
    title_matched = {}  # task id -> [pair]
    closed_with_open_pr = []
    unmatched_open, older_open, unmatched_merged = [], 0, 0
    for pair, pr in own.items():
        is_open = pr["found_as"] == "open"
        owner = ref_owner.get(pair)
        if owner:
            if is_open and owner["status"] not in ACTIVE:
                closed_with_open_pr.append((pr, owner))
            continue
        owners = [key_owner[k] for k in title_keys(pr["title"]) if k in key_owner]
        # A review task holds someone else's pull requests, so it never takes one of the user's own
        target = next((t for t in owners if t["status"] in ACTIVE and t["kind"] != "review"), None)
        closed = next((t for t in owners if t["status"] not in ACTIVE), None)
        if target:
            title_matched.setdefault(target["id"], []).append(pair)
        elif is_open and closed:
            closed_with_open_pr.append((pr, closed))
        elif is_open:
            created = datetime.datetime.fromisoformat(pr["created"].replace("Z", "+00:00"))
            if (now - created).days <= OPEN_PR_WINDOW_DAYS:
                unmatched_open.append(pr)
            else:
                older_open += 1
        elif not owners:
            unmatched_merged += 1

    task_prs = {}
    for detail in active:
        task = detail["task"]
        task_prs[task["id"]] = github_refs(task) + title_matched.get(task["id"], [])
    wanted = {pair for prs in task_prs.values() for pair in prs}

    states, more = fetch_states(wanted)
    problems += more
    shipped, more = deploy_tags(config, states)
    problems += more

    out_dir = state_dir()
    backup_dir = os.path.join(out_dir, "backup", now.strftime("%Y%m%dT%H%M%S"))
    os.makedirs(backup_dir, exist_ok=True)

    lines, blocks, marked, no_backup = [], [], {}, []
    for detail in active:
        task, log = detail["task"], detail["log"]
        prs = task_prs[task["id"]]
        matched = set(title_matched.get(task["id"], []))
        has_own_log = any(entry["author"] != AUTHOR for entry in log)
        marks = marks_for(task, prs, states, shipped, deploy_repos, has_own_log)
        for mark in marks:
            marked.setdefault(mark, []).append(task["id"])
        pr_texts = [describe_pr(pair, states.get(pair), shipped, deploy_repos, pair in matched) for pair in prs]
        other_refs = [ref for ref in task["refs"] if not ref.startswith("github:")]

        try:
            source = os.path.join(shu_json("path", task["id"])["path"], "task.md")
            shutil.copyfile(source, os.path.join(backup_dir, f"{task['id']}.md"))
        except OSError:
            no_backup.append(task["id"])

        mark_text = ",".join(marks) if marks else "-"
        line = f"{task['id']}  {task['status']:<7}  {task['kind']}  [{mark_text}]  {task['title']}"
        if task.get("note"):
            line += f"  ({task['note']})"
        lines.append(line)
        for text in pr_texts:
            lines.append(f"    {text}")
        if other_refs:
            lines.append(f"    not looked up: {' '.join(other_refs)}")

        block = [f"## {task['id']}  {task['title']}", f"status: {task['status']}  kind: {task['kind']}  marks: {mark_text}"]
        if task.get("note"):
            block.append(f"note: {task['note']}")
        block.append(f"updated: {task['updated']}")
        block += [f"pr: {text}" for text in pr_texts]
        block += [f"not looked up: {ref}" for ref in other_refs]
        block += ["", task["body"].strip() or "(no body)", ""]
        if log:
            block.append(f"### Last {min(LOG_TAIL, len(log))} of {len(log)} log entries")
            for entry in log[-LOG_TAIL:]:
                block += [f"#### {entry['at']} {entry['author']}", entry["message"].strip(), ""]
        else:
            block.append("(no log)")
        blocks.append("\n".join(block))

    full_path = os.path.join(out_dir, "last.md")
    with open(full_path, "w", encoding="utf-8") as f:
        f.write(f"# shu-triage {now.isoformat(timespec='seconds')}\n\n" + "\n\n".join(blocks) + "\n")

    counts = {}
    for detail in active:
        counts[detail["task"]["status"]] = counts.get(detail["task"]["status"], 0) + 1
    with open(os.path.join(out_dir, "runs.jsonl"), "a", encoding="utf-8") as f:
        record = {
            "at": now.isoformat(timespec="seconds"),
            "counts": counts,
            "marks": marked,
            "unmatchedOpenPullRequests": len(unmatched_open),
            "problems": len(problems),
        }
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    # First, so that a reader who stops at the first line still learns the marks below cannot be trusted
    if problems:
        print("LOOKUPS FAILED, so a mark below, or the lack of one, may be wrong:")
        for problem in problems:
            print(f"  - {problem}")
    else:
        print("lookups: all succeeded")
    for task_id in no_backup:
        print(f"WARNING: no backup of {task_id}: its task.md could not be copied")
    print(f"now: {now.strftime('%Y-%m-%d %H:%M %Z')}")
    print()
    print("\n".join(lines))
    if unmatched_open:
        print(f"\nOpen pull requests of yours from the last {OPEN_PR_WINDOW_DAYS} days that no task refs:")
        for pr in unmatched_open:
            print(f"  {pr['repo']}#{pr['number']}  {pr['title']}")
    if closed_with_open_pr:
        print("\nOpen pull requests of yours that belong to a closed task:")
        for pr, task in closed_with_open_pr:
            print(f"  {pr['repo']}#{pr['number']}  {pr['title']}  -> {task['id']} ({task['status']})")
    if older_open:
        print(f"\n{older_open} older open pull requests of yours belong to no task (not listed).")
    if unmatched_merged:
        print(
            f"\n{unmatched_merged} pull requests of yours merged in the last {MERGED_PR_WINDOW_DAYS} days"
            " belong to no task (not listed)."
        )
    print(f"\nfull text of every task: {full_path}")


if __name__ == "__main__":
    main()
