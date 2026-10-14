import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error The extension is plain JavaScript, loaded by Chrome as is
import { refLink, showBadge } from "../browser/chrome/lookup.js";
import { cleanupHomes, create, executable, SHU_STAND_IN, shu, shuJson, spawnCollect, tempHome } from "./helpers";

setDefaultTimeout(30_000);

afterEach(cleanupHomes);

const BROWSER = join(import.meta.dir, "../browser");
const HOST = join(BROWSER, "host.py");
const INSTALLER = join(BROWSER, "install.sh");
const PYTHON = Bun.which("python3") ?? "python3";
const PR = "https://github.com/example-org/example-repo/pull/482";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

const HOST_NAME = /export const HOST = "([^"]+)"/.exec(readFileSync(join(BROWSER, "chrome/lookup.js"), "utf8"))![1];

function frame(message: unknown): Buffer {
  const body = Buffer.from(typeof message === "string" ? message : JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function unframe(data: Buffer): any[] {
  const replies = [];
  for (let at = 0; at < data.length; ) {
    const length = data.readUInt32LE(at);
    replies.push(JSON.parse(data.subarray(at + 4, at + 4 + length).toString("utf8")));
    at += 4 + length;
  }
  return replies;
}

function binWith(shuScript: string): string {
  const bin = tempHome();
  executable(join(bin, "shu"), shuScript);
  return bin;
}

interface Setup {
  // What install.sh would have recorded; null for no record
  config?: { shu: string; shu_home: string | null } | null;
  path?: string;
  env?: Record<string, string>;
}

// The environment is exactly what is given, as Chrome started from the Dock passes little:
// no SHU_HOME, and a PATH that holds no shu unless a test puts one there
async function ask(home: string, messages: unknown[], setup: Setup = {}) {
  const userHome = tempHome();
  const config =
    setup.config === undefined ? { shu: join(binWith(SHU_STAND_IN), "shu"), shu_home: home } : setup.config;
  if (config) {
    mkdirSync(join(userHome, ".config/shu"), { recursive: true });
    writeFileSync(join(userHome, ".config/shu/browser-host.json"), JSON.stringify(config));
  }
  const proc = Bun.spawn([PYTHON, HOST], {
    env: { PATH: setup.path ?? "", HOME: userHome, ...setup.env },
    stdin: Buffer.concat(messages.map(frame)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return unframe(Buffer.from(stdout));
}

describe("host", () => {
  test("answers with the task that refs the page, its last 3 log entries, artifacts, and directory", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Fix the login redirect", kind: "review", refs: [PR] });
    for (const n of [1, 2, 3, 4, 5]) await shu(home, ["log", id, `entry ${n}`]);
    const file = join(tempHome(), "brief.md");
    writeFileSync(file, "# Brief\n");
    await shu(home, ["artifact", id, file]);

    const [reply] = await ask(home, [{ url: `${PR}/files#diff-abc` }]);

    expect(reply.task.id).toBe(id);
    expect(reply.log.map((e: { message: string }) => e.message)).toEqual(["entry 3", "entry 4", "entry 5"]);
    expect(reply.log_total).toBe(5);
    expect(reply.artifacts).toEqual(["brief.md"]);
    expect(reply.path).toBe((await shuJson(home, ["path", id])).json.path);
  });

  test("reads the store install.sh recorded, and SHU_HOME from the environment over it", async () => {
    const recorded = tempHome();
    const live = tempHome();
    const inRecorded = await create(recorded, { title: "Recorded", kind: "review", refs: [PR] });
    const inLive = await create(live, { title: "Live", kind: "review", refs: [PR] });
    const config = { shu: join(binWith(SHU_STAND_IN), "shu"), shu_home: recorded };

    const [fromRecord] = await ask(recorded, [{ url: PR }], { config });
    const [fromEnv] = await ask(recorded, [{ url: PR }], { config, env: { SHU_HOME: live } });

    expect(fromRecord.task.id).toBe(inRecorded);
    expect(fromEnv.task.id).toBe(inLive);
  });

  test("finds shu on PATH when nothing was recorded", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Fix the login redirect", kind: "review", refs: [PR] });
    const [reply] = await ask(home, [{ url: PR }], {
      config: null,
      path: binWith(SHU_STAND_IN),
      env: { SHU_HOME: home },
    });
    expect(reply.task.id).toBe(id);
  });

  test("answers task null for a page no task refs", async () => {
    const home = tempHome();
    await create(home, { title: "Another", kind: "review", refs: ["https://github.com/example-org/example-repo/pull/1"] });
    expect(await ask(home, [{ url: PR }])).toEqual([{ task: null }]);
  });

  test("finds a url ref from the page with a fragment, but not with another query", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Read the docs", kind: "research", refs: ["https://docs.example.com/page"] });
    const replies = await ask(home, [
      { url: "https://docs.example.com/page#intro" },
      { url: "https://docs.example.com/page?tab=1" },
    ]);
    expect(replies.map((r) => r.task?.id ?? null)).toEqual([id, null]);
  });

  // With no shu to be found, looking for one would answer an error, not task null
  test("answers task null for a page that is not http(s), without looking for shu", async () => {
    expect(await ask(tempHome(), [{ url: "chrome://newtab/" }, { url: "file:///etc/hosts" }], { config: null })).toEqual([
      { task: null },
      { task: null },
    ]);
  });

  test("answers task null for a message it cannot read, and keeps answering", async () => {
    const home = tempHome();
    const id = await create(home, { title: "Fix the login redirect", kind: "review", refs: [PR] });
    const replies = await ask(home, ["not json", { nourl: true }, { url: PR }]);
    expect(replies.slice(0, 2)).toEqual([{ task: null }, { task: null }]);
    expect(replies[2].task.id).toBe(id);
  });

  test("answers several messages in order in one run", async () => {
    const home = tempHome();
    const first = await create(home, { title: "First", kind: "review", refs: [PR] });
    const second = await create(home, { title: "Second", kind: "review", refs: ["linear:ABC-123"] });
    const replies = await ask(home, [
      { url: "https://linear.app/example/issue/ABC-123/some-title" },
      { url: "https://github.com/example-org/example-repo/pull/9" },
      { url: PR },
    ]);
    expect(replies.map((r) => r.task?.id ?? null)).toEqual([second, null, first]);
  });

  test("passes on an error from shu instead of reading it as no task", async () => {
    const home = tempHome();
    await create(home, { title: "Fix the login redirect", kind: "review", refs: [PR] });
    mkdirSync(join(home, "tasks", "20260101-aoi-kitsune"));
    writeFileSync(join(home, "tasks", "20260101-aoi-kitsune", "task.md"), "not a task\n");

    const [reply] = await ask(home, [{ url: PR }]);

    expect(reply.error.code).toBe("invalid_task");
  });

  test("says how to install shu when none is recorded or on PATH", async () => {
    const [reply] = await ask(tempHome(), [{ url: PR }], { config: null });
    expect(reply.error.code).toBe("host");
    expect(reply.error.message).toContain("shu was not found");
    expect(reply.error.message).toContain("install.sh | sh");
  });

  test("says how to install the latest when shu does not know an option the host uses", async () => {
    const oldShu = `#!/bin/sh
case "$1" in
  find) echo '{"task": {"id": "20260101-aoi-kitsune"}}' ;;
  *) echo '{"error": {"code": "invalid_input", "message": "Unknown option --log"}}'; exit 1 ;;
esac
`;
    const [reply] = await ask(tempHome(), [{ url: PR }], {
      config: { shu: join(binWith(oldShu), "shu"), shu_home: null },
    });
    expect(reply.error.code).toBe("invalid_input");
    expect(reply.error.message).toContain("older than 0.6.0");
  });

  test("answers an error instead of dying when shu writes what is not UTF-8, and keeps answering", async () => {
    const broken = "#!/bin/sh\nprintf '\\377' >&2\nexit 1\n";
    const replies = await ask(tempHome(), [{ url: PR }, { url: "chrome://newtab/" }], {
      config: { shu: join(binWith(broken), "shu"), shu_home: null },
    });
    expect(replies[0].error.code).toBe("host");
    expect(replies[1]).toEqual({ task: null });
  });
});

describe("install.sh", () => {
  async function install(args: string[], options: { shu?: boolean; env?: Record<string, string> } = {}) {
    const home = tempHome();
    const hostsDir = join(home, "NativeMessagingHosts");
    const bin = options.shu === false ? tempHome() : binWith(SHU_STAND_IN);
    const result = await spawnCollect(["sh", INSTALLER, ...args], {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      SHU_CHROME_HOSTS_DIR: hostsDir,
      ...options.env,
    });
    return { ...result, hostsDir, bin, config: join(home, ".config/shu/browser-host.json") };
  }

  test("registers host.py under the name the extension calls, for that extension only", async () => {
    const { exitCode, hostsDir } = await install([EXTENSION_ID]);
    expect(exitCode).toBe(0);
    expect(readdirSync(hostsDir)).toEqual([`${HOST_NAME}.json`]);
    expect(JSON.parse(readFileSync(join(hostsDir, `${HOST_NAME}.json`), "utf8"))).toEqual({
      name: HOST_NAME,
      description: expect.any(String),
      path: HOST,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
  });

  test("records the shu on PATH and SHU_HOME for the host", async () => {
    const store = tempHome();
    const { exitCode, bin, config } = await install([EXTENSION_ID], { env: { SHU_HOME: store } });
    expect(exitCode).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ shu: join(bin, "shu"), shu_home: store });
  });

  test("records no SHU_HOME when none is set", async () => {
    const { config } = await install([EXTENSION_ID]);
    expect(JSON.parse(readFileSync(config, "utf8")).shu_home).toBeNull();
  });

  test.each([
    ["no shu on PATH", { shu: false }],
    ["a relative SHU_HOME", { env: { SHU_HOME: "relative/store" } }],
  ])("refuses %s and writes nothing", async (_, options) => {
    const { exitCode, stderr, hostsDir, config } = await install([EXTENSION_ID], options);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("install.sh");
    expect(existsSync(hostsDir)).toBe(false);
    expect(existsSync(config)).toBe(false);
  });

  // A UTF-8 locale lets [a-p] match uppercase letters; the uppercase ID avoids P, which no locale lets through
  test.each([
    [[]],
    [["abc"]],
    [["ABCDEFGHIJKLMNOaABCDEFGHIJKLMNOa"]],
    [[`${EXTENSION_ID}a`]],
    [["abcdefghijklmnopabcdefghijklmnoz"]],
  ])("refuses %j as an extension ID in a UTF-8 locale and writes nothing", async (args) => {
    const { exitCode, stderr, hostsDir } = await install(args, { env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("install.sh");
    expect(existsSync(hostsDir)).toBe(false);
  });
});

describe("extension", () => {
  test("asks for native messaging", () => {
    const manifest = JSON.parse(readFileSync(join(BROWSER, "chrome/manifest.json"), "utf8"));
    expect(manifest.permissions).toContain("nativeMessaging");
  });

  test.each([
    ["github:example-org/example-repo#482", "https://github.com/example-org/example-repo/issues/482"],
    ["linear:ABC-123", "https://linear.app/issue/ABC-123"],
    ["notion:3f1aeded16c681daa8e9d45d2ea4c74e", "https://www.notion.so/3f1aeded16c681daa8e9d45d2ea4c74e"],
    ["slack:https://example.slack.com/archives/C01/p1700000000000100", "https://example.slack.com/archives/C01/p1700000000000100"],
    ["url:https://docs.example.com/page", "https://docs.example.com/page"],
    ["url:javascript:alert(1)", null],
  ])("links %s to %s", (ref, href) => {
    expect(refLink(ref).href).toBe(href);
  });

  test.each([
    [{ task: { title: "Fix it" } }, "●", "SHU: Fix it"],
    [{ task: null }, "", "SHU: no task"],
    [{ error: { code: "host", message: "broken" } }, "!", "SHU: broken"],
  ])("badges %j", async (reply, text, title) => {
    const calls: Record<string, unknown> = {};
    const record = (name: string) => async (details: unknown) => {
      calls[name] = details;
    };
    (globalThis as any).chrome = {
      action: {
        setBadgeBackgroundColor: record("color"),
        setBadgeTextColor: record("textColor"),
        setBadgeText: record("text"),
        setTitle: record("title"),
      },
    };
    try {
      await showBadge(7, reply);
    } finally {
      delete (globalThis as any).chrome;
    }
    expect(calls.text).toEqual({ tabId: 7, text });
    expect(calls.title).toEqual({ tabId: 7, title });
  });
});
