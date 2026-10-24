import { describe, expect, test } from 'bun:test';
import { WebSocketClient } from '../public/websocket-client.js';

describe('selected session readiness', () => {
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
