export type ObjectValue = Readonly<Record<string, unknown>>;
export type Task = ObjectValue & {
  readonly task_id: string;
  readonly model: string;
  readonly status: string;
  readonly residency_state: string;
  readonly depth: number;
  readonly created_at: string;
  readonly updated_at: string;
};
export type DagNode = ObjectValue & {
  readonly id: string;
  readonly prompt: string;
  readonly state: string;
  readonly depends_on: readonly string[];
  readonly attempt: number;
  readonly created_at: string;
};
export type DagRun = ObjectValue & {
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
export type UnknownState = {
  readonly availability: "unknown";
  readonly coverage?: Coverage;
  readonly parent_session_id?: string;
  readonly reason: string;
};
export type TasksReady = {
  readonly availability: "ready" | "cached";
  readonly parent_session_id: string;
  readonly tasks: readonly Task[];
  readonly truncated_tasks?: number;
  readonly coverage?: Coverage;
};
export type DagReady = {
  readonly availability: "ready" | "cached";
  readonly parent_session_id: string;
  readonly runs: readonly DagRun[];
  readonly truncated_runs?: number;
  readonly coverage?: Coverage;
};
export type AgentsSnapshot = {
  readonly agentsState: UnknownState | TasksReady;
  readonly dagState: UnknownState | DagReady;
};
export type Owner = { readonly sessionId: string; readonly file: string; readonly epoch: string };
export type EventBus = {
  readonly on: (name: string, handler: (value: unknown) => void) => () => void;
};

const taskStatuses = new Set(["pending", "running", "paused", "completed", "error", "cancelled", "interrupted", "lost"]);
const residencyStates = new Set(["resident", "evicted", "disposed", "persisted_only", "rpc_detached"]);
export const object = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const text = (value: unknown): value is string => typeof value === "string";
export const identity = (value: unknown): value is string => text(value) && value.trim().length > 0;
export const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(identity);
export function optional(value: ObjectValue, keys: readonly string[], valid: (item: unknown) => boolean): boolean {
  return keys.every(key => value[key] === undefined || valid(value[key]));
}
export function task(value: unknown): value is Task {
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
export function node(value: unknown): value is DagNode {
  return object(value) && identity(value.id) && text(value.prompt) && identity(value.state) &&
    strings(value.depends_on) && count(value.attempt) && text(value.created_at) &&
    optional(value, ["label", "task_id", "started_at", "completed_at"], text) &&
    (value.last_error === undefined || (object(value.last_error) &&
      text(value.last_error.code) && text(value.last_error.message)));
}
export function run(value: unknown): value is DagRun {
  return object(value) && identity(value.run_id) && identity(value.run_key) && text(value.name) &&
    identity(value.status) && text(value.created_at) && text(value.updated_at) &&
    optional(value, ["completed_at"], text) && optional(value, ["amend_count", "lease_holder_pid"], count) &&
    object(value.counts) && Object.values(value.counts).every(count) &&
    Array.isArray(value.nodes) && value.nodes.every(node) &&
    new Set(value.nodes.map(item => item.id)).size === value.nodes.length &&
    Array.isArray(value.edges) && value.edges.every(item => object(item) && identity(item.from) && identity(item.to)) &&
    Array.isArray(value.waves) && value.waves.every(item => object(item) && count(item.index) && strings(item.node_ids));
}

export type Coverage = { readonly incomplete: boolean; readonly issues: readonly string[] };
export type RecordTask = { readonly task: Task; readonly parent: string; readonly root: string };
export type RecordRun = { readonly run: DagRun; readonly parent: string; readonly root: string };
export type Recovery = { readonly tasks: readonly RecordTask[]; readonly runs: readonly RecordRun[]; readonly issues: readonly string[] };
export const MAX_BYTES = 8 * 1024 * 1024;
export function coverage(issues: Iterable<string>): Coverage {
  const codes = [...new Set(issues)].sort().slice(0, 16);
  return { incomplete: codes.length > 0, issues: codes };
}
