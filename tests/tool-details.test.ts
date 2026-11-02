import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFile, mkdtemp, open, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readConversationPage } from "../extensions/conversation-history";
import { canonicalSession, clipUtf8, detailPayload, objectValue, parseDetailInput, projectTools,
  ToolAuthority, toolSummary, type ObjectValue, type ToolDescriptor } from "../extensions/tool-details";

describe("tool details", () => {
  let root: string;
  let filename: string;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let authority: ToolAuthority;
  let callRef: string;
  let resultRef: string;
  let original: string;
  const call = { type: "message", message: { role: "assistant", content: [
    { type: "toolCall", id: "edit", name: "edit", arguments: { path: "synthetic.txt", oldText: "before", newText: "after" } },
  ] } };
  const result = { type: "message", message: { role: "toolResult", toolCallId: "edit",
    content: [{ type: "text", text: "full output" }], isError: false } };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "tau-details-test-"));
    filename = path.join(root, "history.jsonl");
    original = [{ type: "session" }, call, result].map(item => JSON.stringify(item)).join("\n") + "\n";
    await writeFile(filename, original);
    file = await open(filename, "r");
    authority = new ToolAuthority();
    const page = authority.seal(await readConversationPage(file, { filePath: filename }));
    if (!objectValue(page) || !Array.isArray(page.entries)) throw new Error("Missing entries");
    const entry = page.entries[1];
    if (!objectValue(entry) || !objectValue(entry.message) || !objectValue(entry.message.tool)) throw new Error("Missing tool");
    const tool = entry.message.tool;
    if (typeof tool.callRef !== "string" || typeof tool.resultRef !== "string") throw new Error("Missing refs");
    callRef = tool.callRef;
    resultRef = tool.resultRef;
  });
  afterEach(async () => {
    await file?.close();
    file = undefined;
    await rm(root, { recursive: true, force: true });
  });

  test("reads only issued spans plus record boundaries for explicit details", async () => {
    // Given refs issued from a canonical file.
    const descriptor = authority.verify(callRef);
    const prototype = Object.getPrototypeOf(file);
    const reads = spyOn(prototype, "read");
    try {
      // When resolving the call on demand.
      const body = await authority.read(descriptor, filename);
      // Then the read is positioned at the span boundary, not a history scan.
      expect(body).toEqual(call.message.content[0]);
      expect(reads.mock.calls).toHaveLength(1);
      expect(reads.mock.calls[0]?.[3]).toBe(Math.max(0, (descriptor.span?.start ?? 0) - 1));
      expect(reads.mock.calls[0]?.[2]).toBe((descriptor.span?.end ?? 0) - (descriptor.span?.start ?? 0) + 2);
    } finally { reads.mockRestore(); }
  });

  test("accepts an append after the captured file extent", async () => {
    // Given existing issued spans.
    await appendFile(filename, JSON.stringify({ type: "message", message: { role: "user", content: "later" } }) + "\n");
    // When reading a result after append.
    const body = await authority.read(authority.verify(resultRef), filename);
    // Then the original body is still accessible.
    expect(body).toEqual(result.message);
  });

  test.each(["replace", "shrink", "same-length"])("rejects %s changes as stale", async change => {
    // Given a reference whose source changes after issuance.
    if (change === "replace") {
      await rename(filename, filename + ".old");
      await writeFile(filename, original);
    } else if (change === "shrink") await writeFile(filename, "{}\n");
    else {
      await writeFile(filename, original.replace("full output", "evil output"));
      await utimes(filename, new Date(1000), new Date(2000));
    }
    // When reading the old result.
    const read = authority.read(authority.verify(resultRef), filename);
    // Then stale history is explicit.
    await expect(read).rejects.toMatchObject({ status: 409 });
  });

  test("rejects same-span mutation even when the file later grows", async () => {
    // Given a changed record followed by a new append.
    await writeFile(filename, original.replace("full output", "evil output") + '{"type":"later"}\n');
    // When the original result is requested.
    const read = authority.read(authority.verify(resultRef), filename);
    // Then its hash, not just length, rejects the mutation.
    await expect(read).rejects.toMatchObject({ status: 409 });
  });

  test("rejects malformed and foreign tokens before opening files", () => {
    // Given a ref from a different gateway and malformed input.
    const foreign = new ToolAuthority();
    // When verifying without file access, then statuses distinguish syntax from authentication.
    expect(() => authority.verify("not-a-token")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => foreign.verify(callRef)).toThrow(expect.objectContaining({ status: 403 }));
  });

  test("rejects references bound to a different canonical file", async () => {
    // Given a valid token and another in-root file.
    const other = path.join(root, "other.jsonl");
    await writeFile(other, original);
    // When applying the token to that file.
    const read = authority.read(authority.verify(callRef), other);
    // Then the mismatch is forbidden.
    await expect(read).rejects.toMatchObject({ status: 403 });
  });

  test("rejects wrong tool/block identities within a valid span", async () => {
    // Given a trusted descriptor with the wrong block identity.
    const issued = authority.verify(callRef);
    const wrong: ToolDescriptor = { ...issued, toolCallId: "another" };
    // When resolving the descriptor against its record.
    const read = authority.read(wrong, filename);
    // Then it cannot return another tool body.
    await expect(read).rejects.toMatchObject({ status: 404 });
  });

  test("enforces canonical root containment", async () => {
    // Given an existing file outside the allowed sessions subdirectory.
    const outside = filename;
    const insideRoot = path.join(root, "empty.jsonl");
    await writeFile(insideRoot, "");
    // When its root does not contain the file.
    const resolved = canonicalSession(outside, insideRoot);
    // Then containment is forbidden.
    await expect(resolved).rejects.toMatchObject({ status: 403 });
  });
});

