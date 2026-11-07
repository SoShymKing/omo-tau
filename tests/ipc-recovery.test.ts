import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { WebSocketClient } from "../public/websocket-client.js";

describe("real Tau IPC recovery", () => {
  let root: string;
  let gateway: ChildProcess;
  let client: WebSocketClient | undefined;
  let base: string;
  let sessionFile: string;
  let diagnostics = "";
  let earlyExtensionEvents: readonly unknown[] = [];
  let startupExtensionEvents: readonly unknown[] = [];
  let recoveryStoreKind: "default" | "legacy" | undefined;
  let gatewayLines: ReturnType<typeof createInterface>;

  async function start(earlyEvent = false, requireAutoTitle = false, controlClock = false, compactionHooks = false) {
    root = await mkdtemp(path.join(tmpdir(), "tau-ipc-recovery-"));
    const sessions = path.join(root, ".omo/agent/sessions/project");
    await mkdir(sessions, { recursive: true });
    const first = path.join(sessions, "gateway.jsonl");
    sessionFile = path.join(sessions, "worker.jsonl");
    for (const [file, id] of [[first, "gateway"], [sessionFile, "worker"]] as const) {
      await writeFile(file, JSON.stringify({ type: "session", id, cwd: root }) + "\n");
    }
    if (recoveryStoreKind) {
      const canonical = await realpath(root);
      const key = `${path.basename(canonical)}-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
      const store = recoveryStoreKind === "legacy" ? path.join(root, ".omo/senpi-task") :
        path.join(root, ".omo/agent/projects", key, "senpi-task");
      await mkdir(path.join(store, "tasks"), { recursive: true });
      await writeFile(path.join(store, "tasks/st_00000001.json"), JSON.stringify({
        ...agentTask, task_id: "st_00000001", parent_session_id: "worker", root_session_id: "worker",
        execution_mode: "auto", notification: { run_epoch: 0, notified_epoch: -1 },
      }));
    }
    gateway = spawn(process.execPath, [path.join(import.meta.dir, "fixtures/mirror-host.mjs"), first], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env, HOME: root, USERPROFILE: root,
        OMO_CODING_AGENT_DIR: "", SENPI_CODING_AGENT_DIR: "", TAU_TASK_STATE_DIR: "",
        PI_CODING_AGENT_DIR: path.join(root, ".omo/agent"),
        PI_CODING_AGENT_SESSION_DIR: path.join(root, ".omo/agent/sessions"),
        TAU_HOST: "127.0.0.1", TAU_MIRROR_PORT: "0", TAU_DISABLED: "0",
        TAU_STATIC_DIR: path.resolve(import.meta.dir, "../public"),
        TAU_USER: "", TAU_PASS: "", PI_SUBAGENT_CHILD: "",
        TAU_GATEWAY_PIPE: "", TAU_GATEWAY_TOKEN: "", TAU_GATEWAY_PID: "", TAU_WORKER_NONCE: "",
        QA_EARLY_EVENT: earlyEvent ? "1" : "",
        QA_REQUIRE_AUTO_TITLE: requireAutoTitle ? "1" : "",
        QA_CONTROL_CLOCK: controlClock ? "1" : "",
        QA_COMPACTION_HOOKS: compactionHooks ? "1" : "",
        QA_EARLY_EXTENSION_EVENTS: JSON.stringify(earlyExtensionEvents),
        QA_STARTUP_EXTENSION_EVENTS: JSON.stringify(startupExtensionEvents),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    diagnostics = "";
    gateway.stderr?.on("data", chunk => { diagnostics += String(chunk); });
    const output = gateway.stdout;
    if (!output) throw new Error("Missing gateway stdout");
    gatewayLines = createInterface({ input: output });
    const ready = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Gateway startup failed: ${diagnostics}`)), 10000);
      const receive = (line: string) => {
        if (!line.startsWith("QA_READY ")) return;
        clearTimeout(timeout);
        gatewayLines.removeListener("line", receive);
        resolve(line);
      };
      gatewayLines.on("line", receive);
      gateway.once("exit", code => {
        clearTimeout(timeout);
        reject(new Error(`Gateway exited (${code}): ${diagnostics}`));
      });
    });
    base = `http://127.0.0.1:${ready.split(" ").pop()}`;
    client = new WebSocketClient(base.replace("http", "ws") + "/ws");
    const state = next(message => message.type === "state");
    client.connect();
    await state;
  }

  function next(predicate: (message: Record<string, unknown>) => boolean) {
    const selected = client;
    if (!selected) throw new Error("Missing browser client");
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Missing IPC signal: ${diagnostics}`));
      }, 10000);
      const receive = (event: MessageEvent) => {
        const message: Record<string, unknown> = JSON.parse(String(event.data));
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      };
      const closed = () => {
        cleanup();
        reject(new Error(`Gateway closed before IPC signal: ${diagnostics}`));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        selected.ws?.removeEventListener("message", receive);
        selected.ws?.removeEventListener("close", closed);
        selected.removeEventListener("connected", attach);
      };
      const attach = () => {
        selected.ws?.addEventListener("message", receive);
        selected.ws?.addEventListener("close", closed, { once: true });
      };
      if (selected.ws) attach();
      else selected.addEventListener("connected", attach, { once: true });
    });
  }

  async function openWorker() {
    const response = await fetch(`${base}/api/sessions/switch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionFile }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    const snapshot = await client?.selectSession(sessionFile);
    if (!snapshot) throw new Error("Worker selection was not acknowledged");
    return { snapshot, body };
  }

  function control(command: Record<string, unknown>) {
    // The gateway fixture executes real extension events in its own context.
    const input = gateway.stdin;
    if (!input) throw new Error("Missing gateway control input");
    input.write(JSON.stringify(command) + "\n");
  }

  function outputLine(prefix: string) {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        gatewayLines.removeListener("line", receive);
        reject(new Error(`Missing fixture signal ${prefix}: ${diagnostics}`));
      }, 10000);
      const receive = (line: string) => {
        if (!line.startsWith(prefix)) return;
        clearTimeout(timeout);
        gatewayLines.removeListener("line", receive);
        resolve(line);
      };
      gatewayLines.on("line", receive);
    });
  }

  afterEach(async () => {
    earlyExtensionEvents = [];
    startupExtensionEvents = [];
    recoveryStoreKind = undefined;
    if (client?.ws && client.ws.readyState !== WebSocket.CLOSED) {
      const closed = once(client.ws, "close", { signal: AbortSignal.timeout(5000) });
      client.disconnect();
      await closed;
    }
    client = undefined;
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      const exited = once(gateway, "exit", { signal: AbortSignal.timeout(10000) });
      gateway.stdin?.end();
      try { await exited; } catch (error) { gateway.kill(); throw error; }
    }
    gatewayLines?.close();
    if (root) await rm(root, { recursive: true, force: true });
  }, 20000);

  const agentTask = { task_id: "st_fixture", model: "mock/worker", status: "running",
    residency_state: "resident", depth: 1, created_at: "2026-11-07T00:00:00Z", updated_at: "2026-11-07T00:00:01Z" };
  const agentDag = { run_id: "run-fixture", run_key: "inspect", name: "Inspect", status: "running",
    created_at: agentTask.created_at, updated_at: agentTask.updated_at, amend_count: 2, lease_holder_pid: 42,
    counts: { total: 1, pending: 0, blocked: 0, scheduled: 0, running: 1, paused: 0,
      completed: 0, failed: 0, cancelled: 0, skipped: 0 },
    nodes: [{ id: "inspect", prompt: "Read", label: "Reader", state: "running", depends_on: [],
      attempt: 1, created_at: agentTask.created_at, task_id: agentTask.task_id }],
    edges: [], waves: [{ index: 0, node_ids: ["inspect"] }] };
  const isAgentsEvent = (message: Record<string, unknown>) => message.type === "event" &&
    typeof message.event === "object" && message.event !== null &&
    "type" in message.event && message.event.type === "agents_state";
  function extensionEvent(parent: string, tasks: readonly unknown[]) {
    return { type: "qa_extension_event", id: "agents", name: "omo.task.updated",
      data: { parent_session_id: parent, tasks } };
  }

  test("captures task and DAG emissions before session_start at extension registration", async () => {
    earlyExtensionEvents = [
      { name: "omo.task.updated", data: { parent_session_id: "gateway", tasks: [agentTask], truncated_tasks: 2 } },
      { name: "omo.dag.updated", data: { parent_session_id: "gateway", runs: [agentDag], truncated_runs: 1 } },
      { name: "omo.task.updated", data: { parent_session_id: "foreign", tasks: [] } },
    ];
    await start();
    const selected = await client?.selectSession(path.join(root, ".omo/agent/sessions/project/gateway.jsonl"));
    expect(selected).toMatchObject({
      agentsState: { availability: "ready", parent_session_id: "gateway", tasks: [agentTask], truncated_tasks: 2 },
      dagState: { availability: "ready", parent_session_id: "gateway", runs: [agentDag], truncated_runs: 1 },
    });
  });

  test("agents snapshot and live updates survive worker pipe loss and reselection", async () => {
    await start();
    const { snapshot } = await openWorker();
    expect(snapshot.agentsState).toMatchObject({ availability: "unknown", parent_session_id: "worker" });
    const live = next(isAgentsEvent);
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: extensionEvent("worker", [agentTask]) });
    await live;
    const disconnected = next(message => message.type === "session_status" &&
      message.sessionId === snapshot.sessionId && message.status === "disconnected");
    let pipeLost = false;
    const ready = next(message => {
      if (message.type !== "session_status" || message.sessionId !== snapshot.sessionId) return false;
      if (message.status === "disconnected") pipeLost = true;
      return pipeLost && message.status === "ready";
    });
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: { type: "qa_disconnect" } });
    await disconnected;
    await ready;
    expect(await client?.selectSession(sessionFile)).toMatchObject({
      epoch: snapshot.epoch, agentsState: { availability: "ready", parent_session_id: "worker", tasks: [agentTask] },
    });
    const update = next(isAgentsEvent);
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: extensionEvent("worker", []) });
    expect(await update).toMatchObject({ sessionId: snapshot.sessionId, epoch: snapshot.epoch,
      event: { type: "agents_state", agentsState: { availability: "ready", tasks: [] } } });
  });

  test.each(["default", "legacy"] as const)("selected worker recovers %s store from its real cwd without a Tau override", async kind => {
    recoveryStoreKind = kind;
    await start();
    const recovered = next(message => isAgentsEvent(message) && typeof message.event === "object" &&
      message.event !== null && "agentsState" in message.event && typeof message.event.agentsState === "object" &&
      message.event.agentsState !== null && "availability" in message.event.agentsState &&
      message.event.agentsState.availability === "cached");
    const { snapshot } = await openWorker();
    const wire = await recovered;
    expect(wire).toMatchObject({ sessionId: snapshot.sessionId, epoch: snapshot.epoch, event: {
      type: "agents_state", agentsState: { availability: "cached", parent_session_id: "worker",
        coverage: { incomplete: true, issues: ["location-unverified"] }, tasks: [{
          task_id: "st_00000001", tau_ancestry: { relation: "direct", evidence: "record" },
        }] },
    } });
    expect(await client?.selectSession(sessionFile)).toMatchObject({
      agentsState: { availability: "cached", tasks: [{ task_id: "st_00000001" }] },
    });
  });

  test("real public child events aggregate under the selected owner and root replacement retires both child channels", async () => {
    await start();
    const file = path.join(root, ".omo/agent/sessions/project/gateway.jsonl");
    await client?.selectSession(file);
    const parentTask = { ...agentTask, child_session_id: "proven-child" };
    const parent = next(isAgentsEvent);
    control(extensionEvent("gateway", [parentTask]));
    await parent;
    const child = next(isAgentsEvent);
    control(extensionEvent("proven-child", [{ ...agentTask, task_id: "child-task" }]));
    expect(await child).toMatchObject({ event: { agentsState: { parent_session_id: "gateway",
      tasks: [{ task_id: agentTask.task_id }, { task_id: "child-task" }] } } });
    const dag = next(isAgentsEvent);
    control({ type: "qa_extension_event", id: "child-dag", name: "omo.dag.updated",
      data: { parent_session_id: "proven-child", runs: [agentDag] } });
    expect(await dag).toMatchObject({ event: { dagState: { parent_session_id: "gateway",
      runs: [{ run_id: agentDag.run_id, tau_owner_session_id: "proven-child" }] } } });
    const cut = next(isAgentsEvent);
    control(extensionEvent("gateway", [parentTask]));
    expect(await cut).toMatchObject({ event: {
      agentsState: { tasks: [{ task_id: agentTask.task_id }] }, dagState: { availability: "ready", runs: [] },
    } });
    const empty = next(isAgentsEvent);
    control(extensionEvent("gateway", []));
    await empty;
    const rejected = outputLine("QA_EXTENSION_EVENT_DONE agents");
    control(extensionEvent("proven-child", [agentTask]));
    await rejected;
    expect(await client?.selectSession(file)).toMatchObject({
      agentsState: { availability: "ready", tasks: [] }, dagState: { availability: "ready", runs: [] },
    });
  });

  test("preserves observations while session_start awaits mirror initialization", async () => {
    startupExtensionEvents = [{ name: "omo.task.updated", data: { parent_session_id: "gateway", tasks: [agentTask] } }];
    await start();
    expect(await client?.selectSession(path.join(root, ".omo/agent/sessions/project/gateway.jsonl"))).toMatchObject({
      agentsState: { availability: "ready", parent_session_id: "gateway", tasks: [agentTask] },
    });
  });

  test("session replacement clears old agents and unsubscribes the retired extension", async () => {
    await start();
    const file = path.join(root, ".omo/agent/sessions/project/gateway.jsonl");
    const before = await client?.selectSession(file);
    const live = next(isAgentsEvent);
    control(extensionEvent("gateway", [agentTask]));
    await live;
    const replacement = path.join(root, ".omo/agent/sessions/project/replacement.jsonl");
    await writeFile(replacement, JSON.stringify({ type: "session", id: "replacement", cwd: root }) + "\n");
    const retired = outputLine("QA_EXTENSION_LISTENERS 0");
    const replaced = outputLine("QA_SESSION_REPLACED switch");
    control({ type: "qa_replace_session", id: "switch", sessionFile: replacement,
      events: [{ name: "omo.task.updated", data: { parent_session_id: "gateway", tasks: [agentTask] } }] });
    await retired;
    await replaced;
    const after = await client?.selectSession(replacement);
    expect(after?.epoch).not.toBe(before?.epoch);
    expect(after).toMatchObject({ agentsState: { availability: "unknown", parent_session_id: "replacement" },
      dagState: { availability: "unknown", parent_session_id: "replacement" } });
    const accepted = next(isAgentsEvent);
    control(extensionEvent("replacement", []));
    expect(await accepted).toMatchObject({ epoch: after?.epoch,
      event: { agentsState: { availability: "ready", parent_session_id: "replacement", tasks: [] } } });
    const ws = client?.ws;
    if (!ws || !client) throw new Error("Missing browser connection");
    const closed = once(ws, "close", { signal: AbortSignal.timeout(5000) });
    client.disconnect();
    await closed;
    const unsubscribed = outputLine("QA_EXTENSION_LISTENERS 0");
    const exited = once(gateway, "exit", { signal: AbortSignal.timeout(10000) });
    gateway.stdin?.end();
    await unsubscribed;
    expect((await exited)[0]).toBe(0);
  });

  test("two selected sessions never receive each other's agents state", async () => {
    await start();
    const { snapshot } = await openWorker();
    const terminalFile = path.join(root, ".omo/agent/sessions/project/gateway.jsonl");
    const second = new WebSocketClient(base.replace("http", "ws") + "/ws");
    try {
      const connected = once(second, "stateUpdate", { signal: AbortSignal.timeout(10000) });
      second.connect();
      await connected;
      await second.selectSession(terminalFile);
      const workerEvents: unknown[] = [];
      const terminalEvents: unknown[] = [];
      client?.addEventListener("rpcEvent", event => { if (event instanceof CustomEvent) workerEvents.push(event.detail); });
      second.addEventListener("rpcEvent", event => { if (event instanceof CustomEvent) terminalEvents.push(event.detail); });
      const workerUpdate = next(isAgentsEvent);
      control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: extensionEvent("worker", [agentTask]) });
      await workerUpdate;
      const terminalUpdate = once(second, "rpcEvent", { signal: AbortSignal.timeout(10000) });
      control(extensionEvent("gateway", []));
      await terminalUpdate;
      const rejected = outputLine("QA_EXTENSION_EVENT_DONE foreign");
      control({ ...extensionEvent("worker", []), id: "foreign" });
      await rejected;
      expect(await second.selectSession(terminalFile)).toMatchObject({
        agentsState: { availability: "ready", parent_session_id: "gateway", tasks: [] },
      });
      expect(await client?.selectSession(sessionFile)).toMatchObject({
        agentsState: { availability: "ready", parent_session_id: "worker", tasks: [agentTask] },
      });
      for (const [events, parent] of [[workerEvents, "worker"], [terminalEvents, "gateway"]] as const) {
        const ready: unknown[] = [];
        for (const event of events) {
          expect(event).toMatchObject({ type: "agents_state", agentsState: { parent_session_id: parent } });
          if (typeof event === "object" && event !== null && "agentsState" in event &&
              typeof event.agentsState === "object" && event.agentsState !== null &&
              "availability" in event.agentsState && event.agentsState.availability === "ready") ready.push(event);
        }
        expect(ready).toHaveLength(1);
      }
    } finally {
      const closed = second.ws && once(second.ws, "close", { signal: AbortSignal.timeout(5000) });
      second.disconnect();
      if (closed) await closed;
    }
  });

  test("conversation view preserves agents state in snapshot and live event", async () => {
    await start();
    const { snapshot } = await openWorker();
    await client?.selectSession(sessionFile, { view: "conversation-v1" });
    const received = next(isAgentsEvent);
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: extensionEvent("worker", [agentTask]) });
    expect(await received).toMatchObject({ event: {
      type: "agents_state", agentsState: { availability: "ready", parent_session_id: "worker", tasks: [agentTask] },
      dagState: { availability: "unknown", parent_session_id: "worker" },
    } });
    const dagLive = next(isAgentsEvent);
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
      type: "qa_extension_event", id: "dag", name: "omo.dag.updated",
      data: { parent_session_id: "worker", runs: [agentDag], truncated_runs: 3 },
    } });
    expect(await dagLive).toMatchObject({ event: {
      agentsState: { availability: "ready", tasks: [agentTask] },
      dagState: { availability: "ready", parent_session_id: "worker", runs: [agentDag], truncated_runs: 3 },
    } });
    expect(await client?.selectSession(sessionFile, { view: "conversation-v1" })).toMatchObject({
      view: "conversation-v1", agentsState: { availability: "ready", tasks: [agentTask] },
      dagState: { availability: "ready", parent_session_id: "worker", runs: [agentDag], truncated_runs: 3 },
    });
  });

  test("live agents state uses event envelope with sessionId epoch seq and nested agents_state", async () => {
    await start();
    const file = path.join(root, ".omo/agent/sessions/project/gateway.jsonl");
    const snapshot = await client?.selectSession(file);
    const browser = client;
    if (!browser || !snapshot) throw new Error("Missing browser selection");
    const dispatched: unknown[] = [];
    browser.addEventListener("rpcEvent", event => { if (event instanceof CustomEvent) dispatched.push(event.detail); });
    const received = next(isAgentsEvent);
    control(extensionEvent("gateway", [agentTask]));
    const wire = await received;
    expect(wire).toMatchObject({ type: "event", sessionId: snapshot.sessionId, epoch: snapshot.epoch, seq: snapshot.seq + 1,
      event: { type: "agents_state", agentsState: { tasks: [agentTask] }, dagState: { availability: "unknown" } } });
    browser.handleMessage({ ...wire, type: "agents_state" });
    browser.handleMessage({ ...wire, sessionId: "foreign", seq: browser.seq + 1 });
    browser.handleMessage({ ...wire, epoch: "retired", seq: browser.seq + 1 });
    browser.handleMessage(wire);
    browser.handleMessage({ ...wire, seq: snapshot.seq });
    expect(dispatched).toEqual([{ type: "agents_state", sessionId: snapshot.sessionId,
      agentsState: { availability: "ready", parent_session_id: "gateway", tasks: [
        { ...agentTask, tau_ancestry: { relation: "unresolved", evidence: "unavailable" } },
      ], coverage: { incomplete: true, issues: ["ancestry-unresolved", "location-unverified", "store-missing"] } },
      dagState: { availability: "unknown", parent_session_id: "gateway", reason: "No authoritative DAG snapshot observed.",
        coverage: { incomplete: true, issues: ["location-unverified", "store-missing"] } } }]);
    const socket = browser.ws;
    if (!socket) throw new Error("Missing browser socket");
    const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
    browser.disconnect();
    await closed;
    const state = once(browser, "stateUpdate", { signal: AbortSignal.timeout(10000) });
    browser.connect();
    await state;
    expect(await browser.selectSession(file)).toMatchObject({
      agentsState: { availability: "ready", tasks: [agentTask] }, seq: wire.seq, epoch: wire.epoch,
    });
  });

  test("snapshot and buffered live events apply once in epoch sequence order", async () => {
    await start();
    const file = path.join(root, ".omo/agent/sessions/project/gateway.jsonl");
    const armed = outputLine("QA_SNAPSHOT_ARMED buffer");
    control({ type: "qa_hold_snapshot", id: "buffer" });
    await armed;
    const held = outputLine("QA_SNAPSHOT_HELD buffer");
    const selected = client?.selectSession(file);
    await held;
    const observed: unknown[] = [];
    client?.addEventListener("rpcEvent", event => { if (event instanceof CustomEvent) observed.push(event.detail); });
    const emitted = outputLine("QA_EXTENSION_EVENT_DONE agents");
    control(extensionEvent("gateway", [agentTask]));
    await emitted;
    const live = next(isAgentsEvent);
    control({ type: "qa_release_snapshot" });
    const snapshot = await selected;
    if (!snapshot) throw new Error("Missing buffered snapshot");
    const wire = await live;
    if (typeof wire.seq !== "number") throw new Error("Missing event sequence");
    expect(snapshot).toMatchObject({ agentsState: { availability: "unknown" } });
    expect(wire).toMatchObject({ epoch: snapshot?.epoch, seq: snapshot.seq + 1,
      event: { agentsState: { availability: "ready", tasks: [agentTask] } } });
    expect(observed).toHaveLength(1);
    expect(client?.seq).toBe(wire.seq);
  });

  test("answers a browser liveness probe without selecting or starting a session", async () => {
    // Given a real gateway before the browser has selected any session.
    await start();
    const before = await fetch(`${base}/api/instances`).then(response => response.json());
    const response = next(message => message.id === "resume-probe");
    // When the browser checks the WebSocket route without a session identity.
    client?.ws?.send(JSON.stringify({ type: "ping", id: "resume-probe" }));
    // Then the gateway responds directly without opening or authorizing a worker.
    expect(await response).toEqual({ type: "pong", id: "resume-probe" });
    expect(client?.sessionReady).toBe(false);
    const after = await fetch(`${base}/api/instances`).then(reply => reply.json());
    expect(after.sessions.map((session: { sessionId: string }) => session.sessionId))
      .toEqual(before.sessions.map((session: { sessionId: string }) => session.sessionId));
  }, 20000);

  test("pending selection retains one latest Agents frame and preserves other event order", async () => {
    await start(false, false, true);
    const file = path.join(root, ".omo/agent/sessions/project/gateway.jsonl");
    const armed = outputLine("QA_SNAPSHOT_ARMED coalesce");
    control({ type: "qa_hold_snapshot", id: "coalesce" });
    await armed;
    const held = outputLine("QA_SNAPSHOT_HELD coalesce");
    const selected = client?.selectSession(file);
    await held;
    for (let index = 0; index < 3; index++) {
      control(extensionEvent("gateway", [{ ...agentTask, task_summary: `marker-${index}` }]));
      const flushed = outputLine(`QA_AGENTS_FLUSH ${index} `);
      control({ type: "qa_flush_agents", id: String(index) });
      const line = await flushed;
      const buffers: unknown = JSON.parse(line.slice(`QA_AGENTS_FLUSH ${index} `.length));
      if (!Array.isArray(buffers) || !Array.isArray(buffers[0])) throw new Error("Missing pending queue");
      const events = buffers[0];
      expect(events.filter(isAgentsEvent)).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ event: { agentsState: { tasks: [{ task_summary: `marker-${index}` }] } } });
      if (index === 0) {
        const emitted = outputLine("QA_EVENTS_DONE middle");
        control({ type: "qa_events", id: "middle", events: [{ type: "agent_start" }] });
        await emitted;
      } else expect(events[0]).toMatchObject({ type: "event", event: { type: "agent_start" } });
    }
    const received: unknown[] = [];
    client?.addEventListener("rpcEvent", event => { if (event instanceof CustomEvent) received.push(event.detail); });
    const live = next(isAgentsEvent);
    control({ type: "qa_release_snapshot" });
    await selected;
    expect(await live).toMatchObject({ event: { agentsState: { tasks: [{ task_summary: "marker-2" }] } } });
    expect(received.filter(value => typeof value === "object" && value !== null && "type" in value &&
      value.type === "agents_state")).toHaveLength(1);
  });

  test("publishes background wake sources in status and snapshots", async () => {
    // Given an idle worker with two independent background result sources.
    await start();
    const { snapshot } = await openWorker();
    const pending = next(message => message.type === "session_status" &&
      message.sessionId === snapshot.sessionId && message.activeWakeSources === true);
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
      type: "qa_events", events: [
        { type: "wake_source_state", source: "senpi-task", activeCount: 1 },
        { type: "wake_source_state", source: "senpi-codemode", activeCount: 1 },
      ],
    } });
    expect(await pending).toMatchObject({ isStreaming: false, activeWakeSources: true });
    expect(await client?.selectSession(sessionFile)).toMatchObject({
      isStreaming: false, activeWakeSources: true,
    });
    // When only the child source clears, the detached tool source remains live.
    const remaining = next(message => message.type === "event" &&
      typeof message.event === "object" && message.event !== null &&
      "source" in message.event && message.event.source === "senpi-task" &&
      "activeCount" in message.event && message.event.activeCount === 0);
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
      type: "qa_events", events: [{ type: "wake_source_state", source: "senpi-task", activeCount: 0 }],
    } });
    await remaining;
    expect(await client?.selectSession(sessionFile)).toMatchObject({ activeWakeSources: true });
    // Then the status clears only after the last pending source clears.
    const cleared = next(message => message.type === "session_status" &&
      message.sessionId === snapshot.sessionId && message.activeWakeSources === false);
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
      type: "qa_events", events: [{ type: "wake_source_state", source: "senpi-codemode", activeCount: 0 }],
    } });
    expect(await cleared).toMatchObject({ isStreaming: false, activeWakeSources: false });
  }, 20000);

  test("preserves stream statistics across session selection and IPC reconnect", async () => {
    // Given a real worker with message and tool stream events.
    await start();
    const { snapshot } = await openWorker();
    const received = next(message => message.type === "event" &&
      typeof message.event === "object" && message.event !== null &&
      "type" in message.event && message.event.type === "tool_execution_update");
    const before = Date.now();
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
      type: "qa_events", id: "stream-stats", events: [
        { type: "agent_start" },
        { type: "message_update", message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "text_delta", delta: "answer" } },
        { type: "message_update", message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" } },
        { type: "tool_execution_start", toolCallId: "progress", toolName: "qa", args: {} },
        { type: "tool_execution_update", toolCallId: "progress", partialResult: "progress" },
      ],
    } });
    const event = (await received).event;
    if (typeof event !== "object" || event === null || !("streamStats" in event)) {
      throw new Error("Missing stream statistics");
    }
    const stats = event.streamStats;
    expect(stats).toMatchObject({ count: 3 });
    if (typeof stats !== "object" || stats === null ||
        !("lastReceivedAt" in stats) || typeof stats.lastReceivedAt !== "number") {
      throw new Error("Missing receipt timestamp");
    }
    expect(stats.lastReceivedAt).toBeGreaterThanOrEqual(before);
    expect(stats.lastReceivedAt).toBeLessThanOrEqual(Date.now());

    // When the browser leaves the worker and its IPC pipe reconnects.
    const instances = await fetch(`${base}/api/instances`).then(response => response.json());
    const terminal = instances.sessions.find((item: { kind: string }) => item.kind === "terminal");
    const other = await client?.selectSession(terminal.sessionFile);
    expect(other?.streamStats).toEqual({ count: 0, lastReceivedAt: null });
    const disconnected = next(message => message.type === "session_status" &&
      message.sessionId === snapshot.sessionId && message.status === "disconnected");
    const ready = next(message => message.type === "session_status" &&
      message.sessionId === snapshot.sessionId && message.status === "ready");
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: { type: "qa_disconnect" } });
    await disconnected;
    expect((await ready).streamStats).toEqual(stats);

    // Then selection restores the exact server count and timestamp, and the next run resets them.
    const restored = await client?.selectSession(sessionFile);
    expect(restored?.isStreaming).toBe(true);
    expect(restored?.streamStats).toEqual(stats);
    const restarted = next(message => message.type === "event" &&
      typeof message.event === "object" && message.event !== null &&
      "type" in message.event && message.event.type === "agent_start");
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
      type: "qa_events", id: "stream-restart", events: [{ type: "agent_end" }, { type: "agent_start" }],
    } });
    const restart = (await restarted).event;
    expect(restart).toMatchObject({ streamStats: { count: 0, lastReceivedAt: null } });
    expect((await client?.selectSession(sessionFile))?.streamStats).toEqual({ count: 0, lastReceivedAt: null });
  }, 20000);

  test("delivers events and selection snapshots larger than the old frame limit", async () => {
    // Given a selected real owned worker and an event exceeding the old IPC cap.
    await start();
    const { snapshot } = await openWorker();
    const size = 65 * 1024 * 1024;
    const received = next(message => message.type === "event" &&
      typeof message.event === "object" && message.event !== null &&
      "type" in message.event && message.event.type === "tool_execution_end");

    // When the gateway fixture sends the worker a control command.
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId,
      command: { type: "qa_large_result", size } });
    const message = await received;
    const event = message.event;
    if (typeof event !== "object" || event === null || !("result" in event)) {
      throw new Error("Missing large tool result");
    }
    expect(JSON.stringify(event.result).length).toBeGreaterThan(size);

    // Then a fresh correlated snapshot still crosses the same live pipe.
    const selected = await client?.selectSession(sessionFile);
    expect(selected?.sessionId).toBe(snapshot.sessionId);
    expect(selected?.toolExecutions[0].output.content[0].text.length).toBe(size);
    expect(selected?.toolExecutions[0].output.content[0].text.slice(-4)).toBe("\uD83D\uDE00\uD55Cz");
    const response = next(message => message.type === "response" && message.id === "large-command");
    expect(client?.send({ type: "get_state", id: "large-command", payload: "x".repeat(size) })).toBe(true);
    expect((await response).success).toBe(true);
  }, 30000);

  test("reconnects the same owned worker and resynchronizes selection after pipe loss", async () => {
    // Given an acknowledged worker whose gateway remains alive.
    await start();
    const { snapshot } = await openWorker();
    const before = await fetch(`${base}/api/instances`).then(response => response.json());
    const owned = before.sessions.find((session: { sessionId: string }) => session.sessionId === snapshot.sessionId);
    let readinessAtDisconnect: boolean | undefined;
    const disconnected = next(message => {
      if (message.type !== "session_status" || message.sessionId !== snapshot.sessionId ||
          message.status !== "disconnected") return false;
      readinessAtDisconnect = client?.sessionReady;
      return true;
    });
    const ready = next(message => message.type === "session_status" &&
      message.sessionId === snapshot.sessionId && message.status === "ready");

    // When that worker's actual socket closes.
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: { type: "qa_disconnect" } });
    await disconnected;
    expect(readinessAtDisconnect).toBe(false);
    const recovered = await ready;

    // Then it re-registers rather than shutting down or creating a duplicate.
    expect(recovered.pid).toBe(owned.pid);
    expect(recovered.sessionId).toBe(snapshot.sessionId);
    const selected = await client?.selectSession(sessionFile);
    expect(selected?.sessionId).toBe(snapshot.sessionId);
    expect(client?.sessionReady).toBe(true);
    const response = next(message => message.type === "response" && message.id === "after-reconnect");
    expect(client?.send({ type: "get_state", id: "after-reconnect" })).toBe(true);
    expect((await response).success).toBe(true);
  }, 20000);

  test("registers before publishing events emitted during connection establishment", async () => {
    // Given a worker that emits immediately after its session_start handlers.
    await start(true);
    // When the real gateway opens that worker.
    const { snapshot } = await openWorker();
    // Then early events cannot precede registration and close the pipe.
    expect(snapshot.sessionFile).toBe(sessionFile);
    expect(client?.sessionReady).toBe(true);
  }, 20000);

  test("opts browser-owned workers into the host summary title generator", async () => {
    // Given a worker fixture that refuses to boot without the host opt-in.
    await start(false, true);
    // When Tau launches and selects that worker.
    const { snapshot } = await openWorker();
    // Then the actual child process received the auto-title option.
    expect(snapshot.sessionFile).toBe(sessionFile);
    expect(client?.sessionReady).toBe(true);
  }, 20000);

  test("delivers browser prompts through native RPC so the host can title them", async () => {
    // Given an empty browser-owned worker with host auto-titling enabled.
    await start(false, true);
    const { snapshot } = await openWorker();
    const response = next(message => message.type === "response" && message.id === "native-prompt");
    const title = next(message => message.type === "session_status" &&
      message.sessionId === snapshot.sessionId && message.sessionName === "Native first request summary");
    // When the browser submits a human request.
    expect(client?.send({ type: "prompt", id: "native-prompt", message: "Review the browser title generation path" })).toBe(true);
    // Then the actual child's RPC pipe, not extension sendUserMessage, admits it.
    expect((await response).data).toEqual({
      source: "rpc", hasRoutingId: false, message: "Review the browser title generation path", streamingBehavior: "steer",
    });
    expect((await title).sessionFile).toBe(sessionFile);
    const persisted = await fetch(`${base}/api/sessions`).then(response => response.json());
    expect(persisted.projects.flatMap((project: { sessions: { filePath: string; name: string }[] }) => project.sessions)
      .find((session: { filePath: string }) => session.filePath === sessionFile)?.name).toBe("Native first request summary");
  }, 20000);

  test("delivers explicitly routed background input while another session selection is pending", async () => {
    // Given an acknowledged worker and a pending selection for the terminal.
    await start();
    const { snapshot } = await openWorker();
    const instances = await fetch(`${base}/api/instances`).then(response => response.json());
    const terminal = instances.sessions.find((item: { kind: string }) => item.kind === "terminal");
    const response = next(message => message.type === "response" && message.id === "background-input");
    const selected = client?.selectSession(terminal.sessionFile);
    expect(client?.sessionReady).toBe(false);

    // When the old worker's queue sends an input with its own routing identity.
    expect(client?.send({
      type: "prompt", id: "background-input", sessionId: snapshot.sessionId,
      message: "queued-for-background-worker",
    }, { background: true })).toBe(true);
    await selected;

    // Then the real worker's native pipe admits it, not the newly selected terminal.
    expect(await response).toMatchObject({
      success: true, sessionId: snapshot.sessionId,
      data: { source: "rpc", message: "queued-for-background-worker" },
    });
  }, 20000);

  test("keeps a preflight-compacting prompt alive after switching away and restores its committed message", async () => {
    // Given a native prompt whose host is idle until compaction finishes.
    await start(false, false, true);
    const { snapshot } = await openWorker();
    const started = next(message => message.type === "event" &&
      typeof message.event === "object" && message.event !== null &&
      "type" in message.event && message.event.type === "compaction_start");
    const response = next(message => message.type === "response" && message.id === "compacting-prompt");
    expect(client?.send({ type: "prompt", id: "compacting-prompt",
      clientMessageId: "stable-browser-input", message: "compact-before-prompt" })).toBe(true);
    await started;
    expect(await client?.selectSession(sessionFile)).toMatchObject({
      isStreaming: false, isCompacting: true, hasPendingMessages: false,
    });
    const instances = await fetch(`${base}/api/instances`).then(result => result.json());
    const terminal = instances.sessions.find((item: { kind: string }) => item.kind === "terminal");

    // When selection leaves and all existing 30-second deadlines elapse.
    await client?.selectSession(terminal.sessionFile);
    const advanced = next(message => message.type === "qa_clock_advanced");
    control({ type: "qa_advance_deadlines", sessionId: snapshot.sessionId });
    expect(await advanced).toMatchObject({ pending: 1, idleScheduled: false, writable: true });
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId,
      command: { type: "qa_finish_compaction" } });

    // Then native admission succeeds, and reselecting restores the committed identity.
    expect(await response).toMatchObject({ success: true, sessionId: snapshot.sessionId });
    const restored = await client?.selectSession(sessionFile);
    expect(restored).toMatchObject({ isCompacting: false, isStreaming: true });
    expect(restored?.entries).toContainEqual(expect.objectContaining({
      type: "message", message: expect.objectContaining({ clientMessageId: "stable-browser-input" }),
    }));
    const persisted = (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(persisted).toContainEqual(expect.objectContaining({
      type: "message", message: expect.objectContaining({ clientMessageId: "stable-browser-input" }),
    }));
  }, 20000);

  for (const [failure, hooks] of [[false, false], [true, false], [false, true], [true, true]]) {
    test(`reports manual compaction ${failure ? "failure" : "completion"} after the host finishes (hooks: ${hooks})`, async () => {
      // Given a worker that holds its compaction callback until explicitly released.
      await start(false, false, true, hooks);
      const { snapshot } = await openWorker();
      const events: string[] = [];
      client?.addEventListener("rpcEvent", event => {
        if (event instanceof CustomEvent) events.push(event.detail.type);
      });
      const started = next(message => message.type === "session_status" && message.isCompacting === true);
      const response = fetch(`${base}/api/rpc`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: snapshot.sessionId, type: "compact" }),
      }).then(result => result.json());
      await started;

      // When the old admission deadline elapses before the host completes.
      const advanced = next(message => message.type === "qa_clock_advanced");
      control({ type: "qa_advance_deadlines", sessionId: snapshot.sessionId });
      expect(await advanced).toMatchObject({ pending: 1 });
      control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
        type: "qa_complete_manual_compaction", ...(failure ? { error: "qa-summary-rejected" } : {}),
      } });
      const result = await response;

      // Then the RPC and browser event stream agree on the actual result.
      expect(result).toMatchObject(failure
        ? { success: false, error: "qa-summary-rejected" }
        : { success: true, data: { summary: "qa-compacted-summary" } });
      expect(events).toEqual(["auto_compaction_start", "auto_compaction_end"]);
      expect(await client?.selectSession(sessionFile)).toMatchObject({ isCompacting: false });
    }, 20000);
  }

  test("forwards supported automatic compaction hooks to the browser", async () => {
    // Given a selected worker that exposes the documented extension lifecycle.
    await start();
    const { snapshot } = await openWorker();
    const started = next(message => message.type === "event" &&
      typeof message.event === "object" && message.event !== null &&
      "type" in message.event && message.event.type === "auto_compaction_start");
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
      type: "qa_events", events: [{ type: "session_before_compact", requestId: "automatic" }],
    } });
    await started;
    expect(await client?.selectSession(sessionFile)).toMatchObject({ isCompacting: true });

    // When the host rejects the summary because its source session changed.
    const ended = next(message => message.type === "event" &&
      typeof message.event === "object" && message.event !== null &&
      "type" in message.event && message.event.type === "auto_compaction_end");
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
      type: "qa_events", events: [{
        type: "session_compact", accepted: false, rejectionCause: "stale-revision",
      }],
    } });

    // Then the browser receives a failure, never an invented successful summary.
    expect((await ended).event).toMatchObject({ accepted: false, error: "stale-revision" });
    expect(await client?.selectSession(sessionFile)).toMatchObject({ isCompacting: false });
  }, 20000);

  test("settles a superseded compaction even when the host omits its callback", async () => {
    // Given the documented hook signal for a pending manual compaction.
    await start(false, false, false, true);
    const { snapshot } = await openWorker();
    const started = next(message => message.type === "session_status" && message.isCompacting === true);
    const response = fetch(`${base}/api/rpc`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: snapshot.sessionId, type: "compact" }),
    }).then(result => result.json());
    await started;

    // When another host operation aborts that signal without calling onError.
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId,
      command: { type: "qa_supersede_compaction" } });

    // Then the request settles as stopped, without leaving a permanent spinner.
    expect(await response).toMatchObject({ success: false, error: "Compaction stopped" });
    expect(await client?.selectSession(sessionFile)).toMatchObject({ isCompacting: false });
  }, 20000);

  test("changes the worker's real auto-compaction setting through native RPC", async () => {
    // Given a host whose real setting is false, unlike the former constant true.
    await start();
    const { snapshot } = await openWorker();
    const rpc = (command: Record<string, unknown>) => fetch(`${base}/api/rpc`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...command, sessionId: snapshot.sessionId }),
    }).then(response => response.json());
    expect(await rpc({ type: "get_state" })).toMatchObject({
      success: true, data: { autoCompactionEnabled: false, autoCompactionSupported: true },
    });

    // When auto-compaction is enabled.
    expect(await rpc({ type: "set_auto_compaction", enabled: true })).toMatchObject({ success: true });

    // Then querying the host again returns the applied value.
    expect(await rpc({ type: "get_state" })).toMatchObject({
      success: true, data: { autoCompactionEnabled: true, autoCompactionSupported: true },
    });
  }, 20000);

  test("reports terminal auto-compaction as read-only rather than acknowledging a no-op", async () => {
    // Given a terminal host with read access but no setting mutation API.
    await start();
    const instances = await fetch(`${base}/api/instances`).then(response => response.json());
    const terminal = instances.sessions.find((item: { kind: string }) => item.kind === "terminal");
    const rpc = (command: Record<string, unknown>) => fetch(`${base}/api/rpc`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...command, sessionId: terminal.sessionId }),
    }).then(response => response.json());

    // When a caller attempts to change this unsupported setting.
    expect(await rpc({ type: "set_auto_compaction", enabled: true })).toMatchObject({ success: false });

    // Then the reported setting remains the actual host value and is read-only.
    expect(await rpc({ type: "get_state" })).toMatchObject({
      success: true, data: { autoCompactionEnabled: false, autoCompactionSupported: false },
    });
  }, 20000);

  test("rejects a second manual compaction without interrupting the first", async () => {
    // Given a worker already preparing a summary.
    await start();
    const { snapshot } = await openWorker();
    const started = next(message => message.type === "session_status" && message.isCompacting === true);
    const firstRequest = fetch(`${base}/api/rpc`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: snapshot.sessionId, type: "compact" }),
    }).then(result => result.json());
    await started;

    // When another compaction is requested before completion.
    const secondRequest = await fetch(`${base}/api/rpc`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: snapshot.sessionId, type: "compact" }),
    }).then(result => result.json());
    control({ type: "qa_worker_command", sessionId: snapshot.sessionId,
      command: { type: "qa_complete_manual_compaction" } });

    // Then the second request fails and the original still completes.
    expect(secondRequest.success).toBe(false);
    expect(await firstRequest).toMatchObject({ success: true, data: { summary: "qa-compacted-summary" } });
  }, 20000);

  for (const busy of [
    { start: "compaction_start", end: "compaction_end", pendingMessages: false, isCompacting: true },
    { start: "auto_compaction_start", end: "auto_compaction_end", pendingMessages: false, isCompacting: true },
    { start: "agent_settled", end: "agent_settled", pendingMessages: true, isCompacting: false },
  ]) {
    test(`protects an unselected idle worker during ${busy.start} and evicts after it clears`, async () => {
      // Given an idle worker with compaction or queued input, but no native request.
      await start(false, false, true);
      const { snapshot } = await openWorker();
      const started = next(message => message.type === "event" &&
        typeof message.event === "object" && message.event !== null &&
        "type" in message.event && message.event.type === busy.start);
      control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
        type: "qa_events", events: [{ type: busy.start, pendingMessages: busy.pendingMessages }],
      } });
      await started;
      expect(await client?.selectSession(sessionFile)).toMatchObject({
        isStreaming: false, isCompacting: busy.isCompacting, hasPendingMessages: busy.pendingMessages,
      });
      const instances = await fetch(`${base}/api/instances`).then(result => result.json());
      const terminal = instances.sessions.find((item: { kind: string }) => item.kind === "terminal");

      // When selection leaves and the worker's busy state later clears.
      await client?.selectSession(terminal.sessionFile);
      const advanced = next(message => message.type === "qa_clock_advanced");
      control({ type: "qa_advance_deadlines", sessionId: snapshot.sessionId });
      expect(await advanced).toMatchObject({ pending: 0, idleScheduled: false, writable: true });
      const cleared = next(message => message.type === "session_status" &&
        message.sessionId === snapshot.sessionId &&
        message.isCompacting === false && message.hasPendingMessages === false);
      control({ type: "qa_worker_command", sessionId: snapshot.sessionId, command: {
        type: "qa_events", events: [{ type: busy.end, pendingMessages: false }],
      } });
      await cleared;
      const disconnected = next(message => message.type === "session_status" &&
        message.sessionId === snapshot.sessionId && message.status === "disconnected");
      const expired = next(message => message.type === "qa_clock_advanced");
      control({ type: "qa_advance_deadlines", sessionId: snapshot.sessionId });
      await expired;

      // Then normal idle eviction resumes after compaction or queued input ends.
      expect(await disconnected).toMatchObject({ sessionId: snapshot.sessionId });
    }, 20000);
  }

  test("stops owned workers instead of reconnecting after intentional gateway shutdown", async () => {
    // Given a selected owned worker.
    await start();
    const { snapshot } = await openWorker();
    const state = await fetch(`${base}/api/instances`).then(response => response.json());
    const owned = state.sessions.find((session: { sessionId: string }) => session.sessionId === snapshot.sessionId);
    const ws = client?.ws;
    if (!ws || !client) throw new Error("Missing browser connection");
    const closed = once(ws, "close", { signal: AbortSignal.timeout(5000) });
    client.disconnect();
    await closed;
    // When the gateway deliberately shuts down.
    const exited = once(gateway, "exit", { signal: AbortSignal.timeout(10000) });
    gateway.stdin?.end();
    await exited;
    // Then its worker has exited, rather than becoming an orphan gateway.
    expect(() => process.kill(owned.pid, 0)).toThrow();
  }, 15000);
});
