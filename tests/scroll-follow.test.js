import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

let gateway;
let view;
let entries;
let earlierEntries;
let history;
const historyEntry = index => ({
  id: `entry-${index}`, type: 'message',
  message: { role: 'user', content: `Earlier instruction ${index}` },
});
const evaluate = (fn, args = null) => view.evaluate(`(${fn.toString()})(${JSON.stringify(args)})`);
const position = () => evaluate(() => {
  const messages = document.getElementById('messages');
  return {
    top: messages.scrollTop,
    gap: messages.scrollHeight - messages.clientHeight - messages.scrollTop,
    writes: window.qaScrollWrites,
    errors: window.qaErrors,
  };
});
const reading = () => evaluate(() => {
  const top = document.querySelector('.header').getBoundingClientRect().bottom;
  const row = [...document.querySelectorAll('#messages .message')]
    .find(element => element.getBoundingClientRect().bottom > top);
  return { text: row.querySelector('.message-content').textContent, offset: row.getBoundingClientRect().top };
});

async function rendered() {
  await evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  }));
}

async function ready() {
  await evaluate(() => new Promise((resolve, reject) => {
    const isReady = () => !document.getElementById('attach-btn').disabled &&
      document.getElementById('session-preview-status').classList.contains('hidden');
    if (isReady()) { resolve(true); return; }
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Selected session did not become ready'));
    }, 3000);
    const observer = new MutationObserver(() => {
      if (!isReady()) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(true);
    });
    observer.observe(document.querySelector('.main'), {
      childList: true, subtree: true, attributes: true,
    });
  }));
  await rendered();
}

async function atBottom() {
  await evaluate(() => new Promise((resolve, reject) => {
    const messages = document.getElementById('messages');
    const isAtBottom = () => messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 1;
    if (isAtBottom()) { resolve(true); return; }
    const timer = setTimeout(() => {
      messages.removeEventListener('scroll', check);
      reject(new Error('Output did not reach the bottom'));
    }, 3000);
    function check() {
      if (!isAtBottom()) return;
      clearTimeout(timer);
      messages.removeEventListener('scroll', check);
      resolve(true);
    }
    messages.addEventListener('scroll', check);
  }));
}

async function open(width) {
  view = new Bun.WebView({ width, height: 844 });
  await view.navigate('about:blank');
  await view.cdp('Emulation.setDeviceMetricsOverride', {
    width, height: 844, deviceScaleFactor: 1, mobile: width === 390,
  });
  await view.cdp('Emulation.setTouchEmulationEnabled', { enabled: width === 390 });
  await view.navigate(gateway.server.url.href);
  await gateway.nextSelection();
  gateway.acknowledge();
  await ready();
  await atBottom();
  await evaluate(() => {
    const messages = document.getElementById('messages');
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    window.qaScrollWrites = 0;
    Object.defineProperty(messages, 'scrollTop', {
      get() { return descriptor.get.call(this); },
      set(value) { qaScrollWrites++; descriptor.set.call(this, value); },
    });
    return true;
  });
  expect((await position()).gap).toBeLessThanOrEqual(1);
}

async function scrollToGap(gap) {
  await evaluate(gap => new Promise((resolve, reject) => {
    const messages = document.getElementById('messages');
    const top = messages.scrollHeight - messages.clientHeight - gap;
    const timer = setTimeout(() => {
      messages.removeEventListener('scroll', onScroll);
      reject(new Error('Native scroll did not arrive'));
    }, 3000);
    function onScroll() {
      clearTimeout(timer);
      messages.removeEventListener('scroll', onScroll);
      resolve(true);
    }
    messages.addEventListener('scroll', onScroll);
    messages.scrollTo({ top, behavior: 'instant' });
  }), gap);
}

async function deliver(events) {
  await evaluate(id => {
    window.qaDelivered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Event barrier missing')), 3000);
      function listener(event) {
        if (JSON.parse(event.data).id !== id) return;
        clearTimeout(timer);
        qaSocket.removeEventListener('message', listener);
        resolve(true);
      }
      qaSocket.addEventListener('message', listener);
    });
    return true;
  }, gateway.nextBarrier());
  gateway.send(events);
  await view.evaluate('window.qaDelivered');
  await rendered();
}

const response = () => [
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  { type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', delta: 'Additional output. '.repeat(200),
  } },
];
const notification = () => ({
  type: 'extension_ui_request', method: 'notify', notifyType: 'info', message: 'Scroll notification',
});

beforeEach(async () => {
  view = null;
  entries = Array.from({ length: 40 }, (_, index) => historyEntry(index));
  earlierEntries = [];
  history = { before: null };
  gateway = await createStreamingGateway({
    holdSelection: true, entries, earlierEntries, history,
  });
});
afterEach(async () => {
  if (view) await view.close();
  gateway?.close();
});

test.each([390, 1440])('keeps manual reading paused after a small reversal at width %i', async width => {
  await open(width);
  await scrollToGap(45);
  await scrollToGap(25);
  const before = await position();
  await deliver(response());
  const after = await position();
  expect(after.top).toBe(before.top);
  expect(after.writes).toBe(before.writes);
  expect(after.gap).toBeGreaterThan(25);
  expect(after.errors).toEqual([]);
});

