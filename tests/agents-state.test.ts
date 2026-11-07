import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { observeAgents } from "../extensions/agents-state";

const owner = { sessionId: "parent", file: "/synthetic/parent.jsonl", epoch: "epoch-a" };
const task = {
  task_id: "st_a", model: "mock/worker", status: "running", residency_state: "resident",
  depth: 1, created_at: "2026-11-07T00:00:00Z", updated_at: "2026-11-07T00:00:01Z",
};
const dag = {
  run_id: "run-a", run_key: "key-a", name: "Inspect", status: "running",
  created_at: task.created_at, updated_at: task.updated_at,
  counts: { total: 1, pending: 0, blocked: 0, scheduled: 0, running: 1,
    completed: 0, failed: 0, cancelled: 0, skipped: 0 },
  nodes: [{ id: "inspect", prompt: "Read", state: "running", depends_on: [], attempt: 1,
    created_at: task.created_at, task_id: "st_a" }] as const,
  edges: [], waves: [{ index: 0, node_ids: ["inspect"] }],
};

function harness() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  let current: typeof owner | null = null;
  const published: unknown[] = [];
  const observer = observeAgents({
    on(name, listener) {
      const handlers = listeners.get(name) ?? new Set();
      handlers.add(listener);
      listeners.set(name, handlers);
      return () => { handlers.delete(listener); };
    },
  }, () => current, value => published.push(value));
  return {
    observer, listeners, published,
    current(value: typeof owner | null) { current = value; },
    bind(value = owner) { current = value; observer.bind(value); },
    emit(value: unknown) {
      for (const listener of listeners.get("senpi:extension-rpc-event") ?? []) listener(value);
      jest.advanceTimersByTime(250);
    },
  };
}
function tasks<T>(rows: readonly T[], parent = owner.sessionId) {
  return { name: "omo.task.updated", data: { parent_session_id: parent, tasks: rows } };
}
function runs<T>(rows: readonly T[], parent = owner.sessionId) {
  return { name: "omo.dag.updated", data: { parent_session_id: parent, runs: rows } };
}
function readyTasks<T>(rows: readonly T[], truncated = 0) {
  return { availability: "ready" as const, parent_session_id: owner.sessionId,
    tasks: rows.map(row => ({ ...row, tau_ancestry: { relation: "unresolved", evidence: "unavailable" } })),
    ...(truncated ? { truncated_tasks: truncated } : {}),
    ...(rows.length || truncated ? { coverage: { incomplete: true,
      issues: [...(rows.length ? ["ancestry-unresolved"] : []), ...(truncated ? ["producer-truncated"] : [])] } } : {}) };
}
function readyRuns<T>(rows: readonly T[], truncated = 0) {
  return { availability: "ready" as const, parent_session_id: owner.sessionId,
    runs: rows.map(row => ({ ...row, tau_owner_session_id: owner.sessionId })),
    ...(truncated ? { truncated_runs: truncated, coverage: { incomplete: true, issues: ["producer-truncated"] } } : {}) };
}

