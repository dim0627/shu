import * as commands from "../../src/commands";
import { logMessage } from "../helpers";

// Loops in one process so that reads and writes really overlap, with no process startup in between
const home = process.env.SHU_HOME;
if (!home) throw new Error("SHU_HOME is required");
const [mode, id, count, label = ""] = process.argv.slice(2);
const ctx = { home, now: () => new Date(), random: Math.random };
const body = "a long body ☕\n".repeat(20000);

for (let i = 0; i < Number(count); i++) {
  if (mode === "save") commands.save(ctx, JSON.stringify({ id, title: `t${i}`, body }));
  else if (mode === "show") commands.show(ctx, id);
  else if (mode === "list") commands.list(ctx);
  else if (mode === "log") commands.log(ctx, id, logMessage(label, i), label);
  else throw new Error(`unknown mode: ${mode}`);
}
