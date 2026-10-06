import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CLI, cleanupHomes, create, shu, spawnCollect, tempHome } from "./helpers";

setDefaultTimeout(30_000);

afterEach(cleanupHomes);

const SCRIPT = join(import.meta.dir, "../skills/shu-triage/triage.py");
const PYTHON = Bun.which("python3") ?? "python3";
const REPO = "example-org/example-repo";
const OTHER = "example-org/other-repo";
const TAG_PATTERN = "prod/*";
const MERGED_ON = "2026-01-01";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

type PrState = { state: "OPEN" | "MERGED" | "CLOSED"; draft?: boolean; base?: string; commit?: string };
type OwnPr = { number: number; title: string; created?: string; repo?: string };

interface World {
  // Pull requests the GraphQL stand-in knows, by "<owner>/<repo>#<number>". A ref left out reads as not found
  prs?: Record<string, PrState>;
  issues?: Record<string, "OPEN" | "CLOSED">;
  open?: OwnPr[];
  merged?: OwnPr[];
  // Merge commit -> the deploy tags that contain it, oldest first
  tags?: Record<string, string[]>;
  // Merge commits the clone does not have
  missingCommits?: string[];
  failSearch?: boolean;
  failFetch?: boolean;
  failTagContains?: boolean;
  // Which programs exist on PATH. Leaving one out is how a machine without it looks
  programs?: ("shu" | "gh" | "git")[];
  deployConfig?: false | { pattern?: string; cloneExists?: boolean };
}

function executable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

const searchRow = (pr: OwnPr) => ({
  number: pr.number,
  title: pr.title,
  createdAt: pr.created ?? daysAgo(1),
  repository: { name: (pr.repo ?? REPO).split("/")[1], nameWithOwner: pr.repo ?? REPO },
});

// The stand-in answers the query the script sent, so the test does not depend on the order of its aliases
const FAKE_GH = `#!${PYTHON}
import json, os, re, sys
world = json.load(open(os.environ["FAKE_WORLD"]))
args = sys.argv[1:]
if args[:2] == ["search", "prs"]:
    if world["failSearch"]:
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
                "mergedAt": "${MERGED_ON}T00:00:00Z" if pr["state"] == "MERGED" else None,
                "baseRefName": pr.get("base", "main"),
                "mergeCommit": {"oid": pr["commit"]} if pr.get("commit") else None,
            }
        elif key in world["issues"]:
            node["issueOrPullRequest"] = {"__typename": "Issue", "state": world["issues"][key]}
        else:
            node, failed = None, True
        data[alias] = node
    print(json.dumps({"data": data}))
    sys.exit(1 if failed else 0)
else:
    sys.exit(2)
`;

// Like git, it lists tags by name unless asked for another order: the world holds them oldest first
const FAKE_GIT = `#!${PYTHON}
import json, os, sys
world = json.load(open(os.environ["FAKE_WORLD"]))
args = sys.argv[1:]
with open(os.environ["FAKE_WORLD"] + ".git-calls", "a") as f:
    f.write(" ".join(args) + "\\n")
if args[0] == "fetch":
    if world["failFetch"]:
        sys.stderr.write("fatal: unable to access the remote\\n"); sys.exit(128)
elif args[0] == "cat-file":
    sys.exit(1 if args[2].split("^")[0] in world["missingCommits"] else 0)
elif args[0] == "tag":
    if world["failTagContains"]:
        sys.stderr.write("fatal: the clone is broken\\n"); sys.exit(128)
    tags = world["tags"].get(args[args.index("--contains") + 1], [])
    print("\\n".join(tags if "--sort=creatordate" in args else sorted(tags)))
`;

