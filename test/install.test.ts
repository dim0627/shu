import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupHomes, tempHome } from "./helpers";

setDefaultTimeout(30_000);

afterEach(cleanupHomes);

const INSTALLER = join(import.meta.dir, "../scripts/install.sh");
const TAG = "v9.9.9";
const ASSET = `shu-${process.platform}-${process.arch}`;
const FAKE_BINARY = "#!/bin/sh\necho fake-shu\n";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

// A release laid out like GitHub's download URLs, served over file:// so the test stays offline
function fakeRelease(checksums: string): string {
  const base = tempHome();
  mkdirSync(join(base, TAG));
  writeFileSync(join(base, TAG, ASSET), FAKE_BINARY);
  writeFileSync(join(base, TAG, "checksums.txt"), checksums);
  return base;
}

async function install(base: string, installDir: string) {
  const proc = Bun.spawn(["sh", INSTALLER], {
    env: {
      PATH: process.env.PATH,
      HOME: tempHome(),
      SHU_VERSION: TAG,
      SHU_DOWNLOAD_BASE: `file://${base}`,
      SHU_INSTALL_DIR: installDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("install.sh", () => {
  test("installs a binary whose checksum matches, creating the directory", async () => {
    const base = fakeRelease(`${sha256("other")}  shu-other-target\n${sha256(FAKE_BINARY)}  ${ASSET}\n`);
    const installDir = join(tempHome(), "nested", "bin");

    const { exitCode, stdout, stderr } = await install(base, installDir);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Installed shu ${TAG}`);
    expect(readdirSync(installDir)).toEqual(["shu"]);
    expect(statSync(join(installDir, "shu")).mode & 0o777).toBe(0o755);
    expect(Bun.spawnSync([join(installDir, "shu")]).stdout.toString()).toBe("fake-shu\n");
  });

  test("a checksum mismatch fails and leaves the existing binary untouched", async () => {
    const base = fakeRelease(`${sha256("something else")}  ${ASSET}\n`);
    const installDir = tempHome();
    writeFileSync(join(installDir, "shu"), "previous");

    const { exitCode, stderr } = await install(base, installDir);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("SHA-256 mismatch");
    expect(readdirSync(installDir)).toEqual(["shu"]);
    expect(readFileSync(join(installDir, "shu"), "utf8")).toBe("previous");
  });

  test("an asset missing from checksums.txt fails without installing", async () => {
    // A longer name that ends with the asset name must not count as a match
    const base = fakeRelease(`${sha256(FAKE_BINARY)}  x${ASSET}\n`);
    const installDir = tempHome();

    const { exitCode, stderr } = await install(base, installDir);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("not listed in checksums.txt");
    expect(readdirSync(installDir)).toEqual([]);
  });

  test("a failed download fails without installing", async () => {
    const installDir = tempHome();

    const { exitCode } = await install(tempHome(), installDir);

    expect(exitCode).not.toBe(0);
    expect(readdirSync(installDir)).toEqual([]);
  });
});
