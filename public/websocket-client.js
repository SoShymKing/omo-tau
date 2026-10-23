/**
 * WebSocket Client - Handles connection to backend WebSocket server
 */

export class WebSocketClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = Infinity;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 10000;
    this.isIntentionallyClosed = false;
    this.reconnectTimer = null;
    this.connectionState = 'idle';
    this.gatewayReady = false;
    this.sessionReady = false;
    this.sessionId = null;
    this.sessionFile = null;
    this.epoch = null;
    this.seq = -1;
    this.pendingSelection = null;
    this.requestSequence = 0;
  }

  connect() {
    if (this.connectionState === 'connecting') return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.isIntentionallyClosed = false;
    this.connectionState = 'connecting';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Close only fully stale sockets before reconnecting
    if (this.ws && (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)) {
      this.ws = null;
    }
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.reconnectAttempts = 0;
      this.connectionState = 'open';
      this.dispatchEvent(new CustomEvent('connected'));
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Disconnected (code=${event.code}, reason=${event.reason || 'n/a'})`);
      this.connectionState = 'closed';
      this.gatewayReady = false;
      this.sessionReady = false;
      this.rejectSelection(new Error('Connection lost while selecting session'));
      this.dispatchEvent(new CustomEvent('disconnected'));

      if (!this.isIntentionallyClosed) {
        this.attemptReconnect();
      }
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.connectionState = 'closed';
    this.gatewayReady = false;
    this.sessionReady = false;
    this.rejectSelection(new Error('Disconnected'));
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
    }
  }

  // Force reconnect — resets attempt counter and connects fresh
  forceReconnect() {
    this.reconnectAttempts = 0;
    this.isIntentionallyClosed = false;
    this.connectionState = 'closed';
    this.gatewayReady = false;
    this.sessionReady = false;
    this.rejectSelection(new Error('Reconnecting'));
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      try { this.ws.close(1000, 'force reconnect'); } catch (e) {}
      this.ws = null;
    }
    this.dispatchEvent(new CustomEvent('disconnected'));
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnection attempts reached');
      this.dispatchEvent(new CustomEvent('reconnectFailed'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.maxReconnectDelay, this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1));
    
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(data) {
    if (!this.isConnected || !this.sessionReady) return false;
    const sessionId = data.sessionId || this.sessionId;
    if (!sessionId) return false;
    this.ws.send(JSON.stringify({ ...data, sessionId }));
    return true;
  }

  get isConnected() {
    return this.connectionState === 'open' && this.ws?.readyState === WebSocket.OPEN;
  }

  rejectSelection(error) {
    if (!this.pendingSelection) return;
    clearTimeout(this.pendingSelection.timeout);
    this.pendingSelection.reject(error);
    this.pendingSelection = null;
  }

  selectSession(sessionFile) {
    if (!this.isConnected || !this.gatewayReady) {
      return Promise.reject(new Error('Session selection is unavailable while disconnected'));
    }
    this.rejectSelection(new DOMException('A newer session selection replaced this one', 'AbortError'));
    const id = this.nextRequestId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectSelection(new Error('Session selection timed out'));
      }, 30000);
      this.pendingSelection = { id, sessionFile, resolve, reject, timeout };
      this.ws.send(JSON.stringify({ type: 'select_session', id, sessionFile }));
    });
  }

  nextRequestId() {
    return `${Date.now()}-${++this.requestSequence}`;
  }

  handleMessage(message) {
    // Emit events based on message type
    switch (message.type) {
      case 'event':
        if (!this.sessionReady || message.sessionId !== this.sessionId ||
            message.epoch !== this.epoch || message.seq <= this.seq) break;
        this.seq = message.seq;
        this.dispatchEvent(new CustomEvent('rpcEvent', {
          detail: { ...message.event, sessionId: message.sessionId },
        }));
        break;
      case 'state':
        this.gatewayReady = message.mode === 'gateway';
        this.dispatchEvent(new CustomEvent('stateUpdate', { detail: message }));
        break;
      case 'session_status':
        if (message.sessionId === this.sessionId &&
            (message.status === 'disconnected' || message.status === 'closed')) {
          this.sessionReady = false;
        }
        this.dispatchEvent(new CustomEvent('sessionStatus', { detail: message }));
        break;
      case 'response':
        if (message.command === 'select_session') {
          if (message.id === this.pendingSelection?.id && message.success === false) {
            this.rejectSelection(new Error(message.error || 'Could not select session'));
          }
          break;
        }
        this.dispatchEvent(new CustomEvent('response', { detail: message }));
        break;
      case 'error':
        this.dispatchEvent(new CustomEvent('serverError', { detail: message }));
        break;
      case 'session_switch':
        this.dispatchEvent(new CustomEvent('sessionSwitch'));
        break;
      case 'mirror_sync':
        if (!this.pendingSelection || message.id !== this.pendingSelection.id) break;
        if (!message.sessionId || !message.sessionFile) {
          this.rejectSelection(new Error('Session snapshot is missing its routing identity'));
          break;
        }
        const selection = this.pendingSelection;
        clearTimeout(selection.timeout);
        this.pendingSelection = null;
        this.sessionId = message.sessionId;
        this.sessionFile = message.sessionFile;
        this.epoch = message.epoch;
        this.seq = message.seq;
        this.sessionReady = true;
        this.dispatchEvent(new CustomEvent('mirrorSync', { detail: message }));
        selection.resolve(message);
        break;
      default:
        console.warn('[WS] Unknown message type:', message.type);
    }
  }
}
