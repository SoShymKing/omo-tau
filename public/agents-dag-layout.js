/** Pure, bounded DAG preparation. Edges always point prerequisite -> dependent. */
const MAX_NODES = 200;
const MAX_EDGES = 400;
const pairKey = (from, to) => JSON.stringify([from, to]);
const recordKey = node => JSON.stringify(Object.keys(node).sort().map(key => [key, node[key]]));

export function prepareDag(run) {
  const orderedIds = [], edges = [], adjacency = new Map(), ranks = new Map();
  const result = { orderedIds, edges, adjacency, ranks, error: null, topologyKey: '' };
  const fail = (kind, ids = []) => {
    result.error = { kind, ids: [...new Set(ids)].slice(0, 16) };
  };
  const finish = () => {
    result.topologyKey = JSON.stringify([
      run?.tau_owner_session_id ?? null, run?.run_id ?? null,
      orderedIds, edges.map(edge => [edge.from, edge.to]).sort(),
      explicit === null ? null : [...explicit].sort(), result.error,
    ]);
    return result;
  };
  let explicit = null;
  const nodes = run?.nodes ?? [];
  if (!Array.isArray(nodes)) {
    fail('missing');
    return finish();
  }
  if (nodes.length > MAX_NODES) {
    fail('oversize');
    // Counts distinguish unsupported structures without traversing their contents.
    result.topologyKey = JSON.stringify([run?.run_id, 'oversize', nodes.length, run?.edges?.length]);
    return result;
  }
  const byId = new Map(), records = new Map(), conflicts = [];
  for (const node of nodes) {
    if (typeof node?.id !== 'string' || !node.id) {
      fail('missing');
      return finish();
    }
    if (byId.has(node.id)) {
      if (records.get(node.id) !== recordKey(node)) conflicts.push(node.id);
      continue;
    }
    byId.set(node.id, node);
    records.set(node.id, recordKey(node));
    orderedIds.push(node.id);
    adjacency.set(node.id, []);
  }
  const unique = new Set(), missing = [];
  for (const id of orderedIds) {
    const dependencies = byId.get(id).depends_on ?? [];
    if (!Array.isArray(dependencies)) {
      missing.push(id);
      continue;
    }
    // Transport structural ceiling bounds even repeated dependency entries.
    if (dependencies.length > 4096) {
      fail('oversize');
      return finish();
    }
    for (const from of dependencies) {
      if (typeof from !== 'string' || !byId.has(from)) missing.push(String(from));
      const key = pairKey(from, id);
      if (unique.has(key)) continue;
      unique.add(key);
      if (unique.size > MAX_EDGES) {
        fail('oversize');
        return finish();
      }
      edges.push({ from, to: id });
    }
  }
  if (run?.edges !== undefined) {
    if (!Array.isArray(run.edges) || run.edges.length > 4096) {
      fail('oversize');
      return finish();
    }
    explicit = new Set();
    for (const edge of run.edges) {
      if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string') {
        missing.push('invalid edge');
        continue;
      }
      explicit.add(pairKey(edge.from, edge.to));
      if (explicit.size > MAX_EDGES) {
        fail('oversize');
        return finish();
      }
      if (!unique.has(pairKey(edge.from, edge.to))) missing.push(edge.from, edge.to);
    }
    for (const edge of edges) {
      if (!explicit.has(pairKey(edge.from, edge.to))) missing.push(edge.from, edge.to);
    }
  }
  if (conflicts.length) fail('duplicate', conflicts);
  else if (missing.length) fail('missing', missing);
  if (result.error) return finish();
  const indegree = new Map(orderedIds.map(id => [id, 0]));
  for (const { from, to } of edges) {
    adjacency.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }
  let frontier = orderedIds.filter(id => indegree.get(id) === 0), consumed = 0, rank = 0;
  while (frontier.length) {
    for (const id of frontier) {
      ranks.set(id, rank);
      consumed++;
      for (const to of adjacency.get(id)) indegree.set(to, indegree.get(to) - 1);
    }
    // Input order within each rank, including joins and disconnected components.
    frontier = orderedIds.filter(id => !ranks.has(id) && indegree.get(id) === 0);
    rank++;
  }
  if (consumed !== orderedIds.length) fail('cycle', orderedIds.filter(id => !ranks.has(id)));
  return finish();
}

/** Exact structural signature; deliberately excludes labels, statuses and metrics. */
export function topologyKey(run) {
  return prepareDag(run).topologyKey;
}

/**
 * Geometry keys: nodeMinWidth, nodeHeight, gap, gutter (CSS pixel numbers).
 * Defaults mirror panel tokens. A hidden/zero-width stage defers all geometry.
 */
export function layoutDag(topology, width, geometry = {}) {
  const nodes = new Map(), edges = [];
  if (!Number.isFinite(width) || width <= 0) return { width: 0, height: 0, nodes, edges };
  const { nodeMinWidth = 132, nodeHeight = 88, gap = 16, gutter = 12 } = geometry;
  if (![nodeMinWidth, nodeHeight, gap, gutter].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('DAG geometry must contain positive finite numbers');
  }
  width = Math.max(width, nodeMinWidth + 2 * gutter);
  if (topology.error || !topology.orderedIds.length) return { width, height: 0, nodes, edges };
  const available = width - 2 * gutter;
  const columns = Math.max(1, Math.floor((available + gap) / (nodeMinWidth + gap)));
  const levels = new Map(), rows = new Map(), groups = [];
  for (const id of topology.orderedIds) {
    const rank = topology.ranks.get(id);
    if (!levels.has(rank)) levels.set(rank, []);
    levels.get(rank).push(id);
  }
  let row = 0, y = gutter;
  for (const [rank, ids] of [...levels].sort(([left], [right]) => left - right)) {
    const top = y;
    if (ids.length > 1) y += 2 * gap;
    for (let start = 0; start < ids.length; start += columns) {
      const members = ids.slice(start, start + columns);
      const cardWidth = (available - (members.length - 1) * gap) / members.length;
      members.forEach((id, index) => {
        nodes.set(id, { x: gutter + index * (cardWidth + gap), y, width: cardWidth, height: nodeHeight });
        rows.set(id, row);
      });
      row++;
      y += nodeHeight + gap;
    }
    if (ids.length > 1) groups.push({
      rank, count: ids.length, x: gutter / 2, y: top,
      width: width - gutter, height: y - gap / 2 - top,
    });
  }
  for (const [index, edge] of topology.edges.entries()) {
    const source = nodes.get(edge.from), target = nodes.get(edge.to);
    const x1 = source.x + source.width / 2, y1 = source.y + source.height;
    const x2 = target.x + target.width / 2, y2 = target.y;
    const exit = y1 + gap / 2, enter = y2 - gap / 2;
    const rail = index % 2 ? width - gutter / 2 : gutter / 2;
    const path = rows.get(edge.to) === rows.get(edge.from) + 1
      ? `M ${x1} ${y1} V ${(y1 + y2) / 2} H ${x2} V ${y2}`
      : `M ${x1} ${y1} V ${exit} H ${rail} V ${enter} H ${x2} V ${y2}`;
    edges.push({ ...edge, path });
  }
  return { width, height: y - gap + gutter, nodes, edges, groups };
}
