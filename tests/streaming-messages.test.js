import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

describe('assistant streaming recovery in the real application', () => {
  let gateway;
  let view;
  const evaluate = script => view.evaluate(`(${script.toString()})()`);
  const start = () => ({ type: 'message_start', message: { role: 'assistant', content: [] } });
  const text = delta => ({
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta },
  });
  const end = content => ({ type: 'message_end', message: { role: 'assistant', content } });

  async function deliver(events) {
    // Subscribe to the exact wire barrier before sending the events.
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

  beforeAll(async () => {
    gateway = await createStreamingGateway();
    view = new Bun.WebView({ width: 1000, height: 800 });
  });

  beforeEach(async () => {
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
  });

  afterAll(async () => {
    if (view) await view.close();
    gateway?.close();
  });

  test('recovers the complete text and thinking when deltas are missing', async () => {
    // Given a stream with a start but no update events.
    await deliver([start()]);
    // When the final message contains the complete response.
    await deliver([end([
      { type: 'thinking', thinking: 'final reasoning' },
      { type: 'text', text: '**complete answer**' },
    ])]);
    // Then final content is rendered, with thinking separate from the answer.
    expect(await evaluate(() => ({
      answer: document.querySelector('.message-content strong')?.textContent,
      thinking: document.querySelector('.thinking-content')?.textContent,
      expanded: document.querySelector('.thinking-content')?.classList.contains('expanded'),
      cursors: document.querySelectorAll('.message-content.streaming').length,
      errors: qaErrors,
    }))).toEqual({
      answer: 'complete answer', thinking: 'final reasoning', expanded: false, cursors: 0, errors: [],
    });
  });

  test('replaces partial deltas with the authoritative final content', async () => {
    // Given partial streamed text and thinking.
    await deliver([start(), text('partial answer'), {
      type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'partial reasoning' },
    }]);
    // When the final response replaces both fields.
    await deliver([end([
      { type: 'thinking', thinking: 'complete reasoning' },
      { type: 'text', text: 'complete answer' },
    ])]);
    // Then no partial content leaks into the finalized message.
    expect(await evaluate(() => ({
      answer: document.querySelector('.message-content p')?.textContent,
      thinking: document.querySelector('.thinking-content')?.textContent,
      cursors: document.querySelectorAll('.message-content.streaming').length,
    }))).toEqual({ answer: 'complete answer', thinking: 'complete reasoning', cursors: 0 });
  });

  test('renders a final message even when its start was missed', async () => {
    // Given a selected session with no current assistant element.
    // When a completed assistant response arrives.
    await deliver([end('standalone answer')]);
    // Then its text remains visible without a streaming cursor.
    expect(await evaluate(() => ({
      answer: document.querySelector('.message-content p')?.textContent,
      cursors: document.querySelectorAll('.message-content.streaming').length,
    }))).toEqual({ answer: 'standalone answer', cursors: 0 });
  });

  test('finalizes the previous stream before another assistant start', async () => {
    // Given an unfinished response with pending text.
    await deliver([start(), text('previous answer')]);
    // When another response starts before the previous message_end.
    await deliver([start()]);
    // Then only the new response owns a cursor, and the old content is preserved.
    expect(await evaluate(() => ({
      answers: [...document.querySelectorAll('.message-content')].map(node => node.textContent),
      cursors: document.querySelectorAll('.message-content.streaming').length,
      firstStreaming: document.querySelector('.message-content')?.classList.contains('streaming'),
    }))).toEqual({ answers: ['previous answer', ''], cursors: 1, firstStreaming: false });
  });

  test('finalizes pending text when an interrupted agent ends', async () => {
    // Given a stream without a message_end.
    await deliver([{ type: 'agent_start' }, start(), text('interrupted answer')]);
    // When abort or another interruption ends the agent.
    await deliver([{ type: 'agent_end' }]);
    // Then partial text survives and the cursor is removed.
    expect(await evaluate(() => ({
      answer: document.querySelector('.message-content p')?.textContent,
      cursors: document.querySelectorAll('.message-content.streaming').length,
      errors: qaErrors,
    }))).toEqual({ answer: 'interrupted answer', cursors: 0, errors: [] });
  });

  test('ignores unsupported updates without creating an empty stream', async () => {
    // Given no current assistant response.
    // When an update has no supported text or thinking delta.
    await deliver([
      { type: 'message_update', message: { role: 'assistant', content: [] } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{}' } },
    ]);
    // Then it neither throws nor creates orphaned cursors.
    expect(await evaluate(() => ({
      messages: document.querySelectorAll('.message.assistant').length, errors: qaErrors,
    }))).toEqual({ messages: 0, errors: [] });
  });

  test('preserves partial content and removes its cursor on disconnect', async () => {
    // Given an active response and a listener installed before disconnect.
    await deliver([{ type: 'agent_start' }, start(), text('saved partial answer')]);
    await evaluate(() => {
      window.qaDisconnected = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error('Disconnect cleanup missing'));
        }, 3000);
        const observer = new MutationObserver(() => {
          if (!document.getElementById('message-input').disabled ||
              document.querySelector('.message-content.streaming')) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve(true);
        });
        observer.observe(document.querySelector('.main'), {
          attributes: true, childList: true, subtree: true,
        });
      });
    });
    // When the real transport closes mid-response.
    gateway.disconnect();
    await view.evaluate('window.qaDisconnected');
    // Then the partial response stays readable without a dangling cursor.
    expect(await evaluate(() => ({
      answer: document.querySelector('.message-content p')?.textContent,
      cursors: document.querySelectorAll('.message-content.streaming').length,
      disabled: document.getElementById('message-input').disabled,
      errors: qaErrors,
    }))).toEqual({ answer: 'saved partial answer', cursors: 0, disabled: true, errors: [] });
  });

  test('keeps normal streaming, usage and the next response intact', async () => {
    // Given a regular completed response with usage.
    await deliver([{ type: 'agent_start' }, start(), text('first answer'), {
      ...end([{ type: 'text', text: 'first answer' }]),
      message: {
        role: 'assistant', content: [{ type: 'text', text: 'first answer' }],
        usage: { input: 100, cost: { total: 0.25 } },
      },
    }]);
    // When another normal response completes in the same turn.
    await deliver([start(), text('second answer'), end('second answer'), { type: 'agent_end' }]);
    // Then neither text nor cost is lost, duplicated, or carried into the next response.
    expect(await evaluate(() => ({
      answers: [...document.querySelectorAll('.message-content p')].map(node => node.textContent),
      usage: document.querySelector('.message-usage')?.textContent,
      cursors: document.querySelectorAll('.message-content.streaming').length,
      disabled: document.getElementById('message-input').disabled,
      errors: qaErrors,
    }))).toEqual({
      answers: ['first answer', 'second answer'], usage: '$0.2500',
      cursors: 0, disabled: false, errors: [],
    });
  });

  test('clears streamed content when the final assistant content is empty', async () => {
    // Given text and thinking that were retracted by the final payload.
    await deliver([start(), text('retracted text'), {
      type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'retracted reasoning' },
    }]);
    // When the final payload is authoritative and empty.
    await deliver([end([])]);
    // Then neither stale text nor stale thinking remains.
    expect(await evaluate(() => ({
      text: document.querySelector('.message-content')?.textContent,
      thinking: document.querySelectorAll('.thinking-block').length,
      cursors: document.querySelectorAll('.message-content.streaming').length,
    }))).toEqual({ text: '', thinking: 0, cursors: 0 });
  });
});
