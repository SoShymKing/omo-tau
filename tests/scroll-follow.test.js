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

test.each([390, 1440])('follows a sent prompt through viewport resizing at width %i', async width => {
  await open(width);
  await view.click('#message-input');
  await view.cdp('Input.insertText', { text: 'Resize follow check' });
  const prompt = gateway.nextCommand('prompt');
  await view.click('#send-btn');
  await prompt;
  await atBottom();
  for (const height of [600, 844]) {
    await view.cdp('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width === 390,
    });
    await rendered();
    await atBottom();
    expect((await position()).gap).toBeLessThanOrEqual(1);
  }
  await deliver(response());
  expect((await position()).gap).toBeLessThanOrEqual(1);
  expect((await position()).errors).toEqual([]);
});

test.each([390, 1440])('preserves paused reading through viewport resizing at width %i', async width => {
  await open(width);
  await scrollToGap(400);
  const before = await position();
  const anchor = await reading();
  await view.cdp('Emulation.setDeviceMetricsOverride', {
    width, height: 600, deviceScaleFactor: 1, mobile: width === 390,
  });
  await rendered();
  await deliver(response());
  const after = await position();
  expect(after.top).toBe(before.top);
  expect(after.writes).toBe(before.writes);
  expect(await reading()).toEqual(anchor);
  expect(after.errors).toEqual([]);
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

test.each([390, 1440, 1920])('Tab skips hidden file controls without shifting the page at width %i', async width => {
  await open(width);
  await evaluate(() => {
    document.getElementById('message-input').focus();
    return true;
  });
  for (const type of ['keyDown', 'keyUp']) {
    await view.cdp('Input.dispatchKeyEvent', {
      type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
    });
  }
  const layout = await evaluate(() => ({
    hiddenFocus: document.getElementById('file-sidebar').contains(document.activeElement),
    agentsHidden: document.getElementById('agents-sidebar').inert,
    outerLeft: scrollX,
    width: document.scrollingElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(layout.hiddenFocus).toBe(false);
  expect(layout.agentsHidden).toBe(true);
  expect(layout.outerLeft).toBe(0);
  expect(layout.width).toBeLessThanOrEqual(layout.viewport);
  expect((await position()).errors).toEqual([]);
});

test('file controls regain focus only while open and release it when closed or switched', async () => {
  await open(1440);
  await view.click('#file-sidebar-toggle');
  expect(await evaluate(() => {
    document.getElementById('file-sidebar-up').focus();
    return document.activeElement.id;
  })).toBe('file-sidebar-up');
  await view.click('#file-sidebar-close');
  expect(await evaluate(() => document.activeElement.id)).toBe('file-sidebar-toggle');
  expect(await evaluate(() => {
    document.getElementById('file-sidebar-up').focus();
    return document.getElementById('file-sidebar').contains(document.activeElement);
  })).toBe(false);
  await view.click('#file-sidebar-toggle');
  expect(await evaluate(() => {
    document.getElementById('file-sidebar-up').focus();
    return document.activeElement.id;
  })).toBe('file-sidebar-up');
  const selection = gateway.nextSelection();
  gateway.disconnect();
  await selection;
  gateway.acknowledge();
  await ready();
  expect(await evaluate(() => {
    document.getElementById('file-sidebar-up').focus();
    return document.getElementById('file-sidebar').contains(document.activeElement);
  })).toBe(false);
  expect(await evaluate(() => scrollX)).toBe(0);
  expect((await position()).errors).toEqual([]);
});

test.each([390, 768, 769, 1440, 1920])('Agents and Files share one slot with only active body focusable at width %i', async width => {
  await open(width);
  await view.click('#agents-sidebar-toggle');
  const agents = await evaluate(() => {
    document.getElementById('agents-sidebar-close').focus();
    const agentsFocus = document.activeElement.id;
    document.getElementById('file-sidebar-up').focus();
    return { agentsFocus, focus: document.activeElement.id,
      width: document.getElementById('right-sidebar').getBoundingClientRect().width,
      overflow: document.scrollingElement.scrollWidth - innerWidth };
  });
  expect(agents.agentsFocus).toBe('agents-sidebar-close');
  expect(agents.focus).toBe('agents-sidebar-close');
  expect(agents.width).toBe(width <= 768 ? Math.min(360, width - 44) : 360);
  expect(agents.overflow).toBe(0);
  // Toolbar sits behind the phone backdrop; close it before choosing Files.
  if (width <= 768) await view.click('#agents-sidebar-close');
  await view.click('#file-sidebar-toggle');
  expect(await evaluate(() => ({
    files: document.getElementById('file-sidebar').inert,
    agents: document.getElementById('agents-sidebar').inert,
  }))).toEqual({ files: false, agents: true });
  expect((await position()).errors).toEqual([]);
});

test('mobile Agents closes by backdrop and Escape without aborting stream', async () => {
  await open(390);
  await deliver([{ type: 'agent_start' }]);
  await view.click('#agents-sidebar-toggle');
  await view.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 12, y: 400, button: 'left', clickCount: 1 });
  await view.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 12, y: 400, button: 'left', clickCount: 1 });
  expect(await evaluate(() => document.getElementById('right-sidebar').inert)).toBe(true);
  expect(await evaluate(() => document.activeElement.id)).toBe('agents-sidebar-toggle');
  await view.click('#agents-sidebar-toggle');
  await view.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  expect(await evaluate(() => document.getElementById('agents-sidebar').contains(document.activeElement))).toBe(true);
  await view.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  expect(await evaluate(() => document.getElementById('right-sidebar').inert)).toBe(true);
  expect(gateway.commands.filter(command => command.type === 'abort')).toEqual([]);
  expect(await evaluate(() => ({
    visible: document.getElementById('status-text').checkVisibility(),
    text: document.getElementById('status-text').textContent,
  }))).toEqual({ visible: true, text: 'Working...' });
});

test('mode switch and close release focus before the old body becomes inert', async () => {
  await open(1440);
  await view.click('#agents-sidebar-toggle');
  await evaluate(() => {
    document.getElementById('agents-sidebar-close').focus();
    window.focusAtInert = [];
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert');
    for (const id of ['agents-sidebar', 'file-sidebar']) {
      const panel = document.getElementById(id);
      Object.defineProperty(panel, 'inert', {
        get() { return descriptor.get.call(this); },
        set(value) {
          if (value) focusAtInert.push({ id, focusedInside: this.contains(document.activeElement) });
          descriptor.set.call(this, value);
        },
      });
    }
    document.getElementById('file-sidebar-toggle').click();
    document.getElementById('file-sidebar-up').focus();
    document.getElementById('file-sidebar-close').click();
  });
  expect(await evaluate(() => focusAtInert.every(event => !event.focusedInside))).toBe(true);
  expect(await evaluate(() => document.activeElement.id)).toBe('file-sidebar-toggle');
});

test('existing extension dialogs own Escape before the Agents panel', async () => {
  await open(1440);
  await view.click('#agents-sidebar-toggle');
  await deliver([{ type: 'extension_ui_request', method: 'confirm', id: 'confirm-priority',
    title: 'Confirm action', message: 'Synthetic dialog' }]);
  await view.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  expect(await evaluate(() => ({
    panel: document.getElementById('right-sidebar').inert,
    dialog: document.getElementById('dialog-container').classList.contains('hidden'),
  }))).toEqual({ panel: false, dialog: false });
  expect(gateway.commands.filter(command => command.type === 'abort')).toEqual([]);
});

test.each([1440, 1920])('Agents width and DAG expansion preserve paused reading and bottom follow at width %i', async width => {
  entries.forEach(entry => { entry.message.content += ' Long reading context.'.repeat(20); });
  await open(width);
  await scrollToGap(400);
  const before = await reading();
  await view.click('#agents-sidebar-toggle');
  await rendered();
  expect(await reading()).toEqual(before);
  await view.click('#agents-panel > details:last-of-type > summary');
  await rendered();
  expect(await reading()).toEqual(before);
  await view.click('#agents-panel > details:last-of-type > summary');
  await rendered();
  expect(await reading()).toEqual(before);
  await view.click('#agents-sidebar-close');
  await rendered();
  expect(await reading()).toEqual(before);
  await evaluate(() => {
    // Change width at the old smooth-scroll target, before native scrollend.
    window.panelAtBottom = new Promise((resolve, reject) => {
      const panel = document.getElementById('messages');
      const change = () => {
        if (panel.scrollHeight - panel.scrollTop - panel.clientHeight > 1) return;
        clearTimeout(timer);
        panel.removeEventListener('scroll', change);
        const toggle = document.getElementById('agents-sidebar-toggle');
        toggle.focus();
        toggle.click();
        resolve(true);
      };
      const timer = setTimeout(() => {
        panel.removeEventListener('scroll', change);
        reject(new Error('Smooth scroll did not reach the panel transition'));
      }, 3000);
      panel.addEventListener('scroll', change);
    });
  });
  await view.click('#scroll-bottom-btn');
  await view.evaluate('window.panelAtBottom');
  // Native scrollend can apply the reflowed bottom after the smooth-scroll target.
  await atBottom();
  expect((await position()).gap).toBeLessThanOrEqual(1);
  expect((await position()).errors).toEqual([]);
});

test.each(['night', 'clean'])('contains long task and DAG labels in theme %s', async theme => {
  await open(390);
  const long = 'Unbroken'.repeat(40);
  await deliver([{ type: 'agents_state', agentsState: { availability: 'ready', parent_session_id: 'owner',
    tasks: [{ task_id: 'long', model: long, status: 'running', task_summary: long,
      created_at: 'invalid', live_progress: { activity: long } }] },
    dagState: { availability: 'ready', parent_session_id: 'owner', runs: [
      { run_id: 'run', name: long, status: 'running', nodes: [{ id: long, state: 'pending', prompt: long, depends_on: [long] }] },
    ] } }]);
  await evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  await view.click('#agents-sidebar-toggle');
  await evaluate(() => { for (const detail of document.querySelectorAll('#agents-panel details')) detail.open = true; });
  await rendered();
  expect(await evaluate(() => ({
    page: document.scrollingElement.scrollWidth > innerWidth,
    panel: document.getElementById('agents-panel').scrollWidth > document.getElementById('agents-panel').clientWidth,
  }))).toEqual({ page: false, panel: false });
  expect((await position()).errors).toEqual([]);
});

const graphSnapshot = () => ({
  type: 'agents_state', agentsState: { availability: 'ready', tasks: [], parent_session_id: 'owner' },
  dagState: { availability: 'ready', parent_session_id: 'owner', runs: [
    { run_id: 'first', name: 'First workflow', status: 'running', nodes: [
      { id: 'plan', prompt: 'Plan', state: 'completed', depends_on: [] },
      { id: 'verify', prompt: 'Inspect workflow', state: 'running', depends_on: ['plan'] },
    ] },
    { run_id: 'second', name: 'Second workflow', status: 'running', nodes: [
      { id: 'other', prompt: 'Other workflow', state: 'running', depends_on: [] },
    ] },
  ] },
});

test('mobile Tab and Shift-Tab traverse select, Follow, nodes and Close without leaving active body', async () => {
  await open(390);
  await deliver([graphSnapshot()]);
  await view.click('#agents-sidebar-toggle');
  await rendered();
  await evaluate(() => { document.getElementById('agents-dag-select').focus(); });
  const key = async shiftKey => {
    for (const type of ['keyDown', 'keyUp']) await view.cdp('Input.dispatchKeyEvent', {
      type, key: 'Tab', code: 'Tab', modifiers: shiftKey ? 8 : 0, windowsVirtualKeyCode: 9,
    });
  };
  await key(false);
  expect(await evaluate(() => document.activeElement.dataset.action)).toBe('follow');
  await key(false);
  expect(await evaluate(() => document.activeElement.dataset.nodeId)).toBe('plan');
  await key(false);
  expect(await evaluate(() => document.activeElement.dataset.nodeId)).toBe('verify');
  await key(false);
  expect(await evaluate(() => document.activeElement.id)).toBe('agents-sidebar-close');
  await key(true);
  expect(await evaluate(() => document.activeElement.dataset.nodeId)).toBe('verify');
  await key(true); await key(true); await key(true);
  expect(await evaluate(() => document.activeElement.id)).toBe('agents-dag-select');
  expect((await position()).errors).toEqual([]);
});

test.each([[390, true], [1440, true], [390, false], [1440, false]])(
  'graph selection, follow and live updates preserve chat at width %i with reading paused %s', async (width, paused) => {
  await open(width);
  if (paused) await scrollToGap(400);
  const anchor = await reading();
  await deliver([graphSnapshot()]);
  const before = await position();
  await view.click('#agents-sidebar-toggle');
  await rendered();
  await view.click('button[data-node-id="verify"]');
  await evaluate(() => {
    const select = document.getElementById('agents-dag-select');
    select.value = 'second'; select.dispatchEvent(new Event('change'));
  });
  await view.click('button[data-action="follow"]');
  await deliver([graphSnapshot()]);
  const after = await position();
  if (paused) {
    expect(await reading()).toEqual(anchor);
    expect(after.writes).toBe(before.writes);
  } else {
    await atBottom();
    expect((await position()).gap).toBeLessThanOrEqual(1);
  }
  expect(gateway.commands.filter(command => !['ping', 'select_session'].includes(command.type))).toEqual([]);
  expect(after.errors).toEqual([]);
});

test.each(['night', 'clean'])('valid graph and missing/oversize states keep long text contained in %s', async theme => {
  await open(390);
  await evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  await view.click('#agents-sidebar-toggle');
  const long = 'Unbroken'.repeat(100);
  for (const kind of ['valid', 'missing', 'oversize', 'empty']) {
    const data = graphSnapshot();
    data.dagState.runs = [{
      run_id: 'first', name: long, status: 'running',
      nodes: kind === 'oversize' ? Array.from({ length: 201 }, (_, index) =>
        ({ id: `${long}${index}`, prompt: long, state: 'running', depends_on: [] })) :
        kind === 'empty' ? [] : [
          { id: 'plan', label: long, prompt: long, state: 'completed', depends_on: [] },
          { id: 'verify', label: long, prompt: long, state: 'running', depends_on: [kind === 'missing' ? long : 'plan'] },
        ],
    }];
    await deliver([data]);
    expect(await evaluate(() => ({
      page: document.scrollingElement.scrollWidth > innerWidth,
      panel: document.getElementById('agents-panel').scrollWidth > document.getElementById('agents-panel').clientWidth,
    }))).toEqual({ page: false, panel: false });
  }
  expect((await position()).errors).toEqual([]);
});
