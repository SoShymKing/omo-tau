import { afterEach, expect, test } from 'bun:test';
import { harness, task, node, run, snapshot } from './agents-ui-harness.test.js';
let ui;
afterEach(async () => { await ui?.close(); ui = null; });

test('selected workflow progress counts unique nodes independently of linked tasks', async () => {
  ui = await harness();
  await ui.replace(snapshot([task('unrelated')], [
    run('one', [node('done', [], 'completed'), node('active', [], 'running'), node('wait'),
      node('blocked', [], 'blocked'), node('active', [], 'running')]),
    run('two', [node('failed', [], 'failed'), node('skip', [], 'skipped')]),
  ]));
  await ui.graph();
  expect(await ui.evaluate(() => panel.runSummary.textContent))
    .toContain('4 unique nodes · Completed: 1/4 · Running: 1 · Pending: 1 · Blocked: 1');
  await ui.evaluate(() => { panel.select.value = 'two'; panel.select.dispatchEvent(new Event('change')); });
  expect(await ui.evaluate(() => panel.runSummary.textContent))
    .toContain('2 unique nodes · Completed: 0/2 · Running: 0 · Pending: 0 · Failed: 1 · Skipped: 1');
});

test('selected run has sole graph; task counts, explicit descendants and global linkage stay distinct', async () => {
  ui = await harness();
  const direct = { relation: 'direct', evidence: 'record' };
  const child = { relation: 'descendant', parent_task_id: 'linked', evidence: 'record' };
  const workflow = run();
  workflow.amend_count = 2;
  Object.assign(workflow.nodes[1], { attempt: 3, last_error: { code: 'retryable', message: '<script>retry</script>' } });
  await ui.replace(snapshot([{ ...task('linked', 'running', direct),
    live_progress: { turns: 2, tool_calls: 3, total_tokens: 1000, output_tokens: 200, tokens_per_second: 20 } }, task('child', 'paused', child),
    task('other-linked', 'pending', direct), task('root', 'completed', direct), task('orphan', 'blocked',
      { ...child, parent_task_id: 'absent' }), task('linked')], [workflow, run('two', [node('other', [], 'pending', 'other-linked')])]));
  await ui.graph();
  await ui.view.click('button[data-node-id="verify"]');
  const result = await ui.evaluate(() => ({
    primary: [...document.querySelectorAll('.agents-task')].map(row => row.dataset.taskId),
    count: document.getElementById('count').textContent,
    counts: panel.counts.textContent,
    inspector: panel.inspector.textContent,
    nodes: [...document.querySelectorAll('button[data-node-id]')].map(button => button.dataset.nodeId),
    edges: panel.view.paths.size,
  }));
  expect(result.primary.sort()).toEqual(['orphan', 'root']);
  expect(result.count).toBe('1');
  expect(result.counts).toContain('Pending: 1 · Running: 1 · Completed: 1');
  expect(result.counts).toContain('Paused: 1');
  expect(result.inspector).toContain('Prompt: Prompt verify');
  expect(result.inspector).toContain('Depends on: plan');
  expect(result.inspector).toContain('effective/model');
  expect(result.inspector).toContain('Task child');
  expect(result.inspector).toContain('2 turns · 3 tool calls · 1000 total tokens · 200 output tokens · 20 tokens/s');
  expect(result.inspector).toContain('Attempt: 3 · Workflow amendments: 2 · Last error: retryable: <script>retry</script>');
  expect(result.nodes).toEqual(['plan', 'verify']);
  expect(result.edges).toBe(1);
  await ui.evaluate(() => { panel.select.value = 'two'; panel.select.dispatchEvent(new Event('change')); });
  expect(await ui.evaluate(() => ({
    run: panel.graph.dataset.runId, nodes: [...document.querySelectorAll('button[data-node-id]')].map(button => button.dataset.nodeId),
    follow: panel.follow.getAttribute('aria-pressed'),
  }))).toEqual({ run: 'two', nodes: ['other'], follow: 'false' });
});

