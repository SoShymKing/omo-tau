import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import extension from '../../extensions/mirror-server.ts';

const sessionArg = process.argv.indexOf('--session');
if (process.env.QA_REQUIRE_AUTO_TITLE === '1' && process.env.TAU_WORKER_NONCE &&
    !process.argv.includes('--auto-title-sessions')) {
  throw new Error('Browser-owned sessions must opt into host auto-titles');
}
const file = sessionArg === -1 ? process.argv[2] : process.argv[sessionArg + 1];
const records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const header = records.shift();
const handlers = new Map();
const ctx = {
  cwd: header.cwd,
  sessionManager: {
    getSessionFile: () => file,
    getSessionId: () => header.id,
    getEntries: () => records,
    getLeafEntry: () => records.at(-1),
    getEntry: id => records.find(entry => entry.id === id),
  },
  model: null,
  isIdle: () => true,
  getContextUsage: () => null,
  ui: {
    setStatus() {},
    notify() {
      const address = globalThis.__tauMirrorRuntime?.server?.address();
      if (address && typeof address === 'object') console.log(`QA_READY ${address.port}`);
    },
  },
  shutdown: () => process.stdin.emit('end'),
};
const api = {
  on(name, handler) {
    handlers.set(name, [...(handlers.get(name) || []), handler]);
  },
  registerCommand() {},
  getThinkingLevel: () => 'off',
  getSessionName: () => records.findLast(entry => entry.type === 'session_info')?.name,
  setSessionName(name) {
    const entry = { type: 'session_info', name };
    records.push(entry);
    appendFileSync(file, '\n' + JSON.stringify(entry) + '\n');
    for (const handler of handlers.get('session_info_changed') || []) {
      void handler({ type: 'session_info_changed', name }, ctx);
    }
  },
  getCommands: () => [],
  events: { on: () => () => {}, emit() {} },
};
extension(api);
const input = createInterface({ input: process.stdin });
input.on('line', async line => {
  const event = JSON.parse(line);
  if (event.type === 'qa_events') {
    for (const item of event.events) {
      if (item.type === 'qa_set_session_name') api.setSessionName(item.name);
      else for (const handler of handlers.get(item.type) || []) await handler(item, ctx);
    }
    console.log(`QA_EVENTS_DONE ${event.id}`);
    return;
  }
  if (event.type === 'qa_worker_command') {
    const session = [...globalThis.__tauMirrorRuntime.sessions.values()]
      .find(item => item.sessionId === event.sessionId);
    if (!session?.child?.stdin) throw new Error('Missing owned worker');
    session.child.stdin.write(JSON.stringify(event.command) + '\n');
    return;
  }
  if (event.type === 'qa_disconnect') {
    globalThis.__tauMirrorRuntime.peer.destroy();
    return;
  }
  if (event.type === 'qa_large_result') {
    const result = { content: [{ type: 'text', text: 'x'.repeat(event.size - 4) + '\uD83D\uDE00\uD55Cz' }] };
    for (const handler of handlers.get('tool_execution_start') || []) {
      await handler({ type: 'tool_execution_start', toolCallId: 'large', toolName: 'qa', args: {} }, ctx);
    }
    for (const handler of handlers.get('tool_execution_end') || []) {
      await handler({ type: 'tool_execution_end', toolCallId: 'large', result, isError: false }, ctx);
    }
    return;
  }
  for (const handler of handlers.get(event.type) || []) await handler(event, ctx);
});
process.stdin.on('end', async () => {
  for (const handler of handlers.get('session_shutdown') || []) await handler({ reason: 'quit' }, ctx);
  input.close();
});
for (const handler of handlers.get('session_start') || []) await handler({}, ctx);
if (process.env.QA_EARLY_EVENT === '1') {
  for (const handler of handlers.get('agent_start') || []) await handler({ type: 'agent_start' }, ctx);
}
