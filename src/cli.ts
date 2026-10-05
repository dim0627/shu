#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import pkg from "../package.json";
import * as commands from "./commands";
import { ShuError } from "./errors";
import { formatKinds, formatList, formatShow, formatTask } from "./format";

const HELP = `shu — a local task store for humans and AI agents

Usage:
  shu list [--status <s>]... [--kind <k>]... [--all]
      List tasks, most recently updated first (open / waiting by default;
      --status todo for what is not started)
  shu show <id>
      Show a task: metadata, body, log entries, and artifact file names
  shu save [--remove-ref <ref>]...
      Create or update a task from JSON on standard input
        {"id": "...", "title": "...", "kind": "...", "status": "...", "refs": ["..."], "body": "..."}
      With id, that task is updated: only the given fields change, and refs are
      added to the existing ones.
      Without id, a task that already owns one of refs is matched: its refs are
      merged and nothing else changes. "skipped" lists the fields that were not
      applied; save again with the id to apply them.
      Otherwise a new task is created (title and kind required; status defaults
      to open, so pass todo for work that is not started)
  shu status <status> <id>...
      Set the status of one or more tasks (shu status done aoi-kitsune akai-tsuru).
      Nothing is changed if any <id> does not name a task
  shu find --ref <ref>
      Look up the task that owns a ref
  shu log <id> [message] [--author <name>]
      Append one log entry (reads the message from standard input if omitted).
      A message that starts with "-" must come after "--" or from standard input:
        shu log <id> -- "- a bullet"
  shu artifact <id> <file> [--name <name>] [--force]
      Copy a file into the task (<file> of - reads standard input; needs --name)
  shu path <id>
      Print the absolute path of the task directory
  shu kinds
      List the kinds in use, with the number of tasks of each

Common options:
  --json       Print only JSON to standard output (errors as {"error": {"code", "message"}})
               --help prints {"help"} and --version prints {"version"}
  --help, -h   Show this help
  --version    Show the version

<id>     The full ID (20261001-aoi-kitsune) or just its words (aoi-kitsune)
kind     Free-form. Reuse one that "shu kinds" lists before adding a new one. Suggested:
         review / pr-followup / bug-investigation / alert-investigation / fix-request / ticket
status   todo (not started) / open (in progress) / waiting (blocked on someone else) /
         done / dropped
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
  status: {},
  find: { ref: { type: "string" } },
  log: { author: { type: "string" } },
  artifact: { name: { type: "string" }, force: { type: "boolean" } },
  path: {},
  kinds: {},
};

const ALL_OPTIONS: Options = Object.assign({}, GLOBAL_OPTIONS, ...Object.values(COMMAND_OPTIONS));

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

// The command is the first positional, so an option value before it (--status done list) is not mistaken for it
function findCommandIndex(argv: string[]): number {
  try {
    const { tokens } = parseArgs({
      args: argv,
      options: ALL_OPTIONS,
      allowPositionals: true,
      strict: false,
      tokens: true,
    });
    return tokens.find((token) => token.kind === "positional")?.index ?? -1;
  } catch (e) {
    throw usage((e as Error).message);
  }
}

// --json after "--" is a positional (for example a log message), not the option
function wantsJson(argv: string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
}

function expectPositionals(positionals: string[], min: number, max: number, synopsis: string): void {
  if (positionals.length < min || positionals.length > max) throw usage(`usage: shu ${synopsis}`);
}

async function dispatch(argv: string[]): Promise<Output> {
  const commandIndex = findCommandIndex(argv);
  const command = commandIndex === -1 ? undefined : argv[commandIndex];
  const rest = argv.filter((_, index) => index !== commandIndex);

  if (command !== undefined && !Object.hasOwn(COMMAND_OPTIONS, command)) {
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
      const kinds = values.kind as string[] | undefined;
      const data = commands.list(ctx, {
        statuses: values.status as string[] | undefined,
        kinds,
        all: values.all as boolean | undefined,
      });
      // An empty default list must not read as an empty store while todo tasks are left out of it
      const unfiltered = values.status === undefined && !values.all;
      const todo =
        unfiltered && data.tasks.length === 0 ? commands.list(ctx, { statuses: ["todo"], kinds }).tasks.length : 0;
      const text =
        todo > 0 ? `No open or waiting tasks (${todo} todo: shu list --status todo)` : formatList(data.tasks);
      return { data, text };
    }
    case "show": {
      expectPositionals(positionals, 1, 1, "show <id>");
      const data = commands.show(ctx, positionals[0]);
      return { data, text: formatShow(data.task, data.log, data.artifacts) };
    }
    case "save": {
      expectPositionals(positionals, 0, 0, "save [--remove-ref <ref>]...  (JSON on standard input)");
      const data = commands.save(ctx, await Bun.stdin.text(), (values["remove-ref"] as string[]) ?? []);
      const skipped =
        data.skipped.length > 0 ? ` (not applied: ${data.skipped.join(", ")}; save with the id to apply)` : "";
      return { data, text: `${data.result} ${data.task.id}${skipped}` };
    }
    case "status": {
      expectPositionals(positionals, 2, Infinity, "status <status> <id>...");
      const [status, ...ids] = positionals;
      const data = commands.setStatus(ctx, status, ids);
      return { data, text: data.tasks.map((task) => `${task.status} ${task.id}`).join("\n") };
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
    case "path": {
      expectPositionals(positionals, 1, 1, "path <id>");
      const data = commands.path(ctx, positionals[0]);
      return { data, text: data.path };
    }
    case "kinds": {
      expectPositionals(positionals, 0, 0, "kinds");
      const data = commands.kinds(ctx);
      return { data, text: formatKinds(data.kinds) };
    }
    default:
      throw usage(`unknown command: ${command}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const json = wantsJson(argv);
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