test('status-only replacements reuse prepared/layout objects, buttons, paths, focus and disclosure', async () => {
  ui = await harness();
  await ui.replace(snapshot([task('linked')]));
  await ui.graph();
  await ui.view.click('button[data-node-id="verify"]');
  expect(await ui.evaluate(() => {
    const prepared = panel.view.prepared, layout = panel.view.layout;
    const button = panel.view.buttons.get('verify'), path = [...panel.view.paths.values()][0];
    const place = panel.view.place;
    let placements = 0;
    panel.view.place = function (...args) { placements++; return place.apply(this, args); };
    for (let index = 0; index < 100; index++) panel.replace({
      agentsState: { availability: 'ready', tasks: [{ task_id: 'linked', status: 'running', model: `model-${index}` }] },
      dagState: { availability: 'ready', runs: [{ ...panel.view.run,
        nodes: panel.view.run.nodes.map(node => ({ ...node, label: `${node.id} ${index}`, state: 'running' })) }] },
    }, 'fixture');
    return { prepared: prepared === panel.view.prepared, layout: layout === panel.view.layout,
      button: button === panel.view.buttons.get('verify'), path: path === [...panel.view.paths.values()][0],
      focus: document.activeElement === button, open: panel.dagRoot.node.open,
      model: panel.inspector.textContent.includes('model-99'), placements };
  })).toEqual({ prepared: true, layout: true, button: true, path: true, focus: true, open: true, model: true, placements: 0 });
  await ui.evaluate(() => { window.oldPrepared = panel.view.prepared; window.oldLayout = panel.view.layout; panel.container.style.width = '300px'; });
  await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  expect(await ui.evaluate(() => ({ prepared: oldPrepared === panel.view.prepared, layout: oldLayout !== panel.view.layout,
    errors }))).toEqual({ prepared: true, layout: true, errors: [] });
});

test('closed and document-hidden replacements have zero panel mutations, timers, frames or graph work', async () => {
  ui = await harness();
  await ui.replace(snapshot([task('linked')]));
  await ui.graph();
  expect(await ui.evaluate(async () => {
    panel.setVisible(false);
    const before = panel.container.innerHTML, prepared = panel.view.prepared, layout = panel.view.layout;
    const observer = new MutationObserver(() => {});
    observer.observe(panel.container, { subtree: true, childList: true, attributes: true, characterData: true });
    const originalFrame = window.requestAnimationFrame;
    let frames = 0;
    window.requestAnimationFrame = callback => { frames++; return originalFrame(callback); };
    for (let index = 0; index < 20; index++) {
      panel.replace({ agentsState: { availability: 'ready', tasks: [{ task_id: `latest-${index}`, status: 'running' }] },
        dagState: { availability: 'ready', runs: [] } }, 'fixture');
      panel.setConnected(index % 2 === 0);
      panel.tick();
    }
    panel.container.style.width = '300px';
    observer.takeRecords(); // Width change belongs to test; baseline starts afterward.
    await new Promise(resolve => originalFrame(() => originalFrame(resolve)));
    const closed = { mutations: observer.takeRecords().length, timer: panel.timer, frames,
      prepared: prepared === panel.view.prepared, layout: layout === panel.view.layout };
    window.requestAnimationFrame = originalFrame;
    panel.setVisible(true);
    const latest = panel.container.textContent.includes('latest-19');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    observer.takeRecords();
    panel.replace({ agentsState: { availability: 'ready', tasks: [{ task_id: 'hidden-latest', status: 'pending' }] } }, 'fixture');
    panel.setConnected(false); panel.selectSession('next'); panel.replace({ agentsState: { availability: 'ready',
      tasks: [{ task_id: 'switched', status: 'completed' }] } }, 'next');
    const hidden = { mutations: observer.takeRecords().length, timer: panel.timer };
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    const switched = panel.container.textContent.includes('switched') && !panel.container.textContent.includes('latest-19');
    observer.disconnect();
    return { closed, latest, hidden, switched, changedOnlyByWidth: before !== panel.container.innerHTML };
  })).toEqual({ closed: { mutations: 0, timer: null, frames: 0, prepared: true, layout: true }, latest: true,
    hidden: { mutations: 0, timer: null }, switched: true, changedOnlyByWidth: true });
});

test('cached, coverage, ready-empty and unknown remain distinct; cached never runs a clock', async () => {
  ui = await harness();
  const cached = snapshot([task('cached')], [run()], 'cached');
  cached.agentsState.coverage = { incomplete: true, issues: ['location-unverified', 'checkpoint-stale'] };
  await ui.replace(cached);
  await ui.graph();
  expect(await ui.evaluate(() => ({ text: panel.container.textContent, countHidden: panel.count.hidden,
    timer: panel.timer, followDisabled: panel.follow.disabled }))).toMatchObject({
    countHidden: true, timer: null, followDisabled: true,
  });
  expect(await ui.evaluate(() => panel.container.textContent)).toContain('Cached records; execution state unverified');
  expect(await ui.evaluate(() => panel.container.textContent)).toContain('Store location inferred; custom override unverified');
  expect(await ui.evaluate(() => panel.container.textContent)).toContain('Coverage incomplete');
  await ui.replace(snapshot([], []));
  expect(await ui.evaluate(() => panel.container.textContent)).toContain('No child agents in this session.');
  await ui.replace({ agentsState: { availability: 'unknown' }, dagState: { availability: 'unknown' } });
  expect(await ui.evaluate(() => panel.container.textContent)).toContain('Agent state unknown');
  expect(await ui.evaluate(() => ({ emptyClaim: panel.view.notice.textContent.includes('No nodes'),
    countsHidden: panel.counts.hidden }))).toEqual({ emptyClaim: false, countsHidden: true });
});

