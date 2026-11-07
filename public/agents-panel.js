/** Authoritative selected-session replacements. Transport and owner validation live upstream. */
const terminal = new Set(['completed', 'error', 'cancelled', 'interrupted', 'lost']);
const summary = task => task.task_summary || task.description || task.name || task.task_id;
const model = task => task.effective_model?.display || task.model || 'Model unavailable';
const unknown = () => ({ availability: 'unknown' });

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function reconcile(parent, children) {
  const wanted = new Set(children);
  for (const child of [...parent.children]) if (!wanted.has(child)) child.remove();
  children.forEach((child, index) => {
    if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
  });
}

function availability(state, kind) {
  switch (state.availability) {
    case 'ready': {
      const omitted = state[kind === 'tasks' ? 'truncated_tasks' : 'truncated_runs'];
      return omitted > 0 ? `${omitted} more ${kind} omitted. This view is incomplete.` :
        state[kind].length ? '' : `No ${kind === 'tasks' ? 'child agents' : 'DAG runs'} in this session.`;
    }
    case 'unknown': return state.reason || `${kind === 'tasks' ? 'Agent' : 'DAG'} state unknown. Waiting for an observed snapshot.`;
    case 'unavailable': return `Unavailable. ${state.reason || 'State could not be read.'}`;
    case 'unsupported': return `Unsupported. ${state.reason || 'This session does not provide this state.'}`;
    default: throw new TypeError(`Unknown availability: ${state.availability}`);
  }
}

export class AgentsPanel {
  constructor(container, count) {
    this.container = container;
    this.count = count;
    this.tasks = unknown();
    this.dag = unknown();
    this.sessionFile = null;
    this.connected = false;
    this.visible = false;
    this.timer = null;
    this.rows = new Map();
    this.disclosures = new Map();
    this.clockRows = [];
    this.connection = element('p', 'agents-notice');
    this.connection.setAttribute('role', 'status');
    this.taskNotice = element('p', 'agents-notice');
    this.taskList = element('div', 'agents-task-list');
    this.dagRoot = this.disclosure('dag', 'Workflow DAG');
    this.dagNotice = element('p', 'agents-notice');
    this.dagList = element('div', 'agents-runs');
    this.dagRoot.body.append(this.dagNotice, this.dagList);
    container.append(this.connection, this.taskNotice, this.taskList, this.dagRoot.node);
    this.onVisibility = () => this.syncClock();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.render();
  }

  selectSession(sessionFile) {
    this.sessionFile = sessionFile;
    this.connected = false;
    this.tasks = unknown();
    this.dag = unknown();
    this.rows.clear();
    this.disclosures.clear();
    this.disclosures.set('dag', this.dagRoot);
    this.taskList.replaceChildren();
    this.dagList.replaceChildren();
    this.render();
  }

  replace(data, sessionFile) {
    if (sessionFile !== this.sessionFile) return;
    this.tasks = data.agentsState || unknown();
    this.dag = data.dagState || unknown();
    this.connected = true;
    this.render();
  }

  setConnected(connected) {
    this.connected = connected;
    this.render();
  }

  setVisible(visible) {
    this.visible = visible;
    this.syncClock();
  }

  disclosure(key, title) {
    let result = this.disclosures.get(key);
    if (!result) {
      const node = element('details', 'agents-disclosure');
      const heading = element('summary', '', title);
      const body = element('div', 'agents-disclosure-body');
      node.append(heading, body);
      result = { node, heading, body };
      this.disclosures.set(key, result);
    }
    result.heading.textContent = title;
    return result;
  }

