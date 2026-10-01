#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import pkg from "../package.json";
import * as commands from "./commands";
import { ShuError } from "./errors";
import { formatList, formatShow, formatTask } from "./format";

const HELP = `shu — a local task store for humans and AI agents

Usage:
  shu list [--status <s>]... [--kind <k>]... [--all]
      List tasks, most recently updated first (open / waiting by default)
  shu show <id>
      Show a task: metadata, body, log entries, and artifact file names
  shu save [--remove-ref <ref>]...
      Create or update a task from JSON on standard input
        {"id": "...", "title": "...", "kind": "...", "status": "...", "refs": ["..."], "body": "..."}
      With id, that task is updated. Without id, a task that already owns one of
      refs is updated; otherwise a new task is created (title and kind required).
      refs are added to the existing ones
  shu find --ref <ref>
      Look up the task that owns a ref
  shu log <id> [message] [--author <name>]
      Append one log entry (reads the message from standard input if omitted)
  shu artifact <id> <file> [--name <name>] [--force]
      Copy a file into the task (<file> of - reads standard input; needs --name)
  shu path <id>
      Print the absolute path of the task directory

Common options:
  --json       Print only JSON to standard output (errors as {"error": {"code", "message"}})
  --help, -h   Show this help
  --version    Show the version

<id>     The full ID (20261001-aoi-kitsune) or just its words (aoi-kitsune)
status   open / waiting / done / dropped
<ref>    github:<owner>/<repo>#<number>, linear:<KEY>-<number>, slack:<permalink>, url:<URL>
         (URLs and short forms such as owner/repo#482 or abc-123 are normalized)
Storage  ~/.shu (override with the SHU_HOME environment variable)`;

interface Output {
  data: unknown;
  text: string;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

const GLOBAL_OPTIONS: Options = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
};

const COMMAND_OPTIONS: Record<string, Options> = {
  list: {
    status: { type: "string", multiple: true },
    kind: { type: "string", multiple: true },
    all: { type: "boolean" },
  },
  show: {},
  save: { "remove-ref": { type: "string", multiple: true } },
  find: { ref: { type: "string" } },
  log: { author: { type: "string" } },
  artifact: { name: { type: "string" }, force: { type: "boolean" } },
  path: {},
};

function usage(message: string): ShuError {
  return new ShuError("invalid_input", `${message} (see shu --help)`);
}

function parse(args: string[], options: Options) {
  try {
    return parseArgs({ args, options: { ...GLOBAL_OPTIONS, ...options }, allowPositionals: true });
  } catch (e) {
    throw usage((e as Error).message);
  }
}

function expectPositionals(positionals: string[], min: number, max: number, synopsis: string): void {
  if (positionals.length < min || positionals.length > max) throw usage(`usage: shu ${synopsis}`);
}

async function dispatch(argv: string[]): Promise<Output> {
  const commandIndex = argv.findIndex((arg) => !arg.startsWith("-"));
  const command = commandIndex === -1 ? undefined : argv[commandIndex];
  const rest = argv.filter((_, index) => index !== commandIndex);

  if (command !== undefined && !(command in COMMAND_OPTIONS)) {
    throw usage(`unknown command: ${command}`);
  }
  const { values, positionals } = parse(rest, command === undefined ? {} : COMMAND_OPTIONS[command]);
  if (values.version) return { data: { version: pkg.version }, text: pkg.version };
  if (values.help || command === undefined) return { data: { help: HELP }, text: HELP };

  const ctx: commands.Ctx = {
    home: resolve(process.env.SHU_HOME || join(homedir(), ".shu")),
    now: () => new Date(),
    random: Math.random,
  };

  switch (command) {
    case "list": {
      expectPositionals(positionals, 0, 0, "list [--status <s>]... [--kind <k>]... [--all]");
      const data = commands.list(ctx, {
        statuses: values.status as string[] | undefined,
        kinds: values.kind as string[] | undefined,
        all: values.all as boolean | undefined,
      });
      return { data, text: formatList(data.tasks) };
    }
    case "show": {
      expectPositionals(positionals, 1, 1, "show <id>");
      const data = commands.show(ctx, positionals[0]);
      return { data, text: formatShow(data.task, data.log, data.artifacts) };
    }
    case "save": {
      expectPositionals(positionals, 0, 0, "save [--remove-ref <ref>]...  (JSON on standard input)");
      const data = commands.save(ctx, await Bun.stdin.text(), (values["remove-ref"] as string[]) ?? []);
      return { data, text: `${data.result} ${data.task.id}` };
    }
    case "find": {
      expectPositionals(positionals, 0, 0, "find --ref <ref>");
      if (typeof values.ref !== "string") throw usage("usage: shu find --ref <ref>");
      const data = commands.find(ctx, values.ref);
      return { data, text: formatTask(data.task) };
    }
    case "log": {
      expectPositionals(positionals, 1, 2, "log <id> [message] [--author <name>]");
      const message = positionals[1] ?? (await Bun.stdin.text());
      const data = commands.log(ctx, positionals[0], message, values.author as string | undefined);
      return { data, text: `logged ${data.id}` };
    }
    case "artifact": {
      expectPositionals(positionals, 2, 2, "artifact <id> <file> [--name <name>] [--force]");
      const [id, file] = positionals;
      const source = file === "-" ? { data: await Bun.stdin.bytes() } : { path: file };
      const data = commands.artifact(ctx, id, source, {
        name: values.name as string | undefined,
        force: values.force as boolean | undefined,
      });
      return { data, text: data.path };
    }
    default: {
      expectPositionals(positionals, 1, 1, "path <id>");
      const data = commands.path(ctx, positionals[0]);
      return { data, text: data.path };
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  try {
    const { data, text } = await dispatch(argv);
    console.log(json ? JSON.stringify(data, null, 2) : text);
    return 0;
  } catch (e) {
    const error = e instanceof ShuError ? e : new ShuError("internal", (e as Error)?.message ?? String(e));
    if (json) {
      const body = { error: { code: error.code, message: error.message, ...error.details } };
      console.log(JSON.stringify(body, null, 2));
    } else {
      console.error(`shu: ${error.message}`);
    }
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
