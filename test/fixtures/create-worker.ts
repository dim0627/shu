import { createTaskDir } from "../../src/store";

const home = process.env.SHU_HOME;
if (!home) throw new Error("SHU_HOME is required");

// Draw from only the first few words so that processes are very likely to collide on an ID
console.log(createTaskDir(home, new Date(2026, 9, 1), () => Math.random() * 0.03));
