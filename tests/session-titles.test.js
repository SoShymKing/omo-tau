import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

let gateway;
let view;
const evaluate = fn => view.evaluate(`(${fn.toString()})()`);

beforeAll(async () => {
  gateway = await createStreamingGateway({ projects: [{
    path: 'C:/streaming-test', dirName: 'streaming-test', sessions: [
      { filePath: 'streaming-test.jsonl', firstMessage: 'Original first request', mtime: Date.now() },
      { filePath: 'background.jsonl', name: 'Background session', mtime: Date.now() },
    ],
  }] });
  view = new Bun.WebView();
  const selected = gateway.nextSelection();
  await view.navigate(`http://127.0.0.1:${gateway.server.port}`);
  await selected;
  await evaluate(() => new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Missing session rows')); }, 3000);
    function check() {
      if (document.querySelectorAll('.session-item').length !== 2) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve();
    }
    observer.observe(document.documentElement, { childList: true, subtree: true });
    check();
  }));
});

afterAll(async () => {
  await view?.close();
  gateway?.close();
});

async function expectTitle(filePath, name, trigger) {
  // Subscribe to the rendered change before publishing the host event.
  await view.evaluate(`(() => { window.titleChange = new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Missing title update')); }, 3000);
    function check() {
      const title = document.querySelector('[data-file-path="${filePath}"] .session-title');
      if (title?.textContent !== ${JSON.stringify(name)}) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve();
    }
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    check();
  }); return true; })()`);
  trigger();
  await evaluate(() => window.titleChange);
  return view.evaluate(`(() => {
    const title = document.querySelector('[data-file-path="${filePath}"] .session-title');
    return { text: title.textContent, tooltip: title.title, errors: window.qaErrors };
  })()`);
}

test('a host summary replaces the first-request preview and survives a list rerender', async () => {
  // Given a selected session temporarily displaying its first request.
  expect(await evaluate(() => document.querySelector('.session-item.active .session-title').textContent))
    .toBe('Original first request');
  // When the host completes its short title.
  const result = await expectTitle('streaming-test.jsonl', 'Short request summary',
    () => gateway.send([{ type: 'session_info_changed', name: 'Short request summary' }]));
  // Then both the text and tooltip agree and the cached name survives sorting.
  expect(result).toEqual({ text: 'Short request summary', tooltip: 'Short request summary', errors: [] });
  expect(await evaluate(() => {
    const sort = document.getElementById('session-sort');
    sort.value = 'latest';
    sort.dispatchEvent(new Event('change'));
    return document.querySelector('.session-item.active .session-title').textContent;
  })).toBe('Short request summary');
});

test('background title status updates the correct row without changing the selected session', async () => {
  // Given a different session selected in the chat.
  // When a background session receives its host summary.
  const result = await expectTitle('background.jsonl', 'Background request summary',
    () => gateway.sendStatus({ sessionId: 'background', sessionFile: 'background.jsonl',
      epoch: 'background-epoch', sessionName: 'Background request summary' }));
  // Then only that row changes and the active title remains intact.
  expect(result).toEqual({ text: 'Background request summary', tooltip: 'Background request summary', errors: [] });
  expect(await evaluate(() => document.querySelector('.session-item.active').dataset.filePath))
    .toBe('streaming-test.jsonl');
});

test('cancelling an inline rename restores a summary that arrived during editing', async () => {
  // Given the actual inline editor in a title-filtered list.
  await evaluate(() => {
    window.editorReady = new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Missing rename editor')); }, 3000);
      function check() {
        if (!document.querySelector('.session-rename-input')) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      }
      observer.observe(document.getElementById('session-list'), { childList: true, subtree: true });
    });
    const search = document.getElementById('session-search-input');
    search.value = 'summary';
    search.dispatchEvent(new Event('input'));
    document.querySelector('.session-item.active').dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 30, clientY: 150,
    }));
    [...document.querySelectorAll('.context-menu-item')].find(item => item.textContent.includes('Rename')).click();
  });
  await evaluate(() => window.editorReady);
  await view.evaluate(`(() => {
    window.hostTitleDelivered = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Missing host title barrier')), 3000);
      const receive = event => {
        if (JSON.parse(event.data).id !== ${JSON.stringify(gateway.nextBarrier())}) return;
        clearTimeout(timeout);
        qaSocket.removeEventListener('message', receive);
        resolve();
      };
      qaSocket.addEventListener('message', receive);
    });
    return true;
  })()`);
  gateway.send([{ type: 'session_info_changed', name: 'Updated request summary' }]);
  await evaluate(() => window.hostTitleDelivered);
  expect(await evaluate(() => {
    const input = document.querySelector('.session-rename-input');
    return { focused: document.activeElement === input,
      visible: input.getBoundingClientRect().width > 0,
      draft: input.value };
  })).toEqual({ focused: true, visible: true, draft: 'Short request summary' });
  // When the user cancels without changing the draft.
  const restored = await evaluate(() => {
    document.querySelector('.session-rename-input').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true,
    }));
    const title = document.querySelector('.session-item.active .session-title');
    return { text: title.textContent, tooltip: title.title };
  });
  // Then the latest host title is restored, not the name captured on opening.
  expect(restored).toEqual({ text: 'Updated request summary', tooltip: 'Updated request summary' });
});