describe("owner fenced agents observation", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  test("captures task and DAG emissions before session_start and replays matching owner", () => {
    const h = harness();
    h.emit(tasks([task]));
    h.emit(runs([dag]));
    h.emit(tasks([], "foreign"));
    h.bind();
    expect(h.observer.snapshot()).toEqual({
      agentsState: readyTasks([task]),
      dagState: readyRuns([dag]),
    });
    expect(h.published).toEqual([]);
    h.observer.shutdown();
  });

  test("initial snapshot distinguishes unknown from ready empty and unsupported", () => {
    const h = harness();
    h.bind();
    expect(h.observer.snapshot()).toMatchObject({
      agentsState: { availability: "unknown", parent_session_id: "parent" },
      dagState: { availability: "unknown", parent_session_id: "parent" },
    });
    h.emit(tasks([]));
    expect(h.observer.snapshot()).toMatchObject({
      agentsState: { availability: "ready", tasks: [] }, dagState: { availability: "unknown" },
    });
    h.emit(runs([]));
    expect(h.observer.snapshot()).toEqual({
      agentsState: { availability: "ready", ...tasks([]).data },
      dagState: { availability: "ready", ...runs([]).data },
    });
    h.observer.shutdown();
  });

  test.each([
    null, {}, { name: "omo.task.list", data: tasks([]).data }, tasks([], "foreign"),
    tasks([], " "), tasks([null]), tasks([{ ...task, task_id: "" }]),
    tasks([{ ...task, status: "unknown" }]), tasks([{ ...task, depth: -1 }]),
    tasks([{ ...task, model: {} }]), tasks([{ ...task, task_summary: {} }]),
    tasks([{ ...task, task_summary: () => "malformed" }]),
    tasks([{ ...task, effective_model: 42 }]), tasks([{ ...task, live_progress: {} }]),
    tasks([task, task]), { name: "omo.task.updated", data: { parent_session_id: "parent", tasks: {} } },
    { name: "omo.task.updated", data: { ...tasks([]).data, truncated_tasks: -1 } },
    runs([], "foreign"), runs([{}]), runs([{ ...dag, nodes: [{}] }]),
    runs([{ ...dag, edges: [{ from: "inspect", to: null }] }]),
    runs([{ ...dag, waves: [{ index: 0, node_ids: [3] }] }]),
    runs([{ ...dag, counts: { total: "one" } }]), runs([dag, dag]),
    { name: "omo.dag.updated", data: { ...runs([]).data, truncated_runs: "2" } },
  ])("rejects foreign owner and malformed replacement without clearing valid state (%#)", replacement => {
    const h = harness();
    h.bind();
    h.emit(tasks([task]));
    h.emit(runs([dag]));
    const before = h.observer.snapshot();
    h.emit(replacement);
    expect(h.observer.snapshot()).toEqual(before);
    expect(h.published).toHaveLength(2);
    h.observer.shutdown();
  });

  test("replaces whole lists and preserves optional fields and truncation counts", () => {
    const h = harness();
    h.bind();
    h.emit(tasks([task, { ...task, task_id: "st_removed" }]));
    const projected = { ...task, task_summary: "Latest", description_truncated: true,
      effective_model: { provider: "mock", model_id: "new", display: "mock/new", source: "set" },
      run_stats: { output_tokens: 12 }, live_progress: { activity: "reading", started_at: 1, turns: 2 } };
    const run = { ...dag, completed_at: task.updated_at, amend_count: 3, lease_holder_pid: 101,
      counts: { ...dag.counts, paused: 1 }, nodes: [{ ...dag.nodes[0],
        label: "Reader", started_at: task.created_at, completed_at: task.updated_at,
        last_error: { code: "failed", message: "Try again" } }] };
    h.emit({ name: "omo.task.updated", data: { ...tasks([projected]).data, truncated_tasks: 7 } });
    h.emit({ name: "omo.dag.updated", data: { ...runs([run]).data, truncated_runs: 2 } });
    expect(h.observer.snapshot()).toEqual({
      agentsState: readyTasks([projected], 7),
      dagState: readyRuns([run], 2),
    });
    h.emit(tasks([task]));
    h.emit(runs([dag]));
    expect(h.observer.snapshot()).toEqual({
      agentsState: readyTasks([task]),
      dagState: readyRuns([dag]),
    });
    h.observer.shutdown();
  });

  test("session switch and shutdown reject retired owner and remove listener", () => {
    const h = harness();
    h.bind();
    h.emit(tasks([task]));
    const next = { sessionId: "next", file: "/synthetic/next.jsonl", epoch: "epoch-b" };
    h.current(next);
    h.emit(tasks([]));
    expect(h.observer.snapshot().agentsState).toMatchObject({ availability: "unknown", parent_session_id: "next" });
    h.bind(next);
    h.emit(tasks([], "parent"));
    h.emit(tasks([], "next"));
    expect(h.observer.snapshot().agentsState).toEqual({ availability: "ready", parent_session_id: "next", tasks: [] });
    h.observer.shutdown();
    h.emit(tasks([task], "next"));
    expect(h.published).toHaveLength(2);
    expect(h.listeners.get("senpi:extension-rpc-event")?.size).toBe(0);
    expect(h.observer.snapshot().agentsState.availability).toBe("unknown");
  });

  test.each([
    { ...owner, file: "/synthetic/replaced.jsonl" }, { ...owner, epoch: "retired" }, null,
  ])("rejects observations when the bound file or epoch retires (%#)", current => {
    const h = harness();
    h.bind();
    h.emit(tasks([task]));
    h.current(current);
    h.emit(tasks([]));
    expect(h.observer.snapshot().agentsState.availability).toBe("unknown");
    expect(h.published).toHaveLength(1);
    h.observer.shutdown();
  });

  test("bounds pending owners and never reuses pre-start foreign history after binding", () => {
    const h = harness();
    for (let index = 0; index < 10; index++) h.emit(tasks([], `owner-${index}`));
    h.bind({ ...owner, sessionId: "owner-0" });
    expect(h.observer.snapshot().agentsState.availability).toBe("unknown");
    h.bind({ ...owner, sessionId: "owner-9" });
    expect(h.observer.snapshot().agentsState.availability).toBe("unknown");
    h.observer.shutdown();
  });

  test("bounds pending payload bytes without evicting the last valid observation", () => {
    const h = harness();
    h.emit(tasks([]));
    h.emit(tasks([{ ...task, description: "x".repeat(8 * 1024 * 1024) }]));
    h.bind();
    expect(h.observer.snapshot().agentsState).toEqual({ availability: "ready", ...tasks([]).data });
    h.observer.shutdown();
  });

  test("accepted snapshots cannot be mutated by a later producer write", () => {
    const h = harness();
    h.bind();
    const row = { ...task, live_progress: { activity: "reading", started_at: 1, turns: 1 } };
    h.emit(tasks([row]));
    row.live_progress.turns = 999;
    expect(h.observer.snapshot().agentsState).toMatchObject({
      tasks: [{ live_progress: { turns: 1 } }],
    });
    h.observer.shutdown();
  });
});
