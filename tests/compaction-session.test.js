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
  savedEntries = [], history = { before: null }, earlierEntries = [],
} = {}) {
  entries = savedEntries;
  gateway = await createStreamingGateway({
    holdSelection: true, entries, history, earlierEntries,
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
