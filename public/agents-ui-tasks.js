import { element, reconcile, text, summary, model, terminal, elapsed, activity, descendants } from './agents-ui-model.js';

/** Keyed primary rows and one shared inspector; coordinator supplies render gate. */
export class AgentsTaskView {
  constructor(list, completed, inspector, onSelect, onReference) {
    this.list = list;
    this.completed = completed;
    this.inspector = inspector;
    this.rows = new Map();
    this.descendantRows = new Map();
    this.clockRows = [];
    this.click = event => {
      const button = event.target.closest('button[data-task-id]');
      if (button) onSelect(button.dataset.taskId);
    };
    list.addEventListener('click', this.click);
    completed.addEventListener('click', this.click);
    this.reference = event => {
      const button = event.target.closest('button[data-reference-task]');
      if (button) onReference(button.dataset.referenceTask);
    };
    inspector.addEventListener('click', this.reference);
    this.title = element('h3', 'agents-inspector-title', 'Details');
    this.fields = Array.from({ length: 9 }, () => element('p'));
    this.descendants = element('div', 'agents-descendants');
    inspector.append(this.title, ...this.fields, this.descendants);
  }
  render(index, selected, run, write, cached) {
    this.clockRows = [];
    const active = [], done = [];
    const ordered = [...index.roots].sort((a, b) => Number(terminal.has(a.status)) - Number(terminal.has(b.status))).slice(0, 200);
    for (const task of ordered) {
      let row = this.rows.get(task.task_id);
      if (!row) {
        row = element('article', 'agents-task');
        row.dataset.taskId = task.task_id;
        const title = element('p', 'agents-task-summary');
        const button = element('button', 'agents-task-open');
        button.type = 'button';
        button.dataset.taskId = task.task_id;
        title.append(button);
        row.append(title, element('p', 'agents-task-model'), element('p', 'agents-task-status'), element('p', 'agents-task-activity'));
        this.rows.set(task.task_id, row);
      }
      write(row.children[0].firstChild, summary(task), 96);
      write(row.children[1], model(task), 64);
      write(row.children[2], cached ? `${task.status} · Cached; execution unverified` : elapsed(task), 100);
      const missingParent = task.tau_ancestry?.relation === 'unresolved' ||
        (task.tau_ancestry?.relation === 'descendant' && !index.tasks.has(task.parentTaskId));
      write(row.children[3], `${missingParent ? 'Parent details unavailable. ' : ''}${activity(task)}`, 96);
      if (!cached) this.clockRows.push({ task, status: row.children[2] });
      (terminal.has(task.status) ? done : active).push(row);
    }
    const release = () => this.inspector.closest('.agents-panel')?.querySelector('#agents-dag-select')?.focus({ preventScroll: true });
    reconcile(this.list, active, release);
    reconcile(this.completed, done, release);
    const ids = new Set(ordered.map(task => task.task_id));
    for (const id of this.rows.keys()) if (!ids.has(id)) this.rows.delete(id);
    this.renderInspector(index, selected, run, write, cached);
  }
  renderInspector(index, selected, run, write, cached) {
    const node = selected?.nodeId ? run?.nodes.find(node => node.id === selected.nodeId) : null;
    const task = index.tasks.get(selected?.taskId || node?.task_id);
    this.inspector.hidden = !node && !task;
    if (this.inspector.hidden) {
      this.descendantRows.clear();
      reconcile(this.descendants, []);
      for (const field of this.fields) text(field, '');
      return;
    }
    write(this.title, node ? `${node.label || node.id} · ${node.state}` : summary(task), 1000);
    write(this.fields[0], node ? `Prompt: ${node.prompt || 'Unavailable'}` : `Task: ${summary(task)}`);
    write(this.fields[1], node ? (node.depends_on?.length ? `Depends on: ${[...new Set(node.depends_on)].join(', ')}` : 'No dependencies') : 'Standalone agent');
    write(this.fields[2], task ? `Agent ${task.task_id}: ${summary(task)} · ${model(task)}` :
      node?.task_id ? `Agent ${node.task_id}: task details unavailable` : 'No agent assigned');
    write(this.fields[3], task ? (cached ? `${task.status} · Cached; execution unverified` : elapsed(task)) : `Node status: ${node?.state}`, 1000);
    if (task && !cached) this.clockRows.push({ task, status: this.fields[3] });
    write(this.fields[4], task ? activity(task) : 'Recent activity unavailable', 4000);
    const ancestry = task?.tau_ancestry;
    write(this.fields[5], !ancestry ? 'Descendant relationships unavailable' :
      ancestry.relation === 'unresolved' ? 'Parent details unavailable; ancestry unresolved' :
      task.parentTaskId ? `Parent: ${task.parentTaskId}${index.tasks.has(task.parentTaskId) ? '' : ' · Parent details unavailable'}` : 'Direct child of selected session', 1000);
    write(this.fields[6], node ? `Node ${node.id}${run.tau_owner_session_id ? ` · Owner ${run.tau_owner_session_id}` : ''}` : `Task ${task.task_id}`, 1000);
    const result = task ? descendants(index, task.task_id) : { rows: [], omitted: 0, cycle: false };
    write(this.fields[7], `Descendants: ${result.rows.length}${result.omitted ? ` · ${result.omitted} omitted (limit 100)` : ''}${result.cycle ? ' · Ancestry cycle; repeated relationship omitted' : ''}`, 500);
    write(this.fields[8], [node?.attempt != null ? `Attempt: ${node.attempt}` : '',
      run?.amend_count != null ? `Workflow amendments: ${run.amend_count}` : '',
      node?.last_error ? `Last error: ${node.last_error.code}: ${node.last_error.message}` : ''].filter(Boolean).join(' · '));
    const rows = [];
    for (const child of result.rows) {
      let button = this.descendantRows.get(child.task_id);
      if (!button) {
        button = element('button', 'agents-descendant');
        button.type = 'button';
        button.dataset.referenceTask = child.task_id;
        this.descendantRows.set(child.task_id, button);
      }
      const links = index.linked.get(child.task_id);
      const owner = links?.find(link => link.runId === run?.run_id);
      write(button, `${summary(child)} · ${model(child)} · ${child.status} · ${activity(child)}${owner ? ` · Workflow node ${owner.nodeId}` : links?.length ? ` · Workflow ${links[0].runId}` : ''}`, 350);
      rows.push(button);
    }
    reconcile(this.descendants, rows);
    const wanted = new Set(result.rows.map(task => task.task_id));
    for (const id of this.descendantRows.keys()) if (!wanted.has(id)) this.descendantRows.delete(id);
  }
  tick() {
    for (const { task, status } of this.clockRows) text(status, elapsed(task));
  }
  destroy() {
    this.list.removeEventListener('click', this.click);
    this.completed.removeEventListener('click', this.click);
    this.inspector.removeEventListener('click', this.reference);
    this.rows.clear();
    this.descendantRows.clear();
    this.clockRows = [];
  }
}
