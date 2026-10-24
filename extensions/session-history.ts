export const HISTORY_PAGE_ENTRIES = 80;
export const HISTORY_PAGE_BYTES = 1024 * 1024;

function isSourceArchive(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null &&
    "type" in entry && entry.type === "custom" &&
    "customType" in entry && entry.customType === "opencode.source-message";
}

// Mutable rolling window: raw entry positions stay stable while a file grows.
// One atomic entry can exceed the HTTP byte budget; it is never put into IPC.
export class HistoryWindow {
  private items: { entry: unknown; index: number; bytes: number }[] = [];
  private bytes = 0;
  private dropped = false;
  private nextIndex = 0;

  constructor(private readonly allowOversize = true) {}

  static fromEntries(entries: readonly unknown[], allowOversize = true) {
    const window = new HistoryWindow(allowOversize);
    window.nextIndex = entries.length;
    // A discarded record is an eviction barrier, even if it is oversized.
    // Never encode older payloads or resurrect them to fill the page.
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (isSourceArchive(entry)) continue;
      if (window.items.length === HISTORY_PAGE_ENTRIES) {
        window.dropped = true;
        break;
      }
      const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (window.bytes + bytes > HISTORY_PAGE_BYTES &&
          (window.items.length > 0 || !allowOversize)) {
        window.dropped = true;
        break;
      }
      window.items.push({ entry, index, bytes });
      window.bytes += bytes;
    }
    window.items.reverse();
    return window;
  }

  push(entry: unknown, index: number) {
    this.nextIndex = index + 1;
    if (isSourceArchive(entry)) return;
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    this.items.push({ entry, index, bytes });
    this.bytes += bytes;
    while (this.items.length > HISTORY_PAGE_ENTRIES ||
        (this.bytes > HISTORY_PAGE_BYTES && (this.items.length > 1 || !this.allowOversize))) {
      const removed = this.items.shift();
      if (removed) this.bytes -= removed.bytes;
      this.dropped = true;
    }
  }

  page() {
    return {
      entries: this.items.map(item => item.entry),
      history: {
        before: this.dropped ? (this.items[0]?.index ?? this.nextIndex) : null,
      },
    };
  }
}
