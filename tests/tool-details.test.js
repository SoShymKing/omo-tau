import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

describe('lazy tool details in the real browser', () => {
  let server, view, requests, revision, held;
  const evaluate = script => view.evaluate(`(${script.toString()})()`);
  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/') return new Response('<!doctype html><div id="messages"></div>',
        { headers: { 'Content-Type': 'text/html' } });
      if (pathname === '/api/tool-details') {
        const body = await request.json();
        requests.push(body);
        const current = revision;
        if (held?.id === body.toolCallId) {
          const gate = held;
          held = null;
          gate.arrived.resolve();
          await gate.release.promise;
        }
        if (body.toolCallId === 'failed') return new Response('unavailable', { status: 503 });
        if (body.mode === 'copy') return new Response('full output beyond preview');
        if (body.mode === 'args') return new Response('{"path":"synthetic.txt"}');
        if (body.mode === 'attachment') return new Response('attachment bytes');
        return Response.json({ args: { path: 'synthetic.txt' }, argsText: '{"path":"synthetic.txt"}',
          output: body.toolCallId.startsWith('big') ? '\u20ac'.repeat(65536) : `output ${current}`,
          isError: false, argsTruncated: false, outputTruncated: true, revision: current, attachments: [] });
      }
      const file = Bun.file(new URL(`../public${pathname}`, import.meta.url));
      return await file.exists() ? new Response(file) : new Response('', { status: 404 });
    } });
    view = new Bun.WebView({ width: 1000, height: 800 });
  });
  beforeEach(async () => {
    requests = []; revision = 1; held = null;
    await view.navigate(server.url.href);
    await evaluate(async () => {
      const { ToolDetailClient } = await import('/tool-details.js');
      const { LazyToolCardRenderer } = await import('/lazy-tool-card.js');
      window.context = { sessionFile: 'synthetic.jsonl', epoch: 1, generation: 1 };
      window.client = new ToolDetailClient(() => context);
      window.container = document.getElementById('messages');
      window.scrollRequests = 0;
      window.tools = new LazyToolCardRenderer(container, () => { scrollRequests++; }, () => 'synthetic', client);
      window.summary = { toolCallId: 'one', toolName: 'read', preview: 'synthetic.txt',
        status: 'complete', revision: 1, callRef: 'call', resultRef: 'result', liveRef: null };
      window.disclose = async open => {
        const group = container.querySelector('.activity-group');
        const toggled = new Promise(resolve => group.addEventListener('toggle', resolve, { once: true }));
        group.open = open;
        await toggled;
      };
      window.changed = predicate => new Promise((resolve, reject) => {
        const signal = AbortSignal.timeout(3000);
        const observer = new MutationObserver(() => { if (predicate()) finish(resolve); });
        const abort = () => finish(() => reject(signal.reason));
        const finish = callback => { observer.disconnect(); signal.removeEventListener('abort', abort); callback(); };
        signal.addEventListener('abort', abort, { once: true });
        observer.observe(container, { childList: true, subtree: true, characterData: true });
        if (predicate()) finish(resolve);
      });
      window.outputIs = value => changed(() => container.querySelector('.tool-output')?.textContent === value);
    });
  });
  afterAll(async () => { if (view) await view.close(); server?.stop(true); });

  test('creates no headers until Activity opens and fetches only the selected child', async () => {
    // Given many summaries behind a closed Activity.
    expect(await evaluate(() => {
      for (let i = 0; i < 50; i++) tools.createHistoryCard({ ...summary, toolCallId: String(i) });
      tools.toolCards.get('0').dataset.historyKey = 'history-one';
      return container.querySelectorAll('.tool-card').length;
    })).toBe(0);
    // When Activity opens, no detail work occurs.
    await evaluate(() => disclose(true));
    expect(requests).toHaveLength(0);
    expect(await evaluate(() => container.querySelectorAll('.tool-card-body').length)).toBe(0);
    await evaluate(() => { window.loaded = outputIs('output 1'); });
    await view.click('.tool-card-toggle');
    await evaluate(() => loaded);
    // Then only the selected child owns a body and request.
    expect(requests.map(item => item.toolCallId)).toEqual(['0']);
    expect(await evaluate(() => ({ bodies: container.querySelectorAll('.tool-card-body').length,
      key: container.querySelector('.tool-card').dataset.historyKey,
      expanded: container.querySelector('.tool-card-toggle').getAttribute('aria-expanded'),
      height: container.querySelector('.tool-card-toggle').getBoundingClientRect().height,
      scrollRequests,
    }))).toEqual({ bodies: 1, key: 'history-one', expanded: 'true', height: 44, scrollRequests: 0 });
  });

  test('reuses cached details and resets child disclosure when Activity closes', async () => {
    // Given an opened child with cached details.
    await evaluate(async () => { tools.createHistoryCard(summary); await disclose(true);
      const ready = outputIs('output 1'); container.querySelector('.tool-card-toggle').click(); await ready; });
    // When its header closes and reopens.
    await view.click('.tool-card-toggle');
    await evaluate(async () => { const ready = outputIs('output 1');
      container.querySelector('.tool-card-toggle').click(); await ready; });
    expect(requests).toHaveLength(1);
    // Then Activity close removes all child DOM and reopening remains collapsed.
    await evaluate(() => disclose(false));
    expect(await evaluate(() => container.querySelectorAll('.tool-card').length)).toBe(0);
    await evaluate(() => disclose(true));
    expect(await evaluate(() => container.querySelectorAll('.tool-card-body').length)).toBe(0);
    expect(requests).toHaveLength(1);
  });

  test('copies full output from a closed header without creating a body', async () => {
    // Given a mounted closed header and a clipboard sink.
    await evaluate(async () => {
      tools.createHistoryCard(summary); await disclose(true);
      Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async text => { window.copied = text; } } });
      window.copiedDone = changed(() => container.querySelector('.copy-output-btn').textContent === 'Copied');
    });
    // When Copy output is clicked.
    await view.click('.copy-output-btn');
    await evaluate(() => copiedDone);
    // Then full text bypasses preview/cache and body creation.
    expect(requests.map(item => item.mode)).toEqual(['copy']);
    expect(await evaluate(() => ({ text: copied, bodies: container.querySelectorAll('.tool-card-body').length,
      cached: client.cache.size }))).toEqual({ text: 'full output beyond preview', bodies: 0, cached: 0 });
  });

  test('coalesces live revisions while only the explicitly opened tool refreshes', async () => {
    // Given one selected child with its first response held.
    const gate = { id: 'one', arrived: Promise.withResolvers(), release: Promise.withResolvers() };
    held = gate;
    await evaluate(async () => { tools.createToolCard(summary);
      tools.createToolCard({ ...summary, toolCallId: 'closed' }); await disclose(true);
      window.latest = outputIs('output 3'); container.querySelector('.tool-card-toggle').click(); });
    await gate.arrived.promise;
    // When two newer revisions arrive before that response.
    revision = 3;
    await evaluate(() => {
      tools.updateToolCard({ toolCallId: 'one', revision: 2, status: 'streaming' });
      tools.updateToolCard({ toolCallId: 'one', revision: 3, status: 'complete' });
      tools.updateToolCard({ toolCallId: 'closed', revision: 3, status: 'complete' });
    });
    expect(requests).toHaveLength(1);
    gate.release.resolve();
    await evaluate(() => latest);
    // Then a single follow-up gets the newest body without opening its sibling.
    expect(requests.map(item => item.toolCallId)).toEqual(['one', 'one']);
    expect(await evaluate(() => container.querySelectorAll('.tool-card-body').length)).toBe(1);
  });

  test.each(['close', 'clear'])('ignores held details after %s', async action => {
    // Given a response held while its tool is open.
    const gate = { id: 'one', arrived: Promise.withResolvers(), release: Promise.withResolvers() };
    held = gate;
    await evaluate(async () => {
      const original = client.view.bind(client);
      client.view = (...args) => {
        const promise = original(...args);
        window.settled = promise.then(() => {}, () => {});
        return promise;
      };
      tools.createToolCard(summary); await disclose(true); container.querySelector('.tool-card-toggle').click();
    });
    await gate.arrived.promise;
    // When disclosure closes or the session renderer clears before delivery.
    if (action === 'clear') await evaluate(() => tools.clear());
    else await view.click('.tool-card-toggle');
    gate.release.resolve();
    await evaluate(() => settled);
    // Then no late body or cached aborted response survives.
    expect(await evaluate(() => ({ bodies: container.querySelectorAll('.tool-card-body').length,
      bytes: client.cacheBytes }))).toEqual({ bodies: 0, bytes: 0 });
  });

  test('merges result-first refs without erasing result identity', async () => {
    // Given a result without a call.
    await evaluate(async () => {
      tools.addHistoryResult('one', { tool: { ...summary, callRef: null, status: 'error' } }, true);
      tools.createHistoryCard({ ...summary, resultRef: null, status: 'unknown' });
      await disclose(true);
      const ready = outputIs('output 1'); container.querySelector('.tool-card-toggle').click(); await ready;
    });
    // When the merged result is inspected, then both refs and the terminal status survive.
    expect(requests[0]).toMatchObject({ callRef: 'call', resultRef: 'result' });
    expect(await evaluate(() => container.querySelector('.tool-status').textContent)).toBe('error');
  });

  test('bounds UTF-8 LRU bytes, coalesces requests, and never caches failures', async () => {
    // Given a cold client.
    await evaluate(() => Promise.all([client.view(summary), client.view(summary)]));
    expect(requests).toHaveLength(1);
    // When multibyte previews exceed the limit and failed views are retried.
    const result = await evaluate(async () => {
      for (let i = 0; i < 46; i++) await client.view({ ...summary, toolCallId: `big-${i}` });
      const newest = { ...summary, toolCallId: 'big-45' };
      await client.view(newest);
      const failures = [];
      for (let i = 0; i < 2; i++) {
        try { await client.view({ ...summary, toolCallId: 'failed' }); }
        catch (error) { failures.push(error.message); }
      }
      return { bytes: client.cacheBytes, count: client.cache.size, failures,
        measured: [...client.cache].reduce((sum, [key, entry]) =>
          sum + new TextEncoder().encode(key + JSON.stringify(entry.value)).byteLength, 0) };
    });
    // Then the byte limit, eviction, cache hit, and failure retry are observable.
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.measured).toBe(result.bytes);
    expect(result.count).toBeLessThan(46);
    expect(result.failures.every(message => message.includes('503'))).toBe(true);
    expect(requests).toHaveLength(49);
  });

  test('restores only explicit child disclosure after rebuilding models', async () => {
    // Given one opened tool and one closed sibling.
    await evaluate(async () => {
      tools.createHistoryCard(summary); tools.createHistoryCard({ ...summary, toolCallId: 'closed' });
      await disclose(true);
      const ready = outputIs('output 1'); container.querySelector('.tool-card-toggle').click(); await ready;
      window.disclosure = tools.captureDisclosure();
    });
    // When the models are rebuilt with a new revision.
    revision = 2;
    await evaluate(async () => {
      tools.clear();
      tools.createHistoryCard({ ...summary, revision: 2 });
      tools.createHistoryCard({ ...summary, toolCallId: 'closed', revision: 2 });
      const ready = outputIs('output 2'); tools.restoreDisclosure(disclosure); await ready;
    });
    // Then only the previously open body refetches.
    expect(requests.map(item => item.toolCallId)).toEqual(['one', 'one']);
    expect(await evaluate(() => container.querySelectorAll('.tool-card-body').length)).toBe(1);
  });
});
