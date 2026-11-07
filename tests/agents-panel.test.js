import { afterEach, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

let gateway;
let view;
const evaluate = (fn, args = null) => view.evaluate(`(${fn.toString()})(${JSON.stringify(args)})`);
const task = {
  task_id: 'agent-one', model: 'base/model',
  effective_model: { provider: 'effective', model_id: 'model', display: 'effective/model', source: 'explicit' },
  status: 'completed', created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:02:05Z',
  task_summary: '<img src=x onerror=alert(1)>', live_progress: { activity: '<script>bad()</script>' },
};
const state = (tasks = [task]) => ({
  agentsState: { availability: 'ready', parent_session_id: 'owner', tasks },
  dagState: { availability: 'ready', parent_session_id: 'owner', runs: [] },
});
async function ready() {
  await evaluate(() => new Promise((resolve, reject) => {
    const check = () => !document.getElementById('attach-btn').disabled;
    if (check()) return resolve(true);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Session not ready')); }, 5000);
    const observer = new MutationObserver(() => {
      if (!check()) return;
      clearTimeout(timer); observer.disconnect(); resolve(true);
    });
    observer.observe(document.body, { subtree: true, attributes: true });
  }));
}
async function open(snapshot = state(), options = {}) {
  gateway = await createStreamingGateway({ holdSelection: true, ...options });
  gateway.setSnapshot(snapshot);
  view = new Bun.WebView({ width: 1440, height: 900 });
  await view.navigate(gateway.server.url.href);
  await gateway.nextSelection();
  gateway.acknowledge();
  await ready();
  await view.click('#agents-sidebar-toggle');
}
async function replace(snapshot) {
  await evaluate(id => {
    window.delivered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Missing event barrier')), 3000);
      function onMessage(event) {
        if (JSON.parse(event.data).id !== id) return;
        clearTimeout(timer); qaSocket.removeEventListener('message', onMessage); resolve(true);
      }
      qaSocket.addEventListener('message', onMessage);
    });
  }, gateway.nextBarrier());
  gateway.send([{ type: 'agents_state', ...snapshot }]);
  await view.evaluate('window.delivered');
}
afterEach(async () => {
  if (view) await view.close();
  gateway?.close();
  view = null;
  gateway = null;
});

