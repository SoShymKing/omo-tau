import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { NativeInput } from "../extensions/native-input";

const children: ChildProcess[] = [];
function launch() {
  const child = spawn(process.execPath, [path.join(import.meta.dir, "fixtures/native-input.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return new NativeInput(child);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
    child.stdin?.end();
    await exited;
  }
});

test("native responses retain browser correlation without forwarding Tau routing fields", async () => {
  // Given a real RPC child that also emits oversized native events.
  const input = launch();
  // When concurrent browser commands are admitted through its native stdin.
  const responses = await Promise.all(["prompt", "steer", "follow_up"].map((type, index) =>
    input.send({ type, id: `browser-${index}`, sessionId: "tau-route", epoch: "tau-epoch", message: "한글 request" })));
  // Then each response correlates to its caller and contains native-only input.
  expect(responses.map(response => ({ id: response.id, data: response.data }))).toEqual(
    ["prompt", "steer", "follow_up"].map((type, index) => ({
      id: `browser-${index}`,
      data: { type, id: expect.any(String), message: "한글 request" },
    })),
  );
});

test("native admission failures remain visible to the browser", async () => {
  // Given a real RPC child that refuses this command.
  const input = launch();
  // When native input returns its refusal.
  const response = await input.send({ type: "prompt", id: "refused", message: "reject" });
  // Then success is not forged by the extension bridge.
  expect({ id: response.id, success: response.success }).toEqual({ id: "refused", success: false });
});

test("nested type fields cannot hide a native response whose envelope type comes later", async () => {
  // Given a child whose reply starts with nested data and exits after flushing it.
  const input = launch();
  // When JSON envelope fields arrive in a different valid order.
  const response = await input.send({ type: "prompt", id: "nested", message: "nested-first" });
  // Then the response is admitted before process close, not discarded as an event.
  expect(response).toEqual({
    data: { type: "nested-prompt" }, type: "response", id: "nested", success: true,
  });
});

test("pending admission fails when the native child exits", async () => {
  // Given a real RPC child that exits before replying.
  const input = launch();
  // When admission loses its process, then its promise rejects rather than hanging.
  await expect(input.send({ type: "prompt", message: "exit" })).rejects.toThrow("Native input process closed");
});
