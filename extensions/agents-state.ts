import { createMembership, type Update } from "./agents-membership";
import { recoverAgents } from "./agents-recovery";
import { count, identity, object, optional, run, task, MAX_BYTES,
  type AgentsSnapshot, type EventBus, type Owner } from "./agents-types";

function unknownState(parent?: string): AgentsSnapshot {
  const owner = parent === undefined ? {} : { parent_session_id: parent };
  return {
    agentsState: { availability: "unknown", ...owner, reason: "No authoritative task snapshot observed." },
    dagState: { availability: "unknown", ...owner, reason: "No authoritative DAG snapshot observed." },
  };
}
function matches(left: Owner | null, right: Owner | null): boolean {
  return left !== null && right !== null && left.sessionId === right.sessionId &&
    left.file === right.file && left.epoch === right.epoch;
}

export function observeAgents(events: EventBus, currentOwner: () => Owner | null,
  publish: (snapshot: AgentsSnapshot) => void, options: { readonly stateDir?: string } = {}) {
  let owner: Owner | null = null;
  let project: string | undefined;
  let closed = false;
  let generation = 0;
  let state = unknownState();
  let membership: ReturnType<typeof createMembership> | undefined;
  let stopRecovery: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPublished = "";
  const pending = new Map<string, { readonly updates: readonly Update[]; readonly bytes: number }>();
  let pendingBytes = 0;
  function refresh() {
    if (closed || !matches(owner, currentOwner()) || !membership) return;
    state = membership.snapshot();
    if (timer || JSON.stringify(state) === lastPublished) return;
    const token = generation;
    timer = setTimeout(() => {
      timer = undefined;
      if (closed || generation !== token || !matches(owner, currentOwner())) return;
      const serialized = JSON.stringify(state);
      if (serialized === lastPublished) return;
      lastPublished = serialized;
      publish(state);
    }, 250);
    timer.unref?.();
  }
  const unsubscribe = events.on("senpi:extension-rpc-event", (wrapper: unknown) => {
    if (closed || !object(wrapper) || !object(wrapper.data) || !identity(wrapper.data.parent_session_id)) return;
    const parent = wrapper.data.parent_session_id;
    if (owner && (!matches(owner, currentOwner()) || !membership?.accepts(parent))) return;
    const data = wrapper.data;
    const rows = wrapper.name === "omo.task.updated" ? data.tasks : wrapper.name === "omo.dag.updated" ? data.runs : null;
    if (Array.isArray(rows) && (rows.length > 256 || (wrapper.name === "omo.dag.updated" &&
        rows.some(row => object(row) && ((Array.isArray(row.nodes) && row.nodes.length > 1024) ||
          (Array.isArray(row.edges) && row.edges.length > 4096)))))) {
      if (owner) { membership?.reject(); refresh(); }
      return;
    }
    let update: Update;
    switch (wrapper.name) {
      case "omo.task.updated":
        if (!Array.isArray(data.tasks) || !data.tasks.every(task) ||
            new Set(data.tasks.map(item => item.task_id)).size !== data.tasks.length ||
            !optional(data, ["truncated_tasks"], count)) return;
        update = { channel: "tasks", owner: parent, rows: data.tasks.map(({ tau_ancestry: _ancestry, ...row }) => row),
          truncated: typeof data.truncated_tasks === "number" ? data.truncated_tasks : 0 };
        break;
      case "omo.dag.updated":
        if (!Array.isArray(data.runs) || !data.runs.every(run) ||
            new Set(data.runs.map(item => item.run_id)).size !== data.runs.length ||
            !optional(data, ["truncated_runs"], count)) return;
        update = { channel: "runs", owner: parent, rows: data.runs.map(({ tau_owner_session_id: _owner, ...row }) => row),
          truncated: typeof data.truncated_runs === "number" ? data.truncated_runs : 0 };
        break;
      default: return;
    }
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(update));
      if (bytes <= MAX_BYTES) update = structuredClone(update);
    } catch (error) {
      if (error instanceof TypeError || (error instanceof DOMException && error.name === "DataCloneError")) return;
      throw error;
    }
    if (bytes > MAX_BYTES || update.rows.length > 256 || (update.channel === "runs" &&
        update.rows.some(row => row.nodes.length > 1024 || row.edges.length > 4096))) {
      if (owner) { membership?.reject(); refresh(); }
      return;
    }
    if (owner) { membership?.update(update); refresh(); return; }
    const updates = [...(pending.get(parent)?.updates ?? []).filter(old => old.channel !== update.channel), update];
    const retained = Buffer.byteLength(JSON.stringify(updates));
    if (retained > MAX_BYTES) return;
    pendingBytes -= pending.get(parent)?.bytes ?? 0;
    pending.delete(parent);
    pending.set(parent, { updates, bytes: retained });
    pendingBytes += retained;
    while (pending.size > 8 || pendingBytes > MAX_BYTES) {
      const oldest = pending.entries().next().value;
      if (!oldest) break;
      pendingBytes -= oldest[1].bytes;
      pending.delete(oldest[0]);
    }
  });
  return {
    bind(next: Owner, projectDir?: string) {
      if (closed || (matches(owner, next) && projectDir === project)) return;
      generation++;
      if (timer) clearTimeout(timer);
      timer = undefined;
      stopRecovery?.();
      const sameOwner = matches(owner, next);
      const initial = owner === null ? pending.get(next.sessionId)?.updates ?? [] : [];
      owner = { ...next };
      project = projectDir;
      if (!sameOwner) membership = createMembership(next.sessionId);
      for (const update of initial) membership?.update(update);
      pending.clear(); pendingBytes = 0;
      state = membership?.snapshot() ?? unknownState(next.sessionId);
      lastPublished = JSON.stringify(state);
      const token = generation;
      if (projectDir !== undefined || options.stateDir !== undefined) {
        stopRecovery = recoverAgents({ ...options, ...(projectDir === undefined ? {} : { projectDir }) }, recovered => {
          if (closed || generation !== token || !matches(owner, currentOwner())) return;
          membership?.recover(recovered);
          refresh();
        });
      }
    },
    snapshot(): AgentsSnapshot {
      return !closed && matches(owner, currentOwner()) ? state : unknownState(currentOwner()?.sessionId);
    },
    shutdown() {
      closed = true; generation++;
      unsubscribe(); stopRecovery?.();
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear(); pendingBytes = 0;
      owner = null; membership = undefined; state = unknownState(); lastPublished = "";
    },
  };
}
