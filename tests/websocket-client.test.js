import { describe, expect, test } from 'bun:test';
import { WebSocketClient } from '../public/websocket-client.js';

describe('selected session readiness', () => {
  function connectedClient() {
    const client = new WebSocketClient('ws://localhost/ws');
    const wire = [];
    client.connectionState = 'open';
    client.gatewayReady = true;
    client.sessionReady = true;
    client.sessionId = 'session-a';
    client.sessionFile = 'a.jsonl';
    client.epoch = 'epoch-a';
    client.seq = 0;
    client.ws = { readyState: WebSocket.OPEN, send: raw => wire.push(JSON.parse(raw)) };
    return { client, wire };
  }

  test('blocks commands while another session selection is pending', async () => {
    // Given a ready A conversation.
    const { client, wire } = connectedClient();
    const selected = client.selectSession('b.jsonl').catch(() => {});
    try {
      // When a command is attempted before B acknowledges selection.
      const sent = client.send({ type: 'prompt', message: 'keep this draft' });
      // Then only the selection goes over the wire, not a prompt to A.
      expect(sent).toBe(false);
      expect(wire.map(message => message.type)).toEqual(['select_session']);
    } finally {
      client.rejectSelection(new DOMException('Test finished', 'AbortError'));
      await selected;
    }
  });

  test('allows explicitly routed background input while another selection is pending', async () => {
    // Given A's acknowledged route and B's pending selection.
    const { client, wire } = connectedClient();
    const selected = client.selectSession('b.jsonl').catch(() => {});
    try {
      // When A's existing queue sends through its explicit background route.
      const sent = client.send({
        type: 'prompt', sessionId: 'session-a', message: 'queued-for-a',
      }, { background: true });
      // Then selection does not stall or redirect that already-routed input.
      expect(sent).toBe(true);
      expect(wire.at(-1)).toMatchObject({ type: 'prompt', sessionId: 'session-a', message: 'queued-for-a' });
    } finally {
      client.rejectSelection(new DOMException('Test finished', 'AbortError'));
      await selected;
    }
  });

  test('does not borrow the selected route for background input without an explicit owner', () => {
    // Given a connected client with a valid selected route.
    const { client, wire } = connectedClient();
    // When a background command omits its own session identity.
    const sent = client.send({ type: 'prompt', message: 'missing-owner' }, { background: true });
    // Then no command can be misrouted through the selected session.
    expect(sent).toBe(false);
    expect(wire).toEqual([]);
  });

  test('ignores old session events while selection is pending', async () => {
    // Given A's old acknowledged identity and a newer pending B selection.
    const { client } = connectedClient();
    const selected = client.selectSession('b.jsonl').catch(() => {});
    let events = 0;
    client.addEventListener('rpcEvent', () => events++);
    try {
      // When A publishes while the user is viewing B's preview.
      client.handleMessage({ type: 'event', sessionId: 'session-a', epoch: 'epoch-a',
        seq: 1, event: { type: 'message_start', message: { role: 'assistant', content: [] } } });
      // Then A cannot alter B's displayed content.
      expect(events).toBe(0);
    } finally {
      client.rejectSelection(new DOMException('Test finished', 'AbortError'));
      await selected;
    }
  });

  test('rejects a snapshot whose file does not match the pending request', async () => {
    // Given a pending selection for B.
    const { client } = connectedClient();
    const selected = client.selectSession('b.jsonl').then(() => true, () => false);
    const id = client.pendingSelection.id;
    // When a same-request response supplies a different routing file.
    client.handleMessage({ type: 'mirror_sync', id, sessionId: 'session-c',
      sessionFile: 'c.jsonl', epoch: 'epoch-c', seq: 0 });
    // Then the mismatched snapshot never enables command routing.
    expect(await selected).toBe(false);
    expect(client.sessionReady).toBe(false);
    expect(client.sessionFile).toBe('a.jsonl');
  });

  test('enables the requested route only after its matching snapshot', async () => {
    // Given a pending B selection.
    const { client, wire } = connectedClient();
    const selected = client.selectSession('b.jsonl');
    // When the correlated B snapshot arrives.
    client.handleMessage({ type: 'mirror_sync', id: client.pendingSelection.id,
      sessionId: 'session-b', sessionFile: 'b.jsonl', epoch: 'epoch-b', seq: 3 });
    await selected;
    // Then subsequent commands carry only B's acknowledged identity.
    expect(client.send({ type: 'prompt', message: 'for B' })).toBe(true);
    expect(wire.at(-1).sessionId).toBe('session-b');
  });

  test.each(['disconnected', 'closed'])('invalidates selection before publishing %s status', status => {
    // Given a selected session whose snapshot was acknowledged.
    const client = new WebSocketClient('ws://localhost/ws');
    client.sessionId = 'selected';
    client.sessionReady = true;
    let readinessDuringEvent;
    client.addEventListener('sessionStatus', () => {
      readinessDuringEvent = client.sessionReady;
    });

    // When that selected session becomes unavailable.
    client.handleMessage({ type: 'session_status', sessionId: 'selected', status });

    // Then consumers cannot send with the old acknowledged snapshot.
    expect(readinessDuringEvent).toBe(false);
    expect(client.sessionReady).toBe(false);
  });

  test('keeps the selected session ready when another session disconnects', () => {
    // Given a selected session and an unrelated background session.
    const client = new WebSocketClient('ws://localhost/ws');
    client.sessionId = 'selected';
    client.sessionReady = true;

    // When only the background session disconnects.
    client.handleMessage({ type: 'session_status', sessionId: 'background', status: 'disconnected' });

    // Then the selected conversation remains usable.
    expect(client.sessionReady).toBe(true);
  });

  test('does not treat a ready status as an acknowledged selection snapshot', () => {
    // Given a selected session waiting to be resynchronized.
    const client = new WebSocketClient('ws://localhost/ws');
    client.sessionId = 'selected';
    client.sessionReady = false;

    // When its connection reports ready without a fresh snapshot.
    client.handleMessage({ type: 'session_status', sessionId: 'selected', status: 'ready' });

    // Then sending still requires the correlated mirror_sync acknowledgement.
    expect(client.sessionReady).toBe(false);
  });
});
