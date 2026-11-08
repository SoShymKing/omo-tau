// allow: SIZE_OK - One actual-host scenario keeps process ownership and private-home cleanup in the same try/finally.
import { spawn, execFile } from "node:child_process";
import { mkdirSync, symlinkSync, unlinkSync, rmSync, appendFileSync, readFileSync, readdirSync, watch } from "node:fs";
import { once } from "node:events";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketClient } from "../public/websocket-client.js";
import { NativeInput } from "../extensions/native-input.ts";

const [root, mode] = process.argv.slice(2);
const candidate = join(root, "candidate");
const evidence = join(root, "implementation");
const sandbox = join(evidence, "sandbox-" + mode);
const exe = process.env.TAU_TEST_OMO;
if (!exe) throw new Error("TAU_TEST_OMO must name the installed OmO executable");
const run = randomUUID();
const log = value => {
  appendFileSync(join(evidence, mode + ".jsonl"), JSON.stringify(value) + "\n");
  console.log("ACTUAL " + JSON.stringify(value));
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const env = {};
for (const wanted of ["SystemRoot", "WINDIR", "ComSpec", "PATH"]) {
  const key = Object.keys(process.env).find(key => key.toUpperCase() === wanted.toUpperCase());
  if (key) env[wanted] = process.env[key];
}
Object.assign(env, {
  HOME: sandbox + "/home", USERPROFILE: sandbox + "/home", APPDATA: sandbox + "/config",
  LOCALAPPDATA: sandbox + "/local", XDG_CONFIG_HOME: sandbox + "/config",
  XDG_CACHE_HOME: sandbox + "/cache", XDG_DATA_HOME: sandbox + "/data", XDG_STATE_HOME: sandbox + "/state",
  TEMP: sandbox + "/tmp", TMP: sandbox + "/tmp", TMPDIR: sandbox + "/tmp",
  BUN_INSTALL_CACHE_DIR: sandbox + "/cache/bun", NODE_COMPILE_CACHE: sandbox + "/cache/node",
  JITI_CACHE_DIR: sandbox + "/cache/jiti", OMO_CODING_AGENT_DIR: sandbox + "/agent",
  SENPI_CODING_AGENT_DIR: sandbox + "/agent", PI_CODING_AGENT_DIR: sandbox + "/agent",
  PI_CODING_AGENT_SESSION_DIR: sandbox + "/agent/sessions", TAU_DISABLED: "1", GIT_MASTER: "1",
  TAU_HOST: "127.0.0.1", TAU_MIRROR_PORT: "0", TAU_USER: "", TAU_PASS: "",
  TAU_PROJECTS_DIR: sandbox + "/workspace", TAU_STATIC_DIR: candidate + "/public",
  TAU_TEST_EVIDENCE: evidence + "/" + mode + "-engines.jsonl",
  TAU_TEST_CONTROL: "\\\\.\\pipe\\tau-test-" + randomUUID(),
  TAU_TEST_BUN: process.env.TAU_TEST_BUN, TAU_TEST_RUN: run,
});
for (const dir of ["home/.omo/binary-runtime", "home/.omo/tau-instances", "config", "local", "cache", "data", "state", "tmp", "agent/sessions", "workspace"])
  mkdirSync(join(sandbox, dir), { recursive: true });
const alias = join(sandbox, "home/.omo/binary-runtime/5.1.62");
symlinkSync(dirname(exe), alias, "junction");
const observed = new Set();
let gateway, client, port, watchdog;
let diagnostics = "";
function demand(name, pass) {
  log({ event: "assert", name, pass: !!pass });
  if (!pass) throw new Error(name);
}
function execute(command, args) {
  return new Promise((resolve, reject) => execFile(command, args,
    { env, windowsHide: true, timeout: 10000, maxBuffer: 32768 },
    (error, stdout, stderr) => error ? reject(new Error(`${error.message}: ${stderr}`)) : resolve(stdout)));
}
async function rows(pids) {
  const filter = [...new Set(pids)].filter(pid => Number.isSafeInteger(pid) && pid > 0).map(pid => `ProcessId = ${pid}`).join(" OR ");
  const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;image=$_.ExecutablePath;created=$_.CreationDate.ToUniversalTime().Ticks.ToString()} }) | ConvertTo-Json -Compress`;
  const text = await execute(env.SystemRoot + "/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  const value = JSON.parse(text || "[]");
  return Array.isArray(value) ? value : [value];
}
async function killTree(pid) {
  if (!alive(pid)) return;
  const output = await execute(env.SystemRoot + "/System32/taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
  log({ event: "driver-tree-cleanup", pid, output });
}
function control(command, pid) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(env.TAU_TEST_CONTROL + (pid ? "-" + pid : ""));
    let text = "";
    socket.setTimeout(10000, () => socket.destroy(new Error("Probe timeout")));
    socket.once("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", data => { text += data; });
    socket.once("end", () => resolve(JSON.parse(text)));
    socket.once("error", reject);
  });
}
function privateInstance() {
  const dir = sandbox + "/home/.omo/tau-instances";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { watcher.close(); reject(new Error("No private instance")); }, 20000);
    const scan = () => {
      for (const name of readdirSync(dir)) {
        if (!/^\d+\.json$/.test(name)) continue;
        let value;
        try { value = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
        if (value.port > 0) { clearTimeout(timeout); watcher.close(); resolve(value); return; }
      }
    };
    const watcher = watch(dir, scan);
    scan();
  });
}
async function collect() {
  const records = readFileSync(env.TAU_TEST_EVIDENCE, "utf8").trim().split("\n").map(JSON.parse).filter(record => record.run === run);
  for (const record of records) {
    if (record.event === "engine") observed.add(record.pid);
    if (record.event === "launch") observed.add(record.launcher);
  }
  const info = await control({ type: "inspect" });
  for (const child of info.children) observed.add(child.pid);
  log({ event: "ownership", ...info, discovery: undefined,
    children: info.children.map(({ nonce, ...child }) => child) });
  log({ event: "os", rows: await rows([...observed]) });
  return info;
}
function status(predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.removeEventListener("sessionStatus", receive); reject(new Error("Session status timeout")); }, 10000);
    const receive = event => {
      if (!predicate(event.detail)) return;
      clearTimeout(timer);
      client.removeEventListener("sessionStatus", receive);
      resolve(event.detail);
    };
    client.addEventListener("sessionStatus", receive);
  });
}
function register(info, pid, nonce) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(info.discovery.pipe);
    socket.setTimeout(10000, () => socket.destroy(new Error("Registration did not settle")));
    socket.once("error", reject);
    socket.once("close", () => resolve("closed"));
    socket.once("data", () => { socket.destroy(); resolve("accepted"); });
    socket.once("connect", () => socket.write(JSON.stringify({
      type: "register", token: info.discovery.token, nonce, pid,
      snapshot: { type: "mirror_sync", sessionFile: sandbox + "/foreign.jsonl", cwd: sandbox,
        epoch: "foreign", seq: 0, isStreaming: false, entries: [] },
    }) + "\n"));
  });
}
try {
  log({ event: "driver", pid: process.pid, mode, bun: Bun.version, exe,
    installedManifest: JSON.parse(readFileSync(join(dirname(exe), "package.json"), "utf8")).version,
    expected: "HTTP 201; WS worker selection; native get_state; QA rejection; reconnect; replacement; failed-start cleanup",
    forbiddenEnvironment: Object.keys(env).filter(key => /TRUST|TOKEN|API_KEY|SUBAGENT|TAU_GATEWAY/.test(key)) });
  const ready = privateInstance();
  gateway = spawn(exe, ["--mode", "rpc", "--no-extensions", "--no-skills",
    "--provider", "anthropic", "--model", "claude-sonnet-4-5", "--thinking", "off",
    "--session-dir", sandbox + "/agent/sessions", "--session", sandbox + "/agent/sessions/gateway.jsonl",
    "-e", candidate + "/extensions/mirror-server.ts", "-e", candidate + "/tests/fixtures/actual-host-probe.mjs"],
    { cwd: sandbox + "/workspace", env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  observed.add(gateway.pid);
  const native = new NativeInput(gateway);
  gateway.stdout.on("data", chunk => log({ event: "stdout", text: String(chunk).slice(-3000) }));
  gateway.stderr.on("data", chunk => {
    diagnostics += String(chunk);
    log({ event: "stderr", text: String(chunk).slice(-3000) });
  });
  watchdog = setTimeout(() => {
    void killTree(gateway.pid).finally(() => process.exit(94));
  }, 100000);
  const commands = await native.send({ type: "get_commands" });
  demand("taustart is a registered extension command", commands.success === true &&
    commands.data.commands.some(command => command.name === "taustart"));
  log({ event: "recognized-command", command: "/taustart" });
  const activated = await native.send({ type: "prompt", message: "/taustart" });
  demand("recognized taustart command activates private gateway", activated.success === true);
  const instance = await ready;
  port = instance.port;
  observed.add(instance.pid);
  const base = "http://127.0.0.1:" + port;
  log({ event: "gateway", launcher: gateway.pid, engine: instance.pid, port });
  const started = Date.now();
  const response = await fetch(base + "/api/sessions/new", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directory: sandbox + "/workspace", createDirectory: false }),
    signal: AbortSignal.timeout(45000) });
  const body = await response.json();
  log({ event: "create", status: response.status, elapsed: Date.now() - started, body });
  const info = await collect();
  if (mode === "red") {
    demand("original startup rejects actual engine ownership", response.status === 500 && /Invalid worker ownership/.test(diagnostics));
  } else {
    demand("actual startup returns 201 within existing deadline", response.status === 201 && Date.now() - started < 30000);
    const instances = await fetch(base + "/api/instances").then(reply => reply.json());
    const worker = instances.sessions.find(session => session.sessionId === body.sessionId);
    demand("returned worker is ready", worker?.status === "ready" && worker.kind === "worker");
    const bound = info.sessions.find(session => session.sessionId === body.sessionId);
    demand("native launcher differs from engine", bound.child !== bound.pid);
    const identity = await control({ type: "identity", sessionId: body.sessionId });
    log({ event: "native-identity", response: identity });
    demand("public native identity matches actual worker PID", identity.success === true &&
      identity.command === "extension_request" && identity.data.version === 1 && identity.data.pid === bound.pid &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.data.instance));
    client = new WebSocketClient(base.replace("http", "ws") + "/ws");
    const state = once(client, "stateUpdate", { signal: AbortSignal.timeout(10000) });
    client.connect();
    await state;
    const snapshot = await client.selectSession(body.sessionFile);
    demand("real WS selection acknowledged worker", snapshot.sessionId === body.sessionId);
    const id = randomUUID();
    const rpc = await fetch(base + "/api/rpc", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "get_state", id, sessionId: body.sessionId }) }).then(reply => reply.json());
    log({ event: "native-get-state", rpc });
    demand("worker-specific native get_state succeeds", rpc.success === true && rpc.id === id && rpc.sessionId === body.sessionId);
    demand("native response identifies worker conversation", rpc.data.sessionFile === body.sessionFile &&
      rpc.data.messageCount === 0 && rpc.data.usageTotals.input === 0 && rpc.data.usageTotals.output === 0);
    const qa = await control({ type: "qa-child" }, bound.pid);
    observed.add(qa.pid);
    const owner = info.children.find(child => child.pid === bound.child);
    for (const [name, pid, nonce] of [
      ["QA descendant", qa.pid, owner.nonce],
      ["unrelated live driver", process.pid, owner.nonce],
      ["unknown nonce", bound.pid, "unknown-worker"],
    ]) {
      demand(name + " registration closes", await register(info, pid, nonce) === "closed");
      const current = await control({ type: "inspect" });
      demand(name + " leaves owner unchanged and writable",
        current.sessions.some(session => session.sessionId === body.sessionId && session.epoch === snapshot.epoch &&
          session.child === bound.child && session.pid === bound.pid) &&
        current.children.find(child => child.pid === bound.child)?.writable === true &&
        !current.sessions.some(session => session.sessionFile.endsWith("foreign.jsonl")));
      const responseId = randomUUID();
      const state = await fetch(base + "/api/rpc", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "get_state", id: responseId, sessionId: body.sessionId }) }).then(reply => reply.json());
      demand(name + " leaves native routing usable", state.success === true && state.id === responseId &&
        state.data.sessionFile === body.sessionFile);
    }
    const reconnected = status(value => value.sessionId === body.sessionId && value.status === "ready");
    await control({ type: "disconnect" }, bound.pid);
    demand("same engine reconnect keeps session identity", (await reconnected).pid === bound.pid);
    demand("selection survives reconnect", (await client.selectSession(body.sessionFile)).epoch === snapshot.epoch);
    const replacement = status(value => value.pid === bound.pid && value.status === "ready" &&
      value.sessionFile !== body.sessionFile);
    await control({ type: "native", sessionId: body.sessionId, command: { type: "new_session", id: randomUUID() } });
    const replaced = await replacement;
    demand("conversation replacement selects same engine", (await client.selectSession(replaced.sessionFile)).sessionId === replaced.sessionId);
    const afterReplace = await control({ type: "inspect" });
    demand("replacement preserves native launcher", afterReplace.sessions.some(session =>
      session.sessionId === replaced.sessionId && session.child === bound.child && session.pid === bound.pid));
    const replacementIdentity = await control({ type: "identity", sessionId: replaced.sessionId });
    demand("native lifetime UUID survives real new_session extension replacement",
      replacementIdentity.success === true && replacementIdentity.data.pid === identity.data.pid &&
      replacementIdentity.data.instance === identity.data.instance);
    demand("retired conversation releases child and timer", afterReplace.retired.some(session =>
      session.sessionId === body.sessionId && session.child === null && !session.idleTimer && !session.connected));
    const replacedState = await fetch(base + "/api/rpc", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "get_state", sessionId: replaced.sessionId, id: randomUUID() }) }).then(reply => reply.json());
    demand("replacement routes native get_state", replacedState.success === true &&
      replacedState.data.sessionFile === replaced.sessionFile && replacedState.data.messageCount === 0);
    await collect();
    const existing = new Set(observed);
    await control({ type: "fail-start" });
    const failureStarted = Date.now();
    const failed = await fetch(base + "/api/sessions/new", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: sandbox + "/workspace", createDirectory: false }),
      signal: AbortSignal.timeout(45000) });
    const failureBody = await failed.json();
    log({ event: "failed-start", status: failed.status, elapsed: Date.now() - failureStarted, body: failureBody });
    await collect();
    const failedPids = [...observed].filter(pid => !existing.has(pid));
    demand("failed startup returns bounded error", failed.status === 500 && Date.now() - failureStarted < 45000);
    demand("failed startup closes launcher and unadmitted engine", failedPids.length === 2 && failedPids.every(pid => !alive(pid)));
    log({ event: "failed-start-cleanup", pids: failedPids, survivors: failedPids.filter(alive) });
  }
} catch (error) {
  log({ event: "failure", message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  client?.disconnect();
  if (gateway && alive(gateway.pid)) {
    try { await collect(); } catch (error) { log({ event: "collect-error", message: error.message }); }
    const exit = once(gateway, "exit", { signal: AbortSignal.timeout(15000) });
    gateway.stdin.end();
    try { log({ event: "gateway-eof", exit: await exit }); }
    catch (error) { log({ event: "eof-error", message: error.message }); await killTree(gateway.pid); }
  }
  const productSurvivors = [...observed].filter(alive);
  log({ event: "product-cleanup", survivors: productSurvivors });
  if (mode !== "red" && productSurvivors.length) process.exitCode = 1;
  for (const pid of observed) if (alive(pid)) await killTree(pid);
  clearTimeout(watchdog);
  const survivors = [...observed].filter(alive);
  let listener = false;
  if (port) {
    try { await fetch("http://127.0.0.1:" + port + "/api/instances", { signal: AbortSignal.timeout(1000) }); listener = true; }
    catch (error) { log({ event: "listener-closed", error: error.message }); }
  }
  log({ event: "cleanup", survivors, listener });
  if (survivors.length || listener) process.exitCode = 2;
  unlinkSync(alias);
  if (!survivors.length && !listener) rmSync(sandbox, { recursive: true, force: true });
}
