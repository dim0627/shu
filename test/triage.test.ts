import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupHomes, create, shu, tempHome } from "./helpers";

setDefaultTimeout(30_000);

afterEach(cleanupHomes);

const SCRIPT = join(import.meta.dir, "../skills/shu-triage/triage.py");
const CLI = join(import.meta.dir, "../src/cli.ts");
const REPO = "example-org/example-repo";
const TAG_PATTERN = "prod/*";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

type PrState = { state: "OPEN" | "MERGED" | "CLOSED"; draft?: boolean; base?: string; commit?: string };
type OwnPr = { number: number; title: string; created?: string; repo?: string };

interface World {
  // Pull requests the GraphQL stand-in knows, by "<owner>/<repo>#<number>". A ref left out reads as not found
  prs?: Record<string, PrState>;
  issues?: string[];
  open?: OwnPr[];
  merged?: OwnPr[];
  // Merge commit -> the deploy tags that contain it
  tags?: Record<string, string[]>;
  failSearch?: boolean;
  failFetch?: boolean;
  deployConfig?: boolean;
}

function executable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

const searchRow = (pr: OwnPr, state: string) => ({
  number: pr.number,
  title: pr.title,
  state,
  createdAt: pr.created ?? daysAgo(1),
  url: `https://github.com/${pr.repo ?? REPO}/pull/${pr.number}`,
  repository: { name: (pr.repo ?? REPO).split("/")[1], nameWithOwner: pr.repo ?? REPO },
});

// The stand-in answers the query the script sent, so the test does not depend on the order of its aliases
const FAKE_GH = `#!/usr/bin/env python3
import json, os, re, sys
world = json.load(open(os.environ["FAKE_WORLD"]))
args = sys.argv[1:]
if args[:2] == ["search", "prs"]:
    if world.get("failSearch"):
        sys.stderr.write("search is down\\n"); sys.exit(1)
    print(json.dumps(world["searchOpen"] if "--state" in args else world["searchMerged"]))
elif args[:2] == ["api", "graphql"]:
    query = next(a for a in args if a.startswith("query="))
    data, failed = {}, False
    for alias, owner, name, number in re.findall(r'(n\\d+): repository\\(owner: "([^"]+)", name: "([^"]+)"\\).*?issueOrPullRequest\\(number: (\\d+)\\)', query):
        key = f"{owner}/{name}#{number}"
        node = {"defaultBranchRef": {"name": "main"}}
        if key in world["prs"]:
            pr = world["prs"][key]
            node["issueOrPullRequest"] = {
                "__typename": "PullRequest", "state": pr["state"], "isDraft": pr.get("draft", False),
                "mergedAt": "2026-01-01T00:00:00Z" if pr["state"] == "MERGED" else None,
                "baseRefName": pr.get("base", "main"),
                "mergeCommit": {"oid": pr["commit"]} if pr.get("commit") else None,
            }
        elif key in world["issues"]:
            node["issueOrPullRequest"] = {"__typename": "Issue", "state": "OPEN"}
        else:
            node, failed = None, True
        data[alias] = node
    print(json.dumps({"data": data}))
    sys.exit(1 if failed else 0)
else:
    sys.exit(2)
`;

const FAKE_GIT = `#!/usr/bin/env python3
import json, os, sys
world = json.load(open(os.environ["FAKE_WORLD"]))
args = sys.argv[1:]
with open(os.environ["FAKE_WORLD"] + ".git-calls", "a") as f:
    f.write(" ".join(args) + "\\n")
if args[0] == "fetch":
    if world.get("failFetch"):
        sys.stderr.write("fatal: unable to access the remote\\n"); sys.exit(128)
elif args[:2] == ["tag", "--contains"]:
    print("\\n".join(world["tags"].get(args[2], [])))
`;