test('removed focused node releases focus to select and removed run chooses active fallback', async () => {
  ui = await harness();
  await ui.replace(snapshot([], [run(), { ...run('two'), status: 'completed' }]));
  await ui.graph();
  await ui.view.click('button[data-node-id="verify"]');
  await ui.replace(snapshot([], [run('one', [node('plan')]), run('two')]));
  expect(await ui.evaluate(() => document.activeElement.id)).toBe('agents-dag-select');
  await ui.replace(snapshot([], [run('two')]));
  expect(await ui.evaluate(() => ({ run: panel.selectedRunId, notice: panel.connection.textContent })))
    .toEqual({ run: 'two', notice: 'Selected workflow removed; showing available workflow.' });
  await ui.view.click('button[data-node-id="verify"]');
  await ui.replace(snapshot([], [run('three')]));
  expect(await ui.evaluate(() => ({ focused: document.activeElement.id, run: panel.graph.dataset.runId })))
    .toEqual({ focused: 'agents-dag-select', run: 'three' });
});

test('closed workflow defers all topology and node work until expansion', async () => {
  ui = await harness();
  await ui.evaluate(() => { panel.dagRoot.node.open = false; panel.render(); });
  await ui.replace(snapshot([], [run()]));
  expect(await ui.evaluate(() => ({ prepared: panel.view.prepared, buttons: panel.view.buttons.size })))
    .toEqual({ prepared: null, buttons: 0 });
  await ui.graph();
  await ui.evaluate(() => { panel.dagRoot.node.open = false; panel.render(); window.prepared = panel.view.prepared; window.button = panel.view.buttons.get('verify'); });
  await ui.replace(snapshot([], [run('one', [node('new')])]));
  expect(await ui.evaluate(() => ({ prepared: prepared === panel.view.prepared, button: button === panel.view.buttons.get('verify') })))
    .toEqual({ prepared: true, button: true });
  await ui.graph();
  expect(await ui.evaluate(() => [...panel.view.buttons.keys()])).toEqual(['new']);
});

test('first visible open exposes graph selector while explicit collapse persists and defers work', async () => {
  ui = await harness(390);
  await ui.evaluate(() => panel.setVisible(false));
  await ui.replace(snapshot([], [run()]));
  expect(await ui.evaluate(() => ({ prepared: panel.view.prepared, buttons: panel.view.buttons.size })))
    .toEqual({ prepared: null, buttons: 0 });
  await ui.evaluate(() => panel.setVisible(true));
  expect(await ui.evaluate(() => ({ open: panel.dagRoot.node.open,
    select: document.getElementById('agents-dag-select').checkVisibility(),
    nodes: [...panel.view.buttons.keys()], state: panel.graph.dataset.dagState })))
    .toEqual({ open: true, select: true, nodes: ['plan', 'verify'], state: 'ready' });
  await ui.view.click('#agents-dag-select');
  await ui.view.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await ui.view.click('#agents-panel > details:last-of-type > summary');
  await ui.evaluate(() => {
    window.collapsedPrepared = panel.view.prepared;
    window.collapsedLayout = panel.view.layout;
    panel.setVisible(false);
  });
  await ui.replace(snapshot([], [run('one', [node('latest')])]));
  await ui.evaluate(() => panel.setVisible(true));
  expect(await ui.evaluate(() => ({ open: panel.dagRoot.node.open,
    prepared: collapsedPrepared === panel.view.prepared, layout: collapsedLayout === panel.view.layout,
    nodes: [...panel.view.buttons.keys()] })))
    .toEqual({ open: false, prepared: true, layout: true, nodes: ['plan', 'verify'] });
  await ui.view.click('#agents-panel > details:last-of-type > summary');
  await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  expect(await ui.evaluate(() => [...panel.view.buttons.keys()])).toEqual(['latest']);
});
