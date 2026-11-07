import { describe, expect, test } from "bun:test";
import { createMembership } from "../extensions/agents-membership";
import type { RecordTask, Task } from "../extensions/agents-types";

const task = (id: string, child?: string): Task => ({ task_id: id, model: "mock", status: "running",
  residency_state: "resident", depth: 1, created_at: "now", updated_at: "now",
  ...(child ? { child_session_id: child } : {}) });
const run = (id: string) => ({ run_id: id, run_key: id, name: id, status: "running",
  created_at: "now", updated_at: "now", counts: {}, nodes: [], edges: [], waves: [] });
const record = (row: Task, parent = "R", root = "R"): RecordTask => ({ task: row, parent, root });
function harness(root = "R") {
  const state = createMembership(root);
  return { state,
    tasks: (owner: string, rows: readonly Task[]) => state.update({ owner, channel: "tasks", rows, truncated: 0 }),
    runs: (owner: string, ids: readonly string[]) => state.update({ owner, channel: "runs", rows: ids.map(run), truncated: 0 }),
    records: (tasks: readonly RecordTask[]) => state.recover({ tasks, runs: [], issues: [] }),
    ids: () => {
      const snapshot = state.snapshot();
      return { tasks: "tasks" in snapshot.agentsState ? snapshot.agentsState.tasks.map(row => row.task_id) : [],
        runs: "runs" in snapshot.dagState ? snapshot.dagState.runs.map(row => row.run_id) : [] };
    } };
}