async function triage(home: string, world: World) {
  const dir = tempHome();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  executable(join(bin, "shu"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  executable(join(bin, "gh"), FAKE_GH);
  executable(join(bin, "git"), FAKE_GIT);

  const worldPath = join(dir, "world.json");
  writeFileSync(
    worldPath,
    JSON.stringify({
      prs: world.prs ?? {},
      issues: world.issues ?? [],
      searchOpen: (world.open ?? []).map((pr) => searchRow(pr, "open")),
      searchMerged: (world.merged ?? []).map((pr) => searchRow(pr, "merged")),
      tags: world.tags ?? {},
      failSearch: world.failSearch ?? false,
      failFetch: world.failFetch ?? false,
    }),
  );
  const config = join(dir, "config.json");
  const deployTags = world.deployConfig === false ? {} : { [REPO]: { clone: dir, pattern: TAG_PATTERN } };
  writeFileSync(config, JSON.stringify({ deployTags }));
  const state = join(dir, "state");

  const proc = Bun.spawn(["python3", SCRIPT], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      SHU_HOME: home,
      SHU_TRIAGE_CONFIG: config,
      SHU_TRIAGE_STATE: state,
      FAKE_WORLD: worldPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const gitCalls = existsSync(`${worldPath}.git-calls`) ? readFileSync(`${worldPath}.git-calls`, "utf8") : "";
  return { exitCode, stdout, stderr, state, gitCalls };
}

// The marks printed for one task: the text between the brackets on its line
function marks(stdout: string, id: string): string {
  const line = stdout.split("\n").find((l) => l.startsWith(id));
  if (!line) throw new Error(`no line for ${id} in:\n${stdout}`);
  return line.match(/\[([^\]]*)\]/)?.[1] ?? "";
}

describe("shu-triage: marks", () => {
  test("merged marks an open task whose pull requests are all merged, and not one with a pull request still open", async () => {
    const home = tempHome();
    const allMerged = await create(home, { title: "All merged", kind: "ticket", refs: [`${REPO}#1`, `${REPO}#2`] });
    const oneOpen = await create(home, { title: "One open", kind: "ticket", refs: [`${REPO}#3`, `${REPO}#4`] });

    const { stdout, stderr, exitCode } = await triage(home, {
      prs: {
        [`${REPO}#1`]: { state: "MERGED" },
        [`${REPO}#2`]: { state: "MERGED" },
        [`${REPO}#3`]: { state: "MERGED" },
        [`${REPO}#4`]: { state: "OPEN", draft: true },
      },
    });

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(marks(stdout, allMerged)).toBe("merged");
    expect(marks(stdout, oneOpen)).toBe("-");
    expect(stdout).toContain(`${REPO}#4 open draft`);
    expect(stdout).toContain("lookups: all succeeded");
  });

  test("a todo task is started with an open pull request and merged once all are merged", async () => {
    const home = tempHome();
    const started = await create(home, { title: "Started", kind: "ticket", status: "todo", refs: [`${REPO}#1`] });
    const merged = await create(home, { title: "Merged", kind: "ticket", status: "todo", refs: [`${REPO}#2`] });
    const untouched = await create(home, { title: "Untouched", kind: "ticket", status: "todo", refs: ["ABC-1"] });

    const { stdout } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "OPEN" }, [`${REPO}#2`]: { state: "MERGED" } },
    });

    expect(marks(stdout, started)).toBe("started");
    expect(marks(stdout, merged)).toBe("merged");
    expect(marks(stdout, untouched)).toBe("-");
  });

  test("shipped marks a waiting task once every pull request is in a deploy tag", async () => {
    const home = tempHome();
    const shipped = await create(home, { title: "Shipped", kind: "ticket", status: "waiting", refs: [`${REPO}#1`] });
    const partly = await create(home, {
      title: "Partly",
      kind: "ticket",
      status: "waiting",
      refs: [`${REPO}#2`, `${REPO}#3`],
    });

    const { stdout, gitCalls } = await triage(home, {
      prs: {
        [`${REPO}#1`]: { state: "MERGED", commit: "aaa" },
        [`${REPO}#2`]: { state: "MERGED", commit: "bbb" },
        [`${REPO}#3`]: { state: "MERGED", commit: "ccc" },
      },
      tags: { aaa: ["prod/1", "prod/2"], bbb: ["prod/2"] },
    });

    expect(marks(stdout, shipped)).toBe("shipped");
    expect(stdout).toContain(`${REPO}#1 merged, shipped in prod/1`);
    expect(marks(stdout, partly)).toBe("-");
    expect(stdout).toContain(`${REPO}#3 merged, not confirmed shipped`);
    // Fetching every tag would also move origin/* under every worktree of the clone
    expect(gitCalls).toContain(`fetch --quiet --no-tags --no-prune origin +refs/tags/${TAG_PATTERN}:refs/tags/${TAG_PATTERN}`);
  });

  test("a pull request merged into another branch is not counted as shipped", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Stacked", kind: "ticket", status: "waiting", refs: [`${REPO}#1`] });

    const { stdout } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED", commit: "aaa", base: "feature" } },
      tags: { aaa: ["prod/1"] },
    });

    expect(marks(stdout, id)).toBe("-");
  });

  test("without a deploy config there is no shipped mark and git is never run", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Waiting", kind: "ticket", status: "waiting", refs: [`${REPO}#1`] });

    const { stdout, gitCalls } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED", commit: "aaa" } },
      tags: { aaa: ["prod/1"] },
      deployConfig: false,
    });

    expect(marks(stdout, id)).toBe("-");
    expect(stdout).toContain(`${REPO}#1 merged\n`);
    expect(gitCalls).toBe("");
  });

  test("blank marks an open task with no pull request and nothing written, and leaves a todo alone", async () => {
    const home = tempHome();
    const blank = await create(home, { title: "Blank", kind: "ticket", refs: ["ABC-1"], body: "Some text" });
    const written = await create(home, { title: "Written", kind: "ticket", refs: ["ABC-2"], body: "Some text" });
    await shu(home, ["log", written, "Looked into it"]);
    const todo = await create(home, { title: "Backlog", kind: "ticket", status: "todo", refs: ["ABC-3"] });

    const { stdout } = await triage(home, {});

    expect(marks(stdout, blank)).toBe("blank");
    expect(marks(stdout, written)).toBe("-");
    expect(marks(stdout, todo)).toBe("-");
    expect(stdout).toContain("not looked up: linear:ABC-1");
  });
});

