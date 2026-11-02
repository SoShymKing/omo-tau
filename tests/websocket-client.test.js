import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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

describe('connection recovery', () => {
  let client;
  let sockets;
  let timers;
  let clock;
  let cancel;
  let transport;

  beforeEach(() => {
    sockets = [];
    timers = new Map();
    let timerId = 0;
    clock = spyOn(globalThis, 'setTimeout').mockImplementation(callback => {
      timers.set(++timerId, callback);
      return timerId;
    });
    cancel = spyOn(globalThis, 'clearTimeout').mockImplementation(id => timers.delete(id));
    transport = spyOn(globalThis, 'WebSocket').mockImplementation(() => {
      const socket = {
        readyState: 0, wire: [],
        send(raw) { this.wire.push(JSON.parse(raw)); },
        close() { this.readyState = 3; },
        open() { this.readyState = 1; this.onopen(); },
        receive(message) { this.onmessage({ data: JSON.stringify(message) }); },
      };
      sockets.push(socket);
      return socket;
    });
    Object.assign(globalThis.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    client = new WebSocketClient('ws://localhost/ws');
  });

  afterEach(() => {
    client.disconnect();
    transport.mockRestore();
    clock.mockRestore();
    cancel.mockRestore();
  });

  function openGateway() {
    client.connect();
    sockets[0].open();
    sockets[0].receive({ type: 'state', mode: 'gateway' });
    return sockets[0];
  }

  function expire() {
    expect(timers.size).toBe(1);
    const [id, callback] = [...timers][0];
    timers.delete(id);
    callback();
  }

  test.each(['handshake', 'gateway state'])('replaces a socket stalled before %s', stage => {
    // Given an initial connection with no usable gateway response.
    client.connect();
    if (stage === 'gateway state') sockets[0].open();
    const stale = sockets[0];
    // When its bounded connection deadline expires.
    expire();
    // Then a fresh socket replaces it without authorizing session commands.
    expect(sockets).toHaveLength(2);
    expect(stale.readyState).toBe(3);
    expect(client.sessionReady).toBe(false);
  });

  test('coalesces resume checks and leaves a healthy selected session untouched', () => {
    // Given a gateway with an acknowledged selected session.
    const socket = openGateway();
    client.sessionReady = true;
    client.sessionId = 'session-a';
    // When overlapping lifecycle events check the same connection.
    client.checkConnection();
    client.checkConnection();
    client.checkConnection();
    expect(socket.wire).toHaveLength(1);
    expect(socket.wire[0].type).toBe('ping');
    socket.receive({ type: 'pong', id: socket.wire[0].id });
    // Then no selection or reconnect is needed, and no timer keeps polling.
    expect(sockets).toHaveLength(1);
    expect(client.sessionReady).toBe(true);
    expect(timers.size).toBe(0);
  });

  test('reconnects an OPEN socket when its probe is not answered', () => {
    // Given an OPEN transport whose remote route no longer responds.
    const stale = openGateway();
    client.sessionReady = true;
    // When the liveness response deadline expires.
    client.checkConnection();
    expire();
    // Then readiness is revoked and recovery uses a fresh socket.
    expect(stale.readyState).toBe(3);
    expect(sockets).toHaveLength(2);
    expect(client.sessionReady).toBe(false);
    expect(client.gatewayReady).toBe(false);
  });

  test('does not accept an unrelated pong as proof of the pending probe', () => {
    // Given a pending liveness check.
    const socket = openGateway();
    client.checkConnection();
    // When a reply with a different request id arrives.
    socket.receive({ type: 'pong', id: 'another-probe' });
    expire();
    // Then the unanswered check still replaces the stale transport.
    expect(sockets).toHaveLength(2);
  });

  test('cancels recovery when the client intentionally disconnects', () => {
    // Given a pending liveness check.
    openGateway();
    client.checkConnection();
    // When the owner closes the client and a late lifecycle event arrives.
    client.disconnect();
    client.checkConnection();
    // Then neither a probe deadline nor an automatic reconnect remains.
    expect(timers.size).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  test('does not restart an in-progress connection for overlapping resume events', () => {
    // Given a new handshake that already has a deadline.
    client.connect();
    // When multiple lifecycle events arrive before it opens.
    client.checkConnection();
    client.checkConnection();
    // Then one handshake and its original bounded timer remain.
    expect(sockets).toHaveLength(1);
    expect(timers.size).toBe(1);
  });
});