async function triage(home: string, world: World = {}) {
  const dir = tempHome();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const programs = world.programs ?? ["shu", "gh", "git"];
  if (programs.includes("shu")) executable(join(bin, "shu"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  if (programs.includes("gh")) executable(join(bin, "gh"), FAKE_GH);
  if (programs.includes("git")) executable(join(bin, "git"), FAKE_GIT);

  const worldPath = join(dir, "world.json");
  writeFileSync(
    worldPath,
    JSON.stringify({
      prs: world.prs ?? {},
      issues: world.issues ?? {},
      searchOpen: (world.open ?? []).map(searchRow),
      searchMerged: (world.merged ?? []).map(searchRow),
      tags: world.tags ?? {},
      missingCommits: world.missingCommits ?? [],
      failSearch: world.failSearch ?? false,
      failFetch: world.failFetch ?? false,
      failTagContains: world.failTagContains ?? false,
    }),
  );
  const config = join(dir, "config.json");
  const deploy = world.deployConfig === false ? null : (world.deployConfig ?? {});
  const clone = deploy?.cloneExists === false ? join(dir, "no-such-clone") : dir;
  const deployTags = deploy ? { [REPO]: { clone, pattern: deploy.pattern ?? TAG_PATTERN } } : {};
  writeFileSync(config, JSON.stringify({ deployTags }));
  const state = join(dir, "state");

  // PATH holds the stand-ins only, so a real gh, git, or shu can never answer
  const result = await spawnCollect([PYTHON, SCRIPT], {
    PATH: bin,
    SHU_HOME: home,
    SHU_TRIAGE_CONFIG: config,
    SHU_TRIAGE_STATE: state,
    FAKE_WORLD: worldPath,
  });
  const gitCalls = existsSync(`${worldPath}.git-calls`) ? readFileSync(`${worldPath}.git-calls`, "utf8") : "";
  return { ...result, state, gitCalls };
}

// The marks printed for one task: the text between the brackets on its line
function marks(stdout: string, id: string): string {
  const line = stdout.split("\n").find((l) => l.startsWith(id));
  if (!line) throw new Error(`no line for ${id} in:\n${stdout}`);
  return line.match(/\[([^\]]*)\]/)?.[1] ?? "";
}

// Every file under a directory with its content, to compare before and after
function snapshot(root: string): [string, string][] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry): [string, string] => {
      const path = join(entry.parentPath, entry.name);
      return [relative(root, path), readFileSync(path, "utf8")];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

const ticket = (extra: Record<string, unknown>) => ({ title: "Task", kind: "ticket", ...extra });

describe("shu-triage: merged and started", () => {
  test("merged marks an open task whose pull requests are all merged, and not one with a pull request still open", async () => {
    const home = tempHome();
    const allMerged = await create(home, ticket({ refs: [`${REPO}#1`, `${REPO}#2`] }));
    const oneOpen = await create(home, ticket({ refs: [`${REPO}#3`, `${REPO}#4`] }));

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
    expect(stdout.startsWith("lookups: all succeeded\n")).toBe(true);
  });

  test("a todo task is started with an open pull request and merged once all are merged", async () => {
    const home = tempHome();
    const started = await create(home, ticket({ status: "todo", refs: [`${REPO}#1`, `${REPO}#2`] }));
    const merged = await create(home, ticket({ status: "todo", refs: [`${REPO}#3`] }));
    const untouched = await create(home, ticket({ status: "todo", refs: ["ABC-1"] }));

    const { stdout } = await triage(home, {
      prs: {
        [`${REPO}#1`]: { state: "MERGED" },
        [`${REPO}#2`]: { state: "OPEN" },
        [`${REPO}#3`]: { state: "MERGED" },
      },
    });

    expect(marks(stdout, started)).toBe("started");
    expect(marks(stdout, merged)).toBe("merged");
    expect(marks(stdout, untouched)).toBe("-");
  });

  test("an issue ref does not count: the pull requests alone decide, whether the issue is open or closed", async () => {
    const home = tempHome();
    const open = await create(home, ticket({ refs: [`${REPO}#1`, `${REPO}#2`] }));
    const todo = await create(home, ticket({ status: "todo", refs: [`${REPO}#3`, `${REPO}#4`] }));

    const { stdout } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED" }, [`${REPO}#3`]: { state: "MERGED" } },
      issues: { [`${REPO}#2`]: "OPEN", [`${REPO}#4`]: "CLOSED" },
    });

    expect(marks(stdout, open)).toBe("merged");
    expect(marks(stdout, todo)).toBe("merged");
    expect(stdout).toContain(`${REPO}#2 issue open`);
    expect(stdout).toContain(`${REPO}#4 issue closed`);
  });

  test("a pull request closed without merging neither blocks merged nor makes a todo started", async () => {
    const home = tempHome();
    const redone = await create(home, ticket({ refs: [`${REPO}#1`, `${REPO}#2`] }));
    const abandoned = await create(home, ticket({ status: "todo", refs: [`${REPO}#3`] }));

    const { stdout } = await triage(home, {
      prs: {
        [`${REPO}#1`]: { state: "CLOSED" },
        [`${REPO}#2`]: { state: "MERGED" },
        [`${REPO}#3`]: { state: "CLOSED" },
      },
    });

    expect(marks(stdout, redone)).toBe("merged");
    expect(marks(stdout, abandoned)).toBe("-");
    expect(stdout).toContain(`${REPO}#1 closed without merging`);
  });

  test("a waiting task whose pull requests are merged is marked merged when no deploy tag covers them", async () => {
    const home = tempHome();
    const id = await create(home, ticket({ status: "waiting", refs: [`${REPO}#1`] }));

    const { stdout, gitCalls } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED", commit: "aaa" } },
      tags: { aaa: ["prod/1"] },
      deployConfig: false,
    });

    expect(marks(stdout, id)).toBe("merged");
    expect(stdout).toContain(`${REPO}#1 merged ${MERGED_ON}\n`);
    expect(gitCalls).toBe("");
  });
});

