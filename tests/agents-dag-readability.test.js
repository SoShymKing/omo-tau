import { afterEach, expect, test } from 'bun:test';
import { prepareDag, layoutDag } from '../public/agents-dag-layout.js';
import { harness, node, run, snapshot } from './agents-ui-harness.test.js';

let ui;
afterEach(async () => { await ui?.close(); ui = null; });

test.each([312, 1440])('adjacent rows connect within their endpoints at width %i', width => {
  const topology = prepareDag(run('chain', [node('first'), node('second', ['first']), node('last', ['second'])]));
  const layout = layoutDag(topology, width);
  for (const edge of layout.edges) {
    const source = layout.nodes.get(edge.from), target = layout.nodes.get(edge.to);
    const left = Math.min(source.x + source.width / 2, target.x + target.width / 2);
    const right = Math.max(source.x + source.width / 2, target.x + target.width / 2);
    const horizontal = [...edge.path.matchAll(/H ([\d.]+)/g)].map(match => Number(match[1]));
    expect(horizontal.every(x => x >= left && x <= right)).toBe(true);
  }
  for (const box of layout.nodes.values()) {
    expect(box.x).toBe(12);
    expect(box.width).toBe(width - 24);
  }
});

test('uneven physical rows use actual membership without invented dependencies', () => {
  const topology = prepareDag(run('parallel', Array.from({ length: 5 }, (_, index) => node(`peer-${index}`))));
  const layout = layoutDag(topology, 328);
  const last = layout.nodes.get('peer-4');
  expect(last.x).toBe(12);
  expect(last.width).toBe(304);
  expect(layout.nodes.get('peer-0').width).toBe(144);
  expect(layout.edges).toEqual([]);
});

test('wrapped independent nodes share one visible stage cue and no sequential edges', async () => {
  ui = await harness(390);
  await ui.replace(snapshot([], [run('parallel', Array.from({ length: 5 }, (_, index) => node(`peer-${index}`)))]));
  await ui.graph();
  expect(await ui.evaluate(() => {
    const groups = [...panel.graph.querySelectorAll('.agents-dag-group')];
    const cue = groups[0]?.getBoundingClientRect();
    const boxes = [...panel.view.buttons.values()].map(button => button.getBoundingClientRect());
    return { count: groups.length, text: groups[0]?.textContent,
      visible: groups[0]?.checkVisibility() || false,
      enclosed: !!cue && boxes.every(box => box.top >= cue.top && box.bottom <= cue.bottom),
      rows: new Set(boxes.map(box => box.top)).size,
      edges: panel.graph.querySelectorAll('path').length, errors };
  })).toEqual({ count: 1, text: 'Stage 1 · 5 parallel nodes', visible: true, enclosed: true, rows: 3, edges: 0, errors: [] });
  if (process.env.TAU_DAG_EVIDENCE) {
    await Bun.write(`${process.env.TAU_DAG_EVIDENCE}/isolated-mobile-parallel.png`, await ui.view.screenshot());
  }
});

test('adjacent fork paths leave the parallel caption readable', async () => {
  ui = await harness(390);
  await ui.replace(snapshot([], [run('fork', [node('root'), node('left', ['root']), node('right', ['root'])])]));
  await ui.graph();
  const clear = await ui.evaluate(() => {
    const rect = panel.graph.querySelector('.agents-dag-group > span').getBoundingClientRect();
    const stage = panel.view.stage.getBoundingClientRect();
    const caption = { top: rect.top - stage.top, bottom: rect.bottom - stage.top,
      left: rect.left - stage.left, right: rect.right - stage.left };
    const clearance = parseFloat(getComputedStyle(panel.container).getPropertyValue('--panel-space-sm')) / 2;
    return panel.view.layout.edges.every(edge => {
      const tokens = edge.path.split(' ');
      let x = Number(tokens[1]), y = Number(tokens[2]);
      for (let index = 3; index < tokens.length; index += 2) {
        const value = Number(tokens[index + 1]);
        if (tokens[index] === 'H') {
          if (y > caption.top - clearance && y < caption.bottom + clearance &&
            Math.max(x, value) > caption.left && Math.min(x, value) < caption.right) return false;
          x = value;
        } else y = value;
      }
      return true;
    });
  });
  if (process.env.TAU_DAG_EVIDENCE) {
    const tag = process.env.TAU_DAG_CAPTURE_TAG || 'after';
    await Bun.write(`${process.env.TAU_DAG_EVIDENCE}/isolated-mobile-fork-${tag}.png`, await ui.view.screenshot());
  }
  expect(clear).toBe(true);
});