describe("shu-triage: the user's own pull requests", () => {
  test("a pull request no task refs joins the task whose ticket key is in its title", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Ticket only", kind: "ticket", status: "todo", refs: ["ABC-7"] });

    const { stdout } = await triage(home, {
      merged: [{ number: 9, title: "Drop the unused flag (ABC-7)" }],
      prs: { [`${REPO}#9`]: { state: "MERGED" } },
    });

    expect(marks(stdout, id)).toBe("merged");
    expect(stdout).toContain(`${REPO}#9 merged, not confirmed shipped (matched by title, not a ref yet)`);
  });

  test("a review task never takes one of the user's own pull requests", async () => {
    const home = tempHome();
    const review = await create(home, { title: "Review", kind: "review", refs: ["ABC-7", `${REPO}#1`] });

    const { stdout } = await triage(home, {
      open: [{ number: 9, title: "ABC-7: follow-up" }],
      prs: { [`${REPO}#1`]: { state: "OPEN" } },
    });

    expect(stdout).not.toContain("matched by title");
    expect(marks(stdout, review)).toBe("-");
    expect(stdout).toContain(`${REPO}#9  ABC-7: follow-up`);
  });

  test("an open pull request that no task refs is listed when recent, and merged ones are only counted", async () => {
    const home = tempHome();
    await create(home, { title: "Unrelated", kind: "ticket", refs: [`${REPO}#1`] });

    const { stdout } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "OPEN" } },
      open: [
        { number: 1, title: "Already a ref" },
        { number: 2, title: "Recent and orphaned" },
        { number: 3, title: "Old and orphaned", created: daysAgo(90) },
      ],
      merged: [
        { number: 4, title: "Merged without a task" },
        { number: 5, title: "Another one" },
      ],
    });

    expect(stdout).toContain(`${REPO}#2  Recent and orphaned`);
    expect(stdout).not.toContain("Old and orphaned");
    expect(stdout).not.toContain("Already a ref\n");
    expect(stdout).not.toContain("Merged without a task");
    expect(stdout).toContain("2 merged pull requests of yours");
  });

  test("an open pull request whose ticket belongs to a closed task is pointed out", async () => {
    const home = tempHome();
    const closed = await create(home, { title: "Closed", kind: "ticket", status: "done", refs: ["ABC-7"] });

    const { stdout } = await triage(home, { open: [{ number: 9, title: "ABC-7: one more fix" }] });

    expect(stdout).toContain("Open pull requests whose ticket belongs to a closed task:");
    expect(stdout).toContain(`${REPO}#9  ABC-7: one more fix  -> ${closed} (done)`);
  });
});

