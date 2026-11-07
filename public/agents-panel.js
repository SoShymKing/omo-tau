import { AgentsDagView } from './agents-dag.js';
import { AgentsTaskView } from './agents-ui-tasks.js';
import { element, text, reconcile, textWriter, taskIndex, availability, observed, terminal } from './agents-ui-model.js';
const unknown = () => ({ availability: 'unknown' });
const activeRun = runs => runs.find(run => ['running', 'pending', 'paused', 'scheduled', 'blocked'].includes(run.status)) || runs[0];

/** Selected-session coordinator. Transport generations remain validated upstream. */
export class AgentsPanel {
  constructor(container, count) {
    Object.assign(this, { container, count, tasks: unknown(), dag: unknown(), sessionFile: null,
      connected: false, visible: false, timer: null, dirty: true, reset: false,
      selectedRunId: null, selected: null, followEnabled: true, followTarget: null });
    this.memories = new Map();
    this.options = new Map();
    this.connection = element('p', 'agents-notice');
    this.connection.setAttribute('role', 'status');
    this.taskNotice = element('p', 'agents-notice');
    this.counts = element('p', 'agents-task-counts');
    this.taskList = element('div', 'agents-task-list');
    this.completed = this.disclosure('Completed');
    this.dagRoot = this.disclosure('Workflow DAG');
    this.dagRoot.node.open = true;
    this.dagNotice = element('p', 'agents-notice');
    const label = element('label', 'agents-workflow-label', 'Workflow');
    label.htmlFor = 'agents-dag-select';
    this.select = element('select', 'agents-dag-select');
    this.select.id = 'agents-dag-select';
    this.runSummary = element('p', 'agents-run-summary');
    this.follow = element('button', 'agents-follow', 'Follow running');
    this.follow.type = 'button';
    this.follow.dataset.action = 'follow';
    this.graph = element('div', 'agents-dag');
    this.inspector = element('section', 'agents-inspector');
    this.inspector.setAttribute('aria-label', 'Agent details');
    this.limitNotice = element('p', 'agents-notice');
    this.dagRoot.body.append(this.dagNotice, label, this.select, this.runSummary, this.follow, this.graph);
    container.append(this.connection, this.taskNotice, this.counts, this.taskList, this.completed.node,
      this.dagRoot.node, this.inspector, this.limitNotice);
    this.view = new AgentsDagView(this.graph, { onSelect: id => this.chooseNode(id), onFollow: () => this.resumeFollow() });
    this.taskView = new AgentsTaskView(this.taskList, this.completed.body, this.inspector,
      id => this.chooseTask(id), id => this.referenceTask(id));
    this.change = () => {
      if (!this.allowed()) return;
      this.selectedRunId = this.select.value;
      this.selected = { nodeId: this.memories.get(this.selectedRunId) };
      this.pauseFollow();
      this.followTarget = null;
      this.render();
    };
    this.select.addEventListener('change', this.change);
    this.resume = () => this.resumeFollow();
    this.follow.addEventListener('click', this.resume);
    this.toggle = () => { if (this.allowed()) this.render(); };
    this.dagRoot.node.addEventListener('toggle', this.toggle);
    this.completed.node.addEventListener('toggle', this.toggle);
    this.scroll = () => {
      if (!this.allowed()) return;
      if (this.programmaticTop != null && Math.abs(container.scrollTop - this.programmaticTop) <= 1) {
        this.programmaticTop = null;
        return;
      }
      this.programmaticTop = null;
      this.pauseFollow();
    };
    container.addEventListener('scroll', this.scroll, { passive: true });
    this.manual = () => { if (this.allowed()) { this.programmaticTop = null; this.pauseFollow(); } };
    container.addEventListener('wheel', this.manual, { passive: true });
    container.addEventListener('touchmove', this.manual, { passive: true });
    this.onVisibility = () => { if (this.allowed()) this.render(); else this.suspend(); };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.toolbar();
  }
  disclosure(title) {
    const node = element('details', 'agents-disclosure');
    const heading = element('summary', '', title), body = element('div', 'agents-disclosure-body');
    node.append(heading, body);
    return { node, heading, body };
  }
  allowed() { return this.visible && !document.hidden && !this.destroyed; }
  toolbar() {
    const ready = this.tasks.availability === 'ready';
    const unique = new Map(observed(this.tasks, 'tasks').map(task => [task.task_id, task]));
    const running = [...unique.values()].filter(task => task.status === 'running').length;
    text(this.count, ready ? running : '');
    this.count.hidden = !ready;
    this.count.parentElement.setAttribute('aria-label', `Agents${ready ? `, ${running} running` : ', state unverified'}`);
  }
  selectSession(sessionFile) {
    this.suspend();
    Object.assign(this, { sessionFile, connected: false, tasks: unknown(), dag: unknown(), dirty: true,
      reset: true, selectedRunId: null, selected: null, followEnabled: true, followTarget: null });
    this.memories.clear();
    this.index = null;
    this.view.prepared = this.view.layout = this.view.run = this.view.key = null;
    this.view.buttons.clear();
    this.view.paths.clear();
    this.taskView.rows.clear();
    this.taskView.clockRows = [];
    this.toolbar();
    this.render();
  }
  replace(data, sessionFile) {
    if (sessionFile !== this.sessionFile || this.destroyed) return;
    this.tasks = data.agentsState || unknown();
    this.dag = data.dagState || unknown();
    this.connected = true;
    this.dirty = true;
    this.toolbar();
    this.render();
  }
  setConnected(connected) { this.connected = connected; this.dirty = true; this.render(); if (!connected) this.suspend(); }
  setVisible(visible) { this.visible = visible; if (this.allowed()) this.render(); else this.suspend(); }
  suspend() { if (this.timer !== null) clearInterval(this.timer); this.timer = null; this.view.setVisible(false); }
  pauseFollow() { this.followEnabled = false; if (this.allowed()) this.follow.setAttribute('aria-pressed', 'false'); }
  chooseNode(nodeId) {
    this.pauseFollow();
    this.selected = { nodeId };
    this.memories.delete(this.selectedRunId);
    this.memories.set(this.selectedRunId, nodeId);
    if (this.memories.size > 64) this.memories.delete(this.memories.keys().next().value);
    this.render();
  }
  chooseTask(taskId) { this.pauseFollow(); this.selected = { taskId }; this.render(); }
  referenceTask(taskId) {
    const link = this.index.linked.get(taskId)?.find(link => link.runId === this.selectedRunId);
    if (link) this.chooseNode(link.nodeId); else this.chooseTask(taskId);
  }
  resumeFollow() {
    if (!this.allowed()) return;
    this.followEnabled = true;
    this.followTarget = null;
    this.render();
  }
  render() {
    if (!this.allowed()) return;
    const write = textWriter();
    if (this.reset) {
      this.view.key = null;
      this.taskView.rows.clear();
      this.options.clear();
      this.reset = false;
    }
    this.index = taskIndex(this.tasks, this.dag);
    const { runs, tasks, counts, fallback, roots } = this.index;
    write(this.connection, this.connected ? '' : 'Disconnected. Retained state may be stale; elapsed updates are paused.', 1000);
    this.connection.hidden = this.connected;
    write(this.taskNotice, availability(this.tasks, 'tasks'), 2000);
    this.taskNotice.hidden = !this.taskNotice.textContent;
    write(this.counts, ['pending', 'running', 'completed', ...[...counts.keys()].filter(key => !['pending', 'running', 'completed'].includes(key))]
      .map(key => `${key[0].toUpperCase() + key.slice(1)}: ${counts.get(key) || 0}`).join(' · ') + ` · ${tasks.size} unique observed tasks`, 1000);
    this.counts.hidden = !['ready', 'cached'].includes(this.tasks.availability);
    const choices = runs.slice(0, 64);
    if (!choices.some(run => run.run_id === this.selectedRunId)) {
      const removed = this.selectedRunId !== null;
      this.selectedRunId = activeRun(choices)?.run_id || null;
      this.selected = { nodeId: this.memories.get(this.selectedRunId) };
      this.followTarget = null;
      if (removed) {
        text(this.connection, this.selectedRunId ? 'Selected workflow removed; showing available workflow.' :
          ['ready', 'cached'].includes(this.dag.availability) ? 'Selected workflow removed; no workflow available.' :
            'Workflow state unverified; selection cleared.');
        this.connection.hidden = false;
      }
    }
    const run = choices.find(run => run.run_id === this.selectedRunId);
    if (this.selected?.nodeId && !run?.nodes.some(node => node.id === this.selected.nodeId)) this.selected = null;
    const options = choices.map(run => {
      let option = this.options.get(run.run_id);
      if (!option) { option = element('option'); option.value = run.run_id; this.options.set(run.run_id, option); }
      write(option, `${run.name || run.run_id} · ${run.status}`, 96);
      return option;
    });
    reconcile(this.select, options);
    for (const id of this.options.keys()) if (!choices.some(run => run.run_id === id)) this.options.delete(id);
    this.select.disabled = !choices.length || fallback;
    this.select.value = this.selectedRunId || '';
    write(this.dagNotice, availability(this.dag, 'runs'), 2000);
    this.dagNotice.hidden = !this.dagNotice.textContent;
    write(this.runSummary, this.index.runSummaries.get(run?.run_id) || '', 1500);
    this.follow.setAttribute('aria-pressed', String(this.followEnabled));
    this.follow.disabled = !run || fallback || this.dag.availability !== 'ready';
    this.view.setVisible(this.dagRoot.node.open);
    const oldTarget = this.followTarget;
    if (this.dagRoot.node.open) {
      this.view.replace(fallback ? null : run, tasks, { ...this.selected, followId: this.followTarget, write });
      if (this.connected && this.followEnabled && this.dag.availability === 'ready' && !fallback) {
        const ids = [...(this.view.prepared?.orderedIds || [])].sort((a, b) =>
          (this.view.prepared.ranks.get(a) || 0) - (this.view.prepared.ranks.get(b) || 0));
        const running = new Set(run?.nodes.filter(node => node.state === 'running').map(node => node.id));
        if (!running.has(this.followTarget)) this.followTarget = ids.find(id => running.has(id)) || null;
        for (const [id, button] of this.view.buttons) button.classList.toggle('is-followed', id === this.followTarget);
      }
    }
    this.taskView.render(this.index, this.selected, run, write, this.tasks.availability !== 'ready');
    text(this.completed.heading, `Completed (${this.completed.body.childElementCount})`);
    this.completed.node.hidden = !this.completed.body.childElementCount;
    const limits = [fallback ? 'Observed tasks fallback: workflow linkage exceeds 64 runs / 200 nodes / 400 edges; graph omitted.' : '',
      roots.length > 200 ? `${roots.length - 200} primary tasks omitted (limit 200).` : '',
      write.truncated ? 'Text truncated to presentation limits.' : ''].filter(Boolean).join(' ');
    text(this.limitNotice, limits);
    this.limitNotice.hidden = !limits;
    if (fallback) {
      text(this.runSummary, `${runs.length} observed workflows. ${run?.nodes.length || 0} selected-run nodes. Limits: 64 runs / 200 nodes / 400 unique edges.`);
      if (this.dagRoot.node.open) {
        this.graph.dataset.runId = run?.run_id || '';
        this.graph.dataset.dagState = 'oversize';
        text(this.view.notice, 'Workflow exceeds presentation limits. Observed tasks remain available; no partial graph.');
        this.view.notice.hidden = false;
      }
    }
    if (this.connected && this.followEnabled && this.followTarget !== oldTarget) this.reveal();
    this.dirty = false;
    this.syncClock();
  }
  reveal() {
    const button = this.view.buttons.get(this.followTarget);
    if (!button || !this.allowed() || !this.connected) return;
    const outer = this.container.getBoundingClientRect(), box = button.getBoundingClientRect();
    const offset = box.bottom > outer.bottom ? box.bottom - outer.bottom : box.top < outer.top ? box.top - outer.top : 0;
    if (offset) {
      this.container.scrollTop += offset;
      this.programmaticTop = this.container.scrollTop;
    }
  }
  tick() { if (this.allowed() && this.connected) this.taskView.tick(); }
  syncClock() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.allowed() && this.connected && this.tasks.availability === 'ready' &&
      this.taskView.clockRows.some(({ task }) => !terminal.has(task.status))) this.timer = setInterval(() => this.tick(), 1000);
  }
  destroy() {
    this.destroyed = true;
    this.suspend();
    this.view.destroy();
    this.taskView.destroy();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.select.removeEventListener('change', this.change);
    this.follow.removeEventListener('click', this.resume);
    this.dagRoot.node.removeEventListener('toggle', this.toggle);
    this.completed.node.removeEventListener('toggle', this.toggle);
    this.container.removeEventListener('scroll', this.scroll);
    this.container.removeEventListener('wheel', this.manual);
    this.container.removeEventListener('touchmove', this.manual);
  }
}
