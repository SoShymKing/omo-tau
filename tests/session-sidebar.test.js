import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

describe('session ordering in the real browser renderer', () => {
  let server;
  let view;
  let listReply;
  let listRequested;
  const evaluate = script => view.evaluate(`(${script.toString()})()`);

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/') {
          return new Response('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="sessions" style="width:272px"></div>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        if (pathname === '/api/search') {
          return Response.json({ results: [{
            filePath: 'older', sessionName: 'Older', sessionTimestamp: '2020-01-01',
            project: 'C:/work/alpha', matches: [{ snippet: 'older message' }],
          }] });
        }
        if (pathname === '/api/sessions') {
          listRequested();
          return Response.json(await listReply);
        }
        const file = Bun.file(new URL(`../public${pathname}`, import.meta.url));
        return await file.exists() ? new Response(file) : new Response('', { status: 404 });
      },
    });
    view = new Bun.WebView({ width: 390, height: 844 });
  });

  beforeEach(async () => {
    await view.navigate(server.url.href);
    await evaluate(async () => {
      const { SessionSidebar } = await import('/session-sidebar.js');
      localStorage.removeItem('tau-session-sort');
      localStorage.removeItem('tau-favourites');
      window.SessionSidebar = SessionSidebar;
      window.container = document.getElementById('sessions');
      window.selected = null;
      window.sidebar = new SessionSidebar(container, (session, project) => {
        window.selected = { filePath: session.filePath, workspace: project.path };
      });
      const now = Date.now();
      sidebar.projects = [
        { path: 'C:/work/alpha', dirName: 'alpha', sessions: [
          { filePath: 'newest', name: 'Newest', timestamp: '2020-01-01', lastUserInputAt: now - 9000000, mtime: now - 27000000 },
          { filePath: 'older', name: 'Older', timestamp: '2025-01-01', lastUserInputAt: now - 27000000, mtime: now - 9000000 },
        ] },
        { path: 'C:\\work\\beta', dirName: 'beta', sessions: [
          { filePath: 'middle', name: 'Middle', timestamp: '2024-01-01', lastUserInputAt: now - 18000000, mtime: now - 18000000 },
        ] },
      ];
      sidebar.render();
      window.rowPaths = () => [...container.querySelectorAll('.session-item')].map(el => el.dataset.filePath);
    });
  });

  afterAll(async () => {
    if (view) await view.close();
    server?.stop(true);
  });

  test('latest interleaves workspaces without pinning favourites or mutating default groups', async () => {
    const result = await evaluate(() => {
      sidebar.toggleFavourite('older');
      sidebar.collapsedProjects.add('alpha');
      sidebar.setActive('middle');
      sidebar.setSortMode('latest');
      const latest = {
        paths: rowPaths(),
        workspaces: [...container.querySelectorAll('.session-workspace')].map(el => [el.textContent, el.title]),
        time: container.querySelector('.session-meta > span').textContent,
        active: container.querySelector('.session-item.active').dataset.filePath,
        stars: container.querySelectorAll('.session-fav-icon').length,
      };
      sidebar.setSortMode('default');
      return { latest, groups: container.querySelectorAll('.project-group').length,
        favourite: container.querySelector('.favourites-group .session-item').dataset.filePath,
        collapsed: !!container.querySelector('.project-header.collapsed'),
        original: sidebar.projects[0].sessions.map(s => s.filePath) };
    });
    expect(result).toEqual({
      latest: { paths: ['newest', 'middle', 'older'],
        workspaces: [['alpha', 'C:/work/alpha'], ['beta', 'C:\\work\\beta'], ['alpha', 'C:/work/alpha']],
        time: '2h ago', active: 'middle', stars: 1 },
      groups: 2, favourite: 'older', collapsed: true, original: ['newest', 'older'],
    });
  });

  test('stored latest survives reconstruction and returning to default is persisted', async () => {
    const result = await evaluate(() => {
      sidebar.setSortMode('latest');
      const restored = new SessionSidebar(container, () => {});
      const latest = restored.sortMode;
      restored.setSortMode('default');
      const defaultMode = new SessionSidebar(container, () => {}).sortMode;
      localStorage.setItem('tau-session-sort', 'unknown');
      return { latest, defaultMode, unknown: new SessionSidebar(container, () => {}).sortMode };
    });
    expect(result).toEqual({ latest: 'latest', defaultMode: 'default', unknown: 'default' });
  });

  test('host titles update every copy and survive favourite and sort rerenders', async () => {
    // Given the same session in its project, favourites and message matches.
    const result = await evaluate(() => {
      sidebar.setActive('newest');
      sidebar.toggleFavourite('older');
      sidebar._searchResults = [{
        filePath: 'older', sessionName: 'Older', firstMessage: 'Original request',
        project: 'C:/work/alpha', matches: [{ snippet: 'message' }],
      }];
      sidebar.searchQuery = 'request';
      sidebar.renderSearchResults();
      // When the host titles a session other than the selected one.
      sidebar.updateSessionName('older', 'Summarized request');
      const copies = [...container.querySelectorAll('[data-file-path="older"] .session-title')]
        .map(el => [el.textContent, el.title]);
      sidebar.setSortMode('latest');
      sidebar.setSortMode('default');
      // Then both cached data and every newly rendered title keep the host name.
      return { copies,
        rendered: [...container.querySelectorAll('[data-file-path="older"] .session-title')].map(el => el.textContent),
        active: container.querySelector('.session-item.active').dataset.filePath,
        cached: sidebar.projects[0].sessions[1].name,
        search: sidebar._searchResults[0].sessionName };
    });
    expect(result).toEqual({
      copies: Array.from({ length: 3 }, () => ['Summarized request', 'Summarized request']),
      rendered: ['Summarized request', 'Summarized request', 'Summarized request'],
      active: 'newest', cached: 'Summarized request', search: 'Summarized request',
    });
  });

  test('a title change reapplies the current filter without replacing an inline editor', async () => {
    // Given a filtered session list while another title is being edited.
    const result = await evaluate(() => {
      const title = container.querySelector('[data-file-path="newest"] .session-title');
      const input = document.createElement('input');
      input.className = 'session-rename-input';
      input.value = 'User draft';
      title.replaceWith(input);
      input.focus();
      sidebar.setSearchQuery('summary');
      // When new host titles arrive.
      sidebar.updateSessionName('older', 'Summary title');
      sidebar.updateSessionName('newest', 'Another summary');
      // Then the matching row is visible and the editor retains its draft.
      return { visible: !container.querySelector('[data-file-path="older"]').classList.contains('hidden'),
        draft: input.value, connected: input.isConnected,
        editingVisible: !input.closest('.session-item').classList.contains('hidden'),
        focused: document.activeElement === input,
        cached: sidebar.projects[0].sessions[0].name };
    });
    expect(result).toEqual({ visible: true, draft: 'User draft', connected: true,
      editingVisible: true, focused: true, cached: 'Another summary' });
  });

  test('repeated streaming status with the same name does not replace title nodes', async () => {
    // Given a title already synchronized with the host.
    const unchanged = await evaluate(() => {
      const title = container.querySelector('[data-file-path="older"] .session-title');
      const text = title.firstChild;
      // When another status carries the same name.
      sidebar.updateSessionName('older', 'Older');
      // Then the existing rendered text node is retained.
      return title.firstChild === text;
    });
    expect(unchanged).toBe(true);
  });

  test('search and message matches survive mode changes and favourite rerenders', async () => {
    const result = await evaluate(async () => {
      sidebar.setSortMode('latest');
      sidebar.setSearchQuery('o');
      await sidebar.fullTextSearch('o');
      sidebar.setSortMode('default');
      sidebar.setSortMode('latest');
      sidebar.toggleFavourite('older');
      const visible = [...container.querySelectorAll('.latest-sessions .session-item:not(.hidden)')].map(el => el.dataset.filePath);
      const matches = container.querySelectorAll('.search-results-group .session-item').length;
      container.querySelector('.latest-sessions .session-item:not(.hidden)').click();
      sidebar.setSearchQuery('');
      return { visible, matches, selected, restored: rowPaths(), remainingMatches: container.querySelectorAll('.search-results-group').length };
    });
    expect(result).toEqual({ visible: ['older'], matches: 1,
      selected: { filePath: 'older', workspace: 'C:/work/alpha' },
      restored: ['newest', 'middle', 'older'], remainingMatches: 0 });
  });

  test('workspace text cannot create markup and long names leave time visible', async () => {
    const result = await evaluate(() => {
      const name = 'workspace <img src=x onerror=alert(1)> "quoted" ' + 'long'.repeat(30);
      sidebar.projects[0].path = 'C:\\work\\' + name;
      sidebar.setSortMode('latest');
      const workspace = container.querySelector('.session-workspace');
      const meta = workspace.parentElement;
      const time = meta.firstElementChild;
      return { name: workspace.textContent === name, title: workspace.title === 'C:\\work\\' + name,
        images: meta.querySelectorAll('img').length, clipped: workspace.scrollWidth > workspace.clientWidth,
        contained: workspace.getBoundingClientRect().right <= meta.getBoundingClientRect().right + 1,
        timeVisible: time.clientWidth > 0 };
    });
    expect(result).toEqual({ name: true, title: true, images: 0, clipped: true, contained: true, timeVisible: true });
  });

  test('search-only sessions display their input time or creation fallback', async () => {
    const result = await evaluate(() => {
      sidebar.setSortMode('latest');
      const sentAt = Date.now() - 9000000;
      return [undefined, sentAt].map(lastUserInputAt => {
        sidebar._searchResults = [{
          filePath: 'search-only', sessionName: 'Search only', project: 'C:/work/hidden',
          sessionTimestamp: lastUserInputAt === undefined ? new Date(sentAt).toISOString() : '2020-01-01',
          lastUserInputAt, matches: [{ snippet: 'match' }],
        }];
        sidebar.renderSearchResults();
        const meta = container.querySelector('.search-result-item .session-meta');
        return { time: meta.firstElementChild.textContent, workspace: meta.querySelector('.session-workspace').textContent };
      });
    });
    expect(result).toEqual([{ time: '2h ago', workspace: 'hidden' }, { time: '2h ago', workspace: 'hidden' }]);
  });

  test('empty lists remain empty in either mode', async () => {
    const result = await evaluate(() => {
      sidebar.projects = [];
      sidebar.setSortMode('latest');
      const latest = { rows: rowPaths().length, empty: !!container.querySelector('.session-loading') };
      sidebar.setSortMode('default');
      return { latest, defaultMode: { rows: rowPaths().length, empty: !!container.querySelector('.session-loading') } };
    });
    expect(result).toEqual({ latest: { rows: 0, empty: true }, defaultMode: { rows: 0, empty: true } });
  });

  test('latest falls back to creation time rather than passive file activity', async () => {
    // Given an input-free session and an older chat whose file was just touched.
    const result = await evaluate(() => {
      sidebar.projects = [{ path: 'C:/work/alpha', dirName: 'alpha', sessions: [
        { filePath: 'old-chat', name: 'Old chat', timestamp: '2020-01-01', lastUserInputAt: 0, mtime: Date.now() },
        { filePath: 'new-chat', name: 'New chat', timestamp: new Date(Date.now() - 9000000).toISOString(), mtime: 0 },
      ] }];
      // When Latest renders both creation fallback and the valid epoch input.
      sidebar.setSortMode('latest');
      return { paths: rowPaths(), time: container.querySelector('.session-meta > span').textContent };
    });
    expect(result).toEqual({ paths: ['new-chat', 'old-chat'], time: '2h ago' });
  });

  test('delivered input moves existing rows and updates message matches without losing an editor', async () => {
    const result = await evaluate(() => {
      sidebar.setSortMode('latest');
      sidebar.setActive('older');
      sidebar._searchResults = [{
        filePath: 'older', sessionName: 'Older', project: 'C:/work/alpha',
        sessionTimestamp: '2025-01-01', matches: [{ snippet: 'older message' }],
      }];
      sidebar.searchQuery = 'older';
      sidebar.applySearch();
      sidebar.renderSearchResults();
      const rows = [...container.querySelectorAll('.session-item')];
      const older = container.querySelector('.latest-sessions [data-file-path="older"]');
      sidebar.startRename(older);
      const input = older.querySelector('input');
      input.value = 'Unfinished title';
      // When a committed input arrives while the same row is being edited.
      sidebar.updateLastUserInput('older', Date.now());
      return {
        paths: [...container.querySelectorAll('.latest-sessions .session-item')].map(row => row.dataset.filePath),
        times: [...container.querySelectorAll('[data-file-path="older"] .session-meta > span:first-child')].map(time => time.textContent),
        retained: rows.every(row => row.isConnected),
        draft: input.value, focused: document.activeElement === input,
        active: older.classList.contains('active'), hidden: older.classList.contains('hidden'),
      };
    });
    expect(result).toEqual({
      paths: ['older', 'newest', 'middle'], times: ['Just now', 'Just now'],
      retained: true, draft: 'Unfinished title', focused: true, active: true, hidden: false,
    });
  });

  test('duplicate stale and unusable input times leave the visible list untouched', async () => {
    const result = await evaluate(() => {
      sidebar.setSortMode('latest');
      const sentAt = Date.now();
      sidebar.updateLastUserInput('older', sentAt);
      const observer = new MutationObserver(() => {});
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      // When replayed, out-of-order, malformed and unknown-session inputs arrive.
      for (const value of [sentAt, sentAt - 1, undefined, null, '', 'invalid', NaN, Infinity, 8640000000000001]) {
        sidebar.updateLastUserInput('older', value);
      }
      sidebar.updateLastUserInput('unknown', sentAt + 1);
      const mutations = observer.takeRecords().length;
      observer.disconnect();
      return { paths: rowPaths(), time: container.querySelector('.session-meta > span').textContent, mutations };
    });
    expect(result).toEqual({ paths: ['older', 'newest', 'middle'], time: 'Just now', mutations: 0 });
  });

  test('default keeps its nodes groups and creation labels while caching delivered input', async () => {
    const result = await evaluate(() => {
      sidebar.toggleFavourite('older');
      sidebar.collapsedProjects.add('alpha');
      sidebar.render();
      const rows = [...container.querySelectorAll('.session-item')];
      const before = rows.map(row => row.querySelector('.session-meta').textContent);
      // When a record timestamp supplies the input time in Default.
      sidebar.updateLastUserInput('older', 'invalid', new Date().toISOString());
      const preserved = {
        paths: rowPaths(), labels: rows.map(row => row.querySelector('.session-meta').textContent),
        nodes: rows.every(row => row.isConnected), collapsed: !!container.querySelector('.project-header.collapsed'),
      };
      sidebar.setSortMode('latest');
      return { preserved, before, latest: rowPaths(), time: container.querySelector('.session-meta > span').textContent };
    });
    expect(result.preserved).toEqual({
      paths: ['older', 'newest', 'older', 'middle'], labels: result.before, nodes: true, collapsed: true,
    });
    expect({ paths: result.latest, time: result.time }).toEqual({ paths: ['older', 'newest', 'middle'], time: 'Just now' });
  });

  test('input delivered before the initial list survives an older list response', async () => {
    let release;
    listReply = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { listRequested = resolve; });
    await evaluate(() => {
      sidebar.projects = [];
      sidebar.setSortMode('latest');
      window.loading = sidebar.loadSessions();
      sidebar.updateLastUserInput('older', Date.now());
    });
    await requested;
    // When the earlier HTTP response arrives after the user input event.
    release({ projects: [{ dirName: 'alpha', path: 'C:/work/alpha', sessions: [
      { filePath: 'newer', name: 'Newer', timestamp: '2020-01-01', lastUserInputAt: 2000 },
      { filePath: 'older', name: 'Older', timestamp: '2020-01-01', lastUserInputAt: 1000 },
    ] }] });
    await evaluate(async () => {
      await window.loading;
    });
    expect(await evaluate(() => ({
      paths: rowPaths(), time: container.querySelector('.session-meta > span').textContent,
    }))).toEqual({ paths: ['older', 'newer'], time: 'Just now' });
  });
});

