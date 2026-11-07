import { expect, test } from 'bun:test';
import { prepareDag, layoutDag, topologyKey } from '../public/agents-dag-layout.js';

const node = (id, depends_on = []) => ({ id, depends_on, state: 'pending', prompt: id });
const graph = nodes => ({ run_id: 'workflow', nodes });
const fork = () => graph([node('join', ['left', 'right']), node('root'),
  node('right', ['root']), node('left', ['root']), node('alone')]);

test('iterative Kahn ranks preserve input order, fork/join and disconnected roots', () => {
  const topology = prepareDag(fork());
  expect(topology.error).toBeNull();
  expect(topology.orderedIds).toEqual(['join', 'root', 'right', 'left', 'alone']);
  expect([...topology.ranks]).toEqual([['root', 0], ['alone', 0], ['right', 1], ['left', 1], ['join', 2]]);
  expect(topology.adjacency.get('root')).toEqual(['right', 'left']);
  expect(topology.edges).toHaveLength(4);
  expect(prepareDag(fork())).toEqual(topology);
});

test('empty topology is explicit and has no geometry', () => {
  const topology = prepareDag(graph([]));
  expect(topology.error).toBeNull();
  expect(topology.orderedIds).toEqual([]);
  expect(layoutDag(topology, 390)).toEqual({ width: 390, height: 0, nodes: new Map(), edges: [] });
});

test('identical duplicate records dedupe; conflicting duplicate records fail', () => {
  const first = node('a');
  expect(prepareDag(graph([first, { ...first }])).orderedIds).toEqual(['a']);
  expect(prepareDag(graph([first, { ...first, prompt: 'different' }])).error)
    .toEqual({ kind: 'duplicate', ids: ['a'] });
});

test('missing dependencies, self loops and longer cycles produce bounded fallback', () => {
  expect(prepareDag(graph([node('a', ['absent'])])).error).toEqual({ kind: 'missing', ids: ['absent'] });
  expect(prepareDag(graph([node('a', ['a'])])).error).toEqual({ kind: 'cycle', ids: ['a'] });
  const topology = prepareDag(graph(Array.from({ length: 30 }, (_, i) => node(String(i), [String((i + 1) % 30)]))));
  expect(topology.error.kind).toBe('cycle');
  expect(topology.error.ids).toHaveLength(16);
  expect(layoutDag(topology, 390).nodes.size).toBe(0);
});

test('edges dedupe and explicit wire edges must match dependencies as sets', () => {
  const run = graph([node('a'), node('b', ['a', 'a'])]);
  const edge = { from: 'a', to: 'b' };
  expect(prepareDag({ ...run, edges: [edge, edge] }).edges).toEqual([edge]);
  for (const edges of [[], [{ from: 'b', to: 'a' }], [{ from: 'ghost', to: 'b' }]]) {
    expect(prepareDag({ ...run, edges }).error.kind).toBe('missing');
  }
});

test('200 nodes and 400 unique edges supported; exceeding either falls back', () => {
  const nodes = Array.from({ length: 200 }, (_, i) => node(String(i), i < 2 ? [] : ['0', '1']));
  nodes[199].depends_on.push('2', '3', '4', '5');
  expect(prepareDag(graph(nodes)).edges).toHaveLength(400);
  expect(prepareDag(graph(nodes)).error).toBeNull();
  const over = structuredClone(nodes);
  over[199].depends_on.push('6');
  expect(prepareDag(graph(over)).error.kind).toBe('oversize');
  expect(prepareDag(graph([...nodes, node('extra')])).error.kind).toBe('oversize');
});

test('structural key ignores statuses/text/metrics, includes membership, dependency and owner', () => {
  const run = fork();
  const changed = structuredClone(run);
  changed.status = 'completed';
  changed.updated_at = 'later';
  changed.counts = { running: 0 };
  for (const item of changed.nodes) Object.assign(item, { state: 'completed', prompt: 'new', label: 'new', task_id: 'new' });
  expect(topologyKey(changed)).toBe(topologyKey(run));
  expect(topologyKey({ ...run, run_id: 'other' })).not.toBe(topologyKey(run));
  expect(topologyKey({ ...run, tau_owner_session_id: 'other' })).not.toBe(topologyKey(run));
  changed.nodes[0].depends_on = ['root'];
  expect(topologyKey(changed)).not.toBe(topologyKey(run));
  expect(topologyKey(graph([...run.nodes].reverse()))).not.toBe(topologyKey(run));
  const safe = graph([node('["x","y"]'), node('x'), node('y', ['x'])]);
  expect(prepareDag(safe).error).toBeNull();
});

