/** On-demand details, with a byte-bounded preview cache and shared requests. */
export class ToolDetailClient {
  constructor(getContext) {
    this.getContext = getContext;
    this.cache = new Map();
    this.cacheBytes = 0;
    this.pending = new Map();
    this.requests = new Set();
    this.generation = 0;
  }

  contextKey() {
    const { sessionFile, epoch, generation } = this.getContext();
    return JSON.stringify([sessionFile, epoch, generation, this.generation]);
  }

  view(summary, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const context = this.contextKey();
    const key = JSON.stringify([context, summary.toolCallId,
      summary.callRef, summary.resultRef, summary.liveRef, summary.revision]);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve().then(() => {
        signal?.throwIfAborted();
        if (context !== this.contextKey()) throw new DOMException('Tool context changed', 'AbortError');
        return cached.value;
      });
    }
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { controller: new AbortController(), users: 0 };
      this.pending.set(key, entry);
      entry.promise = this.request(summary, { mode: 'view' }, entry.controller.signal)
        .then(value => {
          entry.controller.signal.throwIfAborted();
          if (context !== this.contextKey()) throw new DOMException('Tool context changed', 'AbortError');
          const bytes = new TextEncoder().encode(key + JSON.stringify(value)).byteLength;
          if (bytes <= 8 * 1024 * 1024) {
            while (this.cacheBytes + bytes > 8 * 1024 * 1024) {
              const oldest = this.cache.keys().next().value;
              this.cacheBytes -= this.cache.get(oldest).bytes;
              this.cache.delete(oldest);
            }
            this.cache.set(key, { value, bytes });
            this.cacheBytes += bytes;
          }
          return value;
        }).finally(() => {
          if (this.pending.get(key) === entry) this.pending.delete(key);
        });
    }
    entry.users++;
    return new Promise((resolve, reject) => {
      const finish = callback => value => {
        signal?.removeEventListener('abort', abort);
        if (settled) return;
        settled = true;
        entry.users--;
        callback(value);
      };
      let settled = false;
      const abort = () => {
        finish(reject)(signal.reason);
        if (entry.users === 0) {
          entry.controller.abort();
          if (this.pending.get(key) === entry) this.pending.delete(key);
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(finish(resolve), finish(reject));
    });
  }

  copy(summary, signal) {
    return this.request(summary, { mode: 'copy' }, signal);
  }

  args(summary, signal) {
    return this.request(summary, { mode: 'args' }, signal);
  }

  attachment(summary, index, signal) {
    return this.request(summary, { mode: 'attachment', attachmentIndex: index }, signal);
  }

  async request(summary, mode, signal) {
    const context = this.contextKey();
    const { sessionFile } = this.getContext();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.requests.add(controller);
    try {
      const response = await fetch('/api/tool-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionFile, toolCallId: summary.toolCallId,
          callRef: summary.callRef ?? null, resultRef: summary.resultRef ?? null,
          liveRef: summary.liveRef ?? null, ...mode }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Tool details HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      let value;
      switch (mode.mode) {
        case 'view': value = await response.json(); break;
        case 'attachment': value = await response.blob(); break;
        case 'copy':
        case 'args': value = await response.text(); break;
        default: throw new Error(`Unknown tool detail mode: ${mode.mode}`);
      }
      controller.signal.throwIfAborted();
      if (context !== this.contextKey()) throw new DOMException('Tool context changed', 'AbortError');
      return value;
    } finally {
      this.requests.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }

  cancelAll() {
    this.generation++;
    for (const controller of this.requests) controller.abort();
    this.pending.clear();
    this.cache.clear();
    this.cacheBytes = 0;
  }
}
