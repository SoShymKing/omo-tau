import { afterEach, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

let gateway;
let view;
const evaluate = (fn, args = null) => view.evaluate(`(${fn.toString()})(${JSON.stringify(args)})`);
const user = (id, text) => ({ type: 'message', id, message: { role: 'user', content: text } });
const answer = (id, text) => ({
  type: 'message', id, message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const latest = () => [user('new-user', 'New question'), answer('new-answer', 'New answer')];
const older = () => [user('old-user', 'Old question'), answer('old-answer', 'Old answer')];

async function observe(predicate, action = () => {}) {
  return evaluate(({ condition, action }) => new Promise((resolve, reject) => {
    const checkState = new Function(`return (${condition})`)();
    const run = new Function(`return (${action})`)();
    const finish = error => {
      clearTimeout(timer);
      observer.disconnect();
      error ? reject(error) : resolve(true);
    };
    const check = () => { if (checkState()) finish(); };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => finish(new Error('History state did not arrive')), 3000);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    run();
    check();
  }), { condition: predicate.toString(), action: action.toString() });
}

async function open(options, ready = false) {
  gateway = await createStreamingGateway({ holdSelection: true, ...options });
  view = new Bun.WebView();
  await view.navigate(`http://127.0.0.1:${gateway.server.port}`);
  await gateway.nextSelection();
  await observe(() => document.querySelector('.history-load'));
  if (ready) {
    const shown = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden'));
    gateway.acknowledge();
    await shown;
  }
}

async function deliver(events) {
  const barrier = gateway.nextBarrier();
  await evaluate(id => {
    window.qaDelivered = new Promise(resolve => {
      const receive = event => {
        if (JSON.parse(event.data).id !== id) return;
        qaSocket.removeEventListener('message', receive);
        resolve(true);
      };
      qaSocket.addEventListener('message', receive);
    });
  }, barrier);
  gateway.send(events);
  await view.evaluate('window.qaDelivered');
}

afterEach(() => {
  view?.close();
  gateway?.close();
  view = null;
  gateway = null;
});

test('one earlier-history click retrieves the call for a result-only page', async () => {
  // Given a saved result whose call is in the next older page.
  await open({
    entries: latest(), history: { before: 3 },
    historyPages: {
      3: {
        entries: [{ type: 'message', id: 'old-result', message: {
          role: 'toolResult', toolCallId: 'old-tool',
          content: [{ type: 'text', text: 'Recovered output' }],
        } }],
        history: { before: 2 },
      },
      2: {
        entries: [user('old-user', 'Old question'), {
          type: 'message', id: 'old-call', message: { role: 'assistant', content: [
            { type: 'toolCall', id: 'old-tool', name: 'read', arguments: { path: 'example.txt' } },
          ] },
        }],
        history: { before: null },
      },
    },
  }, true);
  // When the reader clicks once, even though the first response has no displayable call.
  await observe(() => document.querySelector('[data-tool-call-id="old-tool"] .tool-output')
    ?.textContent === 'Recovered output', () => document.querySelector('.history-load').click());
  // Then the older call, its result and its instruction are available together.
  expect(await evaluate(() => ({
    question: !!document.querySelector('[data-entry-id="old-user"]'),
    output: document.querySelector('[data-tool-call-id="old-tool"] .tool-output').textContent,
  }))).toEqual({ question: true, output: 'Recovered output' });
});

test('ready snapshot preserves history loaded from a short preview and its draft', async () => {
  // Given an expanded preview short enough to remain at the output-following position.
  await open({ entries: latest(), history: { before: 2 }, earlierEntries: older() });
  await observe(() => document.querySelector('[data-entry-id="old-user"]'),
    () => document.querySelector('.history-load').click());
  await evaluate(() => {
    const input = document.querySelector('#message-input');
    input.value = 'Keep this draft';
    input.dispatchEvent(new Event('input'));
  });
  // When preparation completes with the bounded authoritative snapshot.
  const ready = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden'));
  gateway.acknowledge();
  await ready;
  // Then the additional records stay in chronological order and the draft is unchanged.
  expect(await evaluate(() => ({
    ids: [...document.querySelectorAll('#messages .message')].map(row => row.dataset.entryId),
    draft: document.querySelector('#message-input').value,
  }))).toEqual({
    ids: ['old-user', 'old-answer', 'new-user', 'new-answer'],
    draft: 'Keep this draft',
  });
});

test('reconnection preserves previously loaded history even when all messages fit', async () => {
  // Given a ready short history that the reader has expanded.
  await open({ entries: latest(), history: { before: 2 }, earlierEntries: older() }, true);
  await observe(() => document.querySelector('[data-entry-id="old-user"]'),
    () => document.querySelector('.history-load').click());
  // When the same session reconnects and receives its bounded snapshot again.
  const selection = gateway.nextSelection();
  gateway.disconnect();
  await selection;
  const ready = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden'));
  gateway.acknowledge();
  await ready;
  // Then the records that were loaded by the user are not discarded.
  expect(await evaluate(() => [...document.querySelectorAll('#messages .message')]
    .map(row => row.dataset.entryId))).toEqual(['old-user', 'old-answer', 'new-user', 'new-answer']);
});

test('reconnection fills a history gap before replaying buffered live output', async () => {
  // Given loaded history and a later snapshot beyond a previously unseen pair of records.
  const entries = latest();
  const earlierEntries = older();
  const history = { before: 2 };
  let block = false;
  let requested;
  let release;
  const blocked = new Promise(resolve => { requested = resolve; });
  await open({
    entries, earlierEntries, history,
    historyGate() {
      if (!block) return;
      requested();
      return new Promise(resolve => { release = resolve; });
    },
  }, true);
  await observe(() => document.querySelector('[data-entry-id="old-user"]'),
    () => document.querySelector('.history-load').click());
  earlierEntries.push(...entries, user('middle-user', 'Middle question'), answer('middle-answer', 'Middle answer'));
  entries.splice(0, entries.length, user('last-user', 'Last question'), answer('last-answer', 'Last answer'));
  history.before = 6;
  block = true;
  const selection = gateway.nextSelection();
  // When reconnecting while the bridge request is held and live output arrives after the snapshot.
  gateway.disconnect();
  await selection;
  gateway.acknowledge();
  await blocked;
  await deliver([
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Buffered live answer' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Buffered live answer' }] } },
    { type: 'agent_end' },
  ]);
  release();
  await observe(() => document.querySelector('#messages').textContent.includes('Buffered live answer'));
  // Then the range is contiguous and the live answer is neither lost nor duplicated.
  expect(await evaluate(() => ({
    ids: [...document.querySelectorAll('#messages .message[data-entry-id]')].map(row => row.dataset.entryId),
    live: [...document.querySelectorAll('#messages .message-content')]
      .filter(element => element.textContent === 'Buffered live answer').length,
  }))).toEqual({
    ids: ['old-user', 'old-answer', 'new-user', 'new-answer', 'middle-user', 'middle-answer', 'last-user', 'last-answer'],
    live: 1,
  });
});

