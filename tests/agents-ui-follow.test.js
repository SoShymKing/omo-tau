import { afterEach, expect, test } from 'bun:test';
import { harness, node, run, snapshot } from './agents-ui-harness.test.js';
let ui;
afterEach(async () => { await ui?.close(); ui = null; });
const workflow = () => run('one', Array.from({ length: 15 }, (_, index) =>
  node(`step-${index}`, index ? [`step-${index - 1}`] : [], index === 9 || index === 12 ? 'running' : 'pending')));

test('follow retains running identity, advances independently, pauses manually and resumes explicitly', async () => {
  ui = await harness(390);
  await ui.replace(snapshot([], [workflow(), run('other', [node('foreign', [], 'running')])]));
  await ui.graph();
  expect(await ui.evaluate(() => ({ target: panel.followTarget, enabled: panel.followEnabled })))
    .toEqual({ target: 'step-9', enabled: true });
  await ui.evaluate(() => { panel.view.buttons.get('step-1').click(); });
  expect(await ui.evaluate(() => ({ selected: panel.selected.nodeId, enabled: panel.followEnabled })))
    .toEqual({ selected: 'step-1', enabled: false });
  await ui.evaluate(() => panel.resumeFollow());
  await ui.replace(snapshot([], [{ ...workflow(), nodes: workflow().nodes.map(node => ({
    ...node, state: node.id === 'step-3' || node.id === 'step-9' || node.id === 'step-12' ? 'running' : 'pending',
  })) }]));
  expect(await ui.evaluate(() => ({ target: panel.followTarget, selected: panel.selected.nodeId })))
    .toEqual({ target: 'step-9', selected: 'step-1' });
  await ui.evaluate(() => panel.view.buttons.get('step-1').focus({ preventScroll: true }));
  await ui.replace(snapshot([], [{ ...workflow(), nodes: workflow().nodes.map(node => ({
    ...node, state: node.id === 'step-12' ? 'running' : 'completed',
  })) }]));
  expect(await ui.evaluate(() => ({ target: panel.followTarget, selected: panel.selected.nodeId,
    focused: document.activeElement.dataset.nodeId, moved: panel.container.scrollTop > 0 })))
    .toEqual({ target: 'step-12', selected: 'step-1', focused: 'step-1', moved: true });
  await ui.evaluate(() => {
    panel.container.scrollTop = 0;
    panel.container.dispatchEvent(new Event('scroll'));
  });
  expect(await ui.evaluate(() => panel.followEnabled)).toBe(false);
  await ui.view.click('button[data-action="follow"]');
  expect(await ui.evaluate(() => ({ enabled: panel.followEnabled, target: panel.followTarget, selected: panel.selected.nodeId })))
    .toEqual({ enabled: true, target: 'step-12', selected: 'step-1' });
});

test('disconnect suspends movement, timer ticks never move graph, node selection emits no command', async () => {
  ui = await harness();
  await ui.replace(snapshot([], [workflow()]));
  await ui.graph();
  expect(await ui.evaluate(() => {
    const prepared = panel.view.prepared, layout = panel.view.layout;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    let writes = 0;
    Object.defineProperty(panel.container, 'scrollTop', {
      get() { return descriptor.get.call(this); },
      set(value) { writes++; descriptor.set.call(this, value); },
    });
    panel.tick();
    panel.setConnected(false);
    panel.dag.runs[0].nodes[9].state = 'completed';
    panel.render();
    return { writes, prepared: panel.view.prepared === prepared,
      layout: panel.view.layout === layout, target: panel.followTarget, timer: panel.timer };
  })).toEqual({ writes: 0, prepared: true, layout: true, target: 'step-9', timer: null });
  await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  expect(await ui.evaluate(() => panel.followEnabled)).toBe(true);
  await ui.evaluate(() => panel.setConnected(true));
  await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  expect(await ui.evaluate(() => ({ enabled: panel.followEnabled, target: panel.followTarget })))
    .toEqual({ enabled: true, target: 'step-12' });
});

test('run changes pause follow and remember inspector selections without mounting detached graphs', async () => {
  ui = await harness();
  await ui.replace(snapshot([], [run(), run('two', [node('other', [], 'running')])]));
  await ui.graph();
  await ui.evaluate(() => panel.chooseNode('verify'));
  await ui.evaluate(() => { panel.select.value = 'two'; panel.select.dispatchEvent(new Event('change')); });
  expect(await ui.evaluate(() => ({ nodes: [...panel.view.buttons.keys()], selected: panel.selected.nodeId || null,
    enabled: panel.followEnabled }))).toEqual({ nodes: ['other'], selected: null, enabled: false });
  await ui.evaluate(() => panel.chooseNode('other'));
  await ui.evaluate(() => { panel.select.value = 'one'; panel.select.dispatchEvent(new Event('change')); });
  expect(await ui.evaluate(() => ({ nodes: [...panel.view.buttons.keys()], selected: panel.selected.nodeId,
    memories: panel.memories.size }))).toEqual({ nodes: ['plan', 'verify'], selected: 'verify', memories: 2 });
});
