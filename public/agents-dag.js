import { prepareDag, layoutDag } from './agents-dag-layout.js';
import { element, text, reconcile, model } from './agents-ui-model.js';
export { prepareDag, layoutDag } from './agents-dag-layout.js';

/** Signature scan has no graph traversal; prepare/layout run only on structural changes. */
function signature(run) {
  if (!run) return '';
  if (run.nodes.length > 200) return JSON.stringify([run.run_id, 'oversize', run.nodes.length, run.edges?.length]);
  const records = new Map(), duplicates = [];
  for (const node of run.nodes) {
    if (records.has(node.id)) {
      const key = value => JSON.stringify(Object.keys(value).sort().map(name => [name, value[name]]));
      duplicates.push([node.id, key(records.get(node.id)) === key(node)]);
    } else records.set(node.id, node);
  }
  return JSON.stringify([run.tau_owner_session_id, run.run_id,
    run.nodes.map(node => [node.id, node.depends_on]), run.edges, duplicates]);
}
export class AgentsDagView {
  constructor(container, { onSelect, onFollow }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onFollow = onFollow;
    this.visible = false;
    this.buttons = new Map();
    this.paths = new Map();
    /** @type {{ nodeId?: string }} */
    this.selection = {};
    this.prepared = null;
    this.layout = null;
    this.key = null;
    this.width = 0;
    this.frame = null;
    this.notice = element('p', 'agents-notice');
    this.notice.setAttribute('role', 'status');
    this.stage = element('div', 'agents-dag-stage');
    this.groupLayer = element('div', 'agents-dag-groups');
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.setAttribute('focusable', 'false');
    this.svg.classList.add('agents-dag-edges');
    this.defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    for (const [name, value] of Object.entries({
      id: 'agents-dag-arrow', viewBox: '0 0 8 8', refX: '8', refY: '4',
      markerWidth: '8', markerHeight: '8', markerUnits: 'userSpaceOnUse', orient: 'auto',
    })) marker.setAttribute(name, value);
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    arrow.setAttribute('points', '0,0 8,4 0,8');
    arrow.setAttribute('fill', 'context-stroke');
    marker.append(arrow);
    this.defs.append(marker);
    this.stage.append(this.svg, this.groupLayer);
    this.measure = element('div', 'agents-dag-measure');
    this.stage.append(this.measure);
    this.dependencies = element('details', 'agents-disclosure agents-dag-dependencies');
    this.dependencySummary = element('summary');
    this.dependencyList = element('ul');
    this.dependencies.append(this.dependencySummary, this.dependencyList);
    this.dependencyRows = new Map();
    container.append(this.notice, this.stage, this.dependencies);
    this.click = event => {
      const button = event.target.closest('button[data-node-id]');
      if (button && container.contains(button) && this.active()) this.onSelect(button.dataset.nodeId);
    };
    container.addEventListener('click', this.click);
    this.resize = new ResizeObserver(() => {
      if (!this.active() || !this.prepared || this.frame !== null) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        if (this.active()) this.place();
      });
    });
    this.resize.observe(container);
  }
  active() { return this.visible && !document.hidden; }
  setVisible(visible) {
    if (visible && !this.visible) this.widthDirty = true;
    this.visible = visible;
    if (!visible && this.frame !== null) cancelAnimationFrame(this.frame);
    if (!visible) this.frame = null;
  }
  release() {
    const select = document.getElementById('agents-dag-select');
    select?.focus({ preventScroll: true });
    const message = 'Selected node removed. Choose another workflow or node.';
    if (!this.notice.textContent.includes(message)) text(this.notice, [this.notice.textContent, message].filter(Boolean).join(' '));
    this.notice.hidden = false;
  }
  replace(run, tasks, selection = {}) {
    if (!this.active()) return;
    if (run?.run_id !== this.run?.run_id) {
      if (this.stage.contains(document.activeElement)) this.release();
      this.buttons.clear();
      this.paths.clear();
    }
    this.run = run;
    this.selection = selection;
    const write = selection.write || text;
    const nextKey = signature(run);
    const changed = nextKey !== this.key;
    if (changed) {
      this.key = nextKey;
      this.prepared = run ? prepareDag(run) : null;
      this.layout = null;
      this.width = 0;
    }
    this.container.dataset.runId = run?.run_id || '';
    const state = this.prepared?.error?.kind || (this.prepared?.orderedIds.length ? 'ready' : 'empty');
    this.container.dataset.dagState = state;
    const error = this.prepared?.error;
    const messages = {
      empty: run ? 'No nodes in this workflow' : '',
      oversize: `${run?.nodes.length || 0} observed nodes, ${run?.edges?.length ?? 'dependency-derived'} edges. Limits: 200 nodes / 400 unique edges. No partial graph.`,
      cycle: 'Cycle in dependencies; graph unavailable. Inspect nodes below.',
      missing: 'Missing dependency or mismatched edges; graph unavailable. Inspect nodes below.',
      duplicate: 'Conflicting duplicate node IDs; graph unavailable. Inspect nodes below.',
    };
    write(this.notice, (messages[state] || '') + (error?.ids.length ? ` IDs: ${error.ids.join(', ')}` : ''), 1200);
    this.notice.hidden = !this.notice.textContent;
    const nodes = new Map((run?.nodes || []).slice(0, 200).map(node => [node.id, node]));
    const ids = state === 'oversize' ? [] : (this.prepared?.orderedIds || []);
    const order = [...ids].sort((a, b) => (this.prepared.ranks.get(a) || 0) - (this.prepared.ranks.get(b) || 0));
    const buttons = [];
    for (const id of order) {
      const node = nodes.get(id);
      let button = this.buttons.get(id);
      if (!button) {
        button = element('button', 'agents-dag-node');
        button.type = 'button';
        button.dataset.nodeId = id;
        button.append(element('span', 'agents-dag-label'), element('span', 'agents-dag-status'),
          element('span', 'agents-dag-predecessors'));
        this.buttons.set(id, button);
      }
      write(button.children[0], node.label || id, 64);
      write(button.children[1], node.state, 24);
      const predecessors = [...new Set(node.depends_on || [])];
      write(button.children[2], predecessors.length
        ? `Depends on: ${predecessors.slice(0, 2).join(', ')}${predecessors.length > 2 ? ` (+${predecessors.length - 2})` : ''}`
        : 'No dependencies', 96);
      const task = tasks.get(node.task_id);
      button.setAttribute('aria-label', `${id}: ${node.label || id}, ${node.state}${task ? ', ' + model(task) : ''}`.slice(0, 512));
      button.setAttribute('aria-pressed', String(id === selection.nodeId));
      button.dataset.state = node.state;
      button.classList.toggle('is-followed', id === selection.followId);
      buttons.push(button);
    }
    for (const id of this.buttons.keys()) if (!ids.includes(id)) this.buttons.delete(id);
    this.stage.classList.toggle('is-fallback', !!error);
    this.svg.toggleAttribute('hidden', !!error || !ids.length);
    this.dependencies.hidden = !!error || !this.prepared?.edges.length;
    write(this.dependencySummary, `Dependencies (${this.prepared?.edges.length || 0})`, 48);
    const dependencyRows = [];
    for (const edge of error ? [] : (this.prepared?.edges || [])) {
      const key = JSON.stringify([edge.from, edge.to]);
      let row = this.dependencyRows.get(key);
      if (!row) {
        row = element('li');
        row.append(element('span'), document.createTextNode(' -> '), element('span'));
        this.dependencyRows.set(key, row);
      }
      write(row.children[0], edge.from);
      write(row.children[1], edge.to);
      dependencyRows.push(row);
    }
    reconcile(this.dependencyList, dependencyRows);
    const wantedDependencies = new Set(dependencyRows);
    for (const [key, row] of this.dependencyRows) if (!wantedDependencies.has(row)) this.dependencyRows.delete(key);
    if (error || !ids.length) {
      this.paths.clear();
      reconcile(this.svg, []);
      reconcile(this.groupLayer, []);
      this.stage.style.removeProperty('height');
      this.stage.style.removeProperty('width');
      for (const button of buttons) button.removeAttribute('style');
    }
    reconcile(this.stage, [this.svg, this.groupLayer, this.measure, ...buttons], () => this.release());
    if (!error && ids.length && (changed || !this.layout || this.widthDirty)) this.place();
    this.highlight();
  }
  place() {
    if (!this.active() || !this.prepared || this.prepared.error || !this.prepared.orderedIds.length) return;
    const width = this.container.clientWidth;
    if (width <= 0) return;
    this.widthDirty = false;
    if (this.layout && width === this.width) return;
    const style = getComputedStyle(this.measure);
    const geometry = {
      nodeMinWidth: parseFloat(style.width), nodeHeight: parseFloat(style.height),
      gap: parseFloat(style.columnGap), gutter: parseFloat(style.paddingLeft),
    };
    const resolved = Object.values(geometry).every(value => value > 0);
    this.layout = layoutDag(this.prepared, width, resolved ? geometry : {});
    this.width = width;
    this.stage.style.width = `${this.layout.width}px`;
    this.stage.style.height = `${this.layout.height}px`;
    this.svg.setAttribute('viewBox', `0 0 ${this.layout.width} ${this.layout.height}`);
    const paths = [];
    for (const edge of this.layout.edges) {
      const key = JSON.stringify([edge.from, edge.to]);
      let path = this.paths.get(key);
      if (!path) {
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.paths.set(key, path);
      }
      path.setAttribute('d', edge.path);
      path.setAttribute('marker-end', 'url(#agents-dag-arrow)');
      path.dataset.from = edge.from;
      path.dataset.to = edge.to;
      paths.push(path);
    }
    reconcile(this.svg, [this.defs, ...paths]);
    const wanted = new Set(this.layout.edges.map(edge => JSON.stringify([edge.from, edge.to])));
    for (const key of this.paths.keys()) if (!wanted.has(key)) this.paths.delete(key);
    for (const [id, box] of this.layout.nodes) {
      const button = this.buttons.get(id);
      Object.assign(button.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
    }
    const groups = [];
    for (const group of this.layout.groups) {
      const cue = element('div', 'agents-dag-group');
      cue.append(element('span', '', `Stage ${group.rank + 1} \u00b7 ${group.count} parallel nodes`));
      Object.assign(cue.style, { left: `${group.x}px`, top: `${group.y}px`, width: `${group.width}px`, height: `${group.height}px` });
      groups.push(cue);
    }
    reconcile(this.groupLayer, groups);
    this.highlight();
  }
  highlight() {
    const id = this.selection?.nodeId;
    this.svg.classList.toggle('has-selection', !!id);
    for (const path of this.paths.values()) {
      path.classList.toggle('is-related', !!id && (path.dataset.from === id || path.dataset.to === id));
    }
  }
  destroy() {
    this.setVisible(false);
    this.resize.disconnect();
    this.container.removeEventListener('click', this.click);
    this.buttons.clear();
    this.paths.clear();
    this.dependencyRows.clear();
    this.prepared = this.layout = this.run = null;
  }
}
