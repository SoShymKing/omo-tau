import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

describe('fenced code in the real markdown renderer', () => {
  let server;
  let view;

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/') return new Response('<!doctype html><div id="messages"></div>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
        const file = Bun.file(new URL(`../public${pathname}`, import.meta.url));
        return await file.exists() ? new Response(file) : new Response('', { status: 404 });
      },
    });
    view = new Bun.WebView({ width: 1000, height: 800 });
  });

  beforeEach(async () => {
    await view.navigate(server.url.href);
    await view.evaluate(`(async () => {
      const { renderMarkdown } = await import('/markdown.js');
      window.renderMarkdown = renderMarkdown;
    })()`);
  });

  afterAll(async () => {
    if (view) await view.close();
    server?.stop(true);
  });

  const fence = '```js\nconsole.log(1);\n```';
  const cases = [
    ['standalone', fence, 'DIV'],
    ['leading spaces', '  ' + fence, 'DIV'],
    ['trailing spaces', fence + '  ', 'DIV'],
    ['fence indentation', '  ```js\n  console.log(1);\n  ```', 'DIV'],
    ['CRLF and tabs', '\t```js\r\n\tconsole.log(1);\r\n\t```\t', 'DIV'],
    ['quote', '> ```js\n> console.log(1);\n> ```', 'BLOCKQUOTE'],
    ['quote without closing space', '> ```js\n> console.log(1);\n>```', 'BLOCKQUOTE'],
    ['nested quote', '> > ```js\n> > console.log(1);\n> > ```', 'BLOCKQUOTE'],
    ['unordered list', '- ' + fence, 'LI'],
    ['ordered list', '1. ' + fence, 'LI'],
    ['task list', '- [ ] ' + fence, 'LI'],
  ];

  test.each(cases)('restores code in %s', async (_name, content, parent) => {
    // Given a completed fence in a supported block context.
    // When the shipped renderer produces the browser DOM.
    const result = await view.evaluate(`(() => {
      const root = document.getElementById('messages');
      root.innerHTML = renderMarkdown(${JSON.stringify(content)});
      return {
        code: [...root.querySelectorAll('.code-block-wrapper code')].map(node => node.textContent),
        parents: [...root.querySelectorAll('.code-block-wrapper')].map(node => node.parentElement.tagName),
      };
    })()`);
    // Then code contents and the block context both survive restoration.
    expect(result).toEqual({ code: ['console.log(1);'], parents: [parent] });
  });

  test('keeps multiple code blocks in order without formatting their contents', async () => {
    // Given code containing HTML, math and emphasis syntax, followed by quoted code.
    const code = '<b>$x_y$</b>\n  **literal** `inline`';
    const content = '```html\n' + code + '\n```\n\n> ```js\n> second();\n> ```';
    // When both blocks pass through the same markdown render.
    const result = await view.evaluate(`(() => {
      const root = document.getElementById('messages');
      root.innerHTML = renderMarkdown(${JSON.stringify(content)});
      return {
        code: [...root.querySelectorAll('.code-block-wrapper code')].map(node => node.textContent),
        formatted: root.querySelectorAll('code b, code em, code strong, code .math').length,
      };
    })()`);
    // Then the renderer preserves text exactly and does not interpret code as markup.
    expect(result).toEqual({ code: [code, 'second();'], formatted: 0 });
  });

  test.each(['%%CODEBLOCK_0%%', '`%%CODEBLOCK_0%%`'])('keeps literal placeholder text %s', async literal => {
    // Given placeholder-shaped user text beside an actual code block.
    const content = literal + '\n\n' + fence;
    // When the text is rendered together.
    const result = await view.evaluate(`(() => {
      const root = document.getElementById('messages');
      root.innerHTML = renderMarkdown(${JSON.stringify(content)});
      return {
        literal: root.querySelector('p')?.textContent,
        code: [...root.querySelectorAll('.code-block-wrapper code')].map(node => node.textContent),
      };
    })()`);
    // Then literal text cannot impersonate the renderer's internal placeholder.
    expect(result).toEqual({ literal: '%%CODEBLOCK_0%%', code: ['console.log(1);'] });
  });

  test('leaves an unfinished fence readable without creating a code block', async () => {
    // Given a fence that has not received its closing delimiter.
    const content = '```js\nconsole.log(1);';
    // When the partial response is rendered.
    const result = await view.evaluate(`(() => {
      const root = document.getElementById('messages');
      root.innerHTML = renderMarkdown(${JSON.stringify(content)});
      return { blocks: root.querySelectorAll('.code-block-wrapper').length, text: root.textContent };
    })()`);
    // Then text remains available without a fabricated completed block.
    expect(result.blocks).toBe(0);
    expect(result.text).toContain('console.log(1);');
  });

  test('restores indented code when a streamed message is finalized', async () => {
    // Given streamed text containing an indented completed fence.
    // When the real message renderer finalizes that stream.
    const result = await view.evaluate(`(async () => {
      const { MessageRenderer } = await import('/message-renderer.js');
      const root = document.getElementById('messages');
      const renderer = new MessageRenderer(root, () => {});
      const row = renderer.renderAssistantMessage({ content: ${JSON.stringify('  ' + fence)} }, true, true);
      renderer.finalizeStreamingMessage(row);
      return {
        code: [...row.querySelectorAll('.code-block-wrapper code')].map(node => node.textContent),
        streaming: row.querySelector('.message-content').classList.contains('streaming'),
      };
    })()`);
    // Then finalization uses the same code restoration as history rendering.
    expect(result).toEqual({ code: ['console.log(1);'], streaming: false });
  });
});
