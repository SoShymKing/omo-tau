import { once } from "node:events";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";

const cp = createRequire(import.meta.url)("node:child_process");
const bun = process.env.TAU_TEST_BUN;
if (!bun) throw new Error("Explicit standalone Bun is required");
const runtime = process.env.QA_INERT_NODE === "1" ? process.env.TAU_TEST_NODE : bun;
const file = fileURLToPath(import.meta.url);
const [role, scenario] = process.argv.slice(2);
const spawn = next => cp.spawn(runtime, [file, next], {
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
      pid: process.env.QA_CLAIM_PID ? Number(process.env.QA_CLAIM_PID) : process.pid, snapshot: JSON.parse(line),
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
  let instance = randomUUID();
  const keepAlive = setInterval(() => {}, 1000);
  console.log(JSON.stringify({ engine: process.pid, qa: qa.pid }));
  createInterface({ input: process.stdin }).on("line", line => {
    const command = JSON.parse(line);
    if (process.env.QA_SILENT === "1") return;
    if (command.type === "qa_identity_instance") instance = command.instance;
    console.log(JSON.stringify({ type: "response", command: command.type, id: command.id, success: true,
      data: command.type === "extension_request" ? { version: 1, pid: process.pid, instance } : { pid: process.pid } }));
  });
  process.stdin.on("end", () => {
    if (process.env.QA_IGNORE_EOF === "1") return;
    qa.stdin.end();
    clearInterval(keepAlive);
  });
} else if (role === "launcher") {
  const engine = process.env.QA_INERT_NODE === "1" ? cp.spawn(runtime, [file, "engine"], {
    env: process.env, windowsHide: true, detached: true, stdio: ["pipe", "pipe", "pipe"],
  }) : spawn("engine");
  process.stdin.pipe(engine.stdin);
  engine.stdout.pipe(process.stdout);
  engine.stderr.pipe(process.stderr);
  engine.once("exit", code => process.exit(code ?? 1));
} else if (role === "inherited-launcher") {
  const engine = cp.spawn(runtime, [file, "engine"], { env: process.env, stdio: "inherit", windowsHide: true, detached: true });
  engine.once("error", error => { throw error; });
  engine.once("exit", code => { process.exitCode = code ?? 1; });
} else if (role === "posix-control") {
  const platform = process.platform;
  const execute = cp.execFile;
  const kill = process.kill.bind(process);
  const signals = [];
  let identities, child, receipt;
  let mutation = "";
  cp.execFile = (command, args, options, callback) => {
    if (command !== "/bin/ps") return execute(command, args, options, callback);
    const pids = args[1].split(",").map(Number);
    if (args.join(" ") !== `-p ${[...new Set(pids)].join(",")} -o pid= -o ppid= -o pgid=` ||
        options.timeout !== 2000 || options.maxBuffer !== 16384 || options.env.LC_ALL !== "C")
      throw new Error("Unexpected POSIX query boundary");
    const group = mutation === "group" ? child.pid + 1 : child.pid;
    queueMicrotask(() => callback(null, pids.map(pid =>
      `${pid} ${pid === child.pid ? process.pid : child.pid} ${group}\n`).join(""), ""));
  };
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  process.kill = (pid, signal) => {
    if (pid >= 0) return kill(pid, signal);
    if (pid !== -child.pid || signal !== "SIGKILL") throw new Error("Unexpected simulated group signal");
    signals.push({ pid, signal });
    if (scenario === "native-close-timeout") return true;
    execute(process.env.SystemRoot + "/System32/taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
      { env: process.env, windowsHide: true, timeout: 5000, maxBuffer: 32768 },
      error => { if (error) child.emit("error", error); });
    return true;
  };
  syncBuiltinESMExports();
  const { WorkerOwnership } = await import("../../extensions/worker-ownership.ts");
  const { NativeInput } = await import("../../extensions/native-input.ts");
  const live = pid => { try { kill(pid, 0); return true; } catch { return false; } };
  try {
    child = spawn("inherited-launcher");
    let text = "";
    const started = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", chunk => {
        text += chunk;
        if (text.includes("\n")) resolve(JSON.parse(text.slice(0, text.indexOf("\n"))));
      });
    });
    const input = new NativeInput(child);
    const ownership = new WorkerOwnership();
    await ownership.track(child, { mode: "compiled", image: "simulation" }, input);
    identities = await started;
    const admit = () => ownership.admit(child, identities.engine, { current: () => true, commit: () => {} });
    if (scenario === "owner-death") {
      const exited = once(child, "exit");
      await new Promise((resolve, reject) => execute(process.env.SystemRoot + "/System32/WindowsPowerShell/v1.0/powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand",
          Buffer.from(`Stop-Process -Id ${child.pid} -Force`, "utf16le").toString("base64")],
        { env: process.env, windowsHide: true, timeout: 5000, maxBuffer: 32768 },
        error => error ? reject(error) : resolve()));
      await exited;
      let refused = false;
      try { await ownership.close(child, false); }
      catch (error) { refused = /cleanup identity unavailable/.test(error.message); }
      receipt = { scenario, simulation: true, platform, refused, signals,
        inheritedPipesOpen: !ownership.owners.get(child).nativeClosed, engineAlive: live(identities.engine) };
    } else {
      let pending;
      if (scenario === "silent") {
        const send = input.send.bind(input);
        let identityStarted;
        const started = new Promise(resolve => { identityStarted = resolve; });
        input.send = command => { identityStarted(); return send(command); };
        pending = admit().then(accepted => ({ accepted }), error => ({ error: error.message }));
        await started;
      }
      else if (scenario === "graceful" || scenario === "stubborn") {
        if (!await admit()) throw new Error("Simulated POSIX owner not admitted");
      }
      if (scenario === "group") mutation = "group";
      const began = Date.now();
      let error;
      try { await ownership.close(child, false); }
      catch (caught) { error = caught.message; }
      receipt = { scenario, simulation: true, platform, error, signals,
        elapsed: Date.now() - began, nativeClosed: ownership.owners.get(child).nativeClosed,
        pending: pending ? await pending : undefined,
        survivors: [child.pid, identities.engine, identities.qa].filter(live) };
    }
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    process.kill = kill;
    for (const pid of new Set([child?.pid, identities?.engine, identities?.qa].filter(Boolean))) {
      if (!live(pid)) continue;
      await new Promise((resolve, reject) => execute(process.env.SystemRoot + "/System32/taskkill.exe",
        ["/PID", String(pid), "/T", "/F"], { env: process.env, windowsHide: true, timeout: 5000, maxBuffer: 32768 },
        error => error ? reject(error) : resolve()));
    }
  }
  console.log(JSON.stringify({ ...receipt,
    cleanupSurvivors: [child.pid, identities.engine, identities.qa].filter(live) }));
} else if (role === "control") {
  let mutation = "";
  let identities;
  let launcherPid;
  let pendingQuery;
  let queryEntered;
  let signals = 0;
  const execute = cp.execFile;
  cp.execFile = (command, args, options, callback) => {
    if (command.endsWith("taskkill.exe")) signals++;
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
      if (mutation === "hold") {
        pendingQuery = () => callback(error, stdout, stderr);
        queryEntered();
        return;
      }
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
      if (mutation === "launcher-image" && launcher) launcher.image = command;
      if (mutation === "parent-negative" && engine) engine.parent = -1;
      if (mutation === "parent-overflow" && engine) engine.parent = 0x100000000;
      if (mutation === "created-number" && engine) engine.created = Number(engine.created);
      if (mutation === "missing-image" && engine) delete engine.image;
      if (mutation === "unexpected" && engine) engine.pid = process.pid;
      if (mutation === "duplicate") rows.push({ ...rows[0] });
      callback(null, mutation === "missing" ? "[]" : JSON.stringify(rows), stderr);
    });
  };
  syncBuiltinESMExports();
  const { WorkerOwnership } = await import("../../extensions/worker-ownership.ts");
  const { NativeInput } = await import("../../extensions/native-input.ts");
  const owners = new WorkerOwnership();
  const child = spawn(["direct", "compiled-direct", "pin-race", "commit-conflict", "synchronous-eof"].includes(scenario) ? "engine" : "launcher");
  launcherPid = child.pid;
  const input = new NativeInput(child);
  const admit = pid => owners.admit(child, pid, { current: () => true, commit: () => {} });
  let refusedCleanup = false;
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
    if (scenario === "capture-error") mutation = "error";
    let captureError;
    try {
      await owners.track(child, scenario === "direct" ? { mode: "direct" } :
        { mode: "compiled", image: realpathSync(runtime).replaceAll("/", "\\").toLowerCase() }, input);
    } catch (error) {
      if (scenario !== "capture-error") throw error;
      captureError = error.message;
    }
    mutation = "";
    let result;
    if (scenario === "terminate-generation" || scenario === "terminate-image" || scenario === "terminate-owner" || scenario === "capture-error") {
      if (scenario !== "capture-error" && !await admit(identities.engine)) throw new Error("Engine was not admitted");
      mutation = scenario === "terminate-generation" ? "launcher-generation" :
        scenario === "terminate-image" ? "launcher-image" : "";
      let error;
      try {
        if (scenario === "terminate-owner") {
          const { terminateWorkerProcesses } = await import("../../extensions/worker-process.ts");
          const owner = owners.owners.get(child);
          await terminateWorkerProcesses(child, { original: owner.original, engine: owner.engine, nativeClosed: false }, () => false);
        } else await owners.close(child, false);
      } catch (caught) { error = caught.message; }
      result = { error, captureError, signals };
      refusedCleanup = true;
      mutation = "";
      // Driver fallback only after proving product refused an identity it could not authorize.
      const closed = once(child, "close");
      await new Promise((resolve, reject) => execute(process.env.SystemRoot + "/System32/taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"], { env: process.env, windowsHide: true, timeout: 5000, maxBuffer: 32768 },
        error => error ? reject(error) : resolve()));
      await closed;
    } else if (scenario === "direct" || scenario === "compiled-direct" || scenario === "topology") {
      result = {
        qaBefore: await admit(identities.qa),
        unrelated: await admit(process.pid),
        launcher: await admit(child.pid),
        original: await admit(identities.engine),
        reconnect: await admit(identities.engine),
        qaAfter: await admit(identities.qa),
        invalid: await admit(1.5),
      };
    } else if (scenario === "commit-conflict") {
      let rejected = false;
      try {
        await owners.admit(child, identities.engine, { current: () => true, commit: () => { throw new Error("Duplicate live session"); } });
      } catch (error) { rejected = error.message === "Duplicate live session"; }
      const owner = owners.owners.get(child);
      const restoredEmpty = owner.pin === null && owner.engine === null && owner.admitted === null && !owners.matches(child, identities.engine);
      const accepted = await admit(identities.engine);
      const previous = { pin: owner.pin, engine: owner.engine, admitted: owner.admitted };
      try {
        await owners.admit(child, identities.engine, { current: () => true, commit: () => { throw new Error("Duplicate live session"); } });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Duplicate live session") throw error;
      }
      result = { rejected, restoredEmpty, accepted, restoredPrevious: owner.pin === previous.pin &&
        owner.engine === previous.engine && owner.admitted === previous.admitted };
    } else if (scenario === "pin-race") {
      mutation = "hold";
      const entered = new Promise(resolve => { queryEntered = resolve; });
      const first = admit(identities.engine);
      await entered;
      const instance = randomUUID();
      await input.send({ type: "qa_identity_instance", instance });
      mutation = "";
      const second = await admit(identities.engine);
      pendingQuery();
      result = { first: await first, second, retained: owners.owners.get(child).pin.instance === instance };
    } else if (scenario === "synchronous-eof") {
      await admit(identities.engine);
      const end = child.stdin.end.bind(child.stdin);
      let registration;
      child.stdin.end = (...args) => { registration = admit(identities.engine); return end(...args); };
      const closing = owners.close(child, true);
      const coalesced = closing === owners.close(child, true);
      await closing;
      result = { coalesced, closingRejected: !await registration };
    } else if (scenario === "force" || scenario === "orphan" || scenario === "orphan-closed" || scenario === "deadline") {
      if (!await admit(identities.engine)) throw new Error("Original engine was not admitted");
      if (scenario === "orphan" || scenario === "orphan-closed") {
        const exited = once(child, "exit");
        const closed = once(child, "close");
        if (scenario === "orphan-closed") {
          await new Promise((resolve, reject) => execute(process.env.SystemRoot + "/System32/WindowsPowerShell/v1.0/powershell.exe",
            ["-NoProfile", "-NonInteractive", "-EncodedCommand",
              Buffer.from(`Stop-Process -Id ${child.pid} -Force`, "utf16le").toString("base64")],
            { env: process.env, windowsHide: true, timeout: 5000, maxBuffer: 32768 },
            error => error ? reject(error) : resolve()));
        } else child.kill();
        await exited;
        if (scenario === "orphan-closed") await closed;
      }
      const closing = owners.close(child, scenario === "deadline");
      result = { closingRejected: !await admit(identities.engine) };
      if (scenario === "orphan-closed") result.survivorAfterClose =
        owners.owners.get(child).nativeClosed && live(identities.engine);
      await closing;
    } else {
      if ((scenario === "generation" || scenario === "launcher-generation") &&
          !await admit(identities.engine)) throw new Error("Original engine was not admitted");
      mutation = scenario;
      const started = Date.now();
      try { result = { accepted: await admit(identities.engine) }; }
      catch (error) { result = { accepted: false, error: error.message }; }
      result.elapsed = Date.now() - started;
      mutation = "";
    }
    if (!refusedCleanup) await owners.close(child, true);
    console.log(JSON.stringify({ scenario, result, original: child.pid, ...identities, signals,
      originalFacts: owners.owners.get(child).original, engineFacts: owners.owners.get(child).engine,
      pin: owners.owners.get(child).pin,
      survivors: [child.pid, identities.engine, identities.qa].filter(live) }));
  } finally {
    for (const pid of new Set([child.pid, identities?.engine, identities?.qa].filter(Boolean))) {
      if (!live(pid)) continue;
      await new Promise((resolve, reject) => execute(process.env.SystemRoot + "/System32/taskkill.exe",
        ["/PID", String(pid), "/T", "/F"], { env: process.env, windowsHide: true, timeout: 5000 },
        error => error ? reject(error) : resolve()));
    }
  }
} else {
  throw new Error("Unknown launcher fixture role");
}
