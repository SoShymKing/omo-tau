import { afterEach, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

let gateway;
let view;
const evaluate = (fn, args = null) => view.evaluate(`(${fn.toString()})(${JSON.stringify(args)})`);

async function ready() {
  return evaluate(() => new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      observer.disconnect();
      error ? reject(error) : resolve(true);
    };
    const check = () => {
      if (document.querySelector('#session-preview-status')?.classList.contains('hidden') &&
          document.querySelector('#messages')?.textContent.includes('Selected session history')) finish();
    };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => finish(new Error('Session did not become ready')), 3000);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    check();
  }));
}

async function open() {
  gateway = await createStreamingGateway({ holdSelection: true, entries: [{
    type: 'message', message: { role: 'user', content: 'Selected session history' },
  }] });
  view = new Bun.WebView();
  await view.navigate(gateway.server.url.href);
  await gateway.nextSelection();
  gateway.acknowledge();
  await ready();
}

afterEach(() => {
  view?.close();
  gateway?.close();
  view = null;
  gateway = null;
});

test('reload keeps this tab selection after another tab changes the shared default', async () => {
  // Given a ready tab and another tab selecting a different session.
  await open();
  await evaluate(() => localStorage.setItem(`tau-selected-session:${location.origin}`, 'other-tab.jsonl'));
  // When this tab reloads the actual application.
  const selected = gateway.nextSelection();
  await view.navigate(gateway.server.url.href);
  // Then it restores its own selection rather than the shared default.
  expect((await selected).sessionFile).toBe('streaming-test.jsonl');
  gateway.acknowledge();
  await ready();
});

test('reconnect prefers the displayed session over changed storage and preserves its draft', async () => {
  // Given a ready session with a draft and conflicting saved selections.
  await open();
  await evaluate(() => {
    const key = `tau-selected-session:${location.origin}`;
    sessionStorage.setItem(key, 'stale-tab.jsonl');
    localStorage.setItem(key, 'other-tab.jsonl');
    const input = document.querySelector('#message-input');
    input.value = 'Keep this tab draft';
    input.dispatchEvent(new Event('input'));
  });
  // When the connection drops and the gateway sends its initial state again.
  const selected = gateway.nextSelection();
  gateway.disconnect();
  // Then the in-memory selection wins and the acknowledged draft remains local.
  expect((await selected).sessionFile).toBe('streaming-test.jsonl');
  gateway.acknowledge();
  await ready();
  expect(await evaluate(() => document.querySelector('#message-input').value)).toBe('Keep this tab draft');
});

test('a tab without its own saved selection retains the shared startup default', async () => {
  // Given a shared last selection but no selection saved for this tab.
  await open();
  await evaluate(() => {
    const key = `tau-selected-session:${location.origin}`;
    sessionStorage.removeItem(key);
    localStorage.setItem(key, 'shared-default.jsonl');
  });
  gateway.setSnapshot({ sessionFile: 'shared-default.jsonl' });
  // When a document starts without an in-memory or tab-local selection.
  const selected = gateway.nextSelection();
  await view.navigate(gateway.server.url.href);
  // Then the existing shared default still applies.
  expect((await selected).sessionFile).toBe('shared-default.jsonl');
  gateway.acknowledge();
  await ready();
});