describe('delivered input ordering in the real application', () => {
  let gateway;
  let view;
  const records = [];
  const evaluate = script => view.evaluate(`(${script.toString()})()`);
  async function deliver(events) {
    const barrier = gateway.nextBarrier();
    await view.evaluate(`(() => { window.qaDelivered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Input event barrier missing')), 3000);
      const listener = event => {
        if (JSON.parse(event.data).id !== ${JSON.stringify(barrier)}) return;
        clearTimeout(timer);
        qaSocket.removeEventListener('message', listener);
        resolve(true);
      };
      qaSocket.addEventListener('message', listener);
    }); return true; })()`);
    gateway.send(events);
    await view.evaluate('qaDelivered');
  }
  beforeAll(async () => {
    gateway = await createStreamingGateway({
      entries: records,
      projects: [{ dirName: 'project', path: 'C:/streaming-test', sessions: [
        { filePath: 'newer.jsonl', name: 'Newer', timestamp: '2020-01-01', lastUserInputAt: 2000 },
        { filePath: 'streaming-test.jsonl', name: 'Current', timestamp: '2020-01-01', lastUserInputAt: 1000 },
      ] }],
    });
    view = new Bun.WebView({ width: 1000, height: 800 });
  });
  beforeEach(async () => {
    records.length = 0;
    gateway.setSnapshot({ isStreaming: false, hasPendingMessages: false });
    await view.navigate(gateway.server.url.href);
    await evaluate(() => new Promise((resolve, reject) => {
      const check = () => {
        if (document.getElementById('attach-btn').disabled || document.querySelectorAll('.session-item').length !== 2) return;
        clearTimeout(timer);
        observer.disconnect();
        const sort = document.getElementById('session-sort');
        sort.value = 'latest';
        sort.dispatchEvent(new Event('change'));
        resolve(true);
      };
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Input session not ready')); }, 3000);
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      check();
    }));
  });
  afterAll(async () => {
    if (view) await view.close();
    gateway?.close();
  });
  test.each(['message_start', 'message_end'])('%s updates Latest from the host user timestamp', async type => {
    await deliver([{ type, message: { role: 'user', timestamp: Date.now(), content: 'Host input' } }]);
    expect(await evaluate(() => ({
      rows: [...document.querySelectorAll('.latest-sessions .session-item')].map(row => row.dataset.filePath),
      time: document.querySelector('.latest-sessions .session-meta > span').textContent,
      errors: qaErrors,
    }))).toEqual({ rows: ['streaming-test.jsonl', 'newer.jsonl'], time: 'Just now', errors: [] });
  });
  test('pending input and assistant output do not change Latest', async () => {
    await deliver([{ type: 'agent_start' }]);
    await evaluate(() => {
      const input = document.getElementById('message-input');
      input.value = 'Queued only';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send-btn').click();
    });
    await deliver([
      { type: 'message_start', message: { role: 'assistant', timestamp: Date.now(), content: [] } },
      { type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), content: [{ type: 'text', text: 'Passive answer' }] } },
    ]);
    expect(await evaluate(() => ({
      rows: [...document.querySelectorAll('.latest-sessions .session-item')].map(row => row.dataset.filePath),
      queue: document.getElementById('queued-messages').textContent.includes('Queued only'),
      errors: qaErrors,
    }))).toEqual({ rows: ['newer.jsonl', 'streaming-test.jsonl'], queue: true, errors: [] });
  });
  test('reconnect restores a missed input using its record timestamp without reloading the list', async () => {
    await evaluate(() => {
      window.originalRows = [...document.querySelectorAll('.latest-sessions .session-item')];
    });
    records.push({ type: 'message', id: 'offline-user', timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Missed while disconnected' } });
    const selection = gateway.nextSelection();
    gateway.disconnect();
    await selection;
    await evaluate(() => new Promise((resolve, reject) => {
      const check = () => {
        if (document.querySelector('.latest-sessions .session-item')?.dataset.filePath !== 'streaming-test.jsonl') return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(true);
      };
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Missed input did not reorder')); }, 3000);
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      check();
    }));
    expect(await evaluate(() => ({
      time: document.querySelector('.latest-sessions .session-meta > span').textContent,
      retained: originalRows.every(row => row.isConnected), errors: qaErrors,
    }))).toEqual({ time: 'Just now', retained: true, errors: [] });
  });
});
