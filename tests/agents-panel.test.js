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

test('preserves DAG disclosure and shared-node identity across replacements', async () => {
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
    window.focusedNode = document.querySelector('[data-node-id="shared"] > summary');
    focusedNode.focus();
  });
  await replace({ ...snapshot, agentsState: state([{ ...task, task_summary: 'Updated joined task' }]).agentsState });
  const result = await evaluate(() => ({
    open: [...document.querySelectorAll('#agents-panel details')].map(detail => detail.open),
    ids: [...document.querySelectorAll('[data-node-id]')].map(detail => detail.dataset.nodeId),
    text: document.querySelector('[data-node-id="shared"]').innerText,
    focused: document.activeElement === focusedNode,
  }));
  expect(result.open).toEqual([true, true, true, true, true]);
  expect(result.ids).toEqual(['left', 'right', 'shared']);
  expect(result.text).toContain('Agent agent-one: Updated joined task · effective/model');
  expect(result.text).toContain('Depends on: left');
  expect(result.focused).toBe(true);
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
  expect(await evaluate(() => document.querySelectorAll('.agents-task').length)).toBe(0);
  gateway.setSnapshot(state([{ ...task, task_summary: 'Replayed task', status: 'running' }]));
  gateway.acknowledge(); await ready();
  await view.click('#agents-sidebar-toggle');
  expect(await evaluate(() => document.querySelector('.agents-task-summary').textContent)).toBe('Replayed task');
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
