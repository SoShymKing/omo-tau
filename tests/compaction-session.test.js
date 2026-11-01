import { afterEach, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

let gateway;
let view;
let entries;
const first = {
  sessionId: 'session-a', sessionFile: 'a.jsonl', epoch: 'epoch-a',
  isStreaming: false, isCompacting: false, hasPendingMessages: false,
};
const second = { ...first, sessionId: 'session-b', sessionFile: 'b.jsonl', epoch: 'epoch-b' };

async function ready(action) {
  await view.evaluate(`(() => {
    window.qaReady = new Promise((resolve, reject) => {
      const status = document.querySelector('#session-preview-status');
      const check = () => {
        if (!status.classList.contains('hidden')) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(true);
      };
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Selection was not acknowledged'));
      }, 3000);
      observer.observe(status, { attributes: true });
    });
    return true;
  })()`);
  action();
  await view.evaluate('window.qaReady');
}

async function open(width = 1440, {
  savedEntries = [], history = { before: null }, earlierEntries = [], rpcHandler = null,
} = {}) {
  entries = savedEntries;
  gateway = await createStreamingGateway({
    holdSelection: true, entries, history, earlierEntries, rpcHandler,
    projects: [{ path: 'C:/qa', dirName: 'qa', sessions: [
      { filePath: first.sessionFile, name: 'Session A', timestamp: '2026-01-01' },
      { filePath: second.sessionFile, name: 'Session B', timestamp: '2026-01-01' },
    ] }],
  });
  gateway.setSnapshot(first);
  view = new Bun.WebView({ width, height: 900 });
  await view.navigate(gateway.server.url.href);
  await gateway.nextSelection();
  await ready(() => gateway.acknowledge());
}

async function select(snapshot) {
  await view.evaluate(`document.querySelector('.session-item[data-file-path="${snapshot.sessionFile}"]').click()`);
  await gateway.nextSelection();
  gateway.setSnapshot(snapshot);
  await ready(() => gateway.acknowledge());
}

async function submit(message, queued = false) {
  const sent = queued ? null : gateway.nextCommand('prompt');
  await view.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = ${JSON.stringify(message)};
    input.dispatchEvent(new Event('input'));
    document.querySelector('#send-btn').click();
  })()`);
  if (sent) await sent;
}

async function deliver(events) {
  await view.evaluate(`(() => {
    window.qaDelivered = new Promise((resolve, reject) => {
      const listener = event => {
        if (JSON.parse(event.data).id !== ${JSON.stringify(gateway.nextBarrier())}) return;
        clearTimeout(timer);
        qaSocket.removeEventListener('message', listener);
        resolve(true);
      };
      const timer = setTimeout(() => {
        qaSocket.removeEventListener('message', listener);
        reject(new Error('Event barrier missing'));
      }, 3000);
      qaSocket.addEventListener('message', listener);
    });
    return true;
  })()`);
  gateway.send(events);
  await view.evaluate('window.qaDelivered');
}

const prompts = () => gateway.commands.filter(command => command.type === 'prompt');
const visible = () => view.evaluate(`({
  messages: [...document.querySelectorAll('.message.user .message-content')].map(el => el.textContent),
  compacting: !!document.querySelector('#compaction-indicator:not(.compaction-done)'),
  queued: document.querySelector('#queued-messages').textContent.trim(),
  input: document.querySelector('#message-input').value,
  errors: qaErrors,
})`);

afterEach(async () => {
  if (view) await view.close();
  gateway?.close();
  view = null;
  gateway = null;
});

test.each([390, 1440])('restores compaction from status without a start event at width %i', async width => {
  // Given a selected idle session whose start event was not delivered.
  await open(width);

  // When a status update reports compaction in progress.
  gateway.setSnapshot({ isCompacting: true });
  gateway.sendStatus({ isCompacting: true });
  await deliver([]);

  // Then both the persistent status and the message indicator recover.
  expect((await visible()).compacting).toBe(true);
  expect(await view.evaluate(`document.querySelector('#status-text').textContent`)).toBe('Compacting...');
  expect(await view.evaluate(`document.querySelector('#abort-btn').classList.contains('hidden')`)).toBe(false);
});

test('clears a missed compaction end without claiming success or resetting tokens', async () => {
  // Given a compacting session with known context usage.
  await open();
  await select({ ...first, isCompacting: true, contextUsage: { tokens: 900, contextWindow: 1000 } });
  const usage = await view.evaluate(`document.querySelector('#token-usage').textContent`);

  // When only the idle status arrives, without the actual compaction result.
  gateway.setSnapshot({ isCompacting: false });
  gateway.sendStatus({ isCompacting: false });
  await deliver([]);

  // Then the stale spinner clears without inventing a successful result.
  expect((await visible()).compacting).toBe(false);
  expect(await view.evaluate(`document.querySelector('#status-text').textContent`)).toBe('Connected');
  expect(await view.evaluate(`document.querySelector('#token-usage').textContent`)).toBe(usage);
  expect(await view.evaluate(`document.querySelector('#messages').textContent`)).not.toContain('Context compacted');
});

test('does not render background-session compaction in the selected session', async () => {
  // Given a selected idle session.
  await open();

  // When another session starts compacting.
  gateway.sendStatus({ ...second, isCompacting: true });
  await deliver([]);

  // Then the selected session remains idle.
  expect((await visible()).compacting).toBe(false);
  expect(await view.evaluate(`document.querySelector('#status-text').textContent`)).toBe('Connected');
});

test('does not duplicate compaction indicators when status and start events overlap', async () => {
  // Given an active indicator recovered from a session snapshot.
  await open();
  await select({ ...first, isCompacting: true });

  // When both legacy and native start notifications arrive with status.
  gateway.sendStatus({ isCompacting: true });
  await deliver([{ type: 'compaction_start' }, { type: 'auto_compaction_start' }]);

  // Then there is still one progress indicator.
  expect(await view.evaluate(`document.querySelectorAll('.compaction-message').length`)).toBe(1);
  expect((await visible()).compacting).toBe(true);
});

test.each([
  { error: 'qa-summary-rejected' },
  { aborted: true },
])('preserves context usage after unsuccessful compaction %j', async outcome => {
  // Given a session whose existing context was not replaced yet.
  await open();
  await select({ ...first, isCompacting: true, contextUsage: { tokens: 900, contextWindow: 1000 } });
  const usage = await view.evaluate(`document.querySelector('#token-usage').textContent`);

  // When compaction fails or is aborted.
  await deliver([{ type: 'compaction_end', ...outcome }]);

  // Then the current context usage and retry control remain accurate.
  expect((await visible()).compacting).toBe(false);
  expect(await view.evaluate(`document.querySelector('#token-usage').textContent`)).toBe(usage);
  expect(await view.evaluate(`!!document.querySelector('#compact-btn')`)).toBe(true);
  if (outcome.error) {
    expect(await view.evaluate(`document.querySelector('.compaction-done').textContent`)).toContain(outcome.error);
  }
});

async function settings() {
  await view.evaluate(`(() => {
    window.qaSettings = new Promise((resolve, reject) => {
      const toggle = document.querySelector('#toggle-auto-compact');
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        observer.disconnect();
        resolve(true);
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Settings state missing'));
      }, 3000);
      observer.observe(toggle, { attributes: true, attributeFilter: ['class'] });
    });
    document.querySelector('#settings-btn').click();
    return true;
  })()`);
  await view.evaluate('window.qaSettings');
}

test.each([false, true])('keeps auto-compaction unchanged until the host replies (failure: %s)', async failure => {
  // Given a writable host setting initially disabled and a held setter response.
  let requested;
  let release;
  const request = new Promise(resolve => { requested = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  await open(390, { rpcHandler: async command => {
    if (command.type === 'get_state') return { success: true,
      data: { autoCompactionEnabled: false, autoCompactionSupported: true } };
    if (command.type === 'set_auto_compaction') { requested(command); return response; }
    return { success: true, data: {} };
  } });
  await settings();

  // When the user requests a setting change and the host has not yet accepted it.
  await view.evaluate(`document.querySelector('#toggle-auto-compact').click()`);
  expect(await request).toMatchObject({ enabled: true, sessionId: first.sessionId });
  expect(await view.evaluate(`document.querySelector('#toggle-auto-compact').classList.contains('on')`)).toBe(false);
  expect(await view.evaluate(`document.querySelector('#toggle-auto-compact').disabled`)).toBe(true);
  await view.evaluate(`(() => {
    window.qaSettingApplied = new Promise((resolve, reject) => {
      const toggle = document.querySelector('#toggle-auto-compact');
      const observer = new MutationObserver(() => {
        if (toggle.disabled) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(true);
      });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Setting response missing')); }, 3000);
      observer.observe(toggle, { attributes: true, attributeFilter: ['disabled'] });
    });
    return true;
  })()`);
  release(failure ? { success: false, error: 'qa-setting-rejected' } : { success: true });
  await view.evaluate('window.qaSettingApplied');

  // Then only an accepted setting changes the toggle; failures remain visible.
  expect(await view.evaluate(`document.querySelector('#toggle-auto-compact').classList.contains('on')`)).toBe(!failure);
  if (failure) expect(await view.evaluate(`document.querySelector('#auto-compaction-feedback').textContent`))
    .toContain('qa-setting-rejected');
});

test('reloads auto-compaction support and value when selecting a different session', async () => {
  // Given a writable first session with automatic compaction disabled.
  await open(1440, { rpcHandler: command => ({
    success: true, data: command.type === 'get_state' ? {
      autoCompactionEnabled: command.sessionId === second.sessionId,
      autoCompactionSupported: command.sessionId === first.sessionId,
    } : {},
  }) });
  await settings();
  expect(await view.evaluate(`document.querySelector('#toggle-auto-compact').disabled`)).toBe(false);

  // When settings are opened on a read-only session with the opposite value.
  await view.evaluate(`document.querySelector('#settings-close').click()`);
  await select(second);
  await settings();

  // Then the new value is shown but the unsupported control cannot change it.
  expect(await view.evaluate(`document.querySelector('#toggle-auto-compact').classList.contains('on')`)).toBe(true);
  expect(await view.evaluate(`document.querySelector('#toggle-auto-compact').disabled`)).toBe(true);
});

test.each([390, 1440])('retains an uncommitted prompt after leaving a compacting session at width %i', async width => {
  // Given a submitted prompt whose preflight compaction has not committed a user entry.
  await open(width);
  await submit('pending-compaction-input');
  await deliver([{ type: 'compaction_start' }]);

  // When the user visits another session and returns before preflight finishes.
  await select(second);
  await select({ ...first, isCompacting: true });

  // Then the original message and active compaction remain visible without resending.
  expect(await visible()).toEqual({
    messages: ['pending-compaction-input'], compacting: true, queued: '', input: '', errors: [],
  });
  expect(prompts()).toHaveLength(1);
});

test('reconciles a committed prompt by identity without hiding equal text from another input', async () => {
  // Given earlier identical text and a new uncommitted browser prompt.
  await open();
  entries.push({ type: 'message', id: 'earlier', message: {
    role: 'user', content: 'same-input', clientMessageId: 'earlier-input',
  } });
  await submit('same-input');
  await select(second);
  await select({ ...first, isCompacting: true });
  expect((await visible()).messages).toEqual(['same-input', 'same-input']);
  const command = prompts()[0];
  expect(command.clientMessageId).toBeString();

  // When the host commits this exact browser input and publishes the matching user event.
  entries.push({ type: 'message', id: 'committed', message: {
    role: 'user', content: 'same-input', clientMessageId: command.clientMessageId,
  } });
  await select(second);
  await select(first);
  await deliver([{ type: 'message_start', message: {
    role: 'user', content: 'same-input', clientMessageId: command.clientMessageId,
  } }]);

  // Then the transcript has both genuine inputs, with no third optimistic copy.
  expect((await visible()).messages).toEqual(['same-input', 'same-input']);
  expect(prompts()).toHaveLength(1);
});

test('keeps a following input queued while the original prompt is compacting', async () => {
  // Given a submitted input and a round-trip through another session during compaction.
  await open();
  await submit('first-input');
  await select(second);
  await select({ ...first, isCompacting: true });

  // When another input is submitted before the original preflight is accepted.
  await submit('following-input', true);

  // Then the original input is retained and only the following one is queued locally.
  expect(prompts().map(command => command.message)).toEqual(['first-input']);
  expect((await visible()).messages).toEqual(['first-input']);
  expect((await visible()).queued).toContain('following-input');
});

test('resumes the following input after compaction and the original turn finish', async () => {
  // Given a following input queued while the original prompt is compacting.
  await open();
  await submit('first-input');
  await deliver([{ type: 'compaction_start' }]);
  await submit('following-input', true);
  const command = prompts()[0];
  entries.push({ type: 'message', id: 'first-committed', message: {
    role: 'user', content: 'first-input', clientMessageId: command.clientMessageId,
  } });
  await select(second);
  await select({ ...first, isStreaming: true });

  // When the admitted original turn completes after the browser returns.
  const resumed = gateway.nextCommand('prompt');
  await deliver([{ type: 'agent_end' }]);

  // Then the queued input is sent exactly once to its original session.
  expect(await resumed).toMatchObject({
    message: 'following-input', sessionId: first.sessionId,
  });
  expect(prompts()).toHaveLength(2);
  expect((await visible()).messages).toEqual(['first-input', 'following-input']);
  expect((await visible()).queued).toBe('');
});

test('does not release a following input when a run ends before prompt admission', async () => {
  // Given a sent input still awaiting admission and another input queued behind it.
  await open();
  await submit('awaiting-admission');
  await submit('following-input', true);

  // When an earlier host run ends before the pending input becomes a user message.
  await deliver([{ type: 'agent_end' }]);

  // Then the earlier end cannot release the following input ahead of admission.
  expect(prompts().map(command => command.message)).toEqual(['awaiting-admission']);
  expect((await visible()).queued).toContain('following-input');
});

test('reconciles terminal messages without client identities against new host messages only', async () => {
  // Given earlier terminal input with the same text as a new browser submission.
  await open();
  entries.push({ type: 'message', id: 'earlier-terminal', message: {
    role: 'user', content: 'terminal-input', timestamp: 1,
  } });
  await select(second);
  await select(first);
  await submit('terminal-input');
  await select(second);
  await select({ ...first, isCompacting: true });
  expect((await visible()).messages).toEqual(['terminal-input', 'terminal-input']);

  // When the terminal commits a new message without client metadata.
  const message = { role: 'user', content: 'terminal-input', timestamp: 2 };
  entries.push({ type: 'message', id: 'new-terminal', message });
  await select(second);
  await select(first);
  await deliver([{ type: 'message_start', message }]);

  // Then history and events share the accepted input, and future input is not blocked.
  expect((await visible()).messages).toEqual(['terminal-input', 'terminal-input']);
  await submit('next-terminal-input');
  expect(prompts()).toHaveLength(2);
});

test('does not confirm pending input against newly exposed older terminal history', async () => {
  // Given the latest terminal message and a new browser input still awaiting compaction.
  await open();
  entries.push({ type: 'message', id: 'latest-terminal', message: {
    role: 'user', content: 'latest-terminal-input', timestamp: 2,
  } });
  await select(second);
  await select(first);
  await submit('same-as-older-input');

  // When a later snapshot exposes an older equal-text record that was previously paged out.
  entries.unshift({ type: 'message', id: 'older-terminal', message: {
    role: 'user', content: 'same-as-older-input', timestamp: 1,
  } });
  await select(second);
  await select({ ...first, isCompacting: true });

  // Then the older record cannot consume the still-uncommitted browser message.
  expect((await visible()).messages).toEqual([
    'same-as-older-input', 'latest-terminal-input', 'same-as-older-input',
  ]);
  expect(prompts()).toHaveLength(1);
});

test('does not confirm pending input from older pages when the latest page has no user records', async () => {
  // Given an assistant-only latest page and an equal-text user message on an older page.
  await open(1440, {
    savedEntries: [{ type: 'message', id: 'latest-assistant', message: {
      role: 'assistant', content: [{ type: 'text', text: 'latest-context' }], timestamp: 100,
    } }],
    history: { before: 'older-page' },
    earlierEntries: [{ type: 'message', id: 'older-user', message: {
      role: 'user', content: 'repeated-input', timestamp: 1,
    } }],
  });
  await submit('repeated-input');

  // When older history is loaded before leaving and returning during preflight compaction.
  await view.evaluate(`(() => new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-entry-id="older-user"]')) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(true);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Older user history missing'));
    }, 3000);
    observer.observe(document.querySelector('#messages'), { childList: true, subtree: true });
    document.querySelector('.history-load').click();
  }))()`);
  await select(second);
  await select({ ...first, isCompacting: true });

  // Then the older page cannot consume the new prompt that the host has not committed.
  expect((await visible()).messages).toEqual(['repeated-input']);
  expect(prompts()).toHaveLength(1);
});

test('restores a rejected prompt and its failure after returning from another session', async () => {
  // Given a prompt rejected while the browser displays a different session.
  await open();
  await submit('rejected-input');
  const command = prompts()[0];
  await select(second);
  gateway.respond({ command: 'prompt', id: command.id, sessionId: first.sessionId,
    success: false, error: 'preflight-rejected' });
  await deliver([]);

  // When the rejected session is selected again.
  await select(first);

  // Then its text and failure remain visible, without automatically replaying the command.
  expect((await visible()).messages).toEqual(['rejected-input']);
  expect(await view.evaluate(`document.querySelector('#messages').textContent`)).toContain('preflight-rejected');
  expect(prompts()).toHaveLength(1);
  await submit('replacement-input');
  await deliver([]);
  expect(prompts().map(prompt => prompt.message)).toEqual(['rejected-input', 'replacement-input']);
});

test.each([390, 1440])('drains the original queue while another selection is still preparing at width %i', async width => {
  // Given two local inputs queued behind the original session's running turn.
  await open(width);
  await deliver([{ type: 'agent_start' }]);
  await submit('queued-first', true);
  await submit('queued-second', true);
  await view.evaluate(`document.querySelector('.session-item[data-file-path="b.jsonl"]').click()`);
  await gateway.nextSelection();

  // When the original turn and then the first queued turn finish during B's preparation.
  const firstSent = gateway.nextCommand('prompt');
  gateway.sendStatus({ ...first, isStreaming: false });
  await deliver([]);
  const firstCommand = await firstSent;
  gateway.respond({ command: 'prompt', id: firstCommand.id, success: true });
  gateway.sendStatus({ ...first, isStreaming: true });
  await deliver([]);
  const secondSent = gateway.nextCommand('prompt');
  gateway.sendStatus({ ...first, isStreaming: false });
  await deliver([]);
  const secondCommand = await secondSent;

  // Then both commands retain A's route and order before B is acknowledged.
  expect([firstCommand, secondCommand].map(command => ({
    message: command.message, sessionId: command.sessionId,
  }))).toEqual([
    { message: 'queued-first', sessionId: first.sessionId },
    { message: 'queued-second', sessionId: first.sessionId },
  ]);
  expect(await view.evaluate(`document.querySelector('#session-preview-status').classList.contains('hidden')`)).toBe(false);
  gateway.setSnapshot(second);
  await ready(() => gateway.acknowledge());
  await select({ ...first, isCompacting: true });
  expect((await visible()).messages).toEqual(['queued-first', 'queued-second']);
  expect((await visible()).queued).toBe('');
  expect(prompts()).toHaveLength(2);
});

test('drains queued input after returning to an idle accepted turn whose user record is paged out', async () => {
  // Given accepted native input whose committed user record is outside the latest history page.
  await open();
  await submit('accepted-input');
  gateway.respond({ command: 'prompt', id: prompts()[0].id, success: true,
    data: { disposition: 'started' } });
  await deliver([{ type: 'agent_start' }]);
  await submit('queued-after-accepted', true);
  entries.push({ type: 'message', id: 'latest-answer', message: {
    role: 'assistant', content: [{ type: 'text', text: 'latest-answer' }], timestamp: 100,
  } });
  await select(second);

  // When the user returns to A after its turn ended with only the assistant in the latest page.
  const sent = gateway.nextCommand('prompt');
  await select(first);

  // Then an already accepted input cannot block the following local queue forever.
  expect(await sent).toMatchObject({ message: 'queued-after-accepted', sessionId: first.sessionId });
  expect(prompts()).toHaveLength(2);
  expect((await visible()).messages).toEqual(['accepted-input', 'queued-after-accepted']);
  expect((await visible()).queued).toBe('');
});

test('keeps following input queued between native acceptance and the turn starting', async () => {
  // Given input accepted by native preflight before its agent_start event.
  await open();
  await submit('accepted-before-start');
  gateway.respond({ command: 'prompt', id: prompts()[0].id, success: true,
    data: { disposition: 'started' } });
  await deliver([]);

  // When another input arrives during the admission-to-start boundary.
  await submit('following-after-acceptance', true);
  await deliver([]);

  // Then acceptance alone does not send following input ahead of the original turn.
  expect(prompts().map(command => command.message)).toEqual(['accepted-before-start']);
  expect((await visible()).queued).toContain('following-after-acceptance');
});
