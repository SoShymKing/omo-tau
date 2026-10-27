/**
 * Todo Panel - Read-only rendering of canonical todo state.
 */

export function normalizeTodoState(raw) {
  const empty = { state: 'empty', phases: [], completed: 0, total: 0, current: null, finished: false };
  const unavailable = { ...empty, state: 'unavailable' };
  if (raw === null) return empty;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      raw.schema !== 'v2' || !Array.isArray(raw.phases)) return unavailable;

  const phases = [];
  let completed = 0;
  let total = 0;
  let current = null;
  for (const phase of raw.phases) {
    if (!phase || typeof phase !== 'object' || Array.isArray(phase) ||
        typeof phase.name !== 'string' || !Array.isArray(phase.tasks)) return unavailable;
    const tasks = [];
    for (const task of phase.tasks) {
      if (!task || typeof task !== 'object' || Array.isArray(task) ||
          typeof task.content !== 'string' || typeof task.status !== 'string') return unavailable;
      const normalizedTask = { content: task.content, status: task.status };
      tasks.push(normalizedTask);
      total++;
      if (task.status === 'completed') completed++;
      if (task.status === 'in_progress' && current === null) current = normalizedTask;
    }
    phases.push({ name: phase.name, tasks });
  }
  const finished = total > 0 && phases.every(phase => phase.tasks.every(task =>
    ['completed', 'abandoned', 'cancelled', 'failed'].includes(task.status)));
  return { state: total === 0 ? 'empty' : 'ready', phases, completed, total, current, finished };
}

function renderTodoPhases(container, phases) {
  for (const phase of phases) {
    const section = document.createElement('section');
    section.className = 'todo-panel-phase';
    const heading = document.createElement('h3');
    heading.className = 'todo-panel-phase-name';
    heading.textContent = phase.name;
    const list = document.createElement('ul');
    list.className = 'todo-panel-tasks';
    for (const task of phase.tasks) {
      const row = document.createElement('li');
      row.className = 'todo-panel-task';
      row.dataset.status = ['pending', 'in_progress', 'completed', 'abandoned', 'cancelled', 'failed'].includes(task.status)
        ? task.status : 'unknown';
      const status = document.createElement('span');
      status.className = 'todo-panel-task-status';
      status.textContent = {
        pending: 'Pending', in_progress: 'In progress', completed: 'Completed',
        abandoned: 'Cancelled', cancelled: 'Cancelled', failed: 'Failed',
      }[task.status] || task.status;
      const content = document.createElement('span');
      content.className = 'todo-panel-task-content';
      content.textContent = task.content;
      row.append(status, content);
      list.appendChild(row);
    }
    section.append(heading, list);
    container.appendChild(section);
  }
}

export class TodoHistoryRenderer {
  reset() {
    this.previous = null;
  }

  render(raw, container) {
    const model = normalizeTodoState(raw);
    const key = JSON.stringify(model.phases);
    if (key === this.previous) return;
    this.previous = key;
    if (!model.finished || !container) return;

    const record = document.createElement('details');
    record.className = 'task-history';
    const summary = document.createElement('summary');
    summary.className = 'activity-summary';
    const title = document.createElement('span');
    title.className = 'activity-title';
    title.textContent = 'Tasks';
    const progress = document.createElement('span');
    progress.textContent = `${model.completed}/${model.total}`;
    const outcome = document.createElement('span');
    outcome.className = 'activity-status';
    const statuses = model.phases.flatMap(phase => phase.tasks.map(task => task.status));
    outcome.textContent = statuses.includes('failed') ? 'Failed'
      : statuses.some(status => status === 'abandoned' || status === 'cancelled') ? 'Cancelled'
      : 'Completed';
    summary.append(title, progress, outcome);
    const body = document.createElement('div');
    body.className = 'todo-panel-body';
    renderTodoPhases(body, model.phases);
    record.append(summary, body);
    container.appendChild(record);
  }
}

export class TodoPanelRenderer {
  constructor(container, onToggle) {
    this.container = container;
    this.expanded = false;

    this.toggle = document.createElement('button');
    this.toggle.id = 'todo-panel-toggle';
    this.toggle.className = 'todo-panel-toggle';
    this.toggle.type = 'button';
    this.toggle.setAttribute('aria-controls', 'todo-panel-body');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.addEventListener('click', () => onToggle(!this.expanded));

    const label = document.createElement('span');
    label.className = 'todo-panel-label';
    label.textContent = 'Tasks';
    this.progress = document.createElement('span');
    this.progress.className = 'todo-panel-progress';
    this.current = document.createElement('span');
    this.current.className = 'todo-panel-current';
    this.toggle.append(label, this.progress, this.current);

    this.body = document.createElement('div');
    this.body.id = 'todo-panel-body';
    this.body.className = 'todo-panel-body';
    this.body.setAttribute('role', 'region');
    this.body.setAttribute('aria-labelledby', 'todo-panel-toggle');
    this.body.hidden = true;
    this.container.replaceChildren(this.toggle, this.body);
    this.container.hidden = true;
  }

  render(raw, expanded) {
    const model = normalizeTodoState(raw);
    this.expanded = Boolean(expanded);
    this.container.dataset.state = model.state;
    this.container.hidden = model.state === 'empty' || model.finished;
    this.toggle.setAttribute('aria-expanded', String(this.expanded));
    this.body.hidden = !this.expanded;
    this.progress.textContent = model.state === 'ready' ? `${model.completed}/${model.total}` : '';
    this.current.textContent = model.state === 'unavailable'
      ? 'Task list unavailable'
      : model.current?.content || '';
    this.body.replaceChildren();

    if (model.state === 'unavailable') {
      const message = document.createElement('p');
      message.className = 'todo-panel-unavailable';
      message.textContent = 'Task list unavailable';
      this.body.appendChild(message);
      return;
    }
    if (model.state === 'empty') return;

    renderTodoPhases(this.body, model.phases);
  }
}