  render() {
    const tasks = this.tasks.availability === 'ready' ? this.tasks.tasks : [];
    const running = tasks.filter(task => task.status === 'running').length;
    this.count.textContent = this.tasks.availability === 'ready' ? String(running) : '';
    this.count.hidden = this.tasks.availability !== 'ready';
    this.count.parentElement.setAttribute('aria-label',
      `Agents${this.tasks.availability === 'ready' ? `, ${running} running` : ', state unknown'}`);
    this.connection.textContent = this.connected ? '' : 'Disconnected. Retained state may be stale; elapsed updates are paused.';
    this.connection.hidden = this.connected;
    this.taskNotice.textContent = availability(this.tasks, 'tasks');
    this.taskNotice.hidden = !this.taskNotice.textContent;
    this.clockRows = [];
    const ordered = [...tasks].sort((a, b) => Number(terminal.has(a.status)) - Number(terminal.has(b.status)));
    const activeIds = new Set();
    const children = [];
    for (const task of ordered) {
      if (activeIds.has(task.task_id)) continue;
      activeIds.add(task.task_id);
      let row = this.rows.get(task.task_id);
      if (!row) {
        row = element('article', 'agents-task');
        row.dataset.taskId = task.task_id;
        row.append(element('p', 'agents-task-summary'), element('p', 'agents-task-model'),
          element('p', 'agents-task-status'), element('p', 'agents-task-activity'));
        this.rows.set(task.task_id, row);
      }
      const [title, modelLabel, status, activity] = row.children;
      title.textContent = summary(task);
      modelLabel.textContent = model(task);
      this.clockRows.push({ task, status });
      const progress = task.live_progress;
      activity.textContent = [progress?.activity, progress?.current_tool,
        progress?.turns != null ? `${progress.turns} turns` : null,
        progress?.tool_calls != null ? `${progress.tool_calls} tool calls` : null].filter(value => value != null && value !== '').join(' · ') || 'Recent activity unavailable';
      children.push(row);
    }
    for (const id of this.rows.keys()) if (!activeIds.has(id)) this.rows.delete(id);
    reconcile(this.taskList, children);
    this.renderDag(tasks);
    this.syncClock();
  }

  renderDag(tasks) {
    this.dagNotice.textContent = availability(this.dag, 'runs');
    this.dagNotice.hidden = !this.dagNotice.textContent;
    const byTask = new Map(tasks.map(task => [task.task_id, task]));
    const keys = new Set(['dag']);
    const runs = [];
    for (const run of this.dag.availability === 'ready' ? this.dag.runs : []) {
      const key = `run:${run.run_id}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const disclosure = this.disclosure(key, `${run.name || run.run_id} · ${run.status}`);
      const nodes = [];
      for (const node of run.nodes) {
        const nodeKey = `${key}:node:${node.id}`;
        if (keys.has(nodeKey)) continue;
        keys.add(nodeKey);
        const detail = this.disclosure(nodeKey, `${node.label || node.id} · ${node.state}`);
        detail.node.dataset.nodeId = node.id;
        if (!detail.body.childElementCount) detail.body.append(element('p', ''), element('p', ''), element('p', ''));
        const [prompt, dependencies, linked] = detail.body.children;
        prompt.textContent = node.prompt;
        dependencies.textContent = node.depends_on.length ? `Depends on: ${[...new Set(node.depends_on)].join(', ')}` : 'No dependencies';
        const task = byTask.get(node.task_id);
        linked.textContent = task ? `Agent ${node.task_id}: ${summary(task)} · ${model(task)}` :
          node.task_id ? `Agent ${node.task_id}: task details unavailable` : 'No agent assigned';
        nodes.push(detail.node);
      }
      reconcile(disclosure.body, nodes);
      runs.push(disclosure.node);
    }
    // Flat identity-based nodes express dependencies without recursively following cycles.
    reconcile(this.dagList, runs);
    for (const key of this.disclosures.keys()) if (!keys.has(key)) this.disclosures.delete(key);
  }

  tick() {
    for (const { task, status } of this.clockRows) {
      const start = Date.parse(task.created_at);
      const end = terminal.has(task.status) ? Date.parse(task.updated_at) : Date.now();
      const seconds = Math.floor((end - start) / 1000);
      const duration = Number.isFinite(seconds) && seconds >= 0
        ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : 'unavailable';
      const waiting = task.awaiting_input === undefined ? '' : ' · Waiting for user input';
      status.textContent = `${task.status}${waiting} · Elapsed ${duration}`;
    }
  }

  syncClock() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (!this.visible || !this.connected || document.hidden) return;
    this.tick();
    if (this.clockRows.some(({ task }) => !terminal.has(task.status))) {
      this.timer = setInterval(() => this.tick(), 1000);
    }
  }

  destroy() {
    this.visible = false;
    this.syncClock();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
