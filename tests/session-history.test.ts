import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFile, mkdtemp, mkdir, open, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import {
  HistoryWindow, HistoryCursorError, HISTORY_PAGE_BYTES, HISTORY_PAGE_ENTRIES,
  readHistoryPage, resolveSnapshotHistory,
} from "../extensions/session-history";

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

describe("reverse file history", () => {
  let directory: string;
  let filename: string;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const record = (id: number) => ({ type: "message", id, message: { role: "user", content: `Question ${id}` } });
  async function save(records: readonly unknown[], suffix = "") {
    await writeFile(filename, [
      { type: "session", id: "reverse" }, ...records,
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n" + suffix);
    file = await open(filename, "r+");
    return file;
  }
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tau-reverse-history-"));
    filename = path.join(directory, "history.jsonl");
  });
  afterEach(async () => {
    await file?.close();
    file = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  test("reads only the suffix and resumes below the previous byte boundary", async () => {
    // Given a large old prefix that does not belong to either requested page.
    const records = [
      { type: "custom", customType: "opencode.source-message", data: "x".repeat(4 * HISTORY_PAGE_BYTES) },
      ...Array.from({ length: 200 }, (_, id) => record(id)),
    ];
    const handle = await save(records);
    const reads = spyOn(handle, "read");
    try {
      // When reading the latest page and one continuation.
      const first = await readHistoryPage(handle);
      const firstPositions = reads.mock.calls.map(call => call.at(-1));
      reads.mockClear();
      const second = await readHistoryPage(handle, first.history.before ?? undefined);
      const secondPositions = reads.mock.calls.map(call => call.at(-1));
      const boundary = first.history.offsets[0];
      if (typeof boundary !== "number") throw new Error("Missing saved boundary");
      // Then neither request parses the old prefix, and continuation reads only below its boundary.
      expect(first.entries).toEqual(records.slice(-80));
      expect(second.entries).toEqual(records.slice(-160, -80));
      expect(firstPositions.every(position => typeof position === "number" && position > 3 * HISTORY_PAGE_BYTES)).toBe(true);
      expect(secondPositions.every(position => typeof position === "number" && position < boundary)).toBe(true);
    } finally {
      reads.mockRestore();
    }
  });

  test("pages oversized UTF-8 records and ignores an incomplete trailing write", async () => {
    // Given a single record spanning many read blocks and exceeding the response budget.
    const records = [record(0), {
      type: "message", message: { role: "assistant", content: [{ type: "text", text: "한😀".repeat(220000) }] },
    }, record(2)];
    const handle = await save(records, '{"type":"message","message":');
    // When reading the complete frozen history.
    let before: string | undefined;
    let all: unknown[] = [];
    do {
      const page = await readHistoryPage(handle, before);
      all = [...page.entries, ...all];
      const next = page.history.before;
      expect(next).not.toBe(before);
      before = next ?? undefined;
    } while (before !== undefined);
    // Then complete records, including the multibyte payload, appear exactly once.
    expect(all).toEqual(records);
  });

  test("returns no cursor for an empty file", async () => {
    // Given an empty file rather than a JSONL header.
    await writeFile(filename, "");
    file = await open(filename, "r");
    // When reading from EOF.
    const page = await readHistoryPage(file);
    // Then there is no older content to request.
    expect({ entries: page.entries, before: page.history.before, offsets: page.history.offsets })
      .toEqual({ entries: [], before: null, offsets: [] });
  });

  test("keeps a continuation frozen while new records are appended", async () => {
    // Given a cursor captured before another append.
    const records = Array.from({ length: 100 }, (_, id) => record(id));
    const handle = await save(records);
    const first = await readHistoryPage(handle);
    await appendFile(filename, JSON.stringify(record(100)) + "\n");
    // When continuing the old observation.
    const older = await readHistoryPage(handle, first.history.before ?? undefined);
    // Then it joins the old page without duplicates or the later record.
    expect([...older.entries, ...first.entries]).toEqual(records);
    expect(older.history.source).toEqual(first.history.source);
  });

  test("rejects malformed cursors", async () => {
    // Given an existing history file.
    const handle = await save([record(0)]);
    // When a caller submits a malformed cursor.
    const page = readHistoryPage(handle, "-1");
    // Then it is rejected before any records are skipped.
    await expect(page).rejects.toBeInstanceOf(HistoryCursorError);
  });

  test("rejects a cursor invalidated by truncation", async () => {
    // Given a saved cursor whose file is then truncated.
    const handle = await save(Array.from({ length: 100 }, (_, id) => record(id)));
    const page = await readHistoryPage(handle);
    await handle.truncate(0);
    // When a caller submits the no-longer-valid cursor.
    const stale = readHistoryPage(handle, page.history.before ?? undefined);
    // Then errors are explicit rather than silently skipping records.
    await expect(stale).rejects.toMatchObject({ status: 409 });
  });

  test("positions repeated ID-less records and leaves the unsaved suffix unpositioned", async () => {
    // Given repeated identical entries, including the same in-memory object twice.
    const repeated = { type: "message", message: { role: "user", content: "same" } };
    const records = [repeated, repeated, record(2)];
    const handle = await save(records);
    const transient = { type: "message", message: { role: "assistant", content: [] } };
    // When projecting a bounded memory snapshot and loading before it.
    const history = await resolveSnapshotHistory(handle, records, [...records.slice(1), transient], 1);
    const older = await readHistoryPage(handle, history.before ?? undefined);
    // Then only the first repeated record is older; the uncommitted message has no disk identity.
    expect(older.entries).toEqual([repeated]);
    expect(history.offsets.at(-1)).toBeNull();
    expect(history.offsets.slice(0, 2).every(offset => typeof offset === "number")).toBe(true);
  });

  test("runtime metadata aligns saved history and continues before its transient suffix", async () => {
    const call = { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "tool", name: "read", arguments: { runtimeItemKey: "payload" } },
    ] } };
    const result = { type: "message", message: { role: "toolResult", toolCallId: "tool",
      content: [{ type: "text", text: "done" }] } };
    const saved = [record(0), call, result];
    const original = JSON.stringify(saved);
    const decorated = [saved[0], { ...call, message: { ...call.message,
      content: call.message.content.map(part => ({ ...part, runtimeItemKey: "runtime-call" })) } },
      { ...result, runtimeItemKey: "runtime-result", callUnknown: true }];
    const handle = await save(decorated);
    const transient = record(3);

    const history = await resolveSnapshotHistory(handle, saved, [call, result, transient], 1);
    const older = await readHistoryPage(handle, history.before ?? undefined);

    const start = Buffer.byteLength(JSON.stringify({ type: "session", id: "reverse" }) + "\n") +
      Buffer.byteLength(JSON.stringify(saved[0]) + "\n");
    expect(history.offsets).toEqual([start, start + Buffer.byteLength(JSON.stringify(decorated[1]) + "\n"), null]);
    expect(history.before).toEqual(expect.any(String));
    expect(older.entries).toEqual([record(0)]);
    expect(older.history.before).toBeNull();
    expect(JSON.stringify(saved)).toBe(original);
  });

  test("fails snapshot preparation when the captured saved suffix no longer aligns", async () => {
    // Given a saved memory observation followed by an unseen on-disk append.
    const records = [record(0), record(1)];
    const handle = await save(records);
    await appendFile(filename, JSON.stringify(record(2)) + "\n");
    // When resolving that stale memory observation.
    const projection = resolveSnapshotHistory(handle, records, records, null);
    // Then preparation fails explicitly instead of assigning the new row's offset to an old row.
    await expect(projection).rejects.toMatchObject({ status: 409 });
  });

  test.each(["count", "bytes"])("pages saved history before a transient-only %s boundary", async boundary => {
    // Given a saved prefix and transient messages that exceed the snapshot budget.
    const saved = [record(0), record(1)];
    const handle = await save(saved);
    const transient = boundary === "count"
      ? Array.from({ length: HISTORY_PAGE_ENTRIES + 1 }, (_, id) => record(id + 2))
      : [{ ...record(2), text: "x".repeat(HISTORY_PAGE_BYTES + 1) }];
    const page = HistoryWindow.fromEntries([...saved, ...transient], false).page();
    // When mapping that memory window to a persisted byte cursor.
    const history = await resolveSnapshotHistory(handle, saved, page.entries, page.history.before);
    const older = await readHistoryPage(handle, history.before ?? undefined);
    // Then the full saved prefix is available and transient entries have no disk offset.
    expect(older.entries).toEqual(saved);
    expect(history.offsets).toEqual(page.entries.map(() => null));
  });
});

