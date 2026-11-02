import type { FileHandle } from "node:fs/promises";
import { HistoryWindow, parseLine, readHistoryPage, resolveSnapshotHistory, reverseLines,
  type FileHistory } from "./session-history";
import { objectValue, ownerRef, projectTools, recordSpan, toolSummary,
  type ObjectValue, type ToolSummary } from "./tool-details";

export const CONVERSATION_VIEW = "conversation-v1";
type Instruction = { readonly entry: unknown; readonly entryKey: string; readonly offset: number | null };
type ConversationSet = { readonly key: string; readonly instruction: Instruction | null; readonly partialBefore: boolean };
type ConversationInput = {
  readonly file: FileHandle; readonly filePath: string;
  readonly entries: readonly unknown[]; readonly history: FileHistory;
  readonly epoch?: string; readonly captured?: readonly unknown[]; readonly saved?: readonly unknown[];
  readonly indices?: readonly number[]; readonly liveTools?: ReadonlyMap<string, ObjectValue>;
  readonly transientKey?: (entry: unknown, ordinal: number) => string;
};
function isInstruction(entry: unknown): boolean {
  return objectValue(entry) && objectValue(entry.message) && entry.message.role === "user";
}
function blocks(entry: unknown): readonly ObjectValue[] {
  if (!objectValue(entry) || !objectValue(entry.message)) return [];
  const message = entry.message;
  if (message.role === "toolResult") return [message];
  return message.role === "assistant" && Array.isArray(message.content)
    ? message.content.filter(item => objectValue(item) && item.type === "toolCall") : [];
}
export async function conversationPage(input: ConversationInput) {
  const { file, entries, history } = input;
  const keyAt = (offset: number | null, ordinal: number, entry: unknown) => offset === null
    ? input.transientKey?.(entry, ordinal) ?? `${input.epoch ?? "memory"}:${ordinal}`
    : `${history.source.fileId}:${offset}`;
  const entryKeys = entries.map((entry, index) =>
    keyAt(history.offsets[index] ?? null, input.indices?.[index] ?? index, entry));
  let leading: Instruction | null = null;
  if (!isInstruction(entries[0])) {
    if (input.captured && input.indices && input.saved) {
      const first = input.indices[0] ?? input.captured.length;
      for (let index = first - 1; index >= 0; index--) {
        const entry = input.captured[index];
        if (!isInstruction(entry)) continue;
        const positioned = await resolveSnapshotHistory(file, input.saved, [entry], null, [index]);
        const offset = positioned.offsets[0] ?? null;
        leading = { entry, entryKey: keyAt(offset, index, entry), offset };
        break;
      }
    } else {
      // Discovery may scan the whole prefix without an index. Only the instruction is retained.
      const before = history.offsets[0] ?? history.source.endByte;
      for await (const line of reverseLines(file, before)) {
        const entry = parseLine(line.text);
        if (!isInstruction(entry)) continue;
        leading = { entry, entryKey: keyAt(line.offset, 0, entry), offset: line.offset };
        break;
      }
    }
  }
  const sets: ConversationSet[] = [];
  const entrySetKeys: string[] = [];
  let current: ConversationSet | undefined;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const entryKey = entryKeys[index];
    if (entryKey === undefined) continue;
    if (isInstruction(entry)) {
      current = { key: entryKey, instruction: { entry, entryKey, offset: history.offsets[index] ?? null }, partialBefore: false };
      sets.push(current);
    } else if (!current) {
      current = { key: leading?.entryKey ?? `${history.source.fileId}:instructionless`,
        instruction: leading, partialBefore: leading !== null || history.before !== null };
      sets.push(current);
    }
    entrySetKeys.push(current.key);
  }
  if (!entries.length && leading) sets.push({ key: leading.entryKey, instruction: leading, partialBefore: true });
  const summaries = new Map<string, ToolSummary>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const tools = blocks(entry);
    if (!tools.length) continue;
    const offset = history.offsets[index] ?? null;
    const span = offset === null ? null : await recordSpan(file, offset, { source: history.source, entry });
    for (const tool of tools) {
      const summary = toolSummary(tool);
      const existing = summaries.get(summary.toolCallId);
      const live = input.liveTools?.get(summary.toolCallId);
      const block = objectValue(entry) && objectValue(entry.message) && Array.isArray(entry.message.content)
        ? entry.message.content.indexOf(tool) : 0;
      const ref = ownerRef({ kind: span ? tool.role === "toolResult" ? "result" : "call" : "live",
        file: input.filePath, epoch: input.epoch ?? "", toolCallId: summary.toolCallId, block: Math.max(0, block), span });
      const merged = { ...existing, ...summary,
        toolName: summary.toolName || existing?.toolName || "",
        callRef: tool.type === "toolCall" && span ? ref : existing?.callRef ?? null,
        resultRef: tool.role === "toolResult" && span ? ref : existing?.resultRef ?? null,
        liveRef: span ? existing?.liveRef ?? null : ref };
      summaries.set(summary.toolCallId, live ? { ...merged, ...toolSummary(live),
        callRef: merged.callRef, resultRef: merged.resultRef,
        liveRef: ownerRef({ kind: "live", file: input.filePath, epoch: input.epoch ?? "",
          toolCallId: summary.toolCallId, block: 0, span: null }) } : merged);
    }
  }
  const projected = entries.map(entry => projectTools(entry, value => {
    const id = toolSummary(value).toolCallId;
    return summaries.get(id) ?? toolSummary(value);
  }));
  return { view: CONVERSATION_VIEW, entries: projected, history, conversation: { entryKeys, entrySetKeys, sets } };
}

export async function readConversationPage(file: FileHandle, options: {
  readonly filePath: string; readonly before?: string; readonly signal?: AbortSignal;
}) {
  const page = await readHistoryPage(file, options.before, options.signal);
  return conversationPage({ file, filePath: options.filePath, ...page });
}

// Selection and offset resolution happen against the original records, before any cloning.
export async function conversationSnapshot(input: {
  readonly file: FileHandle; readonly filePath: string; readonly saved: readonly unknown[];
  readonly captured: readonly unknown[]; readonly epoch: string;
  readonly liveTools: ReadonlyMap<string, ObjectValue>;
  readonly transientKey: (entry: unknown, ordinal: number) => string;
}) {
  const window = HistoryWindow.fromEntries(input.captured);
  const raw = window.page();
  const history = await resolveSnapshotHistory(input.file, input.saved, raw.entries, raw.history.before, window.indices());
  return conversationPage({ ...input, entries: raw.entries, history, indices: window.indices() });
}
