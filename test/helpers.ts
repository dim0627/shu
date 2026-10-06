import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../src/commands";
import { ShuError } from "../src/errors";

export const CLI = join(import.meta.dir, "../src/cli.ts");

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

// Fails the test unless fn throws a ShuError, so an unrelated exception cannot pass for the expected one
export function errorOf(fn: () => unknown): ShuError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ShuError) return e;
    throw e;
  }
  throw new Error("expected a ShuError");
}

export const codeOf = (fn: () => unknown): string => errorOf(fn).code;

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Runs a command with exactly the given environment and collects what it printed
export async function spawnCollect(
  cmd: string[],
  env: Record<string, string | undefined>,
  stdin?: string,
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    env,
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

export function run(home: string, script: string, args: string[], stdin?: string): Promise<RunResult> {
  return spawnCollect([process.execPath, script, ...args], { ...process.env, SHU_HOME: home }, stdin);
}

export function shu(home: string, args: string[], stdin?: string): Promise<RunResult> {
  return run(home, CLI, args, stdin);
}

export async function shuJson(home: string, args: string[], stdin?: string): Promise<RunResult & { json: any }> {
  const result = await shu(home, [...args, "--json"], stdin);
  return { ...result, json: JSON.parse(result.stdout) };
}

export async function create(home: string, input: Record<string, unknown>): Promise<string> {
  return (await shuJson(home, ["save"], JSON.stringify(input))).json.task.id;
}

// Shared with the loop worker so the test can rebuild the exact message each append wrote
export const logMessage = (author: string, i: number) => `${author} #${i} ☕\n${`${i}`.repeat(1000)}\nend`;
