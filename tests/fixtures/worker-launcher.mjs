import { once } from "node:events";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const cp = require("node:child_process");
const bun = process.env.TAU_TEST_BUN;
if (!bun) throw new Error("Explicit standalone Bun is required");
const file = fileURLToPath(import.meta.url);
const [role, scenario] = process.argv.slice(2);
const spawn = next => cp.spawn(bun, [file, next], {
  env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
});
if (role === "ipc-qa") {
  const sockets = new Set();
  process.stdin.on("end", () => { for (const socket of sockets) socket.destroy(); });
  createInterface({ input: process.stdin }).on("line", line => {
    const socket = createConnection(process.env.TAU_GATEWAY_PIPE);
    sockets.add(socket);
    let accepted = false;
    socket.on("error", error => { console.error(error.message); });
    socket.on("data", () => { accepted = true; socket.destroy(); });
    socket.once("close", () => {
      sockets.delete(socket);
      console.log(JSON.stringify({ pid: process.pid, accepted, nonceInherited: !!process.env.TAU_WORKER_NONCE }));
    });
    socket.once("connect", () => socket.write(JSON.stringify({
      type: "register", token: process.env.TAU_GATEWAY_TOKEN, nonce: process.env.TAU_WORKER_NONCE,
      pid: process.pid, snapshot: JSON.parse(line),
    }) + "\n"));
  });
} else if (role === "ipc-wrapper") {
  const engine = cp.spawn(bun, process.argv.slice(3), { env: process.env, stdio: "inherit" });
  engine.once("error", error => { throw error; });
  engine.once("exit", code => { process.exitCode = code ?? 1; });
} else if (role === "qa") {
  const keepAlive = setInterval(() => {}, 1000);
  process.stdin.resume();
  process.stdin.on("end", () => { clearInterval(keepAlive); });
} else if (role === "engine") {
  const qa = spawn("qa");
  const keepAlive = setInterval(() => {}, 1000);
  console.log(JSON.stringify({ engine: process.pid, qa: qa.pid }));
  process.stdin.resume();
  process.stdin.on("end", () => {
    if (process.env.QA_IGNORE_EOF === "1") return;
    qa.stdin.end();
    clearInterval(keepAlive);
  });
} else if (role === "launcher") {
  const engine = spawn("engine");
  process.stdin.pipe(engine.stdin);
  engine.stdout.pipe(process.stdout);
  engine.stderr.pipe(process.stderr);
  engine.once("exit", code => process.exit(code ?? 1));
} else if (role === "control") {
  let mutation = "";
  let identities;
  let launcherPid;
  const execute = cp.execFile;
  cp.execFile = (command, args, options, callback) => {
    if (!command.endsWith("powershell.exe")) return execute(command, args, options, callback);
    if (mutation === "error") {
      queueMicrotask(() => callback(new Error("CIM query unavailable"), "", ""));
      return;
    }
    if (mutation === "timeout") {
      return execute(command, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from("Start-Sleep -Seconds 20", "utf16le").toString("base64")], options, callback);
    }
    return execute(command, args, options, (error, stdout, stderr) => {
      if (error || !mutation) { callback(error, stdout, stderr); return; }
      if (mutation === "malformed") { callback(null, "{", ""); return; }
      const parsed = JSON.parse(stdout || "[]");
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const engine = rows.find(row => row.pid === identities.engine);
      const launcher = rows.find(row => row.pid === launcherPid);
      if (mutation === "generation" && engine) engine.created = (BigInt(engine.created) + 1n).toString();
      if (mutation === "launcher-generation" && launcher) launcher.created = (BigInt(launcher.created) + 1n).toString();
      if (mutation === "creation-order" && engine) engine.created = "1";
      if (mutation === "image" && engine) engine.image = command;
      callback(null, mutation === "missing" ? "[]" : JSON.stringify(rows), stderr);
    });
  };
  const { WorkerOwnership } = await import("../../extensions/worker-ownership.ts");
  const owners = new WorkerOwnership();
  const child = spawn(scenario === "direct" ? "engine" : "launcher");
  launcherPid = child.pid;
  const live = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    identities = await new Promise((resolve, reject) => {
      let buffer = "";
      child.once("error", reject);
      child.stdout.on("data", data => {
        buffer += data;
        if (buffer.includes("\n")) resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
      });
    });
    await owners.track(child, scenario === "direct" ? { mode: "direct" } :
      { mode: "windows-bootstrap", image: realpathSync(bun).replaceAll("/", "\\").toLowerCase() });
    let result;
    if (scenario === "direct" || scenario === "topology") {
      result = {
        qaBefore: await owners.admit(child, identities.qa),
        unrelated: await owners.admit(child, process.pid),
        launcher: await owners.admit(child, child.pid),
        original: await owners.admit(child, identities.engine),
        reconnect: await owners.admit(child, identities.engine),
        qaAfter: await owners.admit(child, identities.qa),
        invalid: await owners.admit(child, 1.5),
      };
    } else if (scenario === "force" || scenario === "orphan" || scenario === "deadline") {
      if (!await owners.admit(child, identities.engine)) throw new Error("Original engine was not admitted");
      if (scenario === "orphan") {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      const closing = owners.close(child, scenario === "deadline");
      result = { closingRejected: !await owners.admit(child, identities.engine) };
      await closing;
    } else {
      if ((scenario === "generation" || scenario === "launcher-generation") &&
          !await owners.admit(child, identities.engine)) throw new Error("Original engine was not admitted");
      mutation = scenario;
      const started = Date.now();
      try { result = { accepted: await owners.admit(child, identities.engine) }; }
      catch (error) { result = { accepted: false, error: error.message }; }
      result.elapsed = Date.now() - started;
      mutation = "";
    }
    await owners.close(child, true);
    console.log(JSON.stringify({ scenario, result,
      survivors: [child.pid, identities.engine, identities.qa].filter(live) }));
  } finally {
    if (live(child.pid)) {
      await new Promise((resolve, reject) => execute(process.env.SystemRoot + "/System32/taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 },
        error => error ? reject(error) : resolve()));
    }
  }
} else {
  throw new Error("Unknown launcher fixture role");
}