describe("shu-triage: shipped", () => {
  test("shipped marks a waiting task once every pull request is in a deploy tag, and names the oldest tag", async () => {
    const home = tempHome();
    const shipped = await create(home, ticket({ status: "waiting", refs: [`${REPO}#1`] }));
    const partly = await create(home, ticket({ status: "waiting", refs: [`${REPO}#2`, `${REPO}#3`] }));

    const { stdout, gitCalls } = await triage(home, {
      prs: {
        [`${REPO}#1`]: { state: "MERGED", commit: "aaa" },
        [`${REPO}#2`]: { state: "MERGED", commit: "bbb" },
        [`${REPO}#3`]: { state: "MERGED", commit: "ccc" },
      },
      // By name prod/10 sorts before prod/9, which was cut first
      tags: { aaa: ["prod/9", "prod/10"], bbb: ["prod/10"] },
    });

    expect(marks(stdout, shipped)).toBe("shipped");
    expect(stdout).toContain(`${REPO}#1 merged ${MERGED_ON}, shipped in prod/9`);
    expect(marks(stdout, partly)).toBe("-");
    expect(stdout).toContain(`${REPO}#3 merged ${MERGED_ON}, not confirmed shipped`);
    // Fetching every tag would also move origin/* under every worktree of the clone
    expect(gitCalls).toContain(`fetch --quiet --no-tags --no-prune origin +refs/tags/${TAG_PATTERN}:refs/tags/${TAG_PATTERN}`);
  });

  test("shipped waits for a pull request that is still open in a repository without deploy tags", async () => {
    const home = tempHome();
    const twoRepos = await create(home, ticket({ status: "waiting", refs: [`${REPO}#1`, `${OTHER}#2`] }));
    const bothDone = await create(home, ticket({ status: "waiting", refs: [`${REPO}#3`, `${OTHER}#4`] }));

    const { stdout } = await triage(home, {
      prs: {
        [`${REPO}#1`]: { state: "MERGED", commit: "aaa" },
        [`${OTHER}#2`]: { state: "OPEN" },
        [`${REPO}#3`]: { state: "MERGED", commit: "aaa" },
        [`${OTHER}#4`]: { state: "MERGED" },
      },
      tags: { aaa: ["prod/1"] },
    });

    expect(marks(stdout, twoRepos)).toBe("-");
    expect(marks(stdout, bothDone)).toBe("shipped");
  });

  test("a ref that could not be read keeps a task from being marked shipped, merged, or started", async () => {
    const home = tempHome();
    const waiting = await create(home, ticket({ status: "waiting", refs: [`${REPO}#1`, `${REPO}#404`] }));
    const open = await create(home, ticket({ refs: [`${REPO}#2`, `${REPO}#405`] }));
    const todo = await create(home, ticket({ status: "todo", refs: [`${REPO}#3`, `${REPO}#406`] }));

    const { stdout } = await triage(home, {
      prs: {
        [`${REPO}#1`]: { state: "MERGED", commit: "aaa" },
        [`${REPO}#2`]: { state: "MERGED" },
        [`${REPO}#3`]: { state: "MERGED" },
      },
      tags: { aaa: ["prod/1"] },
    });

    expect(marks(stdout, waiting)).toBe("-");
    expect(marks(stdout, open)).toBe("-");
    expect(marks(stdout, todo)).toBe("-");
    expect(stdout).toContain(`${REPO}#404 state unknown`);
  });

  test("a pull request merged into another branch is not counted as shipped", async () => {
    const home = tempHome();
    const id = await create(home, ticket({ status: "waiting", refs: [`${REPO}#1`] }));

    const { stdout } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED", commit: "aaa", base: "feature" } },
      tags: { aaa: ["prod/1"] },
    });

    expect(marks(stdout, id)).toBe("-");
  });
});

