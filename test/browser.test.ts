import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, cleanupHomes, create, shu, shuJson, tempHome } from "./helpers";

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

// PATH holds only a stand-in for shu that runs this checkout, so a shu installed on the machine never answers
function shuOnPath(): string {
  const bin = tempHome();
  writeFileSync(join(bin, "shu"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(bin, "shu"), 0o755);
  return bin;
}

async function ask(home: string, messages: unknown[], path = shuOnPath()) {
  const proc = Bun.spawn([PYTHON, HOST], {
    env: { PATH: path, HOME: tempHome(), SHU_HOME: home },
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

  test("answers task null for a page no task refs", async () => {
    const home = tempHome();
    await create(home, { title: "Another", kind: "review", refs: ["https://github.com/example-org/example-repo/pull/1"] });
    expect(await ask(home, [{ url: PR }])).toEqual([{ task: null }]);
  });

  test("answers task null for a page that is not http(s), without running shu", async () => {
    expect(await ask(tempHome(), [{ url: "chrome://newtab/" }, { url: "file:///etc/hosts" }], "")).toEqual([
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

  // HOME is a temporary directory, but these two are searched as they are
  const realShuNearby = ["/opt/homebrew/bin", "/usr/local/bin"].some((d) => existsSync(join(d, "shu")));
  test.skipIf(realShuNearby)("says where it looked when shu is nowhere", async () => {
    const [reply] = await ask(tempHome(), [{ url: PR }], "");
    expect(reply.error.code).toBe("host");
    expect(reply.error.message).toContain("shu was not found in PATH");
  });
});

describe("install.sh", () => {
  async function install(args: string[], hostsDir: string) {
    const proc = Bun.spawn(["sh", INSTALLER, ...args], {
      env: { PATH: process.env.PATH, HOME: tempHome(), SHU_CHROME_HOSTS_DIR: hostsDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { stderr, exitCode };
  }

  test("registers host.py under the name the extension calls, for that extension only", async () => {
    const dir = join(tempHome(), "NativeMessagingHosts");
    expect((await install([EXTENSION_ID], dir)).exitCode).toBe(0);
    expect(readdirSync(dir)).toEqual([`${HOST_NAME}.json`]);
    expect(JSON.parse(readFileSync(join(dir, `${HOST_NAME}.json`), "utf8"))).toEqual({
      name: HOST_NAME,
      description: expect.any(String),
      path: HOST,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
  });

  test.each([[[]], [["abc"]], [[EXTENSION_ID.toUpperCase()]], [[`${EXTENSION_ID}q`]], [["abcdefghijklmnopabcdefghijklmnoz"]]])(
    "refuses %j as an extension ID and writes nothing",
    async (args) => {
      const dir = join(tempHome(), "NativeMessagingHosts");
      const { stderr, exitCode } = await install(args, dir);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("install.sh");
      expect(existsSync(dir)).toBe(false);
    },
  );
});

test("the extension asks for native messaging", () => {
  const manifest = JSON.parse(readFileSync(join(BROWSER, "chrome/manifest.json"), "utf8"));
  expect(manifest.permissions).toContain("nativeMessaging");
});
