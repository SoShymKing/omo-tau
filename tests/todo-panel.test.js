import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { normalizeTodoState } from '../public/todo-panel.js';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

const todos = (...statuses) => ({
  schema: 'v2',
  phases: [{ name: 'Delivery', tasks: statuses.map((status, i) => ({ content: `Step ${i + 1}`, status })) }],
});
const saved = data => ({ type: 'custom', customType: 'senpi.todo-state', data });
const answer = text => ({
  type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] },
});

test('only nonempty terminal lists are finished', () => {
  // Given canonical task states with unfinished, terminal and unsupported statuses.
  const states = [null, todos(), todos('pending'), todos('in_progress'), todos('unknown'),
    todos('completed', 'pending'), todos('completed'), todos('completed', 'abandoned'),
    todos('cancelled'), todos('failed')];
  // When normalizing the canonical state, then unfinished work is never hidden.
  expect(states.map(state => normalizeTodoState(state).finished))
    .toEqual([false, false, false, false, false, false, true, true, true, true]);
});

describe('task lifecycle in the real application', () => {
  let gateway;
  let view;
  const evaluate = (fn, args = null) => view.evaluate(`(${fn.toString()})(${JSON.stringify(args)})`);

  async function open(options = {}) {
    gateway = await createStreamingGateway({ ...options, holdSelection: true });
    await view.navigate(gateway.server.url.href);
    await gateway.nextSelection();
    await evaluate(() => {
      window.qaReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Selection missing')); }, 3000);
        const observer = new MutationObserver(() => {
          if (!document.querySelector('#session-preview-status').classList.contains('hidden')) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve(true);
        });
        observer.observe(document.querySelector('#session-preview-status'), { attributes: true });
      });
    });
    gateway.acknowledge();
    await view.evaluate('window.qaReady');
  }

  async function deliver(todoState) {
    await evaluate(id => {
      window.qaDelivered = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          qaSocket.removeEventListener('message', listener);
          reject(new Error('Task event barrier missing'));
        }, 3000);
        const listener = event => {
          if (JSON.parse(event.data).id !== id) return;
          clearTimeout(timer);
          qaSocket.removeEventListener('message', listener);
          resolve(true);
        };
        qaSocket.addEventListener('message', listener);
      });
    }, gateway.nextBarrier());
    gateway.send([{ type: 'agent_end', todoState }]);
    await view.evaluate('window.qaDelivered');
  }

  beforeAll(() => { view = new Bun.WebView({ width: 1000, height: 800 }); });
  afterEach(() => { gateway?.close(); });
  afterAll(async () => { await view?.close(); });

  test('keeps unfinished work in the footer even when the agent is idle', async () => {
    // Given an idle selected session.
    await open();
    // When a list still has pending work.
    await deliver(todos('completed', 'pending'));
    // Then only the footer presents the list.
    expect(await evaluate(() => ({
      hidden: document.querySelector('#todo-panel').hidden,
      records: document.querySelectorAll('.task-history').length,
      errors: qaErrors,
    }))).toEqual({ hidden: false, records: 0, errors: [] });
  });

  test('moves a finished list to a collapsed record with its full text and statuses', async () => {
    // Given an unfinished list whose text must be treated as data.
    await open({ todoState: todos('in_progress') });
    const complete = todos('completed');
    complete.phases[0].tasks[0].content = '<img src=x onerror=alert(1)>';
    // When the list completes.
    await deliver(complete);
    // Then the footer is hidden and the full list is retained safely in chat.
    expect(await evaluate(() => {
      const record = document.querySelector('.task-history');
      return {
        hidden: document.querySelector('#todo-panel').hidden,
        records: document.querySelectorAll('.task-history').length,
        open: record.open,
        content: record.querySelector('.todo-panel-task-content').textContent,
        status: record.querySelector('.todo-panel-task').dataset.status,
        images: record.querySelectorAll('img').length,
        errors: qaErrors,
      };
    })).toEqual({ hidden: true, records: 1, open: false,
      content: '<img src=x onerror=alert(1)>', status: 'completed', images: 0, errors: [] });
  });

  test('repeated snapshots preserve one record and its expanded state', async () => {
    // Given a completed record opened by the reader.
    await open({ todoState: todos('completed') });
    await evaluate(() => document.querySelector('.task-history summary').click());
    // When the same authoritative state arrives again.
    await deliver(todos('completed'));
    // Then neither duplication nor disclosure reset occurs.
    expect(await evaluate(() => ({
      records: document.querySelectorAll('.task-history').length,
      open: document.querySelector('.task-history').open,
    }))).toEqual({ records: 1, open: true });
  });

  test('new work restores the footer without removing earlier completions', async () => {
    // Given a finished list.
    await open({ todoState: todos('completed') });
    // When another list starts.
    await deliver(todos('in_progress', 'pending'));
    // Then the new list appears in the footer and the old record stays.
    expect(await evaluate(() => ({
      hidden: document.querySelector('#todo-panel').hidden,
      progress: document.querySelector('.todo-panel-progress').textContent,
      records: document.querySelectorAll('.task-history').length,
    }))).toEqual({ hidden: false, progress: '0/2', records: 1 });
  });

  test('allows the same checklist to complete in a later run', async () => {
    // Given a checklist reused after one completed run.
    await open({ todoState: todos('completed') });
    await deliver(todos('in_progress'));
    // When the reused checklist completes again.
    await deliver(todos('completed'));
    // Then both distinct runs are retained.
    expect(await evaluate(() => document.querySelectorAll('.task-history').length)).toBe(2);
  });

  test.each(['abandoned', 'cancelled', 'failed'])('retains terminal %s status outside the footer', async status => {
    // Given a list with both successful and terminal unsuccessful tasks.
    await open({ todoState: todos('completed', status) });
    // When inspecting the restored record, then the exact status is retained and the footer is hidden.
    expect(await evaluate(() => ({
      hidden: document.querySelector('#todo-panel').hidden,
      statuses: [...document.querySelectorAll('.task-history .todo-panel-task')].map(node => node.dataset.status),
      outcome: document.querySelector('.task-history .activity-status').textContent,
    }))).toEqual({ hidden: true, statuses: ['completed', status],
      outcome: status === 'failed' ? 'Failed' : 'Cancelled' });
  });

  test('restores saved records in chronological order without snapshot duplicates', async () => {
    // Given persisted task entries between two assistant answers.
    const complete = todos('completed');
    await open({ todoState: complete, entries: [
      answer('Before'), saved(todos('in_progress')), saved(complete), answer('After'),
    ] });
    // When the authoritative snapshot is rendered, then the record stays between the answers.
    expect(await evaluate(() => ({
      rows: [...document.querySelector('#messages').children].map(node =>
        node.matches('.task-history') ? 'tasks' : node.querySelector('.message-content')?.textContent.trim()),
      hidden: document.querySelector('#todo-panel').hidden,
      errors: qaErrors,
    }))).toEqual({ rows: ['Before', 'tasks', 'After'], hidden: true, errors: [] });
  });

  test('loads older task records without losing the current record or its open state', async () => {
    // Given a recent completion and an older page containing a different completion.
    await open({ todoState: todos('completed', 'completed'),
      entries: [saved(todos('completed', 'completed')), answer('Recent')],
      history: { before: 5 }, earlierEntries: [answer('Older'), saved(todos('completed'))] });
    // When the reader loads earlier history.
    await evaluate(() => new Promise((resolve, reject) => {
      const current = document.querySelector('.task-history');
      current.open = true;
      const observer = new MutationObserver(() => {
        if (document.querySelector('.history-load')) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(true);
      });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Earlier history missing')); }, 3000);
      observer.observe(document.querySelector('#messages'), { childList: true });
      document.querySelector('.history-load').click();
    }));
    // Then both records are chronological and the live disclosure is preserved.
    expect(await evaluate(() => ({
      progress: [...document.querySelectorAll('.task-history summary')].map(node => node.children[1].textContent),
      open: document.querySelectorAll('.task-history')[1].open,
      errors: qaErrors,
    }))).toEqual({ progress: ['1/1', '2/2'], open: true, errors: [] });
  });

  test('restores an off-page completion only at its saved chronological position', async () => {
    // Given a completed snapshot whose saved entry is outside the recent page.
    const complete = todos('completed');
    await open({ todoState: complete, entries: [answer('Recent')],
      history: { before: 5 }, earlierEntries: [saved(complete)] });
    await deliver(complete);
    const before = await evaluate(() => document.querySelectorAll('.task-history').length);
    // When the reader loads the page with the saved completion.
    await evaluate(() => new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('.history-load')) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(true);
      });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Earlier history missing')); }, 3000);
      observer.observe(document.querySelector('#messages'), { childList: true });
      document.querySelector('.history-load').click();
    }));
    // Then the one record precedes the recent answer, without a misplaced snapshot copy.
    expect({ before, after: await evaluate(() => ({
      rows: [...document.querySelector('#messages').children].map(node =>
        node.matches('.task-history') ? 'tasks' : node.querySelector('.message-content')?.textContent.trim()),
      hidden: document.querySelector('#todo-panel').hidden,
      errors: qaErrors,
    })) }).toEqual({ before: 0, after: { rows: ['tasks', 'Recent'], hidden: true, errors: [] } });
  });

  test('keeps empty and unavailable states distinct from completion', async () => {
    // Given an empty task list.
    await open();
    // When an unsupported payload arrives.
    await deliver({ schema: 'future', phases: [] });
    // Then the footer reports unavailable state instead of fabricating completion.
    expect(await evaluate(() => ({
      state: document.querySelector('#todo-panel').dataset.state,
      hidden: document.querySelector('#todo-panel').hidden,
      records: document.querySelectorAll('.task-history').length,
    }))).toEqual({ state: 'unavailable', hidden: false, records: 0 });
  });
});