describe("shu-triage: blank", () => {
  test("blank marks an open or waiting task with no pull request that lacks a body or a log, and leaves a todo alone", async () => {
    const home = tempHome();
    const noLog = await create(home, ticket({ refs: ["ABC-1"], body: "Some text" }));
    const noBody = await create(home, ticket({ refs: ["ABC-2"] }));
    await shu(home, ["log", noBody, "Looked into it"]);
    const waiting = await create(home, ticket({ status: "waiting", refs: ["ABC-3"], body: "Some text" }));
    const written = await create(home, ticket({ refs: ["ABC-4"], body: "Some text" }));
    await shu(home, ["log", written, "Looked into it"]);
    const todo = await create(home, ticket({ status: "todo", refs: ["ABC-5"] }));

    const { stdout } = await triage(home);

    expect(marks(stdout, noLog)).toBe("blank");
    expect(marks(stdout, noBody)).toBe("blank");
    expect(marks(stdout, waiting)).toBe("blank");
    expect(marks(stdout, written)).toBe("-");
    expect(marks(stdout, todo)).toBe("-");
    expect(stdout).toContain("not looked up: linear:ABC-1");
  });

  test("an issue ref is not a pull request, and the skill's own log entry is not a log", async () => {
    const home = tempHome();
    const issueOnly = await create(home, ticket({ refs: [`${REPO}#1`] }));
    const ownLogOnly = await create(home, ticket({ refs: ["ABC-1"], body: "Some text" }));
    await shu(home, ["log", ownLogOnly, "status: open → waiting. Asked for a reply.", "--author", "shu-triage"]);

    const { stdout } = await triage(home, { issues: { [`${REPO}#1`]: "OPEN" } });

    expect(marks(stdout, issueOnly)).toBe("blank");
    expect(marks(stdout, ownLogOnly)).toBe("blank");
  });
});

describe("shu-triage: the user's own pull requests", () => {
  test("a pull request no task refs joins the task whose ticket key is in its title", async () => {
    const home = tempHome();
    const id = await create(home, ticket({ status: "todo", refs: ["ABC-7"] }));

    const { stdout } = await triage(home, {
      merged: [{ number: 9, title: "Drop the unused flag (ABC-7)" }],
      prs: { [`${REPO}#9`]: { state: "MERGED" } },
    });

    expect(marks(stdout, id)).toBe("merged");
    expect(stdout).toContain(
      `${REPO}#9 merged ${MERGED_ON}, not confirmed shipped (matched by title: add it as a ref)`,
    );
  });

  test("a key in a title is read the way SHU normalizes a linear ref, and next to any text", async () => {
    const home = tempHome();
    const lower = await create(home, ticket({ status: "todo", refs: ["ABC-7"] }));
    const padded = await create(home, ticket({ status: "todo", refs: ["DEF-7"] }));
    const single = await create(home, ticket({ status: "todo", refs: ["X-12"] }));
    const nonAscii = await create(home, ticket({ status: "todo", refs: ["GHI-3"] }));
    const underscore = await create(home, ticket({ status: "todo", refs: ["JKL-4"] }));
    const unrelated = await create(home, ticket({ status: "todo", refs: ["MNO-5"] }));

    const titles = ["abc-7: lower case", "DEF-007 zero padded", "X-12 one letter", "GHI-3ü fix", "JKL-4_followup", "XMNO-55 other"];
    const { stdout } = await triage(home, {
      open: titles.map((title, i) => ({ number: i + 1, title })),
      prs: Object.fromEntries(titles.map((_, i) => [`${REPO}#${i + 1}`, { state: "OPEN" as const }])),
    });

    for (const id of [lower, padded, single, nonAscii, underscore]) expect(marks(stdout, id)).toBe("started");
    expect(marks(stdout, unrelated)).toBe("-");
    expect(stdout).toContain(`${REPO}#6  XMNO-55 other`);
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

  test("of the pull requests no task refs, recent open ones are listed and the rest are counted", async () => {
    const home = tempHome();
    await create(home, ticket({ refs: ["Example-Org/Example-Repo#1"] }));
    await create(home, ticket({ status: "done", refs: ["ABC-9"] }));

    const { stdout } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "OPEN" } },
      open: [
        // GitHub answers in the repository's own case; SHU stores the ref in lowercase
        { number: 1, title: "Already a ref", repo: "Example-Org/Example-Repo" },
        { number: 2, title: "Recent and orphaned" },
        { number: 3, title: "Old and orphaned", created: daysAgo(90) },
      ],
      merged: [
        { number: 4, title: "Merged without a task" },
        { number: 5, title: "Another one" },
        { number: 6, title: "ABC-9: belongs to a closed task" },
      ],
    });

    expect(stdout).toContain(`${REPO}#2  Recent and orphaned`);
    expect(stdout).not.toContain("Old and orphaned");
    expect(stdout).toContain("1 older open pull requests of yours belong to no task (not listed).");
    expect(stdout).not.toContain("Already a ref\n");
    expect(stdout).not.toContain("Merged without a task");
    expect(stdout).toContain("2 pull requests of yours merged in the last 14 days belong to no task (not listed).");
  });

  test("an open pull request that belongs to a closed task is pointed out, by its title or by a ref", async () => {
    const home = tempHome();
    const byTitle = await create(home, ticket({ status: "done", refs: ["ABC-7"] }));
    const byRef = await create(home, ticket({ status: "dropped", refs: [`${REPO}#10`] }));

    const { stdout } = await triage(home, {
      open: [
        { number: 9, title: "ABC-7: one more fix" },
        { number: 10, title: "Still open" },
      ],
    });

    expect(stdout).toContain("Open pull requests of yours that belong to a closed task:");
    expect(stdout).toContain(`${REPO}#9  ABC-7: one more fix  -> ${byTitle} (done)`);
    expect(stdout).toContain(`${REPO}#10  Still open  -> ${byRef} (dropped)`);
  });
});