describe("metadata projection and explicit body modes", () => {
  const huge = "한".repeat(100000) + "BODY_SENTINEL";
  const toolCall = { type: "toolCall", id: "tool", name: "edit", arguments: { diff: huge } };
  const assistant = { role: "assistant", content: [toolCall] };
  const result = { role: "toolResult", toolCallId: "tool", content: [{ type: "text", text: huge }],
    details: { diff: huge }, isError: false };

  test("preserves file links, remote images and structured text without inline bodies", () => {
    const body = { output: { content: [
      { type: "file", path: "generated.txt", name: "Generated file" },
      { type: "image", source: { url: "https://example.com/generated.png" } },
      { type: "image", source: { data: "aW1hZ2U=", media_type: "image/png" } },
      { type: "resource", value: { count: 3 } },
    ] } };
    const input = { sessionFile: "/synthetic.jsonl", toolCallId: "tool", mode: "view" } as const;
    const view = detailPayload(input, body);
    expect(view.output).toBe('{"type":"resource","value":{"count":3}}');
    expect(view.attachments).toMatchObject([
      { index: 0, type: "file", path: "generated.txt" },
      { index: 1, type: "image", url: "https://example.com/generated.png" },
      { index: 2, mimeType: "image/png" },
    ]);
    expect(JSON.stringify(view)).not.toContain("aW1hZ2U=");
    expect(detailPayload({ ...input, mode: "attachment", attachmentIndex: 2 }, body).data).toBe("aW1hZ2U=");
  });

  test.each([
    { type: "tool_execution_start", toolCallId: "tool", args: { diff: huge } },
    { type: "tool_execution_update", toolCallId: "tool", partialResult: result },
    { type: "tool_execution_end", toolCallId: "tool", result },
    { type: "message_start", message: assistant },
    { type: "message_update", message: assistant, assistantMessageEvent: {
      type: "toolcall_delta", delta: huge, partial: assistant,
    } },
    { type: "message_end", message: result },
    { type: "turn_end", message: assistant, toolResults: [result] },
    { type: "agent_end", messages: [assistant, result] },
    { streamingMessage: assistant, toolExecutions: [{ toolCallId: "tool", args: { diff: huge }, output: result }] },
  ])("removes tool bodies from carrier %#", carrier => {
    // Given any supported carrier with a body too large for metadata.
    // When projecting before IPC serialization.
    const projected = projectTools({ sessionId: "session", epoch: "epoch", seq: 4, ...carrier }, toolSummary);
    // Then outer identity survives while all nested tool bodies disappear.
    expect(projected).toMatchObject({ sessionId: "session", epoch: "epoch", seq: 4 });
    expect(JSON.stringify(projected)).not.toContain("BODY_SENTINEL");
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(4000);
  });

  test("caps UTF-8 previews without replacement characters", () => {
    // Given multibyte text crossing a byte boundary.
    // When clipping preview text.
    const preview = clipUtf8("한😀".repeat(100), 160);
    // Then output is valid UTF-8 and inside the exact byte budget.
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(160);
    expect(preview).not.toContain("\ufffd");
  });

  test("bounds view args and output but leaves copy and args downloads complete", () => {
    // Given large args/output and an explicit image attachment.
    const body = { args: { diff: huge }, output: { content: [
      { type: "text", text: huge }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    ] }, revision: 7, isError: true };
    const input = { sessionFile: "/synthetic.jsonl", toolCallId: "tool", mode: "view" } as const;
    // When preparing each explicitly requested representation.
    const view = detailPayload(input, body);
    const copy = detailPayload({ ...input, mode: "copy" }, body);
    const args = detailPayload({ ...input, mode: "args" }, body);
    const image = detailPayload({ ...input, mode: "attachment", attachmentIndex: 0 }, body);
    // Then view has no complete huge args or base64; explicit downloads do.
    expect(view).toMatchObject({ args: null, argsTruncated: true, outputTruncated: true, revision: 7, isError: true });
    expect(Buffer.byteLength(String(view.argsText))).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(String(view.output))).toBeLessThanOrEqual(192 * 1024);
    expect(JSON.stringify(view)).not.toContain("aW1hZ2U=");
    expect(view.attachments).toEqual([{ index: 0, mimeType: "image/png", name: "attachment" }]);
    expect(copy.text).toBe(huge);
    expect(JSON.parse(String(args.text))).toEqual(body.args);
    expect(image.data).toBe("aW1hZ2U=");
  });

  test("rejects malformed detail modes and attachment indices", () => {
    // Given untrusted HTTP request fields.
    const request: ObjectValue = { sessionFile: "/synthetic.jsonl", toolCallId: "tool", mode: "attachment", attachmentIndex: -1 };
    // When parsing, then invalid fields cannot enter the detail resolver.
    expect(() => parseDetailInput(request)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