test('selection emphasizes only incident arrows without new layout or path objects', async () => {
  ui = await harness();
  await ui.replace(snapshot([], [run('relations', [node('root'), node('middle', ['root']),
    node('last', ['middle']), node('side', ['root']), node('unrelated')])]));
  await ui.graph();
  await ui.evaluate(() => {
    window.originalLayout = panel.view.layout;
    window.originalPrepared = panel.view.prepared;
    window.originalPaths = [...panel.view.paths.values()];
    window.placements = 0;
    const place = panel.view.place;
    panel.view.place = function (...args) { placements++; return place.apply(this, args); };
  });
  await ui.view.click('button[data-node-id="middle"]');
  expect(await ui.evaluate(() => {
    const paths = [...panel.view.paths.values()];
    const selected = paths.filter(path => path.classList.contains('is-related'));
    const other = paths.find(path => !path.classList.contains('is-related'));
    return { edges: selected.map(path => [path.dataset.from, path.dataset.to]),
      layout: originalLayout === panel.view.layout, prepared: originalPrepared === panel.view.prepared,
      paths: paths.every((path, index) => path === originalPaths[index]), placements,
      emphasis: selected.length > 0 && selected.every(path => getComputedStyle(path).stroke !== getComputedStyle(other).stroke),
      arrows: paths.every(path => {
        const reference = path.getAttribute('marker-end');
        const marker = reference && panel.view.svg.querySelector(reference.slice(4, -1));
        return !!marker?.querySelector('polygon') && marker.getAttribute('orient') === 'auto' &&
          marker.querySelector('polygon').getAttribute('fill') === 'context-stroke';
      }),
      pathCount: panel.view.svg.querySelectorAll('path').length, errors };
  })).toEqual({ edges: [['root', 'middle'], ['middle', 'last']], layout: true, prepared: true,
    paths: true, placements: 0, emphasis: true, arrows: true, pathCount: 3, errors: [] });
  await ui.view.click('button[data-node-id="unrelated"]');
  expect(await ui.evaluate(() => panel.graph.querySelectorAll('path.is-related').length)).toBe(0);
  await ui.view.click('button[data-node-id="middle"]');
  if (process.env.TAU_DAG_EVIDENCE) {
    await Bun.write(`${process.env.TAU_DAG_EVIDENCE}/isolated-desktop-selected.png`, await ui.view.screenshot());
  }
});

test('node predecessors stay bounded and collapsed Dependencies preserve exact literal edges', async () => {
  ui = await harness(390);
  const ids = ['<img src=x onerror=bad()>', 'left', 'right', 'extra'];
  const workflow = run('literal', [...ids.map(id => node(id)), node('join', [...ids, ids[0]])]);
  await ui.replace(snapshot([], [workflow]));
  await ui.graph();
  const result = await ui.evaluate(() => {
    const details = panel.graph.querySelector('details.agents-dag-dependencies');
    const button = panel.view.buttons.get('join');
    const lines = [...(details?.querySelectorAll('li') || [])];
    const box = button.getBoundingClientRect();
    return { summary: details?.querySelector('summary')?.textContent, open: details?.open,
      preview: button.querySelector('.agents-dag-predecessors')?.textContent,
      edges: lines.map(line => [...line.querySelectorAll('span')].map(span => span.textContent)),
      unsafe: panel.graph.querySelectorAll('img, script').length,
      inside: [...button.children].every(child => {
        const rect = child.getBoundingClientRect();
        return rect.top >= box.top && rect.bottom <= box.bottom;
      }), errors };
  });
  expect(result).toEqual({ summary: 'Dependencies (4)', open: false,
    preview: `Depends on: ${ids[0]}, left (+2)`,
    edges: ids.map(id => [id, 'join']), unsafe: 0, inside: true, errors: [] });
  await ui.view.click('.agents-dag-dependencies > summary');
  await ui.replace(snapshot([], [workflow]));
  expect(await ui.evaluate(() => panel.graph.querySelector('.agents-dag-dependencies').open)).toBe(true);
});

test('all 400 exact dependencies fit the existing mounted DOM and text budgets', async () => {
  ui = await harness(390);
  const nodes = Array.from({ length: 200 }, (_, index) => node(String(index), index < 2 ? [] : ['0', '1']));
  nodes[199].depends_on.push('2', '3', '4', '5');
  const workflow = run('maximum', nodes);
  await ui.replace(snapshot([], [workflow]));
  await ui.graph();
  const result = await ui.evaluate(() => ({
    edges: [...panel.graph.querySelectorAll('.agents-dag-dependencies li')]
      .map(row => ({ from: row.children[0].textContent, to: row.children[1].textContent })),
    nodes: panel.view.buttons.size, paths: panel.view.svg.querySelectorAll('path').length,
    elements: panel.container.querySelectorAll('*').length, characters: panel.container.textContent.length, errors,
  }));
  expect(result.edges).toEqual(prepareDag(workflow).edges);
  expect(result.edges).toHaveLength(400);
  expect(result.nodes).toBe(200);
  expect(result.paths).toBe(400);
  expect(result.elements).toBeLessThanOrEqual(4000);
  expect(result.characters).toBeLessThanOrEqual(128000);
  expect(result.errors).toEqual([]);
  console.info('DAG 400-edge evidence:', JSON.stringify({
    edges: result.edges.length, elements: result.elements, characters: result.characters,
  }));
});
