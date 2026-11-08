import { fileURLToPath } from "node:url";

// Windows supplies only POSIX launch/OS facts. Production NativeInput, IPC,
// admission, sessions, HTTP and WebSocket code all execute unchanged.
const cp = require("node:child_process");
const execute = cp.execFile;
const spawn = cp.spawn;
export const posix = { stage: "", mode: "", child: null, release: null, requests: 0, queries: 0 };
if (process.env.QA_POSIX_TOPOLOGY) {
  cp.spawn = (executable, args, options) => {
    if (!process.env.TAU_WORKER_NONCE && options?.env?.TAU_WORKER_NONCE && process.env.QA_POSIX_TOPOLOGY === "wrapper") {
      return spawn(executable, [fileURLToPath(new URL("./worker-launcher.mjs", import.meta.url)),
        "ipc-wrapper", ...args], options);
    }
    return spawn(executable, args, options);
  };
  cp.execFile = (command, args, options, callback) => {
    if (command !== "/bin/ps") return execute(command, args, options, callback);
    posix.queries++;
    const pids = args[1].split(",").map(Number);
    const original = pids[0];
    const finish = () => {
      const mode = posix.mode;
      posix.stage = "";
      posix.mode = "";
      if (mode === "timeout") {
        execute(process.env.TAU_TEST_BUN, ["-e", "setTimeout(()=>{},20000)"], options, callback);
        return;
      }
      if (mode === "error") {
        callback(new Error("POSIX ps " + mode), "", "");
        return;
      }
      let output = pids.map(pid => `${pid} ${pid === original ? process.pid : original} ${original}\n`).join("");
      if (mode === "missing") output = "";
      if (mode === "malformed") output = "malformed\n";
      if (mode === "duplicate") output += output;
      if (mode === "group") output = pids.map(pid => `${pid} ${original} ${original + 1}\n`).join("");
      if (mode === "parent") output = pids.map(pid => `${pid} ${original + 1} ${original}\n`).join("");
      callback(null, output, "");
    };
    if (posix.stage === "ps") {
      posix.release = finish;
      console.log("QA_ADMISSION_WAIT " + original);
    } else queueMicrotask(finish);
  };
  const { WorkerOwnership } = await import("../../extensions/worker-ownership.ts");
  const track = WorkerOwnership.prototype.track;
  WorkerOwnership.prototype.track = function (child, policy, input) {
    posix.child = child;
    const send = input.send.bind(input);
    input.send = command => {
      if (command.type === "extension_request") posix.requests++;
      return send(command);
    };
    let buffer = "";
    child.stderr.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.startsWith("QA_IDENTITY_WAIT")) console.log("QA_ADMISSION_WAIT " + child.pid);
        if (line.startsWith("QA_POSIX_")) console.log(line);
      }
    });
    return track.call(this, child, { mode: "posix-compiled" }, input);
  };
}

export function armPosix(stage, mode) {
  posix.stage = stage;
  posix.mode = mode;
  if (stage === "identity") {
    posix.child.stdin.write(JSON.stringify({ type: "qa_identity_mode", mode: "hold", response: mode }) + "\n");
  }
}

export function releasePosix() {
  if (posix.stage === "identity") {
    if (posix.child.stdin.writable) posix.child.stdin.write(JSON.stringify({ type: "qa_identity_release" }) + "\n");
    posix.stage = "";
    posix.mode = "";
  } else {
    posix.release();
    posix.release = null;
  }
}