describe("shu-triage: a failed lookup is not read as nothing found", () => {
  const FAILED = "LOOKUPS FAILED, so a mark below, or the lack of one, may be wrong:\n";

  test("a ref GitHub cannot read is reported on the first line and the others still resolve", async () => {
    const home = tempHome();
    const merged = await create(home, ticket({ refs: [`${REPO}#1`] }));
    const unreadable = await create(home, ticket({ refs: ["example-org/gone#5"], body: "x" }));
    await shu(home, ["log", unreadable, "Looked into it"]);

    const { stdout, exitCode } = await triage(home, { prs: { [`${REPO}#1`]: { state: "MERGED" } } });

    expect(exitCode).toBe(0);
    expect(stdout.startsWith(FAILED)).toBe(true);
    expect(stdout).toContain("GitHub lookup could not read 1 of 2 refs");
    expect(marks(stdout, merged)).toBe("merged");
    expect(marks(stdout, unreadable)).toBe("-");
    expect(stdout).toContain("example-org/gone#5 state unknown");
  });

  test("a failed search and a failed tag fetch are both reported, and no task is marked shipped", async () => {
    const home = tempHome();
    const id = await create(home, ticket({ status: "waiting", refs: [`${REPO}#1`] }));

    const { stdout } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED", commit: "aaa" } },
      tags: { aaa: ["prod/1"] },
      failSearch: true,
      failFetch: true,
    });

    expect(stdout.startsWith(FAILED)).toBe(true);
    expect(stdout).toContain("search for your open pull requests failed");
    expect(stdout).toContain(`could not fetch ${TAG_PATTERN} tags of ${REPO}`);
    expect(marks(stdout, id)).toBe("-");
  });

  test("a machine without gh or git still gets its tasks listed, with the failure reported", async () => {
    const home = tempHome();
    const id = await create(home, ticket({ status: "waiting", refs: [`${REPO}#1`], body: "x" }));

    const { stdout, stderr, exitCode } = await triage(home, { programs: ["shu"] });

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.startsWith(FAILED)).toBe(true);
    expect(stdout).toContain("search for your open pull requests failed");
    expect(stdout).toContain("GitHub lookup failed");
    expect(marks(stdout, id)).toBe("-");
  });

  test("a clone directory that does not exist is a failed lookup, not a crash", async () => {
    const home = tempHome();
    const id = await create(home, ticket({ status: "waiting", refs: [`${REPO}#1`] }));

    const { stdout, exitCode } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED", commit: "aaa" } },
      deployConfig: { cloneExists: false },
    });

    expect(exitCode).toBe(0);
    expect(stdout.startsWith(FAILED)).toBe(true);
    expect(stdout).toContain(`could not fetch ${TAG_PATTERN} tags of ${REPO}`);
    expect(marks(stdout, id)).toBe("-");
  });

  test("a pattern that is not a valid refspec is refused before git is run", async () => {
    const home = tempHome();
    await create(home, ticket({ status: "waiting", refs: [`${REPO}#1`] }));

    const { stdout, gitCalls } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED", commit: "aaa" } },
      deployConfig: { pattern: "v[0-9]*" },
    });

    expect(stdout.startsWith(FAILED)).toBe(true);
    expect(stdout).toContain("deployTags pattern v[0-9]* for example-org/example-repo may hold one `*` and no `?` or `[`");
    expect(gitCalls).toBe("");
  });

  test("a merge commit the clone lacks is simply not shipped, but a failing tag lookup is reported", async () => {
    const home = tempHome();
    await create(home, ticket({ status: "waiting", refs: [`${REPO}#1`] }));
    const world: World = { prs: { [`${REPO}#1`]: { state: "MERGED", commit: "aaa" } }, failTagContains: true };

    const notDeployed = await triage(home, { ...world, missingCommits: ["aaa"] });
    const broken = await triage(home, world);

    expect(notDeployed.stdout.startsWith("lookups: all succeeded\n")).toBe(true);
    expect(notDeployed.stdout).toContain(`${REPO}#1 merged ${MERGED_ON}, not confirmed shipped`);
    expect(broken.stdout.startsWith(FAILED)).toBe(true);
    expect(broken.stdout).toContain(`could not check the deploy tags of ${REPO}#1: fatal: the clone is broken`);
  });

  test("without shu the script stops and says how to install it", async () => {
    const { stdout, stderr, exitCode } = await triage(tempHome(), { programs: ["gh", "git"] });

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("install the latest: curl -fsSL https://raw.githubusercontent.com/dim0627/shu/main/scripts/install.sh | sh");
    expect(stderr).not.toContain("Traceback");
  });
});

