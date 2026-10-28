import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  async function start(earlyEvent = false, requireAutoTitle = false) {
    root = await mkdtemp(path.join(tmpdir(), "tau-ipc-recovery-"));
    const sessions = path.join(root, ".omo/agent/sessions/project");
    await mkdir(sessions, { recursive: true });
    const first = path.join(sessions, "gateway.jsonl");
    sessionFile = path.join(sessions, "worker.jsonl");
    for (const [file, id] of [[first, "gateway"], [sessionFile, "worker"]]) {
      await writeFile(file, JSON.stringify({ type: "session", id, cwd: root }) + "\n");
    }
    gateway = spawn(process.execPath, [path.join(import.meta.dir, "fixtures/mirror-host.mjs"), first], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env, HOME: root, USERPROFILE: root,
        PI_CODING_AGENT_DIR: path.join(root, ".omo/agent"),
        PI_CODING_AGENT_SESSION_DIR: path.join(root, ".omo/agent/sessions"),
        TAU_HOST: "127.0.0.1", TAU_MIRROR_PORT: "0", TAU_DISABLED: "0",
        TAU_STATIC_DIR: path.resolve(import.meta.dir, "../public"),
        TAU_USER: "", TAU_PASS: "", PI_SUBAGENT_CHILD: "",
        TAU_GATEWAY_PIPE: "", TAU_GATEWAY_TOKEN: "", TAU_GATEWAY_PID: "", TAU_WORKER_NONCE: "",
        QA_EARLY_EVENT: earlyEvent ? "1" : "",
        QA_REQUIRE_AUTO_TITLE: requireAutoTitle ? "1" : "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    diagnostics = "";
    gateway.stderr?.on("data", chunk => { diagnostics += String(chunk); });
    const output = gateway.stdout;
    if (!output) throw new Error("Missing gateway stdout");
    const ready = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Gateway startup failed: ${diagnostics}`)), 10000);
      const lines = createInterface({ input: output });
      lines.on("line", line => {
        if (!line.startsWith("QA_READY ")) return;
        clearTimeout(timeout);
        lines.close();
        resolve(line);
      });
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

  afterEach(async () => {
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
    if (root) await rm(root, { recursive: true, force: true });
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
