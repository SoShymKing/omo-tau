import { appendFileSync, readFileSync, mkdirSync, writeFileSync, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Socket, createConnection } from 'node:net';
import { posix, armPosix, releasePosix } from './posix-ipc.mjs';
const { default: extension } = await import('../../extensions/mirror-server.ts');
const { WorkerOwnership } = await import('../../extensions/worker-ownership.ts');
const { spawn } = require('node:child_process');

let admissionMode;
let releaseAdmission;
let heldChild;
let savedOwners;
const admit = WorkerOwnership.prototype.admit;
WorkerOwnership.prototype.admit = async function (child, pid, registration) {
  if (process.env.QA_POSIX_TOPOLOGY) console.log('QA_ADMISSION_ENTER ' + pid);
  if (!admissionMode) return admit.call(this, child, pid, registration);
  const mode = admissionMode;
  admissionMode = undefined;
  heldChild = child;
  await new Promise(resolve => {
    releaseAdmission = resolve;
    console.log(`QA_ADMISSION_WAIT ${pid}`);
  });
  if (mode === 'error' || mode === 'timeout') throw new Error(`OS identity query ${mode}`);
  return admit.call(this, child, pid, registration);
};

const sessionArg = process.argv.indexOf('--session');
if (process.env.QA_REQUIRE_AUTO_TITLE === '1' && process.env.TAU_WORKER_NONCE &&
    !process.argv.includes('--auto-title-sessions')) {
  throw new Error('Browser-owned sessions must opt into host auto-titles');
}
let file = sessionArg === -1 ? process.argv[2] : process.argv[sessionArg + 1];
if (sessionArg === -1 && process.argv.includes('--session-dir')) {
  const dir = process.argv[process.argv.indexOf('--session-dir') + 1];
  mkdirSync(dir, { recursive: true });
  file = join(dir, randomUUID() + '.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session', id: randomUUID(), cwd: process.cwd() }) + '\n');
}
let records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
let header = records.shift();
const handlers = new Map();
const eventHandlers = new Map();
const rpcHandlers = new Map();
let identityMode = process.env.TAU_WORKER_NONCE ? process.env.QA_IDENTITY_START || '' : '';
let identityResponse = '';
let releaseIdentity;
const qaChildren = [];
let shuttingDown = false;
async function qaPeer(phase) {
  const child = spawn(process.env.TAU_TEST_BUN, [join(import.meta.dir, 'worker-launcher.mjs'), 'ipc-qa'],
    { env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  qaChildren.push(child);
  const lines = createInterface({ input: child.stdout });
  const result = new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line))));
  child.stdin.write(JSON.stringify({ type: 'mirror_sync', sessionFile: join(header.cwd, 'qa-forged.jsonl'),
    cwd: header.cwd, epoch: 'qa-forged', seq: 0, isStreaming: false, entries: [] }) + '\n');
  const receipt = await result;
  lines.close();
  child.stdin.end();
  console.error('QA_POSIX_PEER ' + JSON.stringify({ phase, engine: process.pid, ...receipt }));
}
let idle = true;
let compacting = false;
let pendingMessages = false;
let continuationHeld = false;
let autoCompactionEnabled = false;
let heldPrompt;
let heldCompaction;
let heldSnapshot;
let snapshotPhase;
let releaseSnapshot;
const openFile = fs.open;
fs.open = async function (target, ...args) {
  const hold = async () => {
    if (!heldSnapshot || target !== file) return;
    const id = heldSnapshot;
    heldSnapshot = undefined;
    await new Promise(resolve => {
      releaseSnapshot = resolve;
      console.log(`QA_SNAPSHOT_HELD ${id}`);
    });
  };
  if (snapshotPhase !== 'read') await hold();
  const handle = await openFile.call(this, target, ...args);
  if (snapshotPhase === 'read' && heldSnapshot && target === file) {
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      await hold();
      return read(...readArgs);
    };
  }
  return handle;
};
let compactionController;
const deadlines = new Map();
const agentDeadlines = new Map();
const authenticationDeadlines = new Map();
const schedule = globalThis.setTimeout;
const cancel = globalThis.clearTimeout;
let wireProbe = null;
const socketWrite = Socket.prototype.write;
Socket.prototype.write = function (chunk, ...args) {
  if (wireProbe && this === globalThis.__tauMirrorRuntime?.peer && typeof chunk === 'string') {
    wireProbe.frames++;
    wireProbe.bytes += Buffer.byteLength(chunk);
    if (chunk.includes(wireProbe.needle)) wireProbe.bodyFound = true;
  }
  return socketWrite.call(this, chunk, ...args);
};
if (process.env.QA_CONTROL_CLOCK === '1') {
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = schedule(() => {
      agentDeadlines.delete(timer);
      authenticationDeadlines.delete(timer);
      callback(...args);
    }, delay);
    if (delay === 30000) deadlines.set(timer, () => callback(...args));
    if (delay === 250) agentDeadlines.set(timer, () => callback(...args));
    if (delay === 10000) authenticationDeadlines.set(timer, () => callback(...args));
    return timer;
  };
  globalThis.clearTimeout = timer => {
    deadlines.delete(timer);
    agentDeadlines.delete(timer);
    authenticationDeadlines.delete(timer);
    cancel(timer);
  };
}
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
  isIdle: () => idle,
  isCompacting: () => compacting,
  hasPendingMessages: () => pendingMessages,
  engineTurnsHeld: () => continuationHeld,
  getContextUsage: () => null,
  getCompactionSettings: () => ({ enabled: autoCompactionEnabled }),
  compact(options) {
    compacting = true;
    heldCompaction = options;
    if (process.env.QA_COMPACTION_HOOKS === '1') {
      compactionController = new AbortController();
      for (const handler of handlers.get('session_before_compact') || []) {
        void handler({ type: 'session_before_compact', requestId: 'qa-manual',
          reason: 'manual', signal: compactionController.signal }, ctx);
      }
    }
  },
  abort() {
    if (!heldCompaction) return;
    compacting = false;
    const pending = heldCompaction;
    heldCompaction = undefined;
    pending.onError(new Error('Compaction aborted'));
  },
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
  rpc: { handle(name, handler) { rpcHandlers.set(name, handler); } },
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
  session: {
    async persistHeaderNow() {
      for (const event of JSON.parse(process.env.QA_STARTUP_EXTENSION_EVENTS || '[]')) {
        api.events.emit('senpi:extension-rpc-event', event);
      }
    },
  },
  events: {
    on(name, handler) {
      const listeners = eventHandlers.get(name) || new Set();
      listeners.add(handler);
      eventHandlers.set(name, listeners);
      return () => listeners.delete(handler);
    },
    emit(name, value) {
      for (const handler of eventHandlers.get(name) || []) handler(value);
    },
  },
};
extension(api);
const input = createInterface({ input: process.stdin });
input.on('line', async line => {
  const event = JSON.parse(line);
  if (event.type === 'qa_admission_arm') {
    if (event.stage && event.stage !== 'outer') armPosix(event.stage, event.mode);
    else admissionMode = event.mode;
    console.log('QA_ADMISSION_ARMED');
    return;
  }
  if (event.type === 'qa_admission_release') {
    const runtime = globalThis.__tauMirrorRuntime;
    const child = heldChild || posix.child;
    if (event.mutation === 'delete' || event.mutation === 'replace') {
      savedOwners = [...runtime.children];
      for (const [nonce, child] of runtime.children) {
        if (child !== (heldChild || posix.child)) continue;
        if (event.mutation === 'delete') runtime.children.delete(nonce);
        else runtime.children.set(nonce, { pid: process.pid });
      }
    }
    if (event.mutation === 'stop') runtime.stopped = true;
    if (event.mutation === 'auth-timeout') {
      for (const [timer, expire] of [...authenticationDeadlines]) {
        clearTimeout(timer);
        expire();
      }
    }
    if (event.mutation === 'closing') void runtime.ownership.close(child, true);
    if (event.mutation === 'native-close') {
      const closed = once(child, 'close');
      child.stdin.end();
      await closed;
    }
    if (posix.stage) releasePosix();
    else { releaseAdmission(); releaseAdmission = undefined; }
    console.log('QA_ADMISSION_RELEASED');
    return;
  }
  if (event.type === 'qa_admission_restore') {
    const runtime = globalThis.__tauMirrorRuntime;
    if (savedOwners) {
      runtime.children.clear();
      for (const [nonce, child] of savedOwners) runtime.children.set(nonce, child);
      savedOwners = undefined;
    }
    runtime.stopped = false;
    console.log('QA_ADMISSION_RESTORED');
    return;
  }
  if (event.type === 'qa_expire_auth') {
    for (const [timer, expire] of [...authenticationDeadlines]) {
      clearTimeout(timer);
      expire();
    }
    console.log('QA_AUTH_EXPIRED');
    return;
  }
  if (event.type === 'qa_startup_timeout') {
    for (const [timer, expire] of [...deadlines]) {
      clearTimeout(timer);
      expire();
    }
    return;
  }
  if (event.type === 'qa_posix_stats') {
    console.log('QA_POSIX_STATS ' + JSON.stringify({ requests: posix.requests, queries: posix.queries,
      children: [...globalThis.__tauMirrorRuntime.children.values()].map(child => child.pid) }));
    return;
  }
  if (event.type === 'qa_peer') {
    await qaPeer('after');
    return;
  }
  if (event.type === 'qa_identity_mode') {
    identityMode = event.mode;
    identityResponse = event.response || '';
    return;
  }
  if (event.type === 'qa_identity_release') {
    releaseIdentity();
    releaseIdentity = undefined;
    return;
  }
  if (event.type === 'extension_request') {
    if (identityMode === 'hold') {
      await new Promise(resolve => {
        releaseIdentity = resolve;
        console.error('QA_IDENTITY_WAIT');
      });
    }
    const mode = identityResponse || identityMode;
    identityMode = '';
    identityResponse = '';
    const handler = rpcHandlers.get(event.name);
    const data = handler?.();
    const response = { type: 'response', command: 'extension_request', id: event.id,
      success: !!handler, data };
    if (mode === 'error' || mode === 'missing-handler') response.success = false;
    if (mode === 'command') response.command = 'get_state';
    if (mode === 'version') data.version = 2;
    if (mode === 'pid') data.pid = 1.5;
    if (mode === 'uuid') data.instance = 'z'.repeat(36);
    if (mode === 'changed') data.instance = randomUUID();
    console.log(JSON.stringify(response));
    return;
  }
  if (event.type === 'qa_flush_agents') {
    for (const [timer, expire] of [...agentDeadlines]) {
      clearTimeout(timer);
      expire();
    }
    const buffers = [...globalThis.__tauMirrorRuntime.selections.values()]
      .filter(selection => selection.buffer).map(selection => selection.buffer);
    console.log(`QA_AGENTS_FLUSH ${event.id} ${JSON.stringify(buffers)}`);
    return;
  }
  if (event.type === 'qa_replace_session') {
    for (const handler of handlers.get('session_shutdown') || []) await handler({ reason: 'switch' }, ctx);
    if (event.terminal) delete process.env.TAU_WORKER_NONCE;
    console.log(`QA_EXTENSION_LISTENERS ${eventHandlers.get('senpi:extension-rpc-event')?.size || 0}`);
    handlers.clear();
    file = event.sessionFile;
    records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    header = records.shift();
    ctx.cwd = header.cwd;
    extension(api);
    for (const wrapper of event.events || []) api.events.emit('senpi:extension-rpc-event', wrapper);
    for (const handler of handlers.get('session_start') || []) await handler({}, ctx);
    console.log(`QA_SESSION_REPLACED ${event.id}`);
    return;
  }
  if (event.type === 'qa_hold_snapshot') {
    heldSnapshot = event.id;
    snapshotPhase = event.phase;
    console.log(`QA_SNAPSHOT_ARMED ${event.id}`);
    return;
  }
  if (event.type === 'qa_release_snapshot') {
    releaseSnapshot();
    releaseSnapshot = undefined;
    return;
  }
  if (event.type === 'qa_extension_event') {
    api.events.emit('senpi:extension-rpc-event', { name: event.name, data: event.data });
    console.log(`QA_EXTENSION_EVENT_DONE ${event.id}`);
    return;
  }
  if (event.type === 'qa_wire_probe') {
    wireProbe = { needle: event.needle, frames: 0, bytes: 0, bodyFound: false };
    console.log(`QA_WIRE_READY ${event.id}`);
    return;
  }
  if (event.type === 'qa_wire_report') {
    console.log(`QA_WIRE_REPORT ${event.id} ${JSON.stringify(wireProbe)}`);
    wireProbe = null;
    return;
  }
  if (event.type === 'get_state' || event.type === 'set_auto_compaction') {
    if (event.type === 'set_auto_compaction') autoCompactionEnabled = event.enabled;
    console.log(JSON.stringify({ type: 'response', command: event.type, id: event.id, success: true,
      ...(event.type === 'get_state' ? { data: {
        autoCompactionEnabled, thinkingLevel: 'off', isStreaming: !idle, sessionFile: file,
      } } : {}),
    }));
    return;
  }
  if (event.type === 'qa_supersede_compaction') {
    compacting = false;
    heldCompaction = undefined;
    compactionController.abort();
    return;
  }
  if (event.type === 'qa_complete_manual_compaction') {
    if (!heldCompaction) throw new Error('No manual compaction is pending');
    compacting = false;
    const pending = heldCompaction;
    heldCompaction = undefined;
    if (process.env.QA_COMPACTION_HOOKS === '1') {
      const outcome = event.error
        ? { type: 'session_compact_failed', errorMessage: event.error, aborted: false }
        : { type: 'session_compact', accepted: true, compactionEntry: {
          summary: 'qa-compacted-summary', tokensBefore: 900, firstKeptEntryId: 'kept',
        } };
      for (const handler of handlers.get(outcome.type) || []) await handler(outcome, ctx);
    }
    if (event.error) pending.onError(new Error(event.error));
    else pending.onComplete({ summary: 'qa-compacted-summary', tokensBefore: 900, firstKeptEntryId: 'kept' });
    return;
  }
  if (['prompt', 'steer', 'follow_up'].includes(event.type)) {
    if (event.message === 'compact-before-prompt') {
      heldPrompt = event;
      compacting = true;
      for (const handler of handlers.get('compaction_start') || []) {
        await handler({ type: 'compaction_start', reason: 'threshold' }, ctx);
      }
      return;
    }
    if (continuationHeld) {
      continuationHeld = false;
      idle = false;
      const message = { role: 'user', content: [{ type: 'text', text: event.message }],
        clientMessageId: event.clientMessageId, timestamp: Date.now() };
      const resumed = [
        { type: 'custom', customType: 'session-lifecycle', data: { sessionId: header.id, state: 'running' } },
        { type: 'message', message },
      ];
      for (const entry of resumed) {
        appendFileSync(file, JSON.stringify(entry) + '\n');
        records.push(entry);
      }
      for (const type of ['held_wakes_released', 'agent_start', 'message_end']) {
        for (const handler of handlers.get(type) || []) await handler({ type, message }, ctx);
      }
    }
    console.log(JSON.stringify({ type: 'response', command: event.type, id: event.id, success: true,
      data: { source: 'rpc', hasRoutingId: Object.hasOwn(event, 'sessionId'), message: event.message,
        streamingBehavior: event.streamingBehavior } }));
    if (event.type === 'prompt' && !api.getSessionName()) api.setSessionName('Native first request summary');
    return;
  }
  if (event.type === 'qa_finish_compaction') {
    compacting = false;
    for (const handler of handlers.get('compaction_end') || []) {
      await handler({ type: 'compaction_end', reason: 'threshold' }, ctx);
    }
    const message = { role: 'user', content: [{ type: 'text', text: heldPrompt.message }],
      clientMessageId: heldPrompt.clientMessageId, timestamp: Date.now() };
    const entry = { type: 'message', message };
    records.push(entry);
    appendFileSync(file, '\n' + JSON.stringify(entry) + '\n');
    for (const handler of handlers.get('message_end') || []) {
      await handler({ type: 'message_end', message }, ctx);
    }
    idle = false;
    for (const handler of handlers.get('agent_start') || []) {
      await handler({ type: 'agent_start' }, ctx);
    }
    console.log(JSON.stringify({ type: 'response', id: heldPrompt.id, command: 'prompt', success: true }));
    heldPrompt = undefined;
    return;
  }
  if (event.type === 'qa_advance_deadlines') {
    for (const [timer, expire] of [...deadlines]) {
      clearTimeout(timer);
      await expire();
    }
    const session = [...globalThis.__tauMirrorRuntime.sessions.values()]
      .find(item => item.sessionId === event.sessionId);
    for (const client of globalThis.__tauMirrorRuntime.clients) {
      client.send(JSON.stringify({ type: 'qa_clock_advanced', id: event.id,
        pending: session.pending, idleScheduled: session.idleTimer !== null,
        writable: session.child?.stdin?.writable === true }));
    }
    return;
  }
  if (event.type === 'qa_events') {
    for (const item of event.events) {
      if (item.type === 'agent_start') idle = false;
      if (item.type === 'agent_end') idle = true;
      if (['compaction_start', 'auto_compaction_start', 'session_before_compact'].includes(item.type)) compacting = true;
      if (['compaction_end', 'auto_compaction_end', 'session_compact', 'session_compact_failed'].includes(item.type)) compacting = false;
      if (typeof item.pendingMessages === 'boolean') pendingMessages = item.pendingMessages;
      if (typeof item.continuationHeld === 'boolean') continuationHeld = item.continuationHeld;
      if (item.lifecycle) {
        const entry = { type: 'custom', customType: 'session-lifecycle',
          data: { ...item.lifecycle, sessionId: header.id } };
        appendFileSync(file, JSON.stringify(entry) + '\n');
        records.push(entry);
      }
      if (item.type === 'wake_source_state') api.events.emit(item.type, item);
      else if (item.type === 'qa_set_session_name') api.setSessionName(item.name);
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
  if (event.type === 'qa_registration') {
    const runtime = globalThis.__tauMirrorRuntime;
    const session = [...runtime.sessions.values()].find(item => item.sessionId === event.sessionId);
    const nonce = [...runtime.children].find(([, child]) => child === session.child)?.[0];
    console.log(`QA_REGISTRATION ${JSON.stringify({ ...runtime.discovery, nonce,
      ownerPid: session.pid, childPid: session.child?.pid, snapshot: session.snapshot,
      requests: posix.requests, queries: posix.queries })}`);
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
  shuttingDown = true;
  for (const child of qaChildren) child.stdin.end();
  if (savedOwners) {
    globalThis.__tauMirrorRuntime.children.clear();
    for (const [nonce, child] of savedOwners) globalThis.__tauMirrorRuntime.children.set(nonce, child);
  }
  for (const handler of handlers.get('session_shutdown') || []) await handler({ reason: 'quit' }, ctx);
  console.log(`QA_EXTENSION_LISTENERS ${eventHandlers.get('senpi:extension-rpc-event')?.size || 0}`);
  input.close();
});
for (const event of JSON.parse(process.env.QA_EARLY_EXTENSION_EVENTS || '[]')) {
  api.events.emit('senpi:extension-rpc-event', event);
}
if (process.env.QA_POSIX_TOPOLOGY && process.env.TAU_WORKER_NONCE) await qaPeer('before');
if (!shuttingDown) for (const handler of handlers.get('session_start') || []) await handler({}, ctx);
if (process.env.QA_EARLY_EVENT === '1') {
  for (const handler of handlers.get('agent_start') || []) await handler({ type: 'agent_start' }, ctx);
}
