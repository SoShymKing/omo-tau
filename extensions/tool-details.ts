// allow: SIZE_OK - the sealed tool-detail protocol keeps its codec, projection, and verifier together.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { fileSource, type HistorySource } from "./session-history";

export type ObjectValue = Record<string, unknown>;
export const objectValue = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export type ToolStatus = "unknown" | "pending" | "streaming" | "complete" | "error";
export type ToolSummary = {
  readonly toolCallId: string; readonly toolName: string; readonly preview: string;
  readonly status: ToolStatus; readonly revision: number;
  readonly callRef: string | null; readonly resultRef: string | null; readonly liveRef: string | null;
};
export class ToolDetailsError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
    this.name = "ToolDetailsError";
  }
}
export function clipUtf8(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.toString("utf8", 0, end);
}
export function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!objectValue(value)) return "";
  if (Array.isArray(value.content)) return value.content.flatMap(block => {
    if (objectValue(block) && block.type === "text" && typeof block.text === "string") return [block.text];
    if (objectValue(block) && ["image", "file", "resource_link"].includes(String(block.type))) return [];
    return [JSON.stringify(block)];
  }).join("\n");
  return typeof value.text === "string" ? value.text : JSON.stringify(value, null, 2);
}
type RecordSpan = {
  readonly source: HistorySource; readonly start: number; readonly end: number;
  readonly hash: string; readonly mtimeMs: number;
};
export type ToolDescriptor = {
  readonly kind: "call" | "result" | "live" | "summaries";
  readonly file: string; readonly toolCallId: string; readonly epoch: string;
  readonly block: number; readonly span: RecordSpan | null;
};
const internalPrefix = "owner:";
export function ownerRef(descriptor: ToolDescriptor): string {
  return internalPrefix + Buffer.from(JSON.stringify(descriptor)).toString("base64url");
}
function descriptor(value: unknown): ToolDescriptor {
  if (!objectValue(value) || !["call", "result", "live", "summaries"].includes(String(value.kind)) ||
      typeof value.file !== "string" || !path.isAbsolute(value.file) ||
      typeof value.toolCallId !== "string" || typeof value.epoch !== "string" ||
      typeof value.block !== "number" || !Number.isSafeInteger(value.block) || value.block < 0) {
    throw new ToolDetailsError("Malformed tool reference", 400);
  }
  const kind = value.kind;
  if (kind !== "call" && kind !== "result" && kind !== "live" && kind !== "summaries") {
    throw new ToolDetailsError("Malformed tool reference", 400);
  }
  let span: RecordSpan | null = null;
  if (kind === "call" || kind === "result") {
    const item = value.span;
    if (!objectValue(item) || !objectValue(item.source) || typeof item.source.fileId !== "string" ||
        typeof item.source.endByte !== "number" || !Number.isSafeInteger(item.source.endByte) ||
        typeof item.start !== "number" || !Number.isSafeInteger(item.start) || item.start < 0 ||
        typeof item.end !== "number" || !Number.isSafeInteger(item.end) || item.end <= item.start ||
        item.end > item.source.endByte || typeof item.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.hash) || typeof item.mtimeMs !== "number") {
      throw new ToolDetailsError("Malformed tool span", 400);
    }
    span = { source: { fileId: item.source.fileId, endByte: item.source.endByte },
      start: item.start, end: item.end, hash: item.hash, mtimeMs: item.mtimeMs };
  }
  return { kind, file: value.file, toolCallId: value.toolCallId, epoch: value.epoch, block: value.block, span };
}
export async function canonicalSession(file: string, root: string): Promise<string> {
  let resolved: string;
  try { resolved = await realpath(file); }
  catch (error) {
    if (objectValue(error) && error.code === "ENOENT") throw new ToolDetailsError("Session not found", 404);
    throw error;
  }
  const relative = path.relative(await realpath(root), resolved);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative) || path.extname(resolved) !== ".jsonl") {
    throw new ToolDetailsError("Choose a session from the session history", 403);
  }
  return resolved;
}
export async function recordSpan(file: FileHandle, offset: number, observation: {
  readonly source: HistorySource; readonly entry: unknown;
}): Promise<RecordSpan> {
  const source = observation.source;
  const parts: Buffer[] = [];
  let position = offset;
  while (position < source.endByte) {
    const chunk = Buffer.allocUnsafe(Math.min(65536, source.endByte - position));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (bytesRead !== chunk.length) throw new ToolDetailsError("Tool record changed", 409);
    const newline = chunk.indexOf(10);
    const part = newline < 0 ? chunk : chunk.subarray(0, newline);
    parts.push(part);
    position += part.length;
    if (newline >= 0) break;
  }
  const bytes = Buffer.concat(parts);
  if (JSON.stringify(JSON.parse(bytes.toString("utf8"))) !== JSON.stringify(observation.entry)) {
    throw new ToolDetailsError("Tool record changed during projection", 409);
  }
  return { source, start: offset, end: position, hash: createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: (await file.stat()).mtimeMs };
}
export class ToolAuthority {
  private readonly key = randomBytes(32);
  readonly epoch = randomUUID();

