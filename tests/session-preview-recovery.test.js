import { afterEach, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

let gateway;
let view;
let releaseHistory;
const entries = [{ type: 'message', message: { role: 'user', content: 'RECOVERED-HISTORY' } }];
const evaluate = (fn, arg = null) => view.evaluate(`(${fn.toString()})(${JSON.stringify(arg)})`);

async function observe(predicate, action = () => {}) {
  return evaluate(({ predicate, action }) => new Promise((resolve, reject) => {
    const condition = new Function(`return (${predicate})`)();
    const run = new Function(`return (${action})`)();
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => finish(new Error('Preview did not recover')), 3000);
    function finish(error) {
      clearTimeout(timeout);
      observer.disconnect();
      error ? reject(error) : resolve(true);
    }
    function check() { if (condition()) finish(); }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    run();
    check();
  }), { predicate: predicate.toString(), action: action.toString() });
}

async function open(options = {}) {
  gateway = await createStreamingGateway({ holdSelection: true, entries, ...options });
  view = new Bun.WebView();
  await view.navigate(gateway.server.url.href);
}

afterEach(() => {
  releaseHistory?.();
  releaseHistory = null;
  view?.close();
  gateway?.close();
  view = null;
  gateway = null;
});

test('loads the saved tab preview before gateway state without authorizing input', async () => {
  // Given a saved tab selection and a gateway that has not sent its state.
  await open({ holdState: true, initialSessionFile: 'streaming-test.jsonl' });
  // When the document loads independently of the WebSocket gateway handshake.
  await observe(() => document.querySelector('#messages').textContent.includes('RECOVERED-HISTORY'));
  // Then history and draft editing work, but no session command has been sent.
  expect(gateway.commands).toEqual([]);
  expect(gateway.historyRequests).toHaveLength(1);
  expect(await evaluate(() => ({
    editable: !document.querySelector('#message-input').disabled,
    sendDisabled: document.querySelector('#send-btn').disabled,
  }))).toEqual({ editable: true, sendDisabled: true });
});

test('acknowledges an early preview without fetching it again or losing its draft', async () => {
  // Given history already visible while gateway state is withheld.
  await open({ holdState: true, initialSessionFile: 'streaming-test.jsonl' });
  await observe(() => document.querySelector('#messages').textContent.includes('RECOVERED-HISTORY'));
  await evaluate(() => {
    const input = document.querySelector('#message-input');
    input.value = 'Draft before gateway state';
    input.dispatchEvent(new Event('input'));
  });
  const selected = gateway.nextSelection();
  // When the gateway becomes ready and acknowledges the same session.
  gateway.releaseState();
  expect((await selected).sessionFile).toBe('streaming-test.jsonl');
  const ready = observe(() => document.querySelector('#session-preview-status').classList.contains('hidden'));
  gateway.acknowledge();
  await ready;
  // Then selection is not duplicated and the successful preview is not reread.
  expect(gateway.commands.filter(command => command.type === 'select_session')).toHaveLength(1);
  expect(gateway.historyRequests).toHaveLength(1);
  expect(await evaluate(() => document.querySelector('#message-input').value)).toBe('Draft before gateway state');
});

test('retries failed history even when initial selection left an error message', async () => {
  // Given a failed initial history request and a failed initial selection.
  await open({ previewFailures: 1 });
  await gateway.nextSelection();
  const failed = observe(() => !!document.querySelector('#messages .error-message') &&
    !document.querySelector('#session-preview-retry').classList.contains('hidden'));
  gateway.failSelection();
  await failed;
  expect(gateway.historyRequests).toHaveLength(1);
  // When Retry runs after the history endpoint recovers, before acknowledgement.
  await observe(() => document.querySelector('#messages').textContent.includes('RECOVERED-HISTORY'),
    () => document.querySelector('#session-preview-retry').click());
  // Then a real history request replaces the error-only view without enabling Send.
  expect(gateway.historyRequests).toHaveLength(2);
  expect(await evaluate(() => ({
    errors: document.querySelectorAll('#messages .error-message').length,
    sendDisabled: document.querySelector('#send-btn').disabled,
  }))).toEqual({ errors: 0, sendDisabled: true });
});

test('keeps an in-flight early preview when gateway state arrives', async () => {
  // Given an initial HTTP history request held independently of gateway state.
  let requested;
  const pending = new Promise(resolve => { requested = resolve; });
  const history = new Promise(resolve => { releaseHistory = resolve; });
  await open({
    holdState: true, initialSessionFile: 'streaming-test.jsonl',
    previewGate(request) { requested(request.signal); return history; },
  });
  const request = await Promise.race([
    pending,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Early history request never started')), 3000);
      pending.then(() => clearTimeout(timer));
    }),
  ]);
  const selected = gateway.nextSelection();
  // When the gateway state arrives before that HTTP response.
  gateway.releaseState();
  await selected;
  releaseHistory();
  await observe(() => document.querySelector('#messages').textContent.includes('RECOVERED-HISTORY'));
  // Then the original request remains live and produces the preview without duplication.
  expect(request.aborted).toBe(false);
  expect(gateway.historyRequests).toHaveLength(1);
});
