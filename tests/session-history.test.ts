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
});

describe("real Tau HTTP and IPC boundaries", () => {
  let root: string;
  let base: string;
  let shortFile: string;
  let largeFile: string;
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
    await save("short", [header("short"), user, reply]);
    await save("empty", [header("empty")]);
    await save("unanswered", [header("unanswered"), user]);
    await save("assistant-only", [header("assistant-only"), reply]);
    await save("large", [
      header("large"),
      { type: "custom", customType: "opencode.source-message", data: "x".repeat(70 * 1024 * 1024) },
      ...Array.from({ length: 200 }, (_, id) => ({ type: "message", id, message: user.message })),
    ]);
    shortFile = path.join(dir, "short.jsonl");
    largeFile = path.join(dir, "large.jsonl");
    const ready = await launch(shortFile, /QA_READY/);
    base = `http://127.0.0.1:${ready.split(" ").pop()}`;
    await launch(largeFile, /Session registered with Tau gateway/);
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
