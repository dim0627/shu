import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../src/commands";

const CLI = join(import.meta.dir, "../src/cli.ts");

const homes: string[] = [];

export function cleanupHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}

// Tests must never touch the real ~/.shu: every SHU_HOME comes from here
export function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "shu-test-"));
  homes.push(home);
  return home;
}

export function testCtx(overrides: Partial<Ctx> = {}): Ctx {
  return { home: tempHome(), now: () => new Date(), random: Math.random, ...overrides };
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function run(home: string, script: string, args: string[], stdin?: string): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    env: { ...process.env, SHU_HOME: home },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
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

export function shu(home: string, args: string[], stdin?: string): Promise<RunResult> {
  return run(home, CLI, args, stdin);
}

export async function shuJson(home: string, args: string[], stdin?: string): Promise<RunResult & { json: any }> {
  const result = await shu(home, [...args, "--json"], stdin);
  return { ...result, json: JSON.parse(result.stdout) };
}
