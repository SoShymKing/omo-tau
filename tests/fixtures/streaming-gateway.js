export async function createStreamingGateway({
  holdSelection = false, entries = [], history = { before: null }, earlierEntries = [],
} = {}) {
  const index = await Bun.file(new URL('../../public/index.html', import.meta.url)).text();
  const session = {
    sessionId: 'streaming-test', sessionFile: 'streaming-test.jsonl',
    epoch: 'streaming-test-epoch', cwd: 'C:/streaming-test',
    status: 'ready', isStreaming: false,
  };
  let socket;
  let seq = 0;
  let barrier = 0;
  let pendingSelection = null;
  const commands = [];
  const selectionWaiters = new Set();
  function acknowledge() {
    if (!pendingSelection) throw new Error('No held selection');
    socket.send(JSON.stringify({
      ...session, type: 'mirror_sync', id: pendingSelection.id, seq,
      entries, history, todoState: null,
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
      if (pathname === '/api/sessions') return Response.json({ projects: [] });
      if (pathname.startsWith('/api/sessions/')) {
        return Response.json(new URL(request.url).searchParams.has('before')
          ? { entries: earlierEntries, history: { before: null } }
          : { entries, history });
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
        seq = 0;
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
        socket.send(JSON.stringify({ ...session, type: 'event', seq: ++seq, event }));
      }
      socket.send(JSON.stringify({
        type: 'response', command: 'qa_barrier', id, success: true,
      }));
      return id;
    },
    nextBarrier() { return `barrier-${barrier + 1}`; },
    disconnect() { socket.close(); },
    close() {
      socket?.close();
      server.stop(true);
    },
  };
}
