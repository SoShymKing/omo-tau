import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { HistoryWindow, HISTORY_PAGE_BYTES, HISTORY_PAGE_ENTRIES } from "../extensions/session-history";

describe("history windows", () => {
  test("excludes only opaque source archives", () => {
    const window = new HistoryWindow(false);
    const records = [
      { type: "custom", customType: "opencode.source-message", data: "x".repeat(70 * 1024 * 1024) },
      { type: "custom", customType: "other", data: "keep" },
      { type: "custom_message", customType: "opencode.source-message", content: "visible" },
    ];
    records.forEach((entry, index) => window.push(entry, index));
    expect(window.page().entries).toEqual(records.slice(1));
    expect(window.page().history.before).toBeNull();
  });

  test("pages every entry exactly once while raw positions include archives", () => {
    const records = Array.from({ length: 241 }, (_, id) => id % 7 === 0
      ? { type: "custom", customType: "opencode.source-message", id }
      : { type: "message", id });
    let before = records.length;
    let all: unknown[] = [];
    while (before > 0) {
      const window = new HistoryWindow();
      records.slice(0, before).forEach((entry, index) => window.push(entry, index));
      const page = window.page();
      expect(page.entries.length).toBeLessThanOrEqual(HISTORY_PAGE_ENTRIES);
      all = [...page.entries, ...all];
      before = page.history.before ?? 0;
    }
    expect(all).toEqual(records.filter(entry => entry.type === "message"));
  });

  test("budgets UTF-8 bytes and defers an oversized atomic record to HTTP", () => {
    const entry = { type: "message", text: "한".repeat(HISTORY_PAGE_BYTES / 2) };
    const ipc = new HistoryWindow(false);
    ipc.push(entry, 0);
    expect(ipc.page()).toEqual({ entries: [], history: { before: 1 } });
    const http = new HistoryWindow();
    http.push(entry, 0);
    http.push({ type: "message", text: "tail" }, 1);
    expect(http.page()).toEqual({ entries: [{ type: "message", text: "tail" }], history: { before: 1 } });
  });

  test("serializes only the retained suffix when building a snapshot window", () => {
    // Given an old prefix whose payload is expensive to encode.
    const encoded: number[] = [];
    const records = Array.from({ length: 8000 }, (_, id) => ({
      type: "message", id,
      toJSON() { encoded.push(id); return { type: "message", id }; },
    }));
    // When selecting the latest snapshot page.
    const page = HistoryWindow.fromEntries(records, false).page();
    // Then discarded prefix payloads are never encoded.
    expect(page.entries).toEqual(records.slice(-HISTORY_PAGE_ENTRIES));
    expect(page.history.before).toBe(7920);
    expect(encoded.length).toBe(HISTORY_PAGE_ENTRIES);
    expect(Math.min(...encoded)).toBe(7920);
  });

  test("matches forward eviction at raw cursor, byte and archive boundaries", () => {
    // Given count/byte boundaries, including an oversized eviction barrier.
    const small = { type: "message", text: "tail" };
    const archive = { type: "custom", customType: "opencode.source-message" };
    const overhead = Buffer.byteLength(JSON.stringify({ type: "message", text: "" }));
    const exact = { type: "message", text: "x".repeat(HISTORY_PAGE_BYTES - overhead) };
    const oversized = { type: "message", text: exact.text + "x" };
    const cases = [
      [], [archive, archive], [small], [exact], [oversized],
      [small, oversized], [small, oversized, archive, archive],
      [small, oversized, archive, small], [exact, small],
      [small, { type: "message", text: "한".repeat(HISTORY_PAGE_BYTES / 2) }, small],
      Array.from({ length: 80 }, () => small),
      Array.from({ length: 81 }, () => small),
      [...Array.from({ length: 80 }, () => small), archive, archive],
      [archive, ...Array.from({ length: 80 }, () => small)],
    ];
    for (const records of cases) {
      for (const allowOversize of [false, true]) {
        const forward = new HistoryWindow(allowOversize);
        records.forEach((entry, index) => forward.push(entry, index));
        // When selecting backwards, then the established streaming contract is unchanged.
        expect(HistoryWindow.fromEntries(records, allowOversize).page()).toEqual(forward.page());
      }
    }
  });
});

