import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

describe('session ordering in the real browser renderer', () => {
  let server;
  let view;
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
          { filePath: 'newest', name: 'Newest', timestamp: '2020-01-01', mtime: now - 9000000 },
          { filePath: 'older', name: 'Older', timestamp: '2025-01-01', mtime: now - 27000000 },
        ] },
        { path: 'C:\\work\\beta', dirName: 'beta', sessions: [
          { filePath: 'middle', name: 'Middle', timestamp: '2024-01-01', mtime: now - 18000000 },
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

  test('search-only sessions retain their timestamp when no list update time is available', async () => {
    const result = await evaluate(() => {
      sidebar.setSortMode('latest');
      sidebar._searchResults = [{
        filePath: 'search-only', sessionName: 'Search only', project: 'C:/work/hidden',
        sessionTimestamp: new Date(Date.now() - 9000000).toISOString(), matches: [{ snippet: 'match' }],
      }];
      sidebar.renderSearchResults();
      const meta = container.querySelector('.search-result-item .session-meta');
      return { time: meta.firstElementChild.textContent, workspace: meta.querySelector('.session-workspace').textContent };
    });
    expect(result).toEqual({ time: '2h ago', workspace: 'hidden' });
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
});
