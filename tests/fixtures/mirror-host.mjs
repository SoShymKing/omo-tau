import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import extension from '../../extensions/mirror-server.ts';

const file = process.argv[2];
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
extension({
  on(name, handler) {
    handlers.set(name, [...(handlers.get(name) || []), handler]);
  },
  registerCommand() {},
  getThinkingLevel: () => 'off',
  getSessionName: () => 'History fixture',
  getCommands: () => [],
  events: { on: () => () => {}, emit() {} },
});
const input = createInterface({ input: process.stdin });
input.on('line', async line => {
  const event = JSON.parse(line);
  for (const handler of handlers.get(event.type) || []) await handler(event, ctx);
});
process.stdin.on('end', async () => {
  for (const handler of handlers.get('session_shutdown') || []) await handler({ reason: 'quit' }, ctx);
  input.close();
});
for (const handler of handlers.get('session_start') || []) await handler({}, ctx);