describe("shu-triage: a failed lookup is not read as nothing found", () => {
  test("a ref GitHub cannot read is reported and the others still resolve", async () => {
    const home = tempHome();
    const merged = await create(home, { title: "Readable", kind: "ticket", refs: [`${REPO}#1`] });
    const unreadable = await create(home, { title: "Unreadable", kind: "ticket", refs: ["example-org/gone#5"] });

    const { stdout, exitCode } = await triage(home, { prs: { [`${REPO}#1`]: { state: "MERGED" } } });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("LOOKUPS FAILED");
    expect(stdout).toContain("GitHub lookup could not read 1 of 2 refs");
    expect(marks(stdout, merged)).toBe("merged");
    expect(marks(stdout, unreadable)).toBe("-");
    expect(stdout).toContain("example-org/gone#5 state unknown");
  });

  test("a failed search and a failed tag fetch are both reported, and no task is marked shipped", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Waiting", kind: "ticket", status: "waiting", refs: [`${REPO}#1`] });

    const { stdout } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED", commit: "aaa" } },
      tags: { aaa: ["prod/1"] },
      failSearch: true,
      failFetch: true,
    });

    expect(stdout).toContain("LOOKUPS FAILED");
    expect(stdout).toContain("search for open pull requests failed");
    expect(stdout).toContain(`could not fetch ${TAG_PATTERN} tags of ${REPO}`);
    expect(marks(stdout, id)).toBe("-");
  });

  test("an issue ref is shown as an issue and keeps the task from being marked merged", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Issue and PR", kind: "ticket", refs: [`${REPO}#1`, `${REPO}#2`] });

    const { stdout } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED" } },
      issues: [`${REPO}#2`],
    });

    expect(stdout).toContain(`${REPO}#2 issue open`);
    expect(marks(stdout, id)).toBe("-");
  });
});

describe("shu-triage: what it writes", () => {
  test("nothing in SHU changes, and the state folder gets the full text, a backup, and a run record", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Task", kind: "ticket", refs: [`${REPO}#1`], body: "The body" });
    for (const message of ["first", "second", "third", "fourth"]) await shu(home, ["log", id, message]);
    const taskDir = join(home, "tasks", id);
    const before = readdirSync(taskDir).map((name) => [name, readFileSync(join(taskDir, name), "utf8")]);

    const { stdout, state } = await triage(home, { prs: { [`${REPO}#1`]: { state: "MERGED" } } });

    expect(readdirSync(taskDir).map((name) => [name, readFileSync(join(taskDir, name), "utf8")])).toEqual(before);

    const full = readFileSync(join(state, "last.md"), "utf8");
    expect(stdout).toContain(`full text of every task: ${join(state, "last.md")}`);
    expect(full).toContain("The body");
    expect(full).toContain("Last 3 of 4 log entries");
    expect(full).not.toContain("first");
    expect(full).toContain("fourth");

    const [backup] = readdirSync(join(state, "backup"));
    expect(readFileSync(join(state, "backup", backup, `${id}.md`), "utf8")).toBe(readFileSync(join(taskDir, "task.md"), "utf8"));

    const runs = readFileSync(join(state, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(runs).toMatchObject([{ counts: { open: 1 }, marks: { merged: [id] }, problems: 0 }]);
  });

  test("the note is printed on the task's line", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Task", kind: "ticket", refs: ["ABC-1"], body: "x" });
    await shu(home, ["status", "waiting", id, "--note", "Waiting for a reply"]);

    const { stdout } = await triage(home, {});

    expect(stdout.split("\n").find((l) => l.startsWith(id))).toContain("(Waiting for a reply)");
  });
});
