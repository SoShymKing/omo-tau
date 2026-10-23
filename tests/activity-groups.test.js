import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

describe('activity disclosures in the real browser renderer', () => {
  let server;
  let view;
  const evaluate = script => view.evaluate(`(${script.toString()})()`);

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/') {
          return new Response('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div class="messages" id="messages"></div>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        const file = Bun.file(new URL(`../public${pathname}`, import.meta.url));
        return await file.exists() ? new Response(file) : new Response('', { status: 404 });
      },
    });
    view = new Bun.WebView({ width: 1000, height: 800 });
  });

  beforeEach(async () => {
    await view.navigate(server.url.href);
    await evaluate(async () => {
      const { MessageRenderer } = await import('/message-renderer.js');
      const { ToolCardRenderer } = await import('/tool-card.js');
      const { mergeActivityGroups } = await import('/activity-group.js');
      window.container = document.getElementById('messages');
      window.messages = new MessageRenderer(window.container, () => {});
      window.tools = new ToolCardRenderer(window.container, () => {});
      window.mergeGroups = mergeActivityGroups;
    });
  });

  afterAll(async () => {
    if (view) await view.close();
    server?.stop(true);
  });

  test('many alternating thinking and tool blocks leave the answer visible', async () => {
    const result = await evaluate(() => {
      for (let i = 0; i < 50; i++) {
        messages.renderAssistantMessage({ content: [{ type: 'thinking', thinking: 'reasoning' }] }, false, true);
        tools.createHistoryCard({ toolCallId: String(i), toolName: 'eval', args: {} });
      }
      const reply = messages.renderAssistantMessage({ content: 'answer' }, false, true);
      const group = container.querySelector('.activity-group');
      return {
        groups: container.querySelectorAll('.activity-group').length,
        items: group.querySelector('.activity-items').children.length,
        open: group.open,
        height: group.getBoundingClientRect().height,
        answerOutside: reply.parentElement === container && reply.getBoundingClientRect().height > 0,
      };
    });
    expect(result).toEqual({ groups: 1, items: 100, open: false, height: 46, answerOutside: true });
  });

  test('new calls and results preserve disclosure state and tool node identity', async () => {
    const result = await evaluate(() => {
      const card = tools.createToolCard({ toolCallId: 'one', toolName: 'eval', args: {}, status: 'pending' });
      const group = card.closest('.activity-group');
      group.open = true;
      tools.createToolCard({ toolCallId: 'two', toolName: 'read', args: {}, status: 'pending' });
      tools.finalizeToolCard('one', { content: [{ type: 'text', text: 'result' }] }, false);
      const stayedOpen = group.open;
      group.open = false;
      tools.updateToolCard({ toolCallId: 'two', status: 'streaming', output: 'partial' });
      return {
        stayedOpen, stayedClosed: !group.open,
        sameNode: tools.toolCards.get('one') === card,
        output: card.querySelector('.tool-output').textContent,
        pending: group.querySelectorAll('.tool-status.streaming').length,
      };
    });
    expect(result).toEqual({ stayedOpen: true, stayedClosed: true, sameNode: true, output: 'result', pending: 1 });
  });

  test('user messages and assistant answers separate activity groups', async () => {
    expect(await evaluate(() => {
      const addTool = id => tools.createHistoryCard({ toolCallId: id, toolName: 'eval', args: {} });
      addTool('one');
      messages.renderAssistantMessage({ content: 'answer' }, false, true);
      addTool('two');
      messages.renderUserMessage({ content: 'next question' }, true);
      addTool('three');
      return [...container.children].map(node => node.className);
    })).toEqual(['activity-group has-tools', 'message assistant history', 'activity-group has-tools',
      'message user history', 'activity-group has-tools']);
  });

  test('streaming text remains outside groups while thinking-only completion joins them', async () => {
    const result = await evaluate(() => {
      tools.createHistoryCard({ toolCallId: 'one', toolName: 'eval', args: {} });
      const thinking = messages.renderAssistantMessage({ content: '' }, true);
      messages.updateStreamingThinking(thinking, 'reasoning');
      messages.finalizeStreamingMessage(thinking, null, 'reasoning');
      const reply = messages.renderAssistantMessage({ content: '' }, true);
      messages.updateStreamingThinking(reply, 'more reasoning');
      messages.updateStreamingMessage(reply, 'visible answer');
      messages.finalizeStreamingMessage(reply, null, 'more reasoning');
      return {
        groupedThinking: !!thinking.closest('.activity-group'),
        replyOutside: reply.parentElement === container,
        replyText: reply.querySelector('.message-content p').textContent,
        thinkingBlocks: reply.querySelectorAll('.thinking-block').length,
      };
    });
    expect(result).toEqual({ groupedThinking: true, replyOutside: true, replyText: 'visible answer', thinkingBlocks: 1 });
  });

  test('empty tool-only assistant completions leave no blank message row', async () => {
    expect(await evaluate(() => {
      const blank = messages.renderAssistantMessage({ content: '' }, true);
      messages.finalizeStreamingMessage(blank);
      return container.children.length;
    })).toBe(0);
  });

  test('history merging preserves newer live nodes and open state', async () => {
    const result = await evaluate(() => {
      const live = tools.createToolCard({ toolCallId: 'live', toolName: 'eval', args: {}, status: 'pending' });
      const newer = live.closest('.activity-group');
      newer.open = true;
      const target = document.createElement('div');
      tools.container = target;
      tools.createHistoryCard({ toolCallId: 'older', toolName: 'read', args: {} });
      const older = target.lastElementChild;
      container.prepend(...target.childNodes);
      mergeGroups(older, newer);
      tools.container = container;
      tools.finalizeToolCard('live', { content: [{ type: 'text', text: 'done' }] }, false);
      return {
        groups: container.querySelectorAll('.activity-group').length,
        ids: [...newer.querySelectorAll('.tool-card')].map(node => node.dataset.toolCallId),
        open: newer.open, sameNode: newer.querySelectorAll('.tool-card')[1] === live,
      };
    });
    expect(result).toEqual({ groups: 1, ids: ['older', 'live'], open: true, sameNode: true });
  });

  test('errors are indicated even while the group is collapsed', async () => {
    const result = await evaluate(() => {
      const card = tools.createHistoryCard({ toolCallId: 'bad', toolName: 'eval', args: {} });
      tools.addHistoryResult('bad', { content: [{ type: 'text', text: 'failure' }] }, true);
      const group = card.closest('.activity-group');
      return { error: group.classList.contains('has-errors'), open: group.open,
        statusVisible: group.querySelector('.activity-status').getBoundingClientRect().height > 0 };
    });
    expect(result).toEqual({ error: true, open: false, statusVisible: true });
  });

  test('show-thinking setting removes thinking-only groups and their empty spacing', async () => {
    const result = await evaluate(() => {
      const thought = messages.renderAssistantMessage({ content: [{ type: 'thinking', thinking: 'reasoning' }] }, false, true);
      messages.renderAssistantMessage({ content: 'answer' }, false, true);
      messages.renderAssistantMessage({ content: [{ type: 'thinking', thinking: 'reasoning' }] }, false, true);
      const card = tools.createHistoryCard({ toolCallId: 'one', toolName: 'eval', args: {} });
      document.body.classList.add('hide-thinking');
      const mixed = card.closest('.activity-group');
      mixed.open = true;
      return {
        onlyThinkingHidden: getComputedStyle(thought.closest('.activity-group')).display === 'none',
        mixedVisible: getComputedStyle(mixed).display !== 'none',
        thoughtRowHidden: getComputedStyle(mixed.querySelector('.message')).display === 'none',
      };
    });
    expect(result).toEqual({ onlyThinkingHidden: true, mixedVisible: true, thoughtRowHidden: true });
  });
});
