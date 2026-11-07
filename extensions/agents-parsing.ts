import { count, identity, object, optional, run, task, text, type RecordRun, type RecordTask } from "./agents-types";

export function parseTaskRecord(value: unknown, filename: string): RecordTask | null {
  if (!object(value) || !/^st_[0-9a-f]{8}\.json$/.test(filename) ||
      `${value.task_id}.json` !== filename || !identity(value.parent_session_id) ||
      !identity(value.root_session_id) || !text(value.execution_mode) ||
      !object(value.notification) || !count(value.notification.run_epoch) ||
      typeof value.notification.notified_epoch !== "number" || !Number.isFinite(value.notification.notified_epoch) ||
      !optional(value.notification, ["notification_failed_epoch", "liveness_notified_epoch"], count) ||
      !optional(value, ["terminal_at", "started_at"], text)) return null;
  const projected: Record<string, unknown> = {};
  for (const key of ["task_id", "model", "status", "residency_state", "depth", "created_at", "updated_at",
    "task_summary", "description", "name", "category", "agent_type", "execution_mode", "child_session_id",
    "failure_kind", "failure_reason", "final_response", "error_message", "effective_model", "run_stats", "awaiting_input"]) {
    if (value[key] !== undefined) projected[key] = value[key];
  }
  if (projected.status === "running" && value.paused === true) projected.status = "paused";
  if (!task(projected)) return null;
  return { task: projected, parent: value.parent_session_id, root: value.root_session_id };
}

export function parseCheckpoint(value: unknown, filename: string): RecordRun | null {
  if (!object(value) || value.schemaVersion !== 1 || !identity(value.runId) ||
      !/^[a-zA-Z0-9_-]+\.json$/.test(filename) || `${value.runId}.json` !== filename ||
      !identity(value.parentSessionId) || !identity(value.rootSessionId) ||
      !Array.isArray(value.nodes) || value.nodes.length > 1024 ||
      !Array.isArray(value.edges) || value.edges.length > 4096 || !Array.isArray(value.waves) ||
      (value.amendHistory !== undefined && !Array.isArray(value.amendHistory))) return null;
  const nodes: unknown[] = [];
  const counts: Record<string, number> = { total: value.nodes.length, pending: 0, blocked: 0, scheduled: 0,
    running: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const item of value.nodes) {
    if (!object(item)) return null;
    const state = item.state === "running" && item.paused === true ? "paused" : item.state;
    if (!identity(state)) return null;
    counts[state] = (counts[state] ?? 0) + 1;
    nodes.push({ id: item.id, prompt: item.prompt, state, depends_on: item.dependsOn,
      attempt: item.attempt, created_at: item.createdAt,
      ...(item.label === undefined ? {} : { label: item.label }),
      ...(item.taskId === undefined ? {} : { task_id: item.taskId }),
      ...(item.startedAt === undefined ? {} : { started_at: item.startedAt }),
      ...(item.completedAt === undefined ? {} : { completed_at: item.completedAt }),
      ...(item.error === undefined ? {} : { last_error: item.error }) });
  }
  const waves: unknown[] = [];
  for (const item of value.waves) {
    if (!object(item)) return null;
    waves.push({ index: item.index, node_ids: item.nodeIds });
  }
  const projected = { run_id: value.runId, run_key: value.runKey, name: value.name, status: value.status,
    created_at: value.createdAt, updated_at: value.updatedAt, counts, nodes, edges: value.edges, waves,
    ...(value.completedAt === undefined ? {} : { completed_at: value.completedAt }),
    ...(value.leaseHolderPid === undefined ? {} : { lease_holder_pid: value.leaseHolderPid }),
    ...(Array.isArray(value.amendHistory) && value.amendHistory.length ? { amend_count: value.amendHistory.length } : {}) };
  return run(projected) ? { run: projected, parent: value.parentSessionId, root: value.rootSessionId } : null;
}
