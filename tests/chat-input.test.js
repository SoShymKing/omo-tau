import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

describe('chat input in the real application', () => {
  let gateway;
  let view;
  const evaluate = script => view.evaluate(`(${script.toString()})()`);

  async function open(width, touch) {
    view = new Bun.WebView({ width, height: 844 });
    await view.navigate('about:blank');
    await view.cdp('Emulation.setDeviceMetricsOverride', {
      width, height: 844, deviceScaleFactor: 1, mobile: touch,
    });
    await view.cdp('Emulation.setTouchEmulationEnabled', { enabled: touch });
    await view.navigate(gateway.server.url.href);
    await evaluate(() => new Promise((resolve, reject) => {
      const input = document.getElementById('message-input');
      if (!input.disabled) { resolve(true); return; }
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Session selection missing'));
      }, 3000);
      const observer = new MutationObserver(() => {
        if (input.disabled) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(true);
      });
      observer.observe(input, { attributes: true, attributeFilter: ['disabled'] });
    }));
    await evaluate(() => {
      window.qaPrompts = [];
      const send = qaSocket.send.bind(qaSocket);
      qaSocket.send = raw => {
        const command = JSON.parse(raw);
        if (command.type === 'prompt') qaPrompts.push(command.message);
        return send(raw);
      };
    });
    expect(await evaluate(() =>
      matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(touch);
  }

  async function enter(modifiers = 0) {
    await view.cdp('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      text: '\r', unmodifiedText: '\r', modifiers,
    });
    await view.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers,
    });
  }

  async function atBottom(action) {
    await evaluate(() => {
      const messages = document.getElementById('messages');
      window.qaBottom = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          messages.removeEventListener('scroll', onScroll);
          reject(new Error('Prompt did not resume scrolling'));
        }, 3000);
        function onScroll() {
          if (messages.scrollHeight - messages.scrollTop - messages.clientHeight > 1) return;
          clearTimeout(timer);
          messages.removeEventListener('scroll', onScroll);
          resolve(messages.scrollTop);
        }
        messages.addEventListener('scroll', onScroll);
      });
    });
    await action();
    expect(await view.evaluate('window.qaBottom')).toBeGreaterThan(0);
  }

  async function scrollUp() {
    await evaluate(() => new Promise((resolve, reject) => {
      const messages = document.getElementById('messages');
      const timer = setTimeout(() => {
        messages.removeEventListener('scroll', onScroll);
        reject(new Error('Upward scroll missing'));
      }, 3000);
      function onScroll() {
        clearTimeout(timer);
        messages.removeEventListener('scroll', onScroll);
        resolve(true);
      }
      messages.addEventListener('scroll', onScroll);
      messages.scrollTo({
        top: messages.scrollHeight - messages.clientHeight - 400, behavior: 'instant',
      });
    }));
  }

  beforeAll(async () => { gateway = await createStreamingGateway(); });
  afterEach(async () => { if (view) await view.close(); });
  afterAll(() => gateway?.close());

  test.each([390, 844])('touch Return inserts a newline and Send submits at width %i', async width => {
    await open(width, true);
    await view.click('#message-input');
    await view.cdp('Input.insertText', { text: 'first line' });
    await enter();
    await view.cdp('Input.insertText', { text: 'second line' });
    expect(await evaluate(() => ({
      value: document.getElementById('message-input').value,
      hint: document.getElementById('message-input').enterKeyHint,
      prompts: qaPrompts,
    }))).toEqual({ value: 'first line\nsecond line', hint: 'enter', prompts: [] });

    await view.click('#send-btn');
    expect(await evaluate(() => ({
      value: document.getElementById('message-input').value,
      prompts: qaPrompts, errors: qaErrors,
    }))).toEqual({ value: '', prompts: ['first line\nsecond line'], errors: [] });
  });

  test.each([390, 1440])('desktop Enter sends and Shift+Enter inserts a newline at width %i', async width => {
    await open(width, false);
    await view.click('#message-input');
    await view.cdp('Input.insertText', { text: 'first line' });
    await enter(8);
    await view.cdp('Input.insertText', { text: 'second line' });
    expect(await evaluate(() => ({
      value: document.getElementById('message-input').value,
      hint: document.getElementById('message-input').enterKeyHint,
      prompts: qaPrompts,
    }))).toEqual({ value: 'first line\nsecond line', hint: 'send', prompts: [] });

    await enter();
    expect(await evaluate(() => ({
      value: document.getElementById('message-input').value,
      prompts: qaPrompts, errors: qaErrors,
    }))).toEqual({ value: '', prompts: ['first line\nsecond line'], errors: [] });
  });

  test('desktop composition Enter does not send and Send remains available', async () => {
    await open(1440, false);
    await view.click('#message-input');
    await view.cdp('Input.insertText', { text: 'draft' });
    expect(await evaluate(() => {
      const input = document.getElementById('message-input');
      const event = new KeyboardEvent('keydown', {
        key: 'Enter', isComposing: true, bubbles: true, cancelable: true,
      });
      input.dispatchEvent(event);
      return { prevented: event.defaultPrevented, value: input.value, prompts: qaPrompts };
    })).toEqual({ prevented: false, value: 'draft', prompts: [] });

    await view.click('#send-btn');
    expect(await evaluate(() => ({ prompts: qaPrompts, errors: qaErrors })))
      .toEqual({ prompts: ['draft'], errors: [] });
  });

  test.each([390, 1440])('submitting a prompt resumes scrolling from history at width %i', async width => {
    await open(width, width === 390);
    await atBottom(() => gateway.send(Array.from({ length: 30 }, (_, i) => ({
      type: 'message_start', message: { role: 'user', content: `Earlier instruction ${i}` },
    }))));
    await view.click('#message-input');
    await view.cdp('Input.insertText', { text: 'new instruction' });
    await scrollUp();
    await atBottom(() => width === 390 ? view.click('#send-btn') : enter());
    expect(await evaluate(() => qaPrompts)).toEqual(['new instruction']);

    await atBottom(() => gateway.send([
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_update', assistantMessageEvent: {
        type: 'text_delta', delta: 'Following the response. '.repeat(300),
      } },
    ]));
    await view.click('#message-input');
    await view.cdp('Input.insertText', { text: 'queued instruction' });
    await scrollUp();
    await atBottom(() => view.click('#send-btn'));
    expect(await evaluate(() => ({
      prompts: qaPrompts,
      queued: document.querySelector('.queued-msg-text')?.textContent,
      errors: qaErrors,
    }))).toEqual({ prompts: ['new instruction'], queued: 'queued instruction', errors: [] });
  });
});
