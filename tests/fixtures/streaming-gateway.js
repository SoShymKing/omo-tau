export async function createStreamingGateway({
  holdSelection = false, entries = [], history = { before: null }, earlierEntries = [], historyPages = null,
  projects = [], todoState = null, historyGate = null,
} = {}) {
  const index = await Bun.file(new URL('../../public/index.html', import.meta.url)).text();
  const session = {
    sessionId: 'streaming-test', sessionFile: 'streaming-test.jsonl',
    epoch: 'streaming-test-epoch', cwd: 'C:/streaming-test',
    status: 'ready', isStreaming: false,
    streamStats: { count: 0, lastReceivedAt: null },
  };
  let socket;
  let seq = 0;
  let barrier = 0;
  let pendingSelection = null;
  const commands = [];
  const selectionWaiters = new Set();
  const positions = new WeakMap();
  let endByte = 1;
  function position(entry) {
    if (!positions.has(entry)) {
      positions.set(entry, endByte);
      endByte += new TextEncoder().encode(JSON.stringify(entry)).length + 1;
    }
    return positions.get(entry);
  }
  for (const entry of [
    ...earlierEntries, ...Object.values(historyPages || {}).flatMap(page => page.entries), ...entries,
  ]) position(entry);
  function historyPage(pageEntries, pageHistory) {
    const offsets = pageEntries.map(position);
    return {
      entries: pageEntries,
      history: { ...pageHistory, source: { fileId: session.sessionFile, endByte }, offsets },
    };
  }
  function acknowledge() {
    if (!pendingSelection) throw new Error('No held selection');
    for (const entry of earlierEntries) position(entry);
    socket.send(JSON.stringify({
      ...session, type: 'mirror_sync', id: pendingSelection.id, seq,
      ...historyPage(entries, history), todoState,
      pendingQuestions: [], questionControl: { supported: false },
    }));
    pendingSelection = null;
  }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, server) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/ws') {
        if (server.upgrade(request)) return;
        return new Response('', { status: 400 });
      }
      if (pathname === '/') {
        const instrumentation = `<script>
          window.qaErrors = [];
          window.addEventListener('error', event => qaErrors.push(event.message));
          window.WebSocket = class extends WebSocket {
            constructor(...args) { super(...args); window.qaSocket = this; }
          };
        </script>`;
        return new Response(index
          .replace(/<link\b[^>]*href="https:[^"]*"[^>]*>/g, '')
          .replace(/<script\b[^>]*src="https:[^"]*"[^>]*><\/script>/g, '')
          .replace('<head>', '<head>' + instrumentation), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (pathname === '/api/health') return Response.json({ mode: 'mirror' });
      if (pathname === '/api/instances') return Response.json({ sessions: [session] });
      if (pathname === '/api/sessions') return Response.json({ projects });
      if (pathname.startsWith('/api/sessions/')) {
        const before = new URL(request.url).searchParams.get('before');
        if (before !== null && historyGate) await historyGate(before, request.signal);
        const page = before !== null
          ? historyPages?.[before] || { entries: earlierEntries, history: { before: null } }
          : { entries, history };
        return Response.json(historyPage(page.entries, page.history));
      }
      if (pathname === '/api/rpc') return Response.json({ success: true, data: {} });
      if (pathname === '/sw.js') {
        return new Response('', { headers: { 'Content-Type': 'text/javascript' } });
      }
      const file = Bun.file(new URL(`../../public${pathname}`, import.meta.url));
      return await file.exists() ? new Response(file) : new Response('', { status: 404 });
    },
    websocket: {
      open(ws) {
        socket = ws;
        ws.send(JSON.stringify({
          type: 'state', mode: 'gateway', defaultSessionFile: session.sessionFile,
        }));
      },
      message(ws, raw) {
        const command = JSON.parse(String(raw));
        commands.push(command);
        if (command.type === 'select_session') {
          pendingSelection = command;
          for (const notify of selectionWaiters) notify(command);
          selectionWaiters.clear();
          if (!holdSelection) acknowledge();
        }
      },
    },
  });
  return {
    server,
    commands,
    acknowledge,
    setSnapshot(data) { Object.assign(session, data); },
    nextSelection() {
      if (pendingSelection) return Promise.resolve(pendingSelection);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          selectionWaiters.delete(notify);
          reject(new Error('Selection did not arrive'));
        }, 3000);
        const notify = command => { clearTimeout(timeout); resolve(command); };
        selectionWaiters.add(notify);
      });
    },
    failSelection() {
      if (!pendingSelection) throw new Error('No held selection');
      socket.send(JSON.stringify({ type: 'response', command: 'select_session',
        id: pendingSelection.id, success: false, error: 'fixture-startup-failure' }));
      pendingSelection = null;
    },
    send(events) {
      const id = `barrier-${++barrier}`;
      for (const event of events) {
        if (event.type === 'agent_start') session.isStreaming = true;
        if (event.type === 'agent_end') session.isStreaming = false;
        if (event.streamStats) session.streamStats = event.streamStats;
        socket.send(JSON.stringify({ ...session, type: 'event', seq: ++seq, event }));
      }
      socket.send(JSON.stringify({
        type: 'response', command: 'qa_barrier', id, success: true,
      }));
      return id;
    },
    nextBarrier() { return `barrier-${barrier + 1}`; },
    sendStatus(status) {
      socket.send(JSON.stringify({ ...session, ...status, type: 'session_status' }));
    },
    disconnect() { socket.close(); },
    close() {
      socket?.close();
      server.stop(true);
    },
  };
}
