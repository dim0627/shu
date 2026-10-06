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
KEY = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")
GITHUB_REF = re.compile(r"^github:([^/]+)/([^#]+)#(\d+)$")


def run(args, cwd=None):
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


def shu_json(*args):
    code, out, err = run(["shu", *args, "--json"])
    if code != 0:
        sys.exit(f"shu-triage: `shu {' '.join(args)}` failed: {err.strip() or out.strip()}")
    return json.loads(out)


def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.environ.get("SHU_TRIAGE_STATE") or os.path.join(base, "shu-triage")


def load_config():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    path = os.environ.get("SHU_TRIAGE_CONFIG") or os.path.join(base, "shu-triage", "config.json")
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def github_refs(task):
    found = []
    for ref in task["refs"]:
        m = GITHUB_REF.match(ref)
        if m:
            found.append((f"{m[1]}/{m[2]}", int(m[3])))
    return found


def linear_keys(task):
    return [ref.split(":", 1)[1] for ref in task["refs"] if ref.startswith("linear:")]


def search_own_prs(today):
    """Own pull requests: every open one, and the ones merged lately."""
    fields = "number,title,repository,state,createdAt,url"
    since = (today - datetime.timedelta(days=MERGED_PR_WINDOW_DAYS)).isoformat()
    queries = {
        "open": ["--state", "open"],
        "merged": ["--merged", "--merged-at", f">={since}"],
    }
    found, problems = {}, []
    for name, flags in queries.items():
        code, out, err = run(
            ["gh", "search", "prs", "--author", "@me", *flags, "--limit", str(SEARCH_LIMIT), "--json", fields]
        )
        if code != 0:
            problems.append(f"search for {name} pull requests failed: {err.strip()}")
            continue
        rows = json.loads(out)
        if len(rows) >= SEARCH_LIMIT:
            problems.append(f"search for {name} pull requests hit the limit of {SEARCH_LIMIT}; some are missing")
        for row in rows:
            repo = row["repository"]["nameWithOwner"].lower()
            found[(repo, row["number"])] = {
                "repo": repo,
                "number": row["number"],
                "title": row["title"],
                "url": row["url"],
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
    """For repositories with a configured deploy tag pattern, the tag each merged pull request first shipped in."""
    shipped, problems = {}, []
    for repo, entry in (config.get("deployTags") or {}).items():
        repo = repo.lower()
        clone, pattern = os.path.expanduser(entry["clone"]), entry["pattern"]
        merged = [(pair, s) for pair, s in states.items() if pair[0] == repo and s["state"] == "MERGED"]
        if not merged:
            continue
        # Only the deploy tags: a plain `fetch --tags` also moves origin/* for every worktree of the clone
        code, _, err = run(
            ["git", "fetch", "--quiet", "--no-tags", "--no-prune", "origin", f"+refs/tags/{pattern}:refs/tags/{pattern}"],
            cwd=clone,
        )
        if code != 0:
            problems.append(f"could not fetch {pattern} tags of {repo}: {err.strip().splitlines()[-1] if err.strip() else 'unknown error'}")
            continue
        for pair, s in merged:
            if s["base"] != s["default_branch"] or not s["merge_commit"]:
                continue
            code, out, _ = run(["git", "tag", "--contains", s["merge_commit"], pattern], cwd=clone)
            tags = out.split()
            if code == 0 and tags:
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
        if pair in shipped:
            text = f"merged, shipped in {shipped[pair]}"
        elif repo in deploy_repos:
            text = "merged, not confirmed shipped"
        else:
            text = "merged"
    else:
        text = state["state"].lower() + (" draft" if state["draft"] else "")
    return f"{label} {text}" + (" (matched by title, not a ref yet)" if via_title else "")


def marks_for(task, prs, states, shipped, deploy_repos, has_log):
    known = [states.get(pair) for pair in prs]
    pulls = [(pair, s) for pair, s in zip(prs, known) if s and s["type"] == "PullRequest"]
    marks = []
    all_merged = bool(pulls) and len(pulls) == len(prs) and all(s["state"] == "MERGED" for _, s in pulls)
    if task["status"] in ("open", "todo") and all_merged:
        marks.append("merged")
    elif task["status"] == "todo" and pulls:
        marks.append("started")
    if task["status"] == "waiting":
        deployable = [(pair, s) for pair, s in pulls if pair[0] in deploy_repos]
        if deployable and all(pair in shipped for pair, _ in deployable):
            marks.append("shipped")
    if task["status"] in ("open", "waiting") and not prs and (task["body"].strip() == "" or not has_log):
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
            key_owner.setdefault(key, task)

    own, problems = search_own_prs(now.date())

    # A pull request that no task refs joins a task when its title carries that task's ticket key
    title_matched = {}  # task id -> [pair]
    closed_with_open_pr = []
    unmatched_open, unmatched_merged = [], 0
    for pair, pr in own.items():
        if pair in ref_owner:
            continue
        owners = [key_owner[k] for k in KEY.findall(pr["title"]) if k in key_owner]
        target = next((t for t in owners if t["status"] in ACTIVE and t["kind"] != "review"), None)
        if target:
            title_matched.setdefault(target["id"], []).append(pair)
        elif pr["found_as"] == "open" and any(t["status"] not in ACTIVE for t in owners):
            closed = next(t for t in owners if t["status"] not in ACTIVE)
            closed_with_open_pr.append((pr, closed))
        elif pr["found_as"] == "open":
            created = datetime.datetime.fromisoformat(pr["created"].replace("Z", "+00:00"))
            if (now - created).days <= OPEN_PR_WINDOW_DAYS:
                unmatched_open.append(pr)
        else:
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

    lines, blocks, marked = [], [], {}
    for detail in active:
        task, log = detail["task"], detail["log"]
        prs = task_prs[task["id"]]
        matched = set(title_matched.get(task["id"], []))
        marks = marks_for(task, prs, states, shipped, deploy_repos, bool(log))
        for mark in marks:
            marked.setdefault(mark, []).append(task["id"])
        pr_texts = [describe_pr(pair, states.get(pair), shipped, deploy_repos, pair in matched) for pair in prs]
        other_refs = [ref for ref in task["refs"] if not ref.startswith("github:")]

        code, path, _ = run(["shu", "path", task["id"]])
        source = os.path.join(path.strip(), "task.md")
        if code == 0 and os.path.exists(source):
            shutil.copyfile(source, os.path.join(backup_dir, f"{task['id']}.md"))

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
    with open(full_path, "w") as f:
        f.write(f"# shu-triage {now.isoformat(timespec='seconds')}\n\n" + "\n\n".join(blocks) + "\n")

    counts = {}
    for detail in active:
        counts[detail["task"]["status"]] = counts.get(detail["task"]["status"], 0) + 1
    with open(os.path.join(out_dir, "runs.jsonl"), "a") as f:
        record = {
            "at": now.isoformat(timespec="seconds"),
            "counts": counts,
            "marks": marked,
            "unmatchedOpenPullRequests": len(unmatched_open),
            "problems": len(problems),
        }
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(f"now: {now.strftime('%Y-%m-%d %H:%M %Z')}")
    if problems:
        print("LOOKUPS FAILED, so a missing mark below does not mean the task is fine:")
        for problem in problems:
            print(f"  - {problem}")
    else:
        print("lookups: all succeeded")
    print()
    print("\n".join(lines))
    if unmatched_open:
        print(f"\nOpen pull requests of yours from the last {OPEN_PR_WINDOW_DAYS} days that no task refs:")
        for pr in unmatched_open:
            print(f"  {pr['repo']}#{pr['number']}  {pr['title']}")
    if closed_with_open_pr:
        print("\nOpen pull requests whose ticket belongs to a closed task:")
        for pr, task in closed_with_open_pr:
            print(f"  {pr['repo']}#{pr['number']}  {pr['title']}  -> {task['id']} ({task['status']})")
    if unmatched_merged:
        print(f"\n{unmatched_merged} merged pull requests of yours from the last {MERGED_PR_WINDOW_DAYS} days belong to no task (not listed).")
    print(f"\nfull text of every task: {full_path}")


if __name__ == "__main__":
    main()
