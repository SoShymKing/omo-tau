import { deriveMembership, type ObservedTask } from "./agents-ancestry";
import { coverage, MAX_BYTES, type AgentsSnapshot, type DagRun, type Recovery, type Task } from "./agents-types";

type Replacement<T> = { readonly rows: readonly T[]; readonly revision: number; readonly truncated: number };
type Entry = { readonly tasks?: Replacement<Task>; readonly runs?: Replacement<DagRun> };
export type Update =
  | { readonly channel: "tasks"; readonly owner: string; readonly rows: readonly Task[]; readonly truncated: number }
  | { readonly channel: "runs"; readonly owner: string; readonly rows: readonly DagRun[]; readonly truncated: number };

export function createMembership(root: string) {
  let entries = new Map<string, Entry>();
  let disk: Recovery = { tasks: [], runs: [], issues: [] };
  let revision = 0;
  let tasksReady = false;
  let runsReady = false;
  const diagnostics = new Set<string>();
  function graph(owners = entries, records = disk.tasks) {
    const rows: ObservedTask[] = [];
    const replaced = new Set<string>();
    for (const [owner, entry] of owners) if (entry.tasks) {
      replaced.add(owner);
      for (const task of entry.tasks.rows) rows.push({ task, owner, revision: entry.tasks.revision });
    }
    return deriveMembership({ root, rows, records, replaced });
  }
  function fits(owners: ReadonlyMap<string, Entry>, recovered = disk) {
    let tasks = 0;
    let runs = recovered.runs.length;
    const liveIds = new Set<string>();
    const sessions = new Set<string>([root, ...owners.keys()]);
    for (const [owner, entry] of owners) {
      sessions.add(owner);
      tasks += entry.tasks?.rows.length ?? 0;
      for (const row of entry.tasks?.rows ?? []) liveIds.add(row.task_id);
      runs += entry.runs?.rows.length ?? 0;
      for (const row of entry.tasks?.rows ?? []) if (typeof row.child_session_id === "string") sessions.add(row.child_session_id);
    }
    for (const record of recovered.tasks) {
      if (!liveIds.has(record.task.task_id)) tasks++;
      sessions.add(record.parent); sessions.add(record.root);
      if (typeof record.task.child_session_id === "string") sessions.add(record.task.child_session_id);
    }
    for (const record of recovered.runs) { sessions.add(record.parent); sessions.add(record.root); }
    return tasks <= 256 && runs <= 256 && sessions.size <= 256 &&
      Buffer.byteLength(JSON.stringify([[...owners], recovered])) <= MAX_BYTES;
  }
  function descendants(owner: string) {
    const sessions = graph().sessions;
    const children = new Set<string>();
    for (const candidate of sessions.keys()) {
      let current = candidate;
      for (let depth = 0; depth < 64 && current !== root; depth++) {
        const edge = sessions.get(current);
        if (!edge) break;
        if (edge.parent === owner) { children.add(candidate); break; }
        current = edge.parent;
      }
    }
    return children;
  }
  return {
    accepts(owner: string) { return owner === root || graph().sessions.has(owner); },
    reject() { diagnostics.add("oversize"); },
    update(update: Update) {
      if (update.owner !== root && !graph().sessions.has(update.owner)) return false;
      const next = new Map(entries);
      const before = next.get(update.owner) ?? {};
      const replacement = { rows: update.rows, revision: revision + 1, truncated: update.truncated };
      switch (update.channel) {
        case "tasks":
          next.set(update.owner, { ...before, tasks: { ...replacement, rows: update.rows } });
          for (const child of descendants(update.owner)) next.delete(child);
          break;
        case "runs":
          next.set(update.owner, { ...before, runs: { ...replacement, rows: update.rows } });
          for (const child of descendants(update.owner)) {
            const entry = next.get(child);
            if (entry?.tasks) next.set(child, { tasks: entry.tasks });
            else next.delete(child);
          }
          break;
        default: return update satisfies never;
      }
      const reachable = graph(next).sessions;
      for (const owner of next.keys()) if (owner !== root && !reachable.has(owner)) next.delete(owner);
      // Live owns the payload budget. Once live, retain disk ancestry only for current IDs.
      const ids = new Set([...next.values()].flatMap(entry => entry.tasks?.rows.map(row => row.task_id) ?? []));
      const metadata = next.get(root)?.tasks
        ? disk.tasks.filter(record => ids.has(record.task.task_id)).map(record => ({
          ...record, task: { ...record.task, description: undefined, final_response: undefined, error_message: undefined },
        })) : disk.tasks;
      const recovered = { ...disk, tasks: metadata, runs: runsReady || update.channel === "runs" ? [] : disk.runs };
      if (!fits(next, recovered)) { diagnostics.add("oversize"); return false; }
      entries = next;
      disk = recovered;
      revision++;
      if (update.channel === "tasks") tasksReady = true;
      else runsReady = true;
      diagnostics.delete("oversize");
      return true;
    },
    recover(value: Recovery) {
      const ids = new Set([...entries.values()].flatMap(entry => entry.tasks?.rows.map(row => row.task_id) ?? []));
      const next = { ...value, tasks: entries.get(root)?.tasks ? value.tasks.filter(record => ids.has(record.task.task_id)) : value.tasks,
        runs: runsReady ? [] : value.runs };
      if (!fits(entries, next)) { diagnostics.add("budget"); return; }
      disk = next;
      const reachable = graph().sessions;
      for (const owner of entries.keys()) if (owner !== root && !reachable.has(owner)) entries.delete(owner);
    },
    snapshot(): AgentsSnapshot {
      const membership = graph();
      const taskRows = new Map<string, { task: Task; revision: number }>();
      const runRows = new Map<string, DagRun>();
      const runOwners = new Map<string, string>();
      const runConflicts = new Set<string>();
      const taskIssues = new Set([...disk.issues, ...diagnostics, ...membership.issues]);
      const runIssues = new Set([...disk.issues, ...diagnostics]);
      let truncatedTasks = 0;
      let truncatedRuns = 0;
      for (const [owner, entry] of [...entries].sort(([left], [right]) => left === root ? -1 : right === root ? 1 : 0)) {
        if (owner !== root && !membership.sessions.has(owner)) continue;
        for (const row of entry.tasks?.rows ?? []) {
          const previous = taskRows.get(row.task_id);
          if (!previous || previous.revision < (entry.tasks?.revision ?? 0)) {
            taskRows.set(row.task_id, { task: row, revision: entry.tasks?.revision ?? 0 });
          }
        }
        truncatedTasks += entry.tasks?.truncated ?? 0;
        truncatedRuns += entry.runs?.truncated ?? 0;
        for (const row of entry.runs?.rows ?? []) {
          if (runOwners.has(row.run_id) && runOwners.get(row.run_id) !== owner) runConflicts.add(row.run_id);
          runOwners.set(row.run_id, owner);
          runRows.set(row.run_id, { ...row, tau_owner_session_id: owner });
        }
      }
      if (!tasksReady) for (const record of disk.tasks) {
        if (membership.eligible.has(record.task.task_id) ||
            (record.root === root && !membership.conflicts.has(record.task.task_id))) {
          taskRows.set(record.task.task_id, { task: record.task, revision: 0 });
        }
      }
      if (!runsReady) for (const record of disk.runs) {
        if (!membership.sessions.has(record.parent)) continue;
        if (runOwners.has(record.run.run_id) && runOwners.get(record.run.run_id) !== record.parent) runConflicts.add(record.run.run_id);
        runOwners.set(record.run.run_id, record.parent);
        runRows.set(record.run.run_id, { ...record.run, tau_owner_session_id: record.parent });
      }
      for (const id of runConflicts) { runRows.delete(id); runIssues.add("ancestry-conflict"); }
      const tasks = [...taskRows.values()].map(row => membership.project(row.task));
      for (const issue of membership.issues) taskIssues.add(issue);
      const runs = [...runRows.values()];
      if (truncatedTasks) taskIssues.add("producer-truncated");
      if (truncatedRuns) runIssues.add("producer-truncated");
      if (!runsReady && runs.length) runIssues.add("checkpoint-stale");
      const taskCoverage = taskIssues.size || (!tasksReady && tasks.length) ? { coverage: coverage(taskIssues) } : {};
      const runCoverage = runIssues.size || (!runsReady && runs.length) ? { coverage: coverage(runIssues) } : {};
      return {
        agentsState: tasksReady || tasks.length ? {
          availability: tasksReady ? "ready" : "cached", parent_session_id: root, tasks,
          ...(truncatedTasks ? { truncated_tasks: truncatedTasks } : {}), ...taskCoverage,
        } : { availability: "unknown", parent_session_id: root, reason: "No authoritative task snapshot observed.", ...taskCoverage },
        dagState: runsReady || runs.length ? {
          availability: runsReady ? "ready" : "cached", parent_session_id: root, runs,
          ...(truncatedRuns ? { truncated_runs: truncatedRuns } : {}), ...runCoverage,
        } : { availability: "unknown", parent_session_id: root, reason: "No authoritative DAG snapshot observed.", ...runCoverage },
      };
    },
  };
}