// Parse this orthogonal SVG subset and prove every segment avoids every card interior.
function points(path) {
  const tokens = path.split(' ');
  const result = [[Number(tokens[1]), Number(tokens[2])]];
  for (let i = 3; i < tokens.length; i += 2) {
    const [x, y] = result.at(-1);
    result.push(tokens[i] === 'H' ? [Number(tokens[i + 1]), y] : [x, Number(tokens[i + 1])]);
  }
  return result;
}
function assertGeometry(topology, width, geometry) {
  const layout = layoutDag(topology, width, geometry);
  const rectangles = [...layout.nodes.values()];
  for (const rect of rectangles) {
    expect(Object.values(rect).every(Number.isFinite)).toBe(true);
    expect(rect.width).toBeGreaterThanOrEqual(geometry?.nodeMinWidth ?? 132);
    expect(rect.height).toBe(geometry?.nodeHeight ?? 88);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(layout.width + 1e-8);
    expect(rect.y + rect.height).toBeLessThanOrEqual(layout.height);
  }
  for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
    const a = rectangles[i], b = rectangles[j];
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x ||
      a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  }
  for (const edge of layout.edges) {
    const source = layout.nodes.get(edge.from), target = layout.nodes.get(edge.to);
    const route = points(edge.path);
    expect(route[0]).toEqual([source.x + source.width / 2, source.y + source.height]);
    expect(route.at(-1)).toEqual([target.x + target.width / 2, target.y]);
    expect(target.y).toBeGreaterThan(source.y);
    for (let i = 1; i < route.length; i++) {
      const [x1, y1] = route[i - 1], [x2, y2] = route[i];
      expect([x1, y1, x2, y2].every(Number.isFinite)).toBe(true);
      for (const rect of rectangles) {
        const intersects = x1 === x2
          ? x1 > rect.x && x1 < rect.x + rect.width &&
            Math.max(y1, y2) > rect.y && Math.min(y1, y2) < rect.y + rect.height
          : y1 > rect.y && y1 < rect.y + rect.height &&
            Math.max(x1, x2) > rect.x && Math.min(x1, x2) < rect.x + rect.width;
        expect(intersects).toBe(false);
      }
    }
  }
  return layout;
}

test.each([390, 1440])('finite nonoverlapping faithful routes at width %i', width => {
  assertGeometry(prepareDag(fork()), width);
  const nodes = Array.from({ length: 200 }, (_, i) => node(String(i), i < 25 ? [] : [String(i - 25), '0']));
  const topology = prepareDag(graph(nodes));
  expect(topology.error).toBeNull();
  const before = structuredClone(topology);
  const layout = assertGeometry(topology, width);
  expect(layout).toEqual(layoutDag(topology, width));
  expect(topology).toEqual(before);
});

test('geometry tokens, hidden widths and extremely narrow widths have explicit behavior', () => {
  const topology = prepareDag(fork());
  assertGeometry(topology, 390, { nodeMinWidth: 150, nodeHeight: 100, gap: 20, gutter: 14 });
  expect(layoutDag(topology, 0).nodes.size).toBe(0);
  expect(layoutDag(topology, NaN).width).toBe(0);
  expect(layoutDag(topology, 80).width).toBe(156);
  expect(() => layoutDag(topology, 390, { gap: 0 })).toThrow(RangeError);
});

test('long chain completes iteratively and input remains unchanged', () => {
  const run = graph(Array.from({ length: 200 }, (_, i) => node(String(i), i ? [String(i - 1)] : [])));
  const before = structuredClone(run);
  const topology = prepareDag(run);
  expect(topology.ranks.get('199')).toBe(199);
  assertGeometry(topology, 390);
  expect(run).toEqual(before);
});