describe("current branch membership", () => {
  test("a root replacement cuts old child copies; only a fresh reachable observation can restore them", () => {
    const h = harness();
    const a = task("A", "C");
    const b = task("B");
    h.tasks("R", [a, b]);
    h.tasks("C", [{ ...b, model: "new" }]);
    h.runs("C", ["child"]);
    h.tasks("R", [a]);
    h.records([record(a), record(b, "C")]);
    expect(h.ids()).toEqual({ tasks: ["A"], runs: [] });
    expect(h.tasks("C", [b])).toBe(true);
    expect(h.ids().tasks).toEqual(["A", "B"]);
    h.tasks("R", []);
    expect(h.tasks("C", [b])).toBe(false);
    expect(h.runs("C", ["late"])).toBe(false);
    h.tasks("R", [a]);
    expect(h.ids()).toEqual({ tasks: ["A"], runs: [] });
    h.tasks("C", [b]);
    expect(h.ids().tasks).toEqual(["A", "B"]);
  });
  test("nested task cuts retire both channels while DAG cuts retain task evidence", () => {
    const h = harness();
    h.tasks("R", [task("A", "C")]);
    h.tasks("C", [task("B", "D")]);
    h.tasks("D", [task("E")]);
    h.runs("D", ["deep"]);
    h.runs("C", []);
    expect(h.ids()).toEqual({ tasks: ["A", "B", "E"], runs: [] });
    h.runs("D", ["fresh"]);
    h.tasks("C", []);
    expect(h.ids()).toEqual({ tasks: ["A"], runs: [] });
    expect(h.tasks("D", [task("late")])).toBe(false);
    h.runs("R", ["root"]);
    h.tasks("R", []);
    expect(h.ids()).toEqual({ tasks: [], runs: ["root"] });
  });
  test("unknown child events are discarded and reused edges require fresh observations", () => {
    const h = harness();
    expect(h.tasks("C", [task("lost")])).toBe(false);
    h.tasks("R", [task("A", "C")]);
    expect(h.ids().tasks).toEqual(["A"]);
    h.tasks("C", [task("accepted")]);
    h.tasks("R", [task("A", "D")]);
    h.tasks("R", [task("A", "C")]);
    expect(h.ids().tasks).toEqual(["A"]);
    expect(h.tasks("C", [task("new")])).toBe(true);
  });
  test("durable paths prove directness and parent edges without overriding live fields", () => {
    const h = harness();
    const a = task("A", "C");
    const b = task("B", "D");
    h.records([record(b, "C"), record(a)]);
    expect(h.state.accepts("D")).toBe(true);
    h.tasks("C", [{ ...b, model: "live" }]);
    expect(h.state.snapshot().agentsState).toMatchObject({ availability: "ready", tasks: [
      { task_id: "B", model: "live", tau_ancestry: { relation: "descendant", parent_task_id: "A", evidence: "record" } },
    ] });
    h.tasks("R", [a, b]);
    expect(h.state.snapshot().agentsState).toMatchObject({ tasks: [
      { task_id: "A", tau_ancestry: { relation: "direct", evidence: "record" } },
      { task_id: "B", tau_ancestry: { parent_task_id: "A" } },
    ] });
  });
  test("a reachable envelope proves membership but cannot invent immediate parentage", () => {
    const h = harness();
    h.tasks("R", [task("A", "C")]);
    h.tasks("C", [task("B")]);
    expect(h.state.snapshot().agentsState).toMatchObject({ tasks: [
      { tau_ancestry: { relation: "unresolved", evidence: "unavailable" } },
      { tau_ancestry: { relation: "unresolved", evidence: "unavailable" } },
    ] });
  });
  test("duplicate child claims and root conflicts never admit a foreign child", () => {
    const h = harness();
    h.tasks("R", [task("A", "C"), task("B", "C")]);
    expect(h.tasks("C", [task("bad")])).toBe(false);
    expect(h.state.snapshot().agentsState.coverage?.issues).toContain("ancestry-conflict");
    const other = harness();
    other.records([record(task("A", "C"), "R", "foreign"), record(task("B"), "C", "different")]);
    expect(other.state.accepts("C")).toBe(true);
    expect(other.ids().tasks).toEqual(["A"]);
  });
  test("unrelated session records are excluded without reporting an ownership conflict", () => {
    const h = harness();
    h.records([record(task("own")), record(task("other"), "foreign", "foreign")]);
    const snapshot = h.state.snapshot();
    expect(h.ids().tasks).toEqual(["own"]);
    expect(snapshot.agentsState.coverage?.issues ?? []).not.toContain("ancestry-conflict");
  });
  test("non-root viewing rejects unrelated siblings and cycles are bounded", () => {
    const h = harness("C");
    h.records([record(task("own"), "C", "R"), record(task("sibling"), "D", "R")]);
    expect(h.ids().tasks).toEqual(["own"]);
    const cycle = harness();
    cycle.tasks("R", [task("A", "C")]);
    cycle.tasks("C", [task("B", "R")]);
    expect(cycle.state.snapshot().agentsState.coverage?.issues).toContain("ancestry-cycle");
    expect(cycle.state.accepts("foreign")).toBe(false);
  });
  test("newest task observations win while conflicting run ownership suppresses a run", () => {
    const h = harness();
    h.tasks("R", [task("A", "C"), task("B")]);
    h.tasks("C", [{ ...task("B"), model: "newest" }]);
    h.runs("R", ["collision"]);
    h.runs("C", ["collision"]);
    expect(h.ids()).toEqual({ tasks: ["A", "B"], runs: [] });
    expect(h.state.snapshot().agentsState).toMatchObject({ tasks: [{ task_id: "A" }, { model: "newest" }] });
    expect(h.state.snapshot().dagState.coverage?.issues).toContain("ancestry-conflict");
    h.runs("C", ["unique"]);
    expect(h.state.snapshot().dagState).toMatchObject({ runs: [
      { run_id: "collision", tau_owner_session_id: "R" }, { run_id: "unique", tau_owner_session_id: "C" },
    ] });
  });
  test("global rows, sessions and serialized bytes reject atomically without cutting children", () => {
    const h = harness();
    h.tasks("R", [task("A", "C")]);
    h.tasks("C", [task("B")]);
    expect(h.tasks("R", Array.from({ length: 257 }, (_, index) => task(`T${index}`)))).toBe(false);
    expect(h.ids().tasks).toEqual(["A", "B"]);
    expect(h.tasks("R", [{ ...task("large"), description: "x".repeat(8 * 1024 * 1024) }])).toBe(false);
    expect(h.ids().tasks).toEqual(["A", "B"]);
    expect(h.tasks("R", Array.from({ length: 256 }, (_, index) => task(`T${index}`, `C${index}`)))).toBe(false);
    expect(h.ids().tasks).toEqual(["A", "B"]);
  });
  test("256 recovered identities can become ready while retaining ancestry metadata for the same IDs", () => {
    const h = harness();
    const rows = Array.from({ length: 256 }, (_, index) => task(`T${index}`));
    h.records(rows.map(row => record(row)));
    expect(h.tasks("R", rows)).toBe(true);
    expect(h.state.snapshot().agentsState.availability).toBe("ready");
    expect(h.ids().tasks).toHaveLength(256);
  });
  test("missing durable paths cannot create child reachability and disconnected cycles have no parent edges", () => {
    const h = harness();
    h.records([record(task("missing", "child"), "absent")]);
    h.tasks("R", [task("missing", "child")]);
    expect(h.state.accepts("child")).toBe(false);
    expect(h.state.snapshot().agentsState).toMatchObject({ tasks: [
      { tau_ancestry: { relation: "unresolved", evidence: "unavailable" } },
    ] });
    const cycle = harness();
    cycle.records([record(task("A", "C"), "D"), record(task("B", "D"), "C")]);
    expect(cycle.ids().tasks).toEqual([]);
    expect(cycle.state.snapshot().agentsState.coverage?.issues).toContain("ancestry-cycle");
  });
  test("ancestry depth stops at 64 sessions even with reverse record order", () => {
    const h = harness();
    h.records(Array.from({ length: 65 }, (_, index) =>
      record(task(`T${index}`, `C${index + 1}`), index === 0 ? "R" : `C${index}`)).reverse());
    expect(h.state.accepts("C64")).toBe(true);
    expect(h.state.accepts("C65")).toBe(false);
    expect(h.state.snapshot().agentsState.coverage?.issues).toContain("budget");
  });
  test("new durable conflicts evict old child contributions and root run ordering stays first", () => {
    const h = harness();
    const a = task("A", "C");
    h.records([record(a)]);
    h.runs("C", ["child"]);
    h.runs("R", ["root"]);
    h.runs("C", ["child"]);
    expect(h.ids().runs).toEqual(["root", "child"]);
    h.records([record(a, "unreachable")]);
    expect(h.ids().runs).toEqual(["root"]);
    h.records([record(a)]);
    expect(h.ids().runs).toEqual(["root"]);
    expect(h.runs("C", ["fresh"])).toBe(true);
    expect(h.ids().runs).toEqual(["root", "fresh"]);
  });
});