describe("real Tau HTTP and IPC boundaries", () => {
  let root: string;
  let base: string;
  let shortFile: string;
  let largeFile: string;
  let toolsFile: string;
  let titleFile: string;
  let titleHost: ChildProcess | undefined;
  const transientHosts = new Map<string, ChildProcess>();
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
    await save("title-host", [header("title-host"), user, reply]);
    for (const boundary of ["count", "bytes", "mismatch"]) {
      await save(`transient-${boundary}`, [
        header(`transient-${boundary}`),
        { ...user, id: "saved-user" }, { ...reply, id: "saved-reply" },
      ]);
    }
    await save("late-name", [
      header("late-name"),
      ...Array.from({ length: 3 }, () => ({
        type: "message", message: { role: "user", content: "title-regression-needle" },
      })),
      reply,
      { type: "session_info", name: "Original name" },
      ...Array.from({ length: 60 }, () => ({ type: "custom", customType: "padding" })),
      { type: "session_info", name: "Summarized first request" },
      { type: "session_info", name: "User chosen title" },
    ]);
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
    titleFile = path.join(dir, "title-host.jsonl");
    const ready = await launch(shortFile, /QA_READY/);
    base = `http://127.0.0.1:${ready.split(" ").pop()}`;
    await launch(largeFile, /Session registered with Tau gateway/);
    await launch(titleFile, /Session registered with Tau gateway/);
    titleHost = children.at(-1);
    for (const boundary of ["count", "bytes", "mismatch"]) {
      await launch(path.join(dir, `transient-${boundary}.jsonl`), /Session registered with Tau gateway/);
      const host = children.at(-1);
      if (!host) throw new Error("Missing transient fixture");
      transientHosts.set(boundary, host);
    }
    const runtimeCall = { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "runtime-tool", name: "read", arguments: { runtimeItemKey: "payload" } },
    ] } };
    const runtimeResult = { type: "message", message: { role: "toolResult", toolCallId: "runtime-tool",
      content: [{ type: "text", text: "done" }] } };
    await save("runtime", [header("runtime"), user, runtimeCall, runtimeResult]);
    await launch(path.join(dir, "runtime.jsonl"), /Session registered with Tau gateway/);
    await save("runtime", [header("runtime"), user, { ...runtimeCall, message: { ...runtimeCall.message,
      content: runtimeCall.message.content.map(part => ({ ...part, runtimeItemKey: "runtime-call" })) } },
      { ...runtimeResult, runtimeItemKey: "runtime-result", callUnknown: true }]);
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

  test("lists and searches the last user input time without assistant, tool or title updates", async () => {
    // Given file activity and creation times that differ from the user's send time.
    const created = "2026-01-01T00:00:00.000Z";
    const earlier = "2026-02-01T00:00:00.000Z";
    const latest = "2026-03-01T00:00:00.000Z";
    const cases = [
      { id: "iso", entries: [{ type: "message", timestamp: latest,
        message: { role: "user", content: "last-input-needle" } }], expected: Date.parse(latest) },
      { id: "numeric", entries: [{ type: "message", timestamp: latest,
        message: { role: "user", timestamp: Date.parse(earlier), content: "last-input-needle" } }], expected: Date.parse(earlier) },
      { id: "epoch", entries: [{ type: "message", timestamp: latest,
        message: { role: "user", timestamp: 0, content: "last-input-needle" } }], expected: 0 },
      { id: "invalid", entries: [{ type: "message", timestamp: "invalid",
        message: { role: "user", timestamp: 1e30, content: "last-input-needle" } }], expected: null },
      { id: "missing", entries: [{ type: "message",
        message: { role: "user", content: "last-input-needle" } }], expected: null },
      { id: "none", entries: [], expected: null },
      { id: "tail", entries: [
        { type: "message", timestamp: earlier, message: { role: "user", content: "last-input-needle" } },
        ...Array.from({ length: 60 }, () => ({ type: "custom", customType: "padding" })),
        { type: "message", timestamp: latest, message: { role: "user", content: "last-input-needle" } },
        { type: "message", timestamp: earlier, message: { role: "user", content: "out-of-order import" } },
        { type: "message", timestamp: "invalid", message: { role: "user", content: "missing time" } },
      ], expected: Date.parse(latest) },
    ];
    for (const fixture of cases) {
      await writeFile(path.join(root, ".omo/agent/sessions/project", `input-${fixture.id}.jsonl`), [
        { type: "session", id: `input-${fixture.id}`, cwd: process.cwd(), timestamp: created },
        ...fixture.entries,
        { type: "message", timestamp: "2026-04-01T00:00:00Z", message: { role: "assistant", content: "output" } },
        { type: "message", timestamp: "2026-05-01T00:00:00Z", message: { role: "toolResult", content: "tool output" } },
        { type: "session_info", timestamp: "2026-06-01T00:00:00Z", name: "Renamed" },
        ...Array.from({ length: 9 }, () => ({ type: "custom", customType: "padding" })),
      ].map(entry => JSON.stringify(entry)).join("\n"));
    }
    // When the real list and search endpoints read their independent file scans.
    const listed = await fetch(`${base}/api/sessions`).then(response => response.json());
    const sessions = listed.projects.flatMap((project: {
      sessions: { id: string; lastUserInputAt?: number; timestamp: string }[];
    }) => project.sessions);
    const searched = await fetch(`${base}/api/search?q=last-input-needle`).then(response => response.json());
    // Then neither passive output nor later metadata can replace the user time.
    for (const fixture of cases) {
      const session = sessions.find((entry: { id: string }) => entry.id === `input-${fixture.id}`);
      expect({ input: session?.lastUserInputAt ?? null, created: session?.timestamp })
        .toEqual({ input: fixture.expected, created });
      if (fixture.id !== "none") {
        const result = searched.results.find((entry: { sessionId: string }) => entry.sessionId === `input-${fixture.id}`);
        expect(result?.lastUserInputAt ?? null).toBe(fixture.expected);
      }
    }
  });

  test("uses the latest persisted title beyond the initial history window", async () => {
    // Given several title changes after the first 50 records.
    // When listing the stored sessions.
    const result = await fetch(`${base}/api/sessions`).then(response => response.json());
    const session = result.projects.flatMap((project: { sessions: { id: string; name: string }[] }) => project.sessions)
      .find((session: { id: string }) => session.id === "late-name");
    // Then the manually chosen name wins over both the prompt and older titles.
    expect(session.name).toBe("User chosen title");
  });

  test("search keeps reading title changes after finding its maximum snippets", async () => {
    // Given three matching messages before the latest session name.
    // When searching their content.
    const result = await fetch(`${base}/api/search?q=title-regression-needle`).then(response => response.json());
    // Then the search title agrees with the list without increasing the snippet limit.
    expect(result.results.map((session: { sessionName: string; matches: unknown[] }) => ({
      name: session.sessionName, matches: session.matches.length,
    }))).toEqual([{ name: "User chosen title", matches: 3 }]);
  });

  test("leaves an unnamed session available for the host summary generator", async () => {
    // Given a new session whose host has not produced its summary title yet.
    const proc = titleHost;
    if (!proc?.stdout || !proc.stdin) throw new Error("Missing gateway fixture");
    const output = createInterface({ input: proc.stdout });
    const done = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { output.close(); reject(new Error("Missing turn acknowledgement")); }, 10000);
      output.on("line", line => {
        if (line !== "QA_EVENTS_DONE title-turns") return;
        clearTimeout(timeout);
        output.close();
        resolve();
      });
    });
    // When Tau observes tool turns during the first request.
    proc.stdin.write(JSON.stringify({ type: "qa_events", id: "title-turns", events: [
      { type: "message_start", message: { role: "user", content: "Please implement the first request instead of copying it" } },
      { type: "turn_start" }, { type: "turn_end" }, { type: "turn_start" }, { type: "turn_end" },
    ] }) + "\n");
    await done;
    // Then Tau has not persisted the prompt as a competing name.
    const result = await fetch(`${base}/api/sessions`).then(response => response.json());
    const session = result.projects.flatMap((project: { sessions: { id: string; name: string | null }[] }) => project.sessions)
      .find((session: { id: string }) => session.id === "title-host");
    expect(session.name).toBeNull();
  });

  test("publishes host title changes to clients that have not selected the session", async () => {
    // Given an unselected browser connection to the gateway.
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    try {
      const update = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Missing session title status")), 3000);
        ws.addEventListener("message", event => {
          const message = JSON.parse(String(event.data));
          if (message.type === "state") {
            titleHost?.stdin?.write(JSON.stringify({ type: "qa_events", id: "host-title", events: [
              { type: "qa_set_session_name", name: "Host summary title" },
            ] }) + "\n");
          }
          if (message.type === "session_status" && message.sessionName === "Host summary title") {
            clearTimeout(timeout);
            resolve({ file: message.sessionFile, name: message.sessionName });
          }
        });
      });
      // When the host persists and announces its summary, then all clients see it.
      expect(await update).toEqual({ file: titleFile, name: "Host summary title" });
    } finally {
      ws.close();
    }
  });

  test("registers a large peer and selects a bounded snapshot over IPC", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    try {
      const snapshot = await new Promise<{
        entries: { id: number }[];
        history: { before: string; offsets: number[] };
      }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Snapshot signal missing")), 10000);
        ws.addEventListener("message", event => {
          const message = JSON.parse(String(event.data));
          if (message.type === "state") ws.send(JSON.stringify({ type: "select_session", id: "select", sessionFile: largeFile }));
          if (message.type === "mirror_sync") { clearTimeout(timeout); resolve(message); }
        });
        ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
      });
      expect(snapshot.entries.length).toBe(HISTORY_PAGE_ENTRIES);
      expect(snapshot.history.offsets.length).toBe(HISTORY_PAGE_ENTRIES);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(HISTORY_PAGE_BYTES + 4096);
      const older = await fetch(`${base}/api/sessions/project/large.jsonl?before=${snapshot.history.before}`)
        .then(response => response.json());
      expect([...older.entries, ...snapshot.entries].map(entry => entry.id))
        .toEqual(Array.from({ length: 160 }, (_, id) => id + 40));
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
        history: { before: string | null };
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
    let before: string | null = null;
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

  test.each(["count", "bytes"])("selects a peer with a transient-only %s boundary", async boundary => {
    // Given a peer whose uncommitted suffix exceeds the snapshot budget.
    const host = transientHosts.get(boundary);
    if (!host?.stdin || !host.stdout) throw new Error("Missing transient fixture");
    const messages = boundary === "count"
      ? Array.from({ length: HISTORY_PAGE_ENTRIES + 1 }, (_, index) => ({
        role: "assistant", content: [{ type: "text", text: `transient-${index}` }], timestamp: index + 1,
      }))
      : [{ role: "assistant", content: [{ type: "text", text: "x".repeat(HISTORY_PAGE_BYTES + 1) }], timestamp: 1 }];
    const output = createInterface({ input: host.stdout });
    const delivered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { output.close(); reject(new Error("Transient events missing")); }, 10000);
      output.on("line", line => {
        if (line !== `QA_EVENTS_DONE transient-${boundary}`) return;
        clearTimeout(timer);
        output.close();
        resolve();
      });
    });
    host.stdin.write(JSON.stringify({ type: "qa_events", id: `transient-${boundary}`,
      events: messages.map(message => ({ type: "message_end", message })) }) + "\n");
    await delivered;
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    try {
      // When selecting through the real gateway/IPC path.
      const snapshot = await new Promise<{
        type: string; error?: string; entries: { message: unknown }[];
        history: { before: string; offsets: null[] };
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Transient selection missing")), 10000);
        ws.addEventListener("message", event => {
          const message = JSON.parse(String(event.data));
          if (message.type === "state") ws.send(JSON.stringify({ type: "select_session",
            id: `select-${boundary}`, sessionFile: path.join(path.dirname(shortFile), `transient-${boundary}.jsonl`) }));
          if (message.id !== `select-${boundary}`) return;
          clearTimeout(timer);
          resolve(message);
        });
      });
      // Then selection succeeds and HTTP can still retrieve the persisted prefix.
      expect(snapshot.type, snapshot.error).toBe("mirror_sync");
      expect(snapshot.entries.map(entry => entry.message)).toEqual(
        boundary === "count" ? messages.slice(-HISTORY_PAGE_ENTRIES) : [],
      );
      expect(snapshot.history.offsets).toEqual(snapshot.entries.map(() => null));
      const older = await fetch(`${base}/api/sessions/project/transient-${boundary}.jsonl?before=${snapshot.history.before}`)
        .then(response => response.json());
      expect(older.entries.map((entry: { id: string }) => entry.id)).toEqual(["saved-user", "saved-reply"]);
    } finally {
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
  });

  test("runtime metadata selects saved peer with persisted tool references", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    try {
      const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Runtime selection missing")), 10000);
        ws.addEventListener("message", event => {
          const message: Record<string, unknown> = JSON.parse(String(event.data));
          if (message.type === "state") ws.send(JSON.stringify({ type: "select_session",
            id: "runtime-select", sessionFile: path.join(path.dirname(shortFile), "runtime.jsonl"),
            view: "conversation-v1" }));
          if (message.id !== "runtime-select") return;
          clearTimeout(timer);
          resolve(message);
        });
      });
      expect(snapshot.type, String(snapshot.error ?? "")).toBe("mirror_sync");
      expect(snapshot).toMatchObject({ entries: [
        { message: { role: "user" } },
        { message: { content: [{ tool: { callRef: expect.any(String), resultRef: expect.any(String) } }] } },
        { message: { tool: { callRef: expect.any(String), resultRef: expect.any(String) } } },
      ], history: { offsets: [expect.any(Number), expect.any(Number), expect.any(Number)] } });
    } finally {
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
  });

  test("preserves a peer's snapshot failure and can select it after history aligns again", async () => {
    // Given an on-disk append that the peer has not captured in memory.
    const file = path.join(path.dirname(shortFile), "transient-mismatch.jsonl");
    const handle = await open(file, "r+");
    const size = (await handle.stat()).size;
    await appendFile(file, "\n" + JSON.stringify({ type: "message", id: "unseen" }));
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    const next = (id: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { ws.removeEventListener("message", receive); reject(new Error("Selection missing")); }, 10000);
      const receive = (event: MessageEvent) => {
        const message: Record<string, unknown> = JSON.parse(String(event.data));
        if (message.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener("message", receive);
        resolve(message);
      };
      ws.addEventListener("message", receive);
    });
    try {
      await once(ws, "open");
      const failed = next("select-mismatch");
      // When selection asks the peer to prepare its inconsistent saved snapshot.
      ws.send(JSON.stringify({ type: "select_session", id: "select-mismatch", sessionFile: file }));
      // Then the actual preparation error is returned rather than a shape-validation error.
      expect(await failed).toMatchObject({
        success: false, error: "Saved history is changing. Retry preparing the session.",
      });
      await handle.truncate(size);
      const recovered = next("select-recovered");
      ws.send(JSON.stringify({ type: "select_session", id: "select-recovered", sessionFile: file }));
      expect(await recovered).toMatchObject({ type: "mirror_sync" });
    } finally {
      await handle.truncate(size);
      await handle.close();
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
  });

  test("projects every body carrier at the peer and resolves live details explicitly", async () => {
    // Given an opted-in browser and a real peer with synthetic large tool bodies.
    const host = children.at(-1);
    if (!host?.stdin || !host.stdout) throw new Error("Missing peer");
    const output = host.stdout;
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    const received: Record<string, unknown>[] = [];
    ws.addEventListener("message", event => received.push(JSON.parse(String(event.data))));
    const next = (predicate: (message: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => { ws.removeEventListener("message", receive); reject(new Error("Peer signal missing")); }, 10000);
        const receive = (event: MessageEvent) => {
          const message: Record<string, unknown> = JSON.parse(String(event.data));
          if (!predicate(message)) return;
          clearTimeout(timer);
          ws.removeEventListener("message", receive);
          resolve(message);
        };
        ws.addEventListener("message", receive);
      });
    const control = (command: Record<string, unknown>, prefix: string) => new Promise<string>((resolve, reject) => {
      const lines = createInterface({ input: output });
      const timer = setTimeout(() => { lines.close(); reject(new Error("Peer control signal missing")); }, 10000);
      lines.on("line", line => {
        if (!line.startsWith(prefix)) return;
        clearTimeout(timer);
        lines.close();
        resolve(line);
      });
      host.stdin?.write(JSON.stringify(command) + "\n");
    });
    try {
      await next(message => message.type === "state");
      const selected = next(message => message.id === "conversation-selected");
      ws.send(JSON.stringify({ type: "select_session", id: "conversation-selected", sessionFile: toolsFile, view: "conversation-v1" }));
      expect(await selected).toMatchObject({ type: "mirror_sync", view: "conversation-v1" });
      await control({ type: "qa_wire_probe", id: "probe", needle: "PEER_BODY_SENTINEL" }, "QA_WIRE_READY probe");
      const huge = "x".repeat(300000) + "PEER_BODY_SENTINEL";
      const assistant = { role: "assistant", timestamp: 901, content: [
        { type: "toolCall", id: "lazy", name: "edit", arguments: { diff: huge } },
      ] };
      const result = { role: "toolResult", toolCallId: "lazy", timestamp: 902,
        content: [{ type: "text", text: huge }], details: { diff: huge }, isError: false };
      const events = [
        { type: "message_end", message: { role: "user", content: "transient instruction without id" } },
        { type: "tool_execution_start", toolCallId: "lazy", toolName: "edit", args: { diff: huge } },
        { type: "tool_execution_update", toolCallId: "lazy", partialResult: result },
        { type: "tool_execution_end", toolCallId: "lazy", result, isError: false },
        { type: "message_start", message: assistant },
        { type: "message_update", message: assistant, assistantMessageEvent: {
          type: "toolcall_delta", delta: huge, partial: assistant,
        } },
        { type: "message_end", message: assistant },
        { type: "message_end", message: result },
        { type: "turn_end", message: assistant, toolResults: [result] },
        { type: "agent_end", messages: [assistant, result] },
      ];
      // When all body carriers and a fresh snapshot cross actual owner IPC.
      await control({ type: "qa_events", id: "lazy-open", events: events.slice(0, 6) }, "QA_EVENTS_DONE lazy-open");
      const streaming = next(message => message.id === "conversation-streaming");
      ws.send(JSON.stringify({ type: "select_session", id: "conversation-streaming", sessionFile: toolsFile, view: "conversation-v1" }));
      expect((await streaming).streamingMessage).toMatchObject({
        role: "assistant", content: [{ type: "toolCall", id: "lazy", tool: { toolCallId: "lazy" } }],
      });
      const completed = next(message => message.type === "event" &&
        typeof message.event === "object" && message.event !== null && "type" in message.event && message.event.type === "agent_end");
      await control({ type: "qa_events", id: "lazy-events", events: events.slice(6) }, "QA_EVENTS_DONE lazy-events");
      await completed;
      const refreshed = next(message => message.id === "conversation-refreshed");
      ws.send(JSON.stringify({ type: "select_session", id: "conversation-refreshed", sessionFile: toolsFile, view: "conversation-v1" }));
      const snapshot = await refreshed;
      const report = await control({ type: "qa_wire_report", id: "probe" }, "QA_WIRE_REPORT probe ");
      const wire = JSON.parse(report.slice("QA_WIRE_REPORT probe ".length));
      // Then neither IPC nor browser metadata includes bodies; HTTP resolves the current owner.
      expect(wire.bodyFound).toBe(false);
      expect(wire.frames).toBeGreaterThanOrEqual(events.length);
      expect(wire.bytes).toBeLessThan(200000);
      expect(JSON.stringify(received)).not.toContain("PEER_BODY_SENTINEL");
      expect(snapshot.conversation).toMatchObject({ sets: expect.arrayContaining([
        expect.objectContaining({ instruction: expect.objectContaining({
          entry: { type: "message", message: { role: "user", content: "transient instruction without id" } },
          offset: null,
        }) }),
      ]) });
      if (!Array.isArray(snapshot.toolExecutions)) throw new Error("Missing summaries");
      const summary = snapshot.toolExecutions.find(tool => tool.toolCallId === "lazy");
      expect(summary).toMatchObject({ status: "complete" });
      expect(summary.revision).toBeGreaterThan(1);
      const response = await fetch(`${base}/api/tool-details`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionFile: toolsFile, toolCallId: "lazy", liveRef: summary.liveRef, mode: "view" }) });
      expect(response.status).toBe(200);
      const detail = await response.json();
      expect(detail).toMatchObject({ args: null, argsTruncated: true, outputTruncated: true, revision: summary.revision });
      const copy = await fetch(`${base}/api/tool-details`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionFile: toolsFile, toolCallId: "lazy", liveRef: summary.liveRef, mode: "copy" }) });
      expect(await copy.text()).toBe(huge);
      const mixed = await fetch(`${base}/api/tool-details`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionFile: toolsFile, toolCallId: "other", liveRef: summary.liveRef, mode: "view" }) });
      expect(mixed.status).toBe(403);
    } finally {
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
  }, 30000);

  test("pages extra live summaries explicitly and rejects an obsolete owner cursor", async () => {
    // Given more live executions than the metadata page budget.
    const host = children.at(-1);
    if (!host?.stdin || !host.stdout) throw new Error("Missing peer");
    const lines = createInterface({ input: host.stdout });
    const delivered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { lines.close(); reject(new Error("Summary fixtures missing")); }, 10000);
      lines.on("line", line => {
        if (line !== "QA_EVENTS_DONE summary-fixtures") return;
        clearTimeout(timer);
        lines.close();
        resolve();
      });
    });
    host.stdin.write(JSON.stringify({ type: "qa_events", id: "summary-fixtures", events: [
      { type: "agent_start" },
      ...Array.from({ length: 95 }, (_, index) => ({
        type: "tool_execution_start", toolCallId: `extra-${index}`, toolName: "bash", args: { command: "synthetic" },
      })),
    ] }) + "\n");
    await delivered;
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    try {
      const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Summary snapshot missing")), 10000);
        ws.addEventListener("message", event => {
          const message = JSON.parse(String(event.data));
          if (message.type === "state") ws.send(JSON.stringify({ type: "select_session", id: "extra",
            sessionFile: toolsFile, view: "conversation-v1" }));
          if (message.id === "extra") { clearTimeout(timer); resolve(message); }
        });
      });
      // When requesting the older metadata page explicitly.
      if (!snapshot.toolHistory || typeof snapshot.toolHistory !== "object" || !("before" in snapshot.toolHistory)) {
        throw new Error("Missing tool history");
      }
      const request = { sessionId: snapshot.sessionId, epoch: snapshot.epoch, before: snapshot.toolHistory.before };
      const post = (value: unknown) => fetch(`${base}/api/tool-summaries`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
      const response = await post(request);
      const older = await response.json();
      // Then the snapshot and explicit page cover all summaries without bodies.
      expect(response.status).toBe(200);
      expect(Array.isArray(snapshot.toolExecutions) ? snapshot.toolExecutions.length : 0).toBe(80);
      expect(older.toolExecutions.map((tool: { toolCallId: string }) => tool.toolCallId))
        .toEqual(Array.from({ length: 15 }, (_, index) => `extra-${index}`));
      expect(older.before).toBeNull();
      expect((await post({ ...request, epoch: "obsolete" })).status).toBe(409);
      expect((await post({ ...request, before: "bad" })).status).toBe(400);
    } finally {
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
  }, 30000);

  test("serves signed persisted details through HTTP and rejects mixed tools", async () => {
    // Given a projected history page with persisted call/result references.
    const page = await fetch(`${base}/api/sessions/project/tools.jsonl?view=conversation-v1`).then(response => response.json());
    const result = page.entries.find((entry: { message?: { role: string; toolCallId: string } }) =>
      entry.message?.role === "toolResult" && entry.message.toolCallId === "complete");
    const summary = result.message.tool;
    const request = { sessionFile: toolsFile, toolCallId: "complete", mode: "view",
      callRef: summary.callRef, resultRef: summary.resultRef };
    const post = (value: unknown) => fetch(`${base}/api/tool-details`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    // When requesting the explicit bodies from issued references.
    const response = await post(request);
    // Then useful detail fields are available and foreign identities cannot reuse refs.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ args: {}, output: "output-complete",
      argsTruncated: false, outputTruncated: false, isError: false });
    expect((await post({ ...request, toolCallId: "failed" })).status).toBe(403);
    expect((await post({ ...request, sessionFile: shortFile })).status).toBe(403);
    expect((await post({ ...request, callRef: "bad" })).status).toBe(400);
  });
});
