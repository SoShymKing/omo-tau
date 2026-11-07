import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { observeAgents } from "../extensions/agents-state";
import type { AgentsSnapshot } from "../extensions/agents-types";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const row = { task_id: "A", child_session_id: "C", model: "mock", status: "running",
  residency_state: "resident", depth: 1, created_at: "", updated_at: "" };
function harness() {
  let owner = { sessionId: "R", file: "A", epoch: "one" };
  let emit: (event: unknown) => void = () => {};
  const frames: AgentsSnapshot[] = [];
  const observer = observeAgents({ on(_name, listener) { emit = listener; return () => {}; } },
    () => owner, state => frames.push(state));
  observer.bind(owner);
  return { frames, observer, emit,
    bind(next: typeof owner) { owner = next; observer.bind(owner); },
    task(marker: number, parent = "R") { emit({ name: "omo.task.updated", data: {
      parent_session_id: parent, tasks: [{ ...row, task_summary: String(marker) }] } }); },
    dag(marker: number) { emit({ name: "omo.dag.updated", data: { parent_session_id: "R", runs: [{
      run_id: "run", run_key: "key", name: String(marker), status: "running", created_at: "", updated_at: "",
      counts: {}, nodes: [], edges: [], waves: [],
    }] } }); } };
}

test("1000 mixed replacements retain the final marker in at most ten combined frames; identical replay adds zero", () => {
  const h = harness();
  for (let index = 0; index < 1000; index++) {
    if (index % 2) h.dag(index);
    else h.task(index);
    jest.advanceTimersByTime(2);
  }
  expect(h.observer.snapshot().dagState).toMatchObject({ runs: [{ name: "999" }] });
  jest.advanceTimersByTime(250);
  expect(h.frames.length).toBeLessThanOrEqual(10);
  expect(h.frames.at(-1)?.agentsState).toMatchObject({ tasks: [{ task_summary: "998" }] });
  expect(h.frames.at(-1)?.dagState).toMatchObject({ runs: [{ name: "999" }] });
  const count = h.frames.length;
  for (let index = 0; index < 1000; index++) {
    if (index % 2) h.dag(999); else h.task(998);
    jest.advanceTimersByTime(2);
  }
  jest.advanceTimersByTime(250);
  expect(h.frames).toHaveLength(count);
  h.observer.shutdown();
});

test("snapshot reads update immediately; owner/file/epoch A/B/A and shutdown cancel old publications", () => {
  const h = harness();
  h.task(1);
  expect(h.observer.snapshot().agentsState).toMatchObject({ tasks: [{ task_summary: "1" }] });
  expect(h.frames).toHaveLength(0);
  h.bind({ sessionId: "B", file: "B", epoch: "two" });
  h.bind({ sessionId: "R", file: "A", epoch: "one" });
  jest.advanceTimersByTime(250);
  expect(h.frames).toHaveLength(0);
  expect(h.observer.snapshot().agentsState.availability).toBe("unknown");
  h.task(2);
  h.observer.shutdown();
  jest.advanceTimersByTime(250);
  expect(h.frames).toHaveLength(0);
});

test("incoming Tau proof is stripped and bad graph envelopes preserve the last good channel", () => {
  const h = harness();
  h.emit({ name: "omo.task.updated", data: { parent_session_id: "R", tasks: [{
    ...row, tau_ancestry: { relation: "direct", parent_task_id: "forged", evidence: "record" },
  }] } });
  expect(h.observer.snapshot().agentsState).toMatchObject({ tasks: [
    { tau_ancestry: { relation: "unresolved", evidence: "unavailable" } },
  ] });
  h.dag(1);
  const before = h.observer.snapshot().dagState;
  h.emit({ name: "omo.dag.updated", data: { parent_session_id: "R", runs: [{ nodes: [null] }] } });
  expect(h.observer.snapshot().dagState).toEqual(before);
  h.observer.shutdown();
});

test("1000 mixed root and proven child observations obey the same combined frame ceiling", () => {
  const h = harness();
  h.task(0);
  jest.advanceTimersByTime(250);
  const baseline = h.frames.length;
  for (let index = 0; index < 1000; index++) {
    if (index % 4 === 0) h.task(index);
    else if (index % 4 === 1) h.emit({ name: "omo.task.updated", data: { parent_session_id: "C",
      tasks: [{ ...row, task_id: "child", child_session_id: "", task_summary: String(index) }] } });
    else if (index % 4 === 2) h.dag(index);
    else h.emit({ name: "omo.dag.updated", data: { parent_session_id: "C", runs: [{
      run_id: "child-run", run_key: "key", name: String(index), status: "running", created_at: "", updated_at: "",
      counts: {}, nodes: [], edges: [], waves: [],
    }] } });
    jest.advanceTimersByTime(2);
  }
  jest.advanceTimersByTime(250);
  expect(h.frames.length - baseline).toBeLessThanOrEqual(10);
  expect(h.frames.at(-1)?.dagState).toMatchObject({ runs: [
    { name: "998", tau_owner_session_id: "R" }, { name: "999", tau_owner_session_id: "C" },
  ] });
  h.observer.shutdown();
});

test("graph structural ceilings reject atomically while valid cyclic and missing-dependency graphs survive", () => {
  const h = harness();
  const graph = { run_id: "run", run_key: "key", name: "bounded", status: "running", created_at: "", updated_at: "",
    counts: {}, nodes: Array.from({ length: 1024 }, (_, index) => ({
      id: String(index), prompt: "", state: "running", depends_on: [String(index)], attempt: 0, created_at: "",
    })), edges: Array.from({ length: 4096 }, () => ({ from: "missing", to: "0" })), waves: [] };
  h.emit({ name: "omo.dag.updated", data: { parent_session_id: "R", runs: [graph] } });
  expect(h.observer.snapshot().dagState).toMatchObject({ availability: "ready", runs: [{ name: "bounded" }] });
  for (const oversized of [{ ...graph, nodes: [...graph.nodes, { ...graph.nodes[0], id: "extra" }] },
    { ...graph, edges: [...graph.edges, { from: "0", to: "1" }] }]) {
    h.emit({ name: "omo.dag.updated", data: { parent_session_id: "R", runs: [{ ...oversized, name: "rejected" }] } });
    expect(h.observer.snapshot().dagState).toMatchObject({
      runs: [{ name: "bounded" }], coverage: { issues: ["oversize"] },
    });
  }
  h.observer.shutdown();
});
