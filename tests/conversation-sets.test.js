import { afterEach, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

let gateway, view;
const evaluate = (fn, input = null) => view.evaluate(`(${fn.toString()})(${JSON.stringify(input)})`);
const user = (id, content) => ({ type: 'message', id, message: { role: 'user', content } });
const answer = (id, text) => ({ type: 'message', id,
  message: { role: 'assistant', content: [{ type: 'text', text }] } });
const instruction = user('latest-user', 'Latest instruction');
const summary = { toolCallId: 'one', toolName: 'read', preview: 'generated.txt',
  status: 'complete', revision: 1, callRef: 'call', resultRef: 'result', liveRef: null };
const call = { type: 'message', id: 'call', message: { role: 'assistant',
  content: [{ type: 'toolCall', id: 'one', name: 'read', tool: summary }] } };
const definition = (key, entry, partialBefore = false) => ({
  key, instruction: { entry, entryKey: entry.id, offset: null }, partialBefore,
});
const metadata = (entries, keys, sets) => ({
  entryKeys: entries.map(entry => entry.id), entrySetKeys: keys, sets,
});
async function observe(predicate, action = () => {}) {
  return evaluate(({ predicate, action }) => new Promise((resolve, reject) => {
    const check = new Function(`return (${predicate})`)();
    const run = new Function(`return (${action})`)();
    const finish = error => {
      clearTimeout(timer); observer.disconnect();
      error ? reject(error) : resolve(true);
    };
    const observer = new MutationObserver(() => { if (check()) finish(); });
    const timer = setTimeout(() => finish(new Error('Conversation state missing')), 4000);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    run();
    if (check()) finish();
  }), { predicate: predicate.toString(), action: action.toString() });
}
async function open(options) {
  gateway = await createStreamingGateway({ holdSelection: true, ...options });
  view = new Bun.WebView({ width: 1000, height: 800 });
  await view.navigate(gateway.server.url.href);
  await gateway.nextSelection();
  await observe(() => document.querySelector('.conversation-set'));
  const ready = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden'));
  gateway.acknowledge();
  await ready;
}
afterEach(async () => {
  if (view) await view.close();
  gateway?.close();
  view = null; gateway = null;
});

test('retains the sidecar instruction once while extending its set and adding an older set', async () => {
  const entries = [call, answer('latest-answer', 'Latest answer')];
  const old = user('old-user', 'Earlier instruction');
  const earlier = [old, answer('old-answer', 'Earlier answer'), instruction];
  await open({
    entries, history: { before: 'older' },
    conversation: metadata(entries, ['latest', 'latest'], [definition('latest', instruction, true)]),
    historyPages: { older: { entries: earlier, history: { before: null },
      conversation: metadata(earlier, ['old', 'old', 'latest'],
        [definition('old', old), definition('latest', instruction)]) } },
  });
  expect(await evaluate(() => ({
    instructions: [...document.querySelectorAll('.conversation-instruction .message-content')].map(e => e.textContent),
    headers: document.querySelectorAll('.tool-card').length,
  }))).toEqual({ instructions: ['Latest instruction'], headers: 0 });
  await evaluate(() => {
    const input = document.querySelector('#message-input');
    input.value = 'Preserved draft'; input.dispatchEvent(new Event('input'));
  });
  await observe(() => document.querySelectorAll('.conversation-set').length === 2,
    () => document.querySelector('.history-load').click());
  expect(await evaluate(() => ({
    instructions: [...document.querySelectorAll('.conversation-instruction .message-content')].map(e => e.textContent),
    draft: document.querySelector('#message-input').value,
    partial: [...document.querySelectorAll('.conversation-partial')].some(e => !e.hidden),
    errors: qaErrors,
  }))).toEqual({ instructions: ['Earlier instruction', 'Latest instruction'],
    draft: 'Preserved draft', partial: false, errors: [] });
  expect(gateway.historyRequests.filter(request => request.before !== null)).toHaveLength(1);
});

test('restores the explicitly opened tool after a same-session reconnect', async () => {
  const entries = [instruction, call, answer('latest-answer', 'Latest answer')];
  await open({ entries, conversation: metadata(entries, ['latest', 'latest', 'latest'],
    [definition('latest', instruction)]) });
  await observe(() => document.querySelector('.tool-card-toggle'),
    () => document.querySelector('.activity-summary').click());
  expect(gateway.detailRequests).toHaveLength(0);
  await observe(() => document.querySelector('.tool-output')?.textContent === 'Tool detail',
    () => document.querySelector('.tool-card-toggle').click());
  const selected = gateway.nextSelection();
  gateway.disconnect();
  await selected;
  const restored = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden')
    && document.querySelector('.tool-output')?.textContent === 'Tool detail');
  gateway.acknowledge();
  await restored;
  expect(await evaluate(() => ({
    sets: document.querySelectorAll('.conversation-set').length,
    bodies: document.querySelectorAll('.tool-card-body').length,
    errors: qaErrors,
  }))).toEqual({ sets: 1, bodies: 1, errors: [] });
  expect(gateway.detailRequests).toHaveLength(2);
});

test('ignores held tool details after selecting another session', async () => {
  const entries = [instruction, call];
  const other = user('other-user', 'Other instruction');
  const otherEntries = [other, answer('other-answer', 'Other answer')];
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  await open({
    entries, conversation: metadata(entries, ['latest', 'latest'], [definition('latest', instruction)]),
    pagesBySession: { 'other.jsonl': { entries: otherEntries, history: { before: null },
      conversation: metadata(otherEntries, ['other', 'other'], [definition('other', other)]) } },
    projects: [{ path: 'C:/generated', name: 'Generated', sessions: [
      { id: 'other', name: 'Other session', filePath: 'other.jsonl', timestamp: '2026-11-02T00:00:00Z' },
    ] }],
    detailHandler: async () => {
      arrived.resolve();
      await release.promise;
      return Response.json({ args: {}, argsText: '', output: 'Stale tool output', isError: false,
        argsTruncated: false, outputTruncated: false, revision: 1, attachments: [] });
    },
  });
  await observe(() => document.querySelector('.tool-card-toggle'),
    () => document.querySelector('.activity-summary').click());
  await evaluate(() => document.querySelector('.tool-card-toggle').click());
  await arrived.promise;
  const selected = gateway.nextSelection();
  await view.click('.session-item[data-file-path="other.jsonl"]');
  await selected;
  const ready = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden')
    && document.querySelector('.conversation-instruction').textContent.includes('Other instruction'));
  gateway.acknowledge();
  await ready;
  release.resolve();
  expect(await evaluate(() => ({
    instruction: document.querySelector('.conversation-instruction .message-content').textContent,
    stale: document.querySelector('#messages').textContent.includes('Stale tool output'),
    bodies: document.querySelectorAll('.tool-card-body').length, errors: qaErrors,
  }))).toEqual({ instruction: 'Other instruction', stale: false, bodies: 0, errors: [] });
});