describe("shu-triage: what it writes", () => {
  test("nothing under SHU_HOME changes, and the state folder gets the full text, a backup, and a run record", async () => {
    const home = tempHome();
    const id = await create(home, ticket({ refs: [`${REPO}#1`], body: "The body" }));
    for (const message of ["first", "second", "third", "fourth"]) await shu(home, ["log", id, message]);
    await create(home, ticket({ status: "waiting", refs: ["ABC-1"] }));
    await create(home, ticket({ status: "todo", refs: ["ABC-2"] }));
    await create(home, ticket({ status: "done", refs: ["ABC-3"] }));
    const before = snapshot(home);

    const { stdout, state } = await triage(home, {
      prs: { [`${REPO}#1`]: { state: "MERGED" }, [`${REPO}#2`]: { state: "OPEN" } },
      open: [{ number: 2, title: "ABC-2: started" }, { number: 3, title: "No task at all" }],
    });

    expect(snapshot(home)).toEqual(before);

    const full = readFileSync(join(state, "last.md"), "utf8");
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(`full text of every task: ${join(state, "last.md")}`);
    expect(full).toContain("The body");
    expect(full).toContain("Last 3 of 4 log entries");
    expect(full).not.toContain("first");
    expect(full).toContain("fourth");

    const [backup] = readdirSync(join(state, "backup"));
    expect(readdirSync(join(state, "backup", backup))).toHaveLength(3);
    expect(readFileSync(join(state, "backup", backup, `${id}.md`), "utf8")).toBe(
      readFileSync(join(home, "tasks", id, "task.md"), "utf8"),
    );

    const runs = readFileSync(join(state, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(runs).toMatchObject([
      { counts: { open: 1, waiting: 1, todo: 1 }, marks: { merged: [id] }, unmatchedOpenPullRequests: 1, problems: 0 },
    ]);
  });

  test("the note is printed on the task's line, and non-ASCII text survives", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Café ☕ naïve", kind: "ticket", refs: ["ABC-1"], body: "Übung" });
    await shu(home, ["status", "waiting", id, "--note", "Waiting — for a reply"]);

    const { stdout, state } = await triage(home);

    expect(stdout.split("\n").find((l) => l.startsWith(id))).toContain("Café ☕ naïve  (Waiting — for a reply)");
    expect(readFileSync(join(state, "last.md"), "utf8")).toContain("Übung");
  });
});
