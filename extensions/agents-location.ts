import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

export type ReadBudget = { entries: number; bytes: number; probes: number; readonly issues: Set<string> };
export const missing = (error: unknown) => error instanceof Error && "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");
export function samePath(left: string, right: string) {
  return process.platform === "win32" ? normalize(left).toLowerCase() === normalize(right).toLowerCase() :
    normalize(left) === normalize(right);
}
export async function directory(target: string) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(target), resolve(target))) {
    return false;
  }
  return true;
}
export async function directoryEntries(target: string, budget: ReadBudget, limit = 4096) {
  const result: string[] = [];
  const handle = await fs.opendir(target);
  try {
    for (;;) {
      if (budget.entries >= 4096 || result.length >= limit) {
        budget.issues.add("budget");
        break;
      }
      const entry = await handle.read();
      if (!entry) break;
      budget.entries++;
      result.push(entry.name);
    }
  } finally { await handle.close(); }
  return result.sort();
}
async function legacyOccupied(target: string, budget: ReadBudget): Promise<boolean | null> {
  try {
    if (!await directory(target)) return null;
    try {
      const marker = await fs.lstat(join(target, ".in-project"));
      if (marker.isFile() && !marker.isSymbolicLink()) return true;
      return null;
    } catch (error) { if (!missing(error)) return null; }
    const pending = [{ path: target, depth: 0 }];
    let inspected = 0;
    let probes = 3; // Root lstat/realpath and adoption-marker lstat share this ceiling.
    while (pending.length) {
      const current = pending.pop();
      if (!current) break;
      if (current.depth > 16 || probes >= 256 || inspected >= 256) {
        budget.issues.add("budget"); return null;
      }
      const names = await directoryEntries(current.path, budget, 256 - inspected);
      inspected += names.length;
      if (budget.issues.has("budget")) return null;
      for (const name of names) {
        if (++probes > 256) { budget.issues.add("budget"); return null; }
        const target = join(current.path, name);
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) return null;
        if (!stat.isDirectory() || name.includes(".")) return true;
        pending.push({ path: target, depth: current.depth + 1 });
      }
    }
    return false;
  } catch (error) {
    if (missing(error)) return false;
    if (error instanceof Error) { budget.issues.add("read-error"); return null; }
    throw error;
  }
}

export async function resolveLocation(input: { readonly projectDir?: string; readonly stateDir?: string }, budget: ReadBudget) {
  const explicit = input.stateDir?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) return { candidates: [], issues: ["location-unverified"] };
    return { selected: resolve(explicit), candidates: [resolve(explicit)], issues: [] };
  }
  if (!input.projectDir) return { candidates: [], issues: ["store-unconfigured"] };
  let project = resolve(input.projectDir);
  try { project = await fs.realpath(project); }
  catch (error) {
    if (!missing(error)) {
      if (error instanceof Error) return { candidates: [], issues: ["location-unverified", "read-error"] };
      throw error;
    }
  }
  const name = basename(project).replace(/[^\p{L}\p{N}._-]/gu, "_") || "root";
  const key = `${name}-${createHash("sha256").update(project).digest("hex").slice(0, 12)}`;
  const configured = ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]
    .map(name => process.env[name]?.trim()).find(Boolean);
  const agent = configured ? resolve(configured) : join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), ".omo", "agent");
  const legacy = join(project, ".omo", "senpi-task");
  const standard = join(agent, "projects", key, "senpi-task");
  const occupied = await legacyOccupied(legacy, budget);
  return { ...(occupied === null ? {} : { selected: occupied ? legacy : standard }),
    candidates: [legacy, standard], issues: ["location-unverified"] };
}
