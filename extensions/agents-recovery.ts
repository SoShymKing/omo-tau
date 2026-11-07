import { watch, promises as fs, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { directory, directoryEntries, missing, resolveLocation, type ReadBudget } from "./agents-location";
import { payloadPath, reconcileFiles, type DiskFile } from "./agents-recovery-read";
import type { Recovery } from "./agents-types";

// One event-driven recovery lifetime. A directory event retires its reads immediately;
// only the newest bounded transaction can commit. No idle work or polling is scheduled.
export function recoverAgents(input: { readonly stateDir?: string; readonly projectDir?: string },
  publish: (value: Recovery) => void) {
  let closed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rescan = true;
  let resolveAgain = true;
  let selected: string | undefined;
  let locationIssues: readonly string[] = [];
  let files = new Map<string, DiskFile>();
  const dirty = new Set<string>();
  const watchers = new Map<string, FSWatcher>();
  let watchGeneration = 0;
  function closeWatchers() {
    watchGeneration++;
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  }
  function schedule(target?: string) {
    if (closed) return;
    if (target && dirty.size < 4096 && !rescan) dirty.add(target);
    else if (!target || dirty.size >= 4096) {
      generation++; rescan = true; resolveAgain = true; dirty.clear();
    }
    if (!timer) {
      timer = setTimeout(() => { timer = undefined; void reconcile(); }, 100);
      timer.unref?.();
    }
  }
  async function arm(targets: readonly string[], budget: ReadBudget, current: () => boolean) {
    closeWatchers();
    const watchToken = watchGeneration;
    const missingTargets = new Set<string>();
    const desired = new Map<string, { payload: boolean; names: Set<string> }>();
    for (const target of targets) {
      let candidate = target;
      let expected = "";
      while (current()) {
        if (++budget.probes > 32) { budget.issues.add("budget"); break; }
        try {
          if (!await directory(candidate)) {
            budget.issues.add("read-error");
            expected = basename(candidate);
            const parent = dirname(candidate);
            if (parent === candidate) break;
            candidate = parent;
            continue;
          }
          const existing = desired.get(candidate) ?? { payload: false, names: new Set<string>() };
          existing.payload ||= !expected && (basename(target) === "tasks" || basename(target) === "runs");
          if (expected) existing.names.add(expected);
          else if (!existing.payload) {
            existing.names.add("tasks"); existing.names.add("dag"); existing.names.add("runs"); existing.names.add(".in-project");
            if (selected && target === dirname(selected)) existing.names.add(basename(selected));
          }
          desired.set(candidate, existing);
          break;
        } catch (error) {
          if (!missing(error)) {
            if (error instanceof Error) { budget.issues.add("read-error"); break; }
            throw error;
          }
          expected = basename(candidate);
          if (candidate === target) missingTargets.add(target);
          const parent = dirname(candidate);
          if (parent === candidate) break;
          candidate = parent;
        }
      }
    }
    for (const [target, filter] of desired) {
      if (!current()) return;
      if (watchers.size >= 4) { budget.issues.add("budget"); break; }
      try {
        const watcher = watch(target, (_event, name) => {
          if (!current() || watchToken !== watchGeneration) return;
          if (name === null) { schedule(); return; }
          const filename = String(name);
          const file = filter.payload ? payloadPath(target, filename) : null;
          if (file) schedule(file);
          else if (filter.names.has(filename) || filename === basename(target)) schedule();
        });
        watcher.on("error", () => {
          if (!closed && watchToken === watchGeneration) {
            budget.issues.add("read-error");
            publishProjection(budget.issues);
          }
        });
        watcher.unref();
        watchers.set(target, watcher);
      } catch (error) {
        if (error instanceof Error) budget.issues.add("read-error");
        else throw error;
      }
    }
    for (const target of missingTargets) {
      if (!current() || ++budget.probes > 32) { budget.issues.add("budget"); break; }
      try {
        if (await directory(target)) { schedule(); break; }
      } catch (error) {
        if (!missing(error)) {
          if (error instanceof Error) budget.issues.add("read-error");
          else throw error;
        }
      }
    }
  }
  function publishProjection(issues: Iterable<string>) {
    if (closed) return;
    publish({ tasks: [...files.values()].flatMap(file => file.task ? [file.task] : []),
      runs: [...files.values()].flatMap(file => file.run ? [file.run] : []),
      issues: [...new Set([...locationIssues, ...issues,
        ...[...files.values()].flatMap(file => file.issues ?? [])])].sort().slice(0, 16) });
  }
  async function reconcile() {
    if (closed || running) return;
    running = true;
    const token = generation;
    const current = () => !closed && token === generation;
    const budget: ReadBudget = { entries: 0, bytes: 0, probes: 0, issues: new Set() };
    const full = rescan;
    rescan = false;
    const invalidated = new Set(full ? files.keys() : dirty);
    dirty.clear();
    try {
      if (resolveAgain) {
        resolveAgain = false;
        const location = await resolveLocation(input, budget);
        if (!current()) return;
        if (selected !== location.selected) files.clear();
        selected = location.selected;
        locationIssues = location.issues;
        const targets = selected ? [join(selected, "tasks"), join(selected, "dag", "runs"), selected, dirname(selected)] :
          location.candidates;
        await arm(targets, budget, current);
      }
      if (!current()) return;
      if (!selected) { publishProjection(budget.issues); return; }
      const paths: string[] = [];
      if (full) {
        const present = new Set<string>();
        try {
          if (!await directory(selected)) { budget.issues.add("read-error"); publishProjection(budget.issues); return; }
          for (const folder of [join(selected, "tasks"), join(selected, "dag", "runs")]) {
            try {
              if (!await directory(folder)) { budget.issues.add("read-error"); continue; }
              const names = await directoryEntries(folder, budget);
              for (const name of names) {
                const file = payloadPath(folder, name);
                if (file) { present.add(file); paths.push(file); }
              }
            } catch (error) {
              if (missing(error)) continue;
              if (error instanceof Error) budget.issues.add("read-error");
              else throw error;
            }
          }
          if (!budget.issues.has("budget") && !budget.issues.has("read-error")) {
            for (const file of files.keys()) if (!present.has(file)) files.delete(file);
          }
        } catch (error) {
          if (missing(error)) { files.clear(); budget.issues.add("store-missing"); }
          else if (error instanceof Error) budget.issues.add("read-error");
          else throw error;
        }
      } else paths.push(...invalidated);
      const result = await reconcileFiles({ paths: [...new Set(paths)], previous: files, invalidated, current }, budget);
      if (!current()) return;
      files = result;
      publishProjection(budget.issues);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (current()) { budget.issues.add("read-error"); publishProjection(budget.issues); }
    } finally {
      running = false;
      if (!closed && (rescan || dirty.size)) schedule(dirty.values().next().value);
    }
  }
  void reconcile();
  return () => {
    closed = true; generation++;
    if (timer) clearTimeout(timer);
    timer = undefined;
    closeWatchers(); files.clear(); dirty.clear();
  };
}
