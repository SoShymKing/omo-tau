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
});
