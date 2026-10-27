import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

describe('chat input in the real application', () => {
  let gateway;
  let view;
  const evaluate = script => view.evaluate(`(${script.toString()})()`);

  async function open(width, touch, { mobile = touch, userAgent, platform } = {}) {
    view = new Bun.WebView({ width, height: 844 });
    await view.navigate('about:blank');
    await view.cdp('Emulation.setDeviceMetricsOverride', {
      width, height: 844, deviceScaleFactor: 1, mobile,
    });
    await view.cdp('Emulation.setTouchEmulationEnabled', {
      enabled: touch, maxTouchPoints: touch ? 5 : 1,
    });
    if (mobile || userAgent) {
      await view.cdp('Emulation.setUserAgentOverride', {
        userAgent: userAgent || 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
        platform: platform || 'Linux armv8l',
      });
    }
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
      window.qaImageCounts = [];
      const send = qaSocket.send.bind(qaSocket);
      qaSocket.send = raw => {
        const command = JSON.parse(raw);
        if (command.type === 'prompt') {
          qaPrompts.push(command.message);
          qaImageCounts.push(command.images?.length || 0);
        }
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

  async function deliver(events) {
    await view.evaluate(`(() => { window.qaDelivered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Event barrier missing')), 3000);
      const listener = event => {
        if (JSON.parse(event.data).id !== ${JSON.stringify(gateway.nextBarrier())}) return;
        clearTimeout(timer);
        qaSocket.removeEventListener('message', listener);
        resolve(true);
      };
      qaSocket.addEventListener('message', listener);
    }); return true; })()`);
    gateway.send(events);
    await view.evaluate('window.qaDelivered');
  }

  const actions = () => evaluate(() => ({
    send: !document.getElementById('send-btn').classList.contains('hidden'),
    abort: !document.getElementById('abort-btn').classList.contains('hidden'),
    disabled: document.getElementById('send-btn').disabled,
  }));

  async function attachImage() {
    await evaluate(() => new Promise((resolve, reject) => {
      const previews = document.getElementById('image-previews');
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Image preview missing'));
      }, 3000);
      const observer = new MutationObserver(() => {
        if (!previews.querySelector('.image-preview')) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(true);
      });
      observer.observe(previews, { childList: true });
      const bytes = Uint8Array.from(atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/csAAAAASUVORK5CYII=',
      ), character => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }));
      const input = document.getElementById('image-input');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));
    }));
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

  test.each([
    [390, 'mouse'], [1440, 'mouse'], [390, 'touch'], [1440, 'touch'],
  ])('desktop Enter sends and Shift+Enter inserts a newline at width %i with %s', async (width, pointer) => {
    await open(width, pointer === 'touch', { mobile: false });
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

  test.each([
    ['iPhone', 390, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'iPhone'],
    ['iPad', 1024, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 'MacIntel'],
  ])('%s Return inserts a newline and Send submits', async (_device, width, userAgent, platform) => {
    await open(width, true, { mobile: true, userAgent, platform });
    await view.click('#message-input');
    await view.cdp('Input.insertText', { text: 'mobile instruction' });
    await enter();
    expect(await evaluate(() => ({
      value: document.getElementById('message-input').value,
      hint: document.getElementById('message-input').enterKeyHint, prompts: qaPrompts,
    }))).toEqual({ value: 'mobile instruction\n', hint: 'enter', prompts: [] });
    await view.click('#send-btn');
    expect(await evaluate(() => ({
      value: document.getElementById('message-input').value, prompts: qaPrompts, errors: qaErrors,
    }))).toEqual({ value: '', prompts: ['mobile instruction'], errors: [] });
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

  test.each([390, 1440])('composer action follows draft contents while working at width %i', async width => {
    await open(width, width === 390);
    expect(await actions()).toEqual({ send: true, abort: false, disabled: true });
    await deliver([{ type: 'agent_start' }]);
    expect(await actions()).toEqual({ send: false, abort: true, disabled: true });

    await view.click('#message-input');
    await view.cdp('Input.insertText', { text: 'additional instruction' });
    expect(await actions()).toEqual({ send: true, abort: false, disabled: false });
    await evaluate(() => {
      const input = document.getElementById('message-input');
      input.value = ' \n ';
      input.dispatchEvent(new Event('input'));
    });
    expect(await actions()).toEqual({ send: false, abort: true, disabled: true });
    await view.cdp('Input.insertText', { text: 'queued instruction' });
    expect(await actions()).toEqual({ send: true, abort: false, disabled: false });
    await view.click('#send-btn');
    expect(await actions()).toEqual({ send: false, abort: true, disabled: true });
    expect(await evaluate(() => ({
      queued: document.querySelectorAll('.queued-msg').length,
      draft: document.getElementById('message-input').value,
      sent: qaPrompts,
    }))).toEqual({ queued: 1, draft: '', sent: [] });
    await deliver([{ type: 'agent_end' }]);
    expect(await actions()).toEqual({ send: true, abort: false, disabled: true });
    expect(await evaluate(() => ({
      queued: document.querySelectorAll('.queued-msg').length, sent: qaPrompts, errors: qaErrors,
    }))).toEqual({ queued: 0, sent: ['queued instruction'], errors: [] });
  });

  test.each([390, 1440])('image-only drafts switch the composer action at width %i', async width => {
    await open(width, width === 390);
    await deliver([{ type: 'agent_start' }]);
    await attachImage();
    expect(await actions()).toEqual({ send: true, abort: false, disabled: false });
    await view.click('.image-preview-remove');
    expect(await actions()).toEqual({ send: false, abort: true, disabled: true });
    await attachImage();
    await view.click('#send-btn');
    expect(await actions()).toEqual({ send: false, abort: true, disabled: true });
    expect(await evaluate(() => ({
      queued: document.querySelectorAll('.queued-msg').length,
      previews: document.querySelectorAll('.image-preview').length, sent: qaPrompts,
    }))).toEqual({ queued: 1, previews: 0, sent: [] });
    await deliver([{ type: 'agent_end' }]);
    expect(await evaluate(() => ({
      sent: qaPrompts, images: qaImageCounts, errors: qaErrors,
    }))).toEqual({ sent: ['(see attached image)'], images: [1], errors: [] });
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