describe("real Tau HTTP and IPC boundaries", () => {
  let root: string;
  let base: string;
  let shortFile: string;
  let largeFile: string;
  let toolsFile: string;
  const todoState = {
    schema: "v2",
    phases: [{ name: "Merge", tasks: [{ content: "Preserve paged history", status: "in_progress" }] }],
  };
  const children: ChildProcess[] = [];

  function launch(file: string, signal: RegExp) {
    const proc = spawn(process.execPath, [path.join(import.meta.dir, "fixtures/mirror-host.mjs"), file], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env, HOME: root, USERPROFILE: root,
        PI_CODING_AGENT_DIR: path.join(root, ".omo/agent"),
        PI_CODING_AGENT_SESSION_DIR: path.join(root, ".omo/agent/sessions"),
        TAU_HOST: "127.0.0.1", TAU_MIRROR_PORT: "0", TAU_DISABLED: "0",
        TAU_STATIC_DIR: path.resolve(import.meta.dir, "../public"),
        PI_SUBAGENT_CHILD: "", TAU_GATEWAY_PIPE: "", TAU_GATEWAY_TOKEN: "",
        TAU_WORKER_NONCE: "", TAU_GATEWAY_PID: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(proc);
    return new Promise<string>((resolve, reject) => {
      const output = proc.stdout;
      if (!output) { reject(new Error("Missing child stdout")); return; }
      let diagnostics = "";
      proc.stderr?.on("data", data => { diagnostics += String(data); });
      const timer = setTimeout(() => reject(new Error(`Missing startup signal: ${diagnostics}`)), 15000);
      createInterface({ input: output }).on("line", line => {
        if (!signal.test(line)) return;
        clearTimeout(timer);
        resolve(line);
      });
      proc.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`Early host exit ${code}: ${diagnostics}`));
      });
    });
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "tau-history-test-"));
    const dir = path.join(root, ".omo/agent/sessions/project");
    await mkdir(dir, { recursive: true });
    const header = (id: string) => ({ type: "session", id, cwd: process.cwd() });
    const user = { type: "message", message: { role: "user", content: "question" } };
    const reply = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } };
    const save = (name: string, entries: unknown[]) => writeFile(path.join(dir, `${name}.jsonl`),
      entries.map(entry => JSON.stringify(entry)).join("\n"));
    await save("short", [header("short"), user, reply, {
      type: "custom", customType: "senpi.todo-state", id: "todo", parentId: null, data: todoState,
    }]);
    await save("empty", [header("empty")]);
    await save("unanswered", [header("unanswered"), user]);
    await save("assistant-only", [header("assistant-only"), reply]);
    await save("large", [
      header("large"),
      { type: "custom", customType: "opencode.source-message", data: "x".repeat(70 * 1024 * 1024) },
      ...Array.from({ length: 200 }, (_, id) => ({ type: "message", id, message: user.message })),
    ]);
    const call = (id: string) => ({ type: "message", message: { role: "assistant",
      content: [{ type: "toolCall", id, name: "bash", arguments: {} }] } });
    const result = (id: string) => ({ type: "message", message: { role: "toolResult",
      toolCallId: id, content: [{ type: "text", text: `output-${id}` }], isError: id === "failed" } });
    await save("tools", [
      header("tools"), call("paged-call"), call("paged-result"), result("paged-result"),
      ...Array.from({ length: 90 }, () => user),
      ...["complete", "failed", "pending", "streaming"].flatMap(id => [call(id), result(id)]),
      call("uncommitted"), result("paged-call"), result("result-only"),
    ]);
    shortFile = path.join(dir, "short.jsonl");
    largeFile = path.join(dir, "large.jsonl");
    toolsFile = path.join(dir, "tools.jsonl");
    const ready = await launch(shortFile, /QA_READY/);
    base = `http://127.0.0.1:${ready.split(" ").pop()}`;
    await launch(largeFile, /Session registered with Tau gateway/);
    await launch(toolsFile, /Session registered with Tau gateway/);
  }, 30000);

  afterAll(async () => {
    for (const proc of children.reverse()) {
      if (proc.exitCode !== null || proc.signalCode !== null) continue;
      const exited = once(proc, "exit");
      proc.stdin?.end();
      await exited;
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("lists a short answered session but keeps empty and unanswered sessions hidden", async () => {
    const result = await fetch(`${base}/api/sessions`).then(response => response.json());
    const ids = result.projects.flatMap((project: { sessions: { id: string }[] }) => project.sessions.map(session => session.id));
    expect(ids).toContain("short");
    expect(ids).not.toContain("empty");
    expect(ids).not.toContain("unanswered");
    expect(ids).not.toContain("assistant-only");
  });

  test("registers a large peer and selects a bounded snapshot over IPC", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    try {
      const snapshot = await new Promise<{ entries: unknown[]; history: { before: number } }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Snapshot signal missing")), 10000);
        ws.addEventListener("message", event => {
          const message = JSON.parse(String(event.data));
          if (message.type === "state") ws.send(JSON.stringify({ type: "select_session", id: "select", sessionFile: largeFile }));
          if (message.type === "mirror_sync") { clearTimeout(timeout); resolve(message); }
        });
        ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
      });
      expect(snapshot.entries.length).toBe(HISTORY_PAGE_ENTRIES);
      expect(snapshot.history.before).toBe(121);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(HISTORY_PAGE_BYTES + 4096);
    } finally {
      ws.close();
    }
  });

  test("keeps todo and question state alongside paged history in a selected snapshot", async () => {
    // Given a session with answered history and a canonical todo record.
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    try {
      // When the gateway acknowledges selection with the real extension snapshot.
      const snapshot = await new Promise<{
        entries: unknown[];
        history: { before: number | null };
        todoState: unknown;
        pendingQuestions: unknown[];
        questionControl: { supported: boolean };
      }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Snapshot signal missing")), 10000);
        ws.addEventListener("message", event => {
          const message = JSON.parse(String(event.data));
          if (message.type === "state") ws.send(JSON.stringify({ type: "select_session", id: "select-todo", sessionFile: shortFile }));
          if (message.type === "mirror_sync") { clearTimeout(timeout); resolve(message); }
        });
        ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
      });
      // Then all three features retain their machine-consumed snapshot fields.
      expect(snapshot.entries.length).toBe(3);
      expect(snapshot.history.before).toBeNull();
      expect(snapshot.todoState).toEqual(todoState);
      expect(snapshot.pendingQuestions).toEqual([]);
      expect(snapshot.questionControl.supported).toBe(false);
    } finally {
      ws.close();
    }
  });

  test("omits only terminal executions whose call and result are both in the selected page", async () => {
    // Given persisted results plus live execution state in a real peer.
    const host = children.at(-1);
    if (!host?.stdin) throw new Error("Missing tool fixture input");
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    const next = (predicate: (message: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.removeEventListener("message", receive);
          reject(new Error("Tool fixture signal missing"));
        }, 10000);
        const receive = (event: MessageEvent) => {
          const message: Record<string, unknown> = JSON.parse(String(event.data));
          if (!predicate(message)) return;
          clearTimeout(timeout);
          ws.removeEventListener("message", receive);
          resolve(message);
        };
        ws.addEventListener("message", receive);
      });
    try {
      await next(message => message.type === "state");
      const initial = next(message => message.type === "mirror_sync");
      ws.send(JSON.stringify({ type: "select_session", id: "tools-initial", sessionFile: toolsFile }));
      await initial;
      for (const id of ["complete", "failed", "pending", "streaming", "uncommitted", "paged-call", "paged-result", "result-only"]) {
        const start = next(message => message.type === "event" &&
          JSON.stringify(message.event).includes(`"toolCallId":"${id}"`));
        host.stdin.write(JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} }) + "\n");
        await start;
        if (id === "pending") continue;
        const type = id === "streaming" ? "tool_execution_update" : "tool_execution_end";
        const done = next(message => message.type === "event" &&
          JSON.stringify(message.event).includes(`"type":"${type}"`));
        const output = { content: [{ type: "text", text: `output-${id}` }] };
        host.stdin.write(JSON.stringify({ type, toolCallId: id,
          ...(id === "streaming" ? { partialResult: output } : { result: output, isError: id === "failed" }) }) + "\n");
        await done;
      }
      // When selecting again, the real IPC response must not retransmit represented results.
      const selected = next(message => message.type === "mirror_sync" && message.id === "tools-final");
      ws.send(JSON.stringify({ type: "select_session", id: "tools-final", sessionFile: toolsFile }));
      const snapshot = await selected;
      // Then pending, uncommitted and either-side-paged-out executions remain available.
      expect(snapshot.toolExecutions).toEqual(
        ["pending", "streaming", "uncommitted", "paged-call", "paged-result", "result-only"].map(id => ({
          toolCallId: id, toolName: "bash", args: {},
          status: id === "pending" ? "pending" : id === "streaming" ? "streaming" : "complete",
          output: id === "pending" ? "" : { content: [{ type: "text", text: `output-${id}` }] },
          isError: false,
        })),
      );
    } finally {
      const closed = new Promise(resolve => ws.addEventListener("close", resolve, { once: true }));
      ws.close();
      await closed;
    }
  });

  test("paginates HTTP history in order without returning archives", async () => {
    let before: number | null = null;
    let all: { id: number }[] = [];
    do {
      const suffix: string = before === null ? "" : `?before=${before}`;
      const response = await fetch(`${base}/api/sessions/project/large.jsonl${suffix}`);
      expect(response.status).toBe(200);
      const page = await response.json();
      expect(page.entries.length).toBeLessThanOrEqual(HISTORY_PAGE_ENTRIES);
      expect(JSON.stringify(page).length).toBeLessThan(HISTORY_PAGE_BYTES);
      all = [...page.entries, ...all];
      before = page.history.before;
    } while (before !== null);
    expect(all.map(entry => entry.id)).toEqual(Array.from({ length: 200 }, (_, id) => id));
  });

  test("rejects malformed HTTP history cursors", async () => {
    const response = await fetch(`${base}/api/sessions/project/large.jsonl?before=-1`);
    expect(response.status).toBe(400);
  });
});