test('actual app first Agents open exposes selector and graph, then preserves explicit collapse', async () => {
  const first = { run_id: 'first', name: 'First workflow', status: 'running',
    nodes: [{ id: 'verify', prompt: 'Verify first workflow', state: 'running', depends_on: [] }] };
  const second = { run_id: 'second', name: 'Second workflow', status: 'running',
    nodes: [{ id: 'other', prompt: 'Inspect second workflow', state: 'running', depends_on: [] }] };
  const snapshot = { ...state([]), dagState: { availability: 'ready', parent_session_id: 'owner', runs: [first, second] } };
  // open() serves index.html/app.js, acknowledges the session and clicks only Agents.
  await open(snapshot);
  const firstOpen = await evaluate(() => ({
    open: document.querySelector('#agents-panel > details:last-of-type').open,
    selectorVisible: document.getElementById('agents-dag-select').checkVisibility(),
    selectorEnabled: !document.getElementById('agents-dag-select').disabled,
    run: document.querySelector('#agents-panel [data-run-id]').dataset.runId,
    nodes: [...document.querySelectorAll('#agents-panel button[data-node-id]')].map(button => button.dataset.nodeId),
    state: document.querySelector('#agents-panel [data-dag-state]').dataset.dagState,
  }));
  expect(firstOpen).toEqual({ open: true, selectorVisible: true, selectorEnabled: true,
    run: 'first', nodes: ['verify'], state: 'ready' });
  console.info('C2 actual app first-open evidence:', JSON.stringify(firstOpen));
  // Exercise C2's selector directly; no disclosure action or forced .open assignment.
  await evaluate(() => {
    const select = document.getElementById('agents-dag-select');
    select.focus({ preventScroll: true });
    select.value = 'second';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(await evaluate(() => ({
    run: document.querySelector('#agents-panel [data-run-id]').dataset.runId,
    nodes: [...document.querySelectorAll('#agents-panel button[data-node-id]')].map(button => button.dataset.nodeId),
    focus: document.activeElement.id,
  }))).toEqual({ run: 'second', nodes: ['other'], focus: 'agents-dag-select' });
  await view.click('#agents-panel > details:last-of-type > summary');
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  await evaluate(() => {
    const graph = document.querySelector('#agents-panel .agents-dag');
    window.closedGraphHTML = graph.innerHTML;
    window.closedGraphObserver = new MutationObserver(() => {});
    closedGraphObserver.observe(graph, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  await replace({ ...snapshot, dagState: { ...snapshot.dagState, runs: [first, {
    ...second, nodes: [{ id: 'latest', prompt: 'Latest second workflow', state: 'pending', depends_on: [] }],
  }] } });
  await view.click('#agents-sidebar-close');
  await view.click('#agents-sidebar-toggle');
  expect(await evaluate(() => ({
    open: document.querySelector('#agents-panel > details:last-of-type').open,
    unchanged: document.querySelector('#agents-panel .agents-dag').innerHTML === closedGraphHTML,
    mutations: closedGraphObserver.takeRecords().length,
  }))).toEqual({ open: false, unchanged: true, mutations: 0 });
  await evaluate(() => closedGraphObserver.disconnect());
  await view.click('#agents-panel > details:last-of-type > summary');
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  expect(await evaluate(() => [...document.querySelectorAll('#agents-panel button[data-node-id]')]
    .map(button => button.dataset.nodeId))).toEqual(['latest']);
});

test('renders task model state elapsed summary with hostile strings as text', async () => {
  await open(state([task, { ...task, task_id: 'invalid-time', task_summary: '', description: 'Description fallback',
    effective_model: undefined, created_at: 'not a date', live_progress: undefined }]));
  const result = await evaluate(() => ({
    rows: [...document.querySelectorAll('.agents-task')].map(row => [...row.children].map(child => child.textContent)),
    unsafe: document.querySelectorAll('#agents-panel img, #agents-panel script').length,
    count: document.getElementById('agents-running-count').textContent,
  }));
  expect(result.rows).toEqual([
    [task.task_summary, 'effective/model', 'completed · Elapsed 2m 05s', '<script>bad()</script>'],
    ['Description fallback', 'base/model', 'completed · Elapsed unavailable', 'Recent activity unavailable'],
  ]);
  expect(result.unsafe).toBe(0);
  expect(result.count).toBe('0');
});

test.each([
  [undefined, 'paused · Elapsed unavailable'],
  [{ reason: 'resumed_turn_aborted', since: '2026-11-07T00:02:05Z' },
    'paused · Waiting for user input · Elapsed unavailable'],
])('renders optional input-waiting state while preserving upstream status: %j', async (awaiting_input, expected) => {
  await open(state([{ ...task, status: 'paused', created_at: 'invalid', awaiting_input, live_progress: undefined }]));
  expect(await evaluate(() => ({
    status: document.querySelector('.agents-task-status').textContent,
    activity: document.querySelector('.agents-task-activity').textContent,
  }))).toEqual({ status: expected, activity: 'Recent activity unavailable' });
});

test.each([
  ['unknown', { availability: 'unknown' }, 'Agent state unknown. Waiting for an observed snapshot.'],
  ['unavailable', { availability: 'unavailable', reason: 'Attachment failed' }, 'Unavailable. Attachment failed'],
  ['unsupported', { availability: 'unsupported', reason: 'Missing capability' }, 'Unsupported. Missing capability'],
  ['empty', { availability: 'ready', parent_session_id: 'owner', tasks: [] }, 'No child agents in this session.'],
  ['truncated', { availability: 'ready', parent_session_id: 'owner', tasks: [task], truncated_tasks: 3 },
    '3 more tasks omitted. This view is incomplete.'],
])('shows %s availability distinctly', async (_name, agentsState, expected) => {
  await open({ ...state(), agentsState });
  expect(await evaluate(() => document.querySelector('#agents-panel > .agents-notice:not([hidden])').textContent)).toBe(expected);
});

test('preserves cyclic fallback disclosure, deduplication, linked details and focused button across replacements', async () => {
  const nodes = [
    { id: 'left', prompt: 'Left task', state: 'completed', depends_on: ['shared'] },
    { id: 'right', prompt: 'Right task', state: 'running', depends_on: ['shared'] },
    { id: 'shared', prompt: 'Shared task', state: 'running', depends_on: ['left'], task_id: task.task_id },
  ];
  const snapshot = { ...state(), dagState: { availability: 'ready', parent_session_id: 'owner',
    runs: [{ run_id: 'run-one', name: 'Workflow', status: 'running', nodes: [...nodes, nodes[2]] }] } };
  await open(snapshot);
  await evaluate(() => {
    for (const detail of document.querySelectorAll('#agents-panel details')) detail.open = true;
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
  });
  await view.click('button[data-node-id="shared"]');
  await evaluate(() => { window.focusedNode = document.activeElement; });
  await replace({ ...snapshot, agentsState: state([{ ...task, task_summary: 'Updated joined task' }]).agentsState });
  const result = await evaluate(() => ({
    open: [...document.querySelectorAll('#agents-panel details')].map(detail => detail.open),
    ids: [...document.querySelectorAll('[data-node-id]')].map(detail => detail.dataset.nodeId),
    text: document.querySelector('.agents-inspector').innerText,
    focused: document.activeElement === focusedNode,
    fallback: document.querySelector('[data-dag-state]').dataset.dagState,
    edges: document.querySelectorAll('.agents-dag-edges path').length,
  }));
  expect(result.open.every(Boolean)).toBe(true);
  expect(result.ids).toEqual(['left', 'right', 'shared']);
  expect(result.text).toContain('Agent agent-one: Updated joined task · effective/model');
  expect(result.text).toContain('Depends on: left');
  expect(result.focused).toBe(true);
  expect(result.fallback).toBe('cycle');
  expect(result.edges).toBe(0);
});

test('drops stale session generations and stops elapsed clock after teardown', async () => {
  await open(state([]));
  const result = await evaluate(async snapshot => {
    const { AgentsPanel } = await import('/agents-panel.js');
    const container = document.createElement('div');
    const button = document.createElement('button');
    const count = document.createElement('span');
    button.append(count);
    const originalSet = window.setInterval;
    const originalClear = window.clearInterval;
    const originalNow = Date.now;
    const callbacks = new Map();
    let nextId = 0;
    let now = Date.parse('2026-11-07T00:00:10Z');
    window.setInterval = callback => { callbacks.set(++nextId, callback); return nextId; };
    window.clearInterval = id => callbacks.delete(id);
    Date.now = () => now;
    const panel = new AgentsPanel(container, count);
    try {
      panel.selectSession('first');
      panel.setVisible(true);
      panel.replace(snapshot, 'first');
      const running = container.querySelector('.agents-task-status').textContent;
      const runningClocks = callbacks.size;
      panel.setVisible(false);
      const hiddenClocks = callbacks.size;
      panel.setVisible(true);
      panel.setConnected(false);
      const disconnectedClocks = callbacks.size;
      const stale = container.textContent.includes('Retained state may be stale');
      panel.selectSession('second');
      panel.replace(snapshot, 'first');
      const staleRows = container.querySelectorAll('.agents-task').length;
      panel.replace({ ...snapshot, agentsState: { ...snapshot.agentsState,
        tasks: [{ ...snapshot.agentsState.tasks[0], status: 'completed', updated_at: '2026-11-07T00:00:07Z' }] } }, 'second');
      now += 60000;
      panel.tick();
      const frozen = container.querySelector('.agents-task-status').textContent;
      panel.replace(snapshot, 'second');
      panel.destroy();
      return { running, runningClocks, hiddenClocks, disconnectedClocks, stale, staleRows, frozen, finalClocks: callbacks.size };
    } finally {
      panel.destroy();
      window.setInterval = originalSet; window.clearInterval = originalClear; Date.now = originalNow;
    }
  }, state([{ ...task, status: 'running' }]));
  expect(result).toEqual({ running: 'running · Elapsed 0m 10s', runningClocks: 1, hiddenClocks: 0,
    disconnectedClocks: 0, stale: true, staleRows: 0, frozen: 'completed · Elapsed 0m 07s', finalClocks: 0 });
});

test('persists mode independently and defaults closed without valid preference', async () => {
  await open();
  await view.click('#file-sidebar-toggle');
  await view.click('#file-sidebar-close');
  expect(await evaluate(() => ({
    mode: localStorage.getItem('tau-right-sidebar-mode'), open: localStorage.getItem('tau-right-sidebar-open'),
  }))).toEqual({ mode: 'files', open: 'closed' });
  await evaluate(() => {
    localStorage.setItem('tau-right-sidebar-mode', 'invalid');
    localStorage.setItem('tau-right-sidebar-open', 'open');
  });
  await view.navigate(gateway.server.url.href);
  await gateway.nextSelection(); gateway.acknowledge(); await ready();
  expect(await evaluate(() => document.getElementById('right-sidebar').inert)).toBe(true);
});

test('restores saved Files mode once after the selected session is ready', async () => {
  let reads = 0;
  await open(state(), { filesHandler: () => {
    reads++;
    return Response.json({ path: 'C:/fixture', items: [] });
  } });
  await evaluate(() => {
    localStorage.setItem('tau-right-sidebar-mode', 'files');
    localStorage.setItem('tau-right-sidebar-open', 'open');
  });
  await view.navigate(gateway.server.url.href);
  await gateway.nextSelection(); gateway.acknowledge(); await ready();
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  expect(await evaluate(() => ({
    files: document.getElementById('file-sidebar').inert,
    agents: document.getElementById('agents-sidebar').inert,
  }))).toEqual({ files: false, agents: true });
  expect(reads).toBe(1);
});

test('reconnect replays latest snapshot while selection clears the previous view', async () => {
  await open();
  const selected = gateway.nextSelection();
  gateway.disconnect();
  await selected;
  // Closed DOM stays untouched until its permitted flush; no stale view is exposed.
  expect(await evaluate(() => document.getElementById('agents-sidebar').inert)).toBe(true);
  gateway.setSnapshot(state([{ ...task, task_summary: 'Replayed task', status: 'running' }]));
  gateway.acknowledge(); await ready();
  await view.click('#agents-sidebar-toggle');
  expect(await evaluate(() => document.querySelector('.agents-task-summary').textContent)).toBe('Replayed task');
  expect(await evaluate(() => document.querySelectorAll('.agents-task').length)).toBe(1);
  expect(await evaluate(() => document.getElementById('agents-running-count').textContent)).toBe('1');
});

test('selected worker disconnect marks retained agents stale', async () => {
  await open(state([{ ...task, status: 'running' }]));
  await evaluate(() => {
    window.workerDisconnected = new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (!document.getElementById('attach-btn').disabled) return;
        clearTimeout(timer);
        observer.disconnect();
        const notice = document.querySelector('#agents-panel [role="status"]');
        resolve({
          visible: notice.checkVisibility(),
          stale: notice.textContent.includes('Retained state may be stale'),
          rows: document.querySelectorAll('.agents-task').length,
        });
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Selected worker did not disconnect'));
      }, 3000);
      observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    });
  });
  gateway.sendStatus({ status: 'disconnected' });
  expect(await view.evaluate('window.workerDisconnected')).toEqual({ visible: true, stale: true, rows: 1 });
});

test('Files mode retains only latest Agents state without mutating hidden panel', async () => {
  await open(state(), { filesHandler: () => Response.json({ path: 'C:/fixture', items: [] }) });
  await view.click('#file-sidebar-toggle');
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  await evaluate(() => {
    window.hiddenAgentsObserver = new MutationObserver(() => {});
    hiddenAgentsObserver.observe(document.getElementById('agents-panel'), {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
    window.hiddenAgentsHTML = document.getElementById('agents-panel').innerHTML;
  });
  await replace(state([{ ...task, status: 'running', task_summary: 'Intermediate' }]));
  await replace(state([{ ...task, status: 'running', task_summary: 'Latest while Files active' }]));
  expect(await evaluate(() => ({
    records: hiddenAgentsObserver.takeRecords().length,
    unchanged: hiddenAgentsHTML === document.getElementById('agents-panel').innerHTML,
    count: document.getElementById('agents-running-count').textContent,
  }))).toEqual({ records: 0, unchanged: true, count: '1' });
  await evaluate(() => hiddenAgentsObserver.disconnect());
  await view.click('#agents-sidebar-toggle');
  expect(await evaluate(() => document.querySelector('.agents-task-summary').textContent)).toBe('Latest while Files active');
});
