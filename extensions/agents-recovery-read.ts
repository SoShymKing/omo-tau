import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { directory, missing, samePath, type ReadBudget } from "./agents-location";
import { parseCheckpoint, parseTaskRecord } from "./agents-parsing";
import { MAX_BYTES, type RecordRun, type RecordTask } from "./agents-types";

export type DiskFile = {
  readonly signature: string;
  readonly bytes: number;
  readonly task?: RecordTask;
  readonly run?: RecordRun;
  readonly issues?: readonly string[];
};
type ReadError = { readonly issue: string };
export async function readProjection(target: string, budget: ReadBudget, previous?: DiskFile): Promise<DiskFile | null | ReadError> {
  const taskFile = basename(dirname(target)) === "tasks";
  const limit = taskFile ? 1024 * 1024 : 4 * 1024 * 1024;
  try {
    if (!await directory(dirname(target))) return { issue: "read-error" };
    if (taskFile) {
      try { await fs.lstat(`${target}.expunging`); return null; }
      catch (error) { if (!missing(error)) throw error; }
    }
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await fs.realpath(target), resolve(target))) {
      return { issue: "read-error" };
    }
    const signature = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (previous?.signature === signature) return previous;
    if (stat.size > limit) return { issue: "oversize" };
    if (budget.bytes + limit + 1 > 32 * 1024 * 1024) return { issue: "budget" };
    // Reserve before yielding, so four concurrent readers share one hard raw-byte cap.
    budget.bytes += limit + 1;
    const handle = await fs.open(target, "r");
    let bytesRead = 0;
    const buffer = Buffer.alloc(limit + 1);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        return { issue: "read-error" };
      }
      for (;;) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        bytesRead += chunk.bytesRead;
        if (bytesRead > limit) return { issue: "oversize" };
        if (chunk.bytesRead === 0) break;
      }
    } finally {
      await handle.close();
      budget.bytes -= limit + 1 - bytesRead;
    }
    const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    const task = taskFile ? parseTaskRecord(parsed, basename(target)) : null;
    const run = taskFile ? null : parseCheckpoint(parsed, basename(target));
    if (!task && !run) return { issue: "malformed" };
    const projection = { signature, ...(task ? { task } : {}), ...(run ? { run } : {}) };
    return { ...projection, bytes: Buffer.byteLength(JSON.stringify(projection)) };
  } catch (error) {
    if (missing(error)) return null;
    if (error instanceof SyntaxError) return { issue: "malformed" };
    if (error instanceof Error) return { issue: "read-error" };
    throw error;
  }
}

export async function reconcileFiles(input: {
  readonly paths: readonly string[];
  readonly previous: ReadonlyMap<string, DiskFile>;
  readonly invalidated: ReadonlySet<string>;
  readonly current: () => boolean;
}, budget: ReadBudget) {
  const result = new Map(input.previous);
  let cursor = 0;
  const accepted: { readonly path: string; readonly value: DiskFile | null | ReadError }[] = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < input.paths.length && input.current()) {
      const target = input.paths[cursor++];
      if (!target) break;
      accepted.push({ path: target, value: await readProjection(target, budget,
        input.invalidated.has(target) ? undefined : input.previous.get(target)) });
    }
  }));
  for (const { path, value } of accepted.sort((left, right) => left.path.localeCompare(right.path))) {
    if (value === null) result.delete(path);
    else if ("issue" in value) {
      budget.issues.add(value.issue);
      result.set(path, { ...(result.get(path) ?? { signature: "", bytes: Buffer.byteLength(path) + 64 }), issues: [value.issue] });
    } else result.set(path, value);
  }
  let tasks = 0;
  let runs = 0;
  let bytes = 0;
  for (const [target, file] of result) {
    const nextTasks = tasks + (file.task ? 1 : 0);
    const nextRuns = runs + (file.run ? 1 : 0);
    if (nextTasks > 256 || nextRuns > 256 || bytes + file.bytes > MAX_BYTES) {
      result.delete(target); budget.issues.add("budget");
    } else { tasks = nextTasks; runs = nextRuns; bytes += file.bytes; }
  }
  return result;
}

export function payloadPath(directory: string, name: string) {
  const task = basename(directory) === "tasks";
  const file = task && name.endsWith(".json.expunging") ? name.slice(0, -10) : name;
  return (task ? /^st_[0-9a-f]{8}\.json$/ : /^[a-zA-Z0-9_-]+\.json$/).test(file) ? join(directory, file) : null;
}