test('switching sessions cancels a pending gap and discards its buffered events', async () => {
  // Given an old selection paused in its reconnect bridge with an event already delivered.
  const entries = latest();
  const earlierEntries = older();
  const history = { before: 2 };
  let block = false;
  let requested;
  let release;
  let cancelled;
  const blocked = new Promise(resolve => { requested = resolve; });
  const aborted = new Promise(resolve => { cancelled = resolve; });
  await open({
    entries, earlierEntries, history,
    projects: [{ path: 'C:/history-qa', sessions: [{
      id: 'second', filePath: 'second-test.jsonl', name: 'Second session',
      firstMessage: 'Second question', timestamp: '2026-01-01T00:00:00Z',
    }] }],
    historyGate(_before, signal) {
      if (!block) return;
      signal.addEventListener('abort', cancelled, { once: true });
      requested();
      return new Promise(resolve => { release = resolve; });
    },
  }, true);
  await observe(() => document.querySelector('[data-entry-id="old-user"]'),
    () => document.querySelector('.history-load').click());
  earlierEntries.push(...entries, user('gap-user', 'Gap question'), answer('gap-answer', 'Gap answer'));
  entries.splice(0, entries.length, user('last-user', 'Last question'), answer('last-answer', 'Last answer'));
  history.before = 6;
  block = true;
  const reconnect = gateway.nextSelection();
  gateway.disconnect();
  await reconnect;
  gateway.acknowledge();
  await blocked;
  await deliver([{ type: 'extension_ui_request', method: 'notify', notifyType: 'info', message: 'Old session notification' }]);
  entries.splice(0, entries.length, user('second-user', 'Second question'), answer('second-answer', 'Second answer'));
  history.before = null;
  gateway.setSnapshot({ sessionFile: 'second-test.jsonl', sessionId: 'second', epoch: 'second-epoch' });
  // When selecting another session before the old request is released.
  const selected = gateway.nextSelection();
  await evaluate(() => document.querySelector('.session-item[data-file-path="second-test.jsonl"]').click());
  await selected;
  gateway.acknowledge();
  await observe(() => document.querySelector('[data-entry-id="second-answer"]'));
  await aborted;
  release();
  // Then the old request is cancelled and neither its records nor buffered event enter the new view.
  expect(await evaluate(() => ({
    ids: [...document.querySelectorAll('#messages .message[data-entry-id]')].map(row => row.dataset.entryId),
    stale: document.querySelector('#messages').textContent.includes('Old session notification'),
  }))).toEqual({ ids: ['second-user', 'second-answer'], stale: false });
});
