import { identity, type RecordTask, type Task } from "./agents-types";

export type ObservedTask = { readonly task: Task; readonly owner: string; readonly revision: number };
export type SessionLink = { readonly parent: string; readonly taskId: string; readonly depth: number };

// The envelope proves branch membership, not immediate task ownership. Durable parent
// evidence supplies placement; current live links supply reachability and override old links.
export function deriveMembership(input: {
  readonly root: string;
  readonly rows: readonly ObservedTask[];
  readonly records: readonly RecordTask[];
  readonly replaced: ReadonlySet<string>;
}) {
  const { root, rows, records, replaced } = input;
  const issues = new Set<string>();
  const metadata = new Map<string, RecordTask>();
  const conflicts = new Set<string>();
  for (const record of records) {
    const old = metadata.get(record.task.task_id);
    if (old && (old.parent !== record.parent || old.root !== record.root)) conflicts.add(record.task.task_id);
    metadata.set(record.task.task_id, record);
  }
  const current = new Map<string, ObservedTask>();
  for (const row of rows) {
    const old = current.get(row.task.task_id);
    if (!old || row.revision > old.revision) current.set(row.task.task_id, row);
  }
  const candidates = new Map(current);
  // Before a task replacement, disk can establish a path. Once a linking ancestor
  // replaces membership, only its live IDs may bridge that part of the path.
  for (const record of records) {
    if (!candidates.has(record.task.task_id)) {
      candidates.set(record.task.task_id, { task: record.task, owner: record.parent, revision: 0 });
    }
  }
  const claims = new Map<string, Set<string>>();
  for (const [id, row] of candidates) {
    if (row.revision === 0 && replaced.has(root)) continue;
    const child = row.task.child_session_id;
    if (identity(child)) {
      const ids = claims.get(child) ?? new Set<string>();
      ids.add(id);
      claims.set(child, ids);
    }
  }
  for (const ids of claims.values()) if (ids.size > 1) {
    issues.add("ancestry-conflict");
    for (const id of ids) conflicts.add(id);
  }
  for (const [id, record] of metadata) {
    const visited = new Set<string>([id]);
    let parent = record.parent;
    for (let depth = 0; depth <= 64; depth++) {
      const ids = claims.get(parent);
      const parentId = ids?.size === 1 ? ids.values().next().value : undefined;
      if (!parentId) break;
      if (visited.has(parentId)) {
        for (const member of visited) conflicts.add(member);
        issues.add("ancestry-cycle"); break;
      }
      visited.add(parentId);
      const next = metadata.get(parentId);
      if (!next) break;
      parent = next.parent;
      if (depth === 64) { issues.add("budget"); conflicts.add(id); }
    }
  }
  const roots = new Set(records.filter(record => record.parent === root).map(record => record.root));
  const expectedRoot = roots.size === 1 ? [...roots][0] : root;
  const sessions = new Map<string, SessionLink>();
  sessions.set(root, { parent: root, taskId: "", depth: 0 });
  const eligible = new Set<string>();
  for (let pass = 0; pass <= 64; pass++) {
    let changed = false;
    for (const [id, row] of candidates) {
      if (conflicts.has(id)) continue;
      const record = metadata.get(id);
      if (record && record.root !== expectedRoot && record.root !== root) {
        conflicts.add(id);
        // Other sessions share this store; only an observed branch can conflict.
        if (row.revision > 0 || sessions.has(record.parent)) issues.add("ancestry-conflict");
        continue;
      }
      const parent = record?.parent ?? row.owner;
      const link = sessions.get(parent) ?? (!record && row.revision > 0 ? sessions.get(row.owner) : undefined);
      if (!link) continue;
      if (row.revision === 0) {
        let ancestor = parent;
        let retired = false;
        for (let depth = 0; depth <= 64; depth++) {
          if (replaced.has(ancestor)) { retired = true; break; }
          if (ancestor === root) break;
          const edge = sessions.get(ancestor);
          if (!edge) break;
          ancestor = edge.parent;
        }
        if (retired) continue;
      }
      eligible.add(id);
      const child = row.task.child_session_id;
      if (!identity(child) || claims.get(child)?.size !== 1) continue;
      let ancestor = parent;
      let cycle = child === root;
      for (let depth = 0; depth <= 64 && ancestor !== root; depth++) {
        if (ancestor === child) { cycle = true; break; }
        const edge = sessions.get(ancestor);
        if (!edge) break;
        ancestor = edge.parent;
      }
      if (cycle) { conflicts.add(id); issues.add("ancestry-cycle"); continue; }
      if (link.depth >= 64 || sessions.size >= 256) { issues.add("budget"); continue; }
      if (!sessions.has(child)) {
        sessions.set(child, { parent: sessions.has(parent) ? parent : row.owner, taskId: id, depth: link.depth + 1 });
        changed = true;
      }
    }
    if (!changed) break;
  }
  function project(row: Task): Task {
    const record = metadata.get(row.task_id);
    const unresolved = { ...row, tau_ancestry: { relation: "unresolved", evidence: "unavailable" } };
    if (conflicts.has(row.task_id)) return unresolved;
    if (record?.parent === root) {
      return { ...row, tau_ancestry: { relation: "direct", evidence: "record" } };
    }
    if (record) {
      const edge = sessions.get(record.parent);
      if (edge?.taskId && edge.taskId !== row.task_id && !conflicts.has(edge.taskId)) {
        return { ...row, tau_ancestry: { relation: "descendant", parent_task_id: edge.taskId, evidence: "record" } };
      }
    }
    issues.add("ancestry-unresolved");
    return unresolved;
  }
  return { sessions, eligible, conflicts, issues, project };
}
