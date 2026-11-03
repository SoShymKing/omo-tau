import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

describe('chat attachments in the real browser renderer', () => {
  let server;
  let view;
  let slowStarted;
  let releaseSlow;
  const requests = [];
  const evaluate = script => view.evaluate(`(${script.toString()})()`);

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        if (pathname === '/api/file') {
          const path = url.searchParams.get('path');
          requests.push({ method: request.method, path, sessionId: url.searchParams.get('sessionId') });
          if (path === './slow.txt') {
            slowStarted?.();
            await new Promise(resolve => { releaseSlow = resolve; });
          }
          if (path === './missing.txt') return new Response('', { status: 404 });
          const type = path.endsWith('.pdf') ? 'application/pdf'
            : path.endsWith('.html') ? 'text/html'
            : path.endsWith('.zip') ? 'application/octet-stream' : 'text/plain; charset=utf-8';
          const body = '<script>window.fileExecuted = true</script>\nPreview text.';
          return new Response(request.method === 'HEAD' ? null : body, {
            headers: { 'Content-Type': type,
              'Content-Length': String(path === './large.txt' ? 2 * 1024 * 1024 : body.length) },
          });
        }
        if (pathname === '/') {
          return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><div class="messages" id="messages"></div>', {
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
    requests.length = 0;
    await view.navigate(server.url.href);
    await evaluate(async () => {
      const { MessageRenderer } = await import('/message-renderer.js');
      const { ToolCardRenderer } = await import('/tool-card.js');
      const { localFileUrl } = await import('/attachments.js');
      window.fileUrl = localFileUrl;
      window.container = document.getElementById('messages');
      window.messages = new MessageRenderer(container, () => {}, () => 'session-one');
      window.tools = new ToolCardRenderer(container, () => {}, () => 'session-one');
      window.waitForAttachment = selector => {
        if (document.querySelector(selector)) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            if (document.querySelector(selector)) {
              clearTimeout(timer);
              observer.disconnect();
              resolve();
            }
          });
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Missing attachment state: ${selector}`));
          }, 3000);
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        });
      };
      window.imageBlock = {
        type: 'image', mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/csAAAAASUVORK5CYII=',
      };
    });
  });

  afterAll(async () => {
    if (view) await view.close();
    server?.stop(true);
  });

  test('local links retain spaces, underscores, parentheses and session ownership', async () => {
    // Given a response referring to a local file.
    const result = await evaluate(async () => {
      const row = messages.renderAssistantMessage({
        content: '[report](<C:/work/my_report (final).pdf>)',
      }, false, true);
      // When the renderer is later used by another session.
      messages.getSessionId = () => 'session-two';
      const open = row.querySelector('.attachment-file button');
      const inlineDownloads = row.querySelectorAll('a[download]').length;
      open.click();
      await waitForAttachment('.attachment-file-details');
      const download = document.querySelector('.attachment-viewer a[download]');
      // Then the original session and exact path remain in both URLs.
      return {
        path: new URL(download.href).searchParams.get('path'),
        session: new URL(download.href).searchParams.get('sessionId'),
        download: new URL(download.href).searchParams.get('download'),
        label: open.textContent,
        inlineDownloads,
      };
    });
    expect(result).toEqual({
      path: 'C:/work/my_report (final).pdf', session: 'session-one', download: '1', label: 'report', inlineDownloads: 0,
    });
  });

  test('keeps cold-preview attachment names without borrowing an acknowledged file route', async () => {
    // Given a history preview with no runtime identity yet.
    const result = await evaluate(async () => {
      const { MessageRenderer } = await import('/message-renderer.js');
      const preview = new MessageRenderer(container, () => {}, () => null);
      // When local structured files, images and links are rendered.
      preview.renderAssistantMessage({ content: [
        { type: 'text', text: '[cold-link.txt](./cold-link.txt) [Remote](https://example.com/)' },
        { type: 'file', path: './cold-summary.txt', name: 'cold-summary.txt' },
        { type: 'image', url: './cold-image.png', name: 'cold-image.png' },
      ] }, false);
      // Then names stay readable, but only the remote link is actionable.
      return {
        fileShown: container.textContent.includes('cold-summary.txt'),
        imageShown: container.textContent.includes('cold-image.png'),
        links: [...container.querySelectorAll('a')].map(link => link.getAttribute('href')),
      };
    });
    expect(result).toEqual({ fileShown: true, imageShown: true, links: ['https://example.com/'] });
  });

  test('base64 images in user, assistant and live/history tool results become downloadable previews', async () => {
    // Given all four renderer paths.
    const result = await evaluate(() => {
      messages.renderUserMessage({ content: '', images: [imageBlock] }, true);
      messages.renderAssistantMessage({ content: [imageBlock] }, false, true);
      tools.createToolCard({ toolCallId: 'live', toolName: 'image', args: {}, status: 'pending' });
      tools.finalizeToolCard('live', { content: [imageBlock] }, false);
      tools.createHistoryCard({ toolCallId: 'past', toolName: 'image', args: {} });
      // When a history result uses the alternative source format.
      tools.addHistoryResult('past', { content: [{
        type: 'image', source: { data: imageBlock.data, media_type: 'image/png' },
      }] }, false);
      // Then none dumps image bytes as text.
      return {
        previews: container.querySelectorAll('.attachment-thumbnail').length,
        downloads: container.querySelectorAll('a[download]').length,
        rawBytes: container.textContent.includes(imageBlock.data),
      };
    });
    expect(result).toEqual({ previews: 4, downloads: 0, rawBytes: false });
  });

  test('image-only streaming completions survive finalization outside activity groups', async () => {
    // Given an assistant stream with no text.
    const result = await evaluate(() => {
      const row = messages.renderAssistantMessage({ content: '' }, true);
      // When an image arrives in the completed message.
      messages.finalizeStreamingMessage(row, null, '', [imageBlock]);
      // Then the image is visible outside collapsed activity.
      return { connected: row.isConnected, grouped: !!row.closest('.activity-group'),
        images: row.querySelectorAll('.attachment-thumbnail').length };
    });
    expect(result).toEqual({ connected: true, grouped: false, images: 1 });
  });

  test.each([1000, 390, 320])('wide photos stay readable and inside the message at %ipx', async width => {
    // Given a photo much wider than the chat viewport.
    await view.cdp('Emulation.setDeviceMetricsOverride', {
      width, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    try {
      const bounds = await evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 6000;
        canvas.height = 1200;
        const image = { type: 'image', mimeType: 'image/png', data: canvas.toDataURL('image/png') };
        // When the photo is shown in user and assistant messages.
        messages.renderUserMessage({ content: '', images: [image] }, true);
        messages.renderAssistantMessage({ content: [image] }, false, true);
        await Promise.all([...container.querySelectorAll('img')].map(image => image.decode()));
        return [...container.querySelectorAll('.attachment-thumbnail')].map(button => {
          const content = button.closest('.message-content');
          const image = button.querySelector('img');
          const rect = image.getBoundingClientRect();
          const bubble = content.getBoundingClientRect();
          return {
            buttonWidth: button.getBoundingClientRect().width,
            imageWidth: rect.width,
            imageInside: rect.left >= bubble.left && rect.right <= bubble.right,
            overflowing: content.scrollWidth > content.clientWidth,
          };
        });
      });
      // Then the original image width cannot inflate the preview or bubble.
      expect(bounds).toHaveLength(2);
      for (const bound of bounds) {
        expect(bound.buttonWidth).toBeLessThanOrEqual(640);
        expect(bound.imageWidth).toBeLessThanOrEqual(640);
        if (width === 1000) expect(bound.imageWidth).toBeGreaterThan(400);
        expect(bound.imageInside).toBe(true);
        expect(bound.overflowing).toBe(false);
      }
    } finally {
      await view.cdp('Emulation.clearDeviceMetricsOverride');
    }
  });

  test('image previews open a native dialog and Close returns focus', async () => {
    // Given a preview.
    await evaluate(() => messages.renderAssistantMessage({ content: [imageBlock] }, false, true));
    // When the user opens it.
    await view.click('.attachment-thumbnail');
    const opened = await evaluate(() => {
      const dialog = document.querySelector('dialog');
      return { modal: dialog.matches(':modal'), images: dialog.querySelectorAll('img').length,
        download: !!dialog.querySelector('a[download]'), focused: dialog.contains(document.activeElement) };
    });
    expect(opened).toEqual({ modal: true, images: 1, download: true, focused: true });
    await evaluate(() => {
      window.viewerClosed = new Promise(resolve => {
        document.querySelector('dialog').addEventListener('close', resolve, { once: true });
      });
    });
    await view.click('.attachment-viewer button');
    expect(await evaluate(async () => {
      await viewerClosed;
      return { dialogs: document.querySelectorAll('dialog').length, focused: document.activeElement.className };
    })).toEqual({ dialogs: 0, focused: 'attachment-thumbnail' });
  });

  test('local markdown images and structured file blocks use the selected session API', async () => {
    // Given local image markdown and a structured file.
    const result = await evaluate(() => {
      const row = messages.renderAssistantMessage({ content: [
        { type: 'text', text: '![plot](./output/plot_one.png)' },
        { type: 'file', path: './output/report.pdf', name: 'Report' },
      ] }, false, true);
      // When attachments are rendered.
      const image = row.querySelector('img');
      const file = row.querySelector('.attachment-file button');
      // Then the file is actionable without a chat download control.
      return { image: new URL(image.src).searchParams.get('path'),
        file: file.textContent,
        downloads: row.querySelectorAll('a[download]').length };
    });
    expect(result).toEqual({ image: './output/plot_one.png', file: 'Report', downloads: 0 });
  });

  test('mixed images and files form an ordered vertical list above the text', async () => {
    const result = await evaluate(async () => {
      messages.renderUserMessage({ content: 'Question below the images', attachments: [
        { ...imageBlock, name: 'first' },
        { type: 'file', path: './notes.txt', name: 'notes' },
        { ...imageBlock, name: 'last' },
      ] }, true);
      const content = container.querySelector('.message-content');
      const list = content.querySelector('.attachment-list');
      const range = document.createRange();
      range.selectNode([...content.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()));
      const rects = [...list.children].map(node => node.getBoundingClientRect());
      return {
        first: content.firstElementChild === list,
        order: [...list.children].map(node => node.querySelector('img')?.alt || node.textContent),
        vertical: rects.every((rect, index) => index === 0 || rect.top >= rects[index - 1].bottom),
        textBelow: range.getBoundingClientRect().top >= list.getBoundingClientRect().bottom,
        downloads: container.querySelectorAll('a[download]').length,
      };
    });
    expect(result).toEqual({ first: true, order: ['first', 'notes', 'last'],
      vertical: true, textBelow: true, downloads: 0 });
  });

  test('text files show their contents as text and expose downloads only in the viewer', async () => {
    await evaluate(() => messages.renderAssistantMessage({ content: [
      { type: 'file', path: './notes.txt', name: 'Notes' },
    ] }, false, true));
    await view.click('.attachment-file button');
    const result = await evaluate(async () => {
      await waitForAttachment('.attachment-text-preview');
      const dialog = document.querySelector('.attachment-viewer');
      return { text: dialog.querySelector('pre').textContent, scripts: dialog.querySelectorAll('script').length,
        executed: window.fileExecuted === true, details: !!dialog.querySelector('.attachment-file-details'),
        download: new URL(dialog.querySelector('a[download]').href).searchParams.get('download'),
        chatDownloads: container.querySelectorAll('a[download]').length };
    });
    expect(result).toEqual({ text: '<script>window.fileExecuted = true</script>\nPreview text.',
      scripts: 0, executed: false, details: true, download: '1', chatDownloads: 0 });
    expect(requests.map(request => request.method)).toEqual(['HEAD', 'GET']);
  });

  test.each(['./archive.zip', './active.html', './large.txt'])('%s shows details without loading unsupported content', async path => {
    await view.evaluate(`messages.renderAssistantMessage({content:[{type:'file',path:${JSON.stringify(path)}}]},false,true)`);
    await view.click('.attachment-file button');
    const result = await evaluate(async () => {
      await waitForAttachment('.attachment-file-details');
      const dialog = document.querySelector('.attachment-viewer');
      return { details: !!dialog.querySelector('.attachment-file-details'), download: !!dialog.querySelector('a[download]'),
        preview: !!dialog.querySelector('pre, iframe, img'), visibleStatus: !dialog.querySelector('[role="status"]').hidden };
    });
    expect(result).toEqual({ details: true, download: true, preview: false, visibleStatus: true });
    expect(requests.map(request => request.method)).toEqual(['HEAD']);
  });

  test('PDF files use the local preview URL inside the viewer', async () => {
    await evaluate(() => messages.renderAssistantMessage({ content: [{ type: 'file', path: './report.pdf' }] }, false, true));
    await view.click('.attachment-file button');
    const result = await evaluate(async () => {
      await waitForAttachment('.attachment-document');
      const frame = document.querySelector('.attachment-document');
      return { path: new URL(frame.src).searchParams.get('path'), title: frame.title,
        download: !!document.querySelector('.attachment-viewer a[download]') };
    });
    expect(result).toEqual({ path: './report.pdf', title: 'report.pdf', download: true });
  });

  test('missing files keep an announced error and the explicit download action', async () => {
    await evaluate(() => messages.renderAssistantMessage({ content: [{ type: 'file', path: './missing.txt' }] }, false, true));
    await view.click('.attachment-file button');
    expect(await evaluate(async () => {
      await waitForAttachment('.attachment-viewer [role="alert"]');
      return { download: !!document.querySelector('.attachment-viewer a[download]'),
        preview: !!document.querySelector('.attachment-viewer pre, .attachment-document') };
    })).toEqual({ download: true, preview: false });
  });

  test('closing a file viewer during metadata loading does not reopen it', async () => {
    const started = Promise.withResolvers();
    slowStarted = started.resolve;
    await evaluate(() => messages.renderAssistantMessage({ content: [{ type: 'file', path: './slow.txt' }] }, false, true));
    await view.click('.attachment-file button');
    await started.promise;
    await evaluate(() => {
      window.fileViewerClosed = new Promise(resolve => {
        document.querySelector('.attachment-viewer').addEventListener('close', resolve, { once: true });
      });
    });
    await view.click('.attachment-viewer button');
    expect(await evaluate(async () => {
      await fileViewerClosed;
      return { dialogs: document.querySelectorAll('.attachment-viewer').length,
        focus: document.activeElement.closest('.attachment-file') !== null };
    })).toEqual({ dialogs: 0, focus: true });
    releaseSlow();
    slowStarted = undefined;
  });

  test('Escape closes the image viewer without reaching chat keyboard shortcuts', async () => {
    // Given an open image viewer and the ordinary chat keyboard handler.
    await evaluate(() => {
      messages.renderAssistantMessage({ content: [imageBlock] }, false, true);
      window.chatEscapeCount = 0;
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') chatEscapeCount++;
      });
    });
    await view.click('.attachment-thumbnail');
    await evaluate(() => {
      window.viewerClosed = new Promise(resolve => {
        document.querySelector('dialog').addEventListener('close', resolve, { once: true });
      });
    });
    // When Escape is pressed through the real browser input channel.
    await view.cdp('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    });
    // Then the viewer closes without aborting chat.
    expect(await evaluate(async () => {
      await viewerClosed;
      return { closed: !document.querySelector('dialog'), chatEscapeCount };
    })).toEqual({ closed: true, chatEscapeCount: 0 });
  });

  test('external URLs stay external while unsafe schemes and network paths are rejected', async () => {
    // Given mixed local and external paths.
    const result = await evaluate(() => {
      messages.renderAssistantMessage({ content: '[web](https://example.com/my_file.pdf)' }, false, true);
      // When paths are classified.
      return {
        href: container.querySelector('a').getAttribute('href'),
        external: fileUrl('https://example.com/image.png', 'one'),
        unsafe: fileUrl('javascript:alert(1)', 'one'),
        network: fileUrl('file://server/share/file.pdf', 'one'),
        unc: fileUrl('\\\\server\\share\\file.pdf', 'one'),
        noSession: fileUrl('./report.pdf', null),
        windows: new URL(fileUrl('file:///C:/work/report.pdf', 'one'), location.origin).searchParams.get('path'),
      };
    });
    expect(result).toEqual({ href: 'https://example.com/my_file.pdf', external: null,
      unsafe: null, network: null, unc: null, noSession: null, windows: 'C:/work/report.pdf' });
  });
});
