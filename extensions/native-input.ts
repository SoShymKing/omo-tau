import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

type Message = Record<string, unknown>;
function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null;
}
type Pending = {
  readonly resolve: (message: Message) => void;
  readonly reject: (error: Error) => void;
};

/** Sends human input over native RPC; extension sends deliberately suppress host titles. */
export class NativeInput {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly child: ChildProcess) {
    if (!child.stdout || !child.stdin) throw new Error("Native input requires RPC pipes");
    let line = "";
    let discard = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf("\n", offset);
        if (!discard) {
          line += chunk.slice(offset, end < 0 ? undefined : end);
          const type = line.match(/^\s*\{\s*"type"\s*:\s*"([^"]+)"/)?.[1];
          const first = line.trimStart()[0];
          // Native events are already forwarded over Tau IPC. Discard their
          // payloads as soon as their headers arrive, including oversized output.
          if ((first && first !== "{") || (type && type !== "response")) {
            line = "";
            discard = true;
          }
        }
        if (end < 0) break;
        if (line.trim()) this.receive(line);
        line = "";
        discard = false;
        offset = end + 1;
      }
    });
    child.once("close", () => this.fail(new Error("Native input process closed")));
    child.once("error", error => this.fail(error));
  }

  private receive(line: string) {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch (error: unknown) {
      if (error instanceof SyntaxError) return; // Extensions can also log to stdout.
      throw error;
    }
    if (!isMessage(message) || message.type !== "response" || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  private fail(error: Error) {
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }

  send(command: Message): Promise<Message> {
    const input = this.child.stdin;
    if (!input?.writable) return Promise.reject(new Error("Native input is unavailable"));
    const id = randomUUID();
    const nativeCommand: Message = { ...command, id };
    delete nativeCommand.sessionId;
    delete nativeCommand.epoch;
    return new Promise<Message>((resolve, reject) => {
      // Preflight compaction can outlive any fixed admission timeout. Keep the
      // request owned until its native response, write failure, or child close.
      this.pending.set(id, {
        resolve: message => resolve({ ...message, id: command.id }), reject,
      });
      input.write(JSON.stringify(nativeCommand) + "\n", error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }
}
