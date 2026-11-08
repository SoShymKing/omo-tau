import { createServer } from "node:net";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { workerLaunchPolicy } from "../../extensions/worker-ownership.ts";

// Isolated actual-host QA only: the production extension has no test flags.
export default function probe(pi) {
  const runtime = globalThis.__tauMirrorRuntime;
  const evidence = process.env.TAU_TEST_EVIDENCE;
  const worker = !!process.env.TAU_WORKER_NONCE;
  const log = value => appendFileSync(evidence, JSON.stringify({ run: process.env.TAU_TEST_RUN, pid: process.pid, worker, ...value }) + "\n");
  const qa = [];
  const remembered = new Set();
  log({ event: "engine", argv: process.argv.slice(1) });
  if (worker && process.env.TAU_TEST_FAIL_START === "1") {
    process.env.TAU_WORKER_NONCE = "deliberately-rejected-start";
    pi.on("session_shutdown", () => new Promise(() => {}));
  }
  pi.on("session_start", async () => {
    log({ event: "session-start", snapshot: runtime.local?.snapshot() });
  });
  if (!worker) {
    const setChild = runtime.children.set.bind(runtime.children);
    runtime.children.set = (nonce, child) => {
      log({ event: "launch", launcher: child.pid, argv: child.spawnargs,
        policy: workerLaunchPolicy(child.spawnfile, child.spawnargs.slice(1), process.env) });
      return setChild(nonce, child);
    };
    const track = runtime.ownership.track.bind(runtime.ownership);
    runtime.ownership.track = (child, policy, input) => {
      const send = input.send.bind(input);
      input.send = command => {
        if (command.type !== "extension_request" || command.name !== "tau.workerIdentity.v1") return send(command);
        log({ event: "admission-identity-request", launcher: child.pid, policy });
        return send(command).then(response => {
          log({ event: "admission-identity-response", launcher: child.pid, response });
          return response;
        });
      };
      return track(child, policy, input);
    };
    const admit = runtime.ownership.admit.bind(runtime.ownership);
    runtime.ownership.admit = (child, pid, admission) => admit(child, pid, {
      current: admission.current,
      commit: () => {
        admission.commit();
        const owner = runtime.ownership.owners.get(child);
        log({ event: "admission-commit", launcher: child.pid, claim: pid, pin: owner.pin,
          original: owner.original, engine: owner.engine });
      },
    });
  }
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const command = JSON.parse(buffer.slice(0, end));
      if (command.type === "inspect") {
        for (const session of runtime.sessions.values()) remembered.add(session);
        socket.end(JSON.stringify({
          pid: process.pid,
          workerInstance: runtime.workerInstance,
          children: [...runtime.children].map(([nonce, child]) => ({
            nonce, pid: child.pid, argv: child.spawnargs, writable: child.stdin?.writable,
          })),
          sessions: [...runtime.sessions.values()].map(session => ({
            sessionId: session.sessionId, sessionFile: session.sessionFile, pid: session.pid,
            epoch: session.snapshot.epoch, child: session.child?.pid, connected: session.connected,
          })),
          retired: [...remembered].filter(session => ![...runtime.sessions.values()].includes(session)).map(session => ({
            sessionId: session.sessionId, child: session.child?.pid ?? null,
            idleTimer: session.idleTimer !== null, connected: session.connected,
          })),
          discovery: runtime.discovery,
          pins: [...runtime.children.values()].map(child => ({
            launcher: child.pid, pin: runtime.ownership.owners.get(child)?.pin,
          })),
        }) + "\n");
      } else if (command.type === "fail-start") {
        process.env.TAU_TEST_FAIL_START = "1";
        socket.end("{}\n");
      } else if (command.type === "disconnect") {
        runtime.peer.destroy();
        socket.end("{}\n");
      } else if (command.type === "qa-child") {
        const child = spawn(process.env.TAU_TEST_BUN, ["-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],
        { env: process.env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
        qa.push(child);
        socket.end(JSON.stringify({ pid: child.pid }) + "\n");
      } else if (command.type === "native") {
        const session = [...runtime.sessions.values()].find(item => item.sessionId === command.sessionId);
        session.child.stdin.write(JSON.stringify(command.command) + "\n");
        socket.end("{}\n");
      } else {
        socket.destroy(new Error("Unknown probe command"));
      }
    });
    socket.on("error", error => log({ event: "probe-error", error: error.message }));
  });
  server.listen(process.env.TAU_TEST_CONTROL + (worker ? "-" + process.pid : ""));
  pi.on("session_shutdown", async event => {
    for (const child of qa) child.stdin.end();
    await new Promise(resolve => server.close(resolve));
  });
}
