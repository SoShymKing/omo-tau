import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, open as openFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConversationPage } from '../extensions/conversation-history.ts';
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
const result = { type: 'message', id: 'result', message: {
  role: 'toolResult', toolCallId: 'one', content: [], tool: summary,
} };
const page = (entries, before, partial = true) => ({
  entries, history: { before },
  conversation: metadata(entries, entries.map(() => 'latest'), [definition('latest', instruction, partial)]),
});
const partialHistory = () => ({
  ...page([result], 'middle'),
  historyPages: {
    middle: page([call], 'first'),
    first: page([instruction, answer('old-answer', 'Recovered answer')], null, false),
  },
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
async function open(options, width = 1000, { previewOnly = false } = {}) {
  const preview = Promise.withResolvers();
  gateway = await createStreamingGateway({ holdSelection: true, ...options,
    ...(!previewOnly && { previewGate: () => preview.promise }) });
  view = new Bun.WebView({ width, height: 800 });
  try {
    await view.navigate(gateway.server.url.href);
    await gateway.nextSelection();
    if (previewOnly) {
      await observe(() => document.querySelector('.conversation-set'));
    } else {
      const ready = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden'));
      gateway.acknowledge();
      await ready;
    }
  } finally {
    preview.resolve();
  }
}
afterEach(async () => {
  if (view) await view.close();
  gateway?.close();
  view = null; gateway = null;
});

test.each([true, false])('initial loading completes the displayed set without a click, preview=%s', async previewOnly => {
  await open(partialHistory(), 1000, { previewOnly });
  await observe(() => document.querySelector('[data-entry-id="old-answer"]')
    && document.querySelector('.conversation-partial').hidden);
  if (previewOnly) {
    const ready = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden'));
    gateway.acknowledge();
    await ready;
  }
  expect(await evaluate(() => ({
    instructions: document.querySelectorAll('.conversation-instruction .message.user').length,
    answers: document.querySelectorAll('[data-entry-id="old-answer"]').length,
    errors: qaErrors,
  }))).toEqual({ instructions: 1, answers: 1, errors: [] });
  expect(gateway.historyRequests.filter(request => request.before !== null).map(request => request.before))
    .toEqual(['middle', 'first']);
  expect(gateway.detailRequests).toHaveLength(0);
});

test('real paging keeps whole displayed answers in order across Load and reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-set-boundary-'));
  const filename = join(directory, 'generated.jsonl');
  const older = [user('older-user', 'Older instruction'),
    ...Array.from({ length: 100 }, (_, index) => answer(`older-${index}`, `Older answer ${index}`))];
  const latest = [user('newer-user', 'Newer instruction'),
    ...Array.from({ length: 100 }, (_, index) => answer(`newer-${index}`, `Newer answer ${index}`))];
  await writeFile(filename, [{ type: 'session' }, ...older, ...latest].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const file = await openFile(filename, 'r');
  try {
    const initial = await readConversationPage(file, { filePath: filename });
    await open({ ...initial, historyGate: async (before, signal) =>
      Response.json(await readConversationPage(file, { filePath: filename, before, signal })) });
    await observe(() => document.querySelectorAll('.message.assistant').length === 100
      && !document.querySelector('.conversation-partial:not([hidden])'));
    expect(await evaluate(() => ({
      instructions: [...document.querySelectorAll('.conversation-instruction .message.user')].map(el => el.dataset.entryId),
      first: document.querySelector('#messages').firstElementChild.className,
    }))).toEqual({ instructions: ['newer-user'], first: 'history-load' });
    await observe(() => document.querySelectorAll('.message.assistant').length === 200
      && !document.querySelector('.conversation-partial:not([hidden])'),
    () => document.querySelector('.history-load').click());
    const selected = gateway.nextSelection();
    gateway.disconnect();
    await selected;
    const ready = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden'));
    gateway.acknowledge();
    await ready;
    expect(await evaluate(() => ({
      instructions: [...document.querySelectorAll('.conversation-instruction .message.user')].map(el => el.dataset.entryId),
      answers: [...document.querySelectorAll('.message.assistant')].map(el => el.dataset.entryId),
      controls: [...document.querySelectorAll('.history-load, .conversation-partial:not([hidden])')].length,
      errors: qaErrors,
    }))).toEqual({
      instructions: ['older-user', 'newer-user'],
      answers: [...older.slice(1), ...latest.slice(1)].map(entry => entry.id),
      controls: 0, errors: [],
    });
    expect(gateway.historyRequests.filter(request => request.before !== null)).toHaveLength(3);
  } finally {
    await file.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([1000, 390])(
  'initial loading preserves the draft and opened Activity at width %i', async width => {
    const older = Promise.withResolvers();
    await open({ ...partialHistory(), historyGate: () => older.promise }, width);
    if (width === 390) {
      // WebView's desktop user agent does not reproduce the phone's taller toolbar.
      await evaluate(() => { document.querySelector('.header').style.minHeight = '100px'; });
      await observe(() => parseFloat(document.querySelector('.main').style.getPropertyValue('--header-height')) >= 100);
    }
    expect(await evaluate(() => {
      const header = document.querySelector('.header').getBoundingClientRect();
      return [...document.querySelectorAll('.history-load, .conversation-history-load')]
        .every(button => button.getBoundingClientRect().top >= header.bottom);
    })).toBe(true);
    expect(await evaluate(() => [...document.querySelectorAll('.history-load, .conversation-history-load')]
      .filter(button => button.getBoundingClientRect().height > 0).length)).toBe(1);
    await observe(() => document.querySelector('.tool-card'),
      () => document.querySelector('.activity-summary').click());
    await evaluate(() => {
      const input = document.querySelector('#message-input');
      input.value = 'Preserved draft'; input.dispatchEvent(new Event('input'));
    });
    const completed = observe(() => document.querySelector('[data-entry-id="old-answer"]'));
    older.resolve();
    await completed;
    expect(await evaluate(() => ({
      instructions: document.querySelectorAll('.conversation-instruction .message.user').length,
      answers: document.querySelectorAll('[data-entry-id="old-answer"]').length,
      tools: document.querySelectorAll('.tool-card').length,
      draft: document.querySelector('#message-input').value,
      open: document.querySelector('.activity-group').open,
      partial: [...document.querySelectorAll('.conversation-partial')].some(element => !element.hidden),
      errors: qaErrors,
    }))).toEqual({ instructions: 1, answers: 1, tools: 1, draft: 'Preserved draft',
      open: true, partial: false, errors: [] });
    expect(gateway.detailRequests).toHaveLength(0);
  }
);

test('continues beyond five bounded pages until the target set is complete', async () => {
  const options = partialHistory();
  options.history.before = 'gap-0';
  for (let index = 0; index < 7; index++) {
    options.historyPages[`gap-${index}`] = page([
      { type: 'custom', id: `invisible-${index}`, customType: 'generated-invisible' },
    ], index === 6 ? 'first' : `gap-${index + 1}`);
  }
  await open(options);
  await observe(() => document.querySelector('[data-entry-id="old-answer"]'));
  expect(await evaluate(() => ({
    answer: !!document.querySelector('[data-entry-id="old-answer"]'),
    disabled: document.querySelector('.conversation-partial button').disabled,
    partial: document.querySelector('.conversation-partial').hidden,
  }))).toEqual({ answer: true, disabled: true, partial: true });
  expect(gateway.historyRequests.filter(request => request.before !== null).map(request => request.before))
    .toEqual(['gap-0', 'gap-1', 'gap-2', 'gap-3', 'gap-4', 'gap-5', 'gap-6', 'first']);
  expect(gateway.detailRequests).toHaveLength(0);
});

test('visible progress does not stop the target, but a different older partial set does', async () => {
  const older = user('older-user', 'Older instruction');
  const boundary = [answer('older-answer', 'Older response'), instruction];
  await open({
    ...page([result], 'visible'),
    historyPages: {
      unrelated: { entries: [older], history: { before: null },
        conversation: metadata([older], ['older'], [definition('older', older)]) },
      boundary: { entries: boundary, history: { before: 'unrelated' },
        conversation: metadata(boundary, ['older', 'latest'],
          [definition('older', older, true), definition('latest', instruction)]) },
      visible: page([answer('visible-answer', 'Visible before boundary')], 'boundary'),
    },
  }, 1000, { previewOnly: true });
  await observe(() => document.querySelector('[data-conversation-key="latest"] .conversation-partial').hidden);
  const ready = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden'));
  gateway.acknowledge();
  await ready;
  expect(await evaluate(() => ({
    visible: !!document.querySelector('[data-entry-id="visible-answer"]'),
    order: [...document.querySelectorAll('.conversation-set')].map(set => set.dataset.conversationKey),
    partial: [...document.querySelectorAll('.conversation-set')]
      .filter(set => !set.querySelector('.conversation-partial').hidden)
      .map(set => set.dataset.conversationKey),
    controls: [...document.querySelectorAll('.history-load, .conversation-history-load')]
      .filter(button => button.getBoundingClientRect().height > 0).length,
  }))).toEqual({ visible: true, order: ['older', 'latest'], partial: ['older'], controls: 1 });
  expect(gateway.historyRequests.filter(request => request.before !== null).map(request => request.before))
    .toEqual(['visible', 'boundary']);
  expect(gateway.detailRequests).toHaveLength(0);
  await observe(() => document.querySelector('[data-conversation-key="older"] .conversation-partial').hidden,
    () => document.querySelector('[data-conversation-key="older"] button.conversation-history-load').click());
  expect(gateway.historyRequests.filter(request => request.before !== null).map(request => request.before))
    .toEqual(['visible', 'boundary', 'unrelated']);
});

test('global fallback captures the first earlier partial target and shows one retry cause', async () => {
  const older = user('older-user', 'Older instruction');
  const earlier = answer('earlier-answer', 'Earlier response');
  let attempts = 0;
  await open({
    ...page([instruction, answer('latest-answer', 'Latest response')], 'earlier', false),
    historyPages: {
      earlier: { entries: [earlier], history: { before: 'boundary' },
        conversation: metadata([earlier], ['older'], [definition('older', older, true)]) },
      boundary: { entries: [older], history: { before: null },
        conversation: metadata([older], ['older'], [definition('older', older)]) },
    },
    historyGate: async () => attempts++ === 0
      ? Response.json({ error: 'generated-unavailable' }, { status: 503 }) : undefined,
  });
  await observe(() => [...document.querySelectorAll('[role="alert"]')]
    .some(element => element.textContent.includes('503')),
  () => document.querySelector('.history-load').click());
  expect(await evaluate(() => ({
    alerts: [...document.querySelectorAll('[role="alert"]')]
      .filter(element => element.getBoundingClientRect().height > 0 && element.textContent.includes('503')).length,
    controls: [...document.querySelectorAll('.history-load, .conversation-history-load')]
      .filter(button => button.getBoundingClientRect().height > 0).length,
    retry: document.querySelector('.history-load').disabled,
  }))).toEqual({ alerts: 1, controls: 1, retry: false });
  await observe(() => document.querySelector('[data-entry-id="earlier-answer"]')
    && document.querySelector('[data-conversation-key="older"] .conversation-partial').hidden,
  () => document.querySelector('.history-load').click());
  expect(gateway.historyRequests.filter(request => request.before !== null).map(request => request.before))
    .toEqual(['earlier', 'earlier', 'boundary']);
  expect(gateway.detailRequests).toHaveLength(0);
});

test.each(['night', 'clean'])('one local retry preserves native geometry and one failure cause in %s', async theme => {
  await open({ ...partialHistory(), historyGate: async () =>
    Response.json({ error: 'generated-unavailable' }, { status: 503 }) });
  await evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  await observe(() => document.querySelector('.conversation-partial [role="alert"]')?.textContent.includes('503'));
  expect(await evaluate(() => {
    const buttons = [...document.querySelectorAll('.history-load, .conversation-history-load')]
      .filter(button => button.getBoundingClientRect().height > 0);
    const rect = buttons[0].getBoundingClientRect();
    return {
      buttons: buttons.length, tag: buttons[0].tagName, type: buttons[0].type,
      width: rect.width, height: rect.height, disabled: buttons[0].disabled,
      retry: buttons[0].textContent.includes('Retry'),
      alerts: [...document.querySelectorAll('[role="alert"]')]
        .filter(element => element.getBoundingClientRect().height > 0 && element.textContent.includes('503')).length,
    };
  })).toEqual({ buttons: 1, tag: 'BUTTON', type: 'button', width: 230, height: 44,
    disabled: false, retry: true, alerts: 1 });
});

test.each(['stalled', 'repeated'])('%s history cursor stops with a retry and retains the cursor', async kind => {
  const options = partialHistory();
  options.historyPages.middle = page([{ type: 'custom', id: 'gap-middle' }], kind === 'stalled' ? 'middle' : 'first');
  options.historyPages.first = page([{ type: 'custom', id: 'gap-first' }], 'middle');
  await open(options);
  await observe(() => document.querySelector('.conversation-partial [role="alert"]')
    ?.textContent.includes('History cursor did not advance.'));
  expect(gateway.historyRequests.filter(request => request.before !== null).map(request => request.before))
    .toEqual(kind === 'stalled' ? ['middle'] : ['middle', 'first']);
  options.historyPages.middle = page([instruction, answer('old-answer', 'Recovered answer')], null, false);
  await observe(() => document.querySelector('[data-entry-id="old-answer"]'),
    () => document.querySelector('.conversation-partial button').click());
  expect(gateway.historyRequests.at(-1).before).toBe('middle');
  expect(await evaluate(() => qaErrors)).toEqual([]);
});

test('changed history source keeps the cursor and rejects stale entries before retry', async () => {
  let attempts = 0;
  await open({ ...partialHistory(), historyGate: async () => attempts++ === 0 ? Response.json({
    ...page([answer('stale-answer', 'Wrong source')], null, false),
    view: 'conversation-v1',
    history: { before: null, offsets: [1], source: { fileId: 'changed.jsonl', endByte: 2 } },
  }) : undefined });
  await observe(() => document.querySelector('.conversation-partial [role="alert"]')
    ?.textContent.includes('Session history changed.'));
  expect(await evaluate(() => !!document.querySelector('[data-entry-id="stale-answer"]'))).toBe(false);
  await observe(() => document.querySelector('[data-entry-id="old-answer"]'),
    () => document.querySelector('.conversation-partial button').click());
  expect(gateway.historyRequests.filter(request => request.before !== null).map(request => request.before))
    .toEqual(['middle', 'middle', 'first']);
});

test('an exhausted empty page removes partial controls', async () => {
  await open({ ...page([result], 'empty'), historyPages: { empty: page([], null, false) } });
  await observe(() => !document.querySelector('.history-load')
    && document.querySelector('.conversation-partial').hidden);
  expect(await evaluate(() => qaErrors)).toEqual([]);
});

test('local retry recovers from an earlier-page failure and prevents duplicate loading', async () => {
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  let attempts = 0;
  await open({ ...partialHistory(), historyGate: async () => {
    if (attempts++ !== 0) return;
    arrived.resolve();
    await release.promise;
    return Response.json({ error: 'generated-unavailable' }, { status: 503 });
  } });
  await arrived.promise;
  expect(await evaluate(() => [...document.querySelectorAll('.conversation-partial button, .history-load')]
    .every(button => button.disabled))).toBe(true);
  await evaluate(() => document.querySelector('.conversation-partial button').click());
  const failed = observe(() => document.querySelector('.conversation-partial [role="alert"]')
    ?.textContent.includes('503'));
  release.resolve();
  await failed;
  expect(gateway.historyRequests.filter(request => request.before !== null)).toHaveLength(1);
  await observe(() => document.querySelector('[data-entry-id="old-answer"]'),
    () => document.querySelector('.conversation-partial button').click());
});

test('switching sessions discards a held earlier page and its local loading state', async () => {
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const other = user('other-user', 'Other instruction');
  const otherEntries = [other, answer('other-answer', 'Other answer')];
  await open({
    ...partialHistory(),
    historyGate: async (_before, signal) => {
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      arrived.resolve();
      await release.promise;
    },
    pagesBySession: { 'other.jsonl': { entries: otherEntries, history: { before: null },
      conversation: metadata(otherEntries, ['other', 'other'], [definition('other', other)]) } },
    projects: [{ path: 'C:/generated', name: 'Generated', sessions: [
      { id: 'other', name: 'Other session', filePath: 'other.jsonl', timestamp: '2026-11-02T00:00:00Z' },
    ] }],
  });
  await arrived.promise;
  const selected = gateway.nextSelection();
  await view.click('.session-item[data-file-path="other.jsonl"]');
  await selected;
  const ready = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden')
    && document.querySelector('[data-entry-id="other-answer"]'));
  gateway.acknowledge();
  await ready;
  await cancelled.promise;
  release.resolve();
  expect(await evaluate(() => ({
    answers: [...document.querySelectorAll('.conversation-response .message-content')].map(element => element.textContent),
    loading: !!document.querySelector('.conversation-partial:not([hidden]) button'),
    errors: qaErrors,
  }))).toEqual({ answers: ['Other answer'], loading: false, errors: [] });
});

test('retains the sidecar instruction once while extending its set and adding an older set', async () => {
  const older = Promise.withResolvers();
  const entries = [call, answer('latest-answer', 'Latest answer')];
  const old = user('old-user', 'Earlier instruction');
  const earlier = [old, answer('old-answer', 'Earlier answer'), instruction];
  await open({
    entries, history: { before: 'older' },
    historyGate: () => older.promise,
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
  const completed = observe(() => document.querySelectorAll('.conversation-set').length === 2);
  older.resolve();
  await completed;
  expect(await evaluate(() => ({
    instructions: [...document.querySelectorAll('.conversation-instruction .message-content')].map(e => e.textContent),
    draft: document.querySelector('#message-input').value,
    partial: [...document.querySelectorAll('.conversation-partial')].some(e => !e.hidden),
    errors: qaErrors,
  }))).toEqual({ instructions: ['Earlier instruction', 'Latest instruction'],
    draft: 'Preserved draft', partial: false, errors: [] });
  expect(gateway.historyRequests.filter(request => request.before !== null)).toHaveLength(1);
  const layout = await evaluate(() => {
    const root = document.querySelector('#messages');
    const style = getComputedStyle(root);
    const width = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const sets = [...root.querySelectorAll('.conversation-set')];
    return {
      widthLoss: sets.map(set => width - set.querySelector('.conversation-response').getBoundingClientRect().width),
      boundaryGap: sets[1].getBoundingClientRect().top - sets[0].getBoundingClientRect().bottom,
      ordinaryGap: parseFloat(style.rowGap),
      instructionGap: sets[1].querySelector('.conversation-response').getBoundingClientRect().top
        - sets[1].querySelector('.conversation-instruction').getBoundingClientRect().bottom,
    };
  });
  for (const loss of layout.widthLoss) expect(Math.abs(loss)).toBeLessThanOrEqual(1);
  expect(layout.boundaryGap).toBeCloseTo(layout.ordinaryGap, 0);
  expect(layout.instructionGap).toBeCloseTo(layout.ordinaryGap, 0);
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
