import type { FileHandle } from "node:fs/promises";

export const HISTORY_PAGE_ENTRIES = 80;
export const HISTORY_PAGE_BYTES = 1024 * 1024;
const READ_BLOCK_BYTES = 64 * 1024;

export type HistorySource = {
  readonly fileId: string;
  readonly endByte: number;
};

export type FileHistory = {
  readonly source: HistorySource;
  readonly before: string | null;
  readonly offsets: readonly (number | null)[];
};

type HistoryCursor = {
  readonly source: HistorySource;
  readonly beforeByte: number;
};

export class HistoryCursorError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) {
    super(message);
    this.name = "HistoryCursorError";
  }
}

function encodeCursor(source: HistorySource, beforeByte: number): string | null {
  return beforeByte > 0
    ? Buffer.from(JSON.stringify({ source, beforeByte })).toString("base64url")
    : null;
}

function isCursor(value: unknown): value is HistoryCursor {
  return typeof value === "object" && value !== null &&
    "source" in value && typeof value.source === "object" && value.source !== null &&
    "fileId" in value.source && typeof value.source.fileId === "string" &&
    value.source.fileId.length > 0 && value.source.fileId.length < 128 &&
    "endByte" in value.source && typeof value.source.endByte === "number" &&
    Number.isSafeInteger(value.source.endByte) && value.source.endByte >= 0 &&
    "beforeByte" in value && typeof value.beforeByte === "number" &&
    Number.isSafeInteger(value.beforeByte) && value.beforeByte >= 0 &&
    value.beforeByte <= value.source.endByte;
}

function decodeCursor(encoded: string): HistoryCursor {
  if (encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new HistoryCursorError("Invalid history cursor");
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!isCursor(value)) throw new HistoryCursorError("Invalid history cursor");
    return value;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new HistoryCursorError("Invalid history cursor");
    throw error;
  }
}

async function fileSource(file: FileHandle): Promise<HistorySource> {
  const stat = await file.stat();
  return {
    fileId: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
    endByte: stat.size,
  };
}

// Decode complete records only: a multibyte UTF-8 character can span blocks.
async function* reverseLines(file: FileHandle, endByte: number, signal?: AbortSignal) {
  let position = endByte;
  let parts: Buffer[] = [];
  while (position > 0) {
    signal?.throwIfAborted();
    const size = Math.min(READ_BLOCK_BYTES, position);
    const buffer = Buffer.allocUnsafe(size);
    position -= size;
    const { bytesRead } = await file.read(buffer, 0, size, position);
    if (bytesRead !== size) throw new HistoryCursorError("Session history changed. Reload the session.", 409);
    let end = size;
    for (let index = size - 1; index >= 0; index--) {
      if (buffer[index] !== 10) continue;
      const right = buffer.subarray(index + 1, end);
      if (right.length || parts.length) {
        yield {
          offset: position + index + 1,
          text: Buffer.concat([right, ...parts.reverse()]).toString("utf8"),
        };
      }
      parts = [];
      end = index;
    }
    if (end > 0) parts.push(buffer.subarray(0, end));
  }
  if (parts.length) yield { offset: 0, text: Buffer.concat(parts.reverse()).toString("utf8") };
}

function parseLine(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isHeader(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && "type" in entry && entry.type === "session";
}

export async function readHistoryPage(file: FileHandle, before?: string, signal?: AbortSignal) {
  const current = await fileSource(file);
  const cursor = before === undefined ? null : decodeCursor(before);
  if (cursor && (cursor.source.fileId !== current.fileId || cursor.source.endByte > current.endByte)) {
    throw new HistoryCursorError("Session history changed. Reload the session.", 409);
  }
  const source = cursor?.source ?? current;
  const boundary = cursor?.beforeByte ?? source.endByte;
  if (boundary > 0 && boundary < source.endByte) {
    const byte = Buffer.allocUnsafe(1);
    const { bytesRead } = await file.read(byte, 0, 1, boundary - 1);
    if (bytesRead !== 1 || byte[0] !== 10) throw new HistoryCursorError("Invalid history cursor boundary");
  }
  const records = reverseLines(file, boundary, signal);
  const items: { entry: unknown; offset: number }[] = [];
  let bytes = 0;
  let exhausted = false;
  while (items.length < HISTORY_PAGE_ENTRIES) {
    const next = await records.next();
    if (next.done) { exhausted = true; break; }
    const entry = parseLine(next.value.text);
    if (entry === null || isHeader(entry) || isSourceArchive(entry)) continue;
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (items.length > 0 && bytes + size > HISTORY_PAGE_BYTES) break;
    items.push({ entry, offset: next.value.offset });
    bytes += size;
  }
  await records.return();
  const oldest = items.at(-1)?.offset ?? 0;
  items.reverse();
  return {
    entries: items.map(item => item.entry),
    history: {
      source,
      before: exhausted ? null : encodeCursor(source, oldest),
      offsets: items.map(item => item.offset),
    } satisfies FileHistory,
  };
}

// Memory snapshots include a transient suffix. Only persisted records get offsets.
export async function resolveSnapshotHistory(
  file: FileHandle,
  saved: readonly unknown[],
  selected: readonly unknown[],
  rawBefore: number | null,
): Promise<FileHistory> {
  if (rawBefore !== null && rawBefore > saved.length) {
    throw new HistoryCursorError("Uncommitted history is not available on disk. Retry when it is saved.", 409);
  }
  const source = await fileSource(file);
  const offsets: (number | null)[] = selected.map(() => null);
  const selectedByEntry = new Map<unknown, number[]>();
  selected.forEach((entry, index) => {
    const indexes = selectedByEntry.get(entry) ?? [];
    indexes.push(index);
    selectedByEntry.set(entry, indexes);
  });
  const wanted = new Map<number, number>();
  for (let index = saved.length - 1; index >= 0; index--) {
    const selectedIndex = selectedByEntry.get(saved[index])?.pop();
    if (selectedIndex !== undefined) wanted.set(index, selectedIndex);
  }
  if (wanted.size > 0) {
    const first = Math.min(...wanted.keys());
    let index = saved.length - 1;
    for await (const line of reverseLines(file, source.endByte)) {
      const entry = parseLine(line.text);
      if (entry === null || isHeader(entry)) continue;
      if (JSON.stringify(entry) !== JSON.stringify(saved[index])) {
        throw new HistoryCursorError("Saved history is changing. Retry preparing the session.", 409);
      }
      const selectedIndex = wanted.get(index);
      if (selectedIndex !== undefined) offsets[selectedIndex] = line.offset;
      index--;
      if (index < first) break;
    }
    if (index >= first) throw new HistoryCursorError("Saved history is incomplete. Retry preparing the session.", 409);
  }
  const firstOffset = offsets.find(offset => offset !== null) ?? source.endByte;
  return {
    source,
    before: rawBefore === null ? null : encodeCursor(source, firstOffset),
    offsets,
  };
}

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
