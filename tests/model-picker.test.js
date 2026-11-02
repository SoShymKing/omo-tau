import { afterEach, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

let gateway;
let view;
const models = [
  { id: 'qa-model-a', provider: 'qa', contextWindow: 100000 },
  { id: 'qa-model-b', provider: 'qa', contextWindow: 200000 },
];
const first = { sessionId: 'model-a', sessionFile: 'model-a.jsonl', epoch: 'epoch-a' };
const second = { sessionId: 'model-b', sessionFile: 'model-b.jsonl', epoch: 'epoch-b' };
const evaluate = (fn, args = null) => view.evaluate(`(${fn.toString()})(${JSON.stringify(args)})`);

async function observe(predicate, action = () => {}) {
  return evaluate(({ predicate, action }) => new Promise((resolve, reject) => {
    const checkState = new Function(`return (${predicate})`)();
    const run = new Function(`return (${action})`)();
    const finish = error => {
      clearTimeout(timer);
      observer.disconnect();
      error ? reject(error) : resolve(true);
    };
    const check = () => { if (checkState()) finish(); };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => finish(new Error('Model state did not arrive')), 3000);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    run();
    check();
  }), { predicate: predicate.toString(), action: action.toString() });
}

async function open(rpcHandler) {
  gateway = await createStreamingGateway({
    holdSelection: true, rpcHandler,
    projects: [{ path: 'C:/qa', dirName: 'qa', sessions: [
      { filePath: first.sessionFile, name: 'Model session A', timestamp: '2026-01-01' },
      { filePath: second.sessionFile, name: 'Model session B', timestamp: '2026-01-01' },
    ] }],
  });
  gateway.setSnapshot({ ...first, contextUsage: { tokens: 50000, contextWindow: 100000 } });
  view = new Bun.WebView();
  await view.navigate(gateway.server.url.href);
  await gateway.nextSelection();
  gateway.acknowledge();
  await observe(() => document.querySelector('#model-dropdown-label').textContent === 'qa-model-a');
  await evaluate(() => {
    window.addEventListener('unhandledrejection', event => {
      event.preventDefault();
      qaErrors.push(String(event.reason));
    });
    window.qaModelConsumed = new Promise(resolve => {
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (args[0] === '/api/rpc' && JSON.parse(args[1].body).type === 'set_model') {
          const originalJson = response.json.bind(response);
          response.json = async () => {
            const result = await originalJson();
            resolve(result);
            return result;
          };
        }
        return response;
      };
    });
  });
}

function modelRpc(command) {
  if (command.type === 'get_available_models') return { success: true, data: { models } };
  return { success: true, data: { model: models[0], thinkingLevel: 'off' } };
}

async function chooseSecondModel() {
  await evaluate(() => {
    document.querySelector('#model-dropdown-btn').click();
    document.querySelector('.model-dropdown-item:last-child').click();
  });
}

const visible = () => evaluate(() => ({
  model: document.querySelector('#model-dropdown-label').textContent,
  thinking: document.querySelector('#thinking-btn').textContent,
  usage: document.querySelector('#token-usage').textContent,
  errors: qaErrors,
}));

afterEach(async () => {
  if (view) await view.close();
  gateway?.close();
  view = null;
  gateway = null;
});

test('updates the model and context display when selection succeeds', async () => {
  // Given the real application with a different selectable context window.
  const requests = [];
  await open(command => {
    if (command.type !== 'set_model') return modelRpc(command);
    requests.push(command);
    return { success: true, data: models[1] };
  });

  // When the selected session accepts the second model.
  await chooseSecondModel();
  await view.evaluate('window.qaModelConsumed');

  // Then both the displayed model and context usage follow the accepted selection.
  expect(requests).toEqual([{ type: 'set_model', sessionId: first.sessionId, provider: 'qa', modelId: 'qa-model-b' }]);
  expect(await visible()).toEqual({ model: 'qa-model-b', thinking: 'off', usage: '25%', errors: [] });
});

test('refreshes model, thinking and context state when the host selects a model', async () => {
  // Given a ready browser and a host whose model state can change independently.
  let current = { model: models[0], thinkingLevel: 'off' };
  await open(command => command.type === 'get_state' ? { success: true, data: current } : modelRpc(command));

  // When a model selection notification follows the authoritative state change.
  current = { model: models[1], thinkingLevel: 'high' };
  gateway.send([{ type: 'model_select', model: models[1], source: 'extension' }]);
  await observe(() => document.querySelector('#thinking-btn').textContent === 'high');

  // Then all model-dependent controls reflect the host state.
  expect(await visible()).toEqual({ model: 'qa-model-b', thinking: 'high', usage: '25%', errors: [] });
});

test('keeps the previous model visible when selection is rejected', async () => {
  // Given a ready browser whose host rejects the second model.
  await open(command => command.type === 'set_model'
    ? { success: false, error: 'qa-model-rejected' } : modelRpc(command));

  // When the user selects the rejected model.
  await chooseSecondModel();
  await view.evaluate('window.qaModelConsumed');

  // Then the old model remains without an unhandled exception.
  expect(await visible()).toEqual({ model: 'qa-model-a', thinking: 'off', usage: '50%', errors: [] });
  expect(await evaluate(() => document.querySelector('#status-text').textContent)).toBe('qa-model-rejected');
});

test('does not apply an old model response after another session is selected', async () => {
  // Given a model request whose response is held while the user changes sessions.
  const requested = Promise.withResolvers();
  const response = Promise.withResolvers();
  await open(command => {
    if (command.type === 'set_model') {
      requested.resolve();
      return response.promise;
    }
    if (command.type === 'get_state' && command.sessionId === second.sessionId) {
      return { success: true, data: { model: models[0], thinkingLevel: 'low' } };
    }
    return modelRpc(command);
  });
  await chooseSecondModel();
  await requested.promise;
  await evaluate(() => document.querySelector('.session-item[data-file-path="model-b.jsonl"]').click());
  await gateway.nextSelection();
  gateway.setSnapshot({ ...second, model: models[0], thinkingLevel: 'low' });
  gateway.acknowledge();
  await observe(() => document.querySelector('#thinking-btn').textContent === 'low');

  // When the old session finally replies.
  response.resolve({ success: true, data: models[1] });
  await view.evaluate('window.qaModelConsumed');

  // Then the newly selected session keeps its own model and thinking state.
  expect(await visible()).toEqual({ model: 'qa-model-a', thinking: 'low', usage: '50%', errors: [] });
});
