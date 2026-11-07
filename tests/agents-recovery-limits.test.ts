import { afterEach, expect, jest, mock, spyOn, test } from "bun:test";
import * as native from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryEntries, resolveLocation, type ReadBudget } from "../extensions/agents-location";
import { readProjection, reconcileFiles } from "../extensions/agents-recovery-read";
import { recoverAgents } from "../extensions/agents-recovery";
import type { Recovery } from "../extensions/agents-types";

const roots: string[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  mock.restore(); jest.useRealTimers();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const budget = (): ReadBudget => ({ entries: 0, bytes: 0, probes: 0, issues: new Set() });
const row = (id = "st_00000001") => ({ task_id: id, parent_session_id: "R", root_session_id: "R", depth: 1,
  model: "test", status: "running", residency_state: "resident", created_at: "now", updated_at: "now",
  execution_mode: "auto", notification: { run_epoch: 0, notified_epoch: -1 } });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "tau-recovery-limits-"));
  roots.push(root);
  await fs.mkdir(join(root, "tasks"));
  const file = join(root, "tasks", "st_00000001.json");
  await fs.writeFile(file, JSON.stringify(row()));
  return { root, file };
}

test("file size and growth caps omit oversized data without reading unbounded contents", async () => {
  const f = await fixture();
  await fs.writeFile(f.file, "x".repeat(1024 * 1024 + 1));
  expect(await readProjection(f.file, budget())).toEqual({ issue: "oversize" });
  await fs.writeFile(f.file, "{");
  const open = fs.open;
  const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === f.file) await fs.appendFile(f.file, "x".repeat(1024 * 1024 + 1));
    return handle;
  });
  expect(await readProjection(f.file, budget())).toEqual({ issue: "oversize" });
  intercepted.mockRestore();
});

test("task and checkpoint raw-byte reservations share the 32 MiB transaction ceiling", async () => {
  const f = await fixture();
  const limits = budget();
  limits.bytes = 32 * 1024 * 1024 - 16;
  expect(await readProjection(f.file, limits)).toEqual({ issue: "budget" });
  expect(limits.bytes).toBe(32 * 1024 * 1024 - 16);
});

test("directory enumeration stops at 4096 entries and legacy inspection at 256", async () => {
  const f = await fixture();
  const populated = join(f.root, "entries");
  await fs.mkdir(populated);
  for (let start = 0; start < 4097; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 4097 - start) },
      (_, index) => fs.writeFile(join(populated, `${start + index}.tmp`), "")));
  }
  const limits = budget();
  expect(await directoryEntries(populated, limits)).toHaveLength(4096);
  expect(limits.issues.has("budget")).toBe(true);
  const legacy = join(f.root, ".omo", "senpi-task");
  await fs.mkdir(legacy, { recursive: true });
  await Promise.all(Array.from({ length: 257 }, (_, index) => fs.mkdir(join(legacy, `d${index}`))));
  const resolutionBudget = budget();
  const location = await resolveLocation({ projectDir: f.root }, resolutionBudget);
  expect(location.selected).toBeUndefined();
  expect(resolutionBudget.entries).toBeLessThanOrEqual(256);
  expect(resolutionBudget.issues.has("budget")).toBe(true);
});