  seal(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.seal(item));
    if (!objectValue(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (["callRef", "resultRef", "liveRef", "before"].includes(key) &&
          typeof item === "string" && item.startsWith(internalPrefix)) {
        const payload = descriptor(JSON.parse(Buffer.from(item.slice(internalPrefix.length), "base64url").toString()));
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify({ ...payload, gateway: this.epoch })), cipher.final()]);
        return [key, "td1." + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url")];
      }
      return [key, this.seal(item)];
    }));
  }

  verify(token: unknown): ToolDescriptor {
    if (typeof token !== "string" || token.length > 8192 || !/^td1\.[A-Za-z0-9_-]+$/.test(token)) {
      throw new ToolDetailsError("Malformed tool reference", 400);
    }
    const bytes = Buffer.from(token.slice(4), "base64url");
    if (bytes.length <= 28) throw new ToolDetailsError("Malformed tool reference", 400);
    let payload: unknown;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    } catch (error) {
      if (error instanceof Error) throw new ToolDetailsError("Foreign tool reference", 403);
      throw error;
    }
    if (!objectValue(payload) || payload.gateway !== this.epoch) throw new ToolDetailsError("Stale gateway", 409);
    return descriptor(payload);
  }

  async read(ref: ToolDescriptor, file: string): Promise<ObjectValue> {
    if (ref.file !== file) throw new ToolDetailsError("Reference belongs to another session", 403);
    if (!ref.span) throw new ToolDetailsError("Expected a persisted reference", 400);
    const span = ref.span;
    const handle = await open(file, "r");
    try {
      const source = await fileSource(handle);
      const stat = await handle.stat();
      if (source.fileId !== span.source.fileId || source.endByte < span.source.endByte ||
          (source.endByte === span.source.endByte && stat.mtimeMs !== span.mtimeMs)) {
        throw new ToolDetailsError("Tool file changed", 409);
      }
      const start = Math.max(0, span.start - 1);
      const length = span.end - start + (span.end < source.endByte ? 1 : 0);
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(bytes, 0, length, start);
      const record = bytes.subarray(span.start - start, span.end - start);
      if (bytesRead !== length || (span.start > 0 && bytes[0] !== 10) ||
          (span.end < source.endByte && bytes.at(-1) !== 10) ||
          createHash("sha256").update(record).digest("hex") !== span.hash) {
        throw new ToolDetailsError("Tool record changed", 409);
      }
      const entry: unknown = JSON.parse(record.toString());
      if (!objectValue(entry) || !objectValue(entry.message)) throw new ToolDetailsError("Tool record missing", 404);
      const message = entry.message;
      if (ref.kind === "result" && message.role === "toolResult" && message.toolCallId === ref.toolCallId) return message;
      const block = Array.isArray(message.content) ? message.content[ref.block] : undefined;
      if (ref.kind === "call" && message.role === "assistant" && objectValue(block) &&
          block.type === "toolCall" && block.id === ref.toolCallId) return block;
      throw new ToolDetailsError("Tool record missing", 404);
    } finally { await handle.close(); }
  }
}

