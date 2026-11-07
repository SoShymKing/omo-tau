type ObjectValue = Readonly<Record<string, unknown>>;
type Task = ObjectValue & {
  readonly task_id: string;
  readonly model: string;
  readonly status: string;
  readonly residency_state: string;
  readonly depth: number;
  readonly created_at: string;
  readonly updated_at: string;
};
type DagNode = ObjectValue & {
  readonly id: string;
  readonly prompt: string;
  readonly state: string;
  readonly depends_on: readonly string[];
  readonly attempt: number;
  readonly created_at: string;
};
type DagRun = ObjectValue & {
  readonly run_id: string;
  readonly run_key: string;
  readonly name: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly nodes: readonly DagNode[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly waves: readonly { readonly index: number; readonly node_ids: readonly string[] }[];
};
type UnknownState = {
  readonly availability: "unknown";
  readonly parent_session_id?: string;
  readonly reason: string;
};
type TasksReady = {
  readonly availability: "ready";
  readonly parent_session_id: string;
  readonly tasks: readonly Task[];
  readonly truncated_tasks?: number;
};
type DagReady = {
  readonly availability: "ready";
  readonly parent_session_id: string;
  readonly runs: readonly DagRun[];
  readonly truncated_runs?: number;
};
type AgentsSnapshot = {
  readonly agentsState: UnknownState | TasksReady;
  readonly dagState: UnknownState | DagReady;
};
type Owner = { readonly sessionId: string; readonly file: string; readonly epoch: string };
type EventBus = {
  readonly on: (name: string, handler: (value: unknown) => void) => () => void;
};

const taskStatuses = new Set(["pending", "running", "paused", "completed", "error", "cancelled", "interrupted", "lost"]);
const residencyStates = new Set(["resident", "evicted", "disposed", "persisted_only", "rpc_detached"]);
const object = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const identity = (value: unknown): value is string => text(value) && value.trim().length > 0;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(identity);
function optional(value: ObjectValue, keys: readonly string[], valid: (item: unknown) => boolean): boolean {
  return keys.every(key => value[key] === undefined || valid(value[key]));
}
function task(value: unknown): value is Task {
  if (!object(value) || !identity(value.task_id) || !text(value.model) ||
      !text(value.status) || !taskStatuses.has(value.status) ||
      !text(value.residency_state) || !residencyStates.has(value.residency_state) ||
      !count(value.depth) || !text(value.created_at) || !text(value.updated_at)) return false;
  if (!optional(value, ["task_summary", "description", "name", "category", "agent_type", "execution_mode",
    "child_session_id", "failure_kind", "failure_reason", "final_response", "error_message"], text) ||
      !optional(value, ["description_truncated", "final_response_truncated", "error_message_truncated"],
        item => typeof item === "boolean")) return false;
  if (value.effective_model !== undefined && (!object(value.effective_model) ||
      !text(value.effective_model.provider) || !text(value.effective_model.model_id) ||
      !text(value.effective_model.display))) return false;
  if (value.live_progress !== undefined && (!object(value.live_progress) ||
      !text(value.live_progress.activity) || !finite(value.live_progress.started_at) ||
      !count(value.live_progress.turns) ||
      !optional(value.live_progress, ["current_tool", "last_assistant_line"], text) ||
      !optional(value.live_progress, ["failed_turns", "tool_calls", "total_tokens", "output_tokens", "tokens_per_second"], finite))) return false;
  return optional(value, ["run_stats", "awaiting_input"], object);
}
function node(value: unknown): value is DagNode {
  return object(value) && identity(value.id) && text(value.prompt) && identity(value.state) &&
    strings(value.depends_on) && count(value.attempt) && text(value.created_at) &&
    optional(value, ["label", "task_id", "started_at", "completed_at"], text) &&
    (value.last_error === undefined || (object(value.last_error) &&
      text(value.last_error.code) && text(value.last_error.message)));
}
function run(value: unknown): value is DagRun {
  return object(value) && identity(value.run_id) && identity(value.run_key) && text(value.name) &&
    identity(value.status) && text(value.created_at) && text(value.updated_at) &&
    optional(value, ["completed_at"], text) && optional(value, ["amend_count", "lease_holder_pid"], count) &&
    object(value.counts) && Object.values(value.counts).every(count) &&
    Array.isArray(value.nodes) && value.nodes.every(node) &&
    new Set(value.nodes.map(item => item.id)).size === value.nodes.length &&
    Array.isArray(value.edges) && value.edges.every(item => object(item) && identity(item.from) && identity(item.to)) &&
    Array.isArray(value.waves) && value.waves.every(item => object(item) && count(item.index) && strings(item.node_ids));
}
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

// Observes complete producer replacements. The owner getter fences mutable host contexts
// and retired extension epochs without deriving an OMO owner from Tau's registry UUID.
export function observeAgents(
  events: EventBus,
  currentOwner: () => Owner | null,
  publish: (snapshot: AgentsSnapshot) => void,
) {
  let owner: Owner | null = null;
  let closed = false;
  let state = unknownState();
  // Only pre-start observations can be pending; binding discards all foreign entries.
  const pending = new Map<string, { readonly state: AgentsSnapshot; readonly bytes: number }>();
  let pendingBytes = 0;
  const unsubscribe = events.on("senpi:extension-rpc-event", (wrapper: unknown) => {
    if (closed || !object(wrapper) ||
        (wrapper.name !== "omo.task.updated" && wrapper.name !== "omo.dag.updated") ||
        !object(wrapper.data) || !identity(wrapper.data.parent_session_id)) return;
    const parent = wrapper.data.parent_session_id;
    if (owner && (parent !== owner.sessionId || !matches(owner, currentOwner()))) return;
    const data = wrapper.data;
    const previous = owner ? state : pending.get(parent)?.state ?? unknownState(parent);
    let next: AgentsSnapshot;
    switch (wrapper.name) {
      case "omo.task.updated":
        if (!Array.isArray(data.tasks) || !data.tasks.every(task) ||
            new Set(data.tasks.map(item => item.task_id)).size !== data.tasks.length ||
            !optional(data, ["truncated_tasks"], count)) return;
        next = { ...previous, agentsState: { availability: "ready", parent_session_id: parent,
          tasks: data.tasks, ...(typeof data.truncated_tasks === "number" ? { truncated_tasks: data.truncated_tasks } : {}) } };
        break;
      case "omo.dag.updated":
        if (!Array.isArray(data.runs) || !data.runs.every(run) ||
            new Set(data.runs.map(item => item.run_id)).size !== data.runs.length ||
            !optional(data, ["truncated_runs"], count)) return;
        next = { ...previous, dagState: { availability: "ready", parent_session_id: parent,
          runs: data.runs, ...(typeof data.truncated_runs === "number" ? { truncated_runs: data.truncated_runs } : {}) } };
        break;
      default: return wrapper.name satisfies never;
    }
    // Require a serializable snapshot and detach it from later producer mutations.
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(next));
      next = structuredClone(next);
    } catch (error) {
      if (error instanceof TypeError || (error instanceof DOMException && error.name === "DataCloneError")) return;
      throw error;
    }
    if (owner) {
      state = next;
      publish(state);
      return;
    }
    if (bytes > 8 * 1024 * 1024) return;
    pendingBytes -= pending.get(parent)?.bytes ?? 0;
    pending.delete(parent);
    pending.set(parent, { state: next, bytes });
    pendingBytes += bytes;
    while (pending.size > 8 || pendingBytes > 8 * 1024 * 1024) {
      const oldest = pending.entries().next().value;
      if (!oldest) break;
      pendingBytes -= oldest[1].bytes;
      pending.delete(oldest[0]);
    }
  });
  return {
    bind(next: Owner) {
      if (closed || matches(owner, next)) return;
      state = owner === null ? pending.get(next.sessionId)?.state ?? unknownState(next.sessionId) : unknownState(next.sessionId);
      owner = next;
      pending.clear();
      pendingBytes = 0;
    },
    snapshot(): AgentsSnapshot {
      return !closed && matches(owner, currentOwner()) ? state : unknownState(currentOwner()?.sessionId);
    },
    shutdown() {
      closed = true;
      unsubscribe();
      pending.clear();
      pendingBytes = 0;
      owner = null;
      state = unknownState();
    },
  };
}
