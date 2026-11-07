import { afterEach, expect, test } from 'bun:test';
import { taskIndex, descendants } from '../public/agents-ui-model.js';
import { harness, task, node, run, snapshot } from './agents-ui-harness.test.js';
let ui;
afterEach(async () => { await ui?.close(); ui = null; });

test.each([
  ['empty', []],
  ['missing', [node('one', ['absent'])]],
  ['cycle', [node('one', ['two']), node('two', ['one'])]],
  ['duplicate', [node('one'), { ...node('one'), prompt: 'conflict' }]],
  ['oversize', Array.from({ length: 201 }, (_, index) => node(`node-${index}`))],
])('%s fallback stays truthful without SVG paths', async (expected, nodes) => {
  ui = await harness(390);
  await ui.replace(snapshot([task('observed')], [run('one', nodes)]));
  await ui.graph();
  expect(await ui.evaluate(() => ({ state: panel.graph.dataset.dagState,
    paths: document.querySelectorAll('.agents-dag-edges path').length,
    buttons: panel.view.buttons.size,
    overflow: document.scrollingElement.scrollWidth > innerWidth ||
      panel.container.scrollWidth > panel.container.clientWidth, errors })))
    .toEqual({ state: expected, paths: 0, buttons: expected === 'oversize' ? 0 : new Set(nodes.map(node => node.id)).size,
      overflow: false, errors: [] });
});

test('oversize run collection uses one observed task list with omitted counts', async () => {
  ui = await harness();
  const runs = Array.from({ length: 65 }, (_, index) => run(String(index)));
  await ui.replace(snapshot(Array.from({ length: 256 }, (_, index) => task(`task-${index}`)), runs));
  await ui.graph();
  expect(await ui.evaluate(() => ({
    options: panel.select.options.length, buttons: panel.view.buttons.size,
    rows: document.querySelectorAll('.agents-task').length,
    fallback: panel.limitNotice.textContent,
  }))).toEqual({ options: 64, buttons: 0, rows: 200,
    fallback: 'Observed tasks fallback: workflow linkage exceeds 64 runs / 200 nodes / 400 edges; graph omitted. 56 primary tasks omitted (limit 200).' });
});

test('focused node removal preserves explicit cycle error while releasing focus', async () => {
  ui = await harness();
  await ui.replace(snapshot([], [run()]));
  await ui.graph();
  await ui.view.click('button[data-node-id="verify"]');
  await ui.replace(snapshot([], [run('one', [node('one', ['two']), node('two', ['one'])])]));
  const result = await ui.evaluate(() => ({ notice: panel.view.notice.textContent,
    hidden: panel.view.notice.hidden, focus: document.activeElement.id }));
  expect(result.notice).toContain('Cycle in dependencies');
  expect(result.notice).toContain('Selected node removed');
  expect(result.hidden).toBe(false);
  expect(result.focus).toBe('agents-dag-select');
});

test('maximum graph, primary tasks, descendants and hostile text fit DOM and text bounds', async () => {
  ui = await harness();
  const ancestry = { relation: 'descendant', parent_task_id: 'linked', evidence: 'record' };
  const tasks = [task('linked'), ...Array.from({ length: 101 }, (_, index) => task(`descendant-${index}`, 'running', ancestry)),
    ...Array.from({ length: 200 }, (_, index) => ({ ...task(`root-${index}`), task_summary: '<script>'.repeat(10000) }))];
  const nodes = Array.from({ length: 200 }, (_, index) => ({
    ...node(`node-${index}`, index > 1 ? [`node-${index - 1}`, `node-${index - 2}`] : index ? ['node-0'] : [],
      'pending', index === 0 ? 'linked' : undefined), prompt: '<img onerror=bad()>'.repeat(10000),
  }));
  await ui.replace(snapshot(tasks, [run('one', nodes)]));
  await ui.graph();
  await ui.evaluate(() => panel.chooseNode('node-0'));
  const result = await ui.evaluate(() => ({ elements: panel.container.querySelectorAll('*').length,
    characters: panel.container.textContent.length,
    descendants: document.querySelectorAll('.agents-descendant').length,
    omission: panel.inspector.textContent.includes('1 omitted (limit 100)'),
    truncation: panel.limitNotice.textContent,
    unsafe: document.querySelectorAll('#agents-panel script, #agents-panel img').length,
    nodes: panel.view.buttons.size, primary: panel.taskView.rows.size, errors }));
  expect(result.elements).toBeLessThanOrEqual(4000);
  expect(result.characters).toBeLessThanOrEqual(128000);
  expect(result.descendants).toBe(100);
  expect(result.omission).toBe(true);
  expect(result.truncation).toContain('Text truncated');
  expect(result.unsafe).toBe(0);
  expect(result.nodes).toBe(200);
  expect(result.primary).toBe(200);
  expect(result.errors).toEqual([]);
  console.info('Agents bound evidence:', JSON.stringify(result));
});

test('ancestry uses explicit metadata only, handles orphans/cycles and caps descendants iteratively', () => {
  const child = parent_task_id => ({ relation: 'descendant', parent_task_id, evidence: 'record' });
  const tasks = [task('root'), task('unknown'), task('child', 'running', child('root')),
    task('orphan', 'running', child('absent')), task('cycle-a', 'running', child('cycle-b')),
    task('cycle-b', 'running', child('cycle-a')),
    ...Array.from({ length: 101 }, (_, index) => task(`deep-${index}`, 'pending', child(index ? `deep-${index - 1}` : 'root')))];
  const data = snapshot(tasks, [run('one', [node('a', [], 'running', 'root'), node('b', ['a'], 'pending', 'unknown')])]);
  const index = taskIndex(data.agentsState, data.dagState);
  expect(index.roots.map(task => task.task_id)).toEqual(['orphan', 'cycle-a']);
  expect(index.children.get('root').map(task => task.task_id)).toEqual(['child', 'deep-0']);
  expect(index.children.has('unknown')).toBe(false);
  expect(descendants(index, 'root')).toMatchObject({ omitted: 2 });
  expect(descendants(index, 'cycle-a')).toMatchObject({ cycle: true });
});