test.each([390, 1440])('preserves reading position while reconnecting the same session at width %i', async width => {
  await open(width);
  await scrollToGap(400);
  const before = await position();
  const selection = gateway.nextSelection();
  gateway.disconnect();
  await selection;
  await rendered();
  expect((await position()).top).toBe(before.top);
  gateway.acknowledge();
  await ready();
  expect((await position()).top).toBe(before.top);
  await deliver(response());
  const after = await position();
  expect(after.top).toBe(before.top);
  expect(after.errors).toEqual([]);
});

test.each([390, 1440])('notifications respect paused reading at width %i', async width => {
  await open(width);
  await scrollToGap(400);
  const before = await position();
  await deliver([notification()]);
  const after = await position();
  expect(after.writes).toBe(before.writes);
  expect(after.top).toBe(before.top);
  expect(after.errors).toEqual([]);
});

test.each([[390, 3], [1440, 3], [390, 35], [1440, 35]])(
  'keeps the reading anchor at width %i after evicting %i entries', async (width, count) => {
    await open(width);
    await scrollToGap(400);
    const before = await reading();
    const selection = gateway.nextSelection();
    gateway.disconnect();
    await selection;
    earlierEntries.push(...entries.splice(0, count));
    entries.push(...Array.from({ length: count }, (_, index) => historyEntry(40 + index)));
    history.before = count;
    if (count === 35) {
      await evaluate(before => {
        window.qaAnchorRestored = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error('Reading anchor was not retrieved from earlier history'));
          }, 5000);
          const observer = new MutationObserver(() => {
            const rows = [...document.querySelectorAll('#messages .message')];
            if (!rows.some(row => row.querySelector('.message-content').textContent === 'Earlier instruction 40')) return;
            const anchor = rows.find(row => row.querySelector('.message-content').textContent === before.text);
            if (!anchor || Math.abs(anchor.getBoundingClientRect().top - before.offset) > 1) return;
            clearTimeout(timer);
            observer.disconnect();
            resolve(true);
          });
          observer.observe(document.getElementById('messages'), { childList: true, subtree: true });
        });
        return true;
      }, before);
    }
    gateway.acknowledge();
    await ready();
    if (count === 35) await view.evaluate('window.qaAnchorRestored');
    const after = await reading();
    expect(after.text).toBe(before.text);
    expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);
    await deliver(response());
    expect((await reading()).text).toBe(before.text);
  },
  10000,
);

test.each([390, 1440])('notifications continue following at the bottom at width %i', async width => {
  await open(width);
  await deliver([notification()]);
  const after = await position();
  expect(after.writes).toBeGreaterThan(0);
  expect(after.gap).toBeLessThanOrEqual(1);
  expect(after.errors).toEqual([]);
});

test.each([390, 1440])('reconnection keeps active output following at width %i', async width => {
  await open(width);
  const selection = gateway.nextSelection();
  gateway.disconnect();
  await selection;
  gateway.acknowledge();
  await ready();
  await deliver(response());
  expect((await position()).gap).toBeLessThanOrEqual(1);
});

test.each([390, 1440])('returning fully to the bottom resumes output following at width %i', async width => {
  await open(width);
  await scrollToGap(400);
  await scrollToGap(0);
  await deliver(response());
  expect((await position()).gap).toBeLessThanOrEqual(1);
});

test.each([390, 1440])('contains hidden math within the chat scrollport at width %i', async width => {
  entries.splice(0, entries.length, ...Array.from({ length: 40 }, (_, index) => ({
    id: `math-entry-${index}`, type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: `Math explanation ${index}. ` + 'Reading context. '.repeat(20) }] },
  })));
  await open(width);
  await evaluate(() => {
    // Reproduce KaTeX's accessibility layer without a network dependency.
    const style = document.createElement('style');
    style.textContent = `.qa-math .katex-mathml {
      position: absolute; clip: rect(1px, 1px, 1px, 1px);
      padding: 0; border: 0; height: 1px; width: 1px; overflow: hidden;
    }`;
    document.head.appendChild(style);
    for (const content of document.querySelectorAll('#messages .message-content')) {
      const math = document.createElement('span');
      math.className = 'qa-math';
      math.innerHTML = '<span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></span><span aria-hidden="true"> x</span>';
      content.appendChild(math);
    }
    return true;
  });
  for (const gap of [400, 0]) {
    await scrollToGap(gap);
    await rendered();
    const layout = await evaluate(() => ({
      height: document.documentElement.scrollHeight,
      viewport: innerHeight,
      outerTop: scrollY,
      mathCount: document.querySelectorAll('#messages math').length,
      hiddenMathDisplay: getComputedStyle(document.querySelector('.katex-mathml')).display,
    }));
    expect(layout.height).toBeLessThanOrEqual(layout.viewport);
    expect(layout.outerTop).toBe(0);
    expect(layout.mathCount).toBe(40);
    expect(layout.hiddenMathDisplay).not.toBe('none');
  }
  expect((await position()).errors).toEqual([]);
});
