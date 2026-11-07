/** Bounded presentation indexes. Only tau_ancestry establishes task parentage. */
export const terminal = new Set(['completed', 'error', 'cancelled', 'interrupted', 'lost']);
export const summary = task => task.task_summary || task.description || task.name || task.task_id;
export const model = task => task.effective_model?.display || task.model || 'Model unavailable';
export const observed = (state, key) => ['ready', 'cached'].includes(state.availability) ? state[key] : [];
export function element(tag, className = '', text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function text(node, value) {
  value = String(value ?? '');
  if (node.textContent !== value) node.textContent = value;
}
export function reconcile(parent, children, beforeRemove) {
  const wanted = new Set(children);
  for (const child of [...parent.children]) if (!wanted.has(child)) {
    if (child.contains(document.activeElement)) beforeRemove?.();
    child.remove();
  }
  children.forEach((child, index) => {
    if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
  });
}
export function textWriter() {
  // Leave space for static labels and 1Hz elapsed updates.
  let remaining = 120000;
  const write = (node, value, maximum = 32000) => {
    value = String(value ?? '');
    const limit = Math.min(maximum, remaining);
    const shortened = value.length > limit;
    const marker = ' [Text truncated]';
    const result = shortened ? value.slice(0, Math.max(0, limit - marker.length)) + marker.slice(0, limit) : value;
    remaining = Math.max(0, remaining - result.length);
    write.truncated ||= shortened;
    text(node, result);
  };
  write.truncated = false;
  return write;
}
export function availability(state, kind) {
  const label = kind === 'tasks' ? 'Agent' : 'DAG';
  const messages = [];
  switch (state.availability) {
    case 'cached': messages.push('Cached records; execution state unverified'); break;
    case 'ready': {
      const omitted = state[kind === 'tasks' ? 'truncated_tasks' : 'truncated_runs'];
      if (omitted > 0) messages.push(`${omitted} more ${kind} omitted. This view is incomplete.`);
      else if (!state[kind].length) messages.push(`No ${kind === 'tasks' ? 'child agents' : 'DAG runs'} in this session.`);
      break;
    }
    case 'unknown': messages.push(state.reason || `${label} state unknown. Waiting for an observed snapshot.`); break;
    case 'unavailable': messages.push(`Unavailable. ${state.reason || 'State could not be read.'}`); break;
    case 'unsupported': messages.push(`Unsupported. ${state.reason || 'This session does not provide this state.'}`); break;
    default: throw new TypeError(`Unknown availability: ${state.availability}`);
  }
  const issues = state.coverage?.issues || [];
  if (issues.includes('location-unverified')) messages.push('Store location inferred; custom override unverified');
  if (state.coverage?.incomplete) messages.push(`Coverage incomplete: ${issues.slice(0, 16).join(', ') || 'details unavailable'}`);
  return messages.join('. ');
}
export function taskIndex(taskState, dagState) {
  const tasks = new Map();
  for (const task of observed(taskState, 'tasks')) if (!tasks.has(task.task_id)) {
    tasks.set(task.task_id, { ...task, parentTaskId: task.tau_ancestry?.parent_task_id });
  }
  const runs = [...new Map(observed(dagState, 'runs').map(run => [run.run_id, run])).values()];
  const children = new Map(), linked = new Map(), counts = new Map(), runSummaries = new Map();
  for (const task of tasks.values()) {
    counts.set(task.status, (counts.get(task.status) || 0) + 1);
    if (task.tau_ancestry?.relation === 'descendant' && task.parentTaskId) {
      if (!children.has(task.parentTaskId)) children.set(task.parentTaskId, []);
      children.get(task.parentTaskId).push(task);
    }
  }
  const fallback = runs.length > 64 || runs.some(run =>
    run.nodes.length > 200 || (run.edges?.length || 0) > 4096 ||
    run.nodes.some(node => (node.depends_on?.length || 0) > 4096) ||
    new Set(run.nodes.flatMap(node => (node.depends_on || []).map(id => JSON.stringify([id, node.id])))).size > 400);
  if (!fallback) for (const run of runs) {
    const nodes = new Map(run.nodes.map(node => [node.id, node])), states = new Map();
    for (const node of nodes.values()) {
      states.set(node.state, (states.get(node.state) || 0) + 1);
      if (!node.task_id) continue;
      if (!linked.has(node.task_id)) linked.set(node.task_id, []);
      linked.get(node.task_id).push({ runId: run.run_id, nodeId: node.id });
    }
    const progress = ['completed', 'running', 'pending',
      ...[...states.keys()].filter(state => !['completed', 'running', 'pending'].includes(state))]
      .map(state => `${state[0].toUpperCase() + state.slice(1)}: ${states.get(state) || 0}${state === 'completed' ? `/${nodes.size}` : ''}`);
    runSummaries.set(run.run_id, `${run.name || run.run_id} · ${run.status} · ${nodes.size} unique nodes · ${progress.join(' · ')}`);
  }
  const roots = [...tasks.values()].filter(task => fallback || (!linked.has(task.task_id) &&
    !(task.tau_ancestry?.relation === 'descendant' && tasks.has(task.parentTaskId))));
  // A malformed ancestry cycle still needs one visible, inspectable root.
  if (!fallback) {
    const seen = new Set(), queue = [...roots, ...[...linked.keys()].map(id => tasks.get(id)).filter(Boolean)];
    for (let i = 0; i < queue.length; i++) {
      const task = queue[i];
      if (seen.has(task.task_id)) continue;
      seen.add(task.task_id);
      queue.push(...(children.get(task.task_id) || []));
    }
    for (const task of tasks.values()) if (!seen.has(task.task_id)) {
      roots.push(task);
      queue.length = 0;
      queue.push(task);
      for (let i = 0; i < queue.length; i++) {
        if (seen.has(queue[i].task_id)) continue;
        seen.add(queue[i].task_id);
        queue.push(...(children.get(queue[i].task_id) || []));
      }
    }
  }
  return { tasks, runs, children, linked, counts, roots, fallback, runSummaries };
}
export function descendants(index, id) {
  const rows = [], seen = new Set([id]), queue = [...(index.children.get(id) || [])];
  let cycle = false, omitted = 0;
  for (let i = 0; i < queue.length; i++) {
    const task = queue[i];
    if (seen.has(task.task_id)) { cycle = true; continue; }
    seen.add(task.task_id);
    if (rows.length < 100) rows.push(task); else omitted++;
    queue.push(...(index.children.get(task.task_id) || []));
  }
  return { rows, cycle, omitted };
}
export function elapsed(task) {
  const start = Date.parse(task.created_at);
  const end = terminal.has(task.status) ? Date.parse(task.updated_at) : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  const duration = Number.isFinite(seconds) && seconds >= 0
    ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : 'unavailable';
  return `${task.status}${task.awaiting_input === undefined ? '' : ' · Waiting for user input'} · Elapsed ${duration}`;
}
export function activity(task) {
  const progress = task.live_progress;
  return [progress?.activity, progress?.current_tool,
    progress?.turns != null ? `${progress.turns} turns` : null,
    progress?.tool_calls != null ? `${progress.tool_calls} tool calls` : null,
    progress?.failed_turns != null ? `${progress.failed_turns} failed turns` : null,
    progress?.total_tokens != null ? `${progress.total_tokens} total tokens` : null,
    progress?.output_tokens != null ? `${progress.output_tokens} output tokens` : null,
    progress?.tokens_per_second != null ? `${progress.tokens_per_second} tokens/s` : null]
    .filter(value => value != null && value !== '').join(' · ') || 'Recent activity unavailable';
}
