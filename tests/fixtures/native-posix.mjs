import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [mode, behavior] = process.argv.slice(2);
const file = fileURLToPath(import.meta.url);
if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Native POSIX required");
if (mode === "qa") {
  process.stdin.resume();
} else if (mode === "engine") {
  const instance = randomUUID();
  const qa = spawn(process.execPath, [file, "qa"], { env: process.env, stdio: ["pipe", "ignore", "ignore"] });
  appendFileSync(process.env.TAU_NATIVE_PIDS, JSON.stringify({ engine: process.pid, qa: qa.pid }) + "\n");
  const keepAlive = setInterval(() => {}, 1000);
  console.error(JSON.stringify({ engine: process.pid, qa: qa.pid, node: process.version }));
  createInterface({ input: process.stdin }).on("line", line => {
    const command = JSON.parse(line);
    if (behavior === "silent" && command.type === "extension_request") return;
    console.log(JSON.stringify({ type: "response", command: command.type, id: command.id, success: true,
      data: command.type === "extension_request" ? { version: 1, pid: process.pid, instance } : { pid: process.pid } }));
  });
  process.stdin.on("end", () => {
    if (behavior === "stubborn" || behavior === "silent") return;
    clearInterval(keepAlive);
    qa.stdin.end();
  });
} else {
  const args = [process.execPath, file, "engine", behavior];
  if (mode === "exec") {
    process.execve(process.execPath, args, process.env);
    throw new Error("Successful execve returned");
  }
  if (mode === "failed-syscall") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 26 || (major === 26 && minor < 1))
      throw new Error("Real failed execve requires Node >= 26.1; older Node can abort");
    try {
      process.execve("/tau-missing-execve-" + randomUUID(), [], process.env);
      throw new Error("Missing execve path unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
      console.error(JSON.stringify({ event: "actual-execve-ENOENT", node: process.version }));
    }
  } else if (mode !== "missing") throw new Error("Unknown native launcher mode");
  // Missing deliberately selects the unavailable-operation branch. No syscall is claimed.
  const engine = spawn(process.execPath, args.slice(1), { env: process.env, stdio: "inherit" });
  engine.once("error", error => { throw error; });
  engine.once("exit", code => { process.exitCode = code ?? 1; });
}