test("concurrent file handles never exceed four; exact invalidation bypasses unchanged signatures", async () => {
  const f = await fixture();
  const paths: string[] = [];
  for (let index = 1; index <= 12; index++) {
    const id = `st_${index.toString(16).padStart(8, "0")}`;
    const target = join(f.root, "tasks", `${id}.json`);
    paths.push(target);
    await fs.writeFile(target, JSON.stringify(row(id)));
  }
  const open = fs.open;
  let active = 0;
  let maximum = 0;
  const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    active++; maximum = Math.max(maximum, active);
    const close = handle.close.bind(handle);
    handle.close = async () => { await close(); active--; };
    return handle;
  });
  const files = await reconcileFiles({ paths, previous: new Map(), invalidated: new Set(), current: () => true }, budget());
  expect(files.size).toBe(12);
  expect(maximum).toBeLessThanOrEqual(4);
  expect(active).toBe(0);
  intercepted.mockRestore();
  const previous = files.get(f.file);
  if (!previous) throw new Error("Missing cached projection");
  await fs.writeFile(f.file, JSON.stringify({ ...row(), model: "next" }));
  const stat = await fs.stat(f.file);
  const stale = new Map([[f.file, { ...previous, signature: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}` }]]);
  const result = await reconcileFiles({ paths: [f.file], previous: stale, invalidated: new Set([f.file]), current: () => true }, budget());
  expect(result.get(f.file)?.task?.task.model).toBe("next");
});

test("unreadable legacy and symlinked payload directories do not fall through or escape", async () => {
  const f = await fixture();
  const legacy = join(f.root, ".omo", "senpi-task");
  await fs.mkdir(legacy, { recursive: true });
  const opendir = fs.opendir;
  const intercepted = spyOn(fs, "opendir").mockImplementation(async (...args) => {
    if (String(args[0]) === legacy) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return opendir(...args);
  });
  const denied = await resolveLocation({ projectDir: f.root }, budget());
  expect(denied.selected).toBeUndefined();
  expect(denied.issues).toContain("location-unverified");
  intercepted.mockRestore();
  const outside = join(f.root, "outside");
  const store = join(f.root, "store");
  await fs.mkdir(outside); await fs.mkdir(store);
  await fs.writeFile(join(outside, "st_00000001.json"), JSON.stringify(row()));
  await fs.symlink(outside, join(store, "tasks"), "junction");
  expect(await readProjection(join(store, "tasks", "st_00000001.json"), budget())).toEqual({ issue: "read-error" });
});

test("four watcher ceiling and idle clock advancement cause zero scans", async () => {
  const f = await fixture();
  const scans = spyOn(fs, "opendir");
  const watched = spyOn(native, "watch");
  const recovered = new Promise<Recovery>(resolve => stops.push(recoverAgents({ stateDir: f.root }, resolve)));
  expect((await recovered).tasks).toHaveLength(1);
  expect(watched.mock.calls.length).toBeGreaterThan(0);
  expect(watched.mock.calls.length).toBeLessThanOrEqual(4);
  const before = scans.mock.calls.length;
  jest.useFakeTimers();
  jest.advanceTimersByTime(3600000);
  expect(scans.mock.calls).toHaveLength(before);
});

test("retained projection rows and bytes stay bounded and malformed updates retain their issue", async () => {
  const f = await fixture();
  const paths: string[] = [];
  for (let index = 0; index < 257; index++) {
    const id = `st_${index.toString(16).padStart(8, "0")}`;
    const file = join(f.root, "tasks", `${id}.json`);
    await fs.writeFile(file, JSON.stringify(row(id))); paths.push(file);
  }
  const limits = budget();
  const files = await reconcileFiles({ paths, previous: new Map(), invalidated: new Set(), current: () => true }, limits);
  expect([...files.values()].filter(file => file.task)).toHaveLength(256);
  expect(limits.issues.has("budget")).toBe(true);
  await fs.writeFile(f.file, "{");
  const broken = await reconcileFiles({ paths: [f.file], previous: files, invalidated: new Set([f.file]), current: () => true }, budget());
  expect(broken.get(f.file)?.task?.task.task_id).toBe("st_00000001");
  expect(broken.get(f.file)?.issues).toEqual(["malformed"]);
});

test("dirty-name overflow and nameless events collapse into one bounded reconciliation", async () => {
  const f = await fixture();
  const watched = spyOn(native, "watch");
  const scans = spyOn(fs, "opendir");
  let receive: (value: Recovery) => void = () => {};
  const first = new Promise<Recovery>(resolve => { receive = resolve; });
  stops.push(recoverAgents({ stateDir: f.root }, value => receive(value)));
  await first;
  const callback = watched.mock.calls.find(call => String(call[0]) === join(f.root, "tasks"))?.[1];
  if (typeof callback !== "function") throw new Error("Missing task directory watcher");
  const before = scans.mock.calls.length;
  const next = new Promise<Recovery>(resolve => { receive = resolve; });
  const stamp = await fs.stat(f.file);
  jest.useFakeTimers();
  await fs.writeFile(f.file, JSON.stringify({ ...row(), model: "next" }));
  await fs.utimes(f.file, stamp.atime, stamp.mtime);
  for (let index = 0; index < 5000; index++) callback("change", `st_${index.toString(16).padStart(8, "0")}.json`);
  callback("rename", null);
  jest.advanceTimersByTime(100);
  expect((await next).tasks).toMatchObject([{ task: { model: "next" } }]);
  expect(scans.mock.calls.length - before).toBeLessThanOrEqual(2);
  const settled = scans.mock.calls.length;
  jest.advanceTimersByTime(3600000);
  expect(scans.mock.calls).toHaveLength(settled);
});

test("ancestor lookup stops after 32 metadata probes instead of searching arbitrary parents", async () => {
  const f = await fixture();
  const deep = join(f.root, ...Array.from({ length: 48 }, (_, index) => `missing${index}`));
  const watched = spyOn(native, "watch");
  const result = await new Promise<Recovery>(resolve => stops.push(recoverAgents({ stateDir: deep }, resolve)));
  expect(result.issues).toContain("budget");
  expect(result.tasks).toEqual([]);
  expect(watched.mock.calls).toHaveLength(0);
});

test("checkpoint files have a 4 MiB cap and retained projections have an 8 MiB cap", async () => {
  const f = await fixture();
  await fs.mkdir(join(f.root, "dag", "runs"), { recursive: true });
  const checkpoint = join(f.root, "dag", "runs", "dag_00000001.json");
  await fs.writeFile(checkpoint, "x".repeat(4 * 1024 * 1024 + 1));
  expect(await readProjection(checkpoint, budget())).toEqual({ issue: "oversize" });
  const paths: string[] = [];
  for (let index = 0; index < 10; index++) {
    const id = `st_${index.toString(16).padStart(8, "0")}`;
    const file = join(f.root, "tasks", `${id}.json`);
    await fs.writeFile(file, JSON.stringify({ ...row(id), description: "x".repeat(950000) }));
    paths.push(file);
  }
  const limits = budget();
  const files = await reconcileFiles({ paths, previous: new Map(), invalidated: new Set(), current: () => true }, limits);
  expect(files.size).toBe(8);
  expect([...files.values()].reduce((bytes, file) => bytes + file.bytes, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(limits.issues.has("budget")).toBe(true);
});
