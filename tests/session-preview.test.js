import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

let gateway;
let view;
const evaluate = (fn, args = null) => view.evaluate(`(${fn.toString()})(${JSON.stringify(args)})`);

async function observe(predicate, action = () => {}) {
  return evaluate(({ condition, action }) => new Promise((resolve, reject) => {
    const test = new Function(`return (${condition})`)();
    const run = new Function(`return (${action})`)();
    const finish = error => {
      clearTimeout(timeout);
      observer.disconnect();
      error ? reject(error) : resolve(true);
    };
    const check = () => { if (test()) finish(); };
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => finish(new Error('Preview state did not arrive')), 3000);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    run();
    check();
  }), { condition: predicate.toString(), action: action.toString() });
}

beforeAll(async () => {
  gateway = await createStreamingGateway({ holdSelection: true, entries: [
    { type: 'message', message: { role: 'user', content: 'PREVIEW-QUESTION' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'PREVIEW-ANSWER' }] } },
  ] });
  view = new Bun.WebView();
  await view.navigate(`http://127.0.0.1:${gateway.server.port}`);
});

afterAll(() => {
  view?.close();
  gateway?.close();
});

test('shows persisted history with editable drafts before acknowledgement, without sending commands', async () => {
  // Given the actual application with its initial selection held at the gateway.
  await gateway.nextSelection();
  await observe(() => document.querySelector('#messages').textContent.includes('PREVIEW-ANSWER'));
  // When the user types and presses Enter before readiness.
  await evaluate(() => {
    const input = document.querySelector('#message-input');
    input.value = 'unsent preview draft';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  // Then local edits survive and nothing except selection reaches the gateway.
  expect(await evaluate(() => ({
    disabled: document.querySelector('#message-input').disabled,
    sendDisabled: document.querySelector('#send-btn').disabled,
    sendLooksUnavailable: Number(getComputedStyle(document.querySelector('#send-btn')).opacity) < 1,
    statusVisible: !document.querySelector('#session-preview-status').classList.contains('hidden'),
    bannerBelowHeader: document.querySelector('#session-preview-status').getBoundingClientRect().top >=
      document.querySelector('.header').getBoundingClientRect().bottom,
    draft: document.querySelector('#message-input').value,
    errors: window.qaErrors,
  }))).toEqual({ disabled: false, sendDisabled: true, sendLooksUnavailable: true, statusVisible: true, bannerBelowHeader: true,
    draft: 'unsent preview draft', errors: [] });
  expect(gateway.commands.map(command => command.type)).toEqual(['select_session']);
});

test('keeps the target history and draft after failure and retries without authorizing commands early', async () => {
  // Given that the held preparation fails.
  const failed = observe(() => !document.querySelector('#session-preview-retry').classList.contains('hidden'));
  gateway.failSelection();
  await failed;
  // When Retry creates another pending selection.
  const retried = gateway.nextSelection();
  await observe(() => document.querySelector('#session-preview-retry').classList.contains('hidden'),
    () => document.querySelector('#session-preview-retry').click());
  await retried;
  // Then the preview and draft are still local, not an acknowledged route.
  expect(await evaluate(() => ({
    text: document.querySelector('#messages').textContent.includes('PREVIEW-ANSWER'),
    draft: document.querySelector('#message-input').value,
    sendDisabled: document.querySelector('#send-btn').disabled,
  }))).toEqual({ text: true, draft: 'unsent preview draft', sendDisabled: true });
});

test('promotes the same draft only after the latest authoritative snapshot', async () => {
  // Given the latest retry still awaiting its acknowledgement.
  const ready = observe(() => !document.querySelector('#send-btn').disabled);
  // When its actual correlated snapshot is released.
  gateway.acknowledge();
  await ready;
  // Then history and draft remain while commands become available.
  expect(await evaluate(() => ({
    text: document.querySelector('#messages').textContent.includes('PREVIEW-ANSWER'),
    draft: document.querySelector('#message-input').value,
    hidden: document.querySelector('#session-preview-status').classList.contains('hidden'),
    errors: window.qaErrors,
  }))).toEqual({ text: true, draft: 'unsent preview draft', hidden: true, errors: [] });
});
