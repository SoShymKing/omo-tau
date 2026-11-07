import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { observeAgents } from "../extensions/agents-state";
import type { AgentsSnapshot } from "../extensions/agents-types";

const roots: string[] = [];
const observers: ReturnType<typeof observeAgents>[] = [];
const waits = new Set<ReturnType<typeof setTimeout>>();
const environment = { ...process.env };
afterEach(async () => {
  for (const observer of observers.splice(0)) observer.shutdown();
  for (const timer of waits) clearTimeout(timer);
  waits.clear();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  for (const name of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "HOME", "USERPROFILE"]) {
    if (environment[name] === undefined) delete process.env[name]; else process.env[name] = environment[name];
  }
});
const task = (id = "st_00000001", parent = "R") => ({ task_id: id, parent_session_id: parent, root_session_id: "R",
  model: "disk", status: "running", residency_state: "persisted_only", depth: 1, execution_mode: "auto",
  created_at: "2026-11-07", updated_at: "2026-11-07", notification: { run_epoch: 1, notified_epoch: -1 } });
const checkpoint = { schemaVersion: 1, runId: "dag_00000001", runKey: "key", name: "Disk run",
  parentSessionId: "R", rootSessionId: "R", status: "running", createdAt: "now", updatedAt: "later",
  nodes: [{ id: "one", prompt: "read", state: "running", paused: true, dependsOn: [], attempt: 1,
    createdAt: "now", taskId: "st_00000001", error: { code: "failed", message: "failure" } }],
  edges: [], waves: [{ index: 0, nodeIds: ["one"] }], amendHistory: [{}] };
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "tau-recovery-"));
  roots.push(root);
  const project = join(root, "project");
  await fs.mkdir(project);
  const canonical = await fs.realpath(project);
  const key = `${basename(canonical)}-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
  for (const name of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) delete process.env[name];
  process.env.HOME = root; process.env.USERPROFILE = root;
  return { root, project, legacy: join(project, ".omo", "senpi-task"),
    standard: join(root, ".omo", "agent", "projects", key, "senpi-task"), key };
}
async function seed(store: string, value: unknown = task(), name = "st_00000001.json") {
  await fs.mkdir(join(store, "tasks"), { recursive: true });
  await fs.writeFile(join(store, "tasks", name), JSON.stringify(value));
}
function observe(project: string, stateDir?: string) {
  let owner = { sessionId: "R", file: "R.jsonl", epoch: "one" };
  let emit: (value: unknown) => void = () => {};
  const subscribers = new Set<(value: AgentsSnapshot) => void>();
  const observer = observeAgents({ on(_name, listener) { emit = listener; return () => {}; } }, () => owner,
    value => { for (const subscriber of subscribers) subscriber(value); }, stateDir === undefined ? {} : { stateDir });
  observers.push(observer);
  observer.bind(owner, project);
  return { observer,
    switch(sessionId: string) { owner = { sessionId, file: `${sessionId}.jsonl`, epoch: "one" }; observer.bind(owner, project); },
    live(rows: readonly unknown[]) { emit({ name: "omo.task.updated", data: { parent_session_id: owner.sessionId, tasks: rows } }); },
    wait(predicate: (value: AgentsSnapshot) => boolean) {
      if (predicate(observer.snapshot())) return Promise.resolve(observer.snapshot());
      return new Promise<AgentsSnapshot>((resolve, reject) => {
        const timer = setTimeout(() => {
          waits.delete(timer); subscribers.delete(receive); reject(new Error("Recovery state not observed"));
        }, 10000);
        waits.add(timer);
        const receive = (value: AgentsSnapshot) => {
          if (!predicate(value)) return;
          clearTimeout(timer); waits.delete(timer); subscribers.delete(receive); resolve(value);
        };
        subscribers.add(receive);
      });
    } };
}
const cached = (state: AgentsSnapshot) => state.agentsState.availability === "cached";

test.each(["absent", "empty", "populated", "marker"] as const)("read-only default and legacy resolution: %s", async mode => {
  const f = await fixture();
  await seed(f.standard, { ...task(), model: "default" });
  if (mode === "empty") await fs.mkdir(join(f.legacy, "tasks", "empty"), { recursive: true });
  if (mode === "populated") await seed(f.legacy, { ...task(), model: "legacy" });
  if (mode === "marker") {
    await fs.mkdir(f.legacy, { recursive: true });
    await fs.writeFile(join(f.legacy, ".in-project"), "");
  }
  const h = observe(f.project);
  const result = await h.wait(state => mode === "marker" ? !!state.agentsState.coverage : cached(state));
  if (mode === "marker") expect(result.agentsState.availability).toBe("unknown");
  else expect(result.agentsState).toMatchObject({ availability: "cached", tasks: [
    { model: mode === "populated" ? "legacy" : "default", tau_ancestry: { relation: "direct", evidence: "record" } },
  ], coverage: { incomplete: true, issues: ["location-unverified"] } });
  if (mode !== "marker") expect(await fs.stat(join(f.legacy, ".in-project")).catch(error => error.code)).toBe("ENOENT");
});

test("explicit override projects paused records and stale camelCase checkpoints without becoming ready", async () => {
  const f = await fixture();
  const store = join(f.root, "override");
  await seed(store, { ...task(), paused: true });
  await fs.mkdir(join(store, "dag", "runs"), { recursive: true });
  await fs.writeFile(join(store, "dag", "runs", "dag_00000001.json"), JSON.stringify(checkpoint));
  const h = observe(f.project, store);
  const result = await h.wait(cached);
  expect(result.agentsState).toMatchObject({ availability: "cached", tasks: [{ status: "paused" }] });
  expect(result.dagState).toMatchObject({ availability: "cached", coverage: { issues: ["checkpoint-stale"] }, runs: [{
    tau_owner_session_id: "R", amend_count: 1, counts: { total: 1, paused: 1, running: 0 },
    nodes: [{ state: "paused", last_error: { code: "failed", message: "failure" } }],
  }] });
  h.live([]);
  expect(h.observer.snapshot().agentsState).toMatchObject({ availability: "ready", tasks: [] });
});

test.each(["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"])("agent directory precedence: %s", async selected => {
  const f = await fixture();
  const names = ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"];
  const index = names.indexOf(selected);
  for (const name of names.slice(index)) process.env[name] = join(f.root, name);
  await seed(join(f.root, selected, "projects", f.key, "senpi-task"));
  const result = await observe(f.project).wait(cached);
  expect(result.agentsState).toMatchObject({ tasks: [{ task_id: "st_00000001" }] });
});

test("invalid override and ambiguous legacy never silently use the default store", async () => {
  const f = await fixture();
  await seed(f.standard);
  const relative = await observe(f.project, "relative").wait(state => !!state.agentsState.coverage);
  expect(relative.agentsState).toMatchObject({ availability: "unknown", coverage: { issues: ["location-unverified"] } });
  await fs.mkdir(join(f.legacy, "scaffolding"), { recursive: true });
  for (let index = 0; index < 257; index++) await fs.mkdir(join(f.legacy, "scaffolding", `folder${index}`));
  const exhausted = await observe(f.project).wait(state => !!state.agentsState.coverage);
  expect(exhausted.agentsState).toMatchObject({ availability: "unknown" });
  expect(exhausted.agentsState.coverage?.issues).toContain("budget");
});

test("watchers recover creation, atomic rename, tombstone and deletion; malformed files retain last good rows", async () => {
  const f = await fixture();
  const h = observe(f.project, f.standard);
  await h.wait(state => state.agentsState.coverage?.issues.includes("store-missing") === true);
  const first = h.wait(cached);
  await seed(f.standard);
  await first;
  const target = join(f.standard, "tasks", "st_00000001.json");
  const changed = h.wait(state => "tasks" in state.agentsState && state.agentsState.tasks[0]?.model === "renamed");
  await fs.writeFile(`${target}.tmp`, JSON.stringify({ ...task(), model: "renamed" }));
  await fs.rename(`${target}.tmp`, target);
  await changed;
  const malformed = h.wait(state => state.agentsState.coverage?.issues.includes("malformed") === true);
  await fs.writeFile(target, "{");
  expect((await malformed).agentsState).toMatchObject({ tasks: [{ model: "renamed" }] });
  const removed = h.wait(state => state.agentsState.availability === "unknown");
  await fs.writeFile(`${target}.expunging`, "");
  await removed;
  await fs.rm(`${target}.expunging`);
  const restored = h.wait(cached);
  await fs.writeFile(target, JSON.stringify(task()));
  await restored;
  const deleted = h.wait(state => state.agentsState.availability === "unknown");
  await fs.unlink(target);
  await deleted;
});

test("live replacement during a held disk read wins and A/B/A retires its old completion", async () => {
  const f = await fixture();
  await seed(f.standard);
  const open = fs.open;
  let release: () => void = () => {};
  let signal: () => void = () => {};
  const held = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("st_00000001.json") && first) { first = false; signal(); await gate; }
    return open(...args);
  });
  try {
    const h = observe(f.project, f.standard);
    await held;
    h.live([{ ...task(), model: "live" }]);
    release();
    const ready = await h.wait(state => state.agentsState.availability === "ready");
    expect(ready.agentsState).toMatchObject({ tasks: [{ model: "live" }] });
    h.switch("B"); h.switch("R");
    const restored = await h.wait(cached);
    expect(restored.agentsState).toMatchObject({ parent_session_id: "R", tasks: [{ model: "disk" }] });
  } finally { release(); intercepted.mockRestore(); }
});

test("filename mismatch, foreign records and unsupported checkpoints never prove empty", async () => {
  const f = await fixture();
  await seed(f.standard, task("st_00000002"));
  await seed(f.standard, { ...task("st_00000003", "foreign"), root_session_id: "foreign" }, "st_00000003.json");
  await fs.mkdir(join(f.standard, "dag", "runs"), { recursive: true });
  await fs.writeFile(join(f.standard, "dag", "runs", "dag_00000001.json"), JSON.stringify({ ...checkpoint, schemaVersion: 2 }));
  const state = await observe(f.project, f.standard).wait(value => !!value.agentsState.coverage);
  expect(state.agentsState.availability).toBe("unknown");
  expect(state.dagState.availability).toBe("unknown");
  expect(state.agentsState.coverage?.issues).toContain("malformed");
});

test("store directory replacement rearms exact-file watchers on the new directory", async () => {
  const f = await fixture();
  await seed(f.standard);
  const h = observe(f.project, f.standard);
  await h.wait(cached);
  const replaced = h.wait(state => "tasks" in state.agentsState && state.agentsState.tasks[0]?.model === "replacement");
  await fs.rm(f.standard, { recursive: true, force: true });
  await seed(f.standard, { ...task(), model: "replacement" });
  await replaced;
  const subsequent = h.wait(state => "tasks" in state.agentsState && state.agentsState.tasks[0]?.model === "subsequent");
  await seed(f.standard, { ...task(), model: "subsequent" });
  await subsequent;
});

test("A/B/A discards an old inode read even after its session identity returns", async () => {
  const f = await fixture();
  await seed(f.standard);
  const open = fs.open;
  const gate = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let first = true;
  const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith("st_00000001.json") && first) {
      first = false;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed.resolve(); };
      held.resolve(); await gate.promise;
    }
    return handle;
  });
  try {
    const h = observe(f.project, f.standard);
    await held.promise;
    h.switch("B");
    const file = join(f.standard, "tasks", "st_00000001.json");
    await fs.rename(file, `${file}.old`);
    await seed(f.standard, { ...task(), model: "new-generation" });
    h.switch("R");
    await h.wait(cached);
    gate.resolve(); await closed.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.observer.snapshot().agentsState).toMatchObject({ tasks: [{ model: "new-generation" }] });
  } finally { gate.resolve(); intercepted.mockRestore(); }
});

test("an ambiguous legacy root can become a contained store through a parent watcher", async () => {
  const f = await fixture();
  await fs.mkdir(join(f.project, ".omo"));
  await fs.writeFile(f.legacy, "not a directory");
  const h = observe(f.project);
  await h.wait(state => state.agentsState.coverage?.issues.includes("location-unverified") === true);
  const resolved = h.wait(cached);
  await fs.unlink(f.legacy);
  await seed(f.legacy, { ...task(), model: "resolved-legacy" });
  expect((await resolved).agentsState).toMatchObject({ tasks: [{ model: "resolved-legacy" }] });
});