export function toolSummary(value: ObjectValue, refs: Partial<ToolSummary> = {}): ToolSummary {
  const status = value.status;
  const args = value.arguments ?? value.args;
  return {
    toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : typeof value.id === "string" ? value.id : "",
    toolName: typeof value.toolName === "string" ? value.toolName : typeof value.name === "string" ? value.name : "",
    preview: clipUtf8(objectValue(args) && Object.keys(args).length ? JSON.stringify(args)
      : outputText(value.output ?? (value.role === "toolResult" ? value : undefined)), 160),
    status: status === "pending" || status === "streaming" || status === "complete" || status === "error"
      ? status : value.role === "toolResult" ? value.isError ? "error" : "complete" : "unknown",
    revision: typeof value.revision === "number" ? value.revision : 0,
    callRef: null, resultRef: null, liveRef: null, ...refs,
  };
}
export type ToolProjector = (value: ObjectValue) => ToolSummary;
// Whitelist body-bearing carriers. Unknown fields in tool deltas never cross the metadata boundary.
export function projectTools(value: unknown, summary: ToolProjector): unknown {
  if (Array.isArray(value)) return value.map(item => projectTools(item, summary));
  if (!objectValue(value)) return value;
  const scope = Object.fromEntries(["sessionId", "epoch", "seq"].filter(key => key in value).map(key => [key, value[key]]));
  if (value.type === "toolCall") return { ...scope, type: "toolCall", id: value.id, name: value.name, tool: summary(value) };
  if (value.role === "toolResult") return {
    ...scope, role: "toolResult", toolCallId: value.toolCallId, toolName: value.toolName, isError: value.isError === true,
    ...(typeof value.timestamp === "number" ? { timestamp: value.timestamp } : {}), tool: summary(value),
  };
  if (value.role === "assistant") return { ...scope, ...Object.fromEntries(
    ["role", "content", "timestamp", "id", "model", "provider", "api", "usage", "stopReason", "errorMessage"]
      .filter(key => key in value).map(key => [key, projectTools(value[key], summary)])) };
  if (typeof value.type === "string" && value.type.startsWith("tool_execution_")) return {
    ...scope, type: value.type, toolCallId: value.toolCallId, toolName: value.toolName,
    tool: summary(value), streamStats: value.streamStats, todoState: value.todoState,
  };
  if (typeof value.type === "string" && value.type.startsWith("toolcall_")) return {
    ...scope, type: value.type, contentIndex: value.contentIndex,
    ...(objectValue(value.partial) ? { partial: projectTools(value.partial, summary) } : {}),
    ...(objectValue(value.toolCall) ? { toolCall: projectTools(value.toolCall, summary) } : {}),
  };
  if (["message_start", "message_update", "message_end", "turn_end", "agent_end"].includes(String(value.type))) {
    return { ...scope, ...Object.fromEntries(["type", "message", "messages", "toolResults", "assistantMessageEvent",
      "streamStats", "todoState", "turnIndex", "timestamp"].filter(key => key in value)
      .map(key => [key, projectTools(value[key], summary)])) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, key === "toolExecutions" && Array.isArray(item)
      ? item.filter(objectValue).map(summary) : projectTools(item, summary),
  ]));
}
export type DetailInput = {
  readonly sessionFile: string; readonly toolCallId: string;
  readonly mode: "view" | "copy" | "args" | "attachment";
  readonly callRef?: string; readonly resultRef?: string; readonly liveRef?: string;
  readonly attachmentIndex?: number;
};
export function parseDetailInput(value: unknown): DetailInput {
  if (!objectValue(value) || typeof value.sessionFile !== "string" || typeof value.toolCallId !== "string" ||
      !value.toolCallId || !["view", "copy", "args", "attachment"].includes(String(value.mode))) {
    throw new ToolDetailsError("Malformed detail request", 400);
  }
  const mode = value.mode;
  if (mode !== "view" && mode !== "copy" && mode !== "args" && mode !== "attachment") {
    throw new ToolDetailsError("Malformed detail mode", 400);
  }
  for (const key of ["callRef", "resultRef", "liveRef"]) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
      throw new ToolDetailsError("Malformed detail reference", 400);
    }
  }
  if (mode === "attachment" && (typeof value.attachmentIndex !== "number" ||
      !Number.isSafeInteger(value.attachmentIndex) || value.attachmentIndex < 0)) {
    throw new ToolDetailsError("Malformed attachment index", 400);
  }
  return { sessionFile: value.sessionFile, toolCallId: value.toolCallId, mode,
    ...(typeof value.callRef === "string" ? { callRef: value.callRef } : {}),
    ...(typeof value.resultRef === "string" ? { resultRef: value.resultRef } : {}),
    ...(typeof value.liveRef === "string" ? { liveRef: value.liveRef } : {}),
    ...(typeof value.attachmentIndex === "number" ? { attachmentIndex: value.attachmentIndex } : {}) };
}
export function detailPayload(input: DetailInput, body: ObjectValue): ObjectValue {
  const args = objectValue(body.args) ? body.args : null;
  const fullArgs = args ? JSON.stringify(args, null, 2) : "";
  const output = outputText(body.output);
  const content = objectValue(body.output) && Array.isArray(body.output.content) ? body.output.content : [];
  const attachments = content.filter(item => objectValue(item) &&
    ["image", "file", "resource_link"].includes(String(item.type)));
  const sourceOf = (item: ObjectValue) => objectValue(item.source) ? item.source : item;
  const dataOf = (item: ObjectValue): string | undefined => {
    const source = sourceOf(item);
    if (typeof source.data === "string") return source.data;
    return typeof source.url === "string" && source.url.startsWith("data:") ? source.url : undefined;
  };
  switch (input.mode) {
    case "copy": return { text: output, contentType: "text/plain; charset=utf-8" };
    case "args": return { text: fullArgs || "null", contentType: "application/json", filename: "arguments.json" };
    case "attachment": {
      const attachment = attachments[input.attachmentIndex ?? -1];
      if (!objectValue(attachment)) throw new ToolDetailsError("Attachment not found", 404);
      const source = sourceOf(attachment);
      const data = dataOf(attachment);
      if (data === undefined) throw new ToolDetailsError("Use the attachment file link", 404);
      return { data: data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data,
        contentType: typeof attachment.mimeType === "string" ? attachment.mimeType
          : typeof source.media_type === "string" ? source.media_type : "application/octet-stream",
        filename: typeof attachment.name === "string" ? path.basename(attachment.name) : "attachment" };
    }
    case "view": {
      const argsText = clipUtf8(fullArgs, 64 * 1024);
      const shown = clipUtf8(output, 192 * 1024);
      return { args: argsText === fullArgs ? args : null, argsText, output: shown,
        isError: body.isError === true, argsTruncated: argsText !== fullArgs, outputTruncated: shown !== output,
        revision: typeof body.revision === "number" ? body.revision : 0,
        attachments: attachments.filter(objectValue).map((item, index) => {
          const source = sourceOf(item);
          return { index,
            mimeType: typeof item.mimeType === "string" ? item.mimeType
              : typeof source.media_type === "string" ? source.media_type : "application/octet-stream",
            name: typeof item.name === "string" ? path.basename(item.name) : "attachment",
            ...(dataOf(item) === undefined ? {
              type: item.type,
              ...Object.fromEntries(["path", "url", "uri", "filename"].filter(key => typeof item[key] === "string")
                .map(key => [key, item[key]])),
              ...(typeof source.url === "string" ? { url: source.url } : {}),
            } : {}) };
        }) };
    }
    default: { const unreachable: never = input.mode; return unreachable; }
  }
}
