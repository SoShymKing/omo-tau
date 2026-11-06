import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { conversationSnapshot, readConversationPage } from "../extensions/conversation-history";
import { HISTORY_PAGE_BYTES, readHistoryPage } from "../extensions/session-history";
import { objectValue } from "../extensions/tool-details";

describe("conversation history", () => {
  let root: string;
  let filename: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
  const reply = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
  async function save(entries: readonly unknown[]) {
    await writeFile(filename, [{ type: "session" }, ...entries].map(item => JSON.stringify(item)).join("\n") + "\n");
    handle = await open(filename, "r");
    return handle;
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "tau-conversation-test-"));
    filename = path.join(root, "history.jsonl");
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await rm(root, { recursive: true, force: true });
  });

  test.each(["count", "bytes"])("retains only the initiating instruction across a long %s set", async boundary => {
    // Given a user set longer than either raw page budget.
    const instruction = user("initiating instruction");
    const entries = [instruction, ...Array.from({ length: 180 }, (_, index) =>
      reply(boundary === "bytes" ? `${index}-` + "x".repeat(20000) : String(index)))];
    const file = await save(entries);
    // When reading its latest raw page and the preceding page.
    const latest = await readConversationPage(file, { filePath: filename });
    const older = await readConversationPage(file, { filePath: filename, before: latest.history.before ?? undefined });
    // Then the header is a sidecar with the same key, never a synthetic entry.
    expect(latest.entries.length).toBeLessThanOrEqual(80);
    expect(latest.entries).not.toContainEqual(instruction);
    const setKey = latest.conversation.sets[0]?.key;
    const instructionKey = latest.conversation.sets[0]?.instruction?.entryKey;
    if (setKey === undefined || instructionKey === undefined) throw new Error("Missing initiating instruction key");
    expect(latest.conversation.sets).toEqual([{
      key: instructionKey,
      instruction: { entry: instruction, entryKey: setKey,
        offset: Buffer.byteLength(JSON.stringify({ type: "session" }) + "\n") }, partialBefore: true,
    }]);
    expect(older.conversation.sets[0]?.key).toBe(latest.conversation.sets[0]?.key);
    expect(new Set(latest.conversation.entrySetKeys).size).toBe(1);
    expect(latest.history.offsets).toEqual((await readHistoryPage(file)).history.offsets);
  });

  test("keeps identical ID-less instructions distinct by their raw offsets", async () => {
    // Given repeated references and repeated serialized records.
    const instruction = user("same");
    const entries = [instruction, reply("one"), instruction, reply("two")];
    const file = await save(entries);
    // When selecting a snapshot using the actual saved objects.
    const page = await conversationSnapshot({ file, filePath: filename, saved: entries, captured: entries,
      epoch: "owner", liveTools: new Map(), transientKey: (_, ordinal) => `owner:${ordinal}` });
    // Then distinct persisted instructions create distinct sets and authoritative keys.
    expect(page.conversation.sets.length).toBe(2);
    expect(new Set(page.conversation.entryKeys).size).toBe(4);
    expect(page.conversation.entryKeys).toEqual(page.history.offsets.map(offset => `${page.history.source.fileId}:${offset}`));
  });

  test("runtime metadata projects saved conversation", async () => {
    const call = { type: "message", id: "call", message: { role: "assistant", content: [
      { type: "toolCall", id: "edit", name: "edit",
        arguments: { runtimeItemKey: "argument", callUnknown: true } },
    ] } };
    const result = { type: "message", id: "result", message: { role: "toolResult", toolCallId: "edit",
      runtimeItemKey: "payload", callUnknown: false,
      content: [{ type: "text", text: "done", runtimeItemKey: "body" }],
      details: { runtimeItemKey: "details", callUnknown: true } } };
    const saved = [user("edit"), call, result];
    const original = JSON.stringify(saved);
    const decorated = [saved[0], { ...call, message: { ...call.message,
      content: call.message.content.map(part => ({ ...part, runtimeItemKey: "runtime-call" })) } },
      { ...result, runtimeItemKey: "runtime-result", callUnknown: true }];
    const disk = decorated.map(entry => JSON.stringify(entry));
    const file = await save(decorated);

    const page = await conversationSnapshot({ file, filePath: filename, saved, captured: saved,
      epoch: "owner", liveTools: new Map(), transientKey: (_, ordinal) => `owner:${ordinal}` });

    const start = Buffer.byteLength(JSON.stringify({ type: "session" }) + "\n");
    const offsets = [start, start + Buffer.byteLength(disk[0] + "\n"),
      start + Buffer.byteLength(disk.slice(0, 2).join("\n") + "\n")];
    expect(page.history.offsets).toEqual(offsets);
    expect(page.conversation.entryKeys).toEqual(offsets.map(offset => `${page.history.source.fileId}:${offset}`));
    const projected = page.entries[2];
    if (!objectValue(projected) || !objectValue(projected.message) || !objectValue(projected.message.tool)) {
      throw new Error("Missing projected result");
    }
    expect(projected.message.tool.callRef).toEqual(expect.any(String));
    expect(projected.message.tool.resultRef).toEqual(expect.any(String));
    expect(JSON.stringify(saved)).toBe(original);
    expect(call.message.content[0]?.arguments).toEqual({ runtimeItemKey: "argument", callUnknown: true });
    expect(result.message.details).toEqual({ runtimeItemKey: "details", callUnknown: true });
  });

  test("finds the initiating instruction outside a transient-only selected suffix", async () => {
    // Given saved history and a full memory-only turn exceeding 80 records.
    const saved = [user("saved"), reply("saved reply")];
    const transient = [user("memory instruction"), ...Array.from({ length: 100 }, (_, index) => reply(String(index)))];
    const file = await save(saved);
    // When selecting only the latest transient suffix.
    const page = await conversationSnapshot({ file, filePath: filename, saved, captured: [...saved, ...transient],
      epoch: "owner", liveTools: new Map(), transientKey: (_, ordinal) => `owner:${ordinal}` });
    // Then its header uses the earlier memory instruction and persisted continuation remains EOF.
    expect(page.conversation.sets[0]?.instruction).toEqual({ entry: transient[0], entryKey: "owner:2", offset: null });
    expect(page.history.offsets).toEqual(Array(80).fill(null));
    expect((await readHistoryPage(file, page.history.before ?? undefined)).entries).toEqual(saved);
  });

  test("projects huge result and edit arguments without changing raw continuation", async () => {
    // Given a result and edit call each larger than the raw byte budget.
    const big = "x".repeat(HISTORY_PAGE_BYTES + 20) + "BODY_SENTINEL";
    const entries = [user("edit"), { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "edit", name: "edit", arguments: { oldText: big, newText: big } },
    ] } }, { type: "message", message: { role: "toolResult", toolCallId: "edit",
      content: [{ type: "text", text: big }], details: { diff: big }, isError: true } }];
    const file = await save(entries);
    // When traversing the raw pages with projection.
    const result = await readConversationPage(file, { filePath: filename });
    const call = await readConversationPage(file, { filePath: filename, before: result.history.before ?? undefined });
    // Then each body becomes only a summary, including result-only and call-only pages.
    expect(JSON.stringify([result, call])).not.toContain("BODY_SENTINEL");
    expect(Buffer.byteLength(JSON.stringify([result, call]))).toBeLessThan(10000);
    const resultEntry = result.entries[0];
    const callEntry = call.entries[0];
    expect(resultEntry).toMatchObject({ message: { role: "toolResult", tool: { toolCallId: "edit", status: "error" } } });
    expect(callEntry).toMatchObject({ message: { content: [{ tool: { toolCallId: "edit", status: "unknown" } }] } });
    if (!objectValue(resultEntry) || !objectValue(resultEntry.message)) throw new Error("Missing result");
    expect(resultEntry.message).not.toHaveProperty("content");
    expect(resultEntry.message).not.toHaveProperty("details");
    expect(result.conversation.sets[0]?.key).toBe(call.conversation.sets[0]?.key);
  });

  test("represents an instruction-less set explicitly", async () => {
    // Given history containing no user message.
    const file = await save([reply("orphan")]);
    // When projecting its only page.
    const page = await readConversationPage(file, { filePath: filename });
    // Then the set exists with a null instruction.
    expect(page.conversation.sets).toEqual([{
      key: `${page.history.source.fileId}:instructionless`, instruction: null, partialBefore: false,
    }]);
  });
});
